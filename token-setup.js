// Runs on Canvas profile/settings pages only.
// Auto-generates a Canvas API token and saves it to the extension with confirmation.

(async () => {
    // Only act if we're on the settings page AND no token is saved yet
    const { apiToken } = await new Promise(r => chrome.storage.local.get(['apiToken'], r));
    if (apiToken) return;

    if (!location.pathname.includes('/profile/settings') && !location.pathname.includes('/profile')) return;

    // Make sure this is actually Canvas (ENV is set by Canvas)
    if (!window.ENV) return;

    // Wait for the page to be ready
    await new Promise(r => {
        if (document.readyState === 'complete') return r();
        window.addEventListener('load', r);
    });

    // ── Find the "New Access Token" link ────────────────────────────────────
    // Canvas renders this differently across versions — try multiple selectors
    function findNewTokenLink() {
        return (
            document.querySelector('a.add_access_token_link') ||
            document.querySelector('[data-testid="new-access-token-button"]') ||
            [...document.querySelectorAll('a, button')].find(el =>
                /new access token|add.*(token|key)/i.test(el.textContent)
            )
        );
    }

    const link = findNewTokenLink();
    if (!link) return; // Can't find the button — bail silently

    // ── Inject a setup banner ───────────────────────────────────────────────
    if (document.getElementById('cm-setup-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'cm-setup-banner';
    banner.style.cssText = `
        position: fixed; top: 16px; right: 16px; z-index: 99999;
        background: #5865f2; color: #fff;
        padding: 12px 18px; border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px; font-weight: 600;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        display: flex; align-items: center; gap: 12px;
        max-width: 340px; line-height: 1.4;
        animation: cm-slidein 0.3s ease;
    `;

    const style = document.createElement('style');
    style.textContent = `
        @keyframes cm-slidein {
            from { transform: translateY(-20px); opacity: 0; }
            to   { transform: translateY(0);     opacity: 1; }
        }
    `;
    document.head.appendChild(style);

    banner.innerHTML = `
        <span style="font-size:22px">📚</span>
        <div style="flex:1">
            <div>Canvas Messenger</div>
            <div style="font-weight:400;font-size:12px;opacity:0.9;margin-top:2px">
                Click to auto-generate your API token
            </div>
        </div>
        <button id="cm-auto-token-btn" style="
            background: #fff; color: #5865f2; border: none;
            border-radius: 5px; padding: 6px 14px; font-size: 13px;
            font-weight: 700; cursor: pointer; white-space: nowrap;
        ">Set up</button>
        <button id="cm-banner-close" style="
            background: none; border: none; color: rgba(255,255,255,0.7);
            font-size: 18px; cursor: pointer; padding: 0 0 0 4px; line-height: 1;
        ">×</button>`;

    document.body.appendChild(banner);

    document.getElementById('cm-banner-close').addEventListener('click', () => banner.remove());

    document.getElementById('cm-auto-token-btn').addEventListener('click', () => {
        banner.remove();
        runAutoSetup();
    });

    // ── Auto-setup flow ─────────────────────────────────────────────────────

    async function runAutoSetup() {
        showOverlay('Opening token dialog…');

        // Click the "New Access Token" link to open the modal
        link.click();

        // Wait for a modal/dialog/form to appear
        const form = await waitFor(() =>
            document.querySelector('#access_token_form, form[action*="access_token"], [data-testid="access-token-form"]') ||
            document.querySelector('[role="dialog"], .ui-dialog')
        , 4000);

        if (!form) {
            showOverlay('Could not open token dialog automatically.<br>Please click "New Access Token" manually, then come back here.', true);
            return;
        }

        // Fill in the purpose field
        const purposeInput = form.querySelector('#access_token_purpose, input[name="purpose"], input[placeholder*="purpose" i]');
        if (purposeInput) {
            purposeInput.value = 'Canvas Messenger';
            purposeInput.dispatchEvent(new Event('input', { bubbles: true }));
            purposeInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        updateOverlay('Generating token…');

        // Click the generate/submit button
        const submitBtn = form.querySelector(
            'button[type="submit"], input[type="submit"], button.btn-primary, [data-testid="submit-button"]'
        ) || [...form.querySelectorAll('button, input[type=submit]')].find(el =>
            /generate|create|submit|save/i.test(el.textContent + el.value)
        );

        if (!submitBtn) {
            showOverlay('Could not find the Generate button.<br>Please generate the token manually.', true);
            return;
        }

        submitBtn.click();

        // Wait for the token to appear in the page (Canvas shows it once after generation)
        const token = await waitForToken(6000);

        if (!token) {
            showOverlay('Could not capture the token automatically.<br>Copy it manually and paste it in the extension settings.', true);
            return;
        }

        // ── Confirmation step ─────────────────────────────────────────────
        showConfirmation(token);
    }

    // ── Wait for generated token to appear in the DOM ──────────────────────

    async function waitForToken(timeout) {
        const start = Date.now();
        return new Promise(resolve => {
            const observer = new MutationObserver(() => {
                const token = extractToken();
                if (token) { observer.disconnect(); resolve(token); }
                if (Date.now() - start > timeout) { observer.disconnect(); resolve(null); }
            });
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
            setTimeout(() => { observer.disconnect(); resolve(extractToken()); }, timeout);
        });
    }

    function extractToken() {
        // Canvas shows the token in various places depending on version
        const candidates = [
            document.querySelector('#token_box input, #token_box code, #token_value'),
            document.querySelector('[data-testid="token-value"], .access_token_box'),
            [...document.querySelectorAll('input[type=text], code')].find(el =>
                /^[a-zA-Z0-9~_\-]{20,}$/.test((el.value || el.textContent || '').trim())
            ),
        ];
        for (const el of candidates) {
            if (!el) continue;
            const val = (el.value || el.textContent || '').trim();
            // Canvas tokens are long alphanumeric strings
            if (/^[a-zA-Z0-9~_\-]{20,}$/.test(val)) return val;
        }
        return null;
    }

    // ── Confirmation overlay ───────────────────────────────────────────────

    function showConfirmation(token) {
        const overlay = document.getElementById('cm-overlay');
        if (overlay) overlay.remove();

        const el = document.createElement('div');
        el.id = 'cm-confirm';
        el.style.cssText = `
            position: fixed; inset: 0; z-index: 100000;
            background: rgba(0,0,0,0.6);
            display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        `;
        el.innerHTML = `
            <div style="
                background: #2b2d31; color: #dcddde; border-radius: 12px;
                padding: 28px 32px; max-width: 420px; width: 90%;
                box-shadow: 0 8px 40px rgba(0,0,0,0.6);
            ">
                <div style="font-size:28px;margin-bottom:12px">📚</div>
                <h2 style="color:#fff;font-size:18px;margin-bottom:8px">Token generated!</h2>
                <p style="font-size:13px;color:#87898c;margin-bottom:20px;line-height:1.5">
                    Canvas Messenger generated an API token with purpose <strong style="color:#dcddde">Canvas Messenger</strong>.
                    Save it to the extension to finish setup?
                </p>
                <div style="
                    background:#1e1f22;border-radius:6px;padding:10px 14px;
                    font-family:monospace;font-size:12px;color:#57f287;
                    word-break:break-all;margin-bottom:20px;
                ">
                    ${token.slice(0, 8)}${'•'.repeat(Math.max(0, token.length - 16))}${token.slice(-8)}
                </div>
                <div style="display:flex;gap:10px;justify-content:flex-end">
                    <button id="cm-confirm-cancel" style="
                        background:#383a40;border:none;color:#dcddde;
                        padding:9px 18px;border-radius:5px;font-size:14px;cursor:pointer;
                    ">Cancel</button>
                    <button id="cm-confirm-save" style="
                        background:#5865f2;border:none;color:#fff;
                        padding:9px 20px;border-radius:5px;font-size:14px;
                        font-weight:600;cursor:pointer;
                    ">Save to Extension</button>
                </div>
            </div>`;
        document.body.appendChild(el);

        document.getElementById('cm-confirm-cancel').addEventListener('click', () => el.remove());

        document.getElementById('cm-confirm-save').addEventListener('click', async () => {
            const canvasUrl = location.origin;
            const user = window.ENV?.current_user || null;
            await new Promise(r => chrome.storage.local.set({
                canvasUrl,
                apiToken: token,
                ...(user ? { currentUser: { id: user.id, name: user.display_name || user.name, login_id: user.email } } : {}),
            }, r));
            chrome.runtime.sendMessage({ action: 'updateBadge' });
            el.remove();
            showSuccess();
        });
    }

    function showSuccess() {
        const el = document.createElement('div');
        el.style.cssText = `
            position: fixed; top: 16px; right: 16px; z-index: 100000;
            background: #57f287; color: #1a1a1a;
            padding: 12px 20px; border-radius: 8px;
            font-family: -apple-system, sans-serif;
            font-size: 14px; font-weight: 700;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        `;
        el.textContent = '✓ Canvas Messenger is ready!';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }

    // ── Overlay helpers ────────────────────────────────────────────────────

    function showOverlay(msg, isError = false) {
        document.getElementById('cm-overlay')?.remove();
        const el = document.createElement('div');
        el.id = 'cm-overlay';
        el.style.cssText = `
            position: fixed; bottom: 24px; right: 24px; z-index: 100000;
            background: ${isError ? '#2c2020' : '#2b2d31'};
            border: 1px solid ${isError ? '#ed4245' : '#404249'};
            color: ${isError ? '#ed4245' : '#dcddde'};
            padding: 14px 18px; border-radius: 8px;
            font-family: -apple-system, sans-serif; font-size: 13px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            max-width: 300px; line-height: 1.5;
            display: flex; align-items: flex-start; gap: 10px;
        `;
        el.innerHTML = `<span>${isError ? '⚠' : '<div style="width:14px;height:14px;border:2px solid #404249;border-top-color:#5865f2;border-radius:50%;animation:cm-spin 0.7s linear infinite"></div>'}</span><span>${msg}</span>`;
        document.body.appendChild(el);
        if (isError) setTimeout(() => el.remove(), 8000);
    }

    function updateOverlay(msg) {
        const el = document.getElementById('cm-overlay');
        if (el) el.querySelector('span:last-child').textContent = msg;
    }

    // ── Poll helper ────────────────────────────────────────────────────────

    function waitFor(fn, timeout = 3000) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                const result = fn();
                if (result) return resolve(result);
                if (Date.now() - start > timeout) return resolve(null);
                requestAnimationFrame(check);
            };
            check();
        });
    }

})();
