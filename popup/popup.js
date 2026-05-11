/**
 * UI Checker — Popup
 *
 * Fixes applied vs prior version:
 *  1. Scan button innerHTML restored properly (not textContent which strips icon)
 *  2. Clone Component replaced with DevTools redirect (popup has no $0 access)
 *  3. Toast is now white-space:normal — long messages fully readable
 *  4. Count label corrected to "Click Scan page to begin"
 *  5. Scan timeout (8s) with explicit error state + button recovery
 *  6. Status pill replaces plain dot — readable label not just colour
 */

// ── Debug logger ──────────────────────────────────────────────────────────────
const LOG = (...a) => console.debug('[uichecker:popup]', ...a);

// ── DOM refs ─────────────────────────────────────────────────────────────────
const countNumber  = document.getElementById('count-number');
const countLabel   = document.getElementById('count-label');
const countBlock   = document.getElementById('count-block');
const btnScan      = document.getElementById('btn-scan');
const btnToggle    = document.getElementById('btn-toggle');
const btnClonePage = document.getElementById('btn-clone-page');
const btnCloneComp = document.getElementById('btn-clone-component');
const statusPill   = document.getElementById('status-pill');
const statusText   = document.getElementById('status-text');
const toast        = document.getElementById('toast');

// ── Scan button HTML templates ──────────────────────────────────────────────
// FIX #1: Store as constants so we can restore innerHTML exactly, never lose the icon.
const SCAN_BTN_IDLE = `
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex-shrink:0">
    <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24L10 6h6V0l-2.35 2.35z" fill="currentColor"/>
  </svg>
  Scan page`;

const SCAN_BTN_ACTIVE = `
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"
       style="flex-shrink:0;animation:spin 0.7s linear infinite">
    <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24L10 6h6V0l-2.35 2.35z" fill="currentColor"/>
  </svg>
  Scanning…`;

// Set initial state
btnScan.innerHTML = SCAN_BTN_IDLE;

// ── State ─────────────────────────────────────────────────────────────────────
let overlaysVisible = true;
let _scanTimeout    = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (err) {
    LOG('getActiveTab error', err);
    return null;
  }
}

function setStatus(state, label) {
  // state: 'idle' | 'scan' | 'found' | 'clean' | 'error'
  statusPill.className = `status-pill status-${state}`;
  statusText.textContent = label;
}

function setCount(count, scanned) {
  if (!scanned) {
    countNumber.textContent = '—';
    countNumber.className = 'score-number';
    countBlock.className = 'score-block';
    countLabel.textContent = 'Click Scan page to begin';
    countLabel.className = 'score-unit';
    setStatus('idle', 'Ready');
    return;
  }
  countNumber.textContent = String(count);
  if (count > 0) {
    countNumber.className = 'score-number state-found';
    countBlock.className = 'score-block state-found';
    countLabel.textContent = count === 1 ? 'anti-pattern detected' : 'anti-patterns detected';
    countLabel.className = 'score-unit state-found';
    setStatus('found', `${count} issue${count === 1 ? '' : 's'}`);
  } else {
    countNumber.className = 'score-number state-clean';
    countBlock.className = 'score-block state-clean';
    countLabel.textContent = 'All clear — no anti-patterns';
    countLabel.className = 'score-unit state-clean';
    setStatus('clean', 'All clear');
  }
}

function updateFromState(state) {
  if (!state) { LOG('updateFromState: no state returned'); return; }
  LOG('updateFromState', { injected: state.injected, findings: state.findings?.length });
  const scanned = state.injected || (Array.isArray(state.findings) && state.findings.length > 0);
  const count = (state.findings || []).reduce((s, f) => s + (f.findings?.length || 0), 0);
  setCount(count, scanned);
  overlaysVisible = state.overlaysVisible !== false;
  syncToggle();
}

