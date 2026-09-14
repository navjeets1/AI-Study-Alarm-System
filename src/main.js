/**
 * main.js
 * ─────────────────────────────────────────────────────────────
 * Side Panel bootstrap — wires together the vision engine,
 * state manager, audio alert, and the UI DOM.
 *
 * Flow:
 *   1. On load: check if permission request tab, or initialise VisionEngine
 *   2. User clicks "Start" → open webcam, start session
 *   3. If camera permission is blocked/dismissed in sidepanel → show permission modal & open grant tab
 *   4. rAF loop: detect frame → update FSM → update UI
 *   5. FSM fires alarm → AudioAlert plays / stops automatically
 */

import { VisionEngine }  from './visionEngine.js';
import { StateManager, State } from './stateManager.js';
import { AudioAlert }    from './audioAlert.js';

// ── Filter non-fatal MediaPipe WASM C++ internal logs ─────────
const origWarn = console.warn;
console.warn = function (...args) {
  const m = args.map((a) => String(a || '')).join(' ');
  if (
    m.includes('FaceBlendshapesGraph') ||
    m.includes('OpenGL error') ||
    m.includes('gl_context') ||
    m.includes('xnnpack')
  ) {
    return;
  }
  origWarn.apply(console, args);
};

// ══════════════════════════════════════════════════════════════
//  DOM refs
// ══════════════════════════════════════════════════════════════
const $ = (id) => document.getElementById(id);

const el = {
  video:            $('webcamVideo'),
  canvas:           $('overlayCanvas'),
  cameraContainer:  $('cameraContainer'),
  cameraOverlay:    $('cameraOverlay'),

  statusCard:       $('statusCard'),
  statusDot:        $('statusDot'),
  statusLabel:      $('statusLabel'),

  countdownWrap:    $('countdownWrap'),
  countdownText:    $('countdownText'),
  progressFill:     $('progressFill'),
  progressGlow:     $('progressGlow'),
  progressBar:      $('progressBar'),
  detectionTags:    $('detectionTags'),

  sessionTimer:     $('sessionTimer'),

  startBtn:         $('startBtn'),
  pauseBtn:         $('pauseBtn'),
  resetBtn:         $('resetBtn'),

  alarmSlider:      $('alarmSlider'),
  alarmValue:       $('alarmValue'),
  recoverySlider:   $('recoverySlider'),
  recoveryValue:    $('recoveryValue'),

  muteToggle:       $('muteToggle'),
  videoToggle:      $('videoToggle'),
  toggleVideoBtn:   $('toggleVideoBtn'),

  settingsToggle:   $('settingsToggle'),
  settingsBody:     $('settingsBody'),
  settingsChevron:  $('settingsChevron'),

  statFocused:      $('statFocused'),
  statDistracted:   $('statDistracted'),
  statAlerts:       $('statAlerts'),

  loadingOverlay:   $('loadingOverlay'),
  loadingTitle:     $('loadingTitle'),
  loadingSub:       $('loadingSub'),
  loadingProgressFill: $('loadingProgressFill'),
  loadingSpinner:   $('loadingSpinner'),
  retryBtn:         $('retryBtn'),

  permissionOverlay: $('permissionOverlay'),
  grantPermBtn:      $('grantPermBtn'),
  cancelPermBtn:     $('cancelPermBtn'),

  errorToast:       $('errorToast'),

  // Custom alarm sound picker
  selectSoundBtn:   $('selectSoundBtn'),
  soundFileInput:   $('soundFileInput'),
  soundFileName:    $('soundFileName'),
  soundModeLabel:   $('soundModeLabel'),
  previewSoundBtn:  $('previewSoundBtn'),
  clearSoundBtn:    $('clearSoundBtn'),
};

// ══════════════════════════════════════════════════════════════
//  Module instances
// ══════════════════════════════════════════════════════════════
const vision  = new VisionEngine();
const fsm     = new StateManager();
const audio   = new AudioAlert();

// ══════════════════════════════════════════════════════════════
//  App state
// ══════════════════════════════════════════════════════════════
let stream             = null;   // MediaStream
let inferenceTimeoutId = null;   // setTimeout handle for decoupled loop
let renderRafId        = null;   // requestAnimationFrame handle for decoupled high-speed renderer
let sessionStart       = null;   // Date.now() when session began
let timerInterval      = null;   // setInterval for session clock
let keepAliveInterval  = null;   // setInterval to ping video.play() every 5s to prevent Chrome suspension
let videoVisible       = true;
let isMuted            = false;
let settingsOpen       = true;
let modelsReady        = false;
let sessionActive      = false;
let isProcessing       = false;

