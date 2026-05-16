// ── Signaling WebSocket (kept alive via alarms) ───────────────────────────────

const SIGNALING_URL = 'wss://signaling.hackatoa.com';
let sigWs = null;

function connectSignaling() {
    if (sigWs && (sigWs.readyState === WebSocket.OPEN || sigWs.readyState === WebSocket.CONNECTING)) return;
    try {
        sigWs = new WebSocket(SIGNALING_URL);

        sigWs.onopen = async () => {
            const { currentUser } = await getSettings();
            if (currentUser?.id) {
                sigWs.send(JSON.stringify({ type: 'register', userId: String(currentUser.id), name: currentUser.name || '' }));
            }
        };

        sigWs.onmessage = async (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            if (msg.type === 'incoming-call' || msg.type === 'call-failed') {
                // Broadcast to all active Canvas tabs
                const tabs = await chrome.tabs.query({ url: ['https://*/*', 'http://*/*'] });
                for (const tab of tabs) {
                    chrome.tabs.sendMessage(tab.id, { action: 'cm-call-event', payload: msg }).catch(() => {});
                }
            }
        };

        sigWs.onerror = () => {};
        sigWs.onclose = () => { sigWs = null; };
    } catch {}
}

// Reconnect signaling on every badge poll
const _origUpdateBadge = typeof updateBadge !== 'undefined' ? updateBadge : null;

// ── Settings ─────────────────────────────────────────────────────────────────

async function getSettings() {
    return new Promise(resolve => {
        chrome.storage.local.get(['canvasUrl', 'apiToken', 'currentUser'], resolve);
    });
}

// ── Canvas API ────────────────────────────────────────────────────────────────

