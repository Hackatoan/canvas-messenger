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
    if (!page.url().includes(CANVAS_URL.replace(/\/$/, ''))) {
        console.log('  Redirected to login at', page.url());

        // Try standard Canvas login form first
        let loggedIn = false;

        // Detect login form type by waiting briefly for either form
        await page.waitForTimeout(1500);
        const currentLoginUrl = page.url();

        if (currentLoginUrl.includes('/adfs/') || currentLoginUrl.includes('/saml') ||
            currentLoginUrl.includes('/sso') || currentLoginUrl.includes('/idp')) {
            // ADFS / SAML SSO — Microsoft-style form
            console.log('  Detected SSO/ADFS login form');

            // Dump all input names for debugging
            const inputNames = await page.evaluate(() =>
                [...document.querySelectorAll('input,button,span[id]')]
                    .map(e => `${e.tagName}[id=${e.id}][name=${e.name}][type=${e.type}]`)
            );
            console.log('  Form elements:', inputNames.join(', '));

            const userField = page.locator(
                'input[name="UserName"], input[id="userNameInput"], input[name="username"], input[type="email"]'
            ).first();
            const passField = page.locator(
                'input[name="Password"], input[id="passwordInput"], input[name="password"], input[type="password"]'
            ).first();
            // ADFS submit button is often a <span> or <input id="submitButton">
            const submitBtn = page.locator(
                '#submitButton, input[id="submitButton"], span[id="submitButton"], ' +
                'input[type="submit"], button[type="submit"]'
            ).first();

            await userField.fill(USERNAME, { timeout: 8000 }).catch(e => console.warn('  username field:', e.message));
            await passField.fill(PASSWORD, { timeout: 5000 }).catch(e => console.warn('  password field:', e.message));
            await submitBtn.click({ timeout: 8000 }).catch(e => console.warn('  submit btn:', e.message));

            // ADFS may chain through several redirects
            console.log('  Waiting for post-SSO redirect…');
            await page.waitForURL(
                url => url.includes(CANVAS_URL.replace(/\/$/, '')),
                { timeout: 20000 }
            ).catch(() => console.warn('  SSO redirect timeout'));
            loggedIn = true;
        } else {
            // Standard Canvas login
            const userField = page.locator('#pseudonym_session_unique_id, input[name="pseudonym_session[unique_id]"]').first();
            const passField = page.locator('#pseudonym_session_password, input[name="pseudonym_session[password]"]').first();
            const loginBtn  = page.locator('button[type="submit"], input[type="submit"]').first();
            await userField.fill(USERNAME, { timeout: 8000 }).catch(() => {});
            await passField.fill(PASSWORD, { timeout: 5000 }).catch(() => {});
            await loginBtn.click({ timeout: 5000 }).catch(() => {});
            await page.waitForURL(
                url => url.includes(CANVAS_URL.replace(/\/$/, '')),
                { timeout: 15000 }
            ).catch(() => console.warn('  Login redirect timeout'));
            loggedIn = true;
        }

        // Navigate to settings after login
        console.log('  Post-login URL:', page.url());
        await page.goto(settingsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('  Now at:', page.url());
    }

    // ── Step 2b: API diagnostic ───────────────────────────────────────────
    console.log('\n→ Running API diagnostics…');
    const diag = await page.evaluate(async () => {
        const csrf =
            document.querySelector('meta[name="csrf-token"]')?.content ||
            document.querySelector('input[name="authenticity_token"]')?.value;
        const headers = { 'Accept': 'application/json', 'X-CSRF-Token': csrf || '' };
        const results = {};

        for (const [label, path] of [
            ['GET /api/v1/users/self',        '/api/v1/users/self'],
            ['GET /api/v1/users/self/access_tokens', '/api/v1/users/self/access_tokens'],
            ['GET /profile/tokens',           '/profile/tokens'],
            ['GET /api/v1/accounts',          '/api/v1/accounts'],
        ]) {
            try {
                const r = await fetch(path, { credentials: 'same-origin', headers });
                const body = await r.text().catch(() => '');
                results[label] = `${r.status} — ${body.slice(0, 120)}`;
            } catch (e) {
                results[label] = `ERROR: ${e.message}`;
            }
        }

        // Also capture what network request Canvas makes when creating a token
        // by looking at what the submit button POSTs to via the form action
        const form = document.querySelector('form#new_access_token, [data-testid="access-token-form"], form');
        results['form_action'] = form?.action || 'no form found';
        results['page_url'] = location.href;
        results['csrf_source'] = document.querySelector('meta[name="csrf-token"]') ? 'meta' :
                                 document.querySelector('input[name="authenticity_token"]') ? 'input' : 'none';
        return results;
    });
    for (const [k, v] of Object.entries(diag)) {
        console.log(`  ${k}: ${v}`);
    }

    // ── Step 2c: intercept Canvas's own token-creation request ───────────
    console.log('\n→ Intercepting what Canvas itself calls for token creation…');
    const intercepted = [];
    page.on('request', req => {
        const u = req.url();
        if (/token|access/i.test(u) && !u.includes('adfs') && !u.includes('.js') && !u.includes('.css')) {
            intercepted.push(`${req.method()} ${u}`);
            console.log('  [request]', req.method(), u);
        }
    });
    page.on('response', resp => {
        const u = resp.url();
        if (/token|access/i.test(u) && !u.includes('adfs') && !u.includes('.js') && !u.includes('.css')) {
            console.log('  [response]', resp.status(), u);
            resp.text().then(b => console.log('  [body]', b.slice(0, 200))).catch(() => {});
        }
    });

    // Find and click the "New Access Token" button, fill form, click Generate
    await page.waitForTimeout(1500);

    // Dismiss the Canvas product tour overlay if present (it intercepts pointer events)
    await page.evaluate(() => {
        const tour = document.getElementById('___reactour');
        if (tour) { tour.style.display = 'none'; tour.style.pointerEvents = 'none'; }
    }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);

    const newTokenBtn = page.locator('a.add_access_token_link, [data-testid="new-access-token-button"], button[data-testid="add-token"]').first()
        .or(page.locator('a, button').filter({ hasText: /new access token|\+ new/i }).first());
    if (await newTokenBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('  Clicking New Access Token…');
        await newTokenBtn.click({ force: true });
        await page.waitForTimeout(2000);

        // Dump what opened after the click
        const dialogContent = await page.evaluate(() => {
            const d = document.querySelector('[role="dialog"], .ReactModal__Content, .ui-dialog');
            if (!d) return 'no dialog found';
            const inputs = [...d.querySelectorAll('input, select, button')].map(el =>
                `${el.tagName}[id=${el.id}][name=${el.name}][type=${el.type}][value=${el.value?.slice(0,30)}]`
            );
            return `text: ${d.textContent.replace(/\s+/g,' ').trim().slice(0,200)} | inputs: ${inputs.join(', ')}`;
        });
        console.log('  Dialog after click:', dialogContent);

        // Fill purpose
        const purposeInput = page.locator('#access_token_purpose, input[name="purpose"], input[id*="purpose" i]').first();
        const purposeVisible = await purposeInput.isVisible({ timeout: 3000 }).catch(() => false);
        console.log('  Purpose input visible:', purposeVisible);
        if (purposeVisible) {
            await purposeInput.fill('CM-Test');
        }
        // Click Generate Token to trigger the actual network request
        const genBtn = page.locator('button:has-text("Generate Token"), input[value*="Generate"], button[type="submit"]').first();
        const genVisible = await genBtn.isVisible({ timeout: 3000 }).catch(() => false);
        console.log('  Generate Token button visible:', genVisible);
        if (genVisible) {
            console.log('  Clicking Generate Token to capture network request…');
            await genBtn.click({ force: true });
            await page.waitForTimeout(3000);
            // Log dialog state after generate
            const afterGenerate = await page.evaluate(() => {
                const d = document.querySelector('[role="dialog"], .ReactModal__Content');
                return d ? d.textContent.replace(/\s+/g,' ').trim().slice(0, 400) : 'no dialog';
            });
            console.log('  Dialog after Generate:', afterGenerate);
        }
        // Close dialog if opened
        await page.keyboard.press('Escape').catch(() => {});
    } else {
        console.log('  New Access Token button not found');
    }
    console.log('  Intercepted requests:', intercepted.length ? intercepted.join(', ') : 'none');

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

    // ── Step 5: watch overlay for 40 seconds ─────────────────────────────
    console.log('\n→ Watching overlay for 40s…');
    const seen = new Set();
    const deadline = Date.now() + 40000;
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
            // Dump token text for diagnostics
            const confirmText = await page.locator('#cm-confirm-save').evaluate(
                el => el.closest('[style*="position:fixed"]')?.textContent
            ).catch(() => null);
            console.log('  Confirmation dialog text:', confirmText?.replace(/\s+/g, ' ').trim().slice(0, 200));
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