// ══════════════════════════════════════════════════════════════
//  Startup — load models
// ══════════════════════════════════════════════════════════════
async function init() {
  // Reset overlay state
  el.loadingTitle.textContent = 'Loading AI Models…';
  el.loadingSub.textContent   = 'Initializing TensorFlow.js & MediaPipe';
  el.loadingProgressFill.style.width = '0%';
  if (el.loadingSpinner) el.loadingSpinner.style.display = 'block';
  if (el.retryBtn) el.retryBtn.style.display = 'none';

  // Load saved settings from chrome.storage
  await loadSettings();

  // Wire UI event listeners before model load
  bindUI();

  // Start model loading progress updates
  vision.onProgress = (pct, msg) => {
    el.loadingProgressFill.style.width = pct + '%';
    el.loadingSub.textContent = msg;
    if (pct === 100) el.loadingTitle.textContent = 'Ready!';
  };

  try {
    const base = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
      ? chrome.runtime.getURL('')
      : '';

    console.log('[StudyFocusGuard] Initializing Vision Engine with base:', base);
    await vision.init(base);
    modelsReady = true;

    // Dismiss loading overlay smoothly
    el.loadingOverlay.classList.add('hidden');
    setTimeout(() => { el.loadingOverlay.style.display = 'none'; }, 450);

    showToast('✓ AI models loaded — click Start to begin');

    // Listen for the camera-granted signal relayed by background.js
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'CAMERA_READY') {
          if (el.permissionOverlay) {
            el.permissionOverlay.classList.add('hidden');
            el.permissionOverlay.style.display = 'none';
          }
          showToast('✓ Camera access granted — starting session…', 3000);
          setTimeout(() => startSession(), 600);
        }
      });
    }
  } catch (err) {
    console.error('[StudyFocusGuard] Model init error:', err);
    el.loadingTitle.textContent = 'Model Load Error';
    el.loadingSub.textContent   = err.message || String(err);
    if (el.loadingSpinner) el.loadingSpinner.style.display = 'none';
    if (el.retryBtn) el.retryBtn.style.display = 'inline-block';
    showToast('⚠ Model load failed. Click Retry or check extension permissions.', 8000);
  }
}

// ══════════════════════════════════════════════════════════════
//  Settings persistence
// ══════════════════════════════════════════════════════════════
async function loadSettings() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;

  const stored = await chrome.storage.sync.get({
    alarmThresholdSec:    5.0,
    recoveryThresholdSec: 1.5,
    muted:                false,
    videoVisible:         true,
  });

  el.alarmSlider.value    = stored.alarmThresholdSec;
  el.recoverySlider.value = stored.recoveryThresholdSec;
  el.alarmValue.textContent    = stored.alarmThresholdSec.toFixed(1) + 's';
  el.recoveryValue.textContent = stored.recoveryThresholdSec.toFixed(1) + 's';

  fsm.setAlarmThreshold(stored.alarmThresholdSec);
  fsm.setRecoveryThreshold(stored.recoveryThresholdSec);

  isMuted      = stored.muted;
  videoVisible = stored.videoVisible;

  applyMute(isMuted);
  applyVideoVisible(videoVisible);

  // Load custom alarm audio from local storage (large binary, not sync)
  try {
    const localStored = await chrome.storage.local.get({ customAlarmDataUrl: null, customAlarmFileName: null });
    if (localStored.customAlarmDataUrl) {
      applyCustomSound(localStored.customAlarmDataUrl, localStored.customAlarmFileName || 'Custom Sound');
    }
  } catch (_) {}
}

function saveSettings() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.sync.set({
    alarmThresholdSec:    parseFloat(el.alarmSlider.value),
    recoveryThresholdSec: parseFloat(el.recoverySlider.value),
    muted:    isMuted,
    videoVisible,
  });
}

/**
 * Apply a custom alarm sound — update AudioAlert and refresh the UI.
 * @param {string|null} dataUrl - base64 data URL or null to revert to TTS
 * @param {string}      name    - filename to display
 */
