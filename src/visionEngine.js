/**
 * visionEngine.js
 * ─────────────────────────────────────────────────────────────
 * Client-side ML vision pipeline using:
 *   • TensorFlow.js + COCO-SSD  → phone detection
 *   • MediaPipe FaceLandmarker  → head pose / look-away detection
 *
 * Performance strategy:
 *   • Inference runs on every 3rd animation frame (~10fps at 30fps source)
 *   • Video downscaled to 320×240 for inference
 *   • Bounding boxes + face mesh drawn on an overlay <canvas>
 *
 * Distraction triggers:
 *   • phone_detected: COCO-SSD detects "cell phone" with confidence ≥ 0.50
 *   • head_down:      FaceLandmarker pitch > HEAD_DOWN_DEG degrees
 *   • looking_away:   FaceLandmarker yaw > HEAD_YAW_DEG degrees (either side)
 *   • no_face:        No face detected for > NOFACE_GRACE_MS milliseconds
 */

import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const PHONE_CONFIDENCE   = 0.20;   // minimum COCO-SSD confidence for "cell phone" / handheld device
const HEAD_DOWN_DEG      = 18;     // pitch angle (degrees) threshold for head-down (adjusted so straight gaze is normal)
const HEAD_UP_DEG        = -16;    // pitch angle (degrees) threshold for looking up
const HEAD_YAW_DEG       = 18;     // yaw angle (degrees) threshold for looking left/right
const NOFACE_GRACE_MS    = 1000;   // ms before "no face" counts as distraction
const FRAME_SKIP         = 1;      // process every frame for best phone detection response
const INFER_W            = 320;    // inference resolution width
const INFER_H            = 240;    // inference resolution height

// Classes COCO-SSD may misclassify phones as (phones held sideways look like these)
const PHONE_LIKE_CLASSES = new Set(['cell phone', 'remote', 'book', 'toothbrush']);

export class VisionEngine {
  constructor() {
    this._cocoModel       = null;
    this._faceLandmarker  = null;
    this._offscreenCanvas = null; // used to downscale frames for inference
    this._offscreenCtx    = null;

    this._frameCount      = 0;
    this._lastResult      = null;
    this._lastFaceSeenTs  = null;  // timestamp of last detected face
    this._ready           = false;

    this.onProgress = null; // (pct: 0-100, msg: string) => void
  }

  /* ── Initialisation ─────────────────────────────────────── */

  async init(extensionBaseUrl) {
    this._report(5, 'Setting up TensorFlow.js backend…');
    try {
      await tf.setBackend('webgl');
      await tf.ready();
      console.log('[VisionEngine] TF.js initialized with WebGL backend');
    } catch (e) {
      console.log('[VisionEngine] WebGL backend fallback to CPU:', e);
      await tf.setBackend('cpu');
      await tf.ready();
      console.log('[VisionEngine] TF.js initialized with CPU backend');
    }

    this._report(20, 'Loading COCO-SSD phone detector…');
    this._cocoModel = await this._loadCocoSsd(extensionBaseUrl);

    this._report(60, 'Loading MediaPipe FaceLandmarker…');
    this._faceLandmarker = await this._loadFaceLandmarker(extensionBaseUrl);

    // Create a standard DOM canvas for downscaled model inputs.
    // HTMLCanvasElement is 100% compatible with MediaPipe WASM and TF.js.
    this._offscreenCanvas = document.createElement('canvas');
    this._offscreenCanvas.width  = INFER_W;
    this._offscreenCanvas.height = INFER_H;
    this._offscreenCtx    = this._offscreenCanvas.getContext('2d');

    // Warm up both WebGL models upfront to compile shaders before starting the session
    await this._warmupModels();

    this._ready = true;
    this._report(100, 'Models ready');
  }

  async _warmupModels() {
    this._report(85, 'Warming up WebGL model shaders…');
    console.log('[VisionEngine] Warming up WebGL shaders via dummy inference...');
    try {
      const dummyCanvas = document.createElement('canvas');
      dummyCanvas.width  = INFER_W;
      dummyCanvas.height = INFER_H;
      const dummyCtx = dummyCanvas.getContext('2d');
      dummyCtx.fillStyle = '#000000';
      dummyCtx.fillRect(0, 0, INFER_W, INFER_H);

      // Wrap in a temporary engine scope to prevent any leak during compilation warmup
      tf.engine().startScope();
      try {
        await Promise.allSettled([
          this._cocoModel.detect(dummyCanvas),
          this._faceLandmarker.detect(dummyCanvas)
        ]);
        console.log('[VisionEngine] WebGL shaders warmed up successfully');
      } finally {
        tf.engine().endScope();
      }
    } catch (err) {
      console.warn('[VisionEngine] Warmup failed (non-fatal):', err);
    }
  }

