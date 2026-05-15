#!/usr/bin/env bash
cd "$(dirname "$0")"
cp manifest-chrome.json manifest-chrome.json.bak 2>/dev/null || true
cp manifest-firefox.json manifest.json 2>/dev/null || cp manifest.json manifest.json
echo "Switched to Firefox manifest. Load at about:debugging"