function applyCustomSound(dataUrl, name) {
  audio.setCustomAudio(dataUrl);

  if (dataUrl) {
    el.soundFileName.textContent = name;
    el.soundFileName.classList.add('has-file');
    el.soundModeLabel.textContent = '🎵 Custom';
    el.previewSoundBtn.disabled = false;
    el.clearSoundBtn.disabled   = false;
  } else {
    el.soundFileName.textContent = 'No file chosen';
    el.soundFileName.classList.remove('has-file');
    el.soundModeLabel.textContent = 'TTS Voice';
    el.previewSoundBtn.disabled = true;
    el.clearSoundBtn.disabled   = true;
  }
}

// ══════════════════════════════════════════════════════════════
//  UI event wiring
// ══════════════════════════════════════════════════════════════
function bindUI() {
  if (el._bound) return;
  el._bound = true;

  // ── Session controls ──
  el.startBtn.addEventListener('click', startSession);
  el.pauseBtn.addEventListener('click', pauseSession);
  el.resetBtn.addEventListener('click', resetSession);

  if (el.retryBtn) {
    el.retryBtn.addEventListener('click', init);
  }

  // ── Permission modal handlers ──
  if (el.grantPermBtn) {
    el.grantPermBtn.addEventListener('click', openCameraPermissionTab);
  }
  if (el.cancelPermBtn) {
    el.cancelPermBtn.addEventListener('click', () => {
      if (el.permissionOverlay) el.permissionOverlay.classList.add('hidden');
    });
  }

  // ── Alarm threshold slider ──
  el.alarmSlider.addEventListener('input', () => {
    const v = parseFloat(el.alarmSlider.value);
    el.alarmValue.textContent = v.toFixed(1) + 's';
    fsm.setAlarmThreshold(v);
    saveSettings();
  });

  // ── Recovery threshold slider ──
  el.recoverySlider.addEventListener('input', () => {
    const v = parseFloat(el.recoverySlider.value);
    el.recoveryValue.textContent = v.toFixed(1) + 's';
    fsm.setRecoveryThreshold(v);
    saveSettings();
  });

  // ── Mute toggle ──
  el.muteToggle.addEventListener('click', () => {
    isMuted = !isMuted;
    applyMute(isMuted);
    saveSettings();
  });

  // ── Video visibility toggle (header button) ──
  el.toggleVideoBtn.addEventListener('click', () => {
    videoVisible = !videoVisible;
    applyVideoVisible(videoVisible);
    saveSettings();
  });

  // ── Video visibility toggle (settings toggle) ──
  el.videoToggle.addEventListener('click', () => {
    videoVisible = !videoVisible;
    applyVideoVisible(videoVisible);
    saveSettings();
  });

  // ── Settings collapsible ──
  el.settingsToggle.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    el.settingsBody.classList.toggle('collapsed', !settingsOpen);
    el.settingsChevron.classList.toggle('collapsed', !settingsOpen);
    el.settingsToggle.setAttribute('aria-expanded', settingsOpen);
  });

  el.settingsToggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') el.settingsToggle.click();
  });

  // ── Custom alarm sound picker ──────────────────────────────────────────────
  // "Choose File" button opens hidden file input
  el.selectSoundBtn.addEventListener('click', () => {
    el.soundFileInput.value = ''; // reset so same file can be re-selected
    el.soundFileInput.click();
  });

  // File selected — read as base64 data URL, persist, apply
  el.soundFileInput.addEventListener('change', () => {
    const file = el.soundFileInput.files[0];
    if (!file) return;

    // Validate it's an audio file
    if (!file.type.startsWith('audio/')) {
      showToast('⚠ Please choose an audio file (.mp3, .wav, .ogg, etc.)', 4000);
      return;
    }

    // Limit to 10 MB to avoid storage quota errors
    if (file.size > 10 * 1024 * 1024) {
      showToast('⚠ File too large — please choose a file under 10 MB.', 4000);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const name    = file.name;

      // Apply immediately
      applyCustomSound(dataUrl, name);
      showToast(`✓ Alarm sound set: ${name}`, 3000);

      // Persist to local storage (large binary, not sync)
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ customAlarmDataUrl: dataUrl, customAlarmFileName: name })
          .catch((err) => console.warn('[StudyFocusGuard] Could not save alarm sound:', err));
      }
    };
    reader.readAsDataURL(file);
  });

  // Preview button — play the sound once
  el.previewSoundBtn.addEventListener('click', () => {
    audio.previewCustomAudio();
  });

  // Clear button — revert to TTS
  el.clearSoundBtn.addEventListener('click', () => {
    applyCustomSound(null, '');
    showToast('✓ Reverted to TTS voice alert', 2500);
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.remove(['customAlarmDataUrl', 'customAlarmFileName']);
    }
  });

  // ── FSM callbacks ──
  fsm.onStateChange = onStateChange;
  fsm.onAlarm       = onAlarmFired;
  fsm.onRecover     = onAlarmRecovered;
}

