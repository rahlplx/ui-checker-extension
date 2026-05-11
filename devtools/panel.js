/**
 * UI Checker DevTools Panel
 *
 * Fixes applied vs prior version:
 *  6.  Clone buttons now have visible text labels (not icon-only)
 *  7.  Re-scan is non-destructive — existing results stay visible with overlay
 *  8.  showScanning() only used on navigation (full clear); re-scan uses overlay
 *  9.  Settings options have hint descriptions
 *  (1-5 are popup fixes; debug layer added throughout)
 */

// ── Debug logger ──────────────────────────────────────────────────────────────
const LOG = (...a) => console.debug('[uichecker:panel]', ...a);

// ── Theme ─────────────────────────────────────────────────────────────────────
if (chrome.devtools.panels.themeName === 'dark') {
  document.documentElement.classList.add('theme-dark');
}

const tabId = chrome.devtools.inspectedWindow.tabId;
LOG('panel init for tab', tabId);

// ── Port (auto-reconnecting) ─────────────────────────────────────────────────
let port = null;

function getPort() {
  if (port) return port;
  LOG('connecting port');
  port = chrome.runtime.connect({ name: `uichecker-panel-${tabId}` });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    LOG('port disconnected');
    port = null;
  });
  return port;
}

function postToPort(msg) {
  try {
    getPort().postMessage(msg);
  } catch (err) {
    LOG('postToPort error, retrying', err.message);
    port = null;
    try { getPort().postMessage(msg); } catch (e) { LOG('postToPort retry failed', e.message); }
  }
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const badge            = document.getElementById('badge');
const container        = document.getElementById('findings-container');
const emptyState       = document.getElementById('empty-state');
const btnRescan        = document.getElementById('btn-rescan');
const btnToggle        = document.getElementById('btn-toggle');
const btnCopyAll       = document.getElementById('btn-copy-all');
const btnClonePage     = document.getElementById('btn-clone-page');
const btnCloneComp     = document.getElementById('btn-clone-component');
const cloneToast       = document.getElementById('clone-toast');
const settingsContainer= document.getElementById('settings-container');
const settingsList     = document.getElementById('settings-list');
const btnSettings      = document.getElementById('btn-settings');

// ── State ─────────────────────────────────────────────────────────────────────
let overlaysVisible  = true;
let allAntipatterns  = [];
let disabledRules    = [];
let currentFindings  = [];
let _isRescanning    = false;

// ── Settings init ────────────────────────────────────────────────────────────
async function initSettings() {
  try {
    const resp = await fetch(chrome.runtime.getURL('detector/antipatterns.json'));
    allAntipatterns = await resp.json();
    LOG('antipatterns loaded', allAntipatterns.length);
  } catch (err) {
    LOG('antipatterns load failed', err.message);
    allAntipatterns = [];
  }

  let stored;
  try {
    stored = await chrome.storage.sync.get({
      disabledRules: [], lineLengthMode: 'strict', spotlightBlur: true, autoScan: 'panel',
    });
  } catch (err) {
    LOG('storage.get failed', err.message);
    stored = { disabledRules: [], lineLengthMode: 'strict', spotlightBlur: true, autoScan: 'panel' };
  }

  disabledRules = stored.disabledRules;
  renderSettings();
  initSegmented('auto-scan-mode',    stored.autoScan,        (v) => chrome.storage.sync.set({ autoScan: v }));
  initSegmented('line-length-mode',  stored.lineLengthMode,  async (v) => {
    await chrome.storage.sync.set({ lineLengthMode: v });
    chrome.runtime.sendMessage({ action: 'disabled-rules-changed' }).catch(() => {});
  });
  initSpotlightBlur(stored.spotlightBlur);
}

function initSegmented(id, current, onChange) {
  const group = document.getElementById(id);
  if (!group) { LOG('initSegmented: element not found', id); return; }
  for (const btn of group.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.value === current);
    btn.addEventListener('click', async () => {
      for (const b of group.querySelectorAll('button')) b.classList.toggle('active', b === btn);
      try { await onChange(btn.dataset.value); } catch (err) { LOG('segmented onChange error', err); }
    });
  }
}

function initSpotlightBlur(current) {
  const cb = document.getElementById('spotlight-blur-toggle');
  if (!cb) return;
  cb.checked = current;
  cb.addEventListener('change', async () => {
    try {
      await chrome.storage.sync.set({ spotlightBlur: cb.checked });
      chrome.runtime.sendMessage({ action: 'disabled-rules-changed' }).catch(() => {});
    } catch (err) { LOG('spotlightBlur save error', err); }
  });
}

