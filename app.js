'use strict';

const S = {
    peer: null, conn: null,
    roomCode: null, role: null,
    isConnected: false,
    pendingFiles: [],
    recvBuffers: {},
    recvFiles: {},
    recvBatches: {},   // batchId → { ids:[], total, received, bubbleId }
    xfer: { t0: null, bytes: 0 },
    scanActive: false, scanRAF: null, scanInterval: null,
    _senderBlobUrls: [],
    wakeLock: null
};

const CHUNK_SIZE = 64 * 1024; // 64KB

// Wake lock
async function _acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        S.wakeLock = await navigator.wakeLock.request('screen');
    } catch(e) {}
}
function _releaseWakeLock() {
    if (S.wakeLock) { try { S.wakeLock.release(); } catch(e) {} S.wakeLock = null; }
}
// Re-acquire wake lock on visibility change
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.isConnected) _acquireWakeLock();
});

// Beforeunload warning
window.addEventListener('beforeunload', (e) => {
    if (S.isConnected) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Utils
function rndCode() {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
}
function fmtSize(b) {
    if (!b) return '0 B';
    const k = 1024, u = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return (b / Math.pow(k, i)).toFixed(i ? 2 : 0) + ' ' + u[i];
}
function fmtSpd(bps) { return (bps / 1048576).toFixed(1); }
function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2800);
}
function log(msg, type = 'info') {
    const c = document.getElementById('logContainer');
    if (!c) return;
    const d = document.createElement('div');
    d.className = 'log-entry ' + type;
    d.innerHTML = `<span class="log-time">${new Date().toLocaleTimeString()}</span>${msg}`;
    c.appendChild(d);
    c.scrollTop = c.scrollHeight;
}
function showView(n) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view' + n).classList.add('active');
}
function showErr(msg) {
    const b = document.getElementById('errBox');
    b.textContent = '⚠️ ' + msg;
    b.style.display = 'block';
}
function fileEmoji(name) {
    const e = name.split('.').pop().toLowerCase();
    const m = {pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📑',pptx:'📑',jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',webp:'🖼',mp4:'🎬',mkv:'🎬',avi:'🎬',mp3:'🎵',wav:'🎵',flac:'🎵',zip:'📦',rar:'📦','7z':'📦',exe:'⚙️',apk:'📱',txt:'📝',js:'💻',html:'💻',py:'💻',json:'💻'};
    return m[e] || '📄';
}

// Media preview
function mediaType(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','webp','bmp','avif','svg'].includes(ext)) return 'image';
    if (['mp4','webm','ogg','mov'].includes(ext)) return 'video';
    if (['mp3','wav','ogg','flac','aac','m4a','opus'].includes(ext)) return 'audio';
    return null;
}

function _mkMediaPreview(url, name) {
    const type = mediaType(name);
    if (!type) return null;
    const wrap = document.createElement('div');
    wrap.className = 'media-preview-wrap';
    if (type === 'image') {
        const img = document.createElement('img');
        img.src = url;
        img.alt = name;
        img.loading = 'lazy';
        img.title = 'Tap to open full size';
        img.addEventListener('click', () => window.open(url, '_blank'));
        wrap.appendChild(img);
    } else if (type === 'video') {
        const vid = document.createElement('video');
        vid.src = url;
        vid.controls = true;
        vid.playsInline = true;
        vid.preload = 'metadata';
        wrap.appendChild(vid);
    } else {
        const aud = document.createElement('audio');
        aud.src = url;
        aud.controls = true;
        wrap.appendChild(aud);
    }
    return wrap;
}

// Chat helpers
function addBubble(side, contentHtml, id) {
    const msgs = document.getElementById('chatMessages');
    if (!msgs) return null;
    const ts = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg ' + side;
    if (id) wrap.id = 'bubble-' + id;
    wrap.innerHTML = `<div class="bubble ${side}">${contentHtml}</div><div class="bubble-time">${ts}</div>`;
    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'bubble-delete-btn';
    delBtn.title = 'Delete message';
    delBtn.innerHTML = '🗑 Delete';
    delBtn.addEventListener('click', () => {
        wrap.style.animation = 'fadeOut 0.18s ease forwards';
        setTimeout(() => wrap.remove(), 180);
        if (id && S.isConnected && S.conn) {
            S.conn.send({ type: 'bubble-delete', id });
        }
    });
    wrap.appendChild(delBtn);
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
    return wrap;
}

function addSystemMsg(text) {
    const msgs = document.getElementById('chatMessages');
    if (!msgs) return;
    const d = document.createElement('div');
    d.className = 'chat-system-msg';
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
}

function textBubbleHtml(text) {
    return esc(text).replace(/\n/g, '<br>');
}

function fileBubbleHtml(name, size, bubbleId) {
    return `
        <div class="file-bubble">
            <div class="file-bubble-inner">
                <div class="file-bubble-icon">${fileEmoji(name)}</div>
                <div class="file-bubble-info">
                    <div class="file-bubble-name">${esc(name)}</div>
                    <div class="file-bubble-size">${fmtSize(size)}</div>
                </div>
            </div>
            <div class="progress-wrap" id="sp-${bubbleId}">
                <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
                <div class="progress-text" style="font-size:0.73rem;color:rgba(255,255,255,0.45);margin-top:3px;text-align:right;">Sending...</div>
            </div>
            <div id="mp-${bubbleId}"></div>
        </div>`;
}

function recvFileBubbleHtml(id, name, size) {
    return `
        <div class="file-bubble">
            <div class="file-bubble-inner">
                <div class="file-bubble-icon">${fileEmoji(name)}</div>
                <div class="file-bubble-info">
                    <div class="file-bubble-name">${esc(name)}</div>
                    <div class="file-bubble-size">${fmtSize(size)}</div>
                </div>
            </div>
            <div class="progress-wrap" id="rp-${id}">
                <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
                <div class="progress-text" style="font-size:0.73rem;color:rgba(255,255,255,0.45);margin-top:3px;text-align:right;">Receiving...</div>
            </div>
            <div id="recv-actions-${id}" class="file-bubble-actions">
                <span style="color:rgba(255,255,255,0.3);font-size:0.78rem;">⏳ Waiting...</span>
            </div>
            <div id="mp-${id}"></div>
        </div>`;
}

// Chat input helpers
function chatKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
}

function autoResizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function clearAttachment() {
    S.pendingFiles = [];
    const prev = document.getElementById('attachPreview');
    if (prev) prev.style.display = 'none';
    const fi = document.getElementById('fileInput');
    if (fi) fi.value = '';
}

// Send chat message
async function sendChatMessage() {
    if (!S.isConnected || !S.conn) { toast('⚠️ Not connected'); return; }
    const textEl = document.getElementById('chatTextInput');
    const text = textEl ? textEl.value.trim() : '';
    const files = S.pendingFiles.slice();

    if (!text && !files.length) return;

    if (textEl) { textEl.value = ''; autoResizeTextarea(textEl); }
    clearAttachment();

    if (files.length > 1) {
        const batchId = Math.random().toString(36).substr(2, 9);
        S.conn.send({ type: 'batch-start', batchId, total: files.length,
            names: files.map(f => f.name), sizes: files.map(f => f.size) });
        _addSenderBatchBubble(batchId, files);
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const bubbleId = batchId + '_' + i;
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            S.conn.send({ type: 'file-meta', id: bubbleId, name: file.name, size: file.size, totalChunks, batchId, batchIndex: i });
            await _doSendChunks(file, bubbleId, batchId, i, files.length);
            S.conn.send({ type: 'file-end', id: bubbleId });
            _updateSenderBatchProgress(batchId, i + 1, files.length);
        }
        S.conn.send({ type: 'batch-end', batchId });
        _finalizeSenderBatchBubble(batchId, files);
        log(`✅ Batch sent: ${files.length} files`, 'success');
    } else if (files.length === 1) {
        const file = files[0];
        const bubbleId = Math.random().toString(36).substr(2, 9);
        addBubble('mine', fileBubbleHtml(file.name, file.size, bubbleId), bubbleId);
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        S.conn.send({ type: 'file-meta', id: bubbleId, name: file.name, size: file.size, totalChunks });
        await _doSendChunks(file, bubbleId);
        S.conn.send({ type: 'file-end', id: bubbleId });
        _setSendProgress(bubbleId, 100, 'Sent ✓');
        setTimeout(() => {
            const spEl = document.getElementById('sp-' + bubbleId);
            if (spEl) spEl.style.display = 'none';
        }, 1200);
        const mpSend = document.getElementById('mp-' + bubbleId);
        if (mpSend) {
            const prevUrl = URL.createObjectURL(file);
            const prev = _mkMediaPreview(prevUrl, file.name);
            if (prev) {
                mpSend.appendChild(prev);
                S._senderBlobUrls = S._senderBlobUrls || [];
                S._senderBlobUrls.push(prevUrl);
            }
        }
        log(`✅ Sent: ${esc(file.name)}`, 'success');
    }

    // Send text message
    if (text) {
        const msgId = Math.random().toString(36).substr(2, 9);
        S.conn.send({ type: 'chat-message', msgId, text, ts: Date.now() });
        addBubble('mine', textBubbleHtml(text), msgId);
    }
}

