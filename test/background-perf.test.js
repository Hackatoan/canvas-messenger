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
        src + '\nreturn { handleMessage, updateBadge, broadcastToTabs };')
        (chrome, WS, fetchFake, globalThis.crypto, inert, inert, inert, inert);
    return { api, store, calls, storageOps, badge, tabQueries, tabMessages };
}

const unreadRoute = ['/conversations?scope=unread', () => ({ status: 200, body: [{ id: 1 }, { id: 2 }] })];

test('updateBadge with a count from the content script skips the Canvas refetch', async () => {
    const env = load({ routes: [unreadRoute] });
    env.store.canvasUrl = 'https://school.instructure.com'; env.store.apiToken = 'T';
    await new Promise(r => setImmediate(r)); // let the load-time updateBadge() settle
    env.calls.length = 0; env.badge.length = 0;

    await env.api.handleMessage({ action: 'updateBadge', count: 3 });
    assert.equal(env.calls.length, 0);
    assert.deepEqual(env.badge, ['3']);

    await env.api.handleMessage({ action: 'updateBadge', count: 0 });
    assert.equal(env.calls.length, 0);
    assert.deepEqual(env.badge, ['3', '']);
});

test('updateBadge without a count still fetches the unread list itself', async () => {
    const env = load({ routes: [unreadRoute] });
    env.store.canvasUrl = 'https://school.instructure.com'; env.store.apiToken = 'T';
    await new Promise(r => setImmediate(r));
    env.calls.length = 0; env.badge.length = 0;

    await env.api.handleMessage({ action: 'updateBadge' });
    assert.equal(env.calls.filter(c => c.url.includes('scope=unread')).length, 1);
    assert.deepEqual(env.badge, ['2']);

    // Garbage counts are ignored rather than trusted.
    await env.api.handleMessage({ action: 'updateBadge', count: -1 });
    assert.equal(env.calls.filter(c => c.url.includes('scope=unread')).length, 2);
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
