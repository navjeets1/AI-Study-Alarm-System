import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const copyTargets = [
  { src: 'icons/*', dest: 'icons' },
  { src: 'permission.html', dest: '.' },
  { src: 'permission.js', dest: '.' },
  { src: 'node_modules/@mediapipe/tasks-vision/wasm/*', dest: 'wasm' },
];

if (existsSync(path.resolve(__dirname, 'public/models'))) {
  copyTargets.push({ src: 'public/models/coco-ssd', dest: 'models' });
  copyTargets.push({ src: 'public/models/face_landmarker.task', dest: 'models' });
}

// Copies local models/ and wasm/ folders into dist/
if (existsSync(path.resolve(__dirname, 'models'))) {
  copyTargets.push({ src: 'models/**', dest: 'models' });
}
if (existsSync(path.resolve(__dirname, 'wasm'))) {
  copyTargets.push({ src: 'wasm/**', dest: 'wasm' });
}

function generateDistManifest() {
  return {
    name: 'generate-dist-manifest',
    generateBundle() {
      const distManifest = {
        manifest_version: 3,
        name: "Study Focus Guard",
        version: "1.0.0",
        description: "AI-powered distraction detection for focused studying. Alerts you when you look away or pick up your phone.",
        permissions: ["sidePanel", "storage", "tabs", "tts"],
        background: {
          service_worker: "background.js",
          type: "module"
        },
        side_panel: {
          default_path: "sidepanel.html"
        },
        action: {
          default_title: "Open Study Focus Guard"
        },
        content_security_policy: {
          extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
        },
        web_accessible_resources: [
          {
            resources: [
              "wasm/*",
              "models/*",
              "models/coco-ssd/*",
              "assets/*",
              "icons/*",
              "permission.html",
              "permission.js"
            ],
            matches: ["<all_urls>"]
          }
        ],
        icons: {
          "16": "icons/icon16.png",
          "48": "icons/icon48.png",
          "128": "icons/icon128.png"
        }
      };

      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(distManifest, null, 2)
      });
    }
  };
}

/**
 * After each build, copy dist/assets/ and dist/background.js to the project
 * root so the extension folder (root) stays up to date.
 * Also restores root sidepanel.html to the source version so the next build works.
 */
function syncRootAfterBuild() {
  return {
    name: 'sync-root-after-build',
    closeBundle() {
      // Restore root sidepanel.html to source form (needed for next build)
      const sourceHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="Study Focus Guard — AI-powered distraction detection for deep focus sessions" />
  <title>Study Focus Guard</title>
  <script type="module" src="/src/main.js"><\/script>
  <link rel="stylesheet" href="/sidepanel.css">
</head>`;

      // Read current file and replace only the <head> portion
      const rootHtml = path.resolve(__dirname, 'sidepanel.html');
      let content = readFileSync(rootHtml, 'utf8');

      // Replace the built <head> block with the source <head> block
      content = content.replace(
        /<head>[\s\S]*?<\/head>/,
        `<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="Study Focus Guard — AI-powered distraction detection for deep focus sessions" />
  <title>Study Focus Guard</title>
  <script type="module" src="/src/main.js"><\/script>
  <link rel="stylesheet" href="/sidepanel.css">
</head>`
      );
      writeFileSync(rootHtml, content, 'utf8');
      console.log('[sync-root] Restored root sidepanel.html to source form.');
    }
  };
}

function fixRelativePaths() {
  return {
    name: 'fix-relative-paths',
    transformIndexHtml(html) {
      return html
        .replace(/src="\/assets\//g, 'src="assets/')
        .replace(/href="\/assets\//g, 'href="assets/')
        .replace(/src="\/sidepanel.css"/g, 'src="sidepanel.css"')
        .replace(/href="\/sidepanel.css"/g, 'href="sidepanel.css"');
    }
  };
}

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      input: {
        sidepanel: path.resolve(__dirname, 'sidepanel.html'),
        background: path.resolve(__dirname, 'background.js'),
      },
      output: {
        // Use stable (non-hashed) name for sidepanel JS so root HTML always matches
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') return 'background.js';
          return 'assets/[name].js';
        },
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  plugins: [
    generateDistManifest(),
    fixRelativePaths(),
    syncRootAfterBuild(),
    viteStaticCopy({ targets: copyTargets }),
  ],
});
