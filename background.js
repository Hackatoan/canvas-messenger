// ── Signaling WebSocket (kept alive via alarms) ───────────────────────────────

const SIGNALING_URL = 'wss://signaling.hackatoa.com';
let sigWs = null;
let sigReconnectTimer = null;
let sigReconnectDelay = 2000;
const RECONNECT_MAX_DELAY = 30000;

// Broadcast a message to every live Canvas content-script tab.
async function broadcastToTabs(action, payload) {
    const tabs = await chrome.tabs.query({ url: ['https://*/*', 'http://*/*'] });
    for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { action, payload }).catch(() => {});
    }
}

function connectSignaling() {
    if (sigWs && (sigWs.readyState === WebSocket.OPEN || sigWs.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(sigReconnectTimer);
    try {
        sigWs = new WebSocket(SIGNALING_URL);

        sigWs.onopen = async () => {
            sigReconnectDelay = 2000;
            const { currentUser } = await getSettings();
            // A relay token proves we actually own this Canvas identity — see
            // cm-signaling's registration-ownership check. Without one (messaging
            // never set up yet) there's nothing to verify against, so don't
            // register; connectSignaling() runs again once relayRegister()
            // succeeds, at which point this picks up the new token.
            const profile = await getRelayProfile();
            if (currentUser?.id && profile?.authToken) {
                sigWs.send(JSON.stringify({ type: 'register', userId: String(currentUser.id), name: currentUser.name || '', token: profile.authToken }));
            }
        };

        sigWs.onmessage = async (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            if (msg.type === 'incoming-call' || msg.type === 'call-failed') {
                broadcastToTabs('cm-call-event', msg);
            }
        };

        sigWs.onerror = () => {};
        sigWs.onclose = () => {
            sigWs = null;
            // Reconnect promptly with backoff instead of waiting for the
            // next minute-interval poll alarm — otherwise a brief network
            // blip can leave the extension unreachable for incoming calls.
            sigReconnectTimer = setTimeout(connectSignaling, sigReconnectDelay);
            sigReconnectDelay = Math.min(sigReconnectDelay * 2, RECONNECT_MAX_DELAY);
        };
    } catch {}
}

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
    // call.html is a web_accessible_resource reachable from any site, so a bare
    // peerId/peerName URL could be forged by an untrusted page to place a call
    // as the logged-in user. Gate it behind a one-time token that only this
    // extension can mint/read (chrome.storage.session isn't visible to pages).
    const token = crypto.randomUUID();
    await chrome.storage.session.set({ [`callToken_${token}`]: true });
    const url = chrome.runtime.getURL(`call.html?peerId=${encodeURIComponent(peerId)}&peerName=${encodeURIComponent(peerName)}&initiator=${isInitiator}&token=${token}`);
    await chrome.windows.create({ url, type: 'popup', width: 720, height: 500 });
}

async function signalingRequest(msg) {
    if (!sigWs || sigWs.readyState !== WebSocket.OPEN) {
        connectSignaling();
        // Wait up to 2s for connection
        await new Promise((resolve) => {
            const check = setInterval(() => {
                if (sigWs?.readyState === WebSocket.OPEN) { clearInterval(check); clearTimeout(t); resolve(); }
            }, 100);
            const t = setTimeout(() => { clearInterval(check); resolve(); }, 2000);
        });
    }
    if (sigWs?.readyState === WebSocket.OPEN) sigWs.send(JSON.stringify(msg));
}

// ── Cross-campus relay ────────────────────────────────────────────────────────

const RELAY_API = 'https://relay.hackatoa.com/api';
const RELAY_WS  = 'wss://relay.hackatoa.com/ws';
let relayWs = null;
let relayReconnectTimer = null;
let relayReconnectDelay = 2000;

async function getRelayProfile() {
    return new Promise(r => chrome.storage.local.get('relayProfile', d => r(d.relayProfile || null)));
}

function connectRelay() {
    getRelayProfile().then(profile => {
        if (!profile) return;
        if (relayWs && (relayWs.readyState === WebSocket.OPEN || relayWs.readyState === WebSocket.CONNECTING)) return;
        clearTimeout(relayReconnectTimer);
        relayWs = new WebSocket(RELAY_WS);
        relayWs.onopen = () => {
            relayReconnectDelay = 2000;
            relayWs.send(JSON.stringify({ type: 'auth', token: profile.authToken }));
        };
        relayWs.onmessage = async (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'message') {
                    await storeRelayMessage(msg.message);
                    broadcastToTabs('relay-message', msg.message);
                } else if (msg.type === 'typing') {
                    broadcastToTabs('relay-typing', { from: msg.from });
                } else if (msg.type === 'read') {
                    await markRelayThreadRead(msg.threadId, msg.readAt);
                    broadcastToTabs('relay-read', { threadId: msg.threadId, readAt: msg.readAt });
                }
            } catch {}
        };
        relayWs.onclose = () => {
            relayWs = null;
            // Same rationale as signaling: reconnect quickly with backoff so
            // messages/typing/read-receipts keep flowing after a blip.
            relayReconnectTimer = setTimeout(connectRelay, relayReconnectDelay);
            relayReconnectDelay = Math.min(relayReconnectDelay * 2, RECONNECT_MAX_DELAY);
        };
        relayWs.onerror = () => {};
    }).catch(() => {});
}

