# MN Tablet APK

Android kiosk app for tablets/phones that opens your existing MN POS in full screen without browser URL bar.

## How this uses the same database

This app loads your desktop server URL (for example: `http://192.168.1.4:3500`).
So tablet orders go to the **same desktop SQLite database** through your existing Express API.

## Features

- Full-screen kiosk WebView (no browser URL bar)
- Hidden admin settings access: tap top-left corner 5 times, then PIN
- Server URL and admin PIN are configurable
- Autofill blockers (WebView + JS patch on each page load)
- Works on tablet and phone

## Build APK (Android Studio)

1. Open `android-tablet` folder in Android Studio.
2. Let Gradle sync.
3. `Build > Build Bundle(s) / APK(s) > Build APK(s)`.
4. Install generated APK on tablet/phone.

## First setup on device

1. Open app.
2. Enter server URL (desktop IP + port), e.g. `http://192.168.1.4:3500`.
3. Set admin PIN (for hidden settings).
4. Save and open.

## Important

- Desktop app/server must be running.
- Tablet and desktop must be on same network (Wi-Fi/LAN).
- If IP changes, open hidden settings and update URL.

