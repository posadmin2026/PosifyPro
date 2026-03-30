const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, globalShortcut, shell, ipcMain, Menu, dialog } = require('electron');
const Database = require('better-sqlite3');
const express = require('express');
const { machineIdSync } = require('node-machine-id');

let mainWindow = null;
let db = null;
let cachedDeviceId = '';
let apiServer = null;
let apiServerMeta = null;
let appPort = 3500;
let allowAppClose = false;

const DEFAULT_APP_PORT = 3500;
const SERVER_PORT_KEY = '__server_port__';
const LICENSE_DEFAULT_GRACE_MS = 48 * 60 * 60 * 1000; // 2 days
const LICENSE_DEFAULT_STALE_MS = 45 * 24 * 60 * 60 * 1000;
const LICENSE_CACHE_KEY = '__license_cache_v1__';
let storageStreamSeq = 0;
const storageStreamClients = new Set();
let storageStreamHeartbeatTimer = null;

function writeSseMessage(res, payload) {
  if (!res || res.writableEnded) return false;
  try {
    res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

function publishStorageChange(key, action) {
  const k = String(key || '').trim();
  if (!k) return;
  storageStreamSeq += 1;
  const msg = {
    type: 'storage_change',
    seq: storageStreamSeq,
    key: k,
    action: String(action || 'set'),
    time: new Date().toISOString()
  };
  for (const client of [...storageStreamClients]) {
    if (!writeSseMessage(client, msg)) {
      try { client.end(); } catch (_) {}
      storageStreamClients.delete(client);
    }
  }
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return fallback;
  }
}

function getDb() {
  if (!db) {
    const dbPath = path.join(app.getPath('userData'), 'mn-pos.sqlite');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.prepare(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
  }
  return db;
}

function kvGet(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const row = getDb().prepare('SELECT value FROM kv_store WHERE key = ?').get(k);
  if (!row) return null;
  return String(row.value);
}

function kvSet(key, value) {
  const k = String(key || '').trim();
  if (!k) return;
  const v = String(value == null ? '' : value);
  getDb()
    .prepare(`
      INSERT INTO kv_store(key, value, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `)
    .run(k, v, Date.now());
  publishStorageChange(k, 'set');
}

function kvRemove(key) {
  const k = String(key || '').trim();
  if (!k) return;
  getDb().prepare('DELETE FROM kv_store WHERE key = ?').run(k);
  publishStorageChange(k, 'remove');
}

function normalizePort(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_APP_PORT;
  if (n < 1024 || n > 65535) return DEFAULT_APP_PORT;
  return n;
}

function getSavedPort() {
  const raw = kvGet(SERVER_PORT_KEY);
  if (raw === null || raw === undefined || raw === '') return DEFAULT_APP_PORT;
  return normalizePort(raw);
}

function savePort(port) {
  kvSet(SERVER_PORT_KEY, String(normalizePort(port)));
}

function nowIso() {
  return new Date().toISOString();
}

function pad2(n) {
  return String(Math.max(0, Math.floor(Number(n) || 0))).padStart(2, '0');
}

function sanitizeFileNamePart(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  return raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').slice(0, 48);
}

function getDefaultBackupFolder() {
  return path.join(app.getPath('documents'), 'MN-Backups');
}

function resolveBackupFolder(rawFolder) {
  const folder = String(rawFolder || '').trim();
  if (!folder) return getDefaultBackupFolder();
  return path.resolve(folder);
}

function buildBackupFileName(reason) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
  const reasonSafe = sanitizeFileNamePart(reason || 'manual');
  return `mn-sushi-backup-${stamp}${reasonSafe ? `-${reasonSafe}` : ''}.json`;
}

function writeBackupFileToDisk(payload) {
  const req = payload && typeof payload === 'object' ? payload : {};
  const data = req.data && typeof req.data === 'object' ? req.data : {};
  const reason = String(req.reason || 'manual').trim() || 'manual';
  const folder = resolveBackupFolder(req.folder);
  fs.mkdirSync(folder, { recursive: true });
  const fileName = buildBackupFileName(reason);
  const filePath = path.join(folder, fileName);
  const body = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, body, 'utf8');
  return {
    ok: true,
    folder,
    fileName,
    filePath,
    bytes: Buffer.byteLength(body, 'utf8'),
    writtenAt: nowIso()
  };
}

