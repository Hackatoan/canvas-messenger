// Shared Canvas Messenger UI logic
// Used by both popup/popup.js and the content-script sidebar

/* global chrome */

const API = {
    send(action, data = {}) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action, ...data }, res => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                if (res && res.error) return reject(new Error(res.error));
                resolve(res);
            });
        });
    },
    getConversations: (scope = 'all') => API.send('getConversations', { scope }),
    getConversation:  (id)            => API.send('getConversation',  { id }),
    sendReply:        (id, body)      => API.send('sendReply',        { id, body }),
    newConversation:  (recipients, subject, body) => API.send('newConversation', { recipients, subject, body }),
    searchRecipients: (search, context) => API.send('searchRecipients', { search, context }),
    getCourses:       ()              => API.send('getCourses'),
    getGroups:              ()                        => API.send('getGroups'),
    getGroupUsers:          (groupId)                 => API.send('getGroupUsers',          { groupId }),
    getCourseUsers:         (courseId, role)          => API.send('getCourseUsers',         { courseId, role }),
    getDiscussionEntries:   (courseId, topicId)       => API.send('getDiscussionEntries',   { courseId, topicId }),
    createDiscussionEntry:  (courseId, topicId, message) => API.send('createDiscussionEntry', { courseId, topicId, message }),
    findOrCreateClassChat:  (courseId)                => API.send('findOrCreateClassChat',  { courseId }),
    markRead:               (id)                      => API.send('markRead',               { id }),
    getSettings:      ()              => API.send('getSettings'),
    getCurrentUser:   ()              => API.send('getCurrentUser'),
    updateBadge:      ()              => API.send('updateBadge'),
    initCall:         (peerId, peerName, fromName) => API.send('initCall', { peerId, peerName, fromName }),
};

// ── Helpers ────────────────────────────────────────────────────────────────

function initials(name = '?') {
    return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function avatarColor(name = '') {
    const colors = ['#5865f2','#57f287','#fee75c','#eb459e','#ed4245','#3ba55c','#faa61a'];
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
    return colors[Math.abs(h) % colors.length];
}

function relativeTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diff < 86400 * 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fullTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
}

// ── Avatar element ─────────────────────────────────────────────────────────

function mkAvatar(name, size = 36) {
    const el = document.createElement('div');
    el.className = 'cm-avatar';
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.style.fontSize = Math.floor(size * 0.36) + 'px';
    el.style.background = avatarColor(name);
    el.textContent = initials(name);
    return el;
}

// ── Messenger class ────────────────────────────────────────────────────────

class CanvasMessenger {
    constructor(root, opts = {}) {
        this.root = root;           // DOM element to mount into
        this.popup = opts.popup;    // true if in popup mode
        this.currentUser = null;
        this.conversations = [];
        this.activeConvId = null;
        this.tab = 'all';
        this.recipients = [];       // for compose
        this.courses = [];
        this.searchDebounce = null;

        this.pendingSnippet = null;
        this.root.innerHTML = '';
        this.render();
    }

    async render() {
        this.root.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div> Loading…</div>';
        try {
            const settings = await API.getSettings();
            if (!settings.canvasUrl || !settings.apiToken) {
                this.renderSetup();
                return;
            }
            this.currentUser = await API.getCurrentUser().catch(() => null);
            await this.renderApp();
        } catch (e) {
            this.root.innerHTML = `<div class="cm-error">Failed to connect: ${escHtml(e.message)}</div>`;
        }
    }

    // ── Setup screen ───────────────────────────────────────────────────────

