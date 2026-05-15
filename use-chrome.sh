#!/usr/bin/env bash
cd "$(dirname "$0")"
cp manifest.json manifest-firefox.json
cp manifest-chrome.json manifest.json
echo "Switched to Chrome manifest. Load the extension from chrome://extensions"