  get isReady() { return this._ready; }

  /* ── Frame processing ───────────────────────────────────── */

  async detectFrame(video, overlayCanvas) {
    if (!this._ready) return this._emptyResult();

    if (!video || video.readyState < 2 || video.videoWidth === 0) {
      return this._emptyResult();
    }

    // Start a TF.js engine scope. Since this function is async, using tf.engine().startScope()
    // and endScope() guarantees that all intermediate tensors created during inference
    // are automatically cleaned up when the scope ends, preventing memory leaks.
    tf.engine().startScope();

    try {
      this._offscreenCtx.drawImage(video, 0, 0, INFER_W, INFER_H);

      const [phoneBoxes, faceResult] = await Promise.all([
        this._runCocoSsd(this._offscreenCanvas),
        this._runFaceLandmarker(this._offscreenCanvas),
      ]);

      let phoneDetected = false;
      let phoneOnCall   = false;
      let lookingDown   = false;
      let lookingUp     = false;
      let lookingLeft   = false;
      let lookingRight  = false;
      let noFace        = false;
      let headAngles    = null;

      const hasFace = faceResult?.faceLandmarks?.length > 0;

      if (hasFace) {
        this._lastFaceSeenTs = Date.now();
        const landmarks = faceResult.faceLandmarks[0];

        // Direct 3D Pose Geometry estimation from landmarks (x, y, z)
        headAngles = this._extractPoseFromLandmarks(landmarks);

        // Directional Head Pose evaluation
        if (headAngles.pitch > HEAD_DOWN_DEG) {
          lookingDown = true;
        } else if (headAngles.pitch < HEAD_UP_DEG) {
          lookingUp = true;
        }

        if (headAngles.yaw > HEAD_YAW_DEG) {
          lookingLeft = true;
        } else if (headAngles.yaw < -HEAD_YAW_DEG) {
          lookingRight = true;
        }
      } else {
        if (this._lastFaceSeenTs !== null) {
          const msSinceFace = Date.now() - this._lastFaceSeenTs;
          noFace = msSinceFace > NOFACE_GRACE_MS;
        } else {
          noFace = true;
        }
      }

      // ── Phone detection: use COCO-SSD classes + geometry heuristic ────────────────
      phoneBoxes.forEach((box) => {
        const isPhoneLike = PHONE_LIKE_CLASSES.has(box.class);

        // Strict phone class at any confidence >= PHONE_CONFIDENCE
        if (box.class === 'cell phone' && box.score >= PHONE_CONFIDENCE) {
          phoneDetected = true;
        }

        // For phone-like objects (remote, book, toothbrush) at low confidence,
        // use a geometry heuristic: object is tall-ish or positioned near the face region
        if (isPhoneLike && box.score >= PHONE_CONFIDENCE && !phoneDetected) {
          const [bx, by, bw, bh] = box.bbox;
          // A phone held in portrait = taller than wide; landscape at ear = wider than tall
          const aspectRatio = bh / bw;
          // Object center Y (normalized 0-1)
          const cy = (by + bh / 2) / INFER_H;
          // Consider it a phone if: portrait orientation (h > 0.6*w) OR near top of frame (face region)
          if (aspectRatio > 0.5 || cy < 0.65) {
            phoneDetected = true;
          }
        }

        // Hand-to-Ear Proximity calling gesture heuristic
        if (isPhoneLike && box.score >= PHONE_CONFIDENCE) {
          if (hasFace && headAngles) {
            const landmarks = faceResult.faceLandmarks[0];
            const leftEar   = landmarks[234]; // Left ear cheek region
            const rightEar  = landmarks[454]; // Right ear cheek region

            // Bounding box center in canvas coordinates
            const [px, py, pw, ph] = box.bbox;
            const pcx = px + pw / 2;
            const pcy = py + ph / 2;

            // Map ear coordinates to offscreen scale (INFER_W x INFER_H)
            const lex = leftEar.x * INFER_W;
            const ley = leftEar.y * INFER_H;
            const rex = rightEar.x * INFER_W;
            const rey = rightEar.y * INFER_H;

            // Calculate pixel distances
            const distLeft  = Math.sqrt((pcx - lex) ** 2 + (pcy - ley) ** 2);
            const distRight = Math.sqrt((pcx - rex) ** 2 + (pcy - rey) ** 2);

            // Proximity threshold: 90 pixels; roll condition relaxed to > 2°
            const earProximity = distLeft < 90 || distRight < 90;
            const rollTilted   = Math.abs(headAngles.roll) > 2;

            if (earProximity && rollTilted) {
              phoneOnCall = true;
              phoneDetected = false; // calling is more specific — don't double-flag
            }
          }
        }
      });

      // Calculate composite distraction state
      const isDistracted = phoneDetected || phoneOnCall || lookingDown || lookingUp || lookingLeft || lookingRight || noFace;

      this._lastResult = {
        phoneDetected,
        phoneOnCall,
        lookingDown,
        lookingUp,
        lookingLeft,
        lookingRight,
        noFace,
        isDistracted,
        phoneBoxes,
        headAngles,
        faceResult,
      };

      return this._lastResult;
    } catch (err) {
      console.error('[VisionEngine] detectFrame error:', err);
      // Gracefully handle WebGL context loss
      const msg = String(err.message || err).toLowerCase();
      if (msg.includes('webgl') || msg.includes('context lost') || msg.includes('compile shader') || msg.includes('disposed')) {
        console.warn('[VisionEngine] WebGL context loss detected. Resetting TF.js backend...');
        this._reinitBackend();
      }
      return this._emptyResult();
    } finally {
      tf.engine().endScope();
    }
  }