function renderSettings() {
  settingsList.innerHTML = '';
  const categories = {
    slop:    { label: 'AI tells',       items: [] },
    quality: { label: 'Quality issues', items: [] },
  };
  for (const ap of allAntipatterns) {
    (categories[ap.category] || categories.quality).items.push(ap);
  }
  for (const [, group] of Object.entries(categories)) {
    if (!group.items.length) continue;
    const header = document.createElement('div');
    header.className = 'settings-header';
    header.textContent = group.label;
    settingsList.appendChild(header);
    const grid = document.createElement('div');
    grid.className = 'settings-grid';
    for (const ap of group.items) {
      const label = document.createElement('label');
      label.className = 'setting-rule';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !disabledRules.includes(ap.id);
      cb.addEventListener('change', () => toggleRule(ap.id, cb.checked));
      const txt = document.createElement('span');
      txt.textContent = ap.name;
      label.appendChild(cb);
      label.appendChild(txt);
      grid.appendChild(label);
    }
    settingsList.appendChild(grid);
  }
}

async function toggleRule(ruleId, enabled) {
  disabledRules = enabled
    ? disabledRules.filter(id => id !== ruleId)
    : [...new Set([...disabledRules, ruleId])];
  try {
    await chrome.storage.sync.set({ disabledRules });
    chrome.runtime.sendMessage({ action: 'disabled-rules-changed' }).catch(() => {});
  } catch (err) { LOG('toggleRule save error', err); }
}

// ── Port message handler ──────────────────────────────────────────────────────
function handlePortMessage(msg) {
  LOG('port message', msg.action);

  if (msg.action === 'page-pointer-active') {
    setHoveredItem(null);
    return;
  }
  if (msg.action === 'findings' || msg.action === 'state') {
    removeScanOverlay();                     // FIX #7: remove overlay on results
    renderFindings(msg.findings || []);
    if (msg.overlaysVisible !== undefined) {
      overlaysVisible = msg.overlaysVisible;
      updateToggleBtn();
    }
    _isRescanning = false;
    return;
  }
  if (msg.action === 'overlays-toggled') {
    overlaysVisible = msg.visible;
    updateToggleBtn();
    return;
  }
  if (msg.action === 'navigated') {
    LOG('navigated — clearing findings');
    _isRescanning = false;
    showScanning();                          // full clear only on navigation
    return;
  }
}

// ── Connect + heartbeat ───────────────────────────────────────────────────────
getPort();
setInterval(() => postToPort({ action: 'ping' }), 20_000);

// ── Scan states ───────────────────────────────────────────────────────────────

// FIX #8: Navigation-triggered clear — destroys content, shows spinner
function showScanning() {
  currentFindings = [];
  badge.classList.remove('visible');
  badge.textContent = '0';
  container.innerHTML = `
    <div class="scanning-indicator">
      <div class="scanning-dot"></div>
      Scanning page…
    </div>`;
}

// FIX #7: Rescan overlay — non-destructive, sits above existing findings
function showRescanOverlay() {
  if (currentFindings.length === 0) {
    showScanning();
    return;
  }
  removeScanOverlay();
  const overlay = document.createElement('div');
  overlay.id    = 'scan-overlay';
  overlay.className = 'scan-overlay';
  overlay.setAttribute('role', 'status');
  overlay.innerHTML = `<div class="scanning-dot"></div><span>Re-scanning…</span>`;
  container.prepend(overlay);
}

function removeScanOverlay() {
  document.getElementById('scan-overlay')?.remove();
}

// ── Controls ──────────────────────────────────────────────────────────────────
btnRescan.addEventListener('click', () => {
  LOG('rescan clicked');
  _isRescanning = true;
  showRescanOverlay();       // FIX #7: non-destructive
  postToPort({ action: 'scan' });
});

btnToggle.addEventListener('click', () => {
  postToPort({ action: 'toggle-overlays' });
});

btnSettings.addEventListener('click', () => {
  const open = settingsContainer.style.display !== 'none';
  settingsContainer.style.display = open ? 'none' : '';
  btnSettings.classList.toggle('active', !open);
  btnSettings.setAttribute('aria-expanded', String(!open));
});

function updateToggleBtn() {
  btnToggle.title = overlaysVisible ? 'Hide overlays' : 'Show overlays';
  btnToggle.classList.toggle('inactive', !overlaysVisible);
}

// ── Clone toast ───────────────────────────────────────────────────────────────
let _cloneToastTimer = null;
function showCloneToast(msg, type = 'success') {
  cloneToast.textContent = msg;
  cloneToast.className   = `clone-toast visible ${type}`;
  clearTimeout(_cloneToastTimer);
  _cloneToastTimer = setTimeout(() => { cloneToast.className = 'clone-toast'; }, 3500);
}