async function canvasFetch(path, opts = {}) {
    const { canvasUrl, apiToken } = await getSettings();
    if (!canvasUrl || !apiToken) throw new Error('NOT_CONFIGURED');

    const url = `${canvasUrl.replace(/\/$/, '')}/api/v1${path}`;
    const res = await fetch(url, {
        ...opts,
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    if (!res.ok) throw new Error(`API_ERROR:${res.status}`);
    return res.json();
}

async function getConversations(scope = 'all') {
    return canvasFetch(`/conversations?scope=${scope}&per_page=50`);
}

async function getConversation(id) {
    return canvasFetch(`/conversations/${id}`);
}

async function sendReply(id, body) {
    return canvasFetch(`/conversations/${id}/add_message`, {
        method: 'POST',
        body: JSON.stringify({ body }),
    });
}

async function newConversation(recipients, subject, body) {
    return canvasFetch('/conversations', {
        method: 'POST',
        body: JSON.stringify({
            recipients,
            subject,
            body,
            group_conversation: recipients.length > 1,
        }),
    });
}

async function searchRecipients(search, context) {
    // search_all_contexts=true lets Canvas search across the entire institution,
    // not just the current course. context is kept as an optional narrowing filter.
    const ctx = context ? `&context=${encodeURIComponent(context)}` : '';
    return canvasFetch(
        `/search/recipients?search=${encodeURIComponent(search)}&type=user&search_all_contexts=true&per_page=30${ctx}`
    );
}

async function getCourses() {
    return canvasFetch('/courses?enrollment_state=active&per_page=50');
}

async function getGroups() {
    return canvasFetch('/users/self/groups?per_page=50');
}

async function getGroupUsers(groupId) {
    return canvasFetch(`/groups/${groupId}/users?per_page=100`);
}

async function getCourseUsers(courseId, role) {
    const roleParam = role ? `&enrollment_type[]=${role}` : '';
    return canvasFetch(`/courses/${courseId}/users?per_page=100${roleParam}&include[]=enrollments`);
}

// ── Class chat (Discussions) ──────────────────────────────────────────────────

async function getDiscussions(courseId) {
    return canvasFetch(`/courses/${courseId}/discussion_topics?per_page=50&order_by=position`);
}

async function getDiscussionEntries(courseId, topicId) {
    return canvasFetch(`/courses/${courseId}/discussion_topics/${topicId}/entries?per_page=100`);
}

async function createDiscussionEntry(courseId, topicId, message) {
    return canvasFetch(`/courses/${courseId}/discussion_topics/${topicId}/entries`, {
        method: 'POST',
        body: JSON.stringify({ message }),
    });
}

async function createDiscussion(courseId, title) {
    return canvasFetch(`/courses/${courseId}/discussion_topics`, {
        method: 'POST',
        body: JSON.stringify({
            title,
            message: 'Class chat — post messages below.',
            discussion_type: 'threaded',
            published: true,
            pinned: true,
        }),
    });
}

async function findOrCreateClassChat(courseId) {
    const discussions = await getDiscussions(courseId);
    const existing = discussions.find(d =>
        d.title === '📣 Class Chat' || d.title === 'Class Chat'
    );
    if (existing) return existing;
    return createDiscussion(courseId, '📣 Class Chat');
}

async function markRead(id) {
    return canvasFetch(`/conversations/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ workflow_state: 'read' }),
    }).catch(() => {});
}

async function getCurrentUser() {
    return canvasFetch('/users/self');
}

// ── File upload → Canvas ──────────────────────────────────────────────────────

async function uploadCanvasFile(base64Data, filename = 'screenshot.png', contentType = 'image/png') {
    const { canvasUrl, apiToken } = await getSettings();
    if (!canvasUrl || !apiToken) throw new Error('NOT_CONFIGURED');

    // Convert base64 data URL to blob bytes
    const base64 = base64Data.replace(/^data:[^;]+;base64,/, '');
    const bytes   = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const size    = bytes.length;

    // Step 1: initiate upload
    const initRes = await fetch(`${canvasUrl}/api/v1/users/self/files`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: filename, size, content_type: contentType, parent_folder_path: '/Canvas Messenger' }),
    });
    if (!initRes.ok) throw new Error(`Upload init failed: ${initRes.status}`);
    const { upload_url, upload_params } = await initRes.json();

    // Step 2: multipart POST to upload_url
    const form = new FormData();
    for (const [k, v] of Object.entries(upload_params || {})) form.append(k, v);
    form.append('file', new Blob([bytes], { type: contentType }), filename);

    const uploadRes = await fetch(upload_url, { method: 'POST', body: form });
    if (!uploadRes.ok && uploadRes.status !== 301) throw new Error(`Upload failed: ${uploadRes.status}`);

    // Canvas may redirect to the file confirmation endpoint
    const fileData = await uploadRes.json();
    return fileData.id || fileData.file_id || fileData['id'];
}

async function sendReplyWithAttachment(convId, body, attachmentIds) {
    return canvasFetch(`/conversations/${convId}/add_message`, {
        method: 'POST',
        body: JSON.stringify({ body: body || ' ', attachment_ids: attachmentIds }),
    });
}

// ── Video call ────────────────────────────────────────────────────────────────

async function openCallWindow(peerId, peerName, isInitiator) {
    const url = chrome.runtime.getURL(`call.html?peerId=${encodeURIComponent(peerId)}&peerName=${encodeURIComponent(peerName)}&initiator=${isInitiator}`);
    await chrome.windows.create({ url, type: 'popup', width: 720, height: 500 });
}

async function signalingRequest(msg) {
    if (!sigWs || sigWs.readyState !== WebSocket.OPEN) {
        connectSignaling();
        // Wait up to 2s for connection
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 2000);
            const check = setInterval(() => {
                if (sigWs?.readyState === WebSocket.OPEN) { clearInterval(check); clearTimeout(t); resolve(); }
            }, 100);
        });
    }
    if (sigWs?.readyState === WebSocket.OPEN) sigWs.send(JSON.stringify(msg));
}

// ── Cross-campus relay ────────────────────────────────────────────────────────

const RELAY_API = 'https://relay.hackatoa.com/api';
const RELAY_WS  = 'wss://relay.hackatoa.com/ws';
let relayWs = null;

async function getRelayProfile() {
    return new Promise(r => chrome.storage.local.get('relayProfile', d => r(d.relayProfile || null)));
}

function connectRelay() {
    getRelayProfile().then(profile => {
        if (!profile) return;
        if (relayWs && (relayWs.readyState === WebSocket.OPEN || relayWs.readyState === WebSocket.CONNECTING)) return;
        relayWs = new WebSocket(RELAY_WS);
        relayWs.onopen = () => relayWs.send(JSON.stringify({ type: 'auth', token: profile.authToken }));
        relayWs.onmessage = async (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'message') {
                    await storeRelayMessage(msg.message);
                    const tabs = await chrome.tabs.query({ url: ['https://*/*', 'http://*/*'] });
                    for (const tab of tabs) {
                        chrome.tabs.sendMessage(tab.id, { action: 'relay-message', payload: msg.message }).catch(() => {});
                    }
                }
            } catch {}
        };
        relayWs.onclose = () => { relayWs = null; };
        relayWs.onerror = () => {};
    }).catch(() => {});
}

async function relayDecrypt(encB64, ivB64, privateJwk, peerPublicJwk) {
    const priv = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
    const pub  = await crypto.subtle.importKey('jwk', peerPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const key  = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const dec  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(atob(ivB64), c => c.charCodeAt(0)) }, key,
        Uint8Array.from(atob(encB64), c => c.charCodeAt(0)));
    return new TextDecoder().decode(dec);
}

async function relayEncrypt(plaintext, privateJwk, peerPublicJwk) {
    const priv = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
    const pub  = await crypto.subtle.importKey('jwk', peerPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const key  = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const enc  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    const b64  = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
    return { encryptedBody: b64(enc), iv: b64(iv) };
}

async function getRelayContacts() {
    return new Promise(r => chrome.storage.local.get('relayContacts', d => r(d.relayContacts || [])));
}

async function storeRelayMessage(msg) {
    const profile = await getRelayProfile();
    if (!profile) return;
    const contacts = await getRelayContacts();
    const senderId = msg.senderId;
    const sender = contacts.find(c => c.id === senderId);
    let body = '[Encrypted — add this contact to decrypt]';
    if (sender) {
        try { body = await relayDecrypt(msg.encryptedBody, msg.iv, profile.privateKeyJwk, sender.publicKeyJwk); } catch {}
    }
    const key = `relayMsg_${msg.threadId}`;
    const stored = await new Promise(r => chrome.storage.local.get(key, d => r(d[key] || [])));
    if (!stored.find(m => m.id === msg.id)) {
        stored.push({ id: msg.id, threadId: msg.threadId, senderId, body, sentAt: msg.sentAt, fromMe: false });
        if (stored.length > 1000) stored.splice(0, stored.length - 1000);
        await new Promise(r => chrome.storage.local.set({ [key]: stored }, r));
    }
    await updateRelayThread(msg.threadId, senderId, body, msg.sentAt, true);
}

async function updateRelayThread(threadId, otherUserId, lastBody, lastAt, incUnread) {
    const threads = await new Promise(r => chrome.storage.local.get('relayThreads', d => r(d.relayThreads || [])));
    const idx = threads.findIndex(t => t.id === threadId);
    if (idx >= 0) {
        threads[idx].lastMessage = lastBody;
        threads[idx].lastAt = lastAt;
        if (incUnread) threads[idx].unreadCount = (threads[idx].unreadCount || 0) + 1;
    } else {
        const contacts = await getRelayContacts();
        const c = contacts.find(x => x.id === otherUserId);
        threads.push({ id: threadId, contactId: otherUserId, contactName: c?.name || 'Unknown',
            lastMessage: lastBody, lastAt, unreadCount: incUnread ? 1 : 0 });
    }
    await new Promise(r => chrome.storage.local.set({ relayThreads: threads }, r));
}

async function relayRegister({ name, email }) {
    const { canvasUrl, currentUser } = await getSettings();
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    const publicKeyJwk  = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);

    const res = await fetch(`${RELAY_API}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email: email || null, publicKey: JSON.stringify(publicKeyJwk),
            canvasUserId: currentUser?.id ? String(currentUser.id) : null, canvasUrl: canvasUrl || null }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
    const { id, authToken } = await res.json();
    const profile = { id, authToken, name, email: email || null, publicKeyJwk, privateKeyJwk, registeredAt: new Date().toISOString() };
    await new Promise(r => chrome.storage.local.set({ relayProfile: profile }, r));
    connectRelay();
    return { ok: true, id };
}

async function relaySendMessage({ recipientId, body }) {
    const profile = await getRelayProfile();
    if (!profile) throw new Error('Not registered on relay');
    const contacts = await getRelayContacts();
    const contact = contacts.find(c => c.id === recipientId);
    if (!contact) throw new Error('Contact not found — add them first');
    const { encryptedBody, iv } = await relayEncrypt(body, profile.privateKeyJwk, contact.publicKeyJwk);
    const res = await fetch(`${RELAY_API}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${profile.authToken}` },
        body: JSON.stringify({ recipientId, encryptedBody, iv }),
    });
    if (!res.ok) throw new Error(`Send failed: ${res.status}`);
    const { id, threadId, sentAt } = await res.json();
    const key = `relayMsg_${threadId}`;
    const stored = await new Promise(r => chrome.storage.local.get(key, d => r(d[key] || [])));
    stored.push({ id, threadId, senderId: profile.id, body, sentAt, fromMe: true });
    await new Promise(r => chrome.storage.local.set({ [key]: stored }, r));
    await updateRelayThread(threadId, recipientId, body, sentAt, false);
    return { ok: true, id, threadId };
}

