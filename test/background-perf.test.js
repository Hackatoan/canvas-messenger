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
    const injections = [];
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
    chrome.scripting = { executeScript: async (o) => { injections.push(o); return []; } };
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
        src + '\nreturn { handleMessage, updateBadge, broadcastToTabs, storeRelayMessage, relayEncrypt };')
        (chrome, WS, fetchFake, globalThis.crypto, inert, inert, inert, inert);
    return { api, store, calls, storageOps, badge, tabQueries, tabMessages, injections };
}

const unreadRoute = ['/conversations?scope=unread', () => ({ status: 200, body: [{ id: 1 }, { id: 2 }] })];

test('updateBadge publishes the unread count for content scripts, writing only on change', async () => {
    const env = load({ routes: [unreadRoute] });
    env.store.canvasUrl = 'https://school.instructure.com'; env.store.apiToken = 'T';
    await new Promise(r => setImmediate(r)); // let the load-time updateBadge() settle
    env.calls.length = 0; env.badge.length = 0;

    await env.api.handleMessage({ action: 'updateBadge' });
    assert.equal(env.calls.filter(c => c.url.includes('scope=unread')).length, 1);
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

test('injectMessengerUI loads only the sidebar UI file into the requesting tab/frame', async () => {
    const env = load();
    assert.deepEqual(await env.api.handleMessage({ action: 'injectMessengerUI' }, { tab: { id: 7 }, frameId: 0 }), { ok: true });
    assert.deepEqual(env.injections, [{ target: { tabId: 7, frameIds: [0] }, files: ['styles/messenger.js'] }]);
    await assert.rejects(env.api.handleMessage({ action: 'injectMessengerUI' }, {}), /No sender tab/);
});

test('manifests no longer inject the sidebar UI into every page', () => {
    for (const f of ['manifest.json', 'manifest-chrome.json']) {
        const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
        const js = m.content_scripts.flatMap(c => c.js);
        assert.ok(js.includes('content.js'), f);
        assert.ok(!js.includes('styles/messenger.js'), f);
    }
});
