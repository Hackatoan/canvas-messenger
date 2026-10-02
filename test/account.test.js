'use strict';
// Exercises the account flow in background.js against a fake Firebase Auth +
// relay + Canvas, with chrome.* stubbed. background.js has no module exports,
// so it is evaluated in a function scope and the pieces under test returned.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function noop() {}
function deepStub() { // any chrome.a.b.c(...) call is a harmless no-op
    const f = function () {};
    return new Proxy(f, { get: (t, k) => (k in t ? t[k] : (k === 'then' ? undefined : deepStub())), apply: () => undefined });
}

function load({ apiKey = 'test-key', routes }) {
    const store = {};
    const calls = [];
    const chrome = deepStub();
    chrome.storage = { local: {
        get: (keys, cb) => {
            const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
            const out = {}; for (const k of ks) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
            cb(out);
        },
        set: (o, cb) => { for (const [k, v] of Object.entries(o)) store[k] = JSON.parse(JSON.stringify(v)); cb && cb(); },
        remove: (keys, cb) => { for (const k of [].concat(keys)) delete store[k]; cb && cb(); },
    } };
    chrome.runtime = { onMessage: { addListener: noop }, onInstalled: { addListener: noop }, onStartup: { addListener: noop }, sendMessage: noop, openOptionsPage: noop };
    chrome.tabs = { query: async () => [], sendMessage: async () => {} };
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
    let src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    src = src.replace(/const FIREBASE_API_KEY = '[^']*';/, `const FIREBASE_API_KEY = '${apiKey}';`);
    // Inert timers: background.js arms reconnect/poll timers at load, which
    // would otherwise keep the test process alive forever.
    const inert = () => 0;
    const api = new Function('chrome', 'WebSocket', 'fetch', 'crypto', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        src + '\nreturn { accountSignUp, accountSignIn, accountSignOut, accountStatus, accountUnlink, accountSyncToken, accountResetPassword };')
        (chrome, WS, fetchFake, globalThis.crypto, inert, inert, inert, inert);
    return { api, store, calls };
}

const KEYPAIR = { publicKeyJwk: { kty: 'EC', x: 'px' }, privateKeyJwk: { kty: 'EC', d: 'secret' } };
const fbOk = (extra = {}) => ({ status: 200, body: { idToken: 'ID1', refreshToken: 'RT1', localId: 'uid1', email: 'a@x.edu', expiresIn: '3600', ...extra } });

