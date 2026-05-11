/**
 * UI Checker DevTools Extension - Content Script
 *
 * Bridges between the extension messaging system and the page-context detector.
 * The detector must run in page context (not isolated world) because it needs
 * access to getComputedStyle, document.styleSheets.cssRules, etc.
 *
 * Wrapped in an IIFE with an idempotency flag so re-injection (via
 * chrome.scripting.executeScript) is a no-op and doesn't cause:
 *   - SyntaxError: Identifier 'foo' has already been declared
 *   - Duplicate event listeners accumulating over time
 */
(function () {
  if (window.__UICHECKER_CS_LOADED__) return;
  window.__UICHECKER_CS_LOADED__ = true;

  // ── Debug logger ────────────────────────────────────────────────────────────
  const LOG = (...a) => console.debug('[uichecker:cs]', ...a);
  LOG('content script loaded on', location.href);

  let injected    = false;
  let pendingScan = false;
  let scanConfig  = null;

  // Listen for commands from the service worker
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    LOG('onMessage', msg.action);
    if (msg.action === 'scan') {
      scanConfig = msg.config || null;
      injectAndScan();
      sendResponse({ ok: true });
    } else if (msg.action === 'toggle-overlays') {
      window.postMessage({ source: 'uichecker-command', action: 'toggle-overlays' }, '*');
      sendResponse({ ok: true });
    } else if (msg.action === 'remove') {
      window.postMessage({ source: 'uichecker-command', action: 'remove' }, '*');
      injected = false;
      sendResponse({ ok: true });
    } else if (msg.action === 'highlight') {
      window.postMessage({ source: 'uichecker-command', action: 'highlight', selector: msg.selector }, '*');
      sendResponse({ ok: true });
    } else if (msg.action === 'unhighlight') {
      window.postMessage({ source: 'uichecker-command', action: 'unhighlight' }, '*');
      sendResponse({ ok: true });
    }
    return true;
  });

  // Listen for results and state changes from the detector in page context
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;

    if (e.data.source === 'uichecker-results') {
      chrome.runtime.sendMessage({
        action: 'findings',
        findings: e.data.findings,
        count: e.data.count,
      }).catch(() => {});
    }

    if (e.data.source === 'uichecker-overlays-toggled') {
      chrome.runtime.sendMessage({
        action: 'overlays-toggled',
        visible: e.data.visible,
      }).catch(() => {});
    }

    if (e.data.source === 'uichecker-ready') {
      LOG('detector ready; pendingScan=', pendingScan);
      injected = true;
      if (pendingScan) {
        pendingScan = false;
        sendScanCommand();
      }
    }
  });

  // Forward "page is active" signal to the extension when the cursor moves over the page.
  // This is the reliable way to know the user has left the DevTools panel — the panel's
  // own pointerleave/mouseleave events are unreliable on fast cursor movement.
  let lastPageActive = 0;
  document.addEventListener('pointermove', () => {
    const now = Date.now();
    if (now - lastPageActive < 150) return; // throttle
    lastPageActive = now;
    chrome.runtime.sendMessage({ action: 'page-pointer-active' }).catch(() => {});
  }, { passive: true, capture: true });

  // SPA navigation detection (pushState/replaceState don't fire events, but
  // popstate and hashchange cover back/forward and hash navigation)
  let lastUrl = location.href;
  function onPossibleNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (injected) {
      // Detector is still loaded in page context, just re-scan after DOM settles
      setTimeout(sendScanCommand, 500);
    }
  }
  window.addEventListener('popstate', onPossibleNavigation);
  window.addEventListener('hashchange', onPossibleNavigation);

  function sendScanCommand() {
    const msg = { source: 'uichecker-command', action: 'scan' };
    if (scanConfig) msg.config = scanConfig;
    window.postMessage(msg, '*');
  }

  function injectAndScan() {
    if (injected) {
      LOG('detector already injected, sending scan command');
      sendScanCommand();
      return;
    }

    LOG('injected=false; probing detector before re-injection');
    pendingScan = true;
    document.documentElement.dataset.uicheckerExtension = 'true';

    let probeAnswered = false;
    window.postMessage({ source: 'uichecker-command', action: 'ping' }, '*');

    setTimeout(() => {
      if (!probeAnswered && pendingScan) {
        LOG('probe timeout — requesting SW injection');
        chrome.runtime.sendMessage({ action: 'inject-fallback' });
      }
    }, 120);

    // Track whether the probe was answered (uichecker-ready fires via window message listener)
    const _onProbeReady = (e) => {
      if (e.source !== window || !e.data || e.data.source !== 'uichecker-ready') return;
      probeAnswered = true;
      window.removeEventListener('message', _onProbeReady);
    };
    window.addEventListener('message', _onProbeReady);
  }
})();
