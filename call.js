/* Canvas Messenger — Video Call Window */

const SIGNALING_URL = 'wss://signaling.hackatoa.com';
const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    {
        urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
    },
];

const params       = new URLSearchParams(location.search);
const peerId       = params.get('peerId');
const peerName     = params.get('peerName') || 'Unknown';
const isInitiator  = params.get('initiator') === 'true';

// DOM
const remoteVideo      = document.getElementById('remote-video');
const remotePlaceholder= document.getElementById('remote-placeholder');
const remoteAvatar     = document.getElementById('remote-avatar');
const remoteNameBig    = document.getElementById('remote-name-big');
const localVideo       = document.getElementById('local-video');
const localCamOff      = document.getElementById('local-cam-off');
const callWithEl       = document.getElementById('call-with');
const timerEl          = document.getElementById('call-timer');
const statusEl         = document.getElementById('status-overlay');
const btnMic           = document.getElementById('btn-mic');
const btnCam           = document.getElementById('btn-cam');
const btnScreen        = document.getElementById('btn-screen');
const btnHangup        = document.getElementById('btn-hangup');

// State
let ws, pc, localStream, screenStream;
let userId, userName;
let callEnded = false;
let callStartTime = null;
let timerInterval = null;
let micOn = true, camOn = true;

// Set up peer name in UI
callWithEl.textContent = peerName;
remoteNameBig.textContent = peerName;
remoteAvatar.textContent = peerName.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

async function init() {
    const data = await chrome.storage.local.get(['currentUser']);
    const user = data.currentUser || {};
    userId   = String(user.id || ('guest-' + Date.now()));
    userName = user.name || 'You';

    // Acquire local media
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
        try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
    }
    if (!localStream) localStream = new MediaStream();

    localVideo.srcObject = localStream;
    if (!localStream.getVideoTracks().length) {
        localCamOff.style.display = 'flex';
        btnCam.classList.add('off');
        camOn = false;
    }

    connectSignaling();
}

// ── Signaling ──────────────────────────────────────────────────────────────

function connectSignaling() {
    ws = new WebSocket(SIGNALING_URL);

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'register', userId, name: userName }));
        statusEl.textContent = isInitiator ? 'Calling…' : 'Connecting…';
        if (isInitiator) setTimeout(startCall, 600);
    };

    ws.onmessage = async (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'offer')       await handleOffer(msg.sdp, msg.from);
        if (msg.type === 'answer')      await pc?.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        if (msg.type === 'ice' && msg.candidate) {
            try { await pc?.addIceCandidate(msg.candidate); } catch {}
        }
        if (msg.type === 'call-ended')  hangup(false);
    };

    ws.onclose = () => {
        if (!callEnded) { statusEl.textContent = 'Lost connection…'; setTimeout(connectSignaling, 2000); }
    };
    ws.onerror = () => {};
}

function wsSend(data) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ── WebRTC ─────────────────────────────────────────────────────────────────

function createPC() {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.ontrack = (e) => {
        if (e.streams[0]) {
            remoteVideo.srcObject = e.streams[0];
            remotePlaceholder.style.display = 'none';
            statusEl.style.display = 'none';
            startTimer();
        }
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) wsSend({ type: 'ice', to: peerId, candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') { statusEl.style.display = 'none'; startTimer(); }
        if (s === 'failed')    statusEl.textContent = 'Connection failed — check network';
        if (s === 'disconnected') statusEl.textContent = 'Reconnecting…';
    };
}

async function startCall() {
    createPC();
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    wsSend({ type: 'offer', to: peerId, sdp: pc.localDescription.sdp });
}

async function handleOffer(sdp, from) {
    const target = from || peerId;
    createPC();
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({ type: 'answer', to: target, sdp: pc.localDescription.sdp });
    statusEl.textContent = 'Connecting…';
}

// ── Controls ───────────────────────────────────────────────────────────────

btnMic.addEventListener('click', () => {
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    micOn = !micOn;
    track.enabled = micOn;
    btnMic.classList.toggle('off', !micOn);
    btnMic.title = micOn ? 'Mute' : 'Unmute';
});

btnCam.addEventListener('click', () => {
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    camOn = !camOn;
    track.enabled = camOn;
    btnCam.classList.toggle('off', !camOn);
    localCamOff.style.display = camOn ? 'none' : 'flex';
    btnCam.title = camOn ? 'Camera off' : 'Camera on';
});

btnScreen.addEventListener('click', toggleScreenShare);
btnHangup.addEventListener('click', () => hangup(true));

async function toggleScreenShare() {
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
        // Restore camera track
        const camTrack = localStream.getVideoTracks()[0];
        if (camTrack) {
            const sender = pc?.getSenders().find(s => s.track?.kind === 'video');
            if (sender) await sender.replaceTrack(camTrack);
        }
        localVideo.srcObject = localStream;
        btnScreen.classList.remove('screen-active');
        btnScreen.title = 'Share screen';
    } else {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            const videoTrack = screenStream.getVideoTracks()[0];
            const sender = pc?.getSenders().find(s => s.track?.kind === 'video');
            if (sender) await sender.replaceTrack(videoTrack);
            localVideo.srcObject = screenStream;
            btnScreen.classList.add('screen-active');
            btnScreen.title = 'Stop sharing';
            videoTrack.addEventListener('ended', () => toggleScreenShare());
        } catch {}
    }
}

// ── Timer ──────────────────────────────────────────────────────────────────

function startTimer() {
    if (callStartTime) return;
    callStartTime = Date.now();
    timerInterval = setInterval(() => {
        const s = Math.floor((Date.now() - callStartTime) / 1000);
        timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
}

// ── Hang up ────────────────────────────────────────────────────────────────

function hangup(notify = true) {
    if (callEnded) return;
    callEnded = true;
    if (notify) wsSend({ type: 'call-ended', to: peerId });
    clearInterval(timerInterval);
    localStream?.getTracks().forEach(t => t.stop());
    screenStream?.getTracks().forEach(t => t.stop());
    pc?.close();
    setTimeout(() => window.close(), 400);
}

window.addEventListener('beforeunload', () => hangup(true));

init();