function openCameraPermissionTab() {
  if (el.permissionOverlay) el.permissionOverlay.classList.add('hidden');
  const url = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
    ? chrome.runtime.getURL('permission.html')
    : 'permission.html';

  if (typeof chrome !== 'undefined' && chrome.tabs) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, '_blank');
  }
}

// ══════════════════════════════════════════════════════════════
//  Camera helpers
// ══════════════════════════════════════════════════════════════

/**
 * Retains strong references to the stream and silently re-acquires camera
 * if Chrome kills the track, WITHOUT resetting the UI or asking for permissions.
 */
function watchStreamTracks(mediaStream) {
  window._activeStream = mediaStream;
  mediaStream.getVideoTracks().forEach((track) => {
    window._activeTrack = track;
    track.onended = async () => {
      console.warn('[StudyFocusGuard] Camera track ended — silently re-acquiring...');
      if (!sessionActive) return;
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
          audio: false,
        });
        stream = newStream;
        el.video.srcObject = newStream;
        window._activeStream = newStream;
        window._activeTrack  = newStream.getVideoTracks()[0];
        if (window._activeTrack) {
          window._activeTrack.onended = track.onended; // re-attach
        }
        await el.video.play().catch(() => {});
        console.log('[StudyFocusGuard] Camera re-acquired silently.');
      } catch (err) {
        console.warn('[StudyFocusGuard] Silent re-acquire failed:', err.name);
      }
    };
  });
}

/**
 * Waits until the video element is ready to play frames.
 * Handles both the case where loadeddata fires later and where it already fired.
 */
async function waitForVideoReady(video) {
  if (video.readyState >= 2) return; // HAVE_CURRENT_DATA or better
  return new Promise((resolve) => {
    const handler = () => {
      video.removeEventListener('loadeddata', handler);
      video.removeEventListener('canplay', handler);
      resolve();
    };
    video.addEventListener('loadeddata', handler);
    video.addEventListener('canplay', handler);
  });
}