// Sender batch bubble
function _addSenderBatchBubble(batchId, files) {
    const totalSize = files.reduce((a, f) => a + f.size, 0);
    const html = `
        <div class="batch-bubble" id="sbatch-${batchId}">
            <div class="batch-header">
                <div class="batch-icon">📦</div>
                <div>
                    <div class="batch-title">${files.length} files</div>
                    <div class="batch-subtitle">${fmtSize(totalSize)} total</div>
                </div>
            </div>
            <div class="batch-file-list">
                ${files.map((f, i) => `
                <div class="batch-file-row" id="sbrow-${batchId}_${i}">
                    <span style="font-size:1rem;">${fileEmoji(f.name)}</span>
                    <span class="batch-file-name">${esc(f.name)}</span>
                    <span class="batch-file-sz">${fmtSize(f.size)}</span>
                    <span id="sbstat-${batchId}_${i}" style="font-size:0.72rem;color:rgba(255,255,255,0.3);">⏳</span>
                </div>`).join('')}
            </div>
            <div class="progress-wrap batch-progress" id="sbprog-${batchId}">
                <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
                <div class="progress-text">Sending 1/${files.length}...</div>
            </div>
        </div>`;
    addBubble('mine', html, 'sbatch-wrap-' + batchId);
}

function _updateSenderBatchProgress(batchId, done, total) {
    const prog = document.getElementById('sbprog-' + batchId);
    if (prog) {
        const pct = Math.round((done / total) * 100);
        prog.querySelector('.progress-fill').style.width = pct + '%';
        prog.querySelector('.progress-text').textContent = done < total ? `Sending ${done+1}/${total}...` : 'Sent ✓';
    }
    const prev = document.getElementById('sbstat-' + batchId + '_' + (done - 1));
    if (prev) prev.textContent = '✓';
}

function _finalizeSenderBatchBubble(batchId, files) {
    const prog = document.getElementById('sbprog-' + batchId);
    if (prog) setTimeout(() => { prog.style.display = 'none'; }, 1200);
    files.forEach((_, i) => {
        const stat = document.getElementById('sbstat-' + batchId + '_' + i);
        if (stat) stat.textContent = '✓';
    });
}

// Home tabs
function switchHomeTab(tab) {
    document.getElementById('tabCode').classList.toggle('active', tab === 'code');
    document.getElementById('tabScan').classList.toggle('active', tab === 'scan');
    document.getElementById('panelCode').classList.toggle('active', tab === 'code');
    document.getElementById('panelScan').classList.toggle('active', tab === 'scan');
    if (tab !== 'scan') stopQRScan();
}

// QR scanner

// Detect iOS and configure the QR panel accordingly
window.addEventListener('load', () => {
    const isIOS = isIOSDevice();
    const isIOSChrome = isIOSChromeBrowser();
    if (isIOS || isIOSChrome) {
        // iOS: skip live stream, go straight to camera button
        document.getElementById('iosQrPanel').style.display = 'block';
        document.getElementById('desktopQrPanel').style.display = 'none';
    }
});
async function startQRScan() {
    const video = document.getElementById('qrVideo');
    const btn = document.getElementById('startScanBtn');
    const stopBtn = document.getElementById('stopScanBtn');
    const statusEl = document.getElementById('scanStatusDesktop');
    const isIOSChrome = isIOSChromeBrowser();
    if (stopBtn) { btn.style.display = 'none'; stopBtn.style.display = 'block'; }

    // iOS Chrome/WKWebView can't read the camera canvas reliably, use photo mode instead
    if (isIOSChrome) {
        document.getElementById('iosQrPanel').style.display = 'block';
        document.getElementById('desktopQrPanel').style.display = 'none';
        return;
    }

    btn.style.display = 'none';
    statusEl.textContent = '⏳ Starting camera...';

    try {
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
            });
        } catch(e) {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        }

        video.srcObject = stream;
        video.setAttribute('playsinline', '');
        video.muted = true;

        await new Promise(resolve => {
            video.onloadedmetadata = resolve;
            setTimeout(resolve, 3000);
        });
        try { await video.play(); } catch(playErr) { /* autoplay policy — stream still active */ }

        S.scanActive = true;

        setTimeout(() => {
            if (S.scanActive) {
                const gal = document.getElementById('qrGalleryInput');
                if (gal && gal.closest) { const wrap = gal.closest('div'); if (wrap) wrap.style.display = 'block'; }
            }
        }, 5000);

        if ('BarcodeDetector' in window) {
            statusEl.textContent = '🔍 Scanning with native detector...';
            _scanWithBarcodeDetector(video, statusEl);
        } else {
            statusEl.textContent = '🔍 Scanning... (hold QR steady)';
            _scanWithJsQR(video, statusEl);
        }

    } catch(e) {
        statusEl.textContent = '⚠️ ' + e.message;
        btn.style.display = '';
    }
}

// Native BarcodeDetector - OS-level QR engine (Android)
async function _scanWithBarcodeDetector(video, statusEl) {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    S.scanInterval = setInterval(async () => {
        if (!S.scanActive) { clearInterval(S.scanInterval); return; }
        if (!video.videoWidth) return;
        try {
            const codes = await detector.detect(video);
            if (codes.length > 0 && codes[0].rawValue) {
                clearInterval(S.scanInterval);
                stopQRScan();
                statusEl.textContent = '✅ QR detected!';
                parseQR(codes[0].rawValue);
            }
        } catch(e) {}
    }, 200);
}

// jsQR fallback
function _scanWithJsQR(video, statusEl) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
    document.body.appendChild(canvas);
    S._jsqrCanvas = canvas;

    let tick = 0;
    S.scanInterval = setInterval(() => {
        if (!S.scanActive) { clearInterval(S.scanInterval); return; }
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return;

        tick++;
        const dots = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'][tick % 10];
        statusEl.textContent = `${dots} Scanning... (${w}×${h})`;

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, w, h);

        const imageData = ctx.getImageData(0, 0, w, h);
        const code = jsQR(imageData.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (code && code.data) {
            clearInterval(S.scanInterval);
            stopQRScan();
            statusEl.textContent = '✅ QR detected!';
            parseQR(code.data);
        }
    }, 100);
}

function stopQRScan() {
    S.scanActive = false;
    if (S.scanInterval) { clearInterval(S.scanInterval); S.scanInterval = null; }
    if (S.scanRAF) { cancelAnimationFrame(S.scanRAF); S.scanRAF = null; }
    if (S._jsqrCanvas) { S._jsqrCanvas.remove(); S._jsqrCanvas = null; }
    const video = document.getElementById('qrVideo');
    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }
    const btn = document.getElementById('startScanBtn');
    const stopBtn = document.getElementById('stopScanBtn');
    if (btn) btn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
}