test('accounts are disabled when no Firebase key is built in', async () => {
    const { api } = load({ apiKey: '', routes: [] });
    assert.deepEqual(await api.accountStatus(), { configured: false, signedIn: false, email: null, linked: false });
    await assert.rejects(api.accountSignIn({ email: 'a@x.edu', password: 'pw' }), /aren't enabled/);
});

test('sign-up on a connected device backs the Canvas token up to the relay', async () => {
    let linkReq;
    const { api, store } = load({ routes: [
        ['accounts:signUp', () => fbOk()],
        ['/account/link', (u, o) => { linkReq = o; return { status: 200, body: { ok: true } }; }],
    ] });
    store.canvasUrl = 'https://school.instructure.com'; store.apiToken = 'CANVAS-TOKEN';
    store.currentUser = { id: 42, name: 'Alice' };
    store.relayProfile = { id: 'u1', authToken: 'RELAY-TOKEN', name: 'Alice', ...KEYPAIR };
    const r = await api.accountSignUp({ email: 'a@x.edu', password: 'hunter22' });
    assert.deepEqual(r, { ok: true, linked: true });
    assert.equal(linkReq.headers['X-Firebase-Token'], 'ID1');
    assert.equal(linkReq.headers.Authorization, 'Bearer RELAY-TOKEN');
    assert.deepEqual(JSON.parse(linkReq.body), { canvasUrl: 'https://school.instructure.com', canvasUserId: '42', canvasToken: 'CANVAS-TOKEN' });
    assert.equal(store.fbSession.linked, true);
    assert.equal(store.fbSession.refreshToken, 'RT1');
    assert.equal((await api.accountStatus()).signedIn, true);
});

test('sign-up before connecting Canvas still creates the account and says what is missing', async () => {
    const { api } = load({ routes: [['accounts:signUp', () => fbOk()]] });
    const r = await api.accountSignUp({ email: 'a@x.edu', password: 'hunter22' });
    assert.equal(r.ok, true); assert.equal(r.linked, false);
    assert.match(r.notice, /Connect to Canvas first/);
});

test('sign-in on a brand-new device restores Canvas, relay login, keys and contacts', async () => {
    const { api, store } = load({ routes: [
        ['accounts:signInWithPassword', () => fbOk()],
        ['/account/login', () => ({ status: 200, body: {
            id: 'u1', authToken: 'RELAY-TOKEN', name: 'Alice', email: 'a@x.edu', keypair: KEYPAIR,
            contacts: [{ id: 'c1', name: 'Bob' }], canvas: { url: 'https://school.instructure.com', userId: '42', token: 'CANVAS-TOKEN' } } })],
        ['/api/v1/users/self', () => ({ status: 200, body: { id: 42, name: 'Alice A.' } })],
    ] });
    const r = await api.accountSignIn({ email: 'a@x.edu', password: 'hunter22' });
    assert.equal(r.restored, true);
    assert.equal(store.canvasUrl, 'https://school.instructure.com');
    assert.equal(store.apiToken, 'CANVAS-TOKEN');
    assert.equal(store.currentUser.name, 'Alice A.');
    assert.equal(store.relayProfile.authToken, 'RELAY-TOKEN');
    assert.deepEqual(store.relayProfile.privateKeyJwk, KEYPAIR.privateKeyJwk);   // the escrowed key wins
    assert.equal(store.relayKeyEscrowed, true);
    assert.deepEqual(store.relayContacts, [{ id: 'c1', name: 'Bob' }]);
    assert.equal(store.fbSession.linked, true);
});

test('restore merges contacts instead of clobbering local ones', async () => {
    const { api, store } = load({ routes: [
        ['accounts:signInWithPassword', () => fbOk()],
        ['/account/login', () => ({ status: 200, body: { id: 'u1', authToken: 't', name: 'A', keypair: KEYPAIR, contacts: [{ id: 'c1' }, { id: 'c2' }], canvas: { url: 'https://s.edu', userId: '1', token: 'x' } } })],
    ] });
    store.relayContacts = [{ id: 'c2' }, { id: 'local-only' }];
    await api.accountSignIn({ email: 'a@x.edu', password: 'pw1234' });
    assert.deepEqual(store.relayContacts.map(c => c.id).sort(), ['c1', 'c2', 'local-only']);
});

test('restore is refused (and nothing overwritten) when the account has no keys or no Canvas data', async () => {
    const noKeys = load({ routes: [['accounts:signInWithPassword', () => fbOk()],
        ['/account/login', () => ({ status: 200, body: { id: 'u1', authToken: 't', name: 'A', canvas: { url: 'https://s.edu', userId: '1', token: 'x' } } })]] });
    noKeys.store.apiToken = 'KEEP-ME';
    await assert.rejects(noKeys.api.accountSignIn({ email: 'a@x.edu', password: 'pw1234' }), /no saved encryption keys/);
    assert.equal(noKeys.store.apiToken, 'KEEP-ME');
    const noCanvas = load({ routes: [['accounts:signInWithPassword', () => fbOk()],
        ['/account/login', () => ({ status: 200, body: { id: 'u1', authToken: 't', keypair: KEYPAIR, canvas: null } })]] });
    await assert.rejects(noCanvas.api.accountSignIn({ email: 'a@x.edu', password: 'pw1234' }), /no saved Canvas connection/);
});

test('valid sign-in with no cloud data yet backs up a connected device (404 no_account)', async () => {
    const { api, store } = load({ routes: [
        ['accounts:signInWithPassword', () => fbOk()],
        ['/account/login', () => ({ status: 404, body: { error: 'no_account' } })],
        ['/account/link', () => ({ status: 200, body: { ok: true } })],
    ] });
    store.canvasUrl = 'https://s.edu'; store.apiToken = 't'; store.currentUser = { id: 1, name: 'A' };
    store.relayProfile = { id: 'u1', authToken: 'r', name: 'A', ...KEYPAIR };
    const r = await api.accountSignIn({ email: 'a@x.edu', password: 'pw1234' });
    assert.deepEqual({ linked: r.linked, restored: r.restored }, { linked: true, restored: false });
});

test('Firebase errors become readable messages', async () => {
    const wrong = load({ routes: [['accounts:signInWithPassword', () => ({ status: 400, body: { error: { message: 'INVALID_LOGIN_CREDENTIALS' } } })]] });
    await assert.rejects(wrong.api.accountSignIn({ email: 'a@x.edu', password: 'bad' }), /Wrong email or password/);
    const dupe = load({ routes: [['accounts:signUp', () => ({ status: 400, body: { error: { message: 'EMAIL_EXISTS' } } })]] });
    await assert.rejects(dupe.api.accountSignUp({ email: 'a@x.edu', password: 'pw1234' }), /already exists/);
    const weak = load({ routes: [['accounts:signUp', () => ({ status: 400, body: { error: { message: 'WEAK_PASSWORD : Password should be at least 6 characters' } } })]] });
    await assert.rejects(weak.api.accountSignUp({ email: 'a@x.edu', password: '1' }), /at least 6/);
});

test('an expired refresh token signs the user out instead of looping', async () => {
    const { api, store } = load({ routes: [['securetoken.googleapis.com', () => ({ status: 400, body: { error: { message: 'TOKEN_EXPIRED' } } })]] });
    store.fbSession = { email: 'a@x.edu', uid: 'uid1', refreshToken: 'DEAD', linked: true };
    await assert.rejects(api.accountUnlink(), /sign in again/);
    assert.equal(store.fbSession, undefined);
});

test('unlink asks the relay to delete the cloud copy and keeps local data', async () => {
    let hit = false;
    const { api, store } = load({ routes: [
        ['securetoken.googleapis.com', () => ({ status: 200, body: { id_token: 'ID2', refresh_token: 'RT2', expires_in: '3600' } })],
        ['/account/unlink', () => { hit = true; return { status: 200, body: { ok: true } }; }],
    ] });
    store.fbSession = { email: 'a@x.edu', uid: 'uid1', refreshToken: 'RT1', linked: true };
    store.apiToken = 'LOCAL'; 
    await api.accountUnlink();
    assert.equal(hit, true);
    assert.equal(store.fbSession.linked, false);
    assert.equal(store.apiToken, 'LOCAL');
    assert.equal(store.fbSession.refreshToken, 'RT2');   // rotated refresh token persisted
});

test('sign-out forgets the session only', async () => {
    const { api, store } = load({ routes: [] });
    store.fbSession = { email: 'a@x.edu', refreshToken: 'RT' }; store.apiToken = 'LOCAL';
    await api.accountSignOut();
    assert.equal(store.fbSession, undefined);
    assert.equal(store.apiToken, 'LOCAL');
});

test('token sync is a quiet no-op unless the account is linked', async () => {
    const { api } = load({ routes: [] });
    assert.deepEqual(await api.accountSyncToken(), { ok: true, skipped: true });
});
