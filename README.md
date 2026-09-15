<div align="center">
  <img src="yunze-icon.png" alt="Yunze Logo" width="96" />

  # ⚡ Yunze Universal Transfer

  **Free, private, peer-to-peer file sharing — no accounts, no servers, no size limits.**

  [![License: BSD 3-Clause](https://img.shields.io/badge/License-BSD%203--Clause-yellow.svg)](LICENSE)
  [![Live Site](https://img.shields.io/badge/Live-yunzetransfer.pages.dev-blue)](https://yunzetransfer.pages.dev)
  ![Version](https://img.shields.io/badge/version-1.2.0-brightgreen)

  🔗 **Live app:** [yunzetransfer.pages.dev](https://yunzetransfer.pages.dev)
</div>

---

## Table of Contents

- [Philosophy](#philosophy)
- [Screenshots](#screenshots)
- [Feature Overview](#feature-overview)
- [Deep Dive: How Peer-to-Peer Transfer Works](#deep-dive-how-peer-to-peer-transfer-works)
  - [1. Room Creation & Peer IDs](#1-room-creation--peer-ids)
  - [2. Joining a Room](#2-joining-a-room)
  - [3. The WebRTC Handshake](#3-the-webrtc-handshake)
  - [4. Chunked File Transfer](#4-chunked-file-transfer)
  - [5. Batch (Multi-File) Transfers](#5-batch-multi-file-transfers)
  - [6. Speed Calculation](#6-speed-calculation)
- [QR Code System](#qr-code-system)
- [Chat & Messaging Layer](#chat--messaging-layer)
- [Cloud Share (gofile.io Fallback)](#cloud-share-gofileio-fallback)
- [Screen Wake Lock](#screen-wake-lock)
- [Clipboard Handling](#clipboard-handling)
- [Full File Structure](#full-file-structure)
- [Function Reference (app.js)](#function-reference-appjs)
- [Design System](#design-system)
- [Browser APIs Used](#browser-apis-used)
- [Tech Stack](#tech-stack)
- [Running Locally](#running-locally)
- [Deployment](#deployment)
- [Security & Privacy Model](#security--privacy-model)
- [Known Limitations](#known-limitations)
- [Browser Compatibility](#browser-compatibility)
- [Version History](#version-history)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)
- [Trademark](#trademark)
- [Contact](#contact)

---

## Philosophy

Most file-sharing tools follow the same pattern: upload your file to a company's server, wait, then send someone a link to download it from that server. This is simple, but it means your file — potentially something sensitive — sits on hardware you don't control, for an amount of time you don't control, subject to a privacy policy you probably didn't read.

Yunze takes a different approach. It uses **WebRTC**, the same real-time communication technology that powers browser-based video calls, to open a **direct connection between two devices**. The file never touches a third-party server. It moves directly from Device A to Device B, encrypted the entire way, and when the transfer ends, there is nothing left behind — no copy, no log, no trace.

This README documents not just *what* Yunze does, but *how* it does it, down to the chunk size and the exact browser APIs involved — because a tool that claims to be private should be easy to verify.

## Screenshots

| Home | Room Code | Active Transfer |
|------|-----------|------------------|
| ![Home screen](screenshots/home.png) | ![Room code](screenshots/room-code.png) | ![Active transfer](screenshots/transfer.png) |

## Feature Overview

| Feature | Description |
|---|---|
| 🔗 Peer-to-peer transfer | Direct WebRTC DataChannel connection, DTLS-encrypted by default |
| 🚀 No file size limit | Files are sliced into 64KB chunks and streamed continuously — there's no server-imposed cap |
| 📦 Batch transfers | Send multiple files in a single session; each file gets its own progress indicator |
| 🌍 Cross-network | Works between WiFi ↔ 4G/5G, and across different countries/ISPs, thanks to WebRTC's NAT traversal |
| 🔑 Room codes | 5-character alphanumeric codes generate a unique PeerJS ID for pairing |
| 📷 QR code pairing | Scan-to-connect using the device camera, with a native `BarcodeDetector` API and a `jsQR` JavaScript fallback |
| 💬 In-session chat | Text messaging alongside file transfer, over the same DataChannel |
| 🖼️ Inline media preview | Images, videos, and common file types render a preview directly in the chat bubble before download |
| 📱 Screen Wake Lock | Keeps the screen from sleeping mid-transfer using the Screen Wake Lock API |
| ☁️ Cloud Share fallback | Optional one-way upload via gofile.io for when both devices can't be online simultaneously |
| 📲 PWA support | Installable to your home screen via `manifest.json`, works like a native app shell |

## Deep Dive: How Peer-to-Peer Transfer Works

### 1. Room Creation & Peer IDs

When you tap **Create Room**, the app calls `createRoom()` (`app.js`), which:

1. Generates a random 5-character code via `rndCode()`
2. Converts that code into a PeerJS peer ID using `peerIdOf(code)`, which simply lowercases the code and prefixes it: `yunze-<code>`
3. Registers that ID with the PeerJS cloud signaling server
4. Displays the code and a QR code (via `showQR()`) for the other device to scan or type in

This means the room code *is* the connection address — there's no separate lookup table or database involved.

### 2. Joining a Room

The joining device calls `joinRoom()`, which takes the entered code, derives the same `yunze-<code>` peer ID, and asks PeerJS to connect directly to that peer. If successful, `_wireConn()` sets up the DataChannel event handlers (`open`, `data`, `close`, `error`) on both ends.

### 3. The WebRTC Handshake

PeerJS's cloud signaling server is only involved in this initial step — exchanging connection metadata (ICE candidates, session descriptions) so that both browsers know how to reach each other. Once ICE negotiation completes, WebRTC either:

- Establishes a **direct peer connection** (most common case, works even across different networks/NAT setups), or
- Falls back to a **TURN relay server** only when a direct path is blocked by very restrictive firewalls (e.g. some corporate/school networks)

In both cases, the actual data is encrypted end-to-end with **DTLS** — even a TURN relay cannot read the contents, it only forwards encrypted packets.

### 4. Chunked File Transfer

Once the DataChannel is open, file sending goes through `_doSendChunks()`. The relevant constant:

```js
const CHUNK_SIZE = 64 * 1024; // 64KB
```

Each file is read and sent in 64KB binary chunks over the DataChannel. This chunking is what allows Yunze to handle files of essentially unlimited size — memory usage stays flat because the whole file is never loaded into a single buffer at once, and the receiving side (`handleData()` → `assembleFile()`) reassembles chunks back into a complete file as they arrive.

Progress is tracked per-chunk: `_setSendProgress()` on the sender side and `_setRecvProgress()` on the receiver side update the UI as each chunk is transmitted/received.

### 5. Batch (Multi-File) Transfers

Selecting multiple files at once triggers the batch transfer path:

- `_createBatchBubble()` builds a single chat bubble representing the whole batch, listing every file
- Each file's individual progress is tracked via `_updateBatchFileProgress()`
- `_toggleBatchRow()` / `_batchToggleAll()` let the receiver select which files (in a batch) to save or get a share link for, rather than forcing an all-or-nothing download
- `_finalizeBatchBubble()` runs once every file in the batch has fully arrived, rebuilding the bubble into its "completed" state with per-file action buttons

### 6. Speed Calculation

`calcSpeed()` runs on an interval, comparing bytes transferred since the last tick to compute a live transfer rate. This value is formatted with `fmtSpd()` (converting bytes/sec into MB/s) and displayed next to the room status ("17.1 MB/s" badge shown during transfer) — this is a real-time measurement of the actual DataChannel throughput, not an estimate.

## QR Code System

Yunze supports two ways of scanning a QR code, tried in this order:

1. **Native `BarcodeDetector` API** (`_scanWithBarcodeDetector()`) — where supported (most Chromium-based browsers), this uses the browser's built-in, hardware-accelerated barcode scanner directly on the live camera feed.
2. **`jsQR` fallback** (`_scanWithJsQR()`) — on browsers without native support (notably Safari), the app falls back to the `jsQR` JavaScript library, manually sampling video frames onto a canvas and decoding them.

There's also a **photo-based scan path** (`scanQRFromPhoto()`) for scanning a QR code from an existing image rather than the live camera — this includes EXIF orientation handling (`_getExifOrientation()`, `_drawRotated()`) so that photos taken in different phone orientations still decode correctly, since a QR code rotated 90° in a raw image buffer would otherwise fail to scan.

## Chat & Messaging Layer

Beyond file transfer, Yunze includes a simple real-time chat over the same DataChannel (`sendChatMessage()`, `addBubble()`, `textBubbleHtml()`). Messages are peer-to-peer like everything else — never relayed through or stored on a server. The chat and file-transfer bubbles share the same visual thread, so a session can mix conversation and file sharing naturally.

## Cloud Share (gofile.io Fallback)

For cases where both devices can't be online at the same time, Yunze offers an optional one-way upload path (`csUpload()`):

1. The app requests an available upload server from `api.gofile.io/servers`
2. The file is uploaded directly to that server via a `FormData` POST request
3. gofile.io returns a public download page URL, which is displayed and copyable (`csCopyLink()`)

This is clearly separated from the default P2P flow in the UI — it's an explicit opt-in ("Cloud Share (No P2P needed)"), not the default path. Links are subject to gofile.io's own retention policy (approximately 10 days of inactivity before deletion).

## Screen Wake Lock

Large transfers can take a while, and mobile browsers aggressively dim/lock the screen to save battery — which can interrupt an in-progress WebRTC session if the tab gets backgrounded. Yunze requests a **Screen Wake Lock** (`_acquireWakeLock()`) using the native `navigator.wakeLock` API for the duration of an active transfer, and releases it afterward (`_releaseWakeLock()`). It also re-acquires the lock if the tab's visibility changes mid-session (e.g. the user briefly switched apps and came back).

This API isn't supported in every browser — the code checks for its existence first and silently does nothing if unavailable, so it degrades gracefully rather than breaking anything.

## Clipboard Handling

Copying the room code or link (`copyToClipboard()`) primarily uses the modern `navigator.clipboard` API. Because that API isn't available in all contexts (e.g. non-HTTPS, certain in-app browsers, older iOS Safari versions), there's a manual fallback (`_clipboardFallback()`) that creates a temporary, invisible `<textarea>`, selects its contents, and uses the older `document.execCommand('copy')` method — ensuring the copy button works even in less capable environments.

## Full File Structure

```
├── index.html            # Main single-page app: room UI, transfer UI, Cloud Share, Help modal,
│                           #   About/Privacy/P2P/Security overlays, footer
├── app.js                 # All application logic (~1650 lines, 80+ functions) — see reference below
├── styles.css              # All styling: CSS variables, layout, responsive breakpoints, animations
├── sitemap.xml                    # XML sitemap (homepage only)
├── manifest.json                   # PWA manifest (icons, name, theme color, display mode)
├── favicon.ico / yunze-icon.png     # App icons (ICO + PNG, used for favicon, PWA icon, OG image)
├── _redirects                        # Cloudflare Pages SPA fallback rule (all paths → index.html)
├── LICENSE                             # BSD 3-Clause License (+ trademark carve-out)
└── README.md                            # This file
```

## Function Reference (app.js)

`app.js` contains roughly 80 functions. Grouped by subsystem:

**Core connection & rooms:** `createRoom`, `joinRoom`, `peerIdOf`, `rndCode`, `_wireConn`, `_showConnect`, `resetApp`

**File transfer engine:** `_doSendChunks`, `handleData`, `assembleFile`, `_setSendProgress`, `_setRecvProgress`, `calcSpeed`, `fmtSpd`, `fmtSize`, `handleFiles`

**Batch transfers:** `_createBatchBubble`, `_addSenderBatchBubble`, `_updateSenderBatchProgress`, `_finalizeSenderBatchBubble`, `_toggleBatchRow`, `_batchToggleAll`, `_syncBatchActions`, `_updateBatchFileProgress`, `_finalizeBatchBubble`, `_buildBatchActions`, `_saveBatchSelected`

**QR code system:** `startQRScan`, `_scanWithBarcodeDetector`, `_scanWithJsQR`, `stopQRScan`, `scanQRFromPhoto`, `parseQR`, `confirmQRJoin`, `resetQRScan`, `showQR`, `closeQR`, `_getExifOrientation`, `_drawRotated`, `_jsqrScan`

**Chat & bubbles:** `sendChatMessage`, `addBubble`, `addSystemMsg`, `textBubbleHtml`, `fileBubbleHtml`, `recvFileBubbleHtml`, `chatKeyDown`, `autoResizeTextarea`, `clearAttachment`, `_mkMediaPreview`, `mediaType`, `fileEmoji`

**Cloud Share:** `switchCloudTab`, `csHandleFile`, `csClearFile`, `csUpload`, `csCopyLink`, `csCheckLink`, `csDownload`, `uploadToFileIO`, `_uploadServiceLabel`

**Sharing & clipboard:** `copyToClipboard`, `_showCopyModal`, `_clipboardFallback`, `copyRoomCode`, `copyRoomLink`, `buildUrl`, `copyShareLink`, `requestShareLink`, `_doUploadAndShowLink`, `triggerDl`

**UI/navigation:** `showView`, `showErr`, `switchHomeTab`, `toast`, `log`, `esc`

**Device/browser detection:** `isIOSDevice`, `isIOSChromeBrowser`

**FAQ:** `renderFAQ`, `toggleFAQ`

**Wake Lock:** `_acquireWakeLock`, `_releaseWakeLock`

## Design System

Colors, spacing, and effects are defined as CSS custom properties at the top of `styles.css`, making the whole visual theme adjustable from one place. Key characteristics:

- **Dark, gradient-based background** (`#0f0c29` → mid → light tones), consistent across the entire app
- **Glassmorphism-style cards**: semi-transparent backgrounds with subtle borders and `backdrop-filter: blur()`
- **Responsive breakpoints** for mobile-first layout (logo size, padding, and container width all scale down on narrow viewports)
- **CSS keyframe animations**: `fadeIn`, `fadeInDown`, `fadeInUp` for view transitions and toasts

## Browser APIs Used

| API | Purpose | Fallback if unavailable |
|---|---|---|
| WebRTC (via PeerJS) | Core P2P data transfer | None — this is the core requirement |
| `BarcodeDetector` | Native QR scanning | Falls back to `jsQR` library |
| `navigator.wakeLock` | Keep screen awake during transfer | Silently skipped |
| `navigator.clipboard` | Copy room code/link | Falls back to `execCommand('copy')` |
| `MediaDevices.getUserMedia` | Camera access for QR scanning | Scan-from-photo option available instead |

## Tech Stack

- **Frontend:** Vanilla JavaScript (ES6+), HTML5, CSS3 — no framework, no build step, no bundler, no npm dependencies to install
- **P2P layer:** [PeerJS](https://peerjs.com) 1.5.2 (loaded via CDN), wrapping the native WebRTC API
- **QR decoding fallback:** [jsQR](https://github.com/cozmo/jsQR) (loaded via CDN)
- **Hosting:** [Cloudflare Pages](https://pages.dev) — global CDN, static file hosting, Git-connected auto-deploy
- **Optional cloud fallback:** [gofile.io](https://gofile.io) public upload API

## Running Locally

This is a fully static site — no build tools, no `npm install`, no compilation step required.

```bash
git clone https://github.com/yunuseeeeeeee/Yunze-Transfer.git
cd Yunze-Transfer

# Option 1: Python
python3 -m http.server 8000

# Option 2: Node.js
npx serve .

# Option 3: PHP
php -S localhost:8000
```

Then open `http://localhost:8000`. To test a real P2P transfer, open the app in two separate browser tabs/windows (or two physical devices) and connect via a room code.

> ⚠️ **Note:** WebRTC generally requires either `localhost` or HTTPS to function correctly. Testing across two *different* physical devices on a local network may require serving over HTTPS or using a tunneling tool like `ngrok`.

## Deployment

The live site is deployed via **Cloudflare Pages**, connected directly to this GitHub repository:

1. Push changes to the `main` branch
2. Cloudflare Pages automatically detects the change and builds a new deployment (no build command needed — served as static files as-is)
3. The `_redirects` file (`/* /index.html 200`) ensures any path falls back to the main app shell, which is relevant for the SPA's query-string-based room joining (`?room=<code>`)

To deploy your own fork:
1. Fork this repository
2. Go to [Cloudflare Pages](https://pages.dev) → **Create a project** → **Connect to Git**
3. Select your fork, leave build settings empty (static site), and deploy

## Security & Privacy Model

- **No server-side file storage** — by default, files never touch any server; they move directly between the two connected devices over an encrypted WebRTC DataChannel.
- **Encryption in transit** — DataChannels use DTLS, the same encryption class securing HTTPS traffic.
- **No accounts, no cookies, no tracking** — Yunze does not require sign-up and does not set cookies or log file names/sizes/metadata anywhere.
- **Signaling metadata only** — the PeerJS signaling server sees connection setup information (used to establish the WebRTC link) but never sees file contents.
- **Cloud Share caveat** — opting into the gofile.io upload path means that specific file is stored on gofile's infrastructure, subject to their policies. This is presented as a clearly separate, opt-in mode.

Full details: [Privacy Policy](https://yunzetransfer.com) · [Security Guide](https://yunzetransfer.com)

## Known Limitations

- **No transfer resume** — if a connection drops mid-transfer, the session must be restarted (this is on the [Roadmap](#roadmap)).
- **One-to-one only** — a room supports exactly two devices (host + guest); there's no multi-peer/group transfer mode currently.
- **Strict corporate/school firewalls** — networks that block WebRTC/UDP traffic entirely may prevent a P2P connection from forming, even with TURN relay fallback. Cloud Share is the practical workaround in that case.
- **Cloud Share retention** — gofile.io links are not permanent; they expire after roughly 10 days of inactivity, per gofile's own policy (outside Yunze's control).

## Browser Compatibility

| Browser | Supported |
|---------|-----------|
| Chrome / Edge (desktop & mobile) | ✅ Full support, including native `BarcodeDetector` |
| Firefox | ✅ Full support (QR scanning uses the `jsQR` fallback) |
| Safari (iOS 11+ / macOS) | ✅ Supported (QR scanning uses the `jsQR` fallback) |
| Samsung Internet | ✅ Full support |
| Internet Explorer | ❌ Not supported (no WebRTC) |

## Version History

**v1.2.0**
- Added gallery picker in chat: tapping 📎 now shows a "Gallery" and "Files" option; Gallery opens the photo/video library directly on mobile.
- Reverted About/Privacy/P2P/Security pages back to in-app overlays (were briefly separate HTML files; consolidated back for a cleaner single-page experience).
- Migrated from `yunzetransfer.pages.dev` to `yunzetransfer.com`.

**v1.1.0**
- Fixed the Help & FAQ screen not displaying — the modal was nested inside the app's internal view container, which silently broke its `position: fixed` behavior; it's now rendered as a fully independent, top-level overlay.
- Minor SEO improvement: the homepage brand name now uses a semantic `<h1>` tag instead of a styled `<div>`.
- Added a GitHub repository link and a contact email to the site footer.

**v1.0.0**
- Initial public release: WebRTC peer-to-peer transfer, room code / QR pairing, in-session chat, batch transfers, Cloud Share (gofile.io) fallback, BSD 3-Clause license.

## Roadmap

- [ ] Transfer resume after a dropped connection
- [ ] Multi-peer / group transfer sessions
- [ ] Optional additional end-to-end encryption layer on top of DTLS
- [ ] Additional Cloud Share provider options

## FAQ

**Are my files stored on your servers?**
No. Files transfer directly between devices (peer-to-peer) and are never stored on Yunze servers. The optional "Cloud Share" feature uses gofile.io for one-way sharing — in that case, the file is stored by gofile.io, not by Yunze.

**Is there a file size limit?**
No hard limit for direct P2P transfer — very large files simply take longer, split into 64KB chunks, depending on both devices' connection speeds.

**Do both people need to be online at the same time?**
For direct P2P transfer, yes. If that's not possible, use the Cloud Share fallback instead.

**Why does the room code look like `yunze-abcde` internally?**
The 5-character code you see and share is converted into a PeerJS peer ID by prefixing it (`peerIdOf()` in `app.js`) — this is purely an internal naming convention for the signaling layer, not something you need to type differently.

**Is it really free?**
Yes, completely — no subscriptions, no premium tier, no ads.

## Contributing

Contributions, bug reports, and feature suggestions are welcome. Feel free to open an issue or submit a pull request.

## License

This project is licensed under the **[BSD 3-Clause License](LICENSE)**.

In short:
- ✅ You are free to **use, copy, modify, and redistribute** this code, including for commercial purposes.
- ✅ You must **keep the original copyright notice** in any copy or substantial portion of the code.
- ❌ You may **not use the "Yunze" name, logo, or branding** to promote a modified/derivative version, or present a fork as the original "Yunze Universal Transfer" project, without explicit written permission.

The **code itself is fully open** — the **Yunze name and identity are protected**. If you fork this project, you're welcome to build on it, but please rebrand it under your own name.

## Trademark

"Yunze" and the Yunze logo are the identity of this project and are **not covered by the code license above**. Republishing this project (as-is or modified) under the Yunze name, or claiming authorship of the original project, is not permitted. If you build something based on this code, please give it its own name and branding.

## Contact

For questions, feedback, or partnership inquiries, reach out via [Instagram @yunze_official](https://www.instagram.com/yunze_official) or email [yunusemrecontact@proton.me](mailto:yunusemrecontact@proton.me).