// Photo-based QR scan fallback (works everywhere, incl. iOS Safari)
// Read EXIF orientation
function _getExifOrientation(file, callback) {
    const reader = new FileReader();
    reader.onload = e => {
        const view = new DataView(e.target.result);
        if (view.getUint16(0, false) !== 0xFFD8) { callback(-1); return; }
        let offset = 2;
        while (offset < view.byteLength) {
            const marker = view.getUint16(offset, false); offset += 2;
            if (marker === 0xFFE1) {
                offset += 2;
                if (view.getUint32(offset, false) !== 0x45786966) { callback(-1); return; }
                const little = view.getUint16(offset += 6, false) === 0x4949;
                offset += view.getUint32(offset + 4, little);
                const tags = view.getUint16(offset, little);
                offset += 2;
                for (let i = 0; i < tags; i++) {
                    if (view.getUint16(offset + i*12, little) === 0x0112) {
                        callback(view.getUint16(offset + i*12 + 8, little)); return;
                    }
                }
            } else if ((marker & 0xFF00) !== 0xFF00) break;
            else offset += view.getUint16(offset, false);
        }
        callback(-1);
    };
    reader.readAsArrayBuffer(file.slice(0, 64 * 1024));
}

// Draw to canvas, correcting for EXIF orientation
function _drawRotated(ctx, img, orientation, w, h) {
    ctx.save();
    switch (orientation) {
        case 3: ctx.translate(w, h); ctx.rotate(Math.PI); break;
        case 6: ctx.translate(w, 0); ctx.rotate(Math.PI / 2); break;
        case 8: ctx.translate(0, h); ctx.rotate(-Math.PI / 2); break;
        default: break;
    }
    if (orientation === 6 || orientation === 8) {
        ctx.drawImage(img, 0, 0, h, w);
    } else {
        ctx.drawImage(img, 0, 0, w, h);
    }
    ctx.restore();
}

function _jsqrScan(img, orientation) {
    const origW = img.width, origH = img.height;
    const isRotated = orientation === 6 || orientation === 8;
    const W = isRotated ? origH : origW;
    const H = isRotated ? origW : origH;

    function tryDraw(sx, sy, sw, sh, outW, outH) {
        const c = document.createElement('canvas');
        c.width = outW; c.height = outH;
        const cx = c.getContext('2d', { willReadFrequently: true });
        if (sx === 0 && sy === 0 && sw === origW && sh === origH) {
            c.width = W; c.height = H;
            _drawRotated(cx, img, orientation, W, H);
        } else {
            cx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
        }
        const d = cx.getImageData(0, 0, c.width, c.height);
        return jsQR(d.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
    }

    for (const scale of [1, 0.5, 0.25, 0.75]) {
        const w = Math.round(W * scale), h = Math.round(H * scale);
        if (w < 100) continue;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cx = c.getContext('2d', { willReadFrequently: true });
        _drawRotated(cx, img, orientation, w, h);
        const r = jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
        if (r && r.data) return r.data;
    }

    for (const [sx, sy] of [[0,0],[origW/2,0],[0,origH/2],[origW/2,origH/2]]) {
        const r = tryDraw(sx, sy, origW/2, origH/2, 600, 600);
        if (r && r.data) return r.data;
    }

    const r = tryDraw(origW*0.2, origH*0.2, origW*0.6, origH*0.6, 600, 600);
    if (r && r.data) return r.data;

    return null;
}

function scanQRFromPhoto(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const statusEl = document.getElementById('scanStatus') || document.getElementById('scanStatusDesktop');
    if (statusEl) statusEl.textContent = '⏳ Scanning...';
    input.value = '';

    _getExifOrientation(file, orientation => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const result = _jsqrScan(img, orientation);
            if (result) {
                if (statusEl) statusEl.textContent = '✅ QR detected!';
                parseQR(result);
            } else {
                if (statusEl) statusEl.textContent = '❌ Not found. Hold steady, good light, QR fills frame.';
            }
        };
        img.onerror = () => { URL.revokeObjectURL(url); if (statusEl) statusEl.textContent = '❌ Could not load image.'; };
        img.src = url;
    });
}

function parseQR(data) {
    const statusEl = document.getElementById('scanStatus') || document.getElementById('scanStatusDesktop');
    try {
        let code = null;
        let rawUrl = null;

        if (data.includes('room=')) {
            try {
                rawUrl = data;
                code = new URL(data).searchParams.get('room');
            } catch(e) {}
        }
        if (!code) {
            const match = data.trim().toUpperCase().match(/[A-Z0-9]{5}/);
            if (match) code = match[0];
        }

        if (code && code.length === 5 && /^[A-Z0-9]{5}$/.test(code)) {
            // Fill the input but don't auto-join yet
            document.getElementById('joinCode').value = code.toUpperCase();

            const isIOS = isIOSDevice() || isIOSChromeBrowser();

            if (isIOS) {
                // iOS camera redirects via link, so just show the instruction note
            } else {
                // Android/Desktop: stop camera, show result card
                stopQRScan();
                const scannerWrap = document.querySelector('#desktopQrPanel .scanner-wrap');
                if (scannerWrap) scannerWrap.style.display = 'none';
                const statusDesktop = document.getElementById('scanStatusDesktop');
                if (statusDesktop) statusDesktop.style.display = 'none';
                const card = document.getElementById('qrResultCardDesktop');
                document.getElementById('qrResultCodeDesktop').textContent = code.toUpperCase();
                document.getElementById('qrResultLinkDesktop').textContent = rawUrl || '';
                card.style.display = 'block';
                const btn = document.getElementById('startScanBtn');
                if (btn) btn.style.display = 'none';
            }

            if (statusEl) statusEl.textContent = '✅ QR detected! Press Join to connect.';

        } else {
            if (statusEl) statusEl.textContent = '❌ Invalid QR. Try again.';
            const isIOS = isIOSDevice();
            if (!isIOS) setTimeout(startQRScan, 1500);
        }
    } catch(e) {
        if (statusEl) statusEl.textContent = '❌ Could not read QR. Try manual entry.';
    }
}

// "Join Room" on result card
function confirmQRJoin() {
    joinRoom();
}

// "Scan Again" — back to scan UI
function resetQRScan() {
    const cardD = document.getElementById('qrResultCardDesktop');
    if (cardD) cardD.style.display = 'none';
    const scannerWrap = document.querySelector('#desktopQrPanel .scanner-wrap');
    if (scannerWrap) scannerWrap.style.display = '';
    const statusD = document.getElementById('scanStatusDesktop');
    if (statusD) { statusD.style.display = ''; statusD.textContent = '—'; }
    const startBtn = document.getElementById('startScanBtn');
    if (startBtn) startBtn.style.display = '';

    document.getElementById('joinCode').value = '';
}

// QR modal
function showQR() {
    const url = buildUrl();
    document.getElementById('qrRoom').textContent = S.roomCode;
    document.getElementById('qrcode').innerHTML = '';
    new QRCode(document.getElementById('qrcode'), { text: url, width: 200, height: 200, colorDark:'#000', colorLight:'#fff', correctLevel: QRCode.CorrectLevel.M });
    document.getElementById('qrModal').classList.add('active');
}
function closeQR() { document.getElementById('qrModal').classList.remove('active'); }
function buildUrl() { return `${location.origin}${location.pathname}?room=${S.roomCode}`; }

// iOS detection helper
// iPadOS 13+ reports as Desktop Safari, no "iPad" in UA — check maxTouchPoints instead
function isIOSDevice() {
    return (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) &&
        !window.MSStream;
}
function isIOSChromeBrowser() {
    return /CriOS/.test(navigator.userAgent);
}