// ══════════════════════════════════════════════════════════════
//  Session control
// ══════════════════════════════════════════════════════════════
async function startSession() {
  if (!modelsReady) {
    showToast('⏳ Models still loading, please wait…');
    return;
  }

  if (sessionActive) return;

  // Pre-warm the AudioContext with a silent sound on the user-gesture click.
  // This prevents Chrome from suspending audio/camera when the alarm later fires.
  audio.prewarm?.();

  // Check if existing stream is still live
  const streamOk = stream
    && stream.active
    && stream.getVideoTracks().some((t) => t.readyState === 'live');

  if (!streamOk) {
    try {
      // Stop dead tracks cleanly before re-acquiring
      if (stream) {
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        stream = null;
        el.video.srcObject = null;
      }

      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });

      // Watch for Chrome killing the track in the background
      watchStreamTracks(stream);

    } catch (err) {
      console.log('[StudyFocusGuard] getUserMedia failed — showing permission modal:', err.name);
      if (el.permissionOverlay) {
        el.permissionOverlay.classList.remove('hidden');
        el.permissionOverlay.style.display = 'flex';
      } else {
        openCameraPermissionTab();
      }
      showToast('⚠ Camera permission required. Please grant access in the opened tab.', 6000);
      return;
    }
  }

  // Attach stream to video element if not already
  if (el.video.srcObject !== stream) {
    el.video.srcObject = stream;
  }

  // Set all critical video properties to prevent Chrome from suspending decoding
  el.video.muted        = true;
  el.video.playsInline  = true;
  el.video.autoplay     = true;
  el.video.controls     = false;
  el.video.disablePictureInPicture = true;
  if ('disableRemotePlayback' in el.video) el.video.disableRemotePlayback = true;

  // Add stall/suspend recovery listeners — remove any previous ones first to prevent stacking.
  // Each Start/Resume call would otherwise add a new listener on top of existing ones.
  if (el.video._restartPlay) {
    el.video.removeEventListener('suspend',   el.video._restartPlay);
    el.video.removeEventListener('stalled',   el.video._restartPlay);
    el.video.removeEventListener('pause',     el.video._restartPlay);
    el.video.removeEventListener('emptied',   el.video._restartPlay);
  }
  el.video._restartPlay = () => {
    // Small delay so transient audio-routing resets don't race with readyState
    setTimeout(() => {
      if (sessionActive && (el.video.paused || el.video.readyState < 2)) {
        el.video.play().catch(() => {});
      }
    }, 100);
  };
  el.video.addEventListener('suspend',   el.video._restartPlay);
  el.video.addEventListener('stalled',   el.video._restartPlay);
  el.video.addEventListener('pause',     el.video._restartPlay);
  el.video.addEventListener('emptied',   el.video._restartPlay);

  // Wait for video to have frame data (race-safe)
  await waitForVideoReady(el.video);

  // Ensure playback is running
  if (el.video.paused) {
    try { await el.video.play(); } catch (playErr) {
      console.log('[StudyFocusGuard] video.play() note:', playErr.name);
    }
  }

  // Hide the camera placeholder overlay
  el.cameraOverlay.classList.add('hidden');

  vision.resetFaceTimer();
  fsm.start();
  sessionActive = true;

  // Accumulate session clock (don't reset if resuming)
  if (!sessionStart) sessionStart = Date.now();
  if (!timerInterval) timerInterval = setInterval(updateSessionClock, 1000);

  // Update button states
  el.startBtn.disabled = true;
  el.startBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    Start
  `;
  el.pauseBtn.disabled = false;

  // Start high-speed decoupled renderer and inference loops
  runRenderLoop();
  runInferenceLoop();

  // ── Keep-alive ping every 5 seconds ───────────────────────────────────────
  // Prevents Chrome from suspending video frame decoding in background tabs/panels.
  // Calls video.play() to keep the HTMLVideoElement pipeline warm.
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(async () => {
    if (!sessionActive) return;
    if (el.video.paused || el.video.ended) {
      try { await el.video.play(); } catch (_) {}
    }
    // Also verify stream tracks are still live
    const tracksLive = stream?.getVideoTracks().some(t => t.readyState === 'live');
    if (!tracksLive && stream) {
      console.warn('[StudyFocusGuard] KeepAlive: stream tracks not live, triggering re-acquire...');
      stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
          audio: false,
        });
        watchStreamTracks(stream);
        el.video.srcObject = stream;
        await el.video.play().catch(() => {});
        console.log('[StudyFocusGuard] KeepAlive: stream re-acquired.');
      } catch (err) {
        console.warn('[StudyFocusGuard] KeepAlive re-acquire failed:', err.name);
      }
    }
  }, 5000);
}

function pauseSession() {
  if (!sessionActive) return;

  fsm.pause();
  audio.stopAlert();
  sessionActive = false;

  if (renderRafId) {
    cancelAnimationFrame(renderRafId);
    renderRafId = null;
  }
  if (inferenceTimeoutId) {
    clearTimeout(inferenceTimeoutId);
    inferenceTimeoutId = null;
  }
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  isProcessing = false;

  // Clear visual overlays on pause
  const ctx = el.canvas.getContext('2d');
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  vision.clearLastResult();

  // Keep stream alive so Resume works instantly without re-granting camera
  el.startBtn.disabled = false;
  el.startBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    Resume
  `;
  el.pauseBtn.disabled = true;
}

