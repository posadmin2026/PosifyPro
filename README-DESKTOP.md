# MN Sushi - Desktop EXE

Bu qovluqda `index.html` proqrami ucun Electron skeleti var.

## 1) Qurasdirma

```bash
npm install
```

## 2) Lokal test

```bash
npm run desktop:dev
```

## 3) Build (Portable + Setup)

```bash
npm run desktop:dist
```

`dist/` qovlugunda 2 fayl yaranacaq:
- Portable EXE (qurasdirma olmadan acilir)
- Setup EXE (normal install ucun)

## 4) Kiosk rejimi (opsional)

```powershell
$env:MN_KIOSK='1'
npm run desktop:dev
```