// Clipboard utility
// clipboard.writeText needs HTTPS + user gesture; fallback covers HTTP/WebViews
function copyToClipboard(text) {
    // iOS Chrome (CriOS): clipboard API and execCommand both fail in WKWebView, show a visible input instead
    const isIOSChrome = isIOSChromeBrowser();
    if (isIOSChrome) {
        _showCopyModal(text);
        return Promise.resolve();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(() => _clipboardFallback(text));
    }
    _clipboardFallback(text);
    return Promise.resolve();
}
function _showCopyModal(text) {
    const modal = document.getElementById('copyModal');
    const inp = document.getElementById('copyModalInput');
    if (!modal || !inp) return;
    inp.value = text;
    modal.classList.add('active');
    setTimeout(() => {
        inp.focus();
        inp.setSelectionRange(0, text.length);
    }, 100);
}
function _clipboardFallback(text) {
    const isIOS = isIOSDevice();
    const ta = document.createElement('textarea');
    ta.value = text;
    if (isIOS) {
        ta.style.cssText = 'position:fixed;top:0;left:0;width:2em;height:2em;padding:0;border:none;outline:none;box-shadow:none;background:transparent;font-size:16px;opacity:0;pointer-events:none;';
        ta.contentEditable = 'true';
        ta.readOnly = false;
        document.body.appendChild(ta);
        const range = document.createRange();
        range.selectNodeContents(ta);
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        ta.setSelectionRange(0, 99999);
    } else {
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;font-size:16px;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
    }
    try { document.execCommand('copy'); } catch(e) { /* best-effort */ }
    document.body.removeChild(ta);
}

// Copy / share
function copyRoomCode() {
    copyToClipboard(S.roomCode);
    toast('📋 Code copied: ' + S.roomCode);
}
function copyRoomLink() {
    copyToClipboard(buildUrl());
    toast('🔗 Link copied!');
}

// PeerJS
// Host peer ID is deterministic ("yunze-XXXXX"), guest gets a random one

function peerIdOf(code) { return 'yunze-' + code.toLowerCase(); }

function createRoom() {
    S.role = 'host';
    S.roomCode = rndCode();
    _showConnect('Creating Room...', S.roomCode, 'Connecting to PeerJS server...');

    S.peer = new Peer(peerIdOf(S.roomCode), { debug: 0 });

    // 20s connect timeout
    const connectTimeout = setTimeout(() => {
        if (!S.isConnected && S.peer && !S.peer.open) {
            showErr('PeerJS server unreachable. Check your internet connection.');
            document.getElementById('connectScreen').querySelector('h3').textContent = 'Connection Timed Out';
        }
    }, 20000);

    S.peer.on('open', () => {
        clearTimeout(connectTimeout);
        document.getElementById('connectScreen').style.display = 'none';
        document.getElementById('hostShareArea').style.display = 'block';
        document.getElementById('hostRoomCode').textContent = S.roomCode;
    });

    S.peer.on('connection', (conn) => {
        // Accept the incoming connection in binary mode
        // Serialization mode is set by the guest; replace any existing connection
        if (S.conn && S.conn.open) {
            try { S.conn.close(); } catch(e) {}
        }
        S.conn = conn;
        _wireConn(conn);
    });

    S.peer.on('error', (err) => {
        clearTimeout(connectTimeout);
        if (err.type === 'unavailable-id') {
            S.peer.destroy();
            createRoom();
        } else {
            showErr('PeerJS error: ' + err.message);
            document.getElementById('connectScreen').querySelector('h3').textContent = 'Connection Failed';
        }
    });
}

function joinRoom() {
    stopQRScan();
    let code = document.getElementById('joinCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (code.length < 5) { toast('⚠️ Enter a 5-character room code'); return; }

    S.role = 'guest';
    S.roomCode = code;
    _showConnect('Connecting...', code, 'Establishing connection with host...');

    S.peer = new Peer({ debug: 0 });

    // 20s connect timeout
    const connectTimeout = setTimeout(() => {
        if (!S.isConnected) {
            showErr('Connection timed out. Make sure the host is on the waiting screen and try again.');
            document.getElementById('connectScreen').querySelector('h3').textContent = 'Connection Timed Out';
        }
    }, 20000);

    S.peer.on('open', () => {
        const conn = S.peer.connect(peerIdOf(S.roomCode), { reliable: true, serialization: 'binary' });
        S.conn = conn;
        _wireConn(conn, connectTimeout);
    });

    S.peer.on('error', (err) => {
        clearTimeout(connectTimeout);
        if (err.type === 'peer-unavailable') {
            showErr('Room not found! Check the code, or wait for host to open the room.');
            document.getElementById('connectScreen').querySelector('h3').textContent = 'Room Not Found';
            document.getElementById('connectDesc').textContent = 'Make sure the host is on the waiting screen, then try again.';
        } else {
            showErr('PeerJS error: ' + err.message);
        }
    });
}

function _showConnect(title, code, desc) {
    showView('Connect');
    document.getElementById('connectTitle').textContent = title;
    document.getElementById('connectCode').textContent = code;
    document.getElementById('connectDesc').textContent = desc;
    document.getElementById('connectScreen').style.display = 'block';
    document.getElementById('hostShareArea').style.display = 'none';
    document.getElementById('errBox').style.display = 'none';
}

function _wireConn(conn, connectTimeout) {
    conn.on('open', () => {
        if (connectTimeout) clearTimeout(connectTimeout);
        S.isConnected = true;
        closeQR();
        showView('Transfer');
        document.getElementById('roomDisplay').textContent = S.roomCode;
        const tipsBanner = document.getElementById('transferTipsBanner');
        if (tipsBanner) tipsBanner.style.display = 'flex';
        _acquireWakeLock();
        addSystemMsg('🔒 Secure P2P connection established · ' + (S.role === 'host' ? 'You are the host' : 'You joined as guest'));
        log('🔒 Secure P2P connection established! (' + (S.role === 'host' ? 'Host' : 'Guest') + ')', 'success');
    });
    conn.on('data', handleData);
    conn.on('close', () => {
        S.isConnected = false;
        S.conn = null;
        _releaseWakeLock();
        const partialBatches = Object.values(S.recvBatches).filter(b => b.received < b.total);
        const partialSingle = Object.values(S.recvBuffers).length > 0;
        if (partialBatches.length > 0 || partialSingle) {
            addSystemMsg('⚠️ Connection lost — some files may be incomplete. Already completed files are still available.');
        } else {
            addSystemMsg('⚠️ Connection closed');
        }
        log('Connection closed.', 'warning');
        const dot = document.getElementById('statusDot');
        if (dot) { dot.className = 'status-dot'; document.getElementById('statusText').textContent = 'Connection lost'; }
        const badge = document.getElementById('chatSpeedBadge');
        if (badge) badge.style.display = 'none';
        // Show "Start New Session" button in chat
        const msgs = document.getElementById('chatMessages');
        if (msgs) {
            const btnWrap = document.createElement('div');
            btnWrap.style.cssText = 'text-align:center;margin:10px 0;';
            btnWrap.innerHTML = `<button onclick="resetApp()" style="background:rgba(0,210,255,0.12);border:1px solid rgba(0,210,255,0.3);color:var(--primary);border-radius:12px;padding:10px 22px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:all 0.2s;" onmouseover="this.style.background='rgba(0,210,255,0.22)'" onmouseout="this.style.background='rgba(0,210,255,0.12)'">🔄 Start New Session</button>`;
            msgs.appendChild(btnWrap);
            msgs.scrollTop = msgs.scrollHeight;
        }
    });
    conn.on('error', (err) => log('Connection error: ' + err.message, 'error'));
}

// Cloud share
let _csFile = null;
let _csLink = null;
let _csService = 'gofile';

const TG_BOT_TOKEN = '8674648038:AAFdVxqDlz7eSYVah9mcKNsncp8R9fNdkfA';
const TG_CHAT_ID = '-1004364593569';
const TG_MAX_SIZE = 50 * 1024 * 1024; // Telegram Bot API hard limit

function switchCloudTab(tab) {
    document.getElementById('csTabUpload').classList.toggle('active', tab === 'upload');
    document.getElementById('csTabDownload').classList.toggle('active', tab === 'download');
    document.getElementById('csPanelUpload').style.display = tab === 'upload' ? 'block' : 'none';
    document.getElementById('csPanelDownload').style.display = tab === 'download' ? 'block' : 'none';
}

function switchCsService(service) {
    _csService = service;
    const gofileBtn = document.getElementById('csSvcGofile');
    const tgBtn = document.getElementById('csSvcTelegram');
    const hint = document.getElementById('csDropHint');
    const uploadBtn = document.getElementById('csUploadBtn');

    const activeStyle = { border: 'rgba(150,100,255,0.5)', bg: 'rgba(150,100,255,0.22)', color: 'rgba(200,170,255,0.95)' };
    const inactiveStyle = { border: 'rgba(255,255,255,0.12)', bg: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.5)' };

    const gStyle = service === 'gofile' ? activeStyle : inactiveStyle;
    const tStyle = service === 'telegram' ? activeStyle : inactiveStyle;
    gofileBtn.style.borderColor = gStyle.border; gofileBtn.style.background = gStyle.bg; gofileBtn.style.color = gStyle.color;
    tgBtn.style.borderColor = tStyle.border; tgBtn.style.background = tStyle.bg; tgBtn.style.color = tStyle.color;

    if (hint) {
        hint.textContent = service === 'telegram'
            ? 'Any file type · Max 50MB · Uploaded to Telegram'
            : 'Any file type · Uploaded to gofile.io';
    }
    if (uploadBtn && !uploadBtn.disabled) {
        uploadBtn.textContent = service === 'telegram' ? '📨 Upload & Get Link' : '☁️ Upload & Get Link';
    }
    document.getElementById('csLinkResult').style.display = 'none';
}

async function uploadToTelegram(blob, filename) {
    if (blob.size > TG_MAX_SIZE) {
        throw new Error("File exceeds Telegram's 50MB limit. Use gofile.io instead.");
    }
    const fd = new FormData();
    fd.append('chat_id', TG_CHAT_ID);
    fd.append('document', blob, filename);
    const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) throw new Error(j.description || 'Telegram upload failed');
    const fileId = j.result.document.file_id;
    const fRes = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fJson = await fRes.json();
    if (!fJson.ok) throw new Error(fJson.description || 'Could not resolve file path');
    return `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${fJson.result.file_path}`;
}