    renderSetup() {
        this.root.innerHTML = `
            <div class="cm-wrap">
                <div class="cm-setup">
                    <div class="cm-setup-logo">📚</div>
                    <h2>Canvas Messenger</h2>
                    <p>Connect your Canvas account to start messaging students and professors.</p>
                    <button class="cm-btn-primary" id="cm-open-settings">Open Settings</button>
                </div>
            </div>`;
        this.root.querySelector('#cm-open-settings').addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'openSettings' });
        });
    }

    // ── Main app ───────────────────────────────────────────────────────────

    async renderApp() {
        const wrap = document.createElement('div');
        wrap.className = 'cm-wrap' + (this.popup ? ' popup-mode' : '');
        wrap.innerHTML = `
            <div class="cm-app">
                <div class="cm-sidebar">
                    <div class="cm-sidebar-header">
                        <h1>Messages</h1>
                        <button class="cm-icon-btn" id="cm-compose-btn" title="New message">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                            </svg>
                        </button>
                        <button class="cm-icon-btn" id="cm-settings-btn" title="Settings">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="cm-tabs">
                        <button class="cm-tab active" data-tab="all">DMs</button>
                        <button class="cm-tab" data-tab="unread">Unread</button>
                        <button class="cm-tab" data-tab="classes">Classes</button>
                        <button class="cm-tab" data-tab="groups">Groups</button>
                        <button class="cm-tab" data-tab="contacts">Contacts</button>
                        <button class="cm-tab" data-tab="connect">Connect</button>
                    </div>
                    <div class="cm-conv-list" id="cm-conv-list">
                        <div class="cm-loading"><div class="cm-spinner"></div></div>
                    </div>
                </div>
                <div class="cm-main" id="cm-main">
                    <div class="cm-placeholder">
                        <div class="cm-placeholder-icon">💬</div>
                        <h2>No conversation selected</h2>
                        <p>Pick a conversation from the left or start a new one.</p>
                    </div>
                </div>
            </div>`;

        this.root.innerHTML = '';
        this.root.appendChild(wrap);
        this.$convList = wrap.querySelector('#cm-conv-list');
        this.$main     = wrap.querySelector('#cm-main');

        wrap.querySelector('#cm-settings-btn').addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openSettings' }));
        wrap.querySelector('#cm-compose-btn').addEventListener('click', () => this.renderCompose());
        wrap.querySelectorAll('.cm-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                wrap.querySelectorAll('.cm-tab').forEach(t => t.classList.remove('active'));
                btn.classList.add('active');
                this.tab = btn.dataset.tab;
                if (this.tab === 'groups') {
                    this.stopClassChatPoll();
                    this.loadGroups();
                } else if (this.tab === 'classes') {
                    this.loadClasses();
                } else if (this.tab === 'contacts') {
                    this.stopClassChatPoll();
                    this.loadContacts();
                } else if (this.tab === 'connect') {
                    this.stopClassChatPoll();
                    this.loadRelayTab();
                } else {
                    this.stopClassChatPoll();
                    this.loadConversations();
                }
            });
        });

        this.loadConversations();
    }

    // ── Conversation list ──────────────────────────────────────────────────

    async loadConversations() {
        this.$convList.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div></div>';
        try {
            this.conversations = await API.getConversations(this.tab);
            this.renderConvList();
        } catch (e) {
            this.$convList.innerHTML = `<div class="cm-error">${escHtml(e.message)}</div>`;
        }
    }

    renderConvList() {
        if (!this.conversations.length) {
            this.$convList.innerHTML = '<div class="cm-empty">No messages</div>';
            return;
        }
        this.$convList.innerHTML = '';
        for (const conv of this.conversations) {
            const item = this.mkConvItem(conv);
            this.$convList.appendChild(item);
        }
    }

    mkConvItem(conv) {
        const isUnread = conv.workflow_state === 'unread';
        const participants = conv.participants || [];
        const others = participants.filter(p => p.id !== (this.currentUser && this.currentUser.id));
        const displayName = others.length
            ? others.map(p => p.name).join(', ')
            : (participants[0] && participants[0].name) || 'Unknown';

        const el = document.createElement('div');
        el.className = 'cm-conv-item' + (isUnread ? ' unread' : '') + (conv.id == this.activeConvId ? ' active' : '');
        el.innerHTML = `
            <div style="flex-shrink:0"></div>
            <div class="cm-conv-info">
                <div class="cm-conv-top">
                    <span class="cm-conv-name">${escHtml(displayName)}</span>
                    <span class="cm-conv-time">${relativeTime(conv.last_message_at || conv.last_authored_at)}</span>
                </div>
                <div class="cm-conv-subject">${escHtml(conv.subject || '(no subject)')}</div>
                <div class="cm-conv-preview">${escHtml(conv.last_message || '')}</div>
            </div>
            ${isUnread ? '<div class="cm-unread-dot"></div>' : ''}`;

        const avatarSlot = el.querySelector('div[style]');
        avatarSlot.replaceWith(mkAvatar(displayName));

        el.addEventListener('click', () => {
            this.$convList.querySelectorAll('.cm-conv-item').forEach(i => i.classList.remove('active'));
            el.classList.add('active');
            el.classList.remove('unread');
            el.querySelector('.cm-unread-dot')?.remove();
            this.activeConvId = conv.id;
            this.openConversation(conv.id, conv.subject, displayName);
            if (isUnread) API.markRead(conv.id).then(() => API.updateBadge());
        });

        return el;
    }

    // ── Conversation view ──────────────────────────────────────────────────

    async openConversation(id, subject, withName) {
        this.$main.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div> Loading messages…</div>';
        try {
            const conv = await API.getConversation(id);
            this.renderConversation(conv, subject, withName);
        } catch (e) {
            this.$main.innerHTML = `<div class="cm-error">${escHtml(e.message)}</div>`;
        }
    }

    renderConversation(conv, subject, withName) {
        const messages = conv.messages || [];
        const participants = conv.participants || [];
        const peer = participants.find(p => p.id !== (this.currentUser && this.currentUser.id));

        const participantMap = {};
        for (const p of participants) participantMap[p.id] = p;

        // Group consecutive messages by same author (Discord style)
        const groups = [];
        for (const msg of [...messages].reverse()) {
            const last = groups[groups.length - 1];
            if (last && last.authorId === msg.author_id) {
                last.messages.push(msg);
            } else {
                groups.push({ authorId: msg.author_id, messages: [msg] });
            }
        }

        const messagesHtml = groups.map(g => {
            const author = participantMap[g.authorId] || { name: 'Unknown' };
            const isMe = this.currentUser && g.authorId === this.currentUser.id;
            const firstMsg = g.messages[0];
            return `
                <div class="cm-msg-group">
                    <div class="cm-msg-group-avatar">
                        <div class="cm-avatar" style="width:36px;height:36px;font-size:13px;background:${avatarColor(author.name)}">${initials(author.name)}</div>
                    </div>
                    <div class="cm-msg-group-body">
                        <div class="cm-msg-group-header">
                            <span class="cm-msg-author" style="color:${isMe ? '#5865f2' : '#f2f3f5'}">${escHtml(author.name)}</span>
                            <span class="cm-msg-timestamp">${fullTime(firstMsg.created_at)}</span>
                        </div>
                        ${g.messages.map(m => `<div class="cm-msg-bubble">${escHtml(m.body || '')}</div>`).join('')}
                    </div>
                </div>`;
        }).join('');

        this.$main.innerHTML = `
            <div class="cm-main-header">
                <div>
                    <div class="cm-main-title">${escHtml(subject || '(no subject)')}</div>
                    <div class="cm-main-subtitle">with ${escHtml(withName)}</div>
                </div>
                ${peer ? `<button class="cm-icon-btn cm-call-btn" id="cm-call-btn" title="Start video call">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/>
                    </svg>
                </button>` : ''}
            </div>
            <div class="cm-messages" id="cm-messages">
                ${messagesHtml || '<div class="cm-empty">No messages yet</div>'}
            </div>
            <div class="cm-input-area">
                <div id="cm-snippet-preview-wrap"></div>
                <div class="cm-input-box">
                    <textarea id="cm-reply-box" placeholder="Message ${escHtml(withName)}…" rows="1"></textarea>
                    <button class="cm-icon-btn cm-snippet-btn" id="cm-snippet-btn" title="Send screenshot">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                            <polyline points="21 15 16 10 5 21"/>
                        </svg>
                    </button>
                    <button class="cm-send-btn" id="cm-send-btn" title="Send">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </button>
                </div>
            </div>`;

        const msgContainer = this.$main.querySelector('#cm-messages');
        msgContainer.scrollTop = msgContainer.scrollHeight;

        const textarea = this.$main.querySelector('#cm-reply-box');
        const sendBtn  = this.$main.querySelector('#cm-send-btn');

        textarea.addEventListener('input', () => {
            autoResize(textarea);
            sendBtn.classList.toggle('active', textarea.value.trim().length > 0);
        });

        textarea.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.doReply(conv.id, textarea, msgContainer, participants);
            }
        });

        sendBtn.addEventListener('click', () => {
            this.doReply(conv.id, textarea, msgContainer, participants);
        });

        this.$main.querySelector('#cm-call-btn')?.addEventListener('click', () => {
            if (!peer) return;
            const fromName = this.currentUser?.name || 'Canvas User';
            API.initCall(String(peer.id), peer.name, fromName);
        });

        this.$main.querySelector('#cm-snippet-btn')?.addEventListener('click', () => {
            this.doSnippet(conv.id, msgContainer, textarea);
        });
    }

    async doReply(convId, textarea, msgContainer, participants) {
        const body = textarea.value.trim();
        const snippetDataUrl = this.pendingSnippet;
        if (!body && !snippetDataUrl) return;

        this.pendingSnippet = null;
        const previewWrap = this.$main.querySelector('#cm-snippet-preview-wrap');
        if (previewWrap) previewWrap.innerHTML = '';

        textarea.value = '';
        autoResize(textarea);

        const myName = this.currentUser ? this.currentUser.name : 'Me';
        const bubble = document.createElement('div');
        bubble.className = 'cm-msg-group';
        bubble.innerHTML = `
            <div class="cm-msg-group-avatar">
                <div class="cm-avatar" style="width:36px;height:36px;font-size:13px;background:${avatarColor(myName)}">${initials(myName)}</div>
            </div>
            <div class="cm-msg-group-body">
                <div class="cm-msg-group-header">
                    <span class="cm-msg-author" style="color:#5865f2">${escHtml(myName)}</span>
                    <span class="cm-msg-timestamp">Just now</span>
                </div>
                <div class="cm-msg-bubble">${escHtml(body)}${snippetDataUrl ? '<br><em style="color:#87898c;font-size:12px">&#128247; Screenshot attached</em>' : ''}</div>
            </div>`;
        msgContainer.appendChild(bubble);
        msgContainer.scrollTop = msgContainer.scrollHeight;

        try {
            if (snippetDataUrl) {
                const res = await new Promise(r => chrome.runtime.sendMessage(
                    { action: 'uploadFile', dataUrl: snippetDataUrl, filename: 'screenshot.png' }, r));
                if (res?.error) throw new Error(res.error);
                await new Promise(r => chrome.runtime.sendMessage(
                    { action: 'sendReplyWithAttachment', convId, body: body || ' ', attachmentIds: [res.fileId] }, r));
            } else {
                await API.sendReply(convId, body);
            }
            this.loadConversations();
        } catch (e) {
            bubble.style.opacity = '0.4';
            bubble.title = 'Failed to send: ' + e.message;
        }
    }

    async doSnippet(convId, msgContainer, textarea) {
        const btn = this.$main.querySelector('#cm-snippet-btn');
        if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; }
        try {
            const result = await new Promise(r => chrome.runtime.sendMessage({ action: 'captureTab' }, r));
            if (!result?.dataUrl) throw new Error('Screenshot unavailable');
            this.pendingSnippet = result.dataUrl;

            const wrap = this.$main.querySelector('#cm-snippet-preview-wrap');
            if (wrap) {
                wrap.innerHTML = `
                    <div class="cm-snippet-preview">
                        <img src="${result.dataUrl}" class="cm-snippet-thumb" alt="Screenshot" />
                        <button class="cm-snippet-remove" id="cm-snippet-remove" title="Remove">×</button>
                    </div>`;
                wrap.querySelector('#cm-snippet-remove').addEventListener('click', () => {
                    this.pendingSnippet = null;
                    wrap.innerHTML = '';
                });
            }
            textarea?.focus();
        } catch (e) {
            console.error('[CM] snippet:', e.message);
        } finally {
            if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        }
    }

    // ── Compose new conversation ───────────────────────────────────────────

    // ── Classes tab ────────────────────────────────────────────────────────

    async loadClasses() {
        this.$convList.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div></div>';
        this.stopClassChatPoll();
        try {
            const courses = await API.getCourses();
            if (!courses.length) {
                this.$convList.innerHTML = '<div class="cm-empty">No active courses</div>';
                return;
            }
            this.$convList.innerHTML = '';
            for (const c of courses) {
                const item = document.createElement('div');
                item.className = 'cm-conv-item' + (c.id == this.activeConvId ? ' active' : '');
                item.innerHTML = `
                    <div style="flex-shrink:0"></div>
                    <div class="cm-conv-info">
                        <div class="cm-conv-top">
                            <span class="cm-conv-name">${escHtml(c.course_code || c.name)}</span>
                        </div>
                        <div class="cm-conv-preview">${escHtml(c.name)}</div>
                    </div>`;
                const av = mkAvatar(c.course_code || c.name);
                av.style.background = '#e67e22';
                item.querySelector('div[style]').replaceWith(av);

                item.addEventListener('click', () => {
                    this.$convList.querySelectorAll('.cm-conv-item').forEach(i => i.classList.remove('active'));
                    item.classList.add('active');
                    this.activeConvId = c.id;
                    this.openClassChat(c);
                });
                this.$convList.appendChild(item);
            }
        } catch (e) {
            this.$convList.innerHTML = `<div class="cm-error">${escHtml(e.message)}</div>`;
        }
    }

    async openClassChat(course) {
        this.stopClassChatPoll();
        this.$main.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div> Setting up class chat…</div>';
        try {
            const topic = await API.findOrCreateClassChat(course.id);
            this.classChatTopic = topic;
            this.classChatCourse = course;
            await this.renderClassChat(course, topic, true);
            // Poll for new messages every 20s while the chat is open
            this.classChatPollTimer = setInterval(() => this.refreshClassChat(), 20000);
        } catch (e) {
            this.$main.innerHTML = `<div class="cm-error">${escHtml(e.message)}</div>`;
        }
    }

    async renderClassChat(course, topic, scrollToBottom = false) {
        let entries;
        try {
            entries = await API.getDiscussionEntries(course.id, topic.id);
        } catch (e) {
            this.$main.innerHTML = `<div class="cm-error">${escHtml(e.message)}</div>`;
            return;
        }

        // Sort oldest first
        entries = [...entries].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        // Group consecutive entries by same author (Discord-style)
        const groups = [];
        for (const entry of entries) {
            const last = groups[groups.length - 1];
            const authorId = entry.user_id || (entry.user && entry.user.id);
            if (last && last.authorId === authorId) {
                last.entries.push(entry);
            } else {
                groups.push({ authorId, author: entry.user || { display_name: 'Unknown' }, entries: [entry] });
            }
        }

        const messagesHtml = groups.map(g => {
            const name = g.author.display_name || g.author.name || 'Unknown';
            const isMe = this.currentUser && (g.authorId === this.currentUser.id || String(g.authorId) === String(this.currentUser.id));
            const firstEntry = g.entries[0];
            return `
                <div class="cm-msg-group">
                    <div class="cm-msg-group-avatar">
                        <div class="cm-avatar" style="width:36px;height:36px;font-size:13px;background:${avatarColor(name)}">${initials(name)}</div>
                    </div>
                    <div class="cm-msg-group-body">
                        <div class="cm-msg-group-header">
                            <span class="cm-msg-author" style="color:${isMe ? '#5865f2' : '#f2f3f5'}">${escHtml(name)}</span>
                            <span class="cm-msg-timestamp">${fullTime(firstEntry.created_at)}</span>
                        </div>
                        ${g.entries.map(e => `<div class="cm-msg-bubble">${stripHtml(e.message || '')}</div>`).join('')}
                    </div>
                </div>`;
        }).join('');

        // Preserve scroll position if refreshing
        const existingMsgs = this.$main.querySelector('#cm-class-messages');
        const wasAtBottom = !existingMsgs || (existingMsgs.scrollHeight - existingMsgs.scrollTop - existingMsgs.clientHeight < 60);

        this.$main.innerHTML = `
            <div class="cm-main-header">
                <div class="cm-class-channel-icon">📣</div>
                <div>
                    <div class="cm-main-title">${escHtml(course.course_code || course.name)}</div>
                    <div class="cm-main-subtitle">Class Chat · ${escHtml(course.name)}</div>
                </div>
                <div class="cm-class-live-dot" title="Live — updates every 20s"></div>
            </div>
            <div class="cm-messages" id="cm-class-messages">
                ${entries.length === 0
                    ? '<div class="cm-empty" style="margin-top:40px">No messages yet — say hello! 👋</div>'
                    : messagesHtml}
            </div>
            <div class="cm-input-area">
                <div class="cm-input-box">
                    <textarea id="cm-class-input" placeholder="Message ${escHtml(course.course_code || course.name)}…" rows="1"></textarea>
                    <button class="cm-send-btn cm-class-send" title="Send">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </button>
                </div>
            </div>`;

        const msgEl = this.$main.querySelector('#cm-class-messages');
        if (scrollToBottom || wasAtBottom) msgEl.scrollTop = msgEl.scrollHeight;

        const textarea = this.$main.querySelector('#cm-class-input');
        const sendBtn  = this.$main.querySelector('.cm-class-send');

        textarea.addEventListener('input', () => {
            autoResize(textarea);
            sendBtn.classList.toggle('active', textarea.value.trim().length > 0);
        });

        textarea.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.doClassPost(textarea, msgEl);
            }
        });

        sendBtn.addEventListener('click', () => this.doClassPost(textarea, msgEl));
    }

    async doClassPost(textarea, msgEl) {
        const message = textarea.value.trim();
        if (!message) return;
        textarea.value = '';
        autoResize(textarea);

        const myName = this.currentUser ? this.currentUser.name : 'Me';
        const bubble = document.createElement('div');
        bubble.className = 'cm-msg-group';
        bubble.innerHTML = `
            <div class="cm-msg-group-avatar">
                <div class="cm-avatar" style="width:36px;height:36px;font-size:13px;background:${avatarColor(myName)}">${initials(myName)}</div>
            </div>
            <div class="cm-msg-group-body">
                <div class="cm-msg-group-header">
                    <span class="cm-msg-author" style="color:#5865f2">${escHtml(myName)}</span>
                    <span class="cm-msg-timestamp">Just now</span>
                </div>
                <div class="cm-msg-bubble">${escHtml(message)}</div>
            </div>`;
        msgEl.appendChild(bubble);
        msgEl.scrollTop = msgEl.scrollHeight;

        try {
            await API.createDiscussionEntry(this.classChatCourse.id, this.classChatTopic.id, message);
        } catch (e) {
            bubble.style.opacity = '0.4';
            bubble.title = 'Failed: ' + e.message;
        }
    }

    async refreshClassChat() {
        if (!this.classChatTopic || !this.classChatCourse) return;
        // Only refresh if the class chat view is still shown
        if (!this.$main.querySelector('#cm-class-messages')) return;
        await this.renderClassChat(this.classChatCourse, this.classChatTopic, false);
    }

    stopClassChatPoll() {
        if (this.classChatPollTimer) {
            clearInterval(this.classChatPollTimer);
            this.classChatPollTimer = null;
        }
        this.classChatTopic  = null;
        this.classChatCourse = null;
    }

    // ── Groups tab ─────────────────────────────────────────────────────────

    async loadGroups() {
        this.$convList.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div></div>';
        try {
            const groups = await API.getGroups();
            if (!groups.length) {
                this.$convList.innerHTML = '<div class="cm-empty">No groups found</div>';
                return;
            }
            this.$convList.innerHTML = '';
            for (const g of groups) {
                const item = document.createElement('div');
                item.className = 'cm-conv-item' + (g.id == this.activeConvId ? ' active' : '');
                item.innerHTML = `
                    <div style="flex-shrink:0"></div>
                    <div class="cm-conv-info">
                        <div class="cm-conv-top">
                            <span class="cm-conv-name">${escHtml(g.name)}</span>
                        </div>
                        <div class="cm-conv-subject">${escHtml(g.course_id ? 'Class group' : 'Group')} · ${g.members_count || 0} members</div>
                    </div>`;
                const avatarSlot = item.querySelector('div[style]');
                const av = mkAvatar(g.name);
                av.style.background = '#3ba55c';
                avatarSlot.replaceWith(av);

                item.addEventListener('click', () => {
                    this.$convList.querySelectorAll('.cm-conv-item').forEach(i => i.classList.remove('active'));
                    item.classList.add('active');
                    this.activeConvId = g.id;
                    this.openGroupView(g);
                });
                this.$convList.appendChild(item);
            }
        } catch (e) {
            this.$convList.innerHTML = `<div class="cm-error">${escHtml(e.message)}</div>`;
        }
    }

    async openGroupView(group) {
        this.$main.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div> Loading members…</div>';
        try {
            const members = await API.getGroupUsers(group.id);
            const others = members.filter(m => m.id !== (this.currentUser && this.currentUser.id));

            this.$main.innerHTML = `
                <div class="cm-main-header">
                    <div>
                        <div class="cm-main-title">${escHtml(group.name)}</div>
                        <div class="cm-main-subtitle">${members.length} members</div>
                    </div>
                    <button class="cm-btn-primary" id="cm-msg-group-btn" style="margin-left:auto;font-size:12px;padding:6px 14px">Message Group</button>
                </div>
                <div class="cm-messages" id="cm-members-list">
                    <div style="padding:8px 0 16px;font-size:11px;font-weight:700;color:#87898c;text-transform:uppercase;letter-spacing:0.06em">Members — ${members.length}</div>
                    ${members.map(m => `
                        <div class="cm-msg-group" style="margin-top:8px">
                            <div class="cm-msg-group-avatar">
                                <div class="cm-avatar" style="width:36px;height:36px;font-size:13px;background:${avatarColor(m.name)}">${initials(m.name)}</div>
                            </div>
                            <div class="cm-msg-group-body" style="display:flex;align-items:center;justify-content:space-between">
                                <div>
                                    <div style="font-size:14px;font-weight:600;color:#f2f3f5">${escHtml(m.name)}</div>
                                    <div style="font-size:12px;color:#87898c">${escHtml(m.login_id || '')}</div>
                                </div>
                                <button class="cm-icon-btn cm-dm-btn" data-id="${m.id}" data-name="${escHtml(m.name)}" title="Send direct message" style="padding:6px 10px;gap:4px;font-size:12px">
                                    DM
                                </button>
                            </div>
                        </div>`).join('')}
                </div>`;

            // DM individual member
            this.$main.querySelectorAll('.cm-dm-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.recipients = [{ id: btn.dataset.id, name: btn.dataset.name }];
                    this.courses.length || API.getCourses().then(c => { this.courses = c; }).catch(() => {});
                    this.renderComposeForm();
                });
            });

            // Message whole group
            this.$main.querySelector('#cm-msg-group-btn').addEventListener('click', () => {
                this.recipients = others.map(m => ({ id: String(m.id), name: m.name }));
                this.courses.length || API.getCourses().then(c => { this.courses = c; }).catch(() => {});
                this.renderComposeForm();
            });
        } catch (e) {
            this.$main.innerHTML = `<div class="cm-error">${escHtml(e.message)}</div>`;
        }
    }

    // ── Compose ────────────────────────────────────────────────────────────

    async renderCompose() {
        this.$main.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div> Loading courses…</div>';
        try {
            this.courses = await API.getCourses();
        } catch {
            this.courses = [];
        }
        if (!this.recipients) this.recipients = [];
        this.renderComposeForm();
    }

    renderComposeForm() {
        const courseOptions = this.courses.map(c =>
            `<option value="course_${c.id}">${escHtml(c.name)}</option>`
        ).join('');

        const prefilledRecipients = (this.recipients || []).map(r =>
            `<div class="cm-recipient-tag" data-id="${r.id}">${escHtml(r.name)} <button data-id="${r.id}" title="Remove">×</button></div>`
        ).join('');

        this.$main.innerHTML = `
            <div class="cm-compose">
                <div class="cm-compose-header">
                    <button class="cm-icon-btn" id="cm-compose-back" title="Back">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
                    </button>
                    <h2>New Message</h2>
                </div>
                <div class="cm-compose-body">
                    ${this.courses.length ? `
                    <div style="display:flex;gap:8px">
                        <div class="cm-field" style="flex:2">
                            <label>Filter by course <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#87898c">(optional)</span></label>
                            <select id="cm-course-select">
                                <option value="">— Anyone on Canvas —</option>
                                ${courseOptions}
                            </select>
                        </div>
                        <div class="cm-field" style="flex:1">
                            <label>Role</label>
                            <select id="cm-role-filter">
                                <option value="">Any</option>
                                <option value="student">Students</option>
                                <option value="teacher">Instructors</option>
                                <option value="ta">TAs</option>
                            </select>
                        </div>
                    </div>` : ''}
                    <div class="cm-field">
                        <label>To</label>
                        <div class="cm-recipients-box" id="cm-recipients-box">${prefilledRecipients}</div>
                        <div id="cm-search-results" style="display:none" class="cm-search-results"></div>
                    </div>
                    <div class="cm-field">
                        <label>Subject</label>
                        <input type="text" id="cm-subject" placeholder="Message subject…" />
                    </div>
                    <div class="cm-field">
                        <label>Message</label>
                        <textarea id="cm-body" placeholder="Write your message…" rows="5"></textarea>
                    </div>
                </div>
                <div class="cm-compose-footer">
                    <button class="cm-btn-primary" id="cm-send-new-btn">Send Message</button>
                </div>
            </div>`;

        this.$main.querySelector('#cm-compose-back').addEventListener('click', () => {
            this.$main.innerHTML = `
                <div class="cm-placeholder">
                    <div class="cm-placeholder-icon">💬</div>
                    <h2>No conversation selected</h2>
                    <p>Pick a conversation from the left or start a new one.</p>
                </div>`;
        });

        this.setupRecipientInput();

        if (this.composeNotFound) {
            const c = this.composeNotFound;
            this.composeNotFound = null;
            const notice = document.createElement('div');
            notice.className = 'cm-contact-notfound';
            notice.innerHTML = `<strong>${escHtml(c.name)}</strong> isn't in any of your current Canvas courses — Canvas can only find people you share a course with. Try searching by their full name below${c.email ? `, or <a href="mailto:${escHtml(c.email)}">email them directly</a>` : ''}.`;
            const body = this.$main.querySelector('.cm-compose-body');
            body.insertBefore(notice, body.firstChild);
            const input = this.$main.querySelector('.cm-recipient-input');
            if (input) {
                input.value = c.name;
                input.dispatchEvent(new Event('input'));
                input.focus();
            }
        }

        this.$main.querySelector('#cm-send-new-btn').addEventListener('click', () => this.doSendNew());
    }

    setupRecipientInput() {
        const box = this.$main.querySelector('#cm-recipients-box');
        const results = this.$main.querySelector('#cm-search-results');

        // Wire remove buttons for pre-filled recipients
        box.querySelectorAll('.cm-recipient-tag button').forEach(btn => {
            btn.addEventListener('click', () => {
                this.recipients = this.recipients.filter(r => r.id !== btn.dataset.id);
                btn.closest('.cm-recipient-tag').remove();
            });
        });

        const input = document.createElement('input');
        input.className = 'cm-recipient-input';
        input.placeholder = 'Search anyone on Canvas…';
        box.appendChild(input);

        const getContext = () => {
            const sel = this.$main.querySelector('#cm-course-select');
            return sel ? sel.value : '';
        };

        const getRole = () => {
            const sel = this.$main.querySelector('#cm-role-filter');
            return sel ? sel.value : '';
        };

        const renderRecipients = () => {
            box.querySelectorAll('.cm-recipient-tag').forEach(t => t.remove());
            for (const r of this.recipients) {
                const tag = document.createElement('div');
                tag.className = 'cm-recipient-tag';
                tag.innerHTML = `${escHtml(r.name)} <button data-id="${r.id}" title="Remove">×</button>`;
                tag.querySelector('button').addEventListener('click', () => {
                    this.recipients = this.recipients.filter(x => x.id !== r.id);
                    renderRecipients();
                });
                box.insertBefore(tag, input);
            }
        };

        input.addEventListener('input', () => {
            clearTimeout(this.searchDebounce);
            const q = input.value.trim();
            if (q.length < 2) { results.style.display = 'none'; return; }
            this.searchDebounce = setTimeout(async () => {
                try {
                    const ctx = getContext(); // optional course narrowing
                    const data = await API.searchRecipients(q, ctx);
                    const users = Array.isArray(data) ? data : (data.users || []);
                    if (!users.length) { results.style.display = 'none'; return; }
                    results.innerHTML = users.slice(0, 10).map(u => `
                        <div class="cm-search-result" data-id="${u.id}" data-name="${escHtml(u.name || u.full_name)}">
                            <div class="cm-avatar" style="width:28px;height:28px;font-size:11px;background:${avatarColor(u.name || u.full_name)}">${initials(u.name || u.full_name)}</div>
                            <div>
                                <div class="cm-search-result-name">${escHtml(u.name || u.full_name)}</div>
                                <div class="cm-search-result-type">${escHtml(u.common_courses ? 'Student/Instructor' : '')}</div>
                            </div>
                        </div>`).join('');
                    results.style.display = 'block';
                    results.querySelectorAll('.cm-search-result').forEach(el => {
                        el.addEventListener('click', () => {
                            const id = el.dataset.id;
                            const name = el.dataset.name;
                            if (!this.recipients.find(r => r.id === id)) {
                                this.recipients.push({ id, name });
                                renderRecipients();
                            }
                            input.value = '';
                            results.style.display = 'none';
                        });
                    });
                } catch { results.style.display = 'none'; }
            }, 300);
        });

        document.addEventListener('click', e => {
            if (!box.contains(e.target) && !results.contains(e.target)) {
                results.style.display = 'none';
            }
        }, { once: false });

        box.addEventListener('click', () => input.focus());
    }

    async doSendNew() {
        const subject = this.$main.querySelector('#cm-subject').value.trim();
        const body    = this.$main.querySelector('#cm-body').value.trim();
        const btn     = this.$main.querySelector('#cm-send-new-btn');

        if (!this.recipients.length) { alert('Add at least one recipient.'); return; }
        if (!body) { alert('Message body is required.'); return; }

        btn.disabled = true;
        btn.textContent = 'Sending…';
        try {
            await API.newConversation(this.recipients.map(r => r.id), subject || '(no subject)', body);
            await this.loadConversations();
            this.$main.innerHTML = `
                <div class="cm-placeholder">
                    <div class="cm-placeholder-icon">✅</div>
                    <h2>Message sent!</h2>
                    <p>Your message has been sent through Canvas.</p>
                </div>`;
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Send Message';
            this.$main.querySelector('.cm-error')?.remove();
            const err = document.createElement('div');
            err.className = 'cm-error';
            err.textContent = 'Failed to send: ' + e.message;
            this.$main.querySelector('.cm-compose-body').prepend(err);
        }
    }

    // ── Contacts tab ───────────────────────────────────────────────────────

    async loadContacts() {
        this.$convList.innerHTML = '';

        const addBtn = document.createElement('button');
        addBtn.className = 'cm-add-contact-btn';
        addBtn.textContent = '+ Add Contact';
        addBtn.addEventListener('click', () => this.renderContactForm());
        this.$convList.appendChild(addBtn);

        const data = await new Promise(r => chrome.storage.local.get('cmContacts', r));
        const contacts = data.cmContacts || [];

        if (!contacts.length) {
            const empty = document.createElement('div');
            empty.className = 'cm-empty';
            empty.textContent = 'No saved contacts yet';
            this.$convList.appendChild(empty);
            this.$main.innerHTML = `
                <div class="cm-placeholder">
                    <div class="cm-placeholder-icon">👥</div>
                    <h2>Contacts</h2>
                    <p>Save emails for students you no longer share a class with.</p>
                </div>`;
            return;
        }

        for (const contact of contacts) {
            this.$convList.appendChild(this.mkContactItem(contact));
        }
    }

    mkContactItem(contact) {
        const el = document.createElement('div');
        el.className = 'cm-conv-item cm-contact-item';
        el.innerHTML = `
            <div class="cm-contact-avatar-slot"></div>
            <div class="cm-conv-info">
                <div class="cm-conv-top">
                    <span class="cm-conv-name">${escHtml(contact.name)}</span>
                </div>
                ${contact.email ? `<div class="cm-conv-preview">${escHtml(contact.email)}</div>` : ''}
                ${contact.notes ? `<div class="cm-conv-preview cm-contact-notes">${escHtml(contact.notes)}</div>` : ''}
            </div>
            <div class="cm-contact-actions">
                <button class="cm-icon-btn cm-contact-edit-btn" title="Edit">✏</button>
                <button class="cm-icon-btn cm-contact-del-btn" title="Delete">✕</button>
            </div>`;

        el.querySelector('.cm-contact-avatar-slot').replaceWith(mkAvatar(contact.name));

        el.addEventListener('click', e => {
            if (e.target.closest('.cm-contact-actions')) return;
            this.$convList.querySelectorAll('.cm-conv-item').forEach(i => i.classList.remove('active'));
            el.classList.add('active');
            this.renderContactDetail(contact);
        });

        el.querySelector('.cm-contact-edit-btn').addEventListener('click', e => {
            e.stopPropagation();
            this.renderContactForm(contact);
        });

        el.querySelector('.cm-contact-del-btn').addEventListener('click', async e => {
            e.stopPropagation();
            if (!confirm(`Delete contact "${contact.name}"?`)) return;
            await this._deleteContact(contact.id);
            this.loadContacts();
        });

        return el;
    }

    renderContactDetail(contact) {
        this.$main.innerHTML = `
            <div class="cm-main-header">
                <div>
                    <div class="cm-main-title">${escHtml(contact.name)}</div>
                    <div class="cm-main-subtitle">${escHtml(contact.email || 'No email saved')}</div>
                </div>
                <button class="cm-btn-primary cm-contact-dm-btn" style="margin-left:auto;font-size:12px;padding:6px 14px">
                    Message on Canvas
                </button>
            </div>
            <div class="cm-messages" style="padding:24px 16px">
                <div class="cm-contact-detail">
                    ${contact.email ? `
                    <div class="cm-contact-detail-row">
                        <div class="cm-contact-detail-label">Email</div>
                        <div class="cm-contact-detail-value">
                            <a href="mailto:${escHtml(contact.email)}">${escHtml(contact.email)}</a>
                        </div>
                    </div>` : ''}
                    ${contact.notes ? `
                    <div class="cm-contact-detail-row">
                        <div class="cm-contact-detail-label">Notes</div>
                        <div class="cm-contact-detail-value">${escHtml(contact.notes)}</div>
                    </div>` : ''}
                    <div class="cm-contact-detail-row" style="margin-top:8px">
                        <button class="cm-icon-btn cm-contact-edit-detail-btn"
                                style="border:1px solid #404249;padding:5px 12px;border-radius:4px;font-size:12px">
                            Edit Contact
                        </button>
                    </div>
                </div>
            </div>`;

        this.$main.querySelector('.cm-contact-dm-btn').addEventListener('click', () => this.dmContact(contact));
        this.$main.querySelector('.cm-contact-edit-detail-btn').addEventListener('click', () => this.renderContactForm(contact));
    }

    async dmContact(contact) {
        this.$main.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div> Looking up on Canvas…</div>';
        this.recipients = [];

        const trySearch = async (term) => {
            try {
                const res = await API.searchRecipients(term, '');
                const users = Array.isArray(res) ? res : (res.users || []);
                return users;
            } catch { return []; }
        };

        const byEmail = contact.email ? await trySearch(contact.email) : [];
        const found   = byEmail.length ? byEmail : await trySearch(contact.name);

        if (found.length) {
            this.recipients = [{ id: String(found[0].id), name: found[0].name || found[0].full_name }];
            this.composeNotFound = null;
        } else {
            this.composeNotFound = contact;
        }

        this.courses.length || await API.getCourses().then(c => { this.courses = c; }).catch(() => {});
        this.renderComposeForm();
    }

    renderContactForm(contact = null) {
        const isEdit = !!contact;
        this.$main.innerHTML = `
            <div class="cm-compose">
                <div class="cm-compose-header">
                    <button class="cm-icon-btn" id="cm-contact-form-back" title="Back">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M19 12H5m7-7-7 7 7 7"/>
                        </svg>
                    </button>
                    <h2>${isEdit ? 'Edit Contact' : 'Add Contact'}</h2>
                </div>
                <div class="cm-compose-body">
                    <div class="cm-field">
                        <label>Name</label>
                        <input type="text" id="cm-contact-name" placeholder="Full name…" value="${escHtml(contact?.name || '')}" />
                    </div>
                    <div class="cm-field">
                        <label>Email <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#87898c">(optional)</span></label>
                        <input type="email" id="cm-contact-email" placeholder="email@example.com" value="${escHtml(contact?.email || '')}" />
                    </div>
                    <div class="cm-field">
                        <label>Notes <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#87898c">(optional)</span></label>
                        <textarea id="cm-contact-notes" placeholder="Class they were in, major, etc…" rows="3">${escHtml(contact?.notes || '')}</textarea>
                    </div>
                </div>
                <div class="cm-compose-footer">
                    ${isEdit ? `<button class="cm-btn-secondary" id="cm-contact-delete-btn" style="margin-right:auto">Delete</button>` : ''}
                    <button class="cm-btn-primary" id="cm-contact-save-btn">${isEdit ? 'Save Changes' : 'Add Contact'}</button>
                </div>
            </div>`;

        const backToList = () => {
            this.loadContacts();
            this.$main.innerHTML = `
                <div class="cm-placeholder">
                    <div class="cm-placeholder-icon">👥</div>
                    <h2>Contacts</h2>
                    <p>Save emails for students you no longer share a class with.</p>
                </div>`;
        };

        this.$main.querySelector('#cm-contact-form-back').addEventListener('click', backToList);

        this.$main.querySelector('#cm-contact-save-btn').addEventListener('click', async () => {
            const name  = this.$main.querySelector('#cm-contact-name').value.trim();
            const email = this.$main.querySelector('#cm-contact-email').value.trim();
            const notes = this.$main.querySelector('#cm-contact-notes').value.trim();
            if (!name) { alert('Name is required.'); return; }

            const data = await new Promise(r => chrome.storage.local.get('cmContacts', r));
            let contacts = data.cmContacts || [];

            if (isEdit) {
                contacts = contacts.map(c => c.id === contact.id ? { ...c, name, email, notes } : c);
            } else {
                contacts.push({ id: Date.now() + '_' + Math.random().toString(36).slice(2), name, email, notes });
            }

            await new Promise(r => chrome.storage.local.set({ cmContacts: contacts }, r));
            backToList();
        });

        if (isEdit) {
            this.$main.querySelector('#cm-contact-delete-btn').addEventListener('click', async () => {
                if (!confirm(`Delete "${contact.name}"?`)) return;
                await this._deleteContact(contact.id);
                backToList();
            });
        }
    }

    async _deleteContact(id) {
        const data = await new Promise(r => chrome.storage.local.get('cmContacts', r));
        const contacts = (data.cmContacts || []).filter(c => c.id !== id);
        await new Promise(r => chrome.storage.local.set({ cmContacts: contacts }, r));
    }

    // ── Cross-campus relay (Connect tab) ───────────────────────────────────

    async loadRelayTab() {
        this.$convList.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div></div>';
        this._removeRelayListener();

        const profile = await new Promise(r => chrome.runtime.sendMessage({ action: 'relayGetProfile' }, r));
        if (!profile) { this.renderRelaySetup(); return; }

        const threads = await new Promise(r => chrome.runtime.sendMessage({ action: 'relayGetThreads' }, r)) || [];
        this.renderRelayThreadList(threads, profile);

        if (!threads.length) {
            this.$main.innerHTML = `
                <div class="cm-placeholder">
                    <div class="cm-placeholder-icon">🌐</div>
                    <h2>Cross-Campus Connect</h2>
                    <p>Message anyone with Canvas Messenger installed — across any school. End-to-end encrypted.</p>
                    <button class="cm-btn-primary" id="cm-relay-find-btn" style="margin-top:12px">Find or Add Contact</button>
                </div>`;
            this.$main.querySelector('#cm-relay-find-btn').addEventListener('click', () => this.renderRelaySearch(profile));
        }
    }

    renderRelaySetup() {
        this.$convList.innerHTML = '';
        this.$main.innerHTML = `
            <div class="cm-compose">
                <div class="cm-compose-header"><h2>Cross-Campus Connect</h2></div>
                <div class="cm-compose-body">
                    <div class="cm-relay-setup-intro">
                        🔒 Create a free account to message anyone with Canvas Messenger, even across different schools.
                        Messages are <strong>end-to-end encrypted</strong> — only you and your contact can read them.
                    </div>
                    <div class="cm-field">
                        <label>Display Name</label>
                        <input type="text" id="cm-relay-name" placeholder="Your full name…" />
                    </div>
                    <div class="cm-field">
                        <label>School Email <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#87898c">(optional — helps others find you)</span></label>
                        <input type="email" id="cm-relay-email" placeholder="you@school.edu" />
                    </div>
                </div>
                <div class="cm-compose-footer">
                    <button class="cm-btn-primary" id="cm-relay-register-btn">Create Account</button>
                </div>
            </div>`;

        new Promise(r => chrome.runtime.sendMessage({ action: 'getSettings' }, r)).then(s => {
            if (s?.currentUser?.name)     this.$main.querySelector('#cm-relay-name').value = s.currentUser.name;
            if (s?.currentUser?.login_id) this.$main.querySelector('#cm-relay-email').value = s.currentUser.login_id;
        }).catch(() => {});

        this.$main.querySelector('#cm-relay-register-btn').addEventListener('click', async () => {
            const name  = this.$main.querySelector('#cm-relay-name').value.trim();
            const email = this.$main.querySelector('#cm-relay-email').value.trim();
            if (!name) { alert('Name is required.'); return; }
            const btn = this.$main.querySelector('#cm-relay-register-btn');
            btn.disabled = true; btn.textContent = 'Creating account…';
            try {
                await new Promise((resolve, reject) => chrome.runtime.sendMessage(
                    { action: 'relayRegister', name, email }, r => r?.ok ? resolve(r) : reject(new Error(r?.error || 'Failed'))));
                this.loadRelayTab();
            } catch (e) {
                btn.disabled = false; btn.textContent = 'Create Account';
                alert('Registration failed: ' + e.message);
            }
        });
    }

    renderRelayThreadList(threads, profile) {
        this.$convList.innerHTML = '';
        const addBtn = document.createElement('button');
        addBtn.className = 'cm-add-contact-btn';
        addBtn.textContent = '+ Find or Add Contact';
        addBtn.addEventListener('click', () => this.renderRelaySearch(profile));
        this.$convList.appendChild(addBtn);

        const myIdEl = document.createElement('div');
        myIdEl.className = 'cm-relay-myid';
        myIdEl.innerHTML = `<span style="color:#87898c;font-size:10px">Your ID: </span><span class="cm-relay-id-text">${escHtml(profile.id)}</span>`;
        myIdEl.querySelector('.cm-relay-id-text').addEventListener('click', () => {
            navigator.clipboard?.writeText(profile.id).catch(() => {});
        });
        this.$convList.appendChild(myIdEl);

        const sorted = [...threads].sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
        for (const thread of sorted) {
            const el = document.createElement('div');
            el.className = 'cm-conv-item' + (thread.unreadCount ? ' unread' : '');
            el.innerHTML = `
                <div class="cm-relay-av-slot"></div>
                <div class="cm-conv-info">
                    <div class="cm-conv-top">
                        <span class="cm-conv-name">${escHtml(thread.contactName)}</span>
                        <span class="cm-conv-time">${thread.lastAt ? relativeTime(thread.lastAt) : ''}</span>
                    </div>
                    <div class="cm-conv-preview">${escHtml(thread.lastMessage || '')}</div>
                </div>
                ${thread.unreadCount ? '<div class="cm-unread-dot"></div>' : ''}`;
            el.querySelector('.cm-relay-av-slot').replaceWith(mkAvatar(thread.contactName));
            el.addEventListener('click', async () => {
                this.$convList.querySelectorAll('.cm-conv-item').forEach(i => i.classList.remove('active'));
                el.classList.add('active');
                el.classList.remove('unread');
                el.querySelector('.cm-unread-dot')?.remove();
                chrome.runtime.sendMessage({ action: 'relayMarkRead', threadId: thread.id });
                this.openRelayThread(thread, profile);
            });
            this.$convList.appendChild(el);
        }
    }

    async openRelayThread(thread, profile) {
        this.$main.innerHTML = '<div class="cm-loading"><div class="cm-spinner"></div> Loading…</div>';
        this._removeRelayListener();
        try {
            const messages  = await new Promise(r => chrome.runtime.sendMessage({ action: 'relayGetMessages', threadId: thread.id }, r)) || [];
            const contacts  = await new Promise(r => chrome.runtime.sendMessage({ action: 'relayGetContacts' }, r)) || [];
            const contact   = contacts.find(c => c.id === thread.contactId) || { id: thread.contactId, name: thread.contactName };
            this.renderRelayChat(thread, contact, messages, profile);
        } catch (e) {
            this.$main.innerHTML = `<div class="cm-error">${escHtml(e.message)}</div>`;
        }
    }

    renderRelayChat(thread, contact, messages, profile) {
        const renderMsg = m => {
            const isMe = m.fromMe;
            const name = isMe ? (profile.name || 'Me') : contact.name;
            return `<div class="cm-msg-group" data-relay-id="${m.id}">
                <div class="cm-msg-group-avatar">
                    <div class="cm-avatar" style="width:36px;height:36px;font-size:13px;background:${avatarColor(name)}">${initials(name)}</div>
                </div>
                <div class="cm-msg-group-body">
                    <div class="cm-msg-group-header">
                        <span class="cm-msg-author" style="color:${isMe ? '#5865f2' : '#f2f3f5'}">${escHtml(name)}</span>
                        <span class="cm-msg-timestamp">${fullTime(m.sentAt)}</span>
                        <span class="cm-relay-lock" title="End-to-end encrypted">🔒</span>
                    </div>
                    <div class="cm-msg-bubble">${escHtml(m.body)}</div>
                </div>
            </div>`;
        };

        this.$main.innerHTML = `
            <div class="cm-main-header">
                <div>
                    <div class="cm-main-title">${escHtml(contact.name)}</div>
                    <div class="cm-main-subtitle cm-relay-subtitle">🔒 End-to-end encrypted · Cross-campus</div>
                </div>
                <button class="cm-icon-btn cm-relay-invite-header-btn" id="cm-relay-invite-btn" title="Share invite link">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                    </svg>
                </button>
            </div>
            <div class="cm-messages" id="cm-relay-messages">
                ${messages.map(renderMsg).join('') || '<div class="cm-empty">No messages yet — say hello!</div>'}
            </div>
            <div class="cm-input-area">
                <div class="cm-input-box">
                    <textarea id="cm-relay-input" placeholder="Message ${escHtml(contact.name)}… (encrypted)" rows="1"></textarea>
                    <button class="cm-send-btn" id="cm-relay-send">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </button>
                </div>
            </div>`;

        const msgEl   = this.$main.querySelector('#cm-relay-messages');
        const textarea = this.$main.querySelector('#cm-relay-input');
        const sendBtn  = this.$main.querySelector('#cm-relay-send');
        msgEl.scrollTop = msgEl.scrollHeight;

        textarea.addEventListener('input', () => {
            autoResize(textarea);
            sendBtn.classList.toggle('active', textarea.value.trim().length > 0);
        });

        const doSend = async () => {
            const body = textarea.value.trim();
            if (!body) return;
            textarea.value = ''; autoResize(textarea); sendBtn.classList.remove('active');
            const myName = profile.name || 'Me';
            const bubble = document.createElement('div');
            bubble.className = 'cm-msg-group';
            bubble.innerHTML = `
                <div class="cm-msg-group-avatar">
                    <div class="cm-avatar" style="width:36px;height:36px;font-size:13px;background:${avatarColor(myName)}">${initials(myName)}</div>
                </div>
                <div class="cm-msg-group-body">
                    <div class="cm-msg-group-header">
                        <span class="cm-msg-author" style="color:#5865f2">${escHtml(myName)}</span>
                        <span class="cm-msg-timestamp">Just now</span>
                        <span class="cm-relay-lock" title="End-to-end encrypted">🔒</span>
                    </div>
                    <div class="cm-msg-bubble">${escHtml(body)}</div>
                </div>`;
            msgEl.appendChild(bubble); msgEl.scrollTop = msgEl.scrollHeight;
            try {
                await new Promise((resolve, reject) => chrome.runtime.sendMessage(
                    { action: 'relaySendMessage', recipientId: contact.id, body },
                    r => r?.ok ? resolve(r) : reject(new Error(r?.error || 'Send failed'))));
            } catch (e) { bubble.style.opacity = '0.4'; bubble.title = 'Failed: ' + e.message; }
        };
        textarea.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
        sendBtn.addEventListener('click', doSend);

        // Real-time: listen for new relay messages on this thread
        this._relayListener = async (e) => {
            if (e.detail.threadId !== thread.id) return;
            // Reload and append new messages
            const newMsgs = await new Promise(r => chrome.runtime.sendMessage({ action: 'relayGetMessages', threadId: thread.id }, r)) || [];
            for (const m of newMsgs) {
                if (!msgEl.querySelector(`[data-relay-id="${m.id}"]`) && !m.fromMe) {
                    msgEl.insertAdjacentHTML('beforeend', renderMsg(m));
                    msgEl.scrollTop = msgEl.scrollHeight;
                }
            }
        };
        document.addEventListener('cm-relay-msg', this._relayListener);

        // Invite share button
        this.$main.querySelector('#cm-relay-invite-btn').addEventListener('click', async () => {
            try {
                const r = await new Promise(res => chrome.runtime.sendMessage({ action: 'relayCreateInvite' }, res));
                if (r?.url) {
                    await navigator.clipboard?.writeText(r.url).catch(() => {});
                    const btn = this.$main.querySelector('#cm-relay-invite-btn');
                    const orig = btn.innerHTML;
                    btn.innerHTML = '<span style="font-size:11px;font-weight:600;color:#57f287">Copied!</span>';
                    setTimeout(() => { btn.innerHTML = orig; }, 2000);
                }
            } catch {}
        });
    }

    _removeRelayListener() {
        if (this._relayListener) {
            document.removeEventListener('cm-relay-msg', this._relayListener);
            this._relayListener = null;
        }
    }

    async renderRelaySearch(profile) {
        if (!profile) {
            profile = await new Promise(r => chrome.runtime.sendMessage({ action: 'relayGetProfile' }, r));
        }
        if (!profile) { this.renderRelaySetup(); return; }

        this.$main.innerHTML = `
            <div class="cm-compose">
                <div class="cm-compose-header">
                    <button class="cm-icon-btn" id="cm-relay-search-back">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
                    </button>
                    <h2>Find or Add Contact</h2>
                </div>
                <div class="cm-compose-body">
                    <div class="cm-relay-myid-box">
                        <div class="cm-relay-myid-label">Your Connect ID <span style="color:#87898c;font-size:10px">(click to copy)</span></div>
                        <div class="cm-relay-myid-value" id="cm-relay-copy-id">${escHtml(profile.id)}</div>
                    </div>
                    <div class="cm-field">
                        <label>Search by name or school email</label>
                        <input type="text" id="cm-relay-search-q" placeholder="Type at least 2 characters…" autocomplete="off" />
                        <div id="cm-relay-search-results" style="display:none" class="cm-search-results"></div>
                    </div>
                    <div class="cm-field">
                        <label>Or paste an invite link / token</label>
                        <div style="display:flex;gap:8px">
                            <input type="text" id="cm-relay-invite-tok" placeholder="https://relay.hackatoa.com/invite/… or 32-char token"
                                style="flex:1;background:#1e1f22;border:1px solid #1e1f22;border-radius:4px;color:#dcddde;font-size:13px;padding:8px 10px;outline:none;font-family:inherit;transition:border-color .15s" />
                            <button class="cm-btn-primary" id="cm-relay-tok-go" style="padding:8px 14px;font-size:13px">Go</button>
                        </div>
                    </div>
                    <div class="cm-field">
                        <label>Or share your own invite link</label>
                        <button class="cm-btn-primary" id="cm-relay-gen-invite" style="width:100%;background:#404249;font-size:13px">Generate &amp; Copy Invite Link</button>
                    </div>
                </div>
            </div>`;

        this.$main.querySelector('#cm-relay-search-back').addEventListener('click', () => this.loadRelayTab());
        this.$main.querySelector('#cm-relay-copy-id').addEventListener('click', () => {
            navigator.clipboard?.writeText(profile.id).catch(() => {});
        });

        let searchResultsData = {};
        const searchInput   = this.$main.querySelector('#cm-relay-search-q');
        const searchResults = this.$main.querySelector('#cm-relay-search-results');

        let debounce;
        searchInput.addEventListener('input', () => {
            clearTimeout(debounce);
            const q = searchInput.value.trim();
            if (q.length < 2) { searchResults.style.display = 'none'; return; }
            debounce = setTimeout(async () => {
                try {
                    const users = await new Promise(r => chrome.runtime.sendMessage({ action: 'relaySearchUsers', query: q }, r));
                    if (!Array.isArray(users) || !users.length) { searchResults.style.display = 'none'; return; }
                    searchResultsData = {};
                    users.forEach(u => { searchResultsData[u.id] = u; });
                    searchResults.innerHTML = users.map(u => `
                        <div class="cm-search-result cm-relay-result" data-uid="${escHtml(u.id)}">
                            <div class="cm-avatar" style="width:28px;height:28px;font-size:11px;background:${avatarColor(u.name)}">${initials(u.name)}</div>
                            <div style="flex:1;min-width:0">
                                <div class="cm-search-result-name">${escHtml(u.name)}</div>
                                <div class="cm-search-result-type">${escHtml(u.email || '')}</div>
                            </div>
                            <button class="cm-btn-primary cm-relay-add-btn" style="font-size:11px;padding:4px 10px;flex-shrink:0">Add</button>
                        </div>`).join('');
                    searchResults.style.display = 'block';
                    searchResults.querySelectorAll('.cm-relay-add-btn').forEach(btn => {
                        btn.addEventListener('click', async () => {
                            const uid = btn.closest('.cm-relay-result').dataset.uid;
                            const u = searchResultsData[uid];
                            if (!u) return;
                            btn.disabled = true; btn.textContent = 'Adding…';
                            await new Promise(r => chrome.runtime.sendMessage({ action: 'relayAddContact', contact: u }, r));
                            this.loadRelayTab().then(() => {
                                const threadId = [profile.id, u.id].sort().join('_');
                                const thread = { id: threadId, contactId: u.id, contactName: u.name, lastMessage: '', lastAt: new Date().toISOString(), unreadCount: 0 };
                                this.openRelayThread(thread, profile);
                            });
                        });
                    });
                } catch { searchResults.style.display = 'none'; }
            }, 350);
        });

        // Invite token / URL resolution
        this.$main.querySelector('#cm-relay-tok-go').addEventListener('click', async () => {
            let tok = this.$main.querySelector('#cm-relay-invite-tok').value.trim();
            const m = tok.match(/[0-9a-f]{32}/i);
            if (m) tok = m[0];
            if (!tok) return;
            const btn = this.$main.querySelector('#cm-relay-tok-go');
            btn.disabled = true; btn.textContent = 'Looking up…';
            try {
                const u = await new Promise((resolve, reject) => chrome.runtime.sendMessage(
                    { action: 'relayResolveInvite', token: tok }, r => r?.error ? reject(new Error(r.error)) : resolve(r)));
                await new Promise(r => chrome.runtime.sendMessage({ action: 'relayAddContact', contact: u }, r));
                this.loadRelayTab().then(() => {
                    const threadId = [profile.id, u.id].sort().join('_');
                    const thread = { id: threadId, contactId: u.id, contactName: u.name, lastMessage: '', lastAt: new Date().toISOString(), unreadCount: 0 };
                    this.openRelayThread(thread, profile);
                });
            } catch (e) {
                btn.disabled = false; btn.textContent = 'Go';
                alert('Could not resolve invite: ' + e.message);
            }
        });

        // Generate invite
        this.$main.querySelector('#cm-relay-gen-invite').addEventListener('click', async () => {
            const btn = this.$main.querySelector('#cm-relay-gen-invite');
            btn.disabled = true; btn.textContent = 'Generating…';
            try {
                const r = await new Promise(res => chrome.runtime.sendMessage({ action: 'relayCreateInvite' }, res));
                await navigator.clipboard?.writeText(r.url).catch(() => {});
                btn.textContent = '✓ Copied to clipboard!';
                btn.style.background = '#57f287'; btn.style.color = '#111';
                setTimeout(() => { btn.disabled = false; btn.textContent = 'Generate & Copy Invite Link'; btn.style.background = ''; btn.style.color = ''; }, 3000);
            } catch (e) {
                btn.disabled = false; btn.textContent = 'Generate & Copy Invite Link';
                alert('Failed: ' + e.message);
            }
        });
    }
}

// Expose as a window global so content.js can reach it regardless of
// how Firefox wraps the content-script module environment.
window.CanvasMessenger = CanvasMessenger;


