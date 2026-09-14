/**
 * audioAlert.js
 * ─────────────────────────────────────────────────────────────
 * Synthesizes distraction alerts using either:
 *   1. A user-selected audio file from their system  ← NEW
 *   2. Chrome TTS (Text-to-Speech) as fallback
 *
 * Custom audio is stored as a base64 data URL in chrome.storage.local
 * and played via HTMLAudioElement.
 */

export class AudioAlert {
  constructor() {
    this.isPlaying     = false;
    this.isMuted       = false;
    this._interval     = null;
    this._customDataUrl= null;   // base64 data URL of the custom alarm file
    this._audioEl      = null;   // active <audio> element during playback
  }

  /**
   * Set a custom alarm audio from a base64 data URL.
   * Pass null to clear and fall back to TTS.
   */
  setCustomAudio(dataUrl) {
    this._customDataUrl = dataUrl || null;
    if (this._audioEl) {
      this._audioEl.pause();
      this._audioEl = null;
    }
  }

  /**
   * Preview the custom alarm sound once (no repeat).
   */
  previewCustomAudio() {
    if (!this._customDataUrl) return;
    const el = new Audio(this._customDataUrl);
    el.volume = 1.0;
    el.play().catch(() => {});
  }

  /**
   * Start looping the refocus alert.
   * Uses custom audio if set, otherwise falls back to TTS.
   * Safe to call repeatedly — will not double-start.
   */
  playAlert() {
    if (this.isMuted || this.isPlaying) return;
    this.isPlaying = true;

    if (this._customDataUrl) {
      this._playCustomLoop();
    } else {
      this._playTtsLoop();
    }
  }

  _playCustomLoop() {
    if (!this.isPlaying || this.isMuted) return;

    this._audioEl = new Audio(this._customDataUrl);
    this._audioEl.volume = 1.0;
    this._audioEl.play().catch(() => {});

    // Repeat after the clip ends with a short gap
    this._audioEl.onended = () => {
      if (this.isPlaying && !this.isMuted) {
        this._interval = setTimeout(() => this._playCustomLoop(), 800);
      }
    };
  }

  _playTtsLoop() {
    const speak = () => {
      if (!this.isPlaying || this.isMuted) return;
      if (typeof chrome !== 'undefined' && chrome.tts) {
        chrome.tts.isSpeaking((speaking) => {
          if (!speaking && this.isPlaying && !this.isMuted) {
            chrome.tts.speak('Please refocus!', {
              rate: 1.0,
              volume: 1.0,
            });
          }
        });
      }
    };

    speak();
    this._interval = setInterval(speak, 2500);
  }

  /**
   * Stop the refocus alert.
   */
  stopAlert() {
    this.isPlaying = false;

    // Stop custom audio element
    if (this._audioEl) {
      this._audioEl.pause();
      this._audioEl.onended = null;
      this._audioEl = null;
    }

    // Clear any pending repeat timers
    if (this._interval) {
      clearInterval(this._interval);
      clearTimeout(this._interval);
      this._interval = null;
    }

    // Only call chrome.tts.stop() in TTS mode AND only if TTS is actually speaking.
    // Calling tts.stop() unconditionally sends an IPC to Windows SAPI which resets
    // the audio subsystem, causes a WASAPI device endpoint re-enumeration, and can
    // physically disconnect and reconnect the USB/integrated camera hardware.
    if (!this._customDataUrl && typeof chrome !== 'undefined' && chrome.tts) {
      chrome.tts.isSpeaking((speaking) => {
        if (speaking) chrome.tts.stop();
      });
    }
  }

  /**
   * Play a brief warning notification.
   */
  playWarningBlip() {
    if (this.isMuted) return;
    if (typeof chrome !== 'undefined' && chrome.tts) {
      chrome.tts.speak('Warning!', {
        rate: 1.3,
        volume: 0.8,
        enqueue: false
      });
    }
  }

  /**
   * Pre-warm API.
   */
  prewarm() {
    console.log('[StudyFocusGuard] AudioAlert prewarm called');
  }

  setMuted(muted) {
    this.isMuted = muted;
    if (muted && this.isPlaying) {
      this.stopAlert();
    }
  }

  dispose() {
    this.stopAlert();
  }
}
