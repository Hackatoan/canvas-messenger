'use strict';
// Guards the request/storage-saving paths in background.js. Same harness idea
// as account.test.js: evaluate background.js with chrome.* and fetch stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function noop() {}
function deepStub() {
    const f = function () {};
    return new Proxy(f, { get: (t, k) => (k in t ? t[k] : (k === 'then' ? undefined : deepStub())), apply: () => undefined });
}

function load({ routes = [], tabs = [] } = {}) {
    const store = {};
    const calls = [];
    const storageOps = { get: 0, set: 0 };
    const badge = [];
    const tabQueries = [];
    const tabMessages = [];
    const chrome = deepStub();
    chrome.storage = { local: {
        get: (keys, cb) => {
            storageOps.get++;
            const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
            const out = {}; for (const k of ks) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
            cb(out);
        },
        set: (o, cb) => { storageOps.set++; for (const [k, v] of Object.entries(o)) store[k] = JSON.parse(JSON.stringify(v)); cb && cb(); },
        remove: (keys, cb) => { for (const k of [].concat(keys)) delete store[k]; cb && cb(); },
    } };
    chrome.runtime = { onMessage: { addListener: noop }, onInstalled: { addListener: noop }, onStartup: { addListener: noop }, sendMessage: noop, openOptionsPage: noop };
    chrome.tabs = {
        query: async (q) => { tabQueries.push(q); return tabs; },
        sendMessage: async (id, m) => { tabMessages.push({ id, m }); },
    };
    chrome.action = { setBadgeText: o => badge.push(o.text), setBadgeBackgroundColor: noop, onClicked: { addListener: noop } };
    class WS { constructor() { this.readyState = 0; } close() {} send() {} }
    WS.OPEN = 1; WS.CONNECTING = 0;
    const fetchFake = async (url, opts = {}) => {
        calls.push({ url: String(url), opts });
        for (const [match, handler] of routes) {
            if (String(url).includes(match)) {
                const r = await handler(String(url), opts);
                return { ok: r.status < 400, status: r.status, json: async () => r.body };
            }
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    const inert = () => 0;
    const api = new Function('chrome', 'WebSocket', 'fetch', 'crypto', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        src + '\nreturn { handleMessage, updateBadge, broadcastToTabs, storeRelayMessage, relayEncrypt, relayDecrypt };')
        (chrome, WS, fetchFake, globalThis.crypto, inert, inert, inert, inert);
    return { api, store, calls, storageOps, badge, tabQueries, tabMessages };
}

const unreadRoute = ['/conversations/unread_count', () => ({ status: 200, body: { unread_count: '2' } })];

test('updateBadge publishes the unread count for content scripts, writing only on change', async () => {
    const env = load({ routes: [unreadRoute] });
    env.store.canvasUrl = 'https://school.instructure.com'; env.store.apiToken = 'T';
    await new Promise(r => setImmediate(r)); // let the load-time updateBadge() settle
    env.calls.length = 0; env.badge.length = 0;

    await env.api.handleMessage({ action: 'updateBadge' });
    assert.equal(env.calls.filter(c => c.url.includes('/conversations/unread_count')).length, 1);
    assert.equal(env.calls.filter(c => c.url.includes('scope=unread')).length, 0, 'no full conversation list for the badge');
    assert.deepEqual(env.badge, ['2']);
    assert.equal(env.store.cmUnreadCount, 2);

    env.storageOps.set = 0;
    await env.api.updateBadge();
    assert.equal(env.storageOps.set, 0, 'unchanged count is not rewritten (no storage.onChanged churn)');
});

test('updateBadge clears the in-page count when the Canvas fetch fails', async () => {
    const env = load({ routes: [] }); // not configured -> NOT_CONFIGURED
    env.store.cmUnreadCount = 5;
    await env.api.updateBadge();
    assert.equal(env.store.cmUnreadCount, 0);
    assert.deepEqual(env.badge, [], 'toolbar badge left untouched on error');
});

test('broadcastToTabs only messages tabs on the saved Canvas host', async () => {
    const tabs = [
        { id: 1, url: 'https://school.instructure.com/courses/1' },
        { id: 2, url: 'https://news.example.com/' },
        { id: 3, url: 'http://school.instructure.com/' },
        { id: 4 }, // url not exposed — keep the old behavior and try it
    ];
    const env = load({ tabs });
    env.store.canvasUrl = 'https://school.instructure.com';
    await env.api.broadcastToTabs('relay-typing', { from: 'u2' });
    assert.deepEqual(env.tabMessages.map(t => t.id), [1, 3, 4]);
    assert.deepEqual(env.tabMessages[0].m, { action: 'relay-typing', payload: { from: 'u2' } });
});

test('broadcastToTabs falls back to every tab before a Canvas host is saved', async () => {
    const env = load({ tabs: [{ id: 1, url: 'https://a.example/' }, { id: 2, url: 'https://b.example/' }] });
    await env.api.broadcastToTabs('cm-call-event', { type: 'incoming-call' });
    assert.deepEqual(env.tabMessages.map(t => t.id), [1, 2]);
});

async function keypair() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    return { pub: await crypto.subtle.exportKey('jwk', kp.publicKey), priv: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}

test('live relay receive stores message + thread in one read-modify-write', async () => {
    const me = await keypair(), peer = await keypair();
    const env = load();
    env.store.relayProfile = { id: 'me', authToken: 'RT', privateKeyJwk: me.priv, publicKeyJwk: me.pub };
    env.store.relayContacts = [{ id: 'p1', name: 'Pat', publicKeyJwk: peer.pub }];
    const { encryptedBody, iv } = await env.api.relayEncrypt('hi there', peer.priv, me.pub);
    await new Promise(r => setImmediate(r)); // let load-time updateBadge() settle
    env.storageOps.get = 0; env.storageOps.set = 0;

    const msg = { id: 'm1', threadId: 't1', senderId: 'p1', encryptedBody, iv, sentAt: '2026-11-08T10:00:00.000Z' };
    await env.api.storeRelayMessage(msg);
    assert.deepEqual(env.storageOps, { get: 2, set: 1 });
    assert.deepEqual(env.store.relayMsg_t1, [{ id: 'm1', threadId: 't1', senderId: 'p1', body: 'hi there', sentAt: msg.sentAt, fromMe: false }]);
    assert.deepEqual(env.store.relayThreads, [{ id: 't1', contactId: 'p1', contactName: 'Pat', lastMessage: 'hi there', lastAt: msg.sentAt, unreadCount: 1 }]);

    // Duplicate delivery: message list untouched, thread still bumped (unchanged semantics).
    await env.api.storeRelayMessage(msg);
    assert.equal(env.store.relayMsg_t1.length, 1);
    assert.equal(env.store.relayThreads[0].unreadCount, 2);
});

test('relaySendMessage stores the sent message + thread in one write', async () => {
    const me = await keypair(), peer = await keypair();
    const env = load({ routes: [['/messages', () => ({ status: 200, body: { id: 'm9', threadId: 't9', sentAt: '2026-11-08T11:00:00.000Z' } })]] });
    env.store.relayProfile = { id: 'me', authToken: 'RT', privateKeyJwk: me.priv, publicKeyJwk: me.pub };
    env.store.relayContacts = [{ id: 'p1', name: 'Pat', publicKeyJwk: peer.pub }];
    env.store.relayThreads = [{ id: 't9', contactId: 'p1', contactName: 'Pat', lastMessage: 'old', lastAt: 'x', unreadCount: 3 }];
    await new Promise(r => setImmediate(r)); // let load-time updateBadge() settle
    env.storageOps.get = 0; env.storageOps.set = 0;

    const r = await env.api.handleMessage({ action: 'relaySendMessage', recipientId: 'p1', body: 'yo' });
    assert.deepEqual(r, { ok: true, id: 'm9', threadId: 't9' });
    assert.equal(env.storageOps.set, 1);
    assert.deepEqual(env.store.relayMsg_t9, [{ id: 'm9', threadId: 't9', senderId: 'me', body: 'yo', sentAt: '2026-11-08T11:00:00.000Z', fromMe: true, read: false }]);
    assert.deepEqual(env.store.relayThreads, [{ id: 't9', contactId: 'p1', contactName: 'Pat', lastMessage: 'yo', lastAt: '2026-11-08T11:00:00.000Z', unreadCount: 3 }]);
});

test('findOrCreateClassChat caches the topic id per host+course; fresh bypasses it', async () => {
    const topics = [{ id: 11, title: 'Week 1' }, { id: 42, title: '📣 Class Chat', message: '<p>long body…</p>' }];
    const env = load({ routes: [['/courses/9/discussion_topics?', () => ({ status: 200, body: topics })]] });
    env.store.canvasUrl = 'https://school.instructure.com'; env.store.apiToken = 'T';
    await new Promise(r => setImmediate(r));
    const listCalls = () => env.calls.filter(c => c.url.includes('/discussion_topics?')).length;

    assert.equal((await env.api.handleMessage({ action: 'findOrCreateClassChat', courseId: 9 })).id, 42);
    assert.equal(listCalls(), 1);
    assert.deepEqual(env.store.cmClassChatTopics, { 'https://school.instructure.com|9': 42 });

    assert.deepEqual(await env.api.handleMessage({ action: 'findOrCreateClassChat', courseId: 9 }), { id: 42 });
    assert.equal(listCalls(), 1, 'second open served from cache');

    topics[1].id = 43; // topic was recreated
    assert.equal((await env.api.handleMessage({ action: 'findOrCreateClassChat', courseId: 9, fresh: true })).id, 43);
    assert.equal(listCalls(), 2);
    assert.equal(env.store.cmClassChatTopics['https://school.instructure.com|9'], 43);
});

// The pre-cache implementation, verbatim, to prove wire compatibility both ways.
async function legacyEncrypt(plaintext, privateJwk, peerPublicJwk) {
    const priv = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
    const pub  = await crypto.subtle.importKey('jwk', peerPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const key  = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const enc  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    const b64  = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
    return { encryptedBody: b64(enc), iv: b64(iv) };
}
async function legacyDecrypt(encB64, ivB64, privateJwk, peerPublicJwk) {
    const priv = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
    const pub  = await crypto.subtle.importKey('jwk', peerPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const key  = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const dec  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(atob(ivB64), c => c.charCodeAt(0)) }, key,
        Uint8Array.from(atob(encB64), c => c.charCodeAt(0)));
    return new TextDecoder().decode(dec);
}

test('cached ECDH keys stay wire-compatible with the previous per-message derivation', async () => {
    const env = load();
    const alice = await keypair(), bob = await keypair(), carol = await keypair();
    // old sender -> new receiver
    const m1 = await legacyEncrypt('from old client', bob.priv, alice.pub);
    assert.equal(await env.api.relayDecrypt(m1.encryptedBody, m1.iv, alice.priv, bob.pub), 'from old client');
    // new sender -> old receiver (reusing the now-cached alice/bob key)
    const m2 = await env.api.relayEncrypt('from new client', alice.priv, bob.pub);
    assert.equal(await legacyDecrypt(m2.encryptedBody, m2.iv, bob.priv, alice.pub), 'from new client');
    // different peers never share a cached key
    const m3 = await env.api.relayEncrypt('for carol only', alice.priv, carol.pub);
    assert.equal(await legacyDecrypt(m3.encryptedBody, m3.iv, carol.priv, alice.pub), 'for carol only');
    await assert.rejects(legacyDecrypt(m3.encryptedBody, m3.iv, bob.priv, alice.pub));
    await assert.rejects(env.api.relayDecrypt(m3.encryptedBody, m3.iv, alice.priv, bob.pub));
    // repeated use of one pair returns correct plaintexts
    for (let i = 0; i < 5; i++) {
        const m = await legacyEncrypt(`n${i}`, bob.priv, alice.pub);
        assert.equal(await env.api.relayDecrypt(m.encryptedBody, m.iv, alice.priv, bob.pub), `n${i}`);
    }
});