function csHandleFile(file) {
    if (!file) return;
    _csFile = file;
    const info = document.getElementById('csFileInfo');
    info.style.display = 'flex';
    document.getElementById('csFileEmoji').textContent = fileEmoji(file.name);
    document.getElementById('csFileName').textContent = file.name;
    document.getElementById('csFileSize').textContent = fmtSize(file.size);
    const btn = document.getElementById('csUploadBtn');
    btn.disabled = false;
    btn.style.color = 'rgba(200,170,255,0.95)';
    btn.style.cursor = 'pointer';
    document.getElementById('csLinkResult').style.display = 'none';
}

function csClearFile() {
    _csFile = null;
    document.getElementById('csFileInfo').style.display = 'none';
    document.getElementById('csFileInput').value = '';
    document.getElementById('csLinkResult').style.display = 'none';
    const btn = document.getElementById('csUploadBtn');
    btn.disabled = true;
    btn.style.color = 'rgba(200,170,255,0.6)';
    btn.style.cursor = 'not-allowed';
}

async function csUpload() {
    if (!_csFile) return;
    const btn = document.getElementById('csUploadBtn');
    const progress = document.getElementById('csUploadProgress');
    const progressBar = document.getElementById('csProgressBar');
    const progressText = document.getElementById('csProgressText');
    btn.disabled = true;
    btn.textContent = '⏳ Uploading...';
    progress.style.display = 'block';
    progressBar.style.width = '10%';

    try {
        let link, ttlText;
        if (_csService === 'telegram') {
            progressText.textContent = 'Sending to Telegram...';
            progressBar.style.width = '35%';
            link = await uploadToTelegram(_csFile, _csFile.name);
            ttlText = '📨 Stored on Telegram · permanent unless removed from the channel';
        } else {
            progressText.textContent = 'Connecting to gofile.io...';
            const srvRes = await fetch('https://api.gofile.io/servers');
            const srvData = await srvRes.json();
            const server = srvData.data.servers[0].name;
            progressBar.style.width = '30%';
            progressText.textContent = 'Uploading...';
            const fd = new FormData();
            fd.append('file', _csFile);
            const r = await fetch(`https://${server}.gofile.io/uploadFile`, { method: 'POST', body: fd });
            const d = await r.json();
            if (d.status !== 'ok') throw new Error('Upload failed');
            link = d.data.downloadPage;
            ttlText = '⏳ Link valid for ~10 days of inactivity (gofile.io)';
        }
        progressBar.style.width = '100%';
        progressText.textContent = 'Done!';
        _csLink = link;
        const result = document.getElementById('csLinkResult');
        result.style.display = 'block';
        const linkEl = document.getElementById('csResultLink');
        linkEl.href = _csLink;
        linkEl.textContent = _csLink;
        document.getElementById('csLinkTtl').textContent = ttlText;
        btn.textContent = '✅ Uploaded';
        setTimeout(() => { progress.style.display = 'none'; }, 1500);
    } catch(e) {
        progressText.textContent = '❌ Upload failed: ' + e.message;
        btn.disabled = false;
        btn.textContent = _csService === 'telegram' ? '📨 Upload & Get Link' : '☁️ Upload & Get Link';
    }
}

function csCopyLink() {
    if (!_csLink) return;
    const btn = document.getElementById('csCopyBtn');
    navigator.clipboard.writeText(_csLink).then(() => {
        btn.textContent = '✓ Copied!';
        setTimeout(() => btn.textContent = 'Copy', 2000);
    }).catch(() => {
        btn.textContent = 'Copy';
    });
}

function csCheckLink() {
    const val = document.getElementById('csLinkInput').value.trim();
    const btn = document.getElementById('csDownloadBtn');
    const valid = val.includes('gofile.io') || val.includes('api.telegram.org/file/');
    btn.disabled = !valid;
    btn.style.color = valid ? 'rgba(200,170,255,0.95)' : 'rgba(200,170,255,0.6)';
    btn.style.cursor = valid ? 'pointer' : 'not-allowed';
}

function csDownload() {
    const val = document.getElementById('csLinkInput').value.trim();
    if (val.includes('gofile.io') || val.includes('api.telegram.org/file/')) window.open(val, '_blank');
}

function resetApp() {
    stopQRScan();
    _releaseWakeLock();
    if (S.conn) { try { S.conn.close(); } catch(e) {} S.conn = null; }
    if (S.peer) { try { S.peer.destroy(); } catch(e) {} S.peer = null; }
    // free blob urls
    Object.values(S.recvFiles).forEach(f => { try { URL.revokeObjectURL(f.url); } catch(e) {} });
    (S._senderBlobUrls || []).forEach(u => { try { URL.revokeObjectURL(u); } catch(e) {} });
    Object.assign(S, { roomCode:null, role:null, isConnected:false, pendingFiles:[], recvBuffers:{}, recvFiles:{}, recvBatches:{}, xfer:{t0:null,bytes:0}, _senderBlobUrls:[] });
    document.getElementById('joinCode').value = '';
    document.getElementById('speedFloat').style.display = 'none';
    const tipsBanner = document.getElementById('transferTipsBanner');
    if (tipsBanner) tipsBanner.style.display = 'none';
    const msgs = document.getElementById('chatMessages');
    if (msgs) msgs.innerHTML = '<div class="chat-system-msg">🔒 WebRTC encrypted · Files transferred directly peer-to-peer — not stored on servers</div>';
    clearAttachment();
    showView('Home');
}

// Data protocol
// { type:'chat-message', msgId, text, ts }
// { type:'file-meta', id, name, size, totalChunks }
// { type:'file-chunk', id, idx, data: ArrayBuffer }
// { type:'file-end', id }

