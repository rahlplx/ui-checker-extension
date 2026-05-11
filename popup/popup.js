/**
 * UI Checker - Popup
 * Scan, overlay toggle, clone page, clone component.
 */

const countNumber  = document.getElementById('count-number');
const countLabel   = document.getElementById('count-label');
const btnScan      = document.getElementById('btn-scan');
const btnToggle    = document.getElementById('btn-toggle');
const btnClonePage = document.getElementById('btn-clone-page');
const btnCloneComp = document.getElementById('btn-clone-component');
const statusDot    = document.getElementById('status-dot');
const toast        = document.getElementById('toast');

let overlaysVisible = true;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ── State display ─────────────────────────────────────────────────────────────

function setCount(count, scanned) {
  if (!scanned) {
    countNumber.textContent = '—';
    countNumber.className = 'count-number';
    countLabel.textContent = 'open DevTools to scan';
    statusDot.className = 'status-dot idle';
    return;
  }
  countNumber.textContent = String(count);
  countLabel.textContent = count === 0 ? 'all clear' : count === 1 ? 'anti-pattern detected' : 'anti-patterns detected';
  countNumber.className = 'count-number' + (count > 0 ? ' has-findings' : ' clean');
  statusDot.className = 'status-dot ' + (count > 0 ? 'has-findings' : 'clean');
}

function updateFromState(state) {
  if (!state) return;
  const scanned = state.injected || (state.findings && state.findings.length > 0);
  const count = state.findings?.reduce((sum, f) => sum + f.findings.length, 0) || 0;
  setCount(count, scanned);
  overlaysVisible = state.overlaysVisible !== false;
  btnToggle.classList.toggle('overlays-hidden', !overlaysVisible);
  btnToggle.title = overlaysVisible ? 'Hide overlays' : 'Show overlays';
}

async function loadState() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.runtime.sendMessage({ action: 'get-state', tabId: tab.id }, updateFromState);
}

// ── Real-time updates ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'findings-updated') {
    const count = msg.findings?.reduce((sum, f) => sum + f.findings.length, 0) || 0;
    setCount(count, true);
    btnScan.textContent = 'Scan page';
    btnScan.disabled = false;
    statusDot.className = 'status-dot ' + (count > 0 ? 'has-findings' : 'clean');
  }
  if (msg.action === 'overlays-toggled-broadcast') {
    overlaysVisible = msg.visible;
    btnToggle.classList.toggle('overlays-hidden', !overlaysVisible);
    btnToggle.title = overlaysVisible ? 'Hide overlays' : 'Show overlays';
  }
});

// ── Scan ──────────────────────────────────────────────────────────────────────

btnScan.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  btnScan.innerHTML = `<svg class="btn-icon" viewBox="0 0 16 16" fill="none" style="animation:spin 0.7s linear infinite"><path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24L10 6h6V0l-2.35 2.35z" fill="currentColor"/></svg> Scanning…`;
  btnScan.disabled = true;
  statusDot.className = 'status-dot scanning';
  chrome.runtime.sendMessage({ action: 'scan', tabId: tab.id });
});

// ── Toggle overlays ───────────────────────────────────────────────────────────

btnToggle.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.runtime.sendMessage({ action: 'toggle-overlays', tabId: tab.id });
  overlaysVisible = !overlaysVisible;
  btnToggle.classList.toggle('overlays-hidden', !overlaysVisible);
  btnToggle.title = overlaysVisible ? 'Hide overlays' : 'Show overlays';
});

// ── Clipboard helper ──────────────────────────────────────────────────────────

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied to clipboard`);
    return true;
  } catch {
    showToast('Copy failed — check clipboard permission');
    return false;
  }
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove('visible'), 2400);
}

// ── Clone Page ────────────────────────────────────────────────────────────────
// Serialises the rendered document outerHTML — includes all inline styles and
// runtime content. Useful for offline review or passing to a design tool.

btnClonePage.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) { showToast('No active tab'); return; }

  btnClonePage.disabled = true;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      // Exclude any uichecker overlay elements from the snapshot
      const clone = document.documentElement.cloneNode(true);
      for (const el of clone.querySelectorAll('.uichecker-overlay, .uichecker-label, .uichecker-banner, .uichecker-spotlight-backdrop, [id^="uichecker-live-"], style[data-uichecker]')) {
        el.remove();
      }
      return '<!DOCTYPE html>\n' + clone.outerHTML;
    },
  }, (results) => {
    btnClonePage.disabled = false;
    const html = results?.[0]?.result;
    if (html) {
      copyText(html, 'Page HTML');
    } else {
      showToast('Could not access page — try DevTools panel');
    }
  });
});

// ── Clone Component ───────────────────────────────────────────────────────────
// Extracts the currently-inspected element ($0 in Elements panel) with its
// critical computed styles inlined, plus the full subtree HTML.
// Useful for extracting individual components for redesign.

btnCloneComp.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) { showToast('No active tab'); return; }

  btnCloneComp.disabled = true;

  // We need $0 which is only available in DevTools context.
  // Popup can't access $0 directly. Instead: capture the focused element
  // via document.activeElement, OR ask the user to open DevTools and use
  // the panel's Clone Component button there (which has $0 access).
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      // Best-effort: grab last element clicked/hovered that had a uichecker overlay,
      // or fall back to the focused element.
      const el = document.querySelector('.uichecker-overlay.uichecker-spotlight')?._targetEl
               || document.querySelector('[data-uichecker-selected]')
               || document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        return { error: 'no-element' };
      }

      const computed = getComputedStyle(el);
      // Capture layout-critical properties only (not every property — that's ~300+ props)
      const PROPS = [
        'display','position','width','height','padding','margin','flex','flexDirection',
        'alignItems','justifyContent','gap','grid','gridTemplateColumns','gridTemplateRows',
        'background','backgroundColor','color','font','fontSize','fontWeight','lineHeight',
        'border','borderRadius','boxShadow','opacity','overflow','transform','zIndex',
      ];
      const styles = PROPS.map(p => `${p}:${computed.getPropertyValue(p)}`).join(';');

      const clone = el.cloneNode(true);
      // Remove uichecker artifacts from clone
      for (const child of clone.querySelectorAll('.uichecker-overlay, .uichecker-label')) {
        child.remove();
      }
      clone.setAttribute('style', (clone.getAttribute('style') || '') + ';' + styles);
      return { html: clone.outerHTML, tag: el.tagName.toLowerCase() };
    },
  }, (results) => {
    btnCloneComp.disabled = false;
    const result = results?.[0]?.result;
    if (!result || result.error === 'no-element') {
      showToast('Select an element in DevTools Elements panel first, then use the panel\'s Clone Component button');
    } else if (result.html) {
      copyText(result.html, `<${result.tag}> component`);
    } else {
      showToast('Could not extract component');
    }
  });
});

// ── Spin animation ────────────────────────────────────────────────────────────

const spinStyle = document.createElement('style');
spinStyle.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
document.head.appendChild(spinStyle);

loadState();