// ── Clipboard ─────────────────────────────────────────────────────────────────
async function copyToClipboard(text, btn) {
  if (text instanceof Promise) text = await text;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.title;
      btn.title = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.title = orig; btn.classList.remove('copied'); }, 1200);
    }
    return true;
  } catch (err) {
    LOG('clipboard write failed', err.message);
    return false;
  }
}

// ── Clone Page ────────────────────────────────────────────────────────────────
btnClonePage.addEventListener('click', () => {
  LOG('clone-page');
  btnClonePage.disabled = true;

  chrome.devtools.inspectedWindow.eval(
    `(function() {
      try {
        var clone = document.documentElement.cloneNode(true);
        var sel = '.uichecker-overlay,.uichecker-label,.uichecker-banner' +
                  ',.uichecker-spotlight-backdrop,[id^="uichecker-live-"]';
        var nodes = clone.querySelectorAll(sel);
        for (var i = 0; i < nodes.length; i++) nodes[i].remove();
        return { ok: true, html: '<!DOCTYPE html>\\n' + clone.outerHTML };
      } catch(e) {
        return { ok: false, error: e.message };
      }
    })()`,
    (result, exInfo) => {
      btnClonePage.disabled = false;
      if (exInfo) {
        LOG('clone-page eval exception', exInfo.value);
        showCloneToast('Eval error: ' + exInfo.value, 'error');
        return;
      }
      if (!result?.ok) {
        LOG('clone-page failed', result?.error);
        showCloneToast('Clone failed: ' + (result?.error || 'unknown'), 'error');
        return;
      }
      LOG('clone-page ok', result.html.length, 'chars');
      copyToClipboard(result.html, btnClonePage).then(ok => {
        if (ok) showCloneToast(`Page HTML copied — ${result.html.length.toLocaleString()} chars`);
        else    showCloneToast('Clipboard write failed', 'error');
      });
    }
  );
});

// ── Clone Component ────────────────────────────────────────────────────────────
// FIX #6: Now has a visible text label in the toolbar.
// Uses $0 — only valid in DevTools context. Proper implementation.
btnCloneComp.addEventListener('click', () => {
  LOG('clone-component');
  btnCloneComp.disabled = true;

  chrome.devtools.inspectedWindow.eval(
    `(function() {
      var el = $0;
      if (!el || el === document.documentElement || el === document.body) {
        return { ok: false, reason: 'no-element' };
      }
      var PROPS = [
        'display','position','top','right','bottom','left',
        'width','height','min-width','min-height','max-width','max-height',
        'padding','padding-top','padding-right','padding-bottom','padding-left',
        'margin','margin-top','margin-right','margin-bottom','margin-left',
        'flex','flex-direction','flex-wrap','align-items','justify-content','gap',
        'grid','grid-template-columns','grid-template-rows','grid-column','grid-row',
        'background','background-color','background-image',
        'color','font-family','font-size','font-weight','font-style','line-height',
        'letter-spacing','text-align','text-transform',
        'border','border-top','border-right','border-bottom','border-left','border-radius',
        'box-shadow','opacity','overflow','overflow-x','overflow-y',
        'transform','transition','z-index','cursor','pointer-events'
      ];
      try {
        var cs      = window.getComputedStyle(el);
        var styles  = PROPS.map(function(p){ return p+':'+cs.getPropertyValue(p); }).join(';');
        var clone   = el.cloneNode(true);
        var artefacts = clone.querySelectorAll('.uichecker-overlay,.uichecker-label');
        for (var i = 0; i < artefacts.length; i++) artefacts[i].remove();
        var existing = clone.getAttribute('style') || '';
        clone.setAttribute('style', (existing ? existing + ';' : '') + styles);
        return { ok: true, html: clone.outerHTML, tag: el.tagName.toLowerCase() };
      } catch(e) {
        return { ok: false, reason: 'exception', error: e.message };
      }
    })()`,
    (result, exInfo) => {
      btnCloneComp.disabled = false;

      if (exInfo) {
        LOG('clone-component eval exception', exInfo.value);
        showCloneToast('Eval error: ' + exInfo.value, 'error');
        return;
      }
      if (!result?.ok) {
        if (result?.reason === 'no-element') {
          // FIX #6: shorter, actionable message — old was 80+ chars on a single line
          showCloneToast('Select an element in the Elements panel first, then click Clone Component', 'error');
        } else {
          LOG('clone-component failed', result?.error);
          showCloneToast('Extract failed: ' + (result?.error || result?.reason), 'error');
        }
        return;
      }
      LOG('clone-component ok', result.tag, result.html.length, 'chars');
      copyToClipboard(result.html, btnCloneComp).then(ok => {
        if (ok) showCloneToast(`<${result.tag}> HTML + computed styles copied`);
        else    showCloneToast('Clipboard write failed', 'error');
      });
    }
  );
});

