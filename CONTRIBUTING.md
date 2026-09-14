# Contributing to Study Focus Guard

Thank you for your interest in improving **Study Focus Guard**! We welcome contributions, whether it's reporting bugs, improving documentation, submitting feature ideas, or opening pull requests.

---

## 🛠 Local Development Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (v18.0.0 or higher recommended)
- [Google Chrome](https://www.google.com/chrome/) (v114+ with Side Panel support)

### Installation & Build Steps
1. **Clone the repository:**
   ```bash
   git clone https://github.com/navjeets1/AI-Study-Alarm-System.git
   cd AI-Study-Alarm-System
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Download offline ML models:**
   ```bash
   npm run setup
   ```
   *This fetches COCO-SSD and MediaPipe FaceLandmarker models locally.*

4. **Build the extension package:**
   ```bash
   npm run build
   ```
   *To watch for changes during development, run `npm run dev`.*

5. **Load unpacked extension into Chrome:**
   - Open Chrome and go to `chrome://extensions/`.
   - Enable **Developer mode** (top-right toggle).
   - Click **Load unpacked** and select the `dist/` directory inside this project.

---

## 🏛 Architectural Guidelines

When making changes, please respect the decoupled architectural boundaries:

1. **`src/visionEngine.js`**: Handles TensorFlow.js (COCO-SSD) and MediaPipe Tasks Vision (`FaceLandmarker`).
   - Keep model inference isolated in decoupled snapshot loops.
   - Always wrap tensor allocations within `tf.engine().startScope()` and `tf.engine().endScope()` to prevent memory leaks.
   - MediaPipe FaceLandmarker runs in `IMAGE` mode with CPU delegate to eliminate WebGL shader collisions.

2. **`src/stateManager.js`**: Finite State Machine (FSM) controlling temporal debouncing (`IDLE`, `FOCUSED`, `WARNING`, `ALARM`, `PAUSED`).
   - Does not touch DOM or audio directly; communicates strictly via state transitions and callback events.

3. **`src/audioAlert.js`**: Synthesizes and coordinates audio alert notifications.
   - Supports user-uploaded custom audio files and Chrome TTS fallback.
   - Guards speech stop calls with `isSpeaking()` checks to prevent Windows audio driver reset glitches.

4. **`src/main.js`**: Orchestrates UI lifecycle, camera stream management, and high-speed rendering loop (30–60 FPS).

---

## 🤝 Submitting Pull Requests

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Commit your changes with clear, descriptive commit messages:
   ```bash
   git commit -m "feat: add support for customizable notification volumes"
   ```
3. Ensure the project builds cleanly without errors:
   ```bash
   npm run build
   ```
4. Push to your fork and submit a Pull Request describing your changes, motivation, and verification steps.

---

## 📜 License

By contributing to Study Focus Guard, you agree that your contributions will be licensed under the [MIT License](LICENSE).
