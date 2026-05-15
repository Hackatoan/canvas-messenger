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
        chrome.storage.local.set({ canvasUrl: parsedUrl.origin, apiToken: token, currentUser: user });
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