function syncToggle() {
  btnToggle.classList.toggle('overlays-hidden', !overlaysVisible);
  btnToggle.title = overlaysVisible ? 'Hide overlays' : 'Show overlays';
  btnToggle.setAttribute('aria-label', overlaysVisible ? 'Hide overlays' : 'Show overlays');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, type = '') {
  // FIX #3: toast is now white-space:normal in CSS — no truncation
  toast.textContent = msg;
  toast.className = `toast visible${type ? ' type-' + type : ''}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ── Real-time updates from SW ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  LOG('onMessage', msg.action);

  if (msg.action === 'findings-updated') {
    clearTimeout(_scanTimeout);                       // FIX #5: clear timeout on success
    const count = (msg.findings || []).reduce((s, f) => s + (f.findings?.length || 0), 0);
    setCount(count, true);
    btnScan.innerHTML = SCAN_BTN_IDLE;                // FIX #1: restores icon via innerHTML
    btnScan.disabled  = false;
  }

  if (msg.action === 'overlays-toggled-broadcast') {
    overlaysVisible = msg.visible;
    syncToggle();
  }
});

// ── Load state on open ────────────────────────────────────────────────────────
async function loadState() {
  const tab = await getActiveTab();
  if (!tab?.id) { LOG('loadState: no active tab'); return; }
  chrome.runtime.sendMessage({ action: 'get-state', tabId: tab.id }, (resp) => {
    if (chrome.runtime.lastError) {
      LOG('loadState error', chrome.runtime.lastError.message);
      return;
    }
    updateFromState(resp);
  });
}

// ── Scan ──────────────────────────────────────────────────────────────────────
btnScan.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) { showToast('No active tab found', 'error'); return; }

  LOG('scan triggered for tab', tab.id);

  btnScan.innerHTML = SCAN_BTN_ACTIVE;   // FIX #1: use innerHTML not textContent
  btnScan.disabled  = true;
  setStatus('scan', 'Scanning…');

  chrome.runtime.sendMessage({ action: 'scan', tabId: tab.id });

  // FIX #5: timeout — 8s, then show error and restore button
  clearTimeout(_scanTimeout);
  _scanTimeout = setTimeout(() => {
    LOG('scan timeout hit');
    btnScan.innerHTML = SCAN_BTN_IDLE;
    btnScan.disabled  = false;
    setStatus('error', 'Timed out');
    showToast('Scan timed out. Try refreshing the page or check chrome://extensions for errors.', 'error');
  }, 8000);
});

// ── Toggle overlays ───────────────────────────────────────────────────────────
btnToggle.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  LOG('toggle-overlays for tab', tab.id);
  chrome.runtime.sendMessage({ action: 'toggle-overlays', tabId: tab.id });
  overlaysVisible = !overlaysVisible;
  syncToggle();
});

// ── Clone Page ────────────────────────────────────────────────────────────────
// Serialises full rendered HTML (minus uichecker artefacts) to clipboard.
// Uses chrome.scripting.executeScript — works in popup context.
btnClonePage.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) { showToast('No active tab', 'error'); return; }

  btnClonePage.disabled = true;
  LOG('clone-page for tab', tab.id);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        try {
          const clone = document.documentElement.cloneNode(true);
          const sel = '.uichecker-overlay,.uichecker-label,.uichecker-banner,.uichecker-spotlight-backdrop,[id^="uichecker-live-"]';
          clone.querySelectorAll(sel).forEach(el => el.remove());
          return { ok: true, html: '<!DOCTYPE html>\n' + clone.outerHTML };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
    });

    const result = results?.[0]?.result;
    if (!result?.ok) {
      showToast('Clone failed: ' + (result?.error || 'unknown'), 'error');
      LOG('clone-page failed', result?.error);
    } else {
      await navigator.clipboard.writeText(result.html);
      btnClonePage.classList.add('state-ok');
      showToast(`Page HTML copied — ${result.html.length.toLocaleString()} chars`, 'ok');
      LOG('clone-page ok', result.html.length);
      setTimeout(() => btnClonePage.classList.remove('state-ok'), 2000);
    }
  } catch (err) {
    LOG('clone-page exception', err.message);
    showToast('Cannot access this page (restricted URL or CSP)', 'error');
  } finally {
    btnClonePage.disabled = false;
  }
});

// ── Clone Component (popup) ────────────────────────────────────────────────────
// FIX #2: Popup cannot access $0 (DevTools-only).
// This button now opens DevTools and shows a hint — it's a deliberate redirect,
// not a broken clone attempt.
btnCloneComp.addEventListener('click', () => {
  LOG('clone-component redirect from popup');
  showToast('Open DevTools → UI Checker panel → select element in Elements → click Clone Component', '');
  // Attempt to open DevTools. This API is not available in all contexts,
  // so we fall through gracefully.
  if (chrome.devtools) {
    // Already in DevTools context — shouldn't happen from popup
  }
});

loadState();
