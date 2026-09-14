/**
 * stateManager.js
 * ─────────────────────────────────────────────────────────────
 * Finite-state machine for managing the distraction detection state.
 *
 * States:
 *   IDLE      → session not started
 *   FOCUSED   → user is attentive
 *   WARNING   → distraction detected, accumulating time
 *   ALARM     → alarm threshold reached, alert firing
 *   PAUSED    → session paused by user
 *
 * Transitions:
 *   FOCUSED  → WARNING  : distraction detected
 *   WARNING  → ALARM    : distracted_ms >= alarmThresholdMs
 *   WARNING  → FOCUSED  : clear for >= recoveryThresholdMs
 *   ALARM    → FOCUSED  : clear for >= recoveryThresholdMs
 */

export const State = Object.freeze({
  IDLE:    'IDLE',
  FOCUSED: 'FOCUSED',
  WARNING: 'WARNING',
  ALARM:   'ALARM',
  PAUSED:  'PAUSED',
});

export class StateManager {
  constructor() {
    this.state = State.IDLE;

    // Configurable thresholds (milliseconds)
    this.alarmThresholdMs    = 5000;
    this.recoveryThresholdMs = 1500;

    // Timers
    this._distractedStart = null;  // when distraction began
    this._clearStart      = null;  // when focus returned (recovery timer)

    // Session statistics
    this.stats = {
      focusedMs:    0,
      distractedMs: 0,
      alarmCount:   0,
    };

    // Snapshot of last focused/distracted accumulation for stats
    this._lastStatTs = null;
    this._lastStatState = State.IDLE;

    // Callbacks
    this.onStateChange = null;  // (newState, prevState) => void
    this.onAlarm       = null;  // () => void — fires once per alarm event
    this.onRecover     = null;  // () => void — fires when alarm recovers

    this._alarmFired = false;   // prevent repeated onAlarm calls
  }

  /* ── Public API ─────────────────────────────────────────── */

  /** Call every detection frame with the current distraction boolean */
  update(isDistracted) {
    if (this.state === State.IDLE || this.state === State.PAUSED) {
      return this._buildResult(0, 0);
    }

    const now = Date.now();
    this._accumulateStats(now);
    this._lastStatTs = now;
    this._lastStatState = this.state;

    if (isDistracted) {
      return this._handleDistracted(now);
    } else {
      return this._handleFocused(now);
    }
  }

  /** Start or resume a session */
  start() {
    const prev = this.state;
    if (this.state === State.IDLE || this.state === State.PAUSED) {
      this.state = State.FOCUSED;
      this._distractedStart = null;
      this._clearStart      = null;
      this._lastStatTs      = Date.now();
      this._lastStatState   = State.FOCUSED;
      this._emit(prev);
    }
  }

  /** Pause the session */
  pause() {
    if (this.state !== State.IDLE && this.state !== State.PAUSED) {
      const now = Date.now();
      this._accumulateStats(now);
      const prev = this.state;
      this.state = State.PAUSED;
      this._distractedStart = null;
      this._clearStart      = null;
      this._alarmFired      = false;
      this._emit(prev);
    }
  }

  /** Hard-reset session */
  reset() {
    const prev = this.state;
    this.state          = State.IDLE;
    this._distractedStart = null;
    this._clearStart      = null;
    this._alarmFired      = false;
    this._lastStatTs      = null;
    this.stats = { focusedMs: 0, distractedMs: 0, alarmCount: 0 };
    this._emit(prev);
  }

  setAlarmThreshold(sec)    { this.alarmThresholdMs    = sec * 1000; }
  setRecoveryThreshold(sec) { this.recoveryThresholdMs = sec * 1000; }

  /* ── Private helpers ────────────────────────────────────── */

  _handleDistracted(now) {
    // Reset recovery timer
    this._clearStart = null;

    if (this._distractedStart === null) {
      this._distractedStart = now;
    }

    const distractedMs = now - this._distractedStart;
    const progress     = Math.min(distractedMs / this.alarmThresholdMs, 1);

    if (distractedMs >= this.alarmThresholdMs) {
      if (this.state !== State.ALARM) {
        const prev = this.state;
        this.state = State.ALARM;
        this._emit(prev);
      }
      if (!this._alarmFired) {
        this._alarmFired = true;
        this.stats.alarmCount++;
        this.onAlarm?.();
      }
    } else {
      if (this.state !== State.WARNING) {
        const prev = this.state;
        this.state = State.WARNING;
        this._emit(prev);
      }
    }

    return this._buildResult(distractedMs, progress);
  }

  _handleFocused(now) {
    if (this._distractedStart === null) {
      // Was already focused
      this._clearStart = null;
      if (this.state !== State.FOCUSED) {
        const prev = this.state;
        this.state = State.FOCUSED;
        this._emit(prev);
      }
      return this._buildResult(0, 0);
    }

    // Starting recovery
    if (this._clearStart === null) {
      this._clearStart = now;
    }

    const clearMs = now - this._clearStart;

    if (clearMs >= this.recoveryThresholdMs) {
      // Fully recovered
      const wasAlarming = this.state === State.ALARM;
      this._distractedStart = null;
      this._clearStart      = null;
      this._alarmFired      = false;
      const prev = this.state;
      this.state = State.FOCUSED;
      this._emit(prev);
      if (wasAlarming) this.onRecover?.();
    }
    // Still in warning/alarm but clearing

    return this._buildResult(0, 0);
  }

  _accumulateStats(now) {
    if (!this._lastStatTs) return;
    const delta = now - this._lastStatTs;
    if (this._lastStatState === State.FOCUSED || this._lastStatState === State.WARNING) {
      if (this._lastStatState === State.FOCUSED) this.stats.focusedMs    += delta;
      else                                        this.stats.distractedMs += delta;
    } else if (this._lastStatState === State.ALARM) {
      this.stats.distractedMs += delta;
    }
  }

  _buildResult(distractedMs, progress) {
    return {
      state:        this.state,
      distractedMs,
      progress,               // 0–1 fill for the progress bar
      alarmThresholdMs:    this.alarmThresholdMs,
      recoveryThresholdMs: this.recoveryThresholdMs,
      stats: { ...this.stats },
    };
  }

  _emit(prev) {
    if (prev !== this.state) {
      this.onStateChange?.(this.state, prev);
    }
  }
}
