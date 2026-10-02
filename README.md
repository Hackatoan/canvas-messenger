# Canvas Messenger

> **🔗 Part of Canvas Messenger:** [canvas-messenger](https://github.com/Hackatoan/canvas-messenger) (extension) · [cm-relay](https://github.com/Hackatoan/cm-relay) (REST API) · [cm-signaling](https://github.com/Hackatoan/cm-signaling) (WebRTC signaling)

A Chrome/Firefox extension that adds Discord-style messaging to Canvas LMS — DMs, group chats, and class channels.

🔗 **Site:** [cm.hackatoa.com](https://cm.hackatoa.com)   ·   ☕ **Support:** [Buy Me a Coffee](https://buymeacoffee.com/hackatoa)

## Overview

A browser extension that layers real-time messaging onto Canvas LMS: direct messages, group chats, and class-wide channels, backed by a WebRTC signaling + relay service.

## Features

- Direct messages, group chats, and class-wide channels
- Real-time delivery over WebRTC
- Works on top of the existing Canvas UI

- Optional account (email + password via Firebase Auth) to restore your Canvas connection and encryption keys on a new device

## Tech Stack

JavaScript · Browser Extension (Chrome / Firefox) · WebRTC

## Development

Run the tests with `npm test`. Accounts use the Firebase project `canvas-messagener` (`FIREBASE_API_KEY` at the top of the accounts section in `background.js` is its public web API key; Email/Password sign-in must be enabled in the Firebase console). Setting the key to an empty string hides the feature.

**Sign in with Google** uses the Google provider's OAuth web client (`GOOGLE_CLIENT_ID` in `background.js`). Each browser's redirect URI must be listed under that client's *Authorized redirect URIs* in Google Cloud Console → APIs & Services → Credentials: `https://<extension-id>.chromiumapp.org/` for Chrome and `https://<hash>.extensions.allizom.org/` for Firefox (the exact value is `chrome.identity.getRedirectURL()`; if it's missing, Google's `redirect_uri_mismatch` error page prints it). The relay needs `ACCOUNT_ENC_KEY` (32 random bytes, base64) set — see [cm-relay](https://github.com/Hackatoan/cm-relay).

Load the extension unpacked from your browser's extensions page (developer mode). See the setup notes for connecting your Canvas API token.

## Support

If this project is useful to you, consider supporting development:

☕ **[Buy Me a Coffee](https://buymeacoffee.com/hackatoa)**

---

Part of the **[Hackatoa](https://hackatoa.com)** ecosystem — self-hosted apps, browser games, and bots. · [All repositories »](https://github.com/Hackatoan)
