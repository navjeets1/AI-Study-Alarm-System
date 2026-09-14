# 🛡️ Study Focus Guard — AI-Powered Chrome Side Panel Extension

<div align="center">

![Chrome Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)
![TensorFlow.js](https://img.shields.io/badge/TensorFlow.js-WebGL_%26_CPU-FF6F00?logo=tensorflow&logoColor=white)
![MediaPipe](https://img.shields.io/badge/MediaPipe-FaceLandmarker-00C7B7?logo=google&logoColor=white)
![Privacy](https://img.shields.io/badge/Privacy-100%25_On--Device-10B981)
![License](https://img.shields.io/badge/License-MIT-6366F1)
![Build](https://img.shields.io/badge/Build-Passing-22C55E)

**A high-performance, privacy-first Chrome Extension that runs client-side computer vision directly in the Chrome Side Panel to eliminate study distractions, track focus metrics, and trigger customizable audio alarms.**

[Features](#-key-features) • [Architecture](#-system-architecture) • [Getting Started](#-getting-started) • [Installation](#-load-in-chrome) • [Configuration](#-configuration--settings) • [Contributing](#-contributing)

</div>

---

## 📖 Overview

**Study Focus Guard** is an intelligent study assistant built for Google Chrome's Side Panel API (`chrome.sidePanel`). Utilizing local machine learning models powered by **TensorFlow.js** and **Google MediaPipe**, it monitors student attention in real-time without sending any video data to external servers.

Whether you're studying for exams, working remotely, or programming, Study Focus Guard gently keeps you on track by alerting you the moment you pick up your phone, look away from your screen, or leave your desk.

---

## ✨ Key Features

### 🧠 1. Real-Time Multi-Modal Computer Vision
* **📱 Phone in Hand Detection:** Employs COCO-SSD object detection with tailored confidence thresholds and geometric aspect-ratio heuristics to immediately identify mobile phones and handheld devices.
* **📞 Phone-to-Ear / Call Gesture Recognition:** Combines face landmarker coordinate geometry (Left Ear landmark #234 and Right Ear landmark #454) with head roll angle tilt to recognize when a phone is held up to the ear during calls.
* **📐 3D Head Pose & Gaze Estimation:** Computes real-time Pitch, Yaw, and Roll Euler angles directly from 468 3D facial landmarks. Calibrated so looking straight ahead evaluates to ~0° neutral:
  * **Looking Down:** Pitch > +18° (e.g., looking at phone/lap).
  * **Looking Up:** Pitch < -16° (e.g., staring at the ceiling).
  * **Looking Left / Right:** Yaw > +18° or < -18° (accurate left/right orientation).
* **👤 Stepped Away / No-Face Detection:** Flags distractions when the user steps away from their desk after a customizable temporal grace period (1.0s).

### 🎵 2. Custom Alarm Audio from Local Files
* **Upload Custom Sound Files:** Choose any audio file (`.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.flac`) directly from your computer to use as your distraction alarm.
* **Instant Preview & Storage:** Test your custom alarm sound with one click; audio is saved locally into `chrome.storage.local` (base64) so your sound persists across browser restarts.
* **Chrome TTS Fallback:** Don't have an audio file? The extension falls back to a clean, non-blocking Chrome Text-To-Speech voice warning (*"Please refocus!"*).
* **Hardware-Safe Audio Management:** Audio execution is guarded with `isSpeaking()` checks and isolated event listeners to prevent Windows audio driver resets and camera disconnections.

### ⚡ 3. Zero-Freeze Decoupled Pipeline
* **60 FPS Native Video + Overlay Renderer:** Video frames render at high frame rates with zero UI stutter.
* **Decoupled ML Inference Worker:** ML evaluations execute in a decoupled 180ms snapshot loop using standard DOM canvas downscaling (320x240), preventing main-thread freezes.
* **Continuous Stream Keep-Alive:** Fully visible video layout engine configuration prevents Chromium's power-saver mode from suspending frame decoding during multi-hour study sessions.
* **Automatic Memory Reclamation:** Encapsulates all tensor allocations in `tf.engine().startScope()` and `tf.engine().endScope()` to eliminate memory leaks.

### 📊 4. Focus Analytics & Finite State Machine
* **Temporal Debounce FSM:** Smooth state transitions (IDLE -> FOCUSED -> WARNING -> ALARM -> PAUSED) prevent false-alarm flashing.
* **Customizable Timers:**
  * **Alarm Delay Slider:** 2.0s to 15.0s (default: 5.0s).
  * **Focus Recovery Slider:** 1.0s to 5.0s (default: 1.5s).
* **Live Study Metrics:** Displays total **Focused Time**, **Distracted Time**, and **Total Alert Count** updated in real-time.

### 🔒 5. Privacy First — 100% On-Device
* **No Cloud API Calls:** All inference is executed locally via WebAssembly (WASM) and WebGL.
* **Zero Video Streaming:** Camera frames never leave your local browser instance.
* **Offline Capable:** Works completely without an active internet connection once local models are downloaded.

---

## 🏛 System Architecture

```
                    ┌────────────────────────────────────────────────────────┐
                    │                   Chrome Side Panel                    │
                    └────────────────────────────────────────────────────────┘
                                                │
                                                ▼
                                    ┌───────────────────────┐
                                    │  navigator.mediaDevices │
                                    │     (Webcam Feed)     │
                                    └───────────────────────┘
                                                │
                     ┌──────────────────────────┴──────────────────────────┐
                     ▼                                                     ▼
        ┌─────────────────────────┐                           ┌─────────────────────────┐
        │   High-Speed Renderer   │                           │   ML Inference Engine   │
        │   (requestAnimationFrame)│                          │      (180ms Worker)     │
        │   • 30–60 FPS Canvas    │                           │   • 320x240 Snapshot    │
        │   • Real-time Face Mesh │                           │   • WebGL / CPU WASM    │
        │   • Phone Bounding Boxes│                           │   • Memory Scope Guard  │
        └─────────────────────────┘                           └─────────────────────────┘
                     │                                                     │
                     │                                                     ▼
                     │                                        ┌─────────────────────────┐
                     │                                        │ COCO-SSD + FaceMesh     │
                     │                                        │ • Phone / Remote BBoxes │
                     │                                        │ • 3D Pose (Pitch/Yaw)   │
                     │                                        │ • Ear Proximity Call    │
                     │                                        └─────────────────────────┘
                     │                                                     │
                     │                                                     ▼
                     │                                        ┌─────────────────────────┐
                     │                                        │  State Manager (FSM)    │
                     │                                        │  • Temporal Debouncing  │
                     │                                        │  • Dynamic Progress Bar │
                     │                                        └─────────────────────────┘
                     │                                                     │
                     └──────────────────────────┬──────────────────────────┘
                                                ▼
                                    ┌───────────────────────┐
                                    │   Audio Alert Dispatch│
                                    │  • Custom Audio File  │
                                    │  • Chrome TTS Fallback│
                                    └───────────────────────┘
```

---

## 🛠 Technology Stack

| Layer | Technologies |
|---|---|
| **Extension Platform** | Manifest V3, Chrome Side Panel API, Chrome Storage Sync/Local, Chrome TTS |
| **Machine Learning** | TensorFlow.js, COCO-SSD (lite_mobilenet_v2), MediaPipe Tasks Vision (`FaceLandmarker`) |
| **Execution Backends** | WebAssembly (WASM) Delegate, WebGL Acceleration, HTML5 2D Canvas |
| **Frontend & Styling** | Vanilla Modern JavaScript (ES6+ Modules), HTML5 Video, CSS3 Glassmorphism |
| **Build System** | Vite 5, Rollup, `vite-plugin-static-copy` |

---

## 🚀 Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/) (version 18.0.0 or higher)
* [Google Chrome](https://www.google.com/chrome/) (version 114+ for Side Panel API support)

### 1. Clone the Repository
```bash
git clone https://github.com/navjeets1/AI-Study-Alarm-System.git
cd AI-Study-Alarm-System
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Download Offline ML Models (~14 MB)
```bash
npm run setup
```
*This downloads the COCO-SSD model weights and MediaPipe FaceLandmarker task file into `public/models/` for 100% offline functionality.*

### 4. Build the Extension
```bash
npm run build
```
The compiled, self-contained extension will be generated in the **`dist/`** directory.

> **Development Mode:** To automatically rebuild on file changes, run:
> ```bash
> npm run dev
> ```

---

## 📦 Load in Chrome

1. Open Google Chrome and navigate to:
   ```text
   chrome://extensions
   ```
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click the **Load unpacked** button in the top-left.
4. Select the **`dist`** folder inside your project directory.
5. Click the **Extensions puzzle icon** in Chrome's toolbar and pin **Study Focus Guard**.
6. Click the **Study Focus Guard** icon to open the Side Panel.
7. Click **Start**, grant camera access on the one-time prompt, and you're ready to study!

---

## ⚙️ Configuration & Settings

Inside the extension's **Settings** panel, you can customize:

| Setting | Range / Options | Description |
|---|---|---|
| **Alarm Delay** | `2.0s` – `15.0s` (Step: `0.5s`) | How long you must be distracted before the audio alarm sounds. |
| **Focus Recovery** | `1.0s` – `5.0s` (Step: `0.5s`) | Duration you must look back at the screen to reset the warning/alarm state. |
| **Alarm Sound** | Custom File / TTS Voice | Upload your own `.mp3` / `.wav` sound or use Chrome's Text-To-Speech voice. |
| **Mute Alarm** | On / Off | Silence alarms while keeping visual distraction tracking active. |
| **Hide Camera** | On / Off | Collapse the live camera preview for reduced distraction while keeping AI tracking running. |

---

## 📁 Project Directory Structure

```text
study-focus-guard/
├── .github/
│   ├── workflows/
│   │   └── build.yml               # Automated CI build verification
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md           # Issue template for bugs
│   │   └── feature_request.md      # Issue template for enhancements
│   └── pull_request_template.md    # Pull request guideline template
├── icons/                          # Extension icons (16x16, 48x48, 128x128)
├── public/
│   └── models/                     # Offline ML models (downloaded via npm run setup)
├── scripts/
│   └── download-models.mjs         # Automated model downloader utility
├── src/
│   ├── audioAlert.js               # Custom audio player & Chrome TTS coordinator
│   ├── main.js                     # UI bootstrap, 60 FPS renderer, session lifecycle
│   ├── stateManager.js             # Temporal debounce Finite State Machine
│   └── visionEngine.js             # TF.js & MediaPipe computer vision pipeline
├── background.js                   # MV3 Service Worker for Side Panel management
├── manifest.json                   # Chrome Extension Manifest V3 configuration
├── package.json                    # Project configuration, scripts, and dependencies
├── permission.html                 # Fallback tab for explicit one-time camera grants
├── permission.js                   # Permission handler script
├── sidepanel.css                   # Responsive dark-mode styling
├── sidepanel.html                  # Main side panel DOM interface
├── vite.config.js                  # Vite bundler & static asset pipeline config
├── .gitignore                      # Git ignore rules for node_modules and builds
├── CONTRIBUTING.md                 # Contribution guidelines
├── LICENSE                         # MIT License
└── README.md                       # Project documentation
```

---

## 🛡️ Security & Content Security Policy (CSP)

Study Focus Guard adheres strictly to Google Chrome Manifest V3 security standards:
* **No Dynamic Code Injection:** No `eval()` or `new Function()` in extension context.
* **Permitted WASM Policy:** Uses `"script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"` solely to enable local WebAssembly acceleration for TensorFlow.js and MediaPipe.
* **No Remote Scripts:** All JavaScript code, stylesheets, and model weights are bundled locally inside the extension.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to open an issue or submit a pull request:
1. Fork the Project.
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`).
3. Commit your Changes (`git commit -m 'feat: add amazing feature'`).
4. Push to the Branch (`git push origin feature/AmazingFeature`).
5. Open a Pull Request.

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for full details.

---

## 📄 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.
