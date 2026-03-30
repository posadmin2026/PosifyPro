const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('MNDesktop', {
  isDesktop: true,
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke('mn-open-external', url),
  storageGet: (key) => ipcRenderer.sendSync('mn-storage-get-sync', key),
  storageSet: (key, value) => ipcRenderer.sendSync('mn-storage-set-sync', key, value),
  storageRemove: (key) => ipcRenderer.sendSync('mn-storage-remove-sync', key),
  getDeviceId: () => ipcRenderer.sendSync('mn-get-device-id-sync'),
  verifyLicense: (payload) => ipcRenderer.invoke('mn-license-verify', payload),
  getAppVersion: () => ipcRenderer.invoke('mn-app-version'),
  getServerInfo: () => ipcRenderer.invoke('mn-server-info'),
  setServerPort: (port) => ipcRenderer.invoke('mn-server-set-port', port),
  pickBackupFolder: () => ipcRenderer.invoke('mn-pick-backup-folder'),
  writeBackupFile: (payload) => ipcRenderer.invoke('mn-write-backup-file', payload),
  requestAppExit: () => ipcRenderer.invoke('mn-request-app-exit'),
  onCloseAttempt: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const wrapped = () => {
      try { handler(); } catch (_) {}
    };
    ipcRenderer.on('mn-close-attempted', wrapped);
    return () => ipcRenderer.removeListener('mn-close-attempted', wrapped);
  }
});
