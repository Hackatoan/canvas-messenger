/* Injected into all pages — activates on any detected Canvas instance */
(async () => {

    // ── Canvas detection (multiple fallbacks) ─────────────────────────────
    function detectCanvas() {
        const env = window.ENV || {};
        if (env.DOMAIN_ROOT_ACCOUNT_ID !== undefined) return true;
        if (env.current_user_id   !== undefined) return true;
        if (env.current_user      !== undefined) return true;
        if (document.querySelector('.ic-app-header, #ic-app-header-primary')) return true;
        if (document.querySelector('link[rel="apple-touch-icon"][href*="canvas"]')) return true;
        if (document.querySelector('#application[data-account-id]')) return true;
        return false;
    }

    const isCanvas = detectCanvas();
    const stored   = await new Promise(r => chrome.storage.local.get(['canvasUrl', 'apiToken'], r));

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

    // ── FAB position & button mode (persisted) ────────────────────────────
    let navbarMode = localStorage.getItem('cm-button-mode') === 'navbar';
    const savedFabPos = JSON.parse(localStorage.getItem('cm-fab-pos') || 'null');
    let fabBottom = savedFabPos ? savedFabPos.bottom : 24;
    let fabRight  = savedFabPos ? savedFabPos.right  : 24;

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
            position: fixed;
            width: 52px; height: 52px; border-radius: 50%;
            background: #5865f2; color: #fff; border: none;
            cursor: grab; z-index: 100000;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 4px 18px rgba(0,0,0,0.4);
            transition: background 0.15s, transform 0.15s, right 0.28s cubic-bezier(0.4,0,0.2,1), bottom 0.28s cubic-bezier(0.4,0,0.2,1);
            user-select: none;
        }
        #cm-fab:hover { background: #4752c4; transform: scale(1.08); }
        #cm-fab.cm-open { background: #404249; transform: none; }
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

    // ── FAB position helper ────────────────────────────────────────────────
    function applyFabPos() {
        if (navbarMode) return;
        const rightVal = isOpen ? fabRight + PANEL_W + 14 : fabRight;
        fab.style.bottom = fabBottom + 'px';
        fab.style.right  = rightVal  + 'px';
        fab.style.top    = 'auto';
        fab.style.left   = 'auto';
    }

    // ── FAB ───────────────────────────────────────────────────────────────
    const fab = document.createElement('button');
    fab.id    = 'cm-fab';
    fab.title = 'Canvas Messenger (drag to move, right-click for options)';
    fab.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    document.body.appendChild(fab);
    applyFabPos();
    if (navbarMode) fab.style.display = 'none';

    // ── Panel host + shadow DOM ───────────────────────────────────────────
    const host   = document.createElement('div');
    host.id      = 'cm-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const loadingEl = document.createElement('div');
    loadingEl.style.cssText = `display:flex;align-items:center;justify-content:center;
        height:100vh;color:#87898c;font-family:sans-serif;font-size:14px;gap:10px;background:#313338;`;
    loadingEl.innerHTML = `<div style="width:18px;height:18px;border:2px solid #404249;
        border-top-color:#5865f2;border-radius:50%;animation:s 0.7s linear infinite"></div>
        Loading…<style>@keyframes s{to{transform:rotate(360deg)}}</style>`;
    shadow.appendChild(loadingEl);

    // ── Toggle logic ──────────────────────────────────────────────────────
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
        applyFabPos();
        updateNavBtn();
    }
    function closePanel() {
        isOpen = false;
        host.classList.remove('cm-open');
        document.body.classList.remove('cm-panel-open');
        fab.classList.remove('cm-open');
        fab.title = 'Canvas Messenger (drag to move, right-click for options)';
        applyFabPos();
        updateNavBtn();
    }
    function togglePanel() { isOpen ? closePanel() : openPanel(); }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.action === 'toggleSidebar') { togglePanel(); sendResponse({ ok: true }); }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isOpen) closePanel();
    });

    // ── Draggable FAB ─────────────────────────────────────────────────────
    let isDragging = false;

    fab.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const startB = fabBottom, startR = fabRight;
        isDragging = false;
        fab.style.transition = 'background 0.15s, transform 0.15s';

        function onMove(ev) {
            const dx = ev.clientX - startX, dy = ev.clientY - startY;
            if (!isDragging && Math.hypot(dx, dy) > 5) {
                isDragging = true;
                fab.style.cursor = 'grabbing';
            }
            if (isDragging) {
                fabRight  = Math.max(8, Math.min(startR - dx, window.innerWidth  - 60));
                fabBottom = Math.max(8, Math.min(startB + dy, window.innerHeight - 60));
                applyFabPos();
            }
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
            fab.style.transition = '';
            fab.style.cursor     = '';
            if (isDragging) {
                localStorage.setItem('cm-fab-pos', JSON.stringify({ bottom: fabBottom, right: fabRight }));
            } else {
                togglePanel();
            }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });

    fab.addEventListener('contextmenu', e => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, false);
    });

    // ── Context menu (for FAB and nav button) ─────────────────────────────
    function showContextMenu(x, y, fromNav) {
        document.getElementById('cm-ctx-menu')?.remove();
        const menu = document.createElement('div');
        menu.id = 'cm-ctx-menu';
        Object.assign(menu.style, {
            position: 'fixed', zIndex: '100001',
            left: Math.min(x, window.innerWidth  - 185) + 'px',
            top:  Math.min(y, window.innerHeight - 90)  + 'px',
            background: '#2b2d31', border: '1px solid #1e1f22',
            borderRadius: '6px', padding: '4px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            fontFamily: '-apple-system,sans-serif', minWidth: '175px',
        });

        const items = fromNav
            ? [{ label: 'Move back to corner', action: () => setNavbarMode(false) }]
            : [
                { label: 'Move to nav bar', action: () => setNavbarMode(true) },
                { label: 'Reset to corner',  action: () => {
                    fabBottom = 24; fabRight = 24;
                    localStorage.removeItem('cm-fab-pos');
                    applyFabPos();
                }},
              ];

        for (const item of items) {
            const btn = document.createElement('button');
            btn.textContent = item.label;
            Object.assign(btn.style, {
                display: 'block', width: '100%', textAlign: 'left',
                background: 'none', border: 'none', color: '#dbdee1',
                padding: '6px 12px', borderRadius: '4px', fontSize: '13px',
                cursor: 'pointer', fontFamily: 'inherit',
            });
            btn.addEventListener('mouseenter', () => btn.style.background = '#404249');
            btn.addEventListener('mouseleave', () => btn.style.background = 'none');
            btn.addEventListener('click', () => { menu.remove(); item.action(); });
            menu.appendChild(btn);
        }

        document.body.appendChild(menu);
        const dismiss = e => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('mousedown', dismiss);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
    }

    // ── Navbar mode ───────────────────────────────────────────────────────
    function setNavbarMode(enabled) {
        navbarMode = enabled;
        localStorage.setItem('cm-button-mode', enabled ? 'navbar' : 'fab');
        if (enabled) {
            fab.style.display = 'none';
            injectNavButton();
        } else {
            fab.style.display = '';
            document.getElementById('cm-nav-li')?.remove();
            applyFabPos();
        }
    }

    function injectNavButton() {
        if (document.getElementById('cm-nav-li')) return;
        const navUl = document.querySelector('#menu')
            || document.querySelector('.ic-app-header__main-navigation ul')
            || document.querySelector('.ic-app-header ul');
        if (!navUl) {
            // Canvas nav not found — silently revert to FAB mode
            setNavbarMode(false);
            return;
        }
        const li = document.createElement('li');
        li.id = 'cm-nav-li';
        li.className = 'ic-app-header__menu-list-item';
        li.innerHTML = `
            <a id="cm-nav-btn" href="javascript:void(0)" role="button" tabindex="0"
               class="ic-app-header__menu-list-link"
               style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                      gap:3px;cursor:pointer;padding:14px 2px;color:inherit;text-decoration:none;">
                <div style="position:relative;line-height:0">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <div id="cm-nav-badge" style="display:none;position:absolute;top:-4px;right:-6px;
                         background:#ed4245;color:#fff;font-size:9px;font-weight:700;
                         min-width:14px;height:14px;border-radius:7px;
                         align-items:center;justify-content:center;padding:0 3px;
                         font-family:-apple-system,sans-serif;pointer-events:none"></div>
                </div>
                <span class="menu-item__text" style="font-size:10px">Messenger</span>
            </a>`;

        li.querySelector('#cm-nav-btn').addEventListener('click', e => {
            e.preventDefault();
            togglePanel();
        });
        li.querySelector('#cm-nav-btn').addEventListener('contextmenu', e => {
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, true);
        });
        navUl.appendChild(li);
        updateNavBtn();
    }

    function updateNavBtn() {
        const btn = document.getElementById('cm-nav-btn');
        if (!btn) return;
        btn.style.color = isOpen ? '#5865f2' : '';
    }

    // Inject nav button if mode was saved
    if (navbarMode) {
        const tryInject = () => {
            if (document.querySelector('#menu, .ic-app-header__main-navigation, .ic-app-header')) {
                injectNavButton();
            } else if (document.readyState !== 'complete') {
                setTimeout(tryInject, 300);
            }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', tryInject);
        } else {
            tryInject();
        }
    }

    // ── Resize handle ──────────────────────────────────────────────────────
    const handle = document.createElement('div');
    handle.id    = 'cm-resize-handle';
    handle.style.cssText = `
        position:absolute;left:0;top:0;width:6px;height:100%;
        cursor:ew-resize;z-index:1000;box-sizing:border-box;
        transition:background 0.15s;
    `;
    shadow.appendChild(handle);

    handle.addEventListener('mousedown', e => {
        e.preventDefault();
        handle.style.background = 'rgba(88,101,242,0.45)';
        const startX = e.clientX;
        const startW = PANEL_W;

        function onMove(e) {
            const delta = startX - e.clientX;
            PANEL_W = Math.min(1000, Math.max(300, startW + delta));
            host.style.width        = PANEL_W + 'px';
            host.style.transition   = 'none';
            document.body.style.transition = 'none';
            if (isOpen) document.body.style.marginRight = PANEL_W + 'px';
            applyFabPos();
        }

        function onUp() {
            handle.style.background = '';
            host.style.transition   = '';
            document.body.style.transition = '';
            localStorage.setItem('cm-panel-width', PANEL_W);
            applyWidth(PANEL_W);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });

    handle.addEventListener('mouseenter', () => { handle.style.background = 'rgba(88,101,242,0.25)'; });
    handle.addEventListener('mouseleave', () => { handle.style.background = ''; });

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

            // FAB badge
            let badge = fab.querySelector('.cm-fab-badge');
            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'cm-fab-badge';
                    fab.appendChild(badge);
                }
                badge.textContent = count > 99 ? '99+' : String(count);
            } else { badge?.remove(); }

            // Nav button badge
            const navBadge = document.getElementById('cm-nav-badge');
            if (navBadge) {
                if (count > 0) {
                    navBadge.textContent = count > 99 ? '99+' : String(count);
                    navBadge.style.display = 'flex';
                } else {
                    navBadge.style.display = 'none';
                }
            }
        } catch {}
    }

    updateBadge();
    setInterval(updateBadge, 60000);
})();
