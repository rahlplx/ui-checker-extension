/**
 * UI Checker v2 — Service Worker
 * Handles: Side Panel, BYOK Gemini API, scanId ACK system, storage-backed state
 */

// ── Debug ─────────────────────────────────────────────────────────────────────
const LOG = (...a) => console.debug('[uichecker:sw-v2]', ...a);

// ── Side Panel: open on action icon click ─────────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionIconClick: true })
  .catch(err => LOG('setPanelBehavior error', err));

// ── State helpers (chrome.storage.session — survives SW restart, clears on browser close) ──
async function getTabState(tabId) {
  const key = `tab_${tabId}`;
  const result = await chrome.storage.session.get(key);
  return result[key] || {
    findings: [], overlaysVisible: true, injected: false,
    csInjected: false, seoData: null, lastUrl: null,
  };
}

async function setTabState(tabId, patch) {
  const key = `tab_${tabId}`;
  const current = await getTabState(tabId);
  await chrome.storage.session.set({ [key]: { ...current, ...patch } });
}

// ── ScanId ACK system (replaces probe-ping race condition) ────────────────────
// SW generates a unique scanId, injects detector, waits for ACK with matching scanId
// before sending scan command. No race condition.
const pendingScans = new Map(); // scanId → { tabId, resolve, timeout }

function generateScanId() {
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function waitForDetectorReady(tabId, scanId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingScans.delete(scanId);
      reject(new Error(`Detector ACK timeout for scanId ${scanId}`));
    }, timeoutMs);
    pendingScans.set(scanId, { tabId, resolve, timeout: timer });
  });
}

// ── Badge ─────────────────────────────────────────────────────────────────────
async function updateBadge(tabId) {
  const state = await getTabState(tabId);
  const count = state.findings?.reduce((s, f) => s + (f.findings?.length || 0), 0) || 0;
  const seoIssues = state.seoData?.critical?.length || 0;
  const total = count + seoIssues;
  chrome.action.setBadgeText({ text: total > 0 ? String(total) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId });
}

// ── Panel ports ───────────────────────────────────────────────────────────────
const panelPorts = new Map(); // tabId → Set<Port>

function notifyPanel(tabId, msg) {
  const ports = panelPorts.get(tabId);
  if (!ports) return;
  for (const port of ports) {
    try { port.postMessage(msg); } catch (e) { LOG('port send error', e.message); }
  }
}

// ── Port connections ──────────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener(port => {
  const match = port.name.match(/^uichecker-sidepanel-(\d+)$/);
  if (!match) return;
  const tabId = parseInt(match[1]);
  LOG('side panel connected for tab', tabId);

  if (!panelPorts.has(tabId)) panelPorts.set(tabId, new Set());
  panelPorts.get(tabId).add(port);

  // Send current state on connect
  getTabState(tabId).then(state => {
    port.postMessage({ action: 'state', ...state });
  });

  port.onMessage.addListener(async msg => {
    LOG('panel msg', msg.action);
    if (msg.action === 'ping') return; // heartbeat
    if (msg.action === 'scan') await triggerScan(tabId);
    if (msg.action === 'toggle-overlays') await toggleOverlays(tabId);
    if (msg.action === 'start-inspector') await startInspector(tabId);
    if (msg.action === 'stop-inspector') await stopInspector(tabId);
  });

  port.onDisconnect.addListener(() => {
    panelPorts.get(tabId)?.delete(port);
    LOG('side panel disconnected for tab', tabId);
  });
});

// ── Content Script injection ───────────────────────────────────────────────────
async function ensureContentScript(tabId) {
  const state = await getTabState(tabId);
  if (state.csInjected) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/inspector.js'],
      injectImmediately: true,
    });
    await setTabState(tabId, { csInjected: true });
    LOG('content script injected for tab', tabId);
    return true;
  } catch (err) {
    LOG('content script injection failed', tabId, err.message);
    return false;
  }
}

// ── Scan trigger with scanId ACK ──────────────────────────────────────────────
async function triggerScan(tabId) {
  LOG('triggerScan', tabId);
  notifyPanel(tabId, { action: 'scan-started' });

  const ok = await ensureContentScript(tabId);
  if (!ok) {
    notifyPanel(tabId, { action: 'scan-error', error: 'Cannot access this page (restricted URL)' });
    return;
  }

  const scanId = generateScanId();
  const config = await buildScanConfig();

  try {
    // Inject detector into MAIN world
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['detector/detect.js'],
    });
    LOG('detector injected, waiting for ACK', scanId);

    // Wait for detector to post ready with matching scanId
    await waitForDetectorReady(tabId, scanId);
    LOG('detector ACK received', scanId);

    // Send scan command
    await chrome.tabs.sendMessage(tabId, { action: 'scan', scanId, config });
  } catch (err) {
    LOG('triggerScan error', err.message);
    notifyPanel(tabId, { action: 'scan-error', error: err.message });
  }
}