  getMemoryInfo() {
    try {
      return tf.memory();
    } catch (e) {
      return { numTensors: -1, numBytes: -1 };
    }
  }

  resetFaceTimer() {
    this._lastFaceSeenTs = null;
  }

  dispose() {
    this._cocoModel?.dispose?.();
    this._faceLandmarker?.close?.();
    this._ready = false;
  }

  /* ── Model loaders ──────────────────────────────────────── */

  async _loadCocoSsd(base) {
    const candidates = [
      base ? `${base}models/coco-ssd/model.json` : null,
      base ? `${base}dist/models/coco-ssd/model.json` : null,
      './models/coco-ssd/model.json',
      'models/coco-ssd/model.json',
    ].filter(Boolean);

    for (const url of candidates) {
      try {
        console.log('[VisionEngine] Attempting COCO-SSD from:', url);
        const model = await cocoSsd.load({
          base: 'lite_mobilenet_v2',
          modelUrl: url,
        });
        console.log('[VisionEngine] Successfully loaded COCO-SSD from:', url);
        return model;
      } catch (err) {
        console.log(`[VisionEngine] Candidate URL info for ${url}:`, err.message || err);
      }
    }

    console.log('[VisionEngine] Trying default CDN fallback...');
    return await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  }

  async _loadFaceLandmarker(base) {
    const wasmCandidates = [
      base ? `${base}wasm/` : null,
      base ? `${base}dist/wasm/` : null,
      './wasm/',
      'wasm/',
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm/',
    ].filter(Boolean);

    let vision = null;
    for (const wasmUrl of wasmCandidates) {
      try {
        console.log('[VisionEngine] Attempting MediaPipe WASM from:', wasmUrl);
        vision = await FilesetResolver.forVisionTasks(wasmUrl);
        console.log('[VisionEngine] Successfully resolved MediaPipe WASM from:', wasmUrl);
        break;
      } catch (err) {
        console.log(`[VisionEngine] Candidate WASM info for ${wasmUrl}:`, err.message || err);
      }
    }

    if (!vision) {
      throw new Error('Failed to resolve MediaPipe WASM binaries');
    }

    const taskCandidates = [
      base ? `${base}models/face_landmarker.task` : null,
      base ? `${base}dist/models/face_landmarker.task` : null,
      './models/face_landmarker.task',
      'models/face_landmarker.task',
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    ].filter(Boolean);

    let modelAssetPath = taskCandidates[0];
    for (const taskUrl of taskCandidates) {
      try {
        const res = await fetch(taskUrl, { method: 'HEAD' });
        if (res.ok) {
          modelAssetPath = taskUrl;
          console.log('[VisionEngine] Found FaceLandmarker task at:', taskUrl);
          break;
        }
      } catch (_) {}
    }

    // Set FaceLandmarker explicitly to use the CPU/WASM delegate to prevent WebGL context
    // collisions and shader deadlocks with TensorFlow.js.
    console.log('[VisionEngine] Creating FaceLandmarker with CPU delegate and IMAGE mode');
    return await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath,
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: false,
    });
  }

  /* ── Inference runners ──────────────────────────────────── */

  async _runCocoSsd(canvas) {
    try {
      return await this._cocoModel.detect(canvas);
    } catch (err) {
      console.log('[VisionEngine] COCO-SSD frame note:', err);
      return [];
    }
  }

  _runFaceLandmarker(image) {
    try {
      return this._faceLandmarker.detect(image);
    } catch (err) {
      console.log('[VisionEngine] FaceLandmarker frame note:', err);
      return null;
    }
  }

  /* ── Head pose extraction ───────────────────────────────── */

  _extractEulerAngles(m) {
    const sy = Math.sqrt(m[0] * m[0] + m[4] * m[4]);
    const singular = sy < 1e-6;

    let pitch, yaw, roll;

    if (!singular) {
      roll  = Math.atan2(m[9], m[10]);
      pitch = Math.atan2(-m[8], sy);
      yaw   = Math.atan2(m[4], m[0]);
    } else {
      roll  = Math.atan2(-m[6], m[5]);
      pitch = Math.atan2(-m[8], sy);
      yaw   = 0;
    }

    const RAD2DEG = 180 / Math.PI;
    return {
      pitch: pitch * RAD2DEG,
      yaw:   yaw   * RAD2DEG,
      roll:  roll  * RAD2DEG,
    };
  }

  /**
   * Calculate head pitch, yaw, and roll directly from facial landmark geometry.
   * Uses anatomical midpoint ratios to measure head rotation accurately in degrees.
   */
  _extractPoseFromLandmarks(landmarks) {
    if (!landmarks || landmarks.length < 33) return { pitch: 0, yaw: 0, roll: 0 };

    const nose     = landmarks[1];    // Nose tip
    const chin     = landmarks[152];  // Chin
    const forehead = landmarks[10];   // Top forehead
    const leftEye  = landmarks[33];   // Left eye outer
    const rightEye = landmarks[263];  // Right eye outer

    // Horizontal eye span and midpoint
    const eyeMidX = (leftEye.x + rightEye.x) / 2;
    const eyeSpan = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) || 1e-4;

    // Vertical face height
    const faceHeight = Math.hypot(chin.x - forehead.x, chin.y - forehead.y) || 1e-4;

    // Yaw: Nose horizontal deviation from eye center, normalized by half eye span
    // Scaling by 45 gives realistic yaw in degrees (-45° to +45°)
    const yawRatio = (nose.x - eyeMidX) / (eyeSpan * 0.5);
    const yaw = Math.max(-90, Math.min(90, yawRatio * 45));

    // Pitch: In the user's neutral position, nose.y is ~0.50 of face height.
    // Setting normalNoseY to 0.51 ensures straight gaze reads ~0° pitch.
    const normalNoseY = forehead.y + faceHeight * 0.51;
    const pitchRatio = (nose.y - normalNoseY) / (faceHeight * 0.25);
    const pitch = Math.max(-90, Math.min(90, pitchRatio * 35));

    // Roll: tilt angle of the eye line in degrees
    const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * (180 / Math.PI);

    return { pitch, yaw, roll };
  }

  /**
   * Render ONLY detection overlays at 30-60 FPS onto the transparent canvas.
   * The video is rendered natively by the browser behind this canvas.
   * Do NOT draw the video here — the native <video> element handles its own display.
   */
  drawScene(video, canvas) {
    if (!canvas || !video) return;

    const W = video.videoWidth || INFER_W;
    const H = video.videoHeight || INFER_H;

    if (canvas.width !== W || canvas.height !== H) {
      canvas.width  = W;
      canvas.height = H;
    }

    const ctx = canvas.getContext('2d');
    // Clear to fully transparent so the video element shows through
    ctx.clearRect(0, 0, W, H);

    // Draw only ML detection overlays (face mesh, phone boxes, angles text)
    if (this._lastResult) {
      this._drawOverlay(canvas, video, this._lastResult);
    }
  }

  clearLastResult() {
    this._lastResult = null;
  }

  _drawOverlay(canvas, video, result) {
    if (!canvas || !result) return;

    const { phoneBoxes, faceResult, headAngles, isDistracted, phoneOnCall } = result;
    const W = video.videoWidth || INFER_W;
    const H = video.videoHeight || INFER_H;

    const ctx = canvas.getContext('2d');

    const scaleX = W / INFER_W;
    const scaleY = H / INFER_H;

    for (const box of phoneBoxes) {
      const isPhoneLike = PHONE_LIKE_CLASSES.has(box.class);
      if (!isPhoneLike) continue;
      if (box.score < PHONE_CONFIDENCE) continue;

      const [x, y, w, h] = box.bbox;
      const sx = x * scaleX, sy = y * scaleY;
      const sw = w * scaleX, sh = h * scaleY;

      const isCall = phoneOnCall;
      const color  = isCall ? '#F59E0B' : '#EF4444';

      ctx.shadowColor  = color;
      ctx.shadowBlur   = 14;
      ctx.strokeStyle  = color;
      ctx.lineWidth    = 3;
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.shadowBlur   = 0;

      ctx.fillStyle = isCall ? 'rgba(245,158,11,0.9)' : 'rgba(239,68,68,0.9)';
      const label = isCall
        ? `📞 Phone Call ${(box.score * 100).toFixed(0)}%`
        : `📱 ${box.class} ${(box.score * 100).toFixed(0)}%`;
      ctx.font = 'bold 12px system-ui';
      const tw = ctx.measureText(label).width;
      ctx.fillRect(sx, Math.max(0, sy - 22), tw + 14, 22);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, sx + 7, Math.max(14, sy - 5));
    }

    if (faceResult?.faceLandmarks?.length > 0) {
      const landmarks = faceResult.faceLandmarks[0];

      const dotColor = isDistracted ? 'rgba(245,158,11,0.7)' : 'rgba(99,102,241,0.6)';
      const connColor = isDistracted ? 'rgba(245,158,11,0.35)' : 'rgba(99,102,241,0.3)';

      ctx.strokeStyle = connColor;
      ctx.lineWidth   = 1;
      this._drawFaceConnections(ctx, landmarks, W, H, connColor);

      ctx.fillStyle = dotColor;
      const keyIndices = [1, 4, 10, 33, 61, 152, 199, 234, 263, 291, 362, 454];
      for (const i of keyIndices) {
        const lm = landmarks[i];
        if (!lm) continue;
        ctx.beginPath();
        ctx.arc(lm.x * W, lm.y * H, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (headAngles) {
        ctx.fillStyle    = 'rgba(255,255,255,0.75)';
        ctx.font         = 'bold 10px monospace';
        ctx.fillText(
          `Pitch:${headAngles.pitch.toFixed(1)}° Yaw:${headAngles.yaw.toFixed(1)}°`,
          6, H - 8
        );
      }
    }

    if (faceResult && faceResult.faceLandmarks?.length === 0) {
      ctx.fillStyle = 'rgba(139,92,246,0.6)';
      ctx.font      = 'bold 12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('⚠ Face not detected', W / 2, H / 2);
      ctx.textAlign = 'left';
    }
  }

  _drawFaceConnections(ctx, landmarks, W, H, color) {
    const FACE_OVAL = [
      10,338,297,332,284,251,389,356,454,323,361,288,
      397,365,379,378,400,377,152,148,176,149,150,136,
      172,58,132,93,234,127,162,21,54,103,67,109,10
    ];

    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    FACE_OVAL.forEach((idx, i) => {
      const lm = landmarks[idx];
      if (!lm) return;
      if (i === 0) ctx.moveTo(lm.x * W, lm.y * H);
      else         ctx.lineTo(lm.x * W, lm.y * H);
    });
    ctx.closePath();
    ctx.stroke();
  }

  async _reinitBackend() {
    try {
      console.log('[VisionEngine] Resetting TF.js WebGL backend...');
      await tf.removeBackend('webgl');
      await tf.setBackend('cpu');
      await tf.ready();
      console.log('[VisionEngine] Fallback to CPU backend completed');
    } catch (e) {
      console.error('[VisionEngine] Reinit backend failed:', e);
    }
  }

  _emptyResult() {
    return {
      phoneDetected: false,
      phoneOnCall:   false,
      lookingDown:   false,
      lookingUp:     false,
      lookingLeft:   false,
      lookingRight:  false,
      noFace:        false,
      isDistracted:  false,
      phoneBoxes:    [],
      headAngles:    null,
    };
  }

  _report(pct, msg) {
    this.onProgress?.(pct, msg);
  }
}