function normalizeLicenseKey(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeDbUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function parseTs(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const t = new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : 0;
}

function isDeviceActive(entry, staleMs, nowTs) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.disabled === true) return false;
  const now = Number(nowTs) || Date.now();
  const seenTs = parseTs(entry.lastSeenAt) || parseTs(entry.boundAt);
  if (!seenTs) return true;
  return now - seenTs <= staleMs;
}

function getActiveDeviceIds(devices, staleMs, nowTs) {
  const list = devices && typeof devices === 'object' ? devices : {};
  return Object.keys(list).filter((id) => isDeviceActive(list[id], staleMs, nowTs));
}

function evaluateLicenseRecord(record, deviceId, staleMs) {
  if (!record || typeof record !== 'object') return { ok: false, code: 'NOT_FOUND' };
  const status = String(record.status || 'active').toLowerCase();
  if (status !== 'active') return { ok: false, code: 'INACTIVE' };

  const expTs = parseTs(record.expiresAt);
  if (expTs && Date.now() > expTs) return { ok: false, code: 'EXPIRED' };

  const maxDevices = Math.max(1, Math.floor(Number(record.maxDevices) || 1));
  const devices = record.devices && typeof record.devices === 'object' ? record.devices : {};
  const nowTs = Date.now();
  const activeIds = getActiveDeviceIds(devices, staleMs, nowTs);
  const hasCurrent = isDeviceActive(devices[deviceId], staleMs, nowTs);
  if (!hasCurrent && activeIds.length >= maxDevices) {
    return { ok: false, code: 'DEVICE_LIMIT', maxDevices, usedDevices: activeIds.length };
  }
  return {
    ok: true,
    code: 'OK',
    hasCurrent,
    maxDevices,
    usedDevices: activeIds.length,
    businessName: String(record.businessName || record.company || record.owner || 'MN Sushi'),
    expiresAt: String(record.expiresAt || ''),
    status
  };
}

function licenseFailureText(code) {
  if (code === 'NO_LICENSE') return 'Lisenziya acari daxil edilmeyib';
  if (code === 'NOT_FOUND') return 'Lisenziya tapilmadi';
  if (code === 'INACTIVE') return 'Lisenziya deaktivdir';
  if (code === 'EXPIRED') return 'Lisenziyanin muddeti bitib';
  if (code === 'DEVICE_LIMIT') return 'Cihaz limiti dolub';
  if (String(code || '').startsWith('HTTP_')) return 'Bulud serverine baglanti xetasi';
  return 'Lisenziya tesdiqlenmedi';
}

