[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/hackatoa)

# Canvas Messenger

A browser extension that adds Discord-style messaging to Canvas LMS — direct messages, group chats, class-wide channels, and team/group communication, all without leaving Canvas.

## Features

- **Direct Messages** — 1:1 and group conversations with any student or professor
- **Class Chat** — a live class-wide channel for every course, backed by Canvas Discussions (auto-refreshes every 20s)
- **Groups** — view your Canvas Groups/Teams, DM members, or message the whole group
- **Recipient search** — search by name, filter by role (Students / Instructors / TAs) and by course
- **Discord-style UI** — dark theme, grouped messages, floating sidebar on Canvas pages
- **Unread badge** — extension icon shows unread count, polls every 60 seconds
- **Auto-setup** — visit your Canvas profile/settings page and the extension detects your Canvas URL and auto-generates your API token

## Installation

### Firefox

1. Download `canvas-messenger-firefox.zip` from [Releases](../../releases/latest) and unzip it
2. Go to `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
3. Select the `manifest.json` inside the unzipped folder

> Temporary add-ons are removed on Firefox restart. For a permanent install, the extension would need to be signed via [Mozilla AMO](https://addons.mozilla.org).

### Chrome / Chromium

1. Download `canvas-messenger-chrome.zip` from [Releases](../../releases/latest) and unzip it
2. Go to `chrome://extensions` → enable **Developer mode** → **Load unpacked**
3. Select the unzipped folder

## Setup

**Auto-setup (recommended)**
1. Navigate to **Account → Settings** on your Canvas instance
2. A blue "Canvas Messenger — Set up" banner appears in the top-right corner
3. Click **Set up** — the extension fills the token dialog and generates a token
4. Click **Save to Extension**

**Manual**
1. Click the extension icon → **Open Settings**
2. Enter your Canvas URL (e.g. `https://yourschool.instructure.com`)
3. Paste an API token generated from **Canvas → Account → Settings → New Access Token**

## Privacy

Your API token is stored locally in browser extension storage and never leaves your device. All requests go directly to your school's Canvas instance — no external servers.

## Build from source

```bash
git clone https://github.com/Hackatoan/canvas-messenger
cd canvas-messenger
chmod +x build.sh
./build.sh
# outputs dist/canvas-messenger-firefox.zip and dist/canvas-messenger-chrome.zip
```

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save your Canvas URL and API token locally |
| `alarms` | Poll for unread messages every 60 seconds |
| `scripting` | Inject token setup helper into Canvas pages |
| `host_permissions: https://*/*` | Make API calls to your Canvas instance |

---

[hackatoa.com](https://hackatoa.com) · [GitHub](https://github.com/Hackatoan) · [Buy Me A Coffee](https://buymeacoffee.com/hackatoa)
