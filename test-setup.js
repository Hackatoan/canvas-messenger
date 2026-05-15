#!/usr/bin/env node
// Automated test for Canvas Messenger token setup flow.
//
// Usage:
//   node test-setup.js --url https://your.canvas.edu --user you@school.edu --pass yourpassword
//
// Opens a real Chromium window with the extension loaded, logs in to Canvas,
// navigates to profile/settings, clicks Set Up, and reports what happens.

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

// ── Parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name) {
    const i = args.indexOf('--' + name);
    return i !== -1 ? args[i + 1] : null;
}

const CANVAS_URL = arg('url');
const USERNAME   = arg('user');
const PASSWORD   = arg('pass');

if (!CANVAS_URL || !USERNAME || !PASSWORD) {
    console.error('Usage: node test-setup.js --url <canvas-url> --user <email> --pass <password>');
    process.exit(1);
}

const EXTENSION_DIR = path.resolve(__dirname, 'dist/chrome');
if (!fs.existsSync(EXTENSION_DIR)) {
    console.error('Chrome build not found at dist/chrome — run ./build.sh first');
    process.exit(1);
}

(async () => {
    console.log('Launching Chrome with extension from', EXTENSION_DIR);

    const ctx = await chromium.launchPersistentContext('', {
        headless: false,
        args: [
            `--disable-extensions-except=${EXTENSION_DIR}`,
            `--load-extension=${EXTENSION_DIR}`,
            '--no-sandbox',
        ],
        // Route all console messages from the page to our stdout
    });

    const page = await ctx.newPage();

    // Capture all console messages — we care about [CM token-setup] lines
    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('[CM') || msg.type() === 'error') {
            console.log(`[browser ${msg.type()}]`, text);
        }
    });
    page.on('pageerror', err => console.error('[page error]', err.message));

    // ── Step 1: navigate to Canvas ─────────────────────────────────────────
    const settingsUrl = CANVAS_URL.replace(/\/$/, '') + '/profile/settings';
    console.log('\n→ Navigating to', settingsUrl);
    await page.goto(settingsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // ── Step 2: log in if redirected ───────────────────────────────────────
    if (!page.url().includes('/profile')) {
        console.log('  Redirected to login at', page.url());

        // Try standard Canvas login form
        const userField = page.locator('input[name="pseudonym_session[unique_id]"], input[type="email"], #pseudonym_session_unique_id');
        const passField = page.locator('input[name="pseudonym_session[password]"], input[type="password"], #pseudonym_session_password');
        const loginBtn  = page.locator('button[type="submit"], input[type="submit"]').first();

        await userField.fill(USERNAME, { timeout: 10000 }).catch(() => {
            console.warn('  Could not find username field — may need manual login');
        });
        await passField.fill(PASSWORD, { timeout: 5000 }).catch(() => {});
        await loginBtn.click({ timeout: 5000 }).catch(() => {});

        await page.waitForURL(url => !url.includes('/login'), { timeout: 15000 })
            .catch(() => console.warn('  Login redirect timeout — continuing anyway'));

        // Navigate to settings after login
        await page.goto(settingsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('  Now at:', page.url());
    }

    // ── Step 3: wait for the CM setup banner ──────────────────────────────
    console.log('\n→ Waiting for Canvas Messenger setup banner…');
    await page.waitForTimeout(2500); // let token-setup.js run (1500ms delay + margin)

    const banner = page.locator('#cm-setup-banner');
    const bannerVisible = await banner.isVisible().catch(() => false);
    if (!bannerVisible) {
        console.warn('  Banner not visible — checking why…');
        const hasChip = await page.locator('#cm-setup-chip').isVisible().catch(() => false);
        console.log('  Setup chip visible:', hasChip);
        const stored = await page.evaluate(() =>
            new Promise(r => chrome?.storage?.local?.get(['apiToken', 'canvasUrl'], r))
        ).catch(() => null);
        console.log('  Stored settings:', stored);
    } else {
        console.log('  ✓ Banner visible');
    }

    // ── Step 4: click Set Up / Regenerate ─────────────────────────────────
    const actionBtn = page.locator('#cm-action-btn');
    if (await actionBtn.isVisible().catch(() => false)) {
        console.log('\n→ Clicking action button…');
        await actionBtn.click();
    } else {
        console.warn('  Action button not found — test may be incomplete');
    }

    // ── Step 5: watch overlay for 15 seconds ─────────────────────────────
    console.log('\n→ Watching overlay for 15s…');
    const seen = new Set();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const text = await page.locator('#cm-overlay span').textContent().catch(() => null);
        if (text && !seen.has(text)) {
            seen.add(text);
            console.log('  overlay:', text);
        }
        // Check for confirmation overlay success
        const confirmed = await page.locator('#cm-confirm-save').isVisible().catch(() => false);
        if (confirmed) {
            console.log('\n  ✓ Token generated! Confirmation dialog visible.');
            break;
        }
        await page.waitForTimeout(250);
    }

    // ── Step 6: check stored token ────────────────────────────────────────
    const finalStored = await page.evaluate(() =>
        new Promise(r => chrome?.storage?.local?.get(['apiToken', 'canvasUrl'], r))
    ).catch(() => null);
    console.log('\n→ Final stored settings:', finalStored
        ? { canvasUrl: finalStored.canvasUrl, apiToken: finalStored.apiToken ? '[SET]' : '[NOT SET]' }
        : 'unavailable');

    console.log('\nDone — browser left open. Close manually when finished.\n');
    // Keep browser open for manual inspection
})();
