// permission.js — Handles camera permission grant for Study Focus Guard
(function () {
  const btn       = document.getElementById('requestBtn');
  const statusMsg = document.getElementById('statusMsg');

  async function requestCamera() {
    btn.disabled = true;
    btn.textContent = 'Waiting for Allow…';
    statusMsg.textContent = '';
    statusMsg.className = 'status';

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });

      // Stop tracks immediately — we only needed the permission grant
      stream.getTracks().forEach(function(t) { t.stop(); });

      statusMsg.textContent = '✓ Camera access granted! Returning to Side Panel…';
      statusMsg.className = 'status ok';

      // Notify background.js → sidepanel to start the camera
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'CAMERA_PERMISSION_GRANTED' }, function() {
          // Tab will be closed by background.js; fallback close
          setTimeout(function() { window.close(); }, 800);
        });
      } else {
        setTimeout(function() { window.close(); }, 1200);
      }

    } catch (err) {
      if (err.name === 'NotAllowedError') {
        // Camera was blocked — guide user to Chrome settings
        document.getElementById('card').innerHTML = [
          '<div class="icon">\uD83D\uDEAB</div>',
          '<h2 style="color:#EF4444">Camera Blocked</h2>',
          '<p>Chrome has camera set to <strong>Block</strong> for this extension.<br>You need to unblock it in Chrome settings.</p>',
          '<div class="info-box">',
          '  1. Open a new tab, go to:<br>',
          '  <code>chrome://settings/content/camera</code><br>',
          '  2. Under <em>"Not allowed"</em> find <strong>Study Focus Guard</strong><br>',
          '  3. Click it &rarr; change Camera to <strong>Allow</strong><br>',
          '  4. Come back and click <strong>Try Again</strong>',
          '</div>',
          '<button class="btn" id="retryBtn">Try Again</button>'
        ].join('');

        var retryBtn = document.getElementById('retryBtn');
        if (retryBtn) {
          retryBtn.addEventListener('click', function() { location.reload(); });
        }
      } else {
        btn.disabled = false;
        btn.textContent = 'Allow Camera Access';
        statusMsg.textContent = '\u26A0 ' + (err.message || err.name) + ' — please try again.';
        statusMsg.className = 'status err';
      }
    }
  }

  if (btn) {
    btn.addEventListener('click', requestCamera);
  }
})();