function handleData(data) {
    if (!data || !data.type) return;
    switch(data.type) {
        case 'chat-message':
            addBubble('theirs', textBubbleHtml(data.text), data.msgId);
            break;
        case 'batch-start':
            _createBatchBubble(data.batchId, data.total, data.names, data.sizes);
            break;
        case 'file-meta':
            S.recvBuffers[data.id] = { chunks:{}, total:data.size, name:data.name, received:0, totalChunks:data.totalChunks, batchId: data.batchId || null, batchIndex: data.batchIndex != null ? data.batchIndex : null };
            log(`📥 Receiving: ${esc(data.name)} (${fmtSize(data.size)})`, 'info');
            if (!data.batchId) _addRecvItem(data.id, data.name, data.size);
            break;
        case 'file-chunk': {
            const buf = S.recvBuffers[data.id];
            if (!buf) return;
            buf.chunks[data.idx] = data.data;
            buf.received += data.data.byteLength;
            const pct = Math.min(100, (buf.received / buf.total) * 100);
            if (!buf.batchId) {
                _setRecvProgress(data.id, pct);
            } else {
                _updateBatchFileProgress(buf.batchId, buf.batchIndex, pct);
            }
            break;
        }
        case 'file-end':
            assembleFile(data.id);
            break;
        case 'batch-end':
            _finalizeBatchBubble(data.batchId);
            break;
        case 'bubble-delete': {
            const el = document.getElementById('bubble-' + data.id);
            if (el) { el.style.animation = 'fadeOut 0.18s ease forwards'; setTimeout(() => el.remove(), 180); }
            break;
        }
    }
}

function _addRecvItem(id, name, size) {
    addBubble('theirs', recvFileBubbleHtml(id, name, size), id);
}

// Receiver batch bubble
function _createBatchBubble(batchId, total, names, sizes) {
    const totalSize = sizes.reduce((a, b) => a + b, 0);
    S.recvBatches[batchId] = { ids: [], total, received: 0, names, sizes };

    const fileRows = names.map((name, i) => `
        <div class="batch-file-row" id="brow-${batchId}_${i}" onclick="_toggleBatchRow('${batchId}',${i})">
            <input type="checkbox" class="batch-checkbox" id="bchk-${batchId}_${i}" checked onclick="event.stopPropagation();_syncBatchActions('${batchId}')">
            <span style="font-size:1rem;">${fileEmoji(name)}</span>
            <span class="batch-file-name">${esc(name)}</span>
            <span class="batch-file-sz">${fmtSize(sizes[i])}</span>
            <span id="bstat-${batchId}_${i}" style="font-size:0.72rem;color:rgba(255,255,255,0.3);">⏳</span>
        </div>`).join('');

    const html = `
        <div class="batch-bubble" id="rbatch-${batchId}">
            <div class="batch-header">
                <div class="batch-icon">📦</div>
                <div>
                    <div class="batch-title">${total} files incoming</div>
                    <div class="batch-subtitle">${fmtSize(totalSize)} total</div>
                </div>
            </div>
            <div class="progress-wrap batch-progress" id="bprog-${batchId}">
                <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
                <div class="progress-text">Receiving...</div>
            </div>
            <span class="batch-select-all" onclick="_batchToggleAll('${batchId}')">☑ Select / Deselect All</span>
            <div class="batch-file-list">${fileRows}</div>
            <div class="batch-actions" id="bact-${batchId}">
                <span style="color:rgba(255,255,255,0.3);font-size:0.78rem;">⏳ Waiting for files...</span>
            </div>
        </div>`;
    addBubble('theirs', html, 'rbatch-wrap-' + batchId);
}

function _toggleBatchRow(batchId, i) {
    const chk = document.getElementById('bchk-' + batchId + '_' + i);
    const row = document.getElementById('brow-' + batchId + '_' + i);
    if (!chk) return;
    chk.checked = !chk.checked;
    if (row) row.classList.toggle('selected', chk.checked);
    _syncBatchActions(batchId);
}

function _batchToggleAll(batchId) {
    const batch = S.recvBatches[batchId];
    if (!batch) return;
    const allChecked = batch.names.every((_, i) => {
        const c = document.getElementById('bchk-' + batchId + '_' + i);
        return c && c.checked;
    });
    batch.names.forEach((_, i) => {
        const c = document.getElementById('bchk-' + batchId + '_' + i);
        const r = document.getElementById('brow-' + batchId + '_' + i);
        if (c) c.checked = !allChecked;
        if (r) r.classList.toggle('selected', !allChecked);
    });
    _syncBatchActions(batchId);
}

function _syncBatchActions(batchId) {
    // rebuild action buttons on checkbox change
    const actEl = document.getElementById('bact-' + batchId);
    if (!actEl) return;
    const batch = S.recvBatches[batchId];
    if (!batch || batch.received < batch.total) return; // still receiving
    _buildBatchActions(batchId);
}

function _updateBatchFileProgress(batchId, idx, pct) {
    const batch = S.recvBatches[batchId];
    if (!batch) return;
    const prog = document.getElementById('bprog-' + batchId);
    if (prog) {
        const completedFiles = batch.ids ? batch.ids.length : 0;
        const overallPct = Math.round(((completedFiles + pct / 100) / batch.total) * 100);
        prog.querySelector('.progress-fill').style.width = overallPct + '%';
        prog.querySelector('.progress-text').textContent = `${completedFiles + 1}/${batch.total} — ${Math.round(pct)}%`;
    }
}

function _finalizeBatchBubble(batchId) {
    const prog = document.getElementById('bprog-' + batchId);
    if (prog) {
        prog.querySelector('.progress-fill').style.width = '100%';
        prog.querySelector('.progress-text').textContent = 'All received ✓';
        setTimeout(() => { prog.style.display = 'none'; }, 1500);
    }
    addSystemMsg(`✅ ${S.recvBatches[batchId]?.total || ''} files received — select and save`);
}

function _buildBatchActions(batchId) {
    const actEl = document.getElementById('bact-' + batchId);
    if (!actEl) return;
    actEl.innerHTML = '';

    const saveAllBtn = document.createElement('button');
    saveAllBtn.className = 'btn-sm btn-sm-dl';
    saveAllBtn.textContent = '💾 Save All';
    saveAllBtn.addEventListener('click', () => _saveBatchSelected(batchId, true));
    actEl.appendChild(saveAllBtn);

    const saveSelBtn = document.createElement('button');
    saveSelBtn.className = 'btn-sm btn-sm-dl';
    saveSelBtn.style.background = 'rgba(0,210,255,0.2)';
    saveSelBtn.style.color = 'var(--primary)';
    saveSelBtn.style.border = '1px solid rgba(0,210,255,0.3)';
    saveSelBtn.textContent = '✔ Save Selected';
    saveSelBtn.addEventListener('click', () => _saveBatchSelected(batchId, false));
    actEl.appendChild(saveSelBtn);
}

function _saveBatchSelected(batchId, all) {
    const batch = S.recvBatches[batchId];
    if (!batch) return;
    let savedCount = 0;
    batch.ids.forEach((fileId, i) => {
        const chk = document.getElementById('bchk-' + batchId + '_' + i);
        const shouldSave = all || (chk && chk.checked);
        if (!shouldSave) return;
        const f = S.recvFiles[fileId];
        if (f) { triggerDl(f.url, f.name); savedCount++; }
    });
    toast(`💾 Saving ${savedCount} file${savedCount !== 1 ? 's' : ''}...`);
}

function _setRecvProgress(id, pct) {
    const el = document.getElementById('rp-' + id);
    if (!el) return;
    el.querySelector('.progress-fill').style.width = Math.round(pct) + '%';
    el.querySelector('.progress-text').textContent = Math.round(pct) + '%';
}

// Shareable upload
// 3-tier fallback: gofile.io -> litterbox -> 0x0.st

