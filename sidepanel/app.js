/**
 * UI Checker v2 — Side Panel App
 * Handles: tab switching, window.ai audit, SEO display, clone stream,
 *          port connection, settings, deterministic findings render
 */

const LOG = (...a) => console.debug('[uichecker:sidepanel]', ...a);

// ── Get current inspected tab ─────────────────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ── Port (auto-reconnecting to SW) ────────────────────────────────────────────
let port = null;
let activeTabId = null;

async function connectPort() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  activeTabId = tab.id;

  port = chrome.runtime.connect({ name: `uichecker-sidepanel-${tab.id}` });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    LOG('port disconnected, reconnecting...');
    port = null;
    setTimeout(connectPort, 1000);
  });
  LOG('port connected for tab', tab.id);
}

function postToPort(msg) {
  try { port?.postMessage(msg); }
  catch (e) { LOG('postToPort error', e.message); connectPort(); }
}

// Keep SW alive
setInterval(() => postToPort({ action: 'ping' }), 20_000);

// ── DOM refs ──────────────────────────────────────────────────────────────────
const totalBadge       = document.getElementById('total-badge');
const btnSettings      = document.getElementById('btn-settings');
const settingsPanel    = document.getElementById('settings-panel');
const apiKeyInput      = document.getElementById('api-key-input');
const btnSaveKey       = document.getElementById('btn-save-key');
const keyStatus        = document.getElementById('key-status');
const autoScanToggle   = document.getElementById('auto-scan-toggle');
const spotlightToggle  = document.getElementById('spotlight-toggle');

// Audit tab
const btnAudit         = document.getElementById('btn-audit');
const btnToggleOverlays= document.getElementById('btn-toggle-overlays');
const aiStatusBar      = document.getElementById('ai-status-bar');
const aiStatusText     = document.getElementById('ai-status-text');
const auditSummary     = document.getElementById('audit-summary');
const slopCount        = document.getElementById('slop-count');
const qualityCount     = document.getElementById('quality-count');
const chatContainer    = document.getElementById('chat-container');
const auditEmpty       = document.getElementById('audit-empty');
const aiAvailBadge     = document.getElementById('ai-availability-badge');
const findingsSection  = document.getElementById('findings-section');
const findingsList     = document.getElementById('findings-list');
const btnCopyFindings  = document.getElementById('btn-copy-findings');

// SEO tab
const btnSeoAudit      = document.getElementById('btn-seo-audit');
const seoScoreBlock    = document.getElementById('seo-score-block');
const seoScoreNum      = document.getElementById('seo-score-number');
const ringFill         = document.getElementById('ring-fill');
const seoMeta          = document.getElementById('seo-meta');
const seoFindingsList  = document.getElementById('seo-findings-list');
const seoEmpty         = document.getElementById('seo-empty');

// Clone tab
const btnInspector     = document.getElementById('btn-inspector-toggle');
const inspectorLabel   = document.getElementById('inspector-btn-label');
const inspectorHint    = document.getElementById('inspector-hint');
const sandboxWrap      = document.getElementById('sandbox-wrap');
const sandboxIframe    = document.getElementById('sandbox-iframe');
const codeBlockWrap    = document.getElementById('code-block-wrap');
const codeOutput       = document.getElementById('code-output');
const btnCopyCode      = document.getElementById('btn-copy-code');
const btnCopyCode2     = document.getElementById('btn-copy-code-2');
const cloneEmpty       = document.getElementById('clone-empty');

// ── State ─────────────────────────────────────────────────────────────────────
let currentFindings = [];
let currentCode     = '';
let inspectorOn     = false;
let aiSession       = null;

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────
btnSettings.addEventListener('click', () => {
  const open = settingsPanel.style.display !== 'none';
  settingsPanel.style.display = open ? 'none' : '';
  btnSettings.classList.toggle('active', !open);
});

async function loadSettings() {
  const stored = await chrome.storage.local.get(['geminiApiKey', 'autoScan', 'spotlightBlur']);
  if (stored.geminiApiKey) {
    apiKeyInput.value = '••••••••••••';
    keyStatus.textContent = '✓ API key saved';
  }
  autoScanToggle.checked = stored.autoScan !== false;
  spotlightToggle.checked = stored.spotlightBlur !== false;
}