// ── Copy all findings ─────────────────────────────────────────────────────────
btnCopyAll.addEventListener('click', () => {
  LOG('copy-all');
  copyToClipboard(formatFindingsForCopy(currentFindings), btnCopyAll);
});

// ── Hover tracking ────────────────────────────────────────────────────────────
let currentHoverSelector = null;
function setHoveredItem(selector) {
  if (selector === currentHoverSelector) return;
  currentHoverSelector = selector;
  postToPort(selector ? { action: 'highlight', selector } : { action: 'unhighlight' });
}

container.addEventListener('pointermove', (e) => {
  const item     = e.target.closest('.finding-item');
  const selector = item && !item.classList.contains('is-hidden') ? item.dataset.selector || null : null;
  setHoveredItem(selector);
});
container.addEventListener('pointerleave', () => setHoveredItem(null));
window.addEventListener('blur', () => setHoveredItem(null));

// ── Render findings ───────────────────────────────────────────────────────────
function renderFindings(findings) {
  LOG('renderFindings', findings.length, 'items');
  currentFindings = findings;

  if (!findings.length) {
    container.innerHTML = '';
    container.appendChild(emptyState);
    emptyState.style.display = '';
    badge.classList.remove('visible');
    badge.textContent = '0';
    return;
  }

  emptyState.style.display = 'none';
  const totalCount = findings.reduce((s, f) => s + f.findings.length, 0);
  badge.textContent = String(totalCount);
  badge.classList.add('visible');

  const categories = { slop: new Map(), quality: new Map() };
  for (const item of findings) {
    for (const f of item.findings) {
      const cat    = f.category || 'quality';
      const groups = categories[cat] || categories.quality;
      if (!groups.has(f.type)) {
        groups.set(f.type, { name: f.name, description: f.description, items: [] });
      }
      groups.get(f.type).items.push({
        selector: item.selector, tagName: item.tagName,
        isPageLevel: item.isPageLevel, isHidden: item.isHidden, detail: f.detail,
      });
    }
  }

  container.innerHTML = '';
  const LABELS = { slop: 'AI tells', quality: 'Quality issues' };

  for (const [catKey, groups] of Object.entries(categories)) {
    if (groups.size === 0) continue;
    const catCount = [...groups.values()].reduce((s, g) => s + g.items.length, 0);
    const section  = document.createElement('div');
    section.className = `category-section category-${catKey}`;

    const catHeader = document.createElement('div');
    catHeader.className = 'category-header';
    catHeader.innerHTML = `
      <span class="category-dot category-dot-${catKey}"></span>
      <span class="category-name">${LABELS[catKey]}</span>
      <span class="category-count">${catCount}</span>`;
    section.appendChild(catHeader);

    for (const [type, group] of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'finding-group';

      const header = document.createElement('div');
      header.className = 'group-header';
      header.innerHTML = `
        <span class="group-chevron">&#9660;</span>
        <span class="group-name">${escapeHtml(group.name)}</span>
        <span class="group-count">${group.items.length}</span>`;
      header.addEventListener('click', () => header.classList.toggle('collapsed'));
      groupEl.appendChild(header);

      const itemsEl = document.createElement('div');
      itemsEl.className = 'group-items';

      for (const item of group.items) {
        const itemEl  = document.createElement('div');
        itemEl.className = 'finding-item' + (item.isHidden ? ' is-hidden' : '');
        const tag = item.isPageLevel
          ? '<span class="finding-tag tag-page">page</span>'
          : item.isHidden
            ? '<span class="finding-tag tag-hidden" title="Element is hidden on the page">hidden</span>'
            : '';
        itemEl.innerHTML = `
          ${tag}
          <div class="finding-row">
            <span class="finding-selector">${escapeHtml(item.selector)}</span>
            <button class="finding-copy" title="Copy this finding" aria-label="Copy finding to clipboard">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M11 1H3a2 2 0 0 0-2 2v10h2V3h8V1zm3 3H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 11H7V6h7v9z" fill="currentColor"/>
              </svg>
            </button>
          </div>
          <span class="finding-detail">${escapeHtml(item.detail)}</span>
          <span class="finding-description">${escapeHtml(group.description)}</span>`;

        const copyBtn = itemEl.querySelector('.finding-copy');
        const finding = { type, name: group.name, description: group.description, detail: item.detail };
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          copyToClipboard(formatSingleFindingForCopy(item, finding), copyBtn);
        });

        if (!item.isPageLevel && !item.isHidden) {
          itemEl.dataset.selector = item.selector;
          itemEl.addEventListener('click', () => inspectElement(item.selector));
        }
        itemsEl.appendChild(itemEl);
      }

      groupEl.appendChild(itemsEl);
      section.appendChild(groupEl);
    }
    container.appendChild(section);
  }
}

