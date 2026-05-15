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
    }

    function closePanel() {
        isOpen = false;
        host.classList.remove('cm-open');
        document.body.classList.remove('cm-panel-open');
    }

    function togglePanel() {
        isOpen ? closePanel() : openPanel();
    }

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

    // ── Unread badge on extension icon ────────────────────────────────────
    async function updateBadge() {
        try {
            const convs = await new Promise(r =>
                chrome.runtime.sendMessage({ action: 'getConversations', scope: 'unread' }, r)
            );
            const count = Array.isArray(convs) ? convs.length : 0;
            chrome.runtime.sendMessage({ action: 'updateBadge' });
            // Update page title prefix
            const prefix = count > 0 ? `(${count}) ` : '';
            if (!document._cmOrigTitle) document._cmOrigTitle = document.title;
            document.title = prefix + document._cmOrigTitle;
        } catch {}
    }

    updateBadge();
    setInterval(updateBadge, 60000);
})();