async function fetchJson(url) {
  const res = await fetch(url, { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

async function patchJson(url, payload) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

function getLicenseCacheForKey(licenseKey) {
  const all = safeJsonParse(kvGet(LICENSE_CACHE_KEY) || '{}', {});
  if (!all || typeof all !== 'object') return null;
  const row = all[licenseKey];
  return row && typeof row === 'object' ? row : null;
}

function setLicenseCacheForKey(licenseKey, payload) {
  const all = safeJsonParse(kvGet(LICENSE_CACHE_KEY) || '{}', {});
  const next = all && typeof all === 'object' ? all : {};
  next[licenseKey] = payload;
  kvSet(LICENSE_CACHE_KEY, JSON.stringify(next));
}

function clearLicenseCacheForKey(licenseKey) {
  const all = safeJsonParse(kvGet(LICENSE_CACHE_KEY) || '{}', {});
  if (!all || typeof all !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(all, licenseKey)) return;
  delete all[licenseKey];
  kvSet(LICENSE_CACHE_KEY, JSON.stringify(all));
}

function shouldAllowOfflineGraceFromCode(code) {
  const c = String(code || '').toUpperCase();
  if (!c) return false;
  if (c === 'NO_CLOUD') return true;
  if (c.includes('FETCH') || c.includes('NETWORK') || c.includes('TIMEOUT')) return true;
  if (c.includes('ECONN') || c.includes('ENOTFOUND') || c.includes('EAI_AGAIN')) return true;
  if (/^HTTP_(408|429)$/.test(c)) return true;
  if (/^HTTP_5\d\d$/.test(c)) return true;
  return false;
}

function getStableDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  let machine = '';
  try {
    machine = machineIdSync(true);
  } catch (_) {
    machine = '';
  }
  const seed = [
    machine,
    os.hostname(),
    os.arch(),
    os.platform(),
    String((os.cpus() || []).length || 0)
  ].join('|');
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  cachedDeviceId = `hw-${hash.slice(0, 40)}`;
  return cachedDeviceId;
}

async function verifyLicenseWithFirebase(payload) {
  const req = payload && typeof payload === 'object' ? payload : {};
  const databaseURL = normalizeDbUrl(req.databaseURL || '');
  const licenseKey = normalizeLicenseKey(req.licenseKey || '');
  const rootList = Array.isArray(req.roots) && req.roots.length
    ? req.roots
    : ['rrt_licenses', 'rr_licenses', 'licenses'];
  const roots = [...new Set(rootList.map((x) => String(x || '').trim()).filter(Boolean))];
  const deviceId = getStableDeviceId(); // server-side device lock
  const graceMs = Math.max(1, Number(req.graceMs) || LICENSE_DEFAULT_GRACE_MS);
  const staleMs = Math.max(1, Number(req.staleMs) || LICENSE_DEFAULT_STALE_MS);

  if (!databaseURL) return { ok: false, code: 'NO_CLOUD', message: 'Database URL tapilmadi' };
  if (!licenseKey) return { ok: false, code: 'NO_LICENSE', message: licenseFailureText('NO_LICENSE') };

  try {
    let chosenRecord = null;
    let chosenRoot = roots[0] || 'rrt_licenses';
    for (const root of roots) {
      const url = `${databaseURL}/${encodeURIComponent(root)}/${encodeURIComponent(licenseKey)}.json`;
      const record = await fetchJson(url);
      if (record && typeof record === 'object') {
        chosenRecord = record;
        chosenRoot = root;
        break;
      }
    }

    const eval0 = evaluateLicenseRecord(chosenRecord, deviceId, staleMs);
    if (!eval0.ok) {
      clearLicenseCacheForKey(licenseKey);
      return {
        ok: false,
        code: eval0.code,
        message: licenseFailureText(eval0.code),
        maxDevices: eval0.maxDevices || 0,
        usedDevices: eval0.usedDevices || 0
      };
    }

    const now = nowIso();
    const patchUrl = `${databaseURL}/${encodeURIComponent(chosenRoot)}/${encodeURIComponent(licenseKey)}/devices/${encodeURIComponent(deviceId)}.json`;
    await patchJson(patchUrl, {
      boundAt: now,
      lastSeenAt: now,
      host: os.hostname().slice(0, 80),
      app: 'mn-desktop'
    });

    const usedDevices = eval0.hasCurrent
      ? eval0.usedDevices
      : Math.min(eval0.maxDevices, eval0.usedDevices + 1);

    setLicenseCacheForKey(licenseKey, {
      status: 'active',
      businessName: eval0.businessName,
      expiresAt: eval0.expiresAt,
      maxDevices: eval0.maxDevices,
      usedDevices,
      rootPath: chosenRoot,
      lastValidatedAt: Date.now()
    });

    return {
      ok: true,
      code: 'OK',
      offlineGrace: false,
      rootPath: chosenRoot,
      businessName: eval0.businessName,
      expiresAt: eval0.expiresAt,
      maxDevices: eval0.maxDevices,
      usedDevices,
      status: 'active'
    };
  } catch (err) {
    const code = String((err && err.message) || 'NO_CLOUD').toUpperCase();
    const canUseOfflineGrace = shouldAllowOfflineGraceFromCode(code);
    const cache = getLicenseCacheForKey(licenseKey);
    const cacheValid =
      canUseOfflineGrace &&
      cache &&
      String(cache.status || '').toLowerCase() === 'active' &&
      (Date.now() - Number(cache.lastValidatedAt || 0)) <= graceMs;

    if (cacheValid) {
      return {
        ok: true,
        code: 'OFFLINE_GRACE',
        offlineGrace: true,
        rootPath: String(cache.rootPath || roots[0] || 'rrt_licenses'),
        businessName: String(cache.businessName || 'MN Sushi'),
        expiresAt: String(cache.expiresAt || ''),
        maxDevices: Math.max(1, Number(cache.maxDevices) || 1),
        usedDevices: Math.max(1, Number(cache.usedDevices) || 1),
        status: 'active'
      };
    }

    return { ok: false, code, message: licenseFailureText(code) };
  }
}

function getLanIpv4Urls(port) {
  const out = [];
  const ifaces = os.networkInterfaces() || {};
  Object.values(ifaces).forEach((rows) => {
    (rows || []).forEach((row) => {
      if (!row || row.family !== 'IPv4' || row.internal) return;
      out.push(`http://${row.address}:${port}`);
    });
  });
  return [...new Set(out)];
}

function getServerMetaSnapshot() {
  if (!apiServerMeta) return null;
  return {
    ...apiServerMeta,
    urls: [...apiServerMeta.urls],
    origins: [...apiServerMeta.origins]
  };
}

function resolveSafeRootAsset(rootDir, assetName) {
  const name = String(assetName || '').trim();
  if (!name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const allowedExact = new Set(['css2']);
  const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.txt', '.json', '.html']);
  const ext = path.extname(name).toLowerCase();
  if (!allowedExact.has(name) && !allowedExt.has(ext)) return null;
  const full = path.join(rootDir, name);
  if (!full.startsWith(rootDir)) return null;
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  if (!stat.isFile()) return null;
  return full;
}

function startExpressServer() {
  if (apiServer && apiServerMeta) return Promise.resolve(getServerMetaSnapshot());
  const listenPort = normalizePort(appPort || DEFAULT_APP_PORT);
  appPort = listenPort;

  const webRoot = path.join(__dirname, '..');
  const appServer = express();
  appServer.disable('x-powered-by');
  appServer.use(express.json({ limit: '2mb' }));

  appServer.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'mn-pos-server',
      sqlite: true,
      port: listenPort,
      time: nowIso()
    });
  });

  appServer.get('/api/server-info', (_req, res) => {
    const meta = getServerMetaSnapshot() || {};
    const port = normalizePort(meta.port || appPort || DEFAULT_APP_PORT);
    res.json({
      ok: true,
      ...meta,
      port,
      localUrl: String(meta.localUrl || `http://127.0.0.1:${port}`),
      urls: Array.isArray(meta.urls) ? meta.urls : [],
      origins: Array.isArray(meta.origins) ? meta.origins : [],
      sqlite: true,
      time: nowIso()
    });
  });

  appServer.get('/api/device-id', (_req, res) => {
    res.json({ ok: true, deviceId: getStableDeviceId() });
  });

  appServer.get('/api/storage/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    storageStreamClients.add(res);
    writeSseMessage(res, {
      type: 'hello',
      seq: storageStreamSeq,
      time: nowIso(),
      service: 'mn-pos-server'
    });

    const onClose = () => {
      storageStreamClients.delete(res);
      try { res.end(); } catch (_) {}
    };
    req.on('close', onClose);
    req.on('aborted', onClose);
  });

  appServer.get('/api/storage/:key', (req, res) => {
    const key = String(req.params.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'KEY_REQUIRED' });
    const value = kvGet(key);
    return res.json({ ok: true, value });
  });

  appServer.put('/api/storage/:key', (req, res) => {
    const key = String(req.params.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'KEY_REQUIRED' });
    const value = req && req.body ? req.body.value : '';
    kvSet(key, value == null ? '' : String(value));
    return res.json({ ok: true });
  });

  appServer.delete('/api/storage/:key', (req, res) => {
    const key = String(req.params.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'KEY_REQUIRED' });
    kvRemove(key);
    return res.json({ ok: true });
  });

  appServer.post('/api/license/verify', async (req, res) => {
    try {
      const payload = req && req.body && typeof req.body === 'object' ? req.body : {};
      const result = await verifyLicenseWithFirebase(payload);
      return res.status(result && result.ok ? 200 : 401).json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: String(err && err.message ? err.message : 'SERVER_ERROR') });
    }
  });

  appServer.use('/build', express.static(path.join(webRoot, 'build')));
  appServer.use('/electron', express.static(path.join(webRoot, 'electron')));

  appServer.get(['/', '/index.html'], (_req, res) => {
    res.sendFile(path.join(webRoot, 'index.html'));
  });

  appServer.get('/:asset', (req, res) => {
    const filePath = resolveSafeRootAsset(webRoot, req.params.asset);
    if (!filePath) return res.status(404).send('Not found');
    return res.sendFile(filePath);
  });

  if (storageStreamHeartbeatTimer) {
    clearInterval(storageStreamHeartbeatTimer);
    storageStreamHeartbeatTimer = null;
  }
  storageStreamHeartbeatTimer = setInterval(() => {
    for (const client of [...storageStreamClients]) {
      try {
        if (client.writableEnded) {
          storageStreamClients.delete(client);
          continue;
        }
        client.write(': ping\n\n');
      } catch (_) {
        storageStreamClients.delete(client);
        try { client.end(); } catch (_) {}
      }
    }
  }, 25000);

  return new Promise((resolve, reject) => {
    const server = appServer.listen(listenPort, '0.0.0.0', () => {
      const localUrl = `http://127.0.0.1:${listenPort}`;
      const urls = [localUrl, ...getLanIpv4Urls(listenPort)];
      const origins = urls.map((u) => {
        try {
          return new URL(u).origin;
        } catch (_) {
          return u;
        }
      });
      apiServer = server;
      apiServerMeta = {
        host: '0.0.0.0',
        port: listenPort,
        localUrl,
        urls,
        origins
      };
      console.log('[MN] Express server started on port', listenPort);
      urls.forEach((u) => console.log('[MN] URL:', u));
      resolve(getServerMetaSnapshot());
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

function stopExpressServer() {
  return new Promise((resolve) => {
    if (storageStreamHeartbeatTimer) {
      clearInterval(storageStreamHeartbeatTimer);
      storageStreamHeartbeatTimer = null;
    }
    for (const client of [...storageStreamClients]) {
      try { client.end(); } catch (_) {}
      storageStreamClients.delete(client);
    }
    if (!apiServer) return resolve();
    const srv = apiServer;
    apiServer = null;
    apiServerMeta = null;
    srv.close(() => resolve());
  });
}

async function applyServerPort(rawPort) {
  const requestedPort = normalizePort(rawPort);
  const prevPort = normalizePort(appPort || DEFAULT_APP_PORT);
  const wasRunning = !!apiServer;
  if (requestedPort === prevPort && apiServerMeta) {
    return {
      ok: true,
      changed: false,
      port: prevPort,
      ...getServerMetaSnapshot()
    };
  }

  try {
    if (wasRunning) await stopExpressServer();
    appPort = requestedPort;
    const meta = await startExpressServer();
    savePort(requestedPort);
    if (mainWindow && !mainWindow.isDestroyed() && meta && meta.localUrl) {
      setTimeout(() => {
        try {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.loadURL(meta.localUrl).catch(() => {});
        } catch (_) {}
      }, 120);
    }
    return {
      ok: true,
      changed: requestedPort !== prevPort,
      port: requestedPort,
      ...meta
    };
  } catch (err) {
    let fallbackMeta = null;
    try {
      appPort = prevPort;
      fallbackMeta = await startExpressServer();
    } catch (_) {}
    return {
      ok: false,
      error: String(err && err.message ? err.message : 'PORT_APPLY_FAILED'),
      port: prevPort,
      ...(fallbackMeta || getServerMetaSnapshot() || {})
    };
  }
}

function registerGlobalShortcuts() {
  globalShortcut.register('F12', () => {});
  globalShortcut.register('CommandOrControl+Shift+I', () => {});
  globalShortcut.register('CommandOrControl+R', () => {});
  globalShortcut.register('F5', () => {});
}

function createMainWindow(serverMeta) {
  const appIconPath = path.join(__dirname, '..', 'build', 'icon.png');
  try {
    Menu.setApplicationMenu(null);
  } catch (_) {}
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#0b0c10',
    icon: appIconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  allowAppClose = false;

  mainWindow.setMenuBarVisibility(false);
  try {
    mainWindow.removeMenu();
  } catch (_) {}
  mainWindow.maximize();

  if (process.env.MN_KIOSK === '1') {
    mainWindow.setKiosk(true);
  }

  const allowedOrigins = (serverMeta && Array.isArray(serverMeta.origins)) ? serverMeta.origins : [];
  const localUrl = serverMeta && serverMeta.localUrl ? serverMeta.localUrl : '';

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedOrigins.some((origin) => url.startsWith(origin))) {
      return { action: 'allow' };
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed =
      url.startsWith('file://') ||
      allowedOrigins.some((origin) => url.startsWith(origin));
    if (!allowed) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url);
      }
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase();
    const isCtrl = input.control || input.meta;
    const isAlt = !!input.alt;
    const isAltGraph = !!input.altGraph;
    const isShift = !!input.shift;
    const isBlockedCombo =
      (isCtrl && input.shift && ['i', 'j', 'c'].includes(key)) ||
      (isCtrl && ['u', 's', 'r'].includes(key)) ||
      ['f12', 'f5'].includes(key);
    const isAltF4 = isAlt && key === 'f4';
    const isBareAlt = isAlt && !isCtrl && !isShift && !isAltGraph && key === 'alt';
    const isF10 = key === 'f10';

    if (isBlockedCombo || isAltF4 || isBareAlt || isF10) {
      event.preventDefault();
    }
  });

  mainWindow.on('close', (event) => {
    if (allowAppClose) {
      allowAppClose = false;
      return;
    }
    event.preventDefault();
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mn-close-attempted');
        mainWindow.focus();
      }
    } catch (_) {}
  });

  if (localUrl) {
    mainWindow.loadURL(localUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  }
}