async function relayAddContact(contact) {
    const contacts = await getRelayContacts();
    if (!contacts.find(c => c.id === contact.id)) {
        const pubJwk = typeof contact.publicKey === 'string' ? JSON.parse(contact.publicKey) : contact.publicKey;
        contacts.push({ id: contact.id, name: contact.name, email: contact.email || null, publicKeyJwk: pubJwk });
        await new Promise(r => chrome.storage.local.set({ relayContacts: contacts }, r));
    }
    return { ok: true };
}

async function syncRelayMessages() {
    const profile = await getRelayProfile();
    if (!profile) return;
    const threads = await new Promise(r => chrome.storage.local.get('relayThreads', d => r(d.relayThreads || [])));
    const since = threads.reduce((m, t) => t.lastAt > m ? t.lastAt : m, '1970-01-01T00:00:00.000Z');
    try {
        const res = await fetch(`${RELAY_API}/messages?since=${encodeURIComponent(since)}`,
            { headers: { 'Authorization': `Bearer ${profile.authToken}` } });
        if (!res.ok) return;
        const msgs = await res.json();
        const contacts = await getRelayContacts();
        for (const msg of msgs) {
            const key = `relayMsg_${msg.threadId}`;
            const stored = await new Promise(r => chrome.storage.local.get(key, d => r(d[key] || [])));
            if (stored.find(m => m.id === msg.id)) continue;
            const fromMe = msg.senderId === profile.id;
            const otherId = fromMe ? msg.recipientId : msg.senderId;
            const contact = contacts.find(c => c.id === otherId);
            let body = '[Encrypted — add this contact to decrypt]';
            if (contact) {
                try { body = await relayDecrypt(msg.encryptedBody, msg.iv, profile.privateKeyJwk, contact.publicKeyJwk); } catch {}
            }
            stored.push({ id: msg.id, threadId: msg.threadId, senderId: msg.senderId, body, sentAt: msg.sentAt, fromMe });
            await new Promise(r => chrome.storage.local.set({ [key]: stored }, r));
            await updateRelayThread(msg.threadId, otherId, body, msg.sentAt, !fromMe);
        }
    } catch {}
}