// Flag locally-stored outgoing messages in a thread as read once the peer
// has read them, so the sender's UI can show a "read" receipt.
async function markRelayThreadRead(threadId, readAt) {
    if (!threadId || !readAt) return;
    const key = `relayMsg_${threadId}`;
    const stored = await new Promise(r => chrome.storage.local.get(key, d => r(d[key] || [])));
    let changed = false;
    for (const m of stored) {
        if (m.fromMe && !m.read && m.sentAt <= readAt) { m.read = true; changed = true; }
    }
    if (changed) await new Promise(r => chrome.storage.local.set({ [key]: stored }, r));
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
    const { canvasUrl, currentUser, apiToken } = await getSettings();
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    const publicKeyJwk  = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);

    // canvasToken proves to the relay that we actually hold a live Canvas
    // session for this canvasUserId — required to reuse/reclaim an existing
    // relay account (see cm-relay's /api/register: without this, anyone who
    // knew a target's canvasUserId+canvasUrl, neither of which is secret,
    // could steal their authToken and hijack their E2E publicKey). Brand new
    // accounts don't need it since there's nothing to prove ownership of yet.
    // privateKey is sent so the relay can escrow it (in Firestore) the first
    // time it sees this account — that's what lets a *future* device recover
    // this exact keypair instead of minting its own and silently breaking
    // everyone's E2E decryption. See cm-relay's /api/register.
    const res = await fetch(`${RELAY_API}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email: email || null, publicKey: JSON.stringify(publicKeyJwk),
            privateKey: JSON.stringify(privateKeyJwk),
            canvasUserId: currentUser?.id ? String(currentUser.id) : null, canvasUrl: canvasUrl || null,
            canvasToken: apiToken || null }),
    });
    if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
    const { id, authToken, keypair, contacts } = await res.json();
    // keypair present = this account already had an escrowed key on another
    // device — use *that* one instead of the one we just generated locally,
    // so old messages (encrypted for the escrowed public key) stay readable.
    const { publicKeyJwk: pub, privateKeyJwk: priv } = keypair || { publicKeyJwk, privateKeyJwk };
    const profile = { id, authToken, name, email: email || null, publicKeyJwk: pub, privateKeyJwk: priv, registeredAt: new Date().toISOString() };
    // Escrowed either just now (fresh account) or already present (reclaim
    // found one) — either way this device is covered, skip ensureKeyEscrow().
    await new Promise(r => chrome.storage.local.set({ relayProfile: profile, relayKeyEscrowed: true }, r));
    if (Array.isArray(contacts) && contacts.length) {
        // Merge rather than overwrite: a reinstall on the *same* device may
        // already have local contacts the synced snapshot doesn't (yet).
        const local = await getRelayContacts();
        const merged = [...local];
        for (const c of contacts) if (!merged.find(m => m.id === c.id)) merged.push(c);
        await new Promise(r => chrome.storage.local.set({ relayContacts: merged }, r));
    }
    connectRelay();
    // Now that a relay token exists, (re-)register for calls too — signaling
    // registration is a no-op without one, so a socket opened before setup
    // finished never got registered.
    if (sigWs && sigWs.readyState === WebSocket.OPEN) sigWs.onopen();
    else connectSignaling();
    // A fresh device has no local threads, so syncRelayMessages()'s epoch
    // default backfills full history right away instead of waiting for the
    // next poll alarm (up to 60s) — worth it once, register() is rare.
    syncRelayMessages();
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
    stored.push({ id, threadId, senderId: profile.id, body, sentAt, fromMe: true, read: false });
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
        // Best-effort: so a future device restores this contact too (and can
        // therefore decrypt its backfilled messages) instead of starting empty.
        const profile = await getRelayProfile();
        if (profile) {
            fetch(`${RELAY_API}/sync-contacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${profile.authToken}` },
                body: JSON.stringify({ contacts }),
            }).catch(() => {});
        }
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
        if (!msgs.length) return;
        const contacts = await getRelayContacts();

        // Catch-up syncs after being offline can carry many messages across
        // many threads. The old code did a chrome.storage.local get+set per
        // message (plus another get+set inside updateRelayThread) — each a
        // serialized round trip to the storage backend. Batch every affected
        // relayMsg_* key into one read and one write instead, and fold the
        // relayThreads update into the same in-memory pass.
        const threadIds = [...new Set(msgs.map(m => m.threadId))];
        const stores = await new Promise(r => chrome.storage.local.get(threadIds.map(id => `relayMsg_${id}`), r));
        const threadMap = new Map(threads.map(t => [t.id, t]));
        const toWrite = {};

        for (const msg of msgs) {
            const key = `relayMsg_${msg.threadId}`;
            const stored = stores[key] || (stores[key] = []);
            if (stored.find(m => m.id === msg.id)) continue;
            const fromMe = msg.senderId === profile.id;
            const otherId = fromMe ? msg.recipientId : msg.senderId;
            const contact = contacts.find(c => c.id === otherId);
            let body = '[Encrypted — add this contact to decrypt]';
            if (contact) {
                try { body = await relayDecrypt(msg.encryptedBody, msg.iv, profile.privateKeyJwk, contact.publicKeyJwk); } catch {}
            }
            stored.push({ id: msg.id, threadId: msg.threadId, senderId: msg.senderId, body, sentAt: msg.sentAt, fromMe, read: !!msg.readAt });
            toWrite[key] = stored;

            // Mirrors updateRelayThread()'s merge logic, applied in-memory.
            const t = threadMap.get(msg.threadId);
            if (t) {
                t.lastMessage = body;
                t.lastAt = msg.sentAt;
                if (!fromMe) t.unreadCount = (t.unreadCount || 0) + 1;
            } else {
                threadMap.set(msg.threadId, {
                    id: msg.threadId, contactId: otherId, contactName: contact?.name || 'Unknown',
                    lastMessage: body, lastAt: msg.sentAt, unreadCount: fromMe ? 0 : 1,
                });
            }
        }

        if (Object.keys(toWrite).length) {
            toWrite.relayThreads = [...threadMap.values()];
            await new Promise(r => chrome.storage.local.set(toWrite, r));
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
        case 'accountStatus':        return accountStatus();
        case 'accountSignUp':        return accountSignUp(msg);
        case 'accountSignIn':        return accountSignIn(msg);
        case 'accountSignOut':       return accountSignOut();
        case 'accountUnlink':        return accountUnlink();
        case 'accountResetPassword': return accountResetPassword(msg);
        case 'accountSyncToken':     return accountSyncToken();
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
            const p = await getRelayProfile();
            if (p) {
                // Best-effort: tell the server so the sender gets a read receipt.
                fetch(`${RELAY_API}/messages/read`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${p.authToken}` },
                    body: JSON.stringify({ threadId: msg.threadId }),
                }).catch(() => {});
            }
            return { ok: true };
        }
        case 'relayTyping': {
            if (relayWs?.readyState === WebSocket.OPEN) {
                relayWs.send(JSON.stringify({ type: 'typing', to: msg.to }));
            }
            return { ok: true };
        }
        case 'relayGetPresence': {
            const p = await getRelayProfile();
            if (!p) throw new Error('Not registered');
            const ids = (msg.ids || []).join(',');
            const rp = await fetch(`${RELAY_API}/presence?ids=${encodeURIComponent(ids)}`, { headers: { 'Authorization': `Bearer ${p.authToken}` } });
            return rp.json();
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

// One-time migration for devices already registered before key escrow
// existed: silently re-runs registration once so this device's *existing*
// keypair gets escrowed (not replaced — the relay only escrows when nothing
// is stored yet). Without this, only a *second* device installed after this
// feature shipped would end up as the escrowed copy, and it would win by
// generating a fresh key — the exact key-rotation bug this feature fixes.
async function ensureKeyEscrow() {
    const { relayProfile, relayKeyEscrowed } = await new Promise(r =>
        chrome.storage.local.get(['relayProfile', 'relayKeyEscrowed'], r));
    if (!relayProfile || relayKeyEscrowed) return;
    try {
        await relayRegister({ name: relayProfile.name, email: relayProfile.email });
        await new Promise(r => chrome.storage.local.set({ relayKeyEscrowed: true }, r));
    } catch { /* Canvas session/token unavailable right now — retry next startup */ }
}

// ── Accounts (Firebase Auth) ──────────────────────────────────────────────────
// Sign in with email + password so a new device can restore the Canvas token,
// relay login and E2E keys instead of redoing the Canvas token flow. The
// extension talks to Firebase Auth's REST API directly (no SDK to bundle); the
// relay verifies the resulting ID token and does all the storing. See
// cm-relay's account.js.

// Public identifier for the Firebase project (Project settings → General →
// Web API key). Not a secret. Empty = accounts disabled in this build.
const FIREBASE_API_KEY = '';
const FB_IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts';
const FB_SECURETOKEN = 'https://securetoken.googleapis.com/v1/token';

const FB_ERRORS = {
    EMAIL_EXISTS: 'An account with that email already exists — sign in instead.',
    INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
    INVALID_PASSWORD: 'Wrong email or password.',
    EMAIL_NOT_FOUND: 'Wrong email or password.',
    INVALID_EMAIL: 'That email address doesn\'t look right.',
    WEAK_PASSWORD: 'Password must be at least 6 characters.',
    MISSING_PASSWORD: 'Enter a password.',
    USER_DISABLED: 'This account has been disabled.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts — try again in a few minutes.',
    OPERATION_NOT_ALLOWED: 'Email/password sign-in isn\'t enabled for this project yet.',
};

let fbIdTokenCache = null; // { token, exp } — in-memory only, refetched after worker restarts

const storageGet = keys => new Promise(r => chrome.storage.local.get(keys, r));
const storageSet = obj => new Promise(r => chrome.storage.local.set(obj, r));
const storageRemove = keys => new Promise(r => chrome.storage.local.remove(keys, r));

function requireFirebase() {
    if (!FIREBASE_API_KEY) throw new Error('Accounts aren\'t enabled in this build yet.');
}

async function fbIdentity(endpoint, body) {
    requireFirebase();
    const res = await fetch(`${FB_IDENTITY}:${endpoint}?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const code = String(data?.error?.message || '').split(' ')[0];
        throw new Error(FB_ERRORS[code] || `Account request failed (${code || res.status}).`);
    }
    return data;
}

async function fbSaveSession(data, extra = {}) {
    const prev = (await storageGet('fbSession')).fbSession || {};
    const session = { ...prev, email: data.email || prev.email, uid: data.localId || prev.uid, refreshToken: data.refreshToken, ...extra };
    await storageSet({ fbSession: session });
    fbIdTokenCache = data.idToken
        ? { token: data.idToken, exp: Date.now() + (Number(data.expiresIn) || 3600) * 1000 - 60_000 }
        : null;
    return session;
}

async function fbGetIdToken() {
    if (fbIdTokenCache && Date.now() < fbIdTokenCache.exp) return fbIdTokenCache.token;
    requireFirebase();
    const { fbSession } = await storageGet('fbSession');
    if (!fbSession?.refreshToken) throw new Error('Not signed in.');
    const res = await fetch(`${FB_SECURETOKEN}?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(fbSession.refreshToken)}`,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        await storageRemove('fbSession'); // refresh token revoked/expired: force a fresh sign-in
        fbIdTokenCache = null;
        throw new Error('Your sign-in expired — please sign in again.');
    }
    await storageSet({ fbSession: { ...fbSession, refreshToken: data.refresh_token || fbSession.refreshToken } });
    fbIdTokenCache = { token: data.id_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 };
    return fbIdTokenCache.token;
}

async function relayAccountCall(path, { bearer, body } = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Firebase-Token': await fbGetIdToken() };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetch(`${RELAY_API}/account/${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json };
}

// Push this device's Canvas token (and, if needed, its relay registration) to
// the signed-in account. Idempotent — also used to refresh a rotated token.
async function accountLink() {
    const { canvasUrl, apiToken, currentUser, fbSession } = await storageGet(['canvasUrl', 'apiToken', 'currentUser', 'fbSession']);
    if (!fbSession) throw new Error('Not signed in.');
    if (!canvasUrl || !apiToken || !currentUser?.id) throw new Error('Connect to Canvas first, then your account can back it up.');
    let profile = await getRelayProfile();
    if (!profile) {
        await relayRegister({ name: currentUser.name || currentUser.login_id || 'Canvas user', email: fbSession.email });
        profile = await getRelayProfile();
    }
    const r = await relayAccountCall('link', {
        bearer: profile.authToken,
        body: { canvasUrl, canvasUserId: String(currentUser.id), canvasToken: apiToken },
    });
    if (!r.ok) throw new Error(r.json?.error || `Couldn\'t back up to your account (${r.status}).`);
    await storageSet({ fbSession: { ...fbSession, linked: true } });
    return { ok: true, linked: true };
}

// Apply what the relay returned for a sign-in on a (possibly brand-new) device.
async function accountRestore(d) {
    if (!d.canvas?.token || !d.canvas?.url) throw new Error('Your account has no saved Canvas connection yet. Connect on your other device first.');
    if (!d.keypair?.publicKeyJwk || !d.keypair?.privateKeyJwk) throw new Error('Your account has no saved encryption keys. Open the extension on your original device once, then try again.');

    let currentUser = { id: d.canvas.userId, name: d.name };
    try {
        const cu = await fetch(`${d.canvas.url.replace(/\/$/, '')}/api/v1/users/self`, { headers: { Authorization: `Bearer ${d.canvas.token}` } });
        if (cu.ok) currentUser = await cu.json();
    } catch { /* offline or token revoked — fall back to the id/name we have */ }

    const profile = {
        id: d.id, authToken: d.authToken, name: d.name, email: d.email || null,
        publicKeyJwk: d.keypair.publicKeyJwk, privateKeyJwk: d.keypair.privateKeyJwk,
        registeredAt: new Date().toISOString(),
    };
    await storageSet({ canvasUrl: d.canvas.url, apiToken: d.canvas.token, currentUser, relayProfile: profile, relayKeyEscrowed: true });
    if (Array.isArray(d.contacts) && d.contacts.length) {
        const local = await getRelayContacts();
        const merged = [...local];
        for (const c of d.contacts) if (!merged.find(m => m.id === c.id)) merged.push(c);
        await storageSet({ relayContacts: merged });
    }
    connectRelay();
    if (sigWs && sigWs.readyState === WebSocket.OPEN) sigWs.onopen(); else connectSignaling();
    syncRelayMessages();
    updateBadge();
    return currentUser;
}

async function accountSignUp({ email, password }) {
    const data = await fbIdentity('signUp', { email: String(email || '').trim(), password, returnSecureToken: true });
    await fbSaveSession(data);
    try {
        await accountLink();
        return { ok: true, linked: true };
    } catch (e) {
        // Account exists now; backing up needs a Canvas connection first.
        return { ok: true, linked: false, notice: e.message };
    }
}

async function accountSignIn({ email, password }) {
    const data = await fbIdentity('signInWithPassword', { email: String(email || '').trim(), password, returnSecureToken: true });
    await fbSaveSession(data);
    const r = await relayAccountCall('login');
    if (r.status === 404) {
        // Valid sign-in with nothing backed up yet: back up this device if it has a Canvas connection.
        try { await accountLink(); return { ok: true, linked: true, restored: false }; }
        catch (e) { return { ok: true, linked: false, restored: false, notice: e.message }; }
    }
    if (!r.ok) throw new Error(r.json?.error || `Sign-in failed (${r.status}).`);
    const user = await accountRestore(r.json);
    const { fbSession } = await storageGet('fbSession');
    await storageSet({ fbSession: { ...fbSession, linked: true } });
    return { ok: true, linked: true, restored: true, user };
}

async function accountSignOut() {
    fbIdTokenCache = null;
    await storageRemove('fbSession'); // local Canvas/relay data stays; the cloud copy is untouched
    return { ok: true };
}

async function accountUnlink() {
    const r = await relayAccountCall('unlink');
    if (!r.ok) throw new Error(r.json?.error || `Couldn\'t remove the cloud copy (${r.status}).`);
    const { fbSession } = await storageGet('fbSession');
    if (fbSession) await storageSet({ fbSession: { ...fbSession, linked: false } });
    return { ok: true };
}

async function accountStatus() {
    const { fbSession } = await storageGet('fbSession');
    return { configured: !!FIREBASE_API_KEY, signedIn: !!fbSession, email: fbSession?.email || null, linked: !!fbSession?.linked };
}

async function accountResetPassword({ email }) {
    await fbIdentity('sendOobCode', { requestType: 'PASSWORD_RESET', email: String(email || '').trim() });
    return { ok: true };
}

// After the user saves a different Canvas token, refresh the cloud copy so a
// new device doesn't restore a dead one. Quiet no-op when not signed in.
async function accountSyncToken() {
    const { fbSession } = await storageGet('fbSession');
    if (!fbSession?.linked) return { ok: true, skipped: true };
    return accountLink();
}

// initial badge on load
updateBadge();
connectSignaling();
connectRelay();
syncRelayMessages();
ensureKeyEscrow();

