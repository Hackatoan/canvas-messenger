// Runs on Canvas pages to auto-generate an API token when none is saved.
// On the settings page: detects existing "Canvas Messenger" tokens and
// offers to regenerate them. On other Canvas pages shows a setup chip.

(async () => {
    const stored = await new Promise(r => chrome.storage.local.get(['apiToken'], r));

    // ── Detect Canvas ─────────────────────────────────────────────────────
    const env = window.ENV || {};
    const isCanvas = !!(
        env.DOMAIN_ROOT_ACCOUNT_ID !== undefined ||
        env.current_user_id        !== undefined ||
        env.current_user           !== undefined ||
        document.querySelector('.ic-app-header, #ic-app-header-primary') ||
        document.querySelector('#application[data-account-id]')
    );
    if (!isCanvas) return;

    await new Promise(r => {
        if (document.readyState === 'complete') return r();
        window.addEventListener('load', r, { once: true });
    });

    // ── Settings page detection ───────────────────────────────────────────
    const path = location.pathname;
    const isSettingsPage = (
        path.includes('/profile/settings') ||
        path.includes('/user_settings')    ||
        path === '/profile'
    );

    if (!isSettingsPage) {
        // Only show chip if not already set up
        if (!stored.apiToken) showSetupChip();
        return;
    }

    // On settings page: always check — even if token stored we may need to regen
    setTimeout(tryAutoSetup, 1500);

    // ── Setup chip (shown on non-settings Canvas pages) ───────────────────
    function showSetupChip() {
        if (document.getElementById('cm-setup-chip')) return;
        const chip = document.createElement('div');
        chip.id    = 'cm-setup-chip';
        chip.style.cssText = `
            position: fixed; bottom: 90px; right: 24px; z-index: 99997;
            background: #5865f2; color: #fff; border-radius: 24px;
            padding: 8px 16px 8px 12px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px; font-weight: 600;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4);
            display: flex; align-items: center; gap: 8px; cursor: pointer;
            animation: cm-fadein 0.3s ease;
        `;
        chip.innerHTML = `
            <style>
                @keyframes cm-fadein { from { opacity:0; transform:translateY(8px); } to { opacity:1; } }
            </style>
            <span style="font-size:16px">📚</span>
            Set up Canvas Messenger
            <span style="opacity:.7;font-size:11px;font-weight:400">click to connect</span>
            <button style="background:none;border:none;color:rgba(255,255,255,.6);
                cursor:pointer;font-size:16px;margin-left:4px;line-height:1;padding:0"
                id="cm-chip-close">×</button>`;

        chip.addEventListener('click', e => {
            if (e.target.id === 'cm-chip-close') { chip.remove(); return; }
            window.location.href = location.origin + '/profile/settings';
        });
        document.body.appendChild(chip);
    }

    // ── Detect existing "Canvas Messenger" token rows in the DOM ─────────
    function findExistingTokenRow() {
        // Canvas renders tokens in a table/list; rows vary by version
        const rows = [
            ...document.querySelectorAll(
                '.access_token, tr, [data-testid*="token"], .ic-Table-row, li'
            ),
        ];
        return rows.find(row => {
            const text = row.textContent || '';
            if (!/canvas\s*messenger/i.test(text)) return false;
            // Must also have a delete action within the same row
            return !!(
                row.querySelector('a.delete_key_link, [data-testid*="delete"], a[href*="delete"]') ||
                [...row.querySelectorAll('button, a')].find(b =>
                    /delete|revoke|remove/i.test(b.textContent)
                )
            );
        });
    }

    // ── Auto-setup on settings page ───────────────────────────────────────
    function tryAutoSetup() {
        if (document.getElementById('cm-setup-banner')) return;

        const existingRow = findExistingTokenRow();
        const newTokenLink = findNewTokenLink();

        if (existingRow) {
            showRegenBanner(existingRow, newTokenLink);
            return;
        }

        // No token stored, no existing row — offer first-time setup
        if (!stored.apiToken) {
            if (!newTokenLink) {
                showManualBanner();
                return;
            }
            showSetupBanner(newTokenLink);
        }
    }

    // ── Setup banner (first-time) ─────────────────────────────────────────
    function showSetupBanner(link) {
        const banner = makeBanner(
            'Canvas Messenger',
            'Auto-generate your API token to get started',
            'Set up'
        );
        document.body.appendChild(banner);
        document.getElementById('cm-action-btn').addEventListener('click', () => {
            banner.remove();
            runAutoSetup(link);
        });
        document.getElementById('cm-close-btn').addEventListener('click', () => banner.remove());
    }

    // ── Regen banner (existing token found) ──────────────────────────────
    function showRegenBanner(existingRow, newTokenLink) {
        const banner = makeBanner(
            'Canvas Messenger — Regenerate Token',
            'A "Canvas Messenger" token already exists. Delete it and generate a fresh one?',
            'Regenerate'
        );
        document.body.appendChild(banner);
        document.getElementById('cm-action-btn').addEventListener('click', async () => {
            banner.remove();
            await deleteExistingToken(existingRow);
            const link = newTokenLink || findNewTokenLink();
            if (!link) { showManualBanner(); return; }
            runAutoSetup(link);
        });
        document.getElementById('cm-close-btn').addEventListener('click', () => banner.remove());
    }

    function makeBanner(title, subtitle, actionLabel) {
        const el = document.createElement('div');
        el.id = 'cm-setup-banner';
        el.style.cssText = `
            position: fixed; top: 16px; right: 16px; z-index: 99999;
            background: #5865f2; color: #fff;
            padding: 12px 16px; border-radius: 8px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 14px; font-weight: 600;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            display: flex; align-items: center; gap: 12px; max-width: 380px;
        `;
        el.innerHTML = `
            <span style="font-size:22px;flex-shrink:0">📚</span>
            <div style="flex:1;line-height:1.4">
                ${escH(title)}<br>
                <span style="font-weight:400;font-size:12px;opacity:.9">${escH(subtitle)}</span>
            </div>
            <button id="cm-action-btn" style="background:#fff;color:#5865f2;border:none;
                border-radius:5px;padding:6px 14px;font-size:13px;font-weight:700;
                cursor:pointer;white-space:nowrap">${escH(actionLabel)}</button>
            <button id="cm-close-btn" style="background:none;border:none;
                color:rgba(255,255,255,.7);font-size:20px;cursor:pointer;
                padding:0;line-height:1;flex-shrink:0">×</button>`;
        return el;
    }

    function escH(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
        );
    }

    function showManualBanner() {
        if (document.getElementById('cm-setup-banner')) return;
        const banner = document.createElement('div');
        banner.id    = 'cm-setup-banner';
        banner.style.cssText = `
            position: fixed; top: 16px; right: 16px; z-index: 99999;
            background: #2b2d31; border: 1px solid #404249; color: #dcddde;
            padding: 14px 18px; border-radius: 8px; max-width: 360px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); line-height:1.5;
        `;
        banner.innerHTML = `
            <div style="font-weight:700;margin-bottom:6px">📚 Canvas Messenger setup</div>
            To connect, click <strong>"+ New Access Token"</strong> on this page,
            set the purpose to <strong>Canvas Messenger</strong>, then paste the
            generated token into the extension settings.<br>
            <div style="text-align:right;margin-top:10px">
                <button id="cm-manual-dismiss" style="background:none;
                border:1px solid #404249;color:#dcddde;border-radius:4px;
                padding:4px 12px;font-size:12px;cursor:pointer">Dismiss</button>
                <button id="cm-manual-settings" style="background:#5865f2;
                border:none;color:#fff;border-radius:4px;padding:4px 12px;
                font-size:12px;cursor:pointer;margin-left:6px">Open settings</button>
            </div>`;
        document.body.appendChild(banner);
        // Use addEventListener — Canvas's CSP blocks inline onclick handlers
        banner.querySelector('#cm-manual-dismiss').addEventListener('click', () => banner.remove());
        banner.querySelector('#cm-manual-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
    }

    // ── Delete an existing token row (DOM path, called from regen banner) ──
    async function deleteExistingToken(row) {
        showOverlay('Removing existing Canvas Messenger token…');

        // Try API deletion first (cleaner, no confirmation dialog needed)
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
        if (csrf) {
            await deleteExistingTokensViaAPI(csrf);
            await new Promise(r => setTimeout(r, 400));
            return;
        }

        // DOM fallback
        const deleteBtn =
            row.querySelector('a.delete_key_link, [data-testid*="delete"]') ||
            [...row.querySelectorAll('button, a')].find(b =>
                /delete|revoke|remove/i.test(b.textContent)
            );
        if (!deleteBtn) return;
        deleteBtn.click();

        const confirmBtn = await waitFor(() =>
            document.querySelector(
                '.ui-dialog:not([style*="display: none"]) button[type="submit"], ' +
                '[data-testid="confirm-delete-button"], ' +
                '.ReactModalPortal button[type="submit"]'
            ) ||
            [...document.querySelectorAll('button')].find(b =>
                /ok|confirm|yes|delete/i.test(b.textContent) &&
                b.offsetParent !== null
            )
        , 4000);
        if (confirmBtn) confirmBtn.click();
        await new Promise(r => setTimeout(r, 800));
    }

    // ── Auto-setup: API-first, UI fallback ───────────────────────────────
    async function runAutoSetup(link) {
        showOverlay('Creating token…');

        // Primary path: POST directly to the Canvas API using the browser's
        // existing session cookie + the CSRF token already in the page.
        // This is far more reliable than automating InstUI's date picker.
        const apiToken = await tryCreateTokenViaAPI();
        if (apiToken) {
            showConfirmation(apiToken);
            return;
        }

        // Fallback: open the dialog and attempt UI automation
        showOverlay('Opening token dialog…');
        link.click();

        const purposeInput = await waitFor(() => {
            const inp = document.querySelector(
                '#access_token_purpose, input[name="purpose"], ' +
                'input[placeholder*="purpose" i], input[id*="purpose" i], ' +
                'input[aria-label*="purpose" i], [data-testid*="purpose"] input'
            );
            return (inp && inp.offsetParent !== null) ? inp : null;
        }, 8000);

        if (!purposeInput) {
            showOverlay('Could not open the token dialog.<br>Please click "+ New Access Token" and fill in the form manually.', true);
            return;
        }

        const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        function setVal(el, v) {
            try { if (nativeSet) nativeSet.call(el, v); else el.value = v; } catch { el.value = v; }
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        setVal(purposeInput, 'Canvas Messenger');
        updateOverlay('Generating token…');

        const container = purposeInput.closest(
            'form, [role="dialog"], dialog, .ui-dialog, .ReactModal__Content, .modal-content'
        ) || document.body;

        const submitBtn =
            container.querySelector('button[type="submit"], input[type="submit"]') ||
            [...container.querySelectorAll('button')].find(b =>
                /generate|create|submit|save/i.test(b.textContent.trim())
            );
        if (!submitBtn) {
            showOverlay('Could not find the Generate button — please click it manually.', true);
            return;
        }
        submitBtn.click();

        const token = await waitForToken(8000);
        if (!token) {
            showOverlay('Could not capture the token — please copy it and paste into extension settings.', true);
            return;
        }
        showConfirmation(token);
    }

    // ── Direct API token creation ─────────────────────────────────────────
    async function tryCreateTokenViaAPI() {
        try {
            const csrf =
                document.querySelector('meta[name="csrf-token"]')?.content ||
                window.ENV?.AUTHENTICITY_TOKEN ||
                document.querySelector('input[name="authenticity_token"]')?.value;
            if (!csrf) {
                updateOverlay('No CSRF token found — trying form…');
                return null;
            }

            await deleteExistingTokensViaAPI(csrf);

            const expires = new Date(Date.now() + 119 * 864e5).toISOString();

            // Attempt 1: JSON body
            let resp = await fetch('/api/v1/users/self/access_tokens', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type':   'application/json',
                    'Accept':         'application/json',
                    'X-CSRF-Token':   csrf,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify({
                    access_token: { purpose: 'Canvas Messenger', expires_at: expires },
                }),
            });

            // Attempt 2: form-encoded (some Canvas instances require this)
            if (!resp.ok) {
                updateOverlay(`API attempt 1 failed (${resp.status}) — retrying…`);
                resp = await fetch('/api/v1/users/self/access_tokens', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept':       'application/json',
                        'X-CSRF-Token': csrf,
                    },
                    body: new URLSearchParams({
                        authenticity_token:        csrf,
                        'access_token[purpose]':    'Canvas Messenger',
                        'access_token[expires_at]': expires,
                    }),
                });
            }

            if (!resp.ok) {
                updateOverlay(`API failed (${resp.status}) — trying form…`);
                return null;
            }

            const data = await resp.json();
            // Canvas returns the full token only at creation time
            return data.token          ||
                   data.visible_token  ||
                   data.full_token     ||
                   data.access_token?.token || null;
        } catch (e) {
            updateOverlay(`API error — trying form… (${e.message})`);
            return null;
        }
    }

    async function deleteExistingTokensViaAPI(csrf) {
        try {
            const resp = await fetch('/api/v1/users/self/access_tokens?per_page=50', {
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json', 'X-CSRF-Token': csrf },
            });
            if (!resp.ok) return;
            const tokens = await resp.json();
            const userId = window.ENV?.current_user_id || 'self';
            for (const t of tokens) {
                if (!/canvas\s*messenger/i.test(t.purpose || '')) continue;
                await fetch(`/api/v1/users/${userId}/access_tokens/${t.id}`, {
                    method: 'DELETE',
                    credentials: 'same-origin',
                    headers: { 'X-CSRF-Token': csrf },
                });
            }
        } catch { /* best-effort */ }
    }

    async function waitForToken(timeout) {
        const start = Date.now();
        return new Promise(resolve => {
            const obs = new MutationObserver(() => {
                const t = extractToken();
                if (t) { obs.disconnect(); return resolve(t); }
                if (Date.now() - start > timeout) { obs.disconnect(); resolve(null); }
            });
            obs.observe(document.body, { childList: true, subtree: true, characterData: true });
            setTimeout(() => { obs.disconnect(); resolve(extractToken()); }, timeout);
        });
    }

    function extractToken() {
        const TOKEN_RE = /^[a-zA-Z0-9~_\-]{20,}$/;

        // Input/code elements first (most reliable)
        for (const el of document.querySelectorAll(
            'input[type=text], input[type=password], input[readonly], code, pre, textarea'
        )) {
            const val = (el.value || el.textContent || '').trim();
            if (TOKEN_RE.test(val)) return val;
        }

        // Leaf nodes inside any visible dialog — Canvas sometimes renders
        // the generated token inside a <span> or <p> in a success modal
        for (const el of document.querySelectorAll(
            '[role="dialog"] *, dialog *, .ui-dialog *, .ReactModal__Content *, ' +
            '.modal-content *, [data-testid*="token"] *'
        )) {
            if (el.children.length > 0) continue;          // skip containers
            const val = (el.textContent || '').trim();
            if (TOKEN_RE.test(val)) return val;
        }

        // Alerts / flash messages — some Canvas versions announce the token here
        for (const el of document.querySelectorAll(
            '[role="alert"], .alert, .flash-message, .ReactModalPortal'
        )) {
            const m = el.textContent.match(/[a-zA-Z0-9~_\-]{20,}/);
            if (m) return m[0];
        }

        return null;
    }

    function findNewTokenLink() {
        return (
            document.querySelector('a.add_access_token_link') ||
            document.querySelector('[data-testid="new-access-token-button"]') ||
            document.querySelector('button[data-testid="add-token"]') ||
            [...document.querySelectorAll('a[href="#"], button, a')].find(el =>
                /new access token|add.*token|\+.*token/i.test(el.textContent.trim())
            )
        );
    }

    // ── Confirmation overlay ──────────────────────────────────────────────
    function showConfirmation(token) {
        document.getElementById('cm-overlay')?.remove();
        const el = document.createElement('div');
        el.style.cssText = `
            position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.65);
            display:flex;align-items:center;justify-content:center;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;`;
        el.innerHTML = `
            <div style="background:#2b2d31;color:#dcddde;border-radius:12px;
                padding:28px 32px;max-width:420px;width:90%;
                box-shadow:0 8px 40px rgba(0,0,0,0.6);">
                <div style="font-size:28px;margin-bottom:12px">📚</div>
                <h2 style="color:#fff;font-size:18px;margin:0 0 8px">Token generated!</h2>
                <p style="font-size:13px;color:#87898c;margin:0 0 20px;line-height:1.5">
                    An API token was created with the purpose
                    <strong style="color:#dcddde">Canvas Messenger</strong>.
                    Save it to finish setup.
                </p>
                <div style="background:#1e1f22;border-radius:6px;padding:10px 14px;
                    font-family:monospace;font-size:12px;color:#57f287;
                    word-break:break-all;margin-bottom:20px;">
                    ${token.slice(0,8)}${'•'.repeat(Math.max(0,token.length-16))}${token.slice(-8)}
                </div>
                <div style="display:flex;gap:10px;justify-content:flex-end">
                    <button id="cm-confirm-cancel" style="background:#383a40;border:none;
                        color:#dcddde;padding:9px 18px;border-radius:5px;
                        font-size:14px;cursor:pointer;">Cancel</button>
                    <button id="cm-confirm-save" style="background:#5865f2;border:none;
                        color:#fff;padding:9px 20px;border-radius:5px;
                        font-size:14px;font-weight:600;cursor:pointer;">Save to Extension</button>
                </div>
            </div>`;
        document.body.appendChild(el);

        el.querySelector('#cm-confirm-cancel').addEventListener('click', () => el.remove());
        el.querySelector('#cm-confirm-save').addEventListener('click', async () => {
            const env  = window.ENV || {};
            const user = env.current_user || {};
            await new Promise(r => chrome.storage.local.set({
                canvasUrl: location.origin,
                apiToken:  token,
                ...(user.id ? {
                    currentUser: {
                        id:       user.id,
                        name:     user.display_name || user.name || '',
                        login_id: user.email || user.login_id || '',
                    },
                } : {}),
            }, r));
            chrome.runtime.sendMessage({ action: 'updateBadge' });
            el.remove();
            showSuccess();
        });
    }

    function showSuccess() {
        const el = document.createElement('div');
        el.style.cssText = `
            position:fixed;top:16px;right:16px;z-index:100000;
            background:#57f287;color:#1a1a1a;padding:12px 20px;border-radius:8px;
            font-family:-apple-system,sans-serif;font-size:14px;font-weight:700;
            box-shadow:0 4px 20px rgba(0,0,0,0.4);`;
        el.textContent = '✓ Canvas Messenger is ready!';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    function showOverlay(msg, isError = false) {
        document.getElementById('cm-overlay')?.remove();
        const el = document.createElement('div');
        el.id    = 'cm-overlay';
        el.style.cssText = `
            position:fixed;bottom:24px;right:24px;z-index:100000;
            background:${isError ? '#2c2020' : '#2b2d31'};
            border:1px solid ${isError ? '#ed4245' : '#404249'};
            color:${isError ? '#ed4245' : '#dcddde'};
            padding:14px 18px;border-radius:8px;
            font-family:-apple-system,sans-serif;font-size:13px;
            box-shadow:0 4px 20px rgba(0,0,0,0.5);max-width:300px;line-height:1.5;
            display:flex;align-items:flex-start;gap:10px;`;
        const spinner = isError ? '⚠' :
            `<div style="width:14px;height:14px;flex-shrink:0;border:2px solid #404249;
                border-top-color:#5865f2;border-radius:50%;animation:s 0.7s linear infinite">
                <style>@keyframes s{to{transform:rotate(360deg)}}</style></div>`;
        el.innerHTML = `${spinner}<span>${msg}</span>`;
        document.body.appendChild(el);
        if (isError) setTimeout(() => el.remove(), 10000);
    }

    function updateOverlay(msg) {
        const el = document.getElementById('cm-overlay');
        if (el) el.querySelector('span').textContent = msg;
    }

    function waitFor(fn, timeout = 4000) {
        return new Promise(resolve => {
            const start = Date.now();
            const tick  = () => {
                const r = fn();
                if (r) return resolve(r);
                if (Date.now() - start > timeout) return resolve(null);
                requestAnimationFrame(tick);
            };
            tick();
        });
    }
})();
