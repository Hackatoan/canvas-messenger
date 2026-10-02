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

Run the tests with `npm test`. To enable accounts in a build, set `FIREBASE_API_KEY` at the top of the accounts section in `background.js` (the Firebase project's web API key, a public identifier) and make sure Email/Password sign-in is enabled in the Firebase console. The relay needs `ACCOUNT_ENC_KEY` (32 random bytes, base64) set — see [cm-relay](https://github.com/Hackatoan/cm-relay).

Load the extension unpacked from your browser's extensions page (developer mode). See the setup notes for connecting your Canvas API token.

## Support

If this project is useful to you, consider supporting development:

☕ **[Buy Me a Coffee](https://buymeacoffee.com/hackatoa)**

---

Part of the **[Hackatoa](https://hackatoa.com)** ecosystem — self-hosted apps, browser games, and bots. · [All repositories »](https://github.com/Hackatoan)
