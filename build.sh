#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

SRC_FILES=(
    background.js
    content.js
    token-setup.js
    styles/messenger.js
    styles/messenger.css
    popup/popup.html
    popup/popup.js
    options/options.html
    options/options.js
)

build() {
    local BROWSER=$1
    local MANIFEST=$2
    local OUT="dist/$BROWSER"

    echo "Building $BROWSER…"
    rm -rf "$OUT"
    mkdir -p "$OUT/styles" "$OUT/popup" "$OUT/options"

    for f in "${SRC_FILES[@]}"; do
        cp "$f" "$OUT/$f"
    done

    cp "$MANIFEST" "$OUT/manifest.json"

    # Zip
    (cd dist && zip -qr "canvas-messenger-$BROWSER.zip" "$BROWSER/")
    echo "  → dist/canvas-messenger-$BROWSER.zip"
}

mkdir -p dist
build firefox manifest.json
build chrome  manifest-chrome.json

echo ""
echo "Done. Zips in dist/"
ls -lh dist/*.zip
