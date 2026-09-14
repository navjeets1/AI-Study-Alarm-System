#!/usr/bin/env node
/**
 * download-models.mjs
 * ─────────────────────────────────────────────────────────────
 * Downloads ML model files required by the extension into public/models/.
 * These files are copied to dist/models/ by Vite during build.
 *
 * Models downloaded:
 *   • COCO-SSD lite_mobilenet_v2  (~8 MB)  → public/models/coco-ssd/
 *   • MediaPipe FaceLandmarker     (~6 MB)  → public/models/face_landmarker.task
 *
 * Run via:  npm run setup
 */

import { mkdir, writeFile, copyFile, readFile, access } from 'fs/promises';
import { existsSync, createWriteStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const PUBLIC    = path.join(ROOT, 'public');
const MODELS    = path.join(PUBLIC, 'models');
const COCO_DIR  = path.join(MODELS, 'coco-ssd');

// ── Model URLs ─────────────────────────────────────────────────
// COCO-SSD lite_mobilenet_v2 (TF.js SavedModel format)
// URL is constructed from BASE_PATH + getPrefix('lite_mobilenet_v2') + '/'
// getPrefix('lite_mobilenet_v2') === 'ssdlite_mobilenet_v2'
const COCO_BASE_URL =
  'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/';

// MediaPipe FaceLandmarker combined task file (float16)
const FACE_LANDMARKER_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// ── Utilities ──────────────────────────────────────────────────
function log(msg)   { process.stdout.write(`  ${msg}\n`); }
function ok(msg)    { process.stdout.write(`  ✓ ${msg}\n`); }
function warn(msg)  { process.stdout.write(`  ⚠ ${msg}\n`); }
function err(msg)   { process.stderr.write(`  ✗ ${msg}\n`); }

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

/**
 * Fetch a URL and save to destPath.
 * Skips if file already exists.
 */
async function downloadFile(url, destPath, label = '') {
  if (await fileExists(destPath)) {
    ok(`Already cached: ${label || path.basename(destPath)}`);
    return;
  }

  const name = label || path.basename(destPath);
  process.stdout.write(`  ↓ Downloading ${name}…`);

  const response = await fetch(url, {
    headers: { 'User-Agent': 'StudyFocusGuard-ModelDownloader/1.0' },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const buffer = await response.arrayBuffer();
  await writeFile(destPath, Buffer.from(buffer));

  const kib = (buffer.byteLength / 1024).toFixed(0);
  process.stdout.write(` ${kib} KiB\n`);
}

// ── COCO-SSD downloader ────────────────────────────────────────
async function downloadCocoSsd() {
  log('');
  log('── COCO-SSD lite_mobilenet_v2 ──────────────────────────');
  await mkdir(COCO_DIR, { recursive: true });

  // 1. Fetch model.json (contains topology + weight shard manifest)
  const modelJsonUrl  = COCO_BASE_URL + 'model.json';
  const modelJsonPath = path.join(COCO_DIR, 'model.json');

  let modelJson;
  if (await fileExists(modelJsonPath)) {
    ok('Already cached: model.json');
    modelJson = JSON.parse(await readFile(modelJsonPath, 'utf8'));
  } else {
    process.stdout.write('  ↓ Downloading model.json…');
    const res = await fetch(modelJsonUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} for model.json`);
    const text = await res.text();
    await writeFile(modelJsonPath, text, 'utf8');
    modelJson = JSON.parse(text);
    process.stdout.write(' done\n');
  }

  // 2. Download all weight shard files listed in weightsManifest
  const shards = [];
  for (const group of modelJson.weightsManifest ?? []) {
    for (const shardPath of group.paths ?? []) {
      shards.push(shardPath);
    }
  }

  log(`  Found ${shards.length} weight shard(s)`);

  for (const shard of shards) {
    const shardDir  = path.join(COCO_DIR, path.dirname(shard));
    const shardFile = path.join(COCO_DIR, shard);
    await mkdir(shardDir, { recursive: true });
    await downloadFile(COCO_BASE_URL + shard, shardFile, shard);
  }

  ok('COCO-SSD download complete');
}

// ── FaceLandmarker downloader ──────────────────────────────────
async function downloadFaceLandmarker() {
  log('');
  log('── MediaPipe FaceLandmarker ────────────────────────────');
  await mkdir(MODELS, { recursive: true });

  const destPath = path.join(MODELS, 'face_landmarker.task');
  await downloadFile(FACE_LANDMARKER_URL, destPath, 'face_landmarker.task');
  ok('FaceLandmarker download complete');
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Study Focus Guard — Model Setup            ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  log(`Output directory: ${MODELS}`);
  await mkdir(MODELS, { recursive: true });

  try {
    await downloadCocoSsd();
  } catch (e) {
    err(`COCO-SSD download failed: ${e.message}`);
    warn('The extension will fall back to loading COCO-SSD from CDN at runtime.');
    warn('This requires an internet connection and may not work in strict CSP environments.');
  }

  try {
    await downloadFaceLandmarker();
  } catch (e) {
    err(`FaceLandmarker download failed: ${e.message}`);
    warn('Head-pose detection will use CDN fallback (requires internet connection).');
  }

  console.log('\n✅ Setup complete! Run `npm run build` to bundle the extension.\n');
}

main().catch((e) => {
  console.error('\n❌ Fatal error during setup:', e);
  process.exit(1);
});