// ── Build scan config from storage ───────────────────────────────────────────
async function buildScanConfig() {
  const stored = await chrome.storage.sync.get({
    disabledRules: [], lineLengthMode: 'strict', spotlightBlur: true,
  });
  return {
    disabledRules: stored.disabledRules,
    lineLength: stored.lineLengthMode === 'strict' ? 80 : 120,
    spotlightBlur: stored.spotlightBlur,
  };
}

// ── Toggle overlays ───────────────────────────────────────────────────────────
async function toggleOverlays(tabId) {
  await chrome.tabs.sendMessage(tabId, { action: 'toggle-overlays' }).catch(() => {});
  const state = await getTabState(tabId);
  await setTabState(tabId, { overlaysVisible: !state.overlaysVisible });
}

// ── Inspector mode ────────────────────────────────────────────────────────────
async function startInspector(tabId) {
  await ensureContentScript(tabId);
  await chrome.tabs.sendMessage(tabId, { action: 'start-inspector' }).catch(() => {});
}

async function stopInspector(tabId) {
  await chrome.tabs.sendMessage(tabId, { action: 'stop-inspector' }).catch(() => {});
}

// ── Message handlers ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  LOG('message', msg.action, 'from tab', tabId);

  // ScanId ACK from detector
  if (msg.action === 'detector-ready' && msg.scanId) {
    const pending = pendingScans.get(msg.scanId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingScans.delete(msg.scanId);
      pending.resolve();
    }
    sendResponse({ ok: true });
    return true;
  }

  // UI findings from detector
  if (msg.action === 'findings' && tabId) {
    setTabState(tabId, { findings: msg.findings || [], injected: true })
      .then(() => updateBadge(tabId))
      .then(() => notifyPanel(tabId, { action: 'findings', findings: msg.findings }));
    sendResponse({ ok: true });
    return true;
  }

  // SEO data from inspector
  if (msg.action === 'seo-data' && tabId) {
    setTabState(tabId, { seoData: msg.data })
      .then(() => updateBadge(tabId))
      .then(() => notifyPanel(tabId, { action: 'seo-data', data: msg.data }));
    sendResponse({ ok: true });
    return true;
  }

  // DOM/component data for cloning → Gemini 2.5 Pro
  if (msg.action === 'clone-component' && tabId) {
    handleComponentClone(tabId, msg.payload);
    sendResponse({ ok: true });
    return true;
  }

  // DOM data for local AI audit (passed to side panel)
  if (msg.action === 'dom-for-audit' && tabId) {
    notifyPanel(tabId, { action: 'dom-for-audit', dom: msg.dom });
    sendResponse({ ok: true });
    return true;
  }

  // Overlay toggle result from content script
  if (msg.action === 'overlays-toggled' && tabId) {
    notifyPanel(tabId, { action: 'overlays-toggled', visible: msg.visible });
    return true;
  }
});

// ── Gemini 2.5 Pro: Component Cloner (BYOK) ──────────────────────────────────
async function handleComponentClone(tabId, payload) {
  notifyPanel(tabId, { action: 'clone-started' });

  const stored = await chrome.storage.local.get('geminiApiKey');
  const apiKey = stored.geminiApiKey;

  if (!apiKey) {
    notifyPanel(tabId, { action: 'clone-error', error: 'No Gemini API key set. Add it in Settings.' });
    return;
  }

  const prompt = buildClonePrompt(payload);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
          systemInstruction: {
            parts: [{ text: 'You are a React and Tailwind CSS expert. Convert raw HTML/CSS into clean, reusable React components using only Tailwind utility classes. Output ONLY valid JSX code. No markdown fences, no explanation.' }]
          }
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `HTTP ${response.status}`);
    }

    // Stream chunks to panel
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const json = JSON.parse(line.slice(6));
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) notifyPanel(tabId, { action: 'clone-chunk', text });
        } catch {}
      }
    }
    notifyPanel(tabId, { action: 'clone-done' });
    LOG('component clone complete for tab', tabId);

  } catch (err) {
    LOG('Gemini API error', err.message);
    notifyPanel(tabId, { action: 'clone-error', error: err.message });
  }
}

function buildClonePrompt(payload) {
  return `Convert this web component to clean React + Tailwind CSS.

ELEMENT TAG: ${payload.tag}
OUTER HTML:
${payload.html}

CRITICAL STYLES (layout, color, typography, spacing only):
${payload.css}

Rules:
- Output a single React functional component
- Replace all computed pixel values with nearest Tailwind utilities
- Extract hardcoded hex colors as Tailwind arbitrary values e.g. bg-[#3b82f6]
- Remove all inline styles — use only Tailwind classes
- Component must be self-contained and renderable standalone
- Export as default export named Component
- Include sample props where needed with sensible defaults`;
}

// ── Navigation: reset state on page change ────────────────────────────────────
chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  LOG('navigation completed', tabId, url);
  await setTabState(tabId, {
    findings: [], injected: false, csInjected: false,
    seoData: null, lastUrl: url,
  });
  notifyPanel(tabId, { action: 'navigated' });
});

// ── Tab cleanup ───────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async tabId => {
  await chrome.storage.session.remove(`tab_${tabId}`);
  panelPorts.delete(tabId);
});

LOG('service worker v2 initialized');