btnSaveKey.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key || key.includes('•')) return;
  await chrome.storage.local.set({ geminiApiKey: key });
  apiKeyInput.value = '••••••••••••';
  keyStatus.textContent = '✓ API key saved';
  LOG('API key saved');
});

autoScanToggle.addEventListener('change', () => {
  chrome.storage.local.set({ autoScan: autoScanToggle.checked });
});
spotlightToggle.addEventListener('change', () => {
  chrome.storage.local.set({ spotlightBlur: spotlightToggle.checked });
});

// ── window.ai availability check ─────────────────────────────────────────────
async function checkAIAvailability() {
  try {
    if (!window.ai?.languageModel) {
      aiAvailBadge.textContent = '⚠ Chrome 127+ with Gemini Nano required';
      aiAvailBadge.className = 'ai-badge unavailable';
      LOG('window.ai not available');
      return 'unavailable';
    }
    const avail = await window.ai.languageModel.availability();
    LOG('window.ai availability:', avail);
    if (avail === 'available' || avail === 'readily') {
      aiAvailBadge.textContent = '✓ Gemini Nano ready (local)';
      aiAvailBadge.className = 'ai-badge available';
      aiStatusBar.style.display = 'flex';
      aiStatusText.textContent = 'Gemini Nano · local · free';
      return 'available';
    } else {
      aiAvailBadge.textContent = '⚠ Gemini Nano downloading (or enable in chrome://flags)';
      aiAvailBadge.className = 'ai-badge unavailable';
      return 'unavailable';
    }
  } catch (e) {
    LOG('window.ai check error', e.message);
    aiAvailBadge.textContent = '⚠ Local AI unavailable — cloud fallback active';
    aiAvailBadge.className = 'ai-badge unavailable';
    return 'unavailable';
  }
}

// ── Audit Page ────────────────────────────────────────────────────────────────
btnAudit.addEventListener('click', async () => {
  LOG('audit triggered');
  btnAudit.disabled = true;
  btnAudit.innerHTML = '<div class="spinner"></div> Scanning…';

  // 1. Trigger deterministic scan via SW
  postToPort({ action: 'scan' });

  // 2. Extract DOM for AI audit
  try {
    const tab = await getActiveTab();
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { action: 'extract-audit-dom' });
    }
  } catch (e) { LOG('extract-audit-dom error', e.message); }
});

// ── Handle DOM for AI audit (from SW) ────────────────────────────────────────
async function runAIAudit(dom) {
  btnAudit.disabled = false;
  btnAudit.innerHTML = `<svg viewBox="0 0 14 14" fill="none" width="12" height="12"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 7l2 2 3-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Audit Page`;

  auditEmpty.style.display = 'none';
  const msgEl = appendChatMsg('', 'ai');
  msgEl.classList.add('streaming-cursor');

  const prompt = `You are a senior UX/UI researcher and conversion optimization expert.
Analyze this webpage DOM structure for:
1. Cognitive load and information hierarchy
2. Call-to-action clarity and button hierarchy
3. Accessibility issues (contrast, focus, ARIA)
4. Conversion friction points
5. Mobile and responsive red flags

Page URL: ${dom.url}
Page Title: ${dom.title}

DOM structure (simplified):
${dom.html.slice(0, 8000)}

Key text content:
${dom.text.slice(0, 2000)}

Provide a prioritized list of findings. Format each as:
🔴 Critical / 🟡 Warning / 🟢 Suggestion
[Finding]: [Specific fix in one sentence]

Be direct, specific, and actionable. Maximum 8 findings.`;

  const avail = await checkAIAvailability();

  if (avail === 'available') {
    // Local Gemini Nano
    try {
      if (!aiSession) {
        aiSession = await window.ai.languageModel.create({
          systemPrompt: 'You are a senior UX/UI researcher. Give direct, actionable feedback. No fluff.',
        });
      }
      const stream = aiSession.promptStreaming(prompt);
      let text = '';
      for await (const chunk of stream) {
        text = chunk;
        msgEl.textContent = text;
      }
      msgEl.classList.remove('streaming-cursor');
      LOG('AI audit complete (local)');
    } catch (e) {
      LOG('Gemini Nano error, falling back', e.message);
      msgEl.textContent = 'Local AI error: ' + e.message;
      msgEl.classList.remove('streaming-cursor');
    }
  } else {
    // Cloud fallback — request via SW
    msgEl.textContent = 'Local AI not available. Add a Gemini API key in Settings to enable cloud audit.';
    msgEl.classList.remove('streaming-cursor');
  }
}