function inspectElement(selector) {
  const json = JSON.stringify(selector);
  chrome.devtools.inspectedWindow.eval(
    `(function(){ var el=document.querySelector(${json}); if(el){ el.scrollIntoView({behavior:'smooth',block:'center'}); inspect(el); } })()`
  );
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Copy formatters ───────────────────────────────────────────────────────────
const FIX_SKILLS = {
  'side-tab':'distill, polish','border-accent-on-rounded':'distill, polish',
  'overused-font':'typeset','single-font':'typeset','flat-type-hierarchy':'typeset',
  'gradient-text':'typeset, distill','ai-color-palette':'colorize, distill',
  'nested-cards':'distill, arrange','monotonous-spacing':'arrange',
  'everything-centered':'arrange','bounce-easing':'animate',
  'dark-glow':'quieter, distill','icon-tile-stacked-above-heading':'distill, arrange',
  'pure-black-white':'colorize','gray-on-color':'colorize',
  'low-contrast':'colorize, audit','layout-transition':'animate, optimize',
  'line-length':'arrange, typeset','cramped-padding':'arrange, polish',
  'tight-leading':'typeset','skipped-heading':'audit, harden',
  'justified-text':'typeset','tiny-text':'typeset',
  'all-caps-body':'typeset','wide-tracking':'typeset',
};

function fixSkillFor(type) {
  return (FIX_SKILLS[type] || 'polish').split(',').map(s => '/' + s.trim()).join(', ');
}

function uniqueSkillsForFindings(findings) {
  const counts = new Map();
  for (const item of findings) {
    for (const f of item.findings) {
      for (const s of (FIX_SKILLS[f.type] || 'polish').split(',').map(s => '/' + s.trim())) {
        counts.set(s, (counts.get(s) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

function getInspectedUrl() {
  return new Promise(resolve => {
    chrome.devtools.inspectedWindow.eval(
      '(function(){var u=new URL(location.href);u.hash="";return u.toString()})()',
      r => resolve(typeof r === 'string' ? r : '')
    );
  });
}

async function formatFindingsForCopy(findings) {
  if (!findings.length) return 'UI Checker found no anti-patterns on this page.';
  const url = await getInspectedUrl();
  const lines = ['# UI Checker findings'];
  if (url) lines.push(`URL: ${url}`);
  lines.push('');
  const groups = { slop: [], quality: [] };
  for (const item of findings) {
    for (const f of item.findings) {
      (groups[f.category] || groups.quality).push({ ...f, selector: item.selector, isPageLevel: item.isPageLevel });
    }
  }
  if (groups.slop.length) {
    lines.push(`## AI tells (${groups.slop.length})`);
    for (const f of groups.slop) lines.push(`- **${f.name}** at ${f.isPageLevel ? '_(page-level)_' : `\`${f.selector}\``}: ${f.detail}`);
    lines.push('');
  }
  if (groups.quality.length) {
    lines.push(`## Quality issues (${groups.quality.length})`);
    for (const f of groups.quality) lines.push(`- **${f.name}** at ${f.isPageLevel ? '_(page-level)_' : `\`${f.selector}\``}: ${f.detail}`);
    lines.push('');
  }
  const skills = uniqueSkillsForFindings(findings);
  if (skills.length) { lines.push(`Suggested fixes: ${skills.join(', ')}`); lines.push(''); }
  lines.push('---');
  lines.push('Detected by UI Checker.');
  return lines.join('\n');
}

async function formatSingleFindingForCopy(item, finding) {
  const url   = await getInspectedUrl();
  const where = item.isPageLevel ? '_(page-level)_' : `\`${item.selector}\``;
  return [
    `# UI Checker: ${finding.name}`,
    url ? `URL: ${url}` : '',
    `Element: ${where}`,
    `Detail: ${finding.detail}`,
    '',
    finding.description,
    '',
    `Fix: ${fixSkillFor(finding.type)}`,
  ].filter(l => l !== null).join('\n');
}

initSettings();