// ── Badge / polling ───────────────────────────────────────────────────────────

async function updateBadge() {
    try {
        const conversations = await getConversations('unread');
        const count = Array.isArray(conversations) ? conversations.length : 0;
        chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
        chrome.action.setBadgeBackgroundColor({ color: '#5865F2' });
    } catch {
        // not configured or network error
    }
}

chrome.alarms.create('poll', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'poll') { updateBadge(); connectSignaling(); connectRelay(); }
});

// ── Message routing ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handleMessage(msg, sender).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async
});

async function handleMessage(msg, sender = {}) {
    switch (msg.action) {
        case 'getConversations':   return getConversations(msg.scope);
        case 'getConversation':    return getConversation(msg.id);
        case 'sendReply':          return sendReply(msg.id, msg.body);
        case 'newConversation':    return newConversation(msg.recipients, msg.subject, msg.body);
        case 'searchRecipients':   return searchRecipients(msg.search, msg.context);
        case 'getCourses':         return getCourses();
        case 'getGroups':          return getGroups();
        case 'getGroupUsers':      return getGroupUsers(msg.groupId);
        case 'getCourseUsers':        return getCourseUsers(msg.courseId, msg.role);
        case 'getDiscussions':        return getDiscussions(msg.courseId);
        case 'getDiscussionEntries':  return getDiscussionEntries(msg.courseId, msg.topicId);
        case 'createDiscussionEntry': return createDiscussionEntry(msg.courseId, msg.topicId, msg.message);
        case 'findOrCreateClassChat': return findOrCreateClassChat(msg.courseId);
        case 'markRead':           return markRead(msg.id);
        case 'getSettings':        return getSettings();
        case 'getCurrentUser':     return getCurrentUser();
        case 'updateBadge':        return updateBadge();
        case 'openSettings':       chrome.runtime.openOptionsPage(); return { ok: true };
        case 'initCall':           await signalingRequest({ type: 'call-request', to: msg.peerId, fromName: msg.fromName }); return openCallWindow(msg.peerId, msg.peerName, true);
        case 'acceptCall':         await openCallWindow(msg.peerId, msg.peerName, false); return { ok: true };
        case 'declineCall':        await signalingRequest({ type: 'call-declined', to: msg.peerId }); return { ok: true };
        case 'captureTab':         return new Promise(resolve => chrome.tabs.captureVisibleTab(null, { format: 'png' }, dataUrl => resolve({ dataUrl: dataUrl || null })));
        case 'uploadFile':         return { fileId: await uploadCanvasFile(msg.dataUrl, msg.filename) };
        case 'sendReplyWithAttachment': return sendReplyWithAttachment(msg.convId, msg.body, msg.attachmentIds);
        case 'relayRegister':    return relayRegister(msg);
        case 'relayGetProfile':  return getRelayProfile();
        case 'relayGetThreads':  return new Promise(r => chrome.storage.local.get('relayThreads', d => r(d.relayThreads || [])));
        case 'relayGetMessages': return new Promise(r => chrome.storage.local.get(`relayMsg_${msg.threadId}`, d => r(d[`relayMsg_${msg.threadId}`] || [])));
        case 'relaySendMessage': return relaySendMessage(msg);
        case 'relaySearchUsers': {
            const p = await getRelayProfile();
            if (!p) throw new Error('Not registered');
            const rs = await fetch(`${RELAY_API}/users/search?q=${encodeURIComponent(msg.query)}`, { headers: { 'Authorization': `Bearer ${p.authToken}` } });
            return rs.json();
        }
        case 'relayGetUser': {
            const p = await getRelayProfile();
            if (!p) throw new Error('Not registered');
            const ru = await fetch(`${RELAY_API}/users/${msg.userId}`, { headers: { 'Authorization': `Bearer ${p.authToken}` } });
            return ru.json();
        }
        case 'relayGetContacts':  return getRelayContacts();
        case 'relayAddContact':   return relayAddContact(msg.contact);
        case 'relayMarkRead': {
            const th = await new Promise(r => chrome.storage.local.get('relayThreads', d => r(d.relayThreads || [])));
            const ti = th.findIndex(t => t.id === msg.threadId);
            if (ti >= 0) { th[ti].unreadCount = 0; await new Promise(r => chrome.storage.local.set({ relayThreads: th }, r)); }
            return { ok: true };
        }
        case 'relayCreateInvite': {
            const p = await getRelayProfile();
            if (!p) throw new Error('Not registered');
            const ri = await fetch(`${RELAY_API}/invites`, { method: 'POST', headers: { 'Authorization': `Bearer ${p.authToken}` } });
            const { token } = await ri.json();
            return { token, url: `https://relay.hackatoa.com/invite/${token}` };
        }
        case 'relayResolveInvite': {
            const rr = await fetch(`${RELAY_API}/invites/${msg.token}`);
            if (!rr.ok) throw new Error('Invalid invite');
            return rr.json();
        }
        case 'setPageValue': {
            // Runs in the page's MAIN world — bypasses Canvas CSP.
            // Uses _valueTracker trick to make React 16-18 detect the change,
            // plus InputEvent(insertText) for React 17/18's beforeinput pathway.
            const [res] = await chrome.scripting.executeScript({
                target: { tabId: sender.tab.id },
                world: 'MAIN',
                func: (selector, value) => {
                    const el = document.querySelector(selector);
                    if (!el) return { ok: false, reason: 'not found' };
                    if (el.tagName === 'SELECT') {
                        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
                        if (setter) setter.call(el, value); else el.value = value;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('input',  { bubbles: true }));
                        return { ok: true, valueAfter: el.value };
                    }
                    el.focus();
                    // Mark old value as "seen" so React's change detection fires
                    const tracker = el._valueTracker;
                    if (tracker) tracker.setValue(el.value);
                    // Set new value via native setter (bypasses React's override)
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        HTMLInputElement.prototype, 'value')?.set;
                    if (nativeSetter) nativeSetter.call(el, value); else el.value = value;
                    // Fire both event types: InputEvent(insertText) for React 17/18,
                    // plain input for React 16, plus change for good measure
                    el.dispatchEvent(new InputEvent('input', {
                        inputType: 'insertText', data: value,
                        bubbles: true, composed: true, cancelable: false,
                    }));
                    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                    return { ok: true, valueAfter: el.value };
                },
                args: [msg.selector, msg.value],
            });
            return res?.result ?? { ok: false };
        }
        case 'blurElement': {
            const [res] = await chrome.scripting.executeScript({
                target: { tabId: sender.tab.id },
                world: 'MAIN',
                func: (selector) => {
                    const el = document.querySelector(selector);
                    if (!el) return false;
                    el.blur();
                    return true;
                },
                args: [msg.selector],
            });
            return { ok: res?.result ?? false };
        }
        default: throw new Error('UNKNOWN_ACTION');
    }
}

// ── Extension icon click → toggle sidebar ─────────────────────────────────────

chrome.action.onClicked.addListener(tab => {
    chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' }, () => {
        // If content script didn't respond (non-Canvas page), open options instead
        if (chrome.runtime.lastError) {
            chrome.runtime.openOptionsPage();
        }
    });
});

// initial badge on load
updateBadge();
connectSignaling();
connectRelay();
syncRelayMessages();

