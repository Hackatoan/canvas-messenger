const urlInput   = document.getElementById('canvas-url');
const tokenInput  = document.getElementById('api-token');
const saveBtn     = document.getElementById('save-btn');
const testBtn     = document.getElementById('test-btn');
const statusEl    = document.getElementById('status');
const userInfo    = document.getElementById('user-info');
const userAvatar  = document.getElementById('user-avatar');
const userName    = document.getElementById('user-name');

function showStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + type;
}

function initials(name = '?') {
    return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

// Load saved settings
chrome.storage.local.get(['canvasUrl', 'apiToken', 'currentUser'], data => {
    if (data.canvasUrl)  urlInput.value   = data.canvasUrl;
    if (data.apiToken)   tokenInput.value = data.apiToken;
    if (data.currentUser) showUserInfo(data.currentUser);
});

function showUserInfo(user) {
    userAvatar.textContent = initials(user.name || '?');
    userName.textContent   = user.name || user.login_id || 'Unknown';
    userInfo.style.display = 'flex';
}

async function testConnection(url, token) {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/v1/users/self`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    return res.json();
}

saveBtn.addEventListener('click', async () => {
    const url   = urlInput.value.trim();
    const token = tokenInput.value.trim();

    if (!url || !token) { showStatus('Please fill in both fields.', 'error'); return; }

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        showStatus('Invalid URL — make sure it starts with https://', 'error');
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Connecting…';
    statusEl.className = 'status';

    try {
        const user = await testConnection(parsedUrl.origin, token);
        chrome.storage.local.set({ canvasUrl: parsedUrl.origin, apiToken: token, currentUser: user }, () => {
            // Keep the cloud copy current if this device is signed in (no-op otherwise).
            send({ action: 'accountSyncToken' }).then(refreshAccount).catch(() => {});
        });
        showStatus(`Connected as ${user.name || user.login_id}!`, 'success');
        showUserInfo(user);
        chrome.runtime.sendMessage({ action: 'updateBadge' });
    } catch (e) {
        showStatus(`Connection failed: ${e.message}. Check your URL and token.`, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save & Connect';
    }
});

testBtn.addEventListener('click', async () => {
    const url   = urlInput.value.trim();
    const token = tokenInput.value.trim();
    if (!url || !token) { showStatus('Fill in both fields first.', 'error'); return; }

    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    try {
        const user = await testConnection(url, token);
        showStatus(`✓ Connected as ${user.name || user.login_id}`, 'success');
    } catch (e) {
        showStatus(`✗ Failed: ${e.message}`, 'error');
    } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Test Connection';
    }
});

// ── Account (Firebase Auth via the background script) ────────────────────────
const accountBox      = document.getElementById('account-box');
const acctSignedOut   = document.getElementById('account-signed-out');
const acctSignedIn    = document.getElementById('account-signed-in');
const acctWho         = document.getElementById('account-who');
const acctEmail       = document.getElementById('account-email');
const acctPassword    = document.getElementById('account-password');
const acctStatus      = document.getElementById('account-status');
const acctButtons     = ['account-signin-btn', 'account-signup-btn', 'account-reset-btn', 'account-signout-btn', 'account-unlink-btn']
    .map(id => document.getElementById(id));

function acctMsg(msg, type) {
    acctStatus.textContent = msg;
    acctStatus.className = 'status inline ' + type;
}

function send(msg) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, res => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (res && res.error) return reject(new Error(res.error));
            resolve(res);
        });
    });
}

async function acctRun(fn) {
    acctButtons.forEach(b => { b.disabled = true; });
    acctStatus.className = 'status inline';
    try { return await fn(); }
    catch (e) { acctMsg(e.message, 'error'); }
    finally { acctButtons.forEach(b => { b.disabled = false; }); }
}

async function refreshAccount() {
    let st;
    try { st = await send({ action: 'accountStatus' }); } catch { return; }
    if (!st || !st.configured) { accountBox.hidden = true; return; }   // build without a Firebase key
    accountBox.hidden = false;
    acctSignedOut.hidden = st.signedIn;
    acctSignedIn.hidden = !st.signedIn;
    if (st.signedIn) {
        acctWho.textContent = st.linked
            ? `Signed in as ${st.email}. Your Canvas connection is backed up.`
            : `Signed in as ${st.email}. Connect to Canvas and press Save & Connect to back it up.`;
    }
    // New device with nothing saved yet: lead with the account box.
    chrome.storage.local.get('apiToken', d => { if (!d.apiToken && !st.signedIn) accountBox.open = true; });
}

// Reload the Canvas fields after a restore replaced local settings.
function reloadSettingsFields() {
    chrome.storage.local.get(['canvasUrl', 'apiToken', 'currentUser'], data => {
        if (data.canvasUrl)  urlInput.value   = data.canvasUrl;
        if (data.apiToken)   tokenInput.value = data.apiToken;
        if (data.currentUser) showUserInfo(data.currentUser);
    });
}

function acctCreds() {
    const email = acctEmail.value.trim(), password = acctPassword.value;
    if (!email || !password) throw new Error('Enter your email and password.');
    return { email, password };
}

document.getElementById('account-signin-btn').addEventListener('click', () => acctRun(async () => {
    const r = await send({ action: 'accountSignIn', ...acctCreds() });
    acctPassword.value = '';
    if (r.restored)      acctMsg('Signed in — your Canvas connection was restored on this device.', 'success');
    else if (r.linked)   acctMsg('Signed in and backed up this device\'s Canvas connection.', 'success');
    else                 acctMsg(`Signed in. ${r.notice || ''}`.trim(), 'info');
    reloadSettingsFields();
    await refreshAccount();
}));

document.getElementById('account-signup-btn').addEventListener('click', () => acctRun(async () => {
    const r = await send({ action: 'accountSignUp', ...acctCreds() });
    acctPassword.value = '';
    acctMsg(r.linked ? 'Account created and your Canvas connection is backed up.' : `Account created. ${r.notice || ''}`.trim(), r.linked ? 'success' : 'info');
    await refreshAccount();
}));

document.getElementById('account-reset-btn').addEventListener('click', () => acctRun(async () => {
    const email = acctEmail.value.trim();
    if (!email) throw new Error('Enter your email above first.');
    await send({ action: 'accountResetPassword', email });
    acctMsg('If that email has an account, a reset link is on its way.', 'success');
}));

document.getElementById('account-signout-btn').addEventListener('click', () => acctRun(async () => {
    await send({ action: 'accountSignOut' });
    acctMsg('Signed out on this device.', 'success');
    await refreshAccount();
}));

document.getElementById('account-unlink-btn').addEventListener('click', () => acctRun(async () => {
    if (!confirm('Delete the backed-up Canvas token from the relay? You stay signed in here, but other devices can no longer restore from it.')) return;
    await send({ action: 'accountUnlink' });
    acctMsg('Cloud copy deleted.', 'success');
    await refreshAccount();
}));

refreshAccount();