process.on('unhandledRejection', (err) => {
  console.error('[MN] Unhandled rejection:', err);
});

app.whenReady().then(async () => {
  getDb();
  appPort = getSavedPort();

  let serverMeta = null;
  try {
    serverMeta = await startExpressServer();
  } catch (err) {
    console.error('[MN] Express server failed to start:', err);
  }

  ipcMain.handle('mn-open-external', (_, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.on('mn-storage-get-sync', (event, key) => {
    event.returnValue = kvGet(key);
  });
  ipcMain.on('mn-storage-set-sync', (event, key, value) => {
    kvSet(key, value);
    event.returnValue = true;
  });
  ipcMain.on('mn-storage-remove-sync', (event, key) => {
    kvRemove(key);
    event.returnValue = true;
  });
  ipcMain.on('mn-get-device-id-sync', (event) => {
    event.returnValue = getStableDeviceId();
  });
  ipcMain.handle('mn-license-verify', async (_, payload) => {
    return verifyLicenseWithFirebase(payload);
  });
  ipcMain.handle('mn-server-info', async () => {
    const meta = getServerMetaSnapshot() || {};
    return {
      ok: true,
      port: normalizePort(meta.port || appPort || DEFAULT_APP_PORT),
      host: String(meta.host || '0.0.0.0'),
      localUrl: String(meta.localUrl || `http://127.0.0.1:${normalizePort(appPort || DEFAULT_APP_PORT)}`),
      urls: Array.isArray(meta.urls) ? meta.urls : [],
      origins: Array.isArray(meta.origins) ? meta.origins : []
    };
  });
  ipcMain.handle('mn-app-version', async () => {
    try {
      return {
        ok: true,
        version: String(app.getVersion() || '')
      };
    } catch (err) {
      return {
        ok: false,
        version: '',
        error: String(err && err.message ? err.message : 'APP_VERSION_FAILED')
      };
    }
  });
  ipcMain.handle('mn-server-set-port', async (_, rawPort) => applyServerPort(rawPort));
  ipcMain.handle('mn-pick-backup-folder', async () => {
    try {
      const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
      const picked = await dialog.showOpenDialog(win, {
        title: 'Backup qovluğu seçin',
        properties: ['openDirectory', 'createDirectory']
      });
      if (!picked || picked.canceled || !picked.filePaths || !picked.filePaths.length) {
        return { ok: false, canceled: true };
      }
      return {
        ok: true,
        folder: String(picked.filePaths[0] || '')
      };
    } catch (err) {
      return {
        ok: false,
        canceled: false,
        error: String(err && err.message ? err.message : 'PICK_FOLDER_FAILED')
      };
    }
  });
  ipcMain.handle('mn-write-backup-file', async (_, payload) => {
    try {
      return writeBackupFileToDisk(payload);
    } catch (err) {
      return {
        ok: false,
        error: String(err && err.message ? err.message : 'BACKUP_WRITE_FAILED')
      };
    }
  });
  ipcMain.handle('mn-request-app-exit', async () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        allowAppClose = true;
        mainWindow.close();
      } else {
        app.quit();
      }
      return { ok: true };
    } catch (err) {
      allowAppClose = false;
      return {
        ok: false,
        error: String(err && err.message ? err.message : 'APP_EXIT_FAILED')
      };
    }
  });

  createMainWindow(serverMeta);
  registerGlobalShortcuts();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!apiServerMeta) {
        try {
          serverMeta = await startExpressServer();
        } catch (_) {
          serverMeta = null;
        }
      } else {
        serverMeta = getServerMetaSnapshot();
      }
      createMainWindow(serverMeta);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  await stopExpressServer();
  if (db) {
    try {
      db.close();
    } catch (_) {}
    db = null;
  }
});