function resetSession() {
  if (renderRafId) {
    cancelAnimationFrame(renderRafId);
    renderRafId = null;
  }
  if (inferenceTimeoutId) {
    clearTimeout(inferenceTimeoutId);
    inferenceTimeoutId = null;
  }
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  isProcessing = false;

  // Fully stop camera tracks on reset (user-initiated)
  if (stream) {
    stream.getVideoTracks().forEach((t) => { t.onended = null; });
    stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    stream = null;
    el.video.srcObject = null;
    window._activeStream = null;
    window._activeTrack  = null;
  }

  audio.stopAlert();
  clearInterval(timerInterval);
  timerInterval = null;
  sessionStart = null;

  fsm.reset();
  vision.resetFaceTimer();
  sessionActive = false;

  // Clear visual overlays on reset
  const ctx = el.canvas.getContext('2d');
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  vision.clearLastResult();

  el.startBtn.disabled = false;
  el.startBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    Start
  `;
  el.pauseBtn.disabled = true;
  el.sessionTimer.textContent = '00:00:00';
  el.countdownWrap.style.display = 'none';
  el.detectionTags.innerHTML = '';
  el.cameraOverlay.classList.remove('hidden');
  setStatusUI(State.IDLE);
  updateStatsUI({ focusedMs: 0, distractedMs: 0, alarmCount: 0 });
}

// ══════════════════════════════════════════════════════════════
//  Main decoupled loops (Rendering and ML Inference)
// ══════════════════════════════════════════════════════════════
let _inferFrameCount  = 0;

/**
 * Rendering loop — draws detection overlays at 30-60 FPS.
 * Also monitors video playback state every frame and recovers immediately
 * if Chrome suspends/pauses the video element.
 */
function runRenderLoop() {
  if (!sessionActive) return;

  try {
    // Immediately restart video if Chrome paused or stalled it
    if (el.video.paused || el.video.ended) {
      el.video.play().catch(() => {});
    }
    vision.drawScene(el.video, el.canvas);
  } catch (err) {
    console.error('[StudyFocusGuard] Render loop error:', err);
  }

  if (sessionActive) {
    renderRafId = requestAnimationFrame(runRenderLoop);
  }
}

async function runInferenceLoop() {
  if (!sessionActive) return;

  // Concurrency Lock: if a previous model evaluation is still running,
  // skip this tick and defer scheduling the next frame to prevent overlaps.
  if (isProcessing) {
    if (sessionActive) {
      inferenceTimeoutId = setTimeout(runInferenceLoop, 150);
    }
    return;
  }

  isProcessing = true;

  try {
    // Health check: ensure video is playing
    if (el.video.readyState >= 2 && el.video.paused) {
      try { await el.video.play(); } catch (_) {}
    }

    if (el.video.readyState >= 2) {
      _inferFrameCount++;

      // Run ML inference on the snapshot of the video frame
      const result    = await vision.detectFrame(el.video, el.canvas);
      const fsmResult = fsm.update(result.isDistracted);

      updateCountdownUI(fsmResult, result);
      updateStatsUI(fsmResult.stats);
      updateDetectionTags(result);

      // Memory monitoring: log tensor counts to ensure stability
      if (_inferFrameCount % 30 === 0) {
        const mem = vision.getMemoryInfo();
        console.log(`[StudyFocusGuard] TF.js Memory Check - Tensors: ${mem.numTensors}, Bytes: ${mem.numBytes}`);
      }
    }
  } catch (err) {
    console.error('[StudyFocusGuard] Error inside main decoupled loop:', err);
  } finally {
    isProcessing = false;
    // Decoupled schedule: run next ML inference frame in ~180ms
    if (sessionActive) {
      inferenceTimeoutId = setTimeout(runInferenceLoop, 180);
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  UI update helpers
// ══════════════════════════════════════════════════════════════
function onStateChange(newState, prevState) {
  setStatusUI(newState);
  const showCountdown = newState === State.WARNING || newState === State.ALARM;
  el.countdownWrap.style.display = showCountdown ? 'flex' : 'none';
}

function onAlarmFired() {
  audio.playAlert();
  document.body.classList.add('alarm-active');
  setTimeout(() => document.body.classList.remove('alarm-active'), 600);
}

async function onAlarmRecovered() {
  audio.stopAlert();
}

function setStatusUI(state) {
  const dotEl   = el.statusDot;
  const labelEl = el.statusLabel;
  const cardEl  = el.statusCard;

  dotEl.className   = 'status-dot';
  cardEl.className  = 'status-card';

  switch (state) {
    case State.IDLE:
      dotEl.classList.add('dot-idle');
      labelEl.textContent = 'Ready to Start';
      break;
    case State.FOCUSED:
      dotEl.classList.add('dot-focused');
      labelEl.textContent = '✓ Focused';
      cardEl.classList.add('state-focused');
      break;
    case State.WARNING:
      dotEl.classList.add('dot-warning');
      labelEl.textContent = '⚠ Distraction Detected';
      cardEl.classList.add('state-warning');
      break;
    case State.ALARM:
      dotEl.classList.add('dot-alarm');
      labelEl.textContent = '🔔 ALARM — Refocus Now!';
      cardEl.classList.add('state-alarm');
      break;
    case State.PAUSED:
      dotEl.classList.add('dot-idle');
      labelEl.textContent = '⏸ Session Paused';
      break;
  }
}

function updateCountdownUI(fsmResult, visionResult) {
  if (fsmResult.state !== State.WARNING && fsmResult.state !== State.ALARM) return;

  const elapsed  = (fsmResult.distractedMs / 1000).toFixed(1);
  const total    = (fsmResult.alarmThresholdMs / 1000).toFixed(1);
  const pct      = Math.min(fsmResult.progress * 100, 100).toFixed(0);

  el.countdownText.textContent = `Distracted: ${elapsed}s / ${total}s`;
  el.progressFill.style.width  = pct + '%';
  el.progressBar.setAttribute('aria-valuenow', pct);

  if (fsmResult.progress > 0.75) {
    el.progressFill.classList.add('fill-alarm');
  } else {
    el.progressFill.classList.remove('fill-alarm');
  }
}

function updateDetectionTags(result) {
  const tags = [];

  if (!result.isDistracted) {
    tags.push(`<span class="tag tag-focused">🟢 Focused</span>`);
  } else {
    if (result.phoneDetected) {
      tags.push(`<span class="tag tag-distracted">🔴 Distracted: Phone in Hand</span>`);
    }
    if (result.phoneOnCall) {
      tags.push(`<span class="tag tag-distracted">🔴 Distracted: Phone on Call</span>`);
    }
    if (result.lookingDown) {
      tags.push(`<span class="tag tag-distracted">🔴 Distracted: Looking Down</span>`);
    }
    if (result.lookingUp) {
      tags.push(`<span class="tag tag-distracted">🔴 Distracted: Looking Up</span>`);
    }
    if (result.lookingLeft) {
      tags.push(`<span class="tag tag-distracted">🔴 Distracted: Looking Left</span>`);
    }
    if (result.lookingRight) {
      tags.push(`<span class="tag tag-distracted">🔴 Distracted: Looking Right</span>`);
    }
    if (result.noFace) {
      tags.push(`<span class="tag tag-distracted">🔴 Distracted: No Face Detected</span>`);
    }
  }

  el.detectionTags.innerHTML = tags.join('');
}

function updateStatsUI(stats) {
  el.statFocused.textContent    = msToMMSS(stats.focusedMs);
  el.statDistracted.textContent = msToMMSS(stats.distractedMs);
  el.statAlerts.textContent     = stats.alarmCount;
}

function updateSessionClock() {
  if (!sessionStart) return;
  const elapsed = Date.now() - sessionStart;
  el.sessionTimer.textContent = msToHHMMSS(elapsed);
}

function applyMute(muted) {
  isMuted = muted;
  audio.setMuted(muted);
  el.muteToggle.setAttribute('aria-checked', muted ? 'true' : 'false');
}

function applyVideoVisible(visible) {
  videoVisible = visible;
  el.cameraContainer.classList.toggle('hidden', !visible);
  el.videoToggle.setAttribute('aria-checked', !visible ? 'true' : 'false');
  el.toggleVideoBtn.classList.toggle('active', !visible);
}

function showToast(msg, duration = 3000) {
  el.errorToast.textContent = msg;
  el.errorToast.style.display = 'block';
  clearTimeout(el.errorToast._timer);
  el.errorToast._timer = setTimeout(() => {
    el.errorToast.style.display = 'none';
  }, duration);
}

function msToHHMMSS(ms) {
  const s   = Math.floor(ms / 1000);
  const hh  = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm  = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss  = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function msToMMSS(ms) {
  const s  = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// ══════════════════════════════════════════════════════════════
//  Bootstrap
// ══════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', init);

window.addEventListener('beforeunload', () => {
  stream?.getTracks().forEach((t) => t.stop());
  audio.dispose();
  vision.dispose();
  if (renderRafId) cancelAnimationFrame(renderRafId);
  if (inferenceTimeoutId) clearTimeout(inferenceTimeoutId);
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (timerInterval) clearInterval(timerInterval);
});