// ── Deterministic findings render ─────────────────────────────────────────────
function renderFindings(findings) {
  currentFindings = findings;
  const total = findings.reduce((s, f) => s + (f.findings?.length || 0), 0);
  if (total === 0) { findingsSection.style.display = 'none'; return; }

  let slop = 0, quality = 0;
  findingsList.innerHTML = '';
  for (const item of findings) {
    for (const f of item.findings) {
      if (f.category === 'slop') slop++;
      else quality++;
      const el = document.createElement('div');
      el.className = `finding-item finding-item--${f.category || 'quality'}`;
      el.innerHTML = `
        <div class="finding-selector">${escHtml(item.selector)}</div>
        <div class="finding-name">${escHtml(f.name)}</div>
        <div class="finding-detail">${escHtml(f.detail)}</div>`;
      findingsList.appendChild(el);
    }
  }

  slopCount.textContent = slop;
  qualityCount.textContent = quality;
  auditSummary.style.display = 'flex';
  findingsSection.style.display = '';

  // Update total badge
  const grandTotal = total + (document.getElementById('seo-score-number').textContent === '0' ? 0 : 0);
  totalBadge.textContent = total;
  totalBadge.style.display = total > 0 ? '' : 'none';
}

btnCopyFindings.addEventListener('click', async () => {
  if (!currentFindings.length) return;
  const text = currentFindings.flatMap(item =>
    item.findings.map(f => `[${f.category}] ${f.name} at ${item.selector}: ${f.detail}`)
  ).join('\n');
  await navigator.clipboard.writeText(text);
  btnCopyFindings.textContent = 'Copied!';
  setTimeout(() => { btnCopyFindings.textContent = 'Copy all'; }, 1500);
});

// ── SEO Audit ─────────────────────────────────────────────────────────────────
btnSeoAudit.addEventListener('click', async () => {
  LOG('SEO audit triggered');
  btnSeoAudit.disabled = true;
  btnSeoAudit.innerHTML = '<div class="spinner"></div> Scanning…';
  try {
    const tab = await getActiveTab();
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { action: 'extract-seo' });
    }
  } catch (e) {
    LOG('extract-seo error', e.message);
    btnSeoAudit.disabled = false;
    btnSeoAudit.textContent = 'Run SEO Audit';
  }
});

function renderSEO(data) {
  btnSeoAudit.disabled = false;
  btnSeoAudit.innerHTML = `<svg viewBox="0 0 14 14" fill="none" width="12" height="12"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 10l2.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Run SEO Audit`;
  seoEmpty.style.display = 'none';
  seoScoreBlock.style.display = 'flex';

  // Score ring
  const score = data.score || 0;
  seoScoreNum.textContent = score;
  const circ = 2 * Math.PI * 34; // 213.6
  const offset = circ * (1 - score / 100);
  ringFill.style.strokeDashoffset = offset;
  ringFill.style.stroke = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';

  // Meta info
  seoMeta.innerHTML = [
    data.title ? `<div class="seo-meta-row"><strong>Title</strong> ${escHtml(data.title.slice(0, 45))}…</div>` : '',
    data.canonical ? `<div class="seo-meta-row"><strong>Canonical</strong> ✓</div>` : '',
    data.perf?.load ? `<div class="seo-meta-row"><strong>Load</strong> ${data.perf.load}ms</div>` : '',
    data.lcp ? `<div class="seo-meta-row"><strong>LCP</strong> ${data.lcp}ms</div>` : '',
  ].join('');

  // Findings
  seoFindingsList.innerHTML = '';
  const groups = [
    { key: 'critical', label: 'Critical', items: data.critical || [] },
    { key: 'warning',  label: 'Warnings', items: data.warnings || [] },
    { key: 'info',     label: 'Info',     items: data.info     || [] },
  ];
  for (const group of groups) {
    if (!group.items.length) continue;
    const gEl = document.createElement('div');
    gEl.className = 'seo-group';
    const header = document.createElement('div');
    header.className = 'seo-group-header';
    header.textContent = `${group.label} (${group.items.length})`;
    gEl.appendChild(header);
    for (const item of group.items) {
      const iEl = document.createElement('div');
      iEl.className = `seo-finding-item seo-finding-item--${group.key}`;
      iEl.innerHTML = `<div class="seo-finding-label">${escHtml(item.label)}</div>${item.fix ? `<div class="seo-finding-fix">Fix: ${escHtml(item.fix)}</div>` : ''}`;
      gEl.appendChild(iEl);
    }
    seoFindingsList.appendChild(gEl);
  }
  LOG('SEO rendered', { score, critical: data.critical?.length, warnings: data.warnings?.length });
}