async function uploadToFileIO(blob, filename) {
    const errors = [];

    // 1) gofile.io - unlimited size, CORS-friendly, 10-day retention
    try {
        log('☁️ Uploading to gofile.io...', 'info');
        const srvRes = await fetch('https://api.gofile.io/servers');
        if (!srvRes.ok) throw new Error('Server list HTTP ' + srvRes.status);
        const srvJson = await srvRes.json();
        if (srvJson.status !== 'ok' || !srvJson.data?.servers?.length) throw new Error('No servers');
        const server = srvJson.data.servers[0].name;
        const fd = new FormData();
        fd.append('file', blob, filename);
        const r = await fetch(`https://${server}.gofile.io/uploadFile`, {
            method: 'POST', body: fd
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.status !== 'ok' || !j.data?.downloadPage) throw new Error('Bad response');
        return j.data.downloadPage;
    } catch (e) {
        errors.push('gofile: ' + e.message);
        log('⚠️ gofile.io failed, trying litterbox...', 'warning');
    }

    // 2) litterbox.catbox.moe - 1 GB, 72-hour retention
    try {
        const fd2 = new FormData();
        fd2.append('reqtype', 'fileupload');
        fd2.append('time', '72h');
        fd2.append('fileToUpload', blob, filename);
        const r2 = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
            method: 'POST', body: fd2
        });
        if (!r2.ok) throw new Error('HTTP ' + r2.status);
        const url2 = (await r2.text()).trim();
        if (!url2.startsWith('http')) throw new Error('Invalid: ' + url2);
        return url2;
    } catch (e) {
        errors.push('litterbox: ' + e.message);
        log('⚠️ litterbox failed, trying 0x0.st...', 'warning');
    }

    // 3) 0x0.st - 512 MB, semi-permanent
    try {
        const fd3 = new FormData();
        fd3.append('file', blob, filename);
        const r3 = await fetch('https://0x0.st', { method: 'POST', body: fd3 });
        if (!r3.ok) throw new Error('HTTP ' + r3.status);
        const url3 = (await r3.text()).trim();
        if (!url3.startsWith('http')) throw new Error('Invalid: ' + url3);
        return url3;
    } catch (e) {
        errors.push('0x0.st: ' + e.message);
    }

    throw new Error('All upload services failed: ' + errors.join(' | '));
}

function _uploadServiceLabel(url) {
    if (url.includes('gofile.io'))   return '🔗 gofile.io';
    if (url.includes('catbox.moe'))  return '🔗 litterbox';
    if (url.includes('0x0.st'))      return '🔗 0x0.st';
    return '🔗 Share Link';
}

function assembleFile(id) {
    const buf = S.recvBuffers[id];
    if (!buf) return;
    const parts = [];
    const missing = [];
    for (let i = 0; i < buf.totalChunks; i++) {
        if (buf.chunks[i]) { parts.push(buf.chunks[i]); }
        else { missing.push(i); }
    }
    const hasMissing = missing.length > 0;
    if (hasMissing) {
        log(`❌ Transfer incomplete: ${missing.length} chunk(s) missing for "${esc(buf.name)}". File may be corrupted.`, 'error');
    }
    const blob = new Blob(parts);
    const url = URL.createObjectURL(blob);

    S.recvFiles[id] = { name: buf.name, size: buf.total, url, blob };

    if (buf.batchId) {
        const batch = S.recvBatches[buf.batchId];
        if (batch) {
            batch.ids.push(id);
            const stat = document.getElementById('bstat-' + buf.batchId + '_' + buf.batchIndex);
            if (stat) stat.textContent = hasMissing ? '⚠️' : '✓';
            const row = document.getElementById('brow-' + buf.batchId + '_' + buf.batchIndex);
            if (row) row.classList.add('selected');
            const prog = document.getElementById('bprog-' + buf.batchId);
            if (prog) {
                const pct = Math.round((batch.ids.length / batch.total) * 100);
                prog.querySelector('.progress-fill').style.width = pct + '%';
                prog.querySelector('.progress-text').textContent = `${batch.ids.length}/${batch.total} received`;
            }
            if (batch.ids.length === batch.total) {
                _buildBatchActions(buf.batchId);
            }
        }
        delete S.recvBuffers[id];
        log(`✅ Received: ${esc(buf.name)} (${fmtSize(buf.total)})`, 'success');
        return;
    }

    delete S.recvBuffers[id];

    _setRecvProgress(id, 100);

    setTimeout(() => {
        const rpEl = document.getElementById('rp-' + id);
        if (rpEl) rpEl.style.display = 'none';
    }, 1200);

    if (hasMissing) {
        addSystemMsg(`⚠️ "${buf.name}" received with ${missing.length} missing chunk(s) — file may be corrupted`);
    } else {
        addSystemMsg(`✅ "${buf.name}" received — tap Save to download`);
    }
    log(`✅ Received: ${esc(buf.name)} (${fmtSize(buf.total)})`, 'success');

    const mpEl = document.getElementById('mp-' + id);
    if (mpEl) {
        const prev = _mkMediaPreview(url, buf.name);
        if (prev) mpEl.appendChild(prev);
    }

    function _mkSaveDl() {
        const btn = document.createElement('button');
        btn.className = 'btn-sm btn-sm-dl';
        btn.textContent = '💾 Save';
        btn.addEventListener('click', () => triggerDl(url, buf.name));
        return btn;
    }

    function _mkShareBtn() {
        const btn = document.createElement('button');
        btn.className = 'btn-sm btn-sm-link';
        btn.textContent = '☁️ Get Share Link';
        btn.addEventListener('click', () => requestShareLink(id, btn));
        return btn;
    }

    const actEl = document.getElementById('recv-actions-' + id);
    if (actEl) {
        actEl.innerHTML = '';
        actEl.appendChild(_mkSaveDl());
        actEl.appendChild(_mkShareBtn());
    }
}

function copyShareLink(url, btn) {
    copyToClipboard(url);
    let ttl = 'temporary';
    if (url.includes('gofile.io'))  ttl = '10 days (public link)';
    else if (url.includes('catbox.moe')) ttl = '72h';
    else if (url.includes('0x0.st')) ttl = 'long-term';
    toast('🔗 Link copied! Valid: ' + ttl);
    if (btn) { const orig = btn.textContent; btn.textContent = '✅ Copied!'; setTimeout(() => btn.textContent = orig, 2200); }
}

// Get Share Link button — confirm before uploading
function requestShareLink(id, btn) {
    const modal = document.getElementById('shareConfirmModal');
    const okBtn = document.getElementById('shareConfirmOkBtn');
    if (!modal || !okBtn) return;

    const newOkBtn = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOkBtn, okBtn);

    newOkBtn.addEventListener('click', () => {
        modal.classList.remove('active');
        _doUploadAndShowLink(id, btn);
    });

    modal.classList.add('active');
}

function _doUploadAndShowLink(id, triggerBtn) {
    const file = S.recvFiles[id];
    if (!file) return;

    const actEl = document.getElementById('recv-actions-' + id);

    if (triggerBtn) {
        triggerBtn.textContent = '⏳ Uploading...';
        triggerBtn.disabled = true;
    }

    uploadToFileIO(file.blob, file.name)
        .then(shareUrl => {
            if (actEl) {
                const shareBtn = document.createElement('button');
                shareBtn.className = 'btn-sm btn-sm-link copy-share-btn';
                shareBtn.dataset.shareUrl = shareUrl;
                shareBtn.title = new URL(shareUrl).hostname;
                shareBtn.textContent = _uploadServiceLabel(shareUrl);
                if (triggerBtn && triggerBtn.parentNode) {
                    triggerBtn.parentNode.replaceChild(shareBtn, triggerBtn);
                } else {
                    actEl.appendChild(shareBtn);
                }
            }
            log('✅ Shareable link ready: ' + shareUrl, 'success');
        })
        .catch(err => {
            if (triggerBtn) {
                triggerBtn.textContent = '🔄 Retry';
                triggerBtn.disabled = false;
                triggerBtn.onclick = () => _doUploadAndShowLink(id, triggerBtn);
            }
            log('❌ ' + err.message, 'error');
            toast('❌ Upload failed. Tap Retry to try again.');
        });
}

