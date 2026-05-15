/* Injected into all pages — activates on any detected Canvas instance */
(async () => {

    // ── Canvas detection (multiple fallbacks) ─────────────────────────────
    // Canvas always sets window.ENV with account info. DOMAIN_ROOT_ACCOUNT_ID
    // and current_user_id are the most reliable indicators across all page types.
    function detectCanvas() {
        const env = window.ENV || {};
        if (env.DOMAIN_ROOT_ACCOUNT_ID !== undefined) return true;
        if (env.current_user_id   !== undefined) return true;
        if (env.current_user      !== undefined) return true;
        // DOM fallback — Canvas always renders these elements when logged in
        if (document.querySelector('.ic-app-header, #ic-app-header-primary')) return true;
        if (document.querySelector('link[rel="apple-touch-icon"][href*="canvas"]')) return true;
        if (document.querySelector('#application[data-account-id]')) return true;
        return false;
    }

    const isCanvas = detectCanvas();
    const stored   = await new Promise(r => chrome.storage.local.get(['canvasUrl', 'apiToken'], r));

    // Auto-save URL + user on first visit to any Canvas page
    if (isCanvas && !stored.canvasUrl) {
        const env  = window.ENV || {};
        const user = env.current_user || {};
        await new Promise(r => chrome.storage.local.set({
            canvasUrl: location.origin,
            ...(user.id ? {
                currentUser: {
                    id:       user.id,
                    name:     user.display_name || user.name || '',
                    login_id: user.email || user.login_id || '',
                },
            } : {}),
        }, r));
    }

    const canvasUrl = stored.canvasUrl || (isCanvas ? location.origin : null);
    if (!canvasUrl) return;

    try {
        if (new URL(canvasUrl).hostname !== location.hostname) return;
    } catch { return; }

    if (document.getElementById('cm-host')) return;

    // ── Panel width (persisted across sessions) ───────────────────────────
    const SAVED_W   = parseInt(localStorage.getItem('cm-panel-width') || '0', 10);
    let   PANEL_W   = SAVED_W || Math.min(780, Math.max(480, Math.round(window.innerWidth * 0.38)));

    // ── Page-level styles ─────────────────────────────────────────────────
    const pageStyle = document.createElement('style');
    pageStyle.id    = 'cm-page-styles';

    function buildPageCSS(w) {
        return `
        #cm-host {
            position: fixed; top: 0; right: 0;
            width: ${w}px; height: 100vh;
            z-index: 99999;
            transform: translateX(100%);
            transition: transform 0.28s cubic-bezier(0.4,0,0.2,1);
            box-shadow: -6px 0 40px rgba(0,0,0,0.45);
            background: #313338;
        }
        #cm-host.cm-open { transform: translateX(0); }

        body { transition: margin-right 0.28s cubic-bezier(0.4,0,0.2,1); }
        body.cm-panel-open { margin-right: ${w}px !important; }

        body.cm-panel-open #header,
        body.cm-panel-open .ic-app-header,
        body.cm-panel-open nav[role="navigation"] {
            right: ${w}px !important;
            transition: right 0.28s cubic-bezier(0.4,0,0.2,1);
        }

        #cm-fab {
            position: fixed; bottom: 24px; right: 24px;
            width: 52px; height: 52px; border-radius: 50%;
            background: #5865f2; color: #fff; border: none;
            cursor: pointer; z-index: 100000;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 4px 18px rgba(0,0,0,0.4);
            transition: transform 0.15s, background 0.15s, right 0.28s cubic-bezier(0.4,0,0.2,1);
        }
        #cm-fab:hover { background: #4752c4; transform: scale(1.08); }
        #cm-fab.cm-open { background: #404249; right: calc(${w}px + 14px); transform: none; }
        #cm-fab.cm-open:hover { background: #35373c; }
        #cm-fab .cm-fab-badge {
            position: absolute; top: -3px; right: -3px;
            background: #ed4245; color: #fff;
            font-size: 10px; font-weight: 700;
            min-width: 17px; height: 17px; border-radius: 9px;
            display: flex; align-items: center; justify-content: center;
            padding: 0 4px; font-family: -apple-system,sans-serif;
            pointer-events: none;
        }
`;
    }

    pageStyle.textContent = buildPageCSS(PANEL_W);
    document.head.appendChild(pageStyle);

    // ── FAB ───────────────────────────────────────────────────────────────
    const fab = document.createElement('button');
    fab.id    = 'cm-fab';
    fab.title = 'Canvas Messenger';
    fab.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    document.body.appendChild(fab);

    // ── Panel host + shadow DOM ───────────────────────────────────────────
    const host   = document.createElement('div');
    host.id      = 'cm-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    // Loading spinner until CSS+app ready
    const loadingEl = document.createElement('div');
    loadingEl.style.cssText = `display:flex;align-items:center;justify-content:center;
        height:100vh;color:#87898c;font-family:sans-serif;font-size:14px;gap:10px;background:#313338;`;
    loadingEl.innerHTML = `<div style="width:18px;height:18px;border:2px solid #404249;
        border-top-color:#5865f2;border-radius:50%;animation:s 0.7s linear infinite"></div>
        Loading…<style>@keyframes s{to{transform:rotate(360deg)}}</style>`;
    shadow.appendChild(loadingEl);

    // ── Toggle logic — wired BEFORE any async work ────────────────────────
    let isOpen = false;

    function applyWidth(w) {
        pageStyle.textContent = buildPageCSS(w);
        if (isOpen) document.body.style.marginRight = w + 'px';
    }

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
    function togglePanel() { isOpen ? closePanel() : openPanel(); }

    fab.addEventListener('click', togglePanel);

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.action === 'toggleSidebar') { togglePanel(); sendResponse({ ok: true }); }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isOpen) closePanel();
    });

    // ── Resize handle (lives in shadow so it renders over the panel) ────────
    const handle = document.createElement('div');
    handle.id    = 'cm-resize-handle';
    // Inline styles — page CSS can't reach inside shadow DOM
    handle.style.cssText = `
        position:absolute;left:0;top:0;width:6px;height:100%;
        cursor:ew-resize;z-index:1000;box-sizing:border-box;
        transition:background 0.15s;
    `;
    // handle goes into the shadow, not the light DOM of a shadow host
    shadow.appendChild(handle);

    handle.addEventListener('mousedown', e => {
        e.preventDefault();
        handle.style.background = 'rgba(88,101,242,0.45)';
        const startX = e.clientX;
        const startW = PANEL_W;

        function onMove(e) {
            const delta = startX - e.clientX;            // drag left = wider
            PANEL_W = Math.min(1000, Math.max(300, startW + delta));
            host.style.width        = PANEL_W + 'px';
            host.style.transition   = 'none';
            document.body.style.transition = 'none';
            if (isOpen) document.body.style.marginRight = PANEL_W + 'px';
            fab.style.right = fab.classList.contains('cm-open')
                ? (PANEL_W + 14) + 'px' : '24px';
        }

        function onUp() {
            handle.style.background = '';
            host.style.transition   = '';
            document.body.style.transition = '';
            localStorage.setItem('cm-panel-width', PANEL_W);
            applyWidth(PANEL_W);
            fab.style.right = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });

    handle.addEventListener('mouseenter', () => {
        handle.style.background = 'rgba(88,101,242,0.25)';
    });
    handle.addEventListener('mouseleave', () => {
        handle.style.background = '';
    });

    // ── Load messenger CSS into shadow, init app ──────────────────────────
    try {
        const cssResp = await fetch(chrome.runtime.getURL('styles/messenger.css'));
        if (!cssResp.ok) throw new Error(`CSS fetch ${cssResp.status}`);
        const shadowStyle = document.createElement('style');
        shadowStyle.textContent = await cssResp.text();
        shadow.replaceChild(shadowStyle, loadingEl);

        const appRoot = document.createElement('div');
        appRoot.style.cssText = 'width:100%;height:100vh;overflow:hidden;';
        shadow.appendChild(appRoot);

        new window.CanvasMessenger(appRoot, { popup: false });
    } catch (err) {
        console.error('[Canvas Messenger] init failed:', err);
        loadingEl.style.color = '#ed4245';
        loadingEl.innerHTML   = `⚠ Canvas Messenger failed to load<br>
            <small style="font-size:11px">${err.message}</small>`;
    }

    // ── Unread badge ──────────────────────────────────────────────────────
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
            } else { badge?.remove(); }
        } catch {}
    }

    updateBadge();
    setInterval(updateBadge, 60000);
})();