// ── Inspector / Component Cloner ──────────────────────────────────────────────
btnInspector.addEventListener('click', async () => {
  inspectorOn = !inspectorOn;
  if (inspectorOn) {
    postToPort({ action: 'start-inspector' });
    inspectorLabel.textContent = 'Inspector ON — click element';
    btnInspector.classList.add('active');
    inspectorHint.style.display = 'flex';
    LOG('inspector enabled');
  } else {
    postToPort({ action: 'stop-inspector' });
    inspectorLabel.textContent = 'Enable Inspector';
    btnInspector.classList.remove('active');
    inspectorHint.style.display = 'none';
    LOG('inspector disabled');
  }
});

function handleCloneChunk(text) {
  currentCode += text;
  codeOutput.textContent = currentCode;
  cloneEmpty.style.display = 'none';
  codeBlockWrap.style.display = 'flex';
  // Send to sandbox
  sandboxIframe.contentWindow?.postMessage({ type: 'RENDER_CODE', code: currentCode }, '*');
}

function handleCloneDone() {
  inspectorOn = false;
  inspectorLabel.textContent = 'Enable Inspector';
  btnInspector.classList.remove('active');
  inspectorHint.style.display = 'none';
  sandboxWrap.style.display = '';
  LOG('clone complete, code length:', currentCode.length);
}

function handleCloneStart() {
  currentCode = '';
  codeOutput.textContent = '';
  cloneEmpty.style.display = 'none';
  codeBlockWrap.style.display = 'flex';
  appendChatMsg('', 'system'); // just UI feedback
  LOG('clone started');
}

[btnCopyCode, btnCopyCode2].forEach(btn => {
  btn?.addEventListener('click', async () => {
    if (!currentCode) return;
    await navigator.clipboard.writeText(currentCode);
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
});

// ── Toggle overlays ───────────────────────────────────────────────────────────
btnToggleOverlays.addEventListener('click', () => postToPort({ action: 'toggle-overlays' }));

// ── Port message handler ──────────────────────────────────────────────────────
function handlePortMessage(msg) {
  LOG('port msg', msg.action);
  switch (msg.action) {
    case 'state':
    case 'findings':
      renderFindings(msg.findings || []);
      btnAudit.disabled = false;
      btnAudit.innerHTML = `<svg viewBox="0 0 14 14" fill="none" width="12" height="12"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 7l2 2 3-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Audit Page`;
      break;
    case 'dom-for-audit':
      runAIAudit(msg.dom);
      break;
    case 'seo-data':
      renderSEO(msg.data);
      break;
    case 'scan-started':
      appendChatMsg('Scanning page…', 'system');
      break;
    case 'scan-error':
      appendChatMsg('Error: ' + msg.error, 'error');
      btnAudit.disabled = false;
      break;
    case 'clone-started':
      handleCloneStart();
      break;
    case 'clone-chunk':
      handleCloneChunk(msg.text);
      break;
    case 'clone-done':
      handleCloneDone();
      break;
    case 'clone-error':
      appendChatMsg('Clone error: ' + msg.error, 'error');
      btnInspector.classList.remove('active');
      inspectorLabel.textContent = 'Enable Inspector';
      break;
    case 'navigated':
      appendChatMsg('Page navigated — ready to scan.', 'system');
      break;
  }
}

// ── Chat helpers ──────────────────────────────────────────────────────────────
function appendChatMsg(text, type = 'ai') {
  auditEmpty.style.display = 'none';
  const el = document.createElement('div');
  el.className = `chat-msg chat-msg--${type}`;
  el.textContent = text;
  chatContainer.appendChild(el);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return el;
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  await connectPort();
  await checkAIAvailability();

  // Auto-scan if enabled
  const stored = await chrome.storage.local.get('autoScan');
  if (stored.autoScan !== false) {
    setTimeout(() => postToPort({ action: 'scan' }), 800);
  }
}

init();
