/* Injected into all pages — only activates on the configured Canvas domain */
(async () => {
    // ── Auto-detect Canvas from window.ENV ────────────────────────────────
    if (window.ENV && window.ENV.current_user) {
        const user = window.ENV.current_user;
        const stored = await new Promise(r => chrome.storage.local.get(['canvasUrl'], r));
        if (!stored.canvasUrl) {
            chrome.storage.local.set({
                canvasUrl: location.origin,
                currentUser: {
                    id: user.id,
                    name: user.display_name || user.name,
                    login_id: user.email || user.login_id || '',
                },
            });
        }
    }

    const settings = await new Promise(r => chrome.storage.local.get(['canvasUrl'], r));
    const isCanvas  = !!(window.ENV && window.ENV.current_user);
    const canvasUrl = settings.canvasUrl || (isCanvas ? location.origin : null);
    if (!canvasUrl) return;

    const canvasHost = new URL(canvasUrl).hostname;
    if (location.hostname !== canvasHost) return;

    // Already injected (e.g. SPA navigation)
    if (document.getElementById('cm-host')) return;

    // ── Panel width ───────────────────────────────────────────────────────
    // Clamp between 480px and 780px, never more than 45% of viewport
    const PANEL_W = Math.min(780, Math.max(480, Math.round(window.innerWidth * 0.38)));

    // ── Styles ────────────────────────────────────────────────────────────
    const styleEl = document.createElement('style');
    styleEl.textContent = `
        #cm-host {
            position: fixed;
            top: 0;
            right: 0;
            width: ${PANEL_W}px;
            height: 100vh;
            z-index: 99999;
            transform: translateX(100%);
            transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: -6px 0 40px rgba(0,0,0,0.45);
        }
        #cm-host.cm-open {
            transform: translateX(0);
        }

        /* Push page content left when panel is open */
        body.cm-panel-open {
            margin-right: ${PANEL_W}px !important;
            transition: margin-right 0.28s cubic-bezier(0.4, 0, 0.2, 1);
        }
        body {
            transition: margin-right 0.28s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Keep Canvas fixed header from spanning under the panel */
        body.cm-panel-open #header,
        body.cm-panel-open .ic-app-header,
        body.cm-panel-open nav[role="navigation"] {
            right: ${PANEL_W}px !important;
            transition: right 0.28s cubic-bezier(0.4, 0, 0.2, 1);
        }
    `;
    document.head.appendChild(styleEl);

    // ── Floating chat button ──────────────────────────────────────────────
    const fabStyle = document.createElement('style');
    fabStyle.textContent = `
        #cm-fab {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 52px;
            height: 52px;
            border-radius: 50%;
            background: #5865f2;
            color: #fff;
            border: none;
            cursor: pointer;
            z-index: 99998;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 18px rgba(0,0,0,0.4);
            transition: transform 0.15s, background 0.15s, right 0.28s cubic-bezier(0.4,0,0.2,1);
        }
        #cm-fab:hover { background: #4752c4; transform: scale(1.08); }
        #cm-fab.cm-open { background: #404249; right: calc(${PANEL_W}px + 14px); }
        #cm-fab.cm-open:hover { background: #35373c; }
        #cm-fab .cm-fab-badge {
            position: absolute;
            top: -3px; right: -3px;
            background: #ed4245;
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            min-width: 17px;
            height: 17px;
            border-radius: 9px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0 4px;
            font-family: -apple-system, sans-serif;
            pointer-events: none;
        }
    `;
    document.head.appendChild(fabStyle);

    const fab = document.createElement('button');
    fab.id = 'cm-fab';
    fab.title = 'Canvas Messenger';
    fab.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>`;
    document.body.appendChild(fab);

    // ── Panel (shadow DOM for CSS isolation) ──────────────────────────────
    const host = document.createElement('div');
    host.id = 'cm-host';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    const cssResp = await fetch(chrome.runtime.getURL('styles/messenger.css'));
    const cssText = await cssResp.text();
    const shadowStyle = document.createElement('style');
    shadowStyle.textContent = cssText;
    shadow.appendChild(shadowStyle);

    const appRoot = document.createElement('div');
    appRoot.style.cssText = 'width:100%;height:100vh;overflow:hidden;';
    shadow.appendChild(appRoot);

    const jsResp = await fetch(chrome.runtime.getURL('styles/messenger.js'));
    const jsText = await jsResp.text();
    const fn = new Function(jsText); // eslint-disable-line no-new-func
    fn();

    new CanvasMessenger(appRoot, { popup: false }); // eslint-disable-line no-undef

    // ── Toggle logic ──────────────────────────────────────────────────────
    let isOpen = false;

    function openPanel() {
        isOpen = true;
        host.classList.add('cm-open');
        document.body.classList.add('cm-panel-open');
        fab.classList.add('cm-open');
        fab.title = 'Close Canvas Messenger';
    }

    function closePanel() {
        isOpen = false;
        host.classList.remove('cm-open');
        document.body.classList.remove('cm-panel-open');
        fab.classList.remove('cm-open');
        fab.title = 'Canvas Messenger';
    }

    function togglePanel() {
        isOpen ? closePanel() : openPanel();
    }

    fab.addEventListener('click', togglePanel);

    // Extension icon click (message from background)
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.action === 'toggleSidebar') {
            togglePanel();
            sendResponse({ ok: true });
        }
    });

    // Escape to close
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isOpen) closePanel();
    });

    // ── Unread badge on FAB ───────────────────────────────────────────────
    async function updateBadge() {
        try {
            const convs = await new Promise(r =>
                chrome.runtime.sendMessage({ action: 'getConversations', scope: 'unread' }, r)
            );
            const count = Array.isArray(convs) ? convs.length : 0;
            chrome.runtime.sendMessage({ action: 'updateBadge' });

            let badge = fab.querySelector('.cm-fab-badge');
            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'cm-fab-badge';
                    fab.appendChild(badge);
                }
                badge.textContent = count > 99 ? '99+' : String(count);
            } else {
                badge?.remove();
            }
        } catch {}
    }

    updateBadge();
    setInterval(updateBadge, 60000);
})();
