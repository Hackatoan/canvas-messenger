/* Injected into all pages — only activates on the configured Canvas domain */
(async () => {
    // ── Auto-detect Canvas from window.ENV ────────────────────────────────
    if (window.ENV && window.ENV.current_user) {
        const detectedUrl = location.origin;
        const user = window.ENV.current_user;
        const stored = await new Promise(r => chrome.storage.local.get(['canvasUrl', 'apiToken'], r));

        // Auto-save URL and user info even if no token yet
        if (!stored.canvasUrl) {
            chrome.storage.local.set({
                canvasUrl: detectedUrl,
                currentUser: {
                    id: user.id,
                    name: user.display_name || user.name,
                    login_id: user.email || user.login_id || '',
                },
            });
        }
    }

    const settings = await new Promise(resolve =>
        chrome.storage.local.get(['canvasUrl'], resolve)
    );

    // Detect Canvas even without stored URL using window.ENV
    const isCanvas = !!(window.ENV && window.ENV.current_user);
    const canvasUrl = settings.canvasUrl || (isCanvas ? location.origin : null);
    if (!canvasUrl) return;

    const canvasHost = new URL(canvasUrl).hostname;
    if (location.hostname !== canvasHost) return;

    // Already injected (e.g. SPA navigation)
    if (document.getElementById('cm-host')) return;

    // ── Styles ────────────────────────────────────────────────────────────

    const TOGGLE_BTN_CSS = `
        #cm-toggle {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: #5865f2;
            color: #fff;
            border: none;
            cursor: pointer;
            z-index: 99998;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4);
            transition: transform 0.15s, background 0.15s;
            font-size: 22px;
            font-family: sans-serif;
        }
        #cm-toggle:hover { background: #4752c4; transform: scale(1.08); }
        #cm-toggle .cm-badge {
            position: absolute;
            top: -2px;
            right: -2px;
            background: #ed4245;
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            min-width: 16px;
            height: 16px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0 4px;
            font-family: -apple-system, sans-serif;
        }
        #cm-panel {
            position: fixed;
            top: 0;
            right: 0;
            width: 700px;
            max-width: 90vw;
            height: 100vh;
            z-index: 99999;
            box-shadow: -4px 0 32px rgba(0,0,0,0.5);
            transform: translateX(100%);
            transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        }
        #cm-panel.open { transform: translateX(0); }
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = TOGGLE_BTN_CSS;
    document.head.appendChild(styleEl);

    // ── Toggle button ─────────────────────────────────────────────────────

    const toggle = document.createElement('button');
    toggle.id = 'cm-toggle';
    toggle.title = 'Canvas Messenger';
    toggle.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>`;
    document.body.appendChild(toggle);

    // ── Panel (shadow DOM for CSS isolation) ──────────────────────────────

    const host = document.createElement('div');
    host.id = 'cm-host';
    document.body.appendChild(host);

    const panel = document.createElement('div');
    panel.id = 'cm-panel';
    host.appendChild(panel);

    const shadow = panel.attachShadow({ mode: 'open' });

    // Load CSS into shadow
    const cssResp = await fetch(chrome.runtime.getURL('styles/messenger.css'));
    const cssText = await cssResp.text();
    const shadowStyle = document.createElement('style');
    shadowStyle.textContent = cssText;
    shadow.appendChild(shadowStyle);

    // App root inside shadow DOM
    const appRoot = document.createElement('div');
    appRoot.style.cssText = 'width:100%;height:100vh;overflow:hidden;';
    shadow.appendChild(appRoot);

    // Load and execute messenger.js in shadow DOM context
    // (content scripts have access to chrome.runtime, so this works)
    const jsUrl = chrome.runtime.getURL('styles/messenger.js');
    const jsResp = await fetch(jsUrl);
    const jsText = await jsResp.text();

    // Execute in the content-script context (has chrome.runtime access)
    const fn = new Function(jsText); // eslint-disable-line no-new-func
    fn();

    // CanvasMessenger is now defined globally from the executed script
    new CanvasMessenger(appRoot, { popup: false }); // eslint-disable-line no-undef

    // ── Toggle logic ──────────────────────────────────────────────────────

    let isOpen = false;

    toggle.addEventListener('click', () => {
        isOpen = !isOpen;
        panel.classList.toggle('open', isOpen);
    });

    // Close on Escape
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isOpen) {
            isOpen = false;
            panel.classList.remove('open');
        }
    });

    // ── Unread badge on toggle button ─────────────────────────────────────

    async function updateToggleBadge() {
        try {
            const convs = await new Promise(resolve =>
                chrome.runtime.sendMessage({ action: 'getConversations', scope: 'unread' }, resolve)
            );
            const count = Array.isArray(convs) ? convs.length : 0;
            let badge = toggle.querySelector('.cm-badge');
            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'cm-badge';
                    toggle.appendChild(badge);
                }
                badge.textContent = count > 99 ? '99+' : String(count);
            } else {
                badge?.remove();
            }
        } catch {}
    }

    updateToggleBadge();
    setInterval(updateToggleBadge, 60000);
})();