function triggerDl(url, name) {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// File send
function handleFiles(files) {
    const arr = Array.from(files);
    if (!arr.length) return;
    S.pendingFiles = arr;
    const first = arr[0];
    document.getElementById('attachEmoji').textContent = fileEmoji(first.name);
    document.getElementById('attachName').textContent = arr.length > 1 ? `${first.name} +${arr.length - 1} more` : first.name;
    document.getElementById('attachSize').textContent = fmtSize(arr.reduce((a, f) => a + f.size, 0));
    document.getElementById('attachPreview').style.display = 'block';
    document.getElementById('fileInput').value = '';
    const ti = document.getElementById('chatTextInput');
    if (ti) ti.focus();
}

async function _doSendChunks(file, bubbleId, batchId, batchIndex, batchTotal) {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    S.xfer.t0 = Date.now();
    S.xfer.bytes = 0;
    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const ab = await file.slice(start, end).arrayBuffer();
        S.conn.send({ type: 'file-chunk', id: bubbleId, idx: i, data: ab });
        S.xfer.bytes += ab.byteLength;
        if (i % 6 === 0) {
            const pct = ((i + 1) / totalChunks) * 100;
            _setSendProgress(bubbleId, pct);
            calcSpeed();
            await new Promise(r => setTimeout(r, 0));
        }
    }
}

function _setSendProgress(bubbleId, pct, label) {
    const el = document.getElementById('sp-' + bubbleId);
    if (!el) return;
    el.querySelector('.progress-fill').style.width = Math.round(pct) + '%';
    el.querySelector('.progress-text').textContent = label || (Math.round(pct) + '%');
}

function calcSpeed() {
    const elapsed = (Date.now() - S.xfer.t0) / 1000;
    if (!elapsed) return;
    const s = fmtSpd(S.xfer.bytes / elapsed);
    document.getElementById('statSpeed').textContent = s;
    document.getElementById('speedValue').textContent = s;
    const badge = document.getElementById('chatSpeedBadge');
    const val = document.getElementById('chatSpeedVal');
    if (badge && val) { badge.style.display = 'block'; val.textContent = s; }
}

// Drag & drop (chat area)
document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('dragOverlay');
    let dragCounter = 0;

    ['dragenter','dragover','dragleave','drop'].forEach(ev => {
        document.body.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); });
    });

    document.body.addEventListener('dragenter', e => {
        if (!e.dataTransfer || !e.dataTransfer.types || !Array.from(e.dataTransfer.types).includes('Files')) return;
        dragCounter++;
        if (overlay) overlay.classList.add('active');
    });

    document.body.addEventListener('dragleave', () => {
        dragCounter--;
        if (dragCounter <= 0) { dragCounter = 0; if (overlay) overlay.classList.remove('active'); }
    });

    document.body.addEventListener('drop', e => {
        dragCounter = 0;
        if (overlay) overlay.classList.remove('active');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        if (!S.isConnected) { toast('⚠️ Connect to a room first to send files'); return; }
        handleFiles(files);
    });

    // Delegated handler avoids inline onclick + escaping issues on dynamic buttons
    document.body.addEventListener('click', e => {
        const btn = e.target.closest('.copy-share-btn');
        if (!btn) return;
        const shareUrl = btn.dataset.shareUrl;
        if (!shareUrl) return;
        copyShareLink(shareUrl, btn);
    });
});

// Init
document.getElementById('joinCode').addEventListener('input', function() {
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);
});
document.getElementById('joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

window.addEventListener('load', () => {
    const p = new URLSearchParams(location.search);
    const room = p.get('room');
    if (room) {
        const code = room.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);
        if (code.length === 5) {
            document.getElementById('joinCode').value = code;
            setTimeout(joinRoom, 500);
        }
    }
});


// ============================================================
// HELP / FAQ
// ============================================================
const FAQ = [
  {
    q: "How do I create a room?",
    a: "Tap the <strong>Create Room</strong> button on the home screen. The system generates a 5-character room code and a QR code for you. Share that code or QR with the other person."
  },
  {
    q: "How do I join a room?",
    a: "Switch to the <strong>Enter Code</strong> tab, enter the 5-character room code and hit Join. Or scan the QR code from the <strong>Scan QR</strong> tab — the connection is established automatically."
  },
  {
    q: "How do I send a file?",
    a: "Once connected, tap the 📎 button in the chat screen and select the file you want to send. The file goes directly to the other device and is never stored on a server."
  },
  {
    q: "Does it work across different networks? (different Wi-Fi, 4G vs Wi-Fi)",
    a: "Yes. Thanks to WebRTC and the PeerJS infrastructure, Yunze also works across different networks. It automatically gets past NAT and firewalls."
  },
  {
    q: "Is there a file size limit?",
    a: "There's no technical size limit. For very large files (e.g. 1 GB+), however, transfer time can grow depending on your internet speed. Small files transfer instantly."
  },
  {
    q: "Are my files stored on the server?",
    a: "No. All transfers happen directly between devices (P2P). No file is ever uploaded to or saved on Yunze's servers."
  },
  {
    q: "The connection won't establish — what should I do?",
    a: "1) Check that both devices are connected to the internet. 2) Refresh the page and try again. 3) Create a new room. 4) Corporate networks or some VPNs can block WebRTC — try a different network."
  },
  {
    q: "I'm getting a \"PeerJS server unreachable\" error",
    a: "This means the PeerJS server can't be reached. It's usually a temporary network issue. Wait a few seconds and refresh the page. If it persists, try a different network (Wi-Fi ↔ 4G)."
  },
  {
    q: "QR code scanning isn't working",
    a: "Make sure you've granted the browser camera permission. We recommend using Safari on iOS. Chrome works on Android. After granting camera permission, reopen the Scan QR tab."
  },
  {
    q: "What is Cloud Share for?",
    a: "When a P2P connection can't be established, you can instead upload your file to gofile.io or Telegram and get a download link. Choose your preferred service on the Cloud Share screen."
  },
  {
    q: "Is the app free?",
    a: "Yes, completely free. No sign-up, subscription, or fee required."
  },
  {
    q: "How is privacy ensured?",
    a: "Connections are encrypted with WebRTC. Files never pass through Yunze's servers — they're transferred directly between the two devices. Chat messages travel over that same encrypted channel."
  },
  {
    q: "Does it work on mobile devices?",
    a: "Yes. Yunze works in all modern browsers — Android Chrome, iOS Safari, desktop Chrome/Firefox/Edge. It can also be added to the home screen as a PWA."
  },
  {
    q: "How many people can connect at once?",
    a: "Right now each room supports a one-to-one (2-device) connection. If you create a room, you're the host and the other person is the guest."
  },
  {
    q: "What happens if the file transfer is interrupted?",
    a: "The transfer stops if the connection drops. Resuming from where it left off isn't currently supported. You'll need to refresh the connection and send again."
  }
];

let helpOpen = false;

function toggleHelpView() {
    const btn = document.getElementById('helpNavBtn');
    if (helpOpen) {
        showView('Home');
        btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Help`;
        btn.style.background = 'rgba(255,255,255,0.08)';
        helpOpen = false;
    } else {
        showView('Help');
        btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Back`;
        btn.style.background = 'rgba(0,210,255,0.15)';
        helpOpen = true;
    }
}

function renderFAQ() {
    const list = document.getElementById('faqList');
    if (list.childElementCount > 0) return;
    list.innerHTML = FAQ.map((item, i) => `
        <div class="faq-item" onclick="toggleFAQ(${i})">
            <div class="faq-q">
                <span>${item.q}</span>
                <svg class="faq-chevron" id="faqChevron${i}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="faq-a" id="faqA${i}">${item.a}</div>
        </div>
    `).join('');
}

function toggleFAQ(i) {
    const ans = document.getElementById('faqA' + i);
    const chev = document.getElementById('faqChevron' + i);
    const open = ans.style.display === 'block';
    ans.style.display = open ? 'none' : 'block';
    chev.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
}

// Note: About/Privacy/P2P/Security are now standalone crawlable pages
// (about.html, privacy.html, p2p.html, security.html) instead of JS overlays.

