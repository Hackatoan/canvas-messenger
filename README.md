# Canvas Messenger

A browser extension that adds Discord-style messaging to Canvas LMS — direct messages, group chats, class-wide channels, and team/group communication, all without leaving Canvas.

## Features

- **Direct Messages** — 1:1 and group conversations with any student or professor
- **Class Chat** — a live class-wide channel for every course you're enrolled in (backed by Canvas Discussions, auto-refreshes every 20s)
- **Groups** — view your Canvas Groups/Teams, DM members, or message the whole group at once
- **Recipient search** — search by name, filter by role (Students / Instructors / TAs) and by course
- **Discord-style UI** — dark theme, grouped messages by sender, floating sidebar on Canvas pages
- **Unread badge** — extension icon shows unread count, polls every 60 seconds
- **Auto-setup** — visit your Canvas profile/settings page and the extension detects your Canvas URL and offers to auto-generate your API token

## Installation

### Firefox

1. Download `canvas-messenger-firefox.zip` from [Releases](../../releases/latest) and unzip it
2. Go to `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
3. Select the `manifest.json` inside the unzipped folder

> **Note:** Temporary add-ons are removed on Firefox restart. For a permanent install, the extension would need to be signed through [Mozilla AMO](https://addons.mozilla.org).

### Chrome / Chromium

1. Download `canvas-messenger-chrome.zip` from [Releases](../../releases/latest) and unzip it
2. Go to `chrome://extensions` → enable **Developer mode** → **Load unpacked**
3. Select the unzipped folder

## Setup

After installing, you have two options:

**Option A — Auto-setup (recommended)**
1. Visit your Canvas instance and navigate to **Account → Settings** (the profile/settings page)
2. A blue "Canvas Messenger — Set up" banner will appear in the top-right corner
3. Click **Set up** — the extension opens the token dialog, fills in the purpose, generates the token, and asks for your confirmation
4. Click **Save to Extension** — done

**Option B — Manual**
1. Click the extension icon → **Open Settings**
2. Enter your Canvas URL (e.g. `https://yourschool.instructure.com`)
3. Generate a token at **Canvas → Account → Settings → New Access Token**
4. Paste the token and click **Save & Connect**

## Privacy

Your API token is stored locally in your browser's extension storage and never leaves your device. All requests go directly to your school's Canvas instance. No external servers are involved.

## Building from source

```bash
git clone https://github.com/Hackatoan/canvas-messenger
cd canvas-messenger
chmod +x build.sh
./build.sh
# outputs dist/canvas-messenger-firefox.zip and dist/canvas-messenger-chrome.zip
```

## How class chat works

The **Classes** tab uses Canvas's Discussions API. When you open a course's class chat for the first time, the extension creates a pinned discussion topic called **📣 Class Chat** in that course. All students and instructors in the course can post to it — even those without the extension, via the normal Canvas Discussions interface.

## Permissions used

| Permission | Why |
|---|---|
| `storage` | Save your Canvas URL and API token locally |
| `alarms` | Poll for unread messages every 60 seconds |
| `host_permissions: https://*/*` | Make API calls to your Canvas instance |
