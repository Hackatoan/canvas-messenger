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
    if (alarm.name === 'poll') updateBadge();
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
