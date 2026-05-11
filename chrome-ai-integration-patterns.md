# Chrome Built-in AI Integration Patterns for UI Checker

> Analysis of Google's official Chrome extension AI samples and their application to the UI Checker extension.

---

## Table of Contents

1. [Sample Analysis: ai.gemini-on-device](#1-sample-analysis-aigemini-on-device)
2. [Sample Analysis: ai.gemini-on-device-summarization](#2-sample-analysis-aigemini-on-device-summarization)
3. [API Surface Reference](#3-api-surface-reference)
4. [Capability Detection Pattern](#4-capability-detection-pattern)
5. [Session Management](#5-session-management)
6. [Prompt Engineering for UI Analysis](#6-prompt-engineering-for-ui-analysis)
7. [Response Handling & Streaming](#7-response-handling--streaming)
8. [Content Security Policy Considerations](#8-content-security-policy-considerations)
9. [Service Worker Integration Patterns](#9-service-worker-integration-patterns)
10. [Integration into UI Checker Architecture](#10-integration-into-ui-checker-architecture)
11. [Error Handling and Fallback Strategies](#11-error-handling-and-fallback-strategies)
12. [Performance Considerations](#12-performance-considerations)
13. [Manifest Requirements](#13-manifest-requirements)

---

## 1. Sample Analysis: ai.gemini-on-device

### File Structure

```
ai.gemini-on-device/
├── .gitignore
├── README.md
├── background.js           # Minimal SW — only sets sidePanel behavior
├── manifest.json           # MV3, min Chrome 138, sidePanel permission
├── package.json            # Rollup build with dompurify + marked
├── package-lock.json
├── privacy.txt             # Privacy declaration
├── rollup.config.mjs       # Bundles sidepanel/index.js → dist/sidepanel (IIFE)
├── images/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── sidepanel/
    ├── index.html          # Chat UI with temperature/top-k sliders
    ├── index.js            # Core AI logic — LanguageModel API usage
    └── index.css           # Minimal styles
```

### manifest.json

```json
{
  "name": "Chrome Prompt AI Demo",
  "version": "0.2",
  "manifest_version": 3,
  "description": "Try Chrome's built-in prompt API built with Gemini Nano.",
  "background": {
    "service_worker": "background.js"
  },
  "permissions": ["sidePanel"],
  "minimum_chrome_version": "138",
  "side_panel": {
    "default_path": "sidepanel/index.html"
  },
  "action": {
    "default_icon": { "16": "images/icon16.png", ... },
    "default_title": "Open Chat Interface"
  }
}
```

**Key observations:**
- Only `sidePanel` permission needed — no special AI permissions
- `minimum_chrome_version: "138"` — AI APIs require recent Chrome
- No origin trial tokens (LanguageModel/Prompt API is shipping stable)
- No `host_permissions` — the AI runs entirely client-side

### How It Uses the LanguageModel API

```javascript
/* global LanguageModel */

// Create a session with parameters
const session = await LanguageModel.create({
  initialPrompts: [
    { role: 'system', content: 'You are a helpful and friendly assistant.' }
  ],
  temperature: sliderTemperature.value,
  topK: sliderTopK.value
});

// Send a prompt and get a response
const response = await session.prompt(prompt);

// Destroy the session when done
session.destroy();
```

### Capability Detection

```javascript
// Get default model parameters — also serves as availability check
const defaults = await LanguageModel.params();

// Check if the API exists at all
if (!('LanguageModel' in self)) {
  showResponse('Model not available');
  return;
}
```

### Session Management

```javascript
let session;  // Module-level variable

async function runPrompt(prompt, params) {
  try {
    if (!session) {
      session = await LanguageModel.create(params);
    }
    return session.prompt(prompt);
  } catch (e) {
    console.log('Prompt failed');
    console.error(e);
    // Reset session on error
    reset();
    throw e;
  }
}

async function reset() {
  if (session) {
    session.destroy();
  }
  session = null;
}
```

**Pattern:** Lazy session creation, reuse across prompts, destroy on error or parameter change.

### Error Handling

- On `session.prompt()` failure: destroy the session and throw
- On parameter change (temperature/top-k slider): destroy and recreate
- The UI shows the raw error text in a dedicated error div
- No retry logic — user must re-trigger

### Response Handling

- `session.prompt()` returns a **string** (not a ReadableStream)
- Response is rendered with `DOMPurify.sanitize(marked.parse(response))` — Markdown → sanitized HTML
- No streaming in this sample (full response awaited)

---

## 2. Sample Analysis: ai.gemini-on-device-summarization

### File Structure

```
ai.gemini-on-device-summarization/
├── .gitignore
├── README.md
├── background.js           # Content extraction + sidePanel setup
├── manifest.json           # MV3, tabs + scripting + sidePanel + storage, trial_tokens
├── package.json            # Rollup build with dompurify + marked + @mozilla/readability
├── package-lock.json
├── rollup.config.mjs       # Two bundles: sidepanel + extract-content script
├── images/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── scripts/
│   └── extract-content.js  # Readability-based content extraction (injected into page)
└── sidepanel/
    ├── index.html          # Summary UI with type/length/format settings
    ├── index.js            # Summarizer API logic
    └── index.css           # Open Props-based styles
```

### manifest.json

```json
{
  "name": "Summarization API sample",
  "version": "0.1",
  "manifest_version": 3,
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...",
  "trial_tokens": [
    "AkGcfoMTs5K71isPlCiY033XA9HKSjUJvPCF6K56eqY7mAUAsR7NDbmIWDjomLgC..."
  ],
  "background": {
    "service_worker": "background.js"
  },
  "permissions": ["tabs", "scripting", "sidePanel", "storage"],
  "host_permissions": ["http://*/*", "https://*/*"],
  "side_panel": {
    "default_path": "sidepanel/index.html"
  },
  "action": {
    "default_icon": { "16": "images/icon16.png", ... },
    "default_title": "Generate a summary"
  }
}
```

**Key observations:**
- Uses `trial_tokens` — the Summarizer API was in origin trial at time of writing
- Needs `tabs` + `scripting` + `host_permissions` for content extraction
- Needs `storage` to pass page content from background → sidepanel
- Has a `key` field (required for origin trial token binding)

### How It Uses the Summarizer API

```javascript
/* global Summarizer */

// Check availability FIRST
const availability = await Summarizer.availability();

if (availability === 'unavailable') {
  return 'Summarizer API is not available';
}

// Create with options
const summarizer = await Summarizer.create({
  sharedContext: 'this is a website',
  type: summaryTypeSelect.value,    // 'key-points' | 'tldr' | 'teaser' | 'headline'
  format: summaryFormatSelect.value, // 'markdown' | 'plain-text'
  length: summaryLengthSelect.value  // 'short' | 'medium' | 'long'
});

// If model needs downloading, wait for ready
if (availability === 'after-download') {
  summarizer.addEventListener('downloadprogress', (e) => {
    console.log(`Downloaded ${e.loaded * 100}%`);
  });
  await summarizer.ready;
}

// Generate summary
const summary = await summarizer.summarize(text);

// Always destroy
summarizer.destroy();
```

### Capability Detection (Three-State Pattern)

```javascript
const availability = await Summarizer.availability();
// Returns: 'unavailable' | 'available' | 'after-download'
```

This is the canonical **three-state availability check**:
1. **`'unavailable'`** — Device/Chrome doesn't support the API, or model can't run
2. **`'available'`** — Model is downloaded and ready to use immediately
3. **`'after-download'`** — Model needs to be downloaded first; use `downloadprogress` event + `ready` promise

### Content Extraction Pipeline

The sample uses a **background script → injected script → session storage → sidepanel** pipeline:

```javascript
// background.js
chrome.tabs.onActivated.addListener((activeInfo) => {
  showSummary(activeInfo.tabId);
});
chrome.tabs.onUpdated.addListener(async (tabId) => {
  showSummary(tabId);
});

async function showSummary(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url.startsWith('http')) return;
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['scripts/extract-content.js']
  });
  chrome.storage.session.set({ pageContent: injection[0].result });
}
```

```javascript
// scripts/extract-content.js (injected into page)
import { isProbablyReaderable, Readability } from '@mozilla/readability';

function parse(document) {
  if (!isProbablyReaderable(document, { minContentLength: 100 })) return false;
  const documentClone = document.cloneNode(true);
  const article = new Readability(documentClone).parse();
  return article.textContent;
}
parse(window.document);
```

```javascript
// sidepanel/index.js — receives content via storage
chrome.storage.session.get('pageContent', ({ pageContent }) => {
  onContentChange(pageContent);
});
chrome.storage.session.onChanged.addListener((changes) => {
  const pageContent = changes['pageContent'];
  onContentChange(pageContent.newValue);
});
```

### Context Length Warning

```javascript
// The underlying model has a context of ~1,024 tokens (about 4,000 characters)
const MAX_MODEL_CHARS = 4000;

if (newContent.length > MAX_MODEL_CHARS) {
  updateWarning(
    `Text is too long for summarization with ${newContent.length} characters ` +
    `(maximum supported content length is ~4000 characters).`
  );
}
```

**Important:** Gemini Nano has a small context window. Content must be truncated or summarized before feeding to the model.

### Error Handling

```javascript
async function generateSummary(text) {
  try {
    // ... create and use summarizer ...
    const summary = await summarizer.summarize(text);
    summarizer.destroy();
    return summary;
  } catch (e) {
    console.log('Summary generation failed');
    console.error(e);
    return 'Error: ' + e.message;
  }
}
```

**Pattern:** Try/catch around the entire AI operation, return error message as user-facing string, always call `destroy()`.

---

## 3. API Surface Reference

### LanguageModel (Prompt API) — `ai.languageModel`

This is the primary API for UI Checker integration. It provides a general-purpose text-in/text-out interface powered by Gemini Nano.

```javascript
// Availability check
const availability = await LanguageModel.availability();
// Returns: 'unavailable' | 'available' | 'after-download'

// Get default parameters
const defaults = await LanguageModel.params();
// Returns: { defaultTemperature, maxTemperature, defaultTopK, maxTopK }

// Create a session
const session = await LanguageModel.create({
  initialPrompts: [
    { role: 'system', content: 'You are a UI analysis expert.' },
    { role: 'user', content: '...' },
    { role: 'assistant', content: '...' }
  ],
  temperature: 0.1,   // Low for deterministic analysis
  topK: 1             // Low for focused responses
});

// Prompt (non-streaming)
const response = await session.prompt('Analyze this UI...');

// Prompt (streaming) — returns ReadableStream
const stream = await session.promptStreaming('Analyze this UI...');
for await (const chunk of stream) {
  processChunk(chunk);
}

// Check model capabilities
const capabilities = await session.capabilities();
// Returns information about what the model can do

// Destroy session
session.destroy();

// Monitor download progress (if model not yet available)
session.addEventListener('downloadprogress', (e) => {
  console.log(`Downloaded ${Math.round(e.loaded * 100)}%`);
});
await session.ready;
```

### Summarizer API

```javascript
const availability = await Summarizer.availability();

const summarizer = await Summarizer.create({
  sharedContext: 'this is a website',
  type: 'key-points',    // 'key-points' | 'tldr' | 'teaser' | 'headline'
  format: 'markdown',    // 'markdown' | 'plain-text'
  length: 'short'        // 'short' | 'medium' | 'long'
});

const summary = await summarizer.summarize(text);
summarizer.destroy();
```

---

## 4. Capability Detection Pattern

### Recommended Multi-Layer Check

```javascript
/**
 * Check if Chrome's built-in AI is available.
 * Returns an object with availability status and details.
 */
async function checkAIAvailability() {
  // Layer 1: API existence check
  if (!('LanguageModel' in self)) {
    return {
      available: false,
      reason: 'LanguageModel API not found — requires Chrome 138+',
      status: 'unavailable'
    };
  }

  // Layer 2: Model availability check (three-state)
  try {
    const availability = await LanguageModel.availability();

    if (availability === 'unavailable') {
      return {
        available: false,
        reason: 'On-device model not available on this device',
        status: 'unavailable'
      };
    }

    if (availability === 'after-download') {
      return {
        available: true,
        needsDownload: true,
        reason: 'Model needs to be downloaded first',
        status: 'after-download'
      };
    }

    // availability === 'available'
    return {
      available: true,
      needsDownload: false,
      reason: null,
      status: 'available'
    };
  } catch (e) {
    return {
      available: false,
      reason: `Availability check failed: ${e.message}`,
      status: 'error'
    };
  }
}
```

### Where to Run the Check

Based on the samples, the AI API is used from the **sidepanel** context (not the service worker). The `LanguageModel` and `Summarizer` globals are available in extension pages (sidepanel, popup, options, devtools panels) but **NOT** in service workers.

**For UI Checker:** The check should run in the DevTools panel page (`panel.js`), since that's where AI results will be displayed.

---

## 5. Session Management

### Lazy Creation with Caching

```javascript
let aiSession = null;
let currentSessionParams = null;

async function getAISession(params = {}) {
  // Reuse existing session if params match
  if (aiSession && JSON.stringify(currentSessionParams) === JSON.stringify(params)) {
    return aiSession;
  }

  // Destroy old session if params changed
  if (aiSession) {
    aiSession.destroy();
    aiSession = null;
  }

  // Create new session
  aiSession = await LanguageModel.create({
    initialPrompts: params.systemPrompts || [
      { role: 'system', content: 'You are a UI quality analysis expert.' }
    ],
    temperature: params.temperature ?? 0.1,
    topK: params.topK ?? 1
  });
  currentSessionParams = params;
  return aiSession;
}
```

### Lifecycle Bound to UI

```javascript
// Create session when panel opens
panelPort.onMessage.addListener(async (msg) => {
  if (msg.action === 'ai-audit') {
    const session = await getAISession();
    // ... use session ...
  }
});

// Destroy session when panel disconnects
panelPort.onDisconnect.addListener(() => {
  if (aiSession) {
    aiSession.destroy();
    aiSession = null;
  }
});
```

### Multi-Turn Context

The `initialPrompts` array supports system/user/assistant turns, enabling few-shot prompting:

```javascript
const session = await LanguageModel.create({
  initialPrompts: [
    { role: 'system', content: 'You are a UI quality analysis expert. Respond in JSON.' },
    { role: 'user', content: 'Analyze: button with 10px padding, blue background, white text' },
    { role: 'assistant', content: '{"finding": "none", "quality": "good"}' },
    // ... more examples ...
  ],
  temperature: 0.1,
  topK: 1
});
```

---

## 6. Prompt Engineering for UI Analysis

### Context Window Constraint

Gemini Nano has approximately **1,024 tokens** (~4,000 characters) of context. This is the critical constraint for UI Checker integration.

**Implications:**
- Cannot send full DOM tree or all CSS
- Must distill findings to concise representations
- Need to chunk or summarize before prompting

### Strategy: Post-Process Deterministic Findings with AI

Instead of asking the AI to scan raw HTML/CSS, use the deterministic detector's output as the AI's input:

```javascript
// Phase 1: Deterministic scan (existing detector)
const findings = await runDeterministicScan();

// Phase 2: AI visual audit — send condensed findings + context
const condensedFindings = findings.map(f => ({
  id: f.id,
  rule: f.name,
  selector: f.selector,
  severity: f.severity,
  context: f.snippet  // Small excerpt of the affected HTML
}));

const aiPrompt = `Analyze these UI quality findings from a web page scan.
Each finding has a rule ID, element selector, and context snippet.

Findings (${condensedFindings.length} total):
${JSON.stringify(condensedFindings.slice(0, 20), null, 2)}

Provide:
1. A severity ranking (critical/medium/low) for each finding
2. Whether any findings are false positives
3. Suggested fixes (brief)
4. Overall UI quality score (1-10)

Respond in JSON format.`;
```

### Prompt Templates for UI Checker

#### Visual Audit Prompt

```
You are a UI quality expert. Analyze these findings from a web page scan.

Findings: [condensed findings array]

For each finding, determine:
- Is this a genuine issue or a false positive?
- Severity: critical | warning | info
- Brief fix suggestion

Also provide:
- Overall quality score (1-10)
- Top 3 priority fixes

Respond as JSON: { "findings": [...], "score": N, "priorities": [...] }
```

#### Accessibility Audit Prompt

```
You are an accessibility expert. Given these UI quality findings from a web page:

Findings: [findings related to a11y: low-contrast, tiny-text, skipped-heading, etc.]

Assess WCAG 2.1 AA compliance:
- Which findings represent real accessibility barriers?
- What is the estimated WCAG conformance level?

Respond as JSON: { "wcagLevel": "A|AA|AAA|None", "barriers": [...], "score": N }
```

#### Design System Coherence Prompt

```
You are a design systems expert. Analyze these UI findings for design coherence:

Typography findings: [font usage, hierarchy data]
Color findings: [palette data, contrast issues]
Spacing findings: [monotonous spacing, cramped padding data]

Assess:
- Design system maturity (ad-hoc | partial | systematic | mature)
- Key inconsistencies
- Recommendations

Respond as JSON.
```

### Truncation Strategy for Large Pages

```javascript
function condenseFindings(findings, maxChars = 3000) {
  let output = '';
  const included = [];

  for (const f of findings) {
    const line = `${f.id}|${f.selector}|${f.name}|${f.severity}`;
    if (output.length + line.length + 1 > maxChars) break;
    output += line + '\n';
    included.push(f);
  }

  return { condensed: output, count: included.length, total: findings.length };
}
```

---

## 7. Response Handling & Streaming

### Non-Streaming (Simple, Used in Both Samples)

```javascript
const response = await session.prompt(prompt);
// Full response as a string — blocks until complete
```

### Streaming (Recommended for UI Checker)

```javascript
async function streamAIAudit(session, prompt, onChunk, onComplete) {
  try {
    const stream = await session.promptStreaming(prompt);
    let fullResponse = '';

    for await (const chunk of stream) {
      fullResponse += chunk;
      onChunk(chunk, fullResponse);
    }

    onComplete(fullResponse);
  } catch (e) {
    console.error('[uichecker] AI streaming failed:', e);
    throw e;
  }
}
```

**For UI Checker:**
- Use streaming for the AI visual audit so results appear incrementally
- Parse JSON from the streamed response as it arrives
- Show a loading indicator during inference (typically 1-5 seconds)

### Markdown Rendering

Both samples render AI responses as Markdown → sanitized HTML:

```javascript
import DOMPurify from 'dompurify';
import { marked } from 'marked';

// Sanitize and render
element.innerHTML = DOMPurify.sanitize(marked.parse(response));
```

**For UI Checker:** AI audit results should be rendered as structured HTML in the panel, not raw Markdown. Consider parsing the JSON response and rendering with the existing panel UI components.

---

## 8. Content Security Policy Considerations

### Current UI Checker CSP

The UI Checker extension uses `chrome.scripting.executeScript` to inject the detector into the page's MAIN world. The detector accesses `getComputedStyle` and `document.styleSheets.cssRules`.

### AI API and CSP

- The `LanguageModel` and `Summarizer` APIs are **browser-native** — they don't require network access
- No `connect-src` or `script-src` CSP modifications needed
- No external API endpoints are called
- The AI inference happens entirely on-device

### What Needs to Change

Nothing CSP-related. The AI APIs are available as browser globals in extension pages (sidepanel, popup, DevTools panel). They do NOT need to be loaded from external URLs.

**Important:** The AI API is NOT available in content scripts (isolated world) or the page's main world. It must be called from an extension page context.

### Architecture Implication

```
┌─────────────────────────────────────────────┐
│ DevTools Panel (extension page)             │
│                                             │
│  panel.js                                   │
│  ├── Deterministic findings display         │
│  └── AI visual audit ← LanguageModel API    │
│       │   (runs HERE, in extension page)     │
│       │                                     │
│       └── Gets scan data from service worker │
│           via port.postMessage()            │
└─────────────────────────────────────────────┘
```

---

## 9. Service Worker Integration Patterns

### Service Worker Cannot Use AI APIs Directly

The `LanguageModel` and `Summarizer` globals are **not available in service workers**. This is a critical architectural constraint.

### Pattern 1: Sidepanel/Panel as AI Host (Used by Both Samples)

Both Google samples run AI calls from the sidepanel page, not the service worker:

```javascript
// sidepanel/index.js (NOT background.js)
const session = await LanguageModel.create(params);
const response = await session.prompt(prompt);
```

The service worker only handles:
- SidePanel behavior setup
- Content extraction (via `chrome.scripting.executeScript`)
- Data passing (via `chrome.storage.session`)

### Pattern 2: For UI Checker — DevTools Panel as AI Host

Since UI Checker's primary interface is the DevTools panel, the AI integration should live there:

```javascript
// devtools/panel.js
let aiSession = null;

async function runAIAudit(findings) {
  // Check availability
  if (!('LanguageModel' in self)) {
    showAIUnavailable();
    return;
  }

  const availability = await LanguageModel.availability();
  if (availability === 'unavailable') {
    showAIUnavailable();
    return;
  }

  // Create session if needed
  if (!aiSession) {
    if (availability === 'after-download') {
      showDownloadProgress();
    }
    aiSession = await LanguageModel.create({
      initialPrompts: [
        { role: 'system', content: AI_SYSTEM_PROMPT }
      ],
      temperature: 0.1,
      topK: 1
    });
  }

  // Run audit
  const condensed = condenseFindings(findings);
  const prompt = buildAuditPrompt(condensed);
  const response = await aiSession.prompt(prompt);
  renderAIResults(JSON.parse(response));
}
```

### Data Flow for AI Audit

```
Content Script → Service Worker → DevTools Panel → AI API
(detector)      (relay)          (AI host)        (inference)

1. Detector runs deterministic scan
2. Content script relays findings to service worker
3. Service worker forwards findings to DevTools panel via port
4. Panel's AI module condenses findings and prompts LanguageModel
5. AI response is rendered in the panel UI
```

---

## 10. Integration into UI Checker Architecture

### Three-Phase Detection + AI Visual Audit

```
┌─────────────────────────────────────────────────────────────┐
│                    SCAN PIPELINE                              │
│                                                              │
│  Phase 1: HTML Regex Scan                                    │
│  ├── Pure black background, purple accents, gradient text    │
│  ├── Monotonous spacing, bounce easing, dark glow            │
│  └── (Runs on cloned document outerHTML)                     │
│                                                              │
│  Phase 2: Element-by-Element DOM Walk                        │
│  ├── 9 per-element check functions                           │
│  └── (Runs on querySelectorAll('*'))                         │
│                                                              │
│  Phase 3: Page-Level Aggregate Checks                        │
│  ├── Typography, layout, heading levels                      │
│  └── (Runs on collected data from Phase 2)                   │
│                                                              │
│  ═══════════════════════════════════════════════════════      │
│                                                              │
│  Phase 4: AI Visual Audit (NEW)                              │
│  ├── Receives condensed findings from Phases 1-3             │
│  ├── Runs on-device via LanguageModel API                    │
│  ├── Provides:                                               │
│  │   ├── False positive filtering                            │
│  │   ├── Severity re-ranking                                 │
│  │   ├── Fix suggestions                                     │
│  │   ├── Overall quality score                               │
│  │   └── Accessibility assessment                            │
│  └── Fallback: Skip if AI unavailable (graceful degrade)     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### UI Design for AI Audit

Add an "AI Audit" tab or section to the DevTools panel:

```html
<!-- In panel.html, add after existing findings section -->
<div id="ai-audit-section" class="ai-section" hidden>
  <div class="ai-header">
    <h3>AI Visual Audit</h3>
    <button id="btn-run-ai" class="primary">Run AI Audit</button>
    <div id="ai-status" class="status-badge" hidden></div>
  </div>

  <div id="ai-loading" hidden>
    <div class="ai-progress">
      <span class="blink">Analyzing findings with on-device AI...</span>
    </div>
  </div>

  <div id="ai-unavailable" hidden>
    <p>On-device AI is not available. Requires Chrome 138+ with Gemini Nano.</p>
  </div>

  <div id="ai-results" hidden>
    <div id="ai-score" class="score-card"></div>
    <div id="ai-priorities" class="priority-list"></div>
    <div id="ai-false-positives" class="fp-list"></div>
    <div id="ai-fixes" class="fix-suggestions"></div>
  </div>
</div>
```

### Service Worker Changes

The service worker needs minimal changes — just relay the AI audit trigger:

```javascript
// In service-worker.js, add to panel port message handler:
port.onMessage.addListener((msg) => {
  // ... existing handlers ...
  if (msg.action === 'ai-audit') {
    // The panel itself will handle AI — just forward findings if needed
    const state = getState(tabId);
    port.postMessage({ action: 'ai-audit-findings', findings: state.findings });
  }
});
```

### Manifest Changes

```json
{
  "minimum_chrome_version": "138"
}
```

That's the only manifest change needed. No new permissions required for the LanguageModel API.

---

## 11. Error Handling and Fallback Strategies

### Comprehensive Error Matrix

| Error | Cause | Recovery |
|-------|-------|----------|
| `'LanguageModel' not in self` | Chrome < 138 or feature disabled | Show "AI not available" message, hide AI section |
| `availability === 'unavailable'` | Device doesn't support on-device AI | Same as above |
| `availability === 'after-download'` | Model needs download | Show download progress, create session after ready |
| `session.prompt()` throws | Context overflow, invalid prompt | Destroy session, show error, offer retry |
| JSON parse error on response | Model returned non-JSON | Fall back to displaying raw text |
| Session creation timeout | Model download taking too long | Show progress, allow cancel |
| `session.destroy()` throws | Session already destroyed | Catch and ignore |

### Graceful Degradation Strategy

```javascript
async function runAIAudit(findings) {
  // 1. Check API availability
  const aiStatus = await checkAIAvailability();
  if (!aiStatus.available) {
    // Graceful: just skip AI audit, show deterministic results only
    console.log('[uichecker] AI audit unavailable:', aiStatus.reason);
    return { success: false, reason: aiStatus.reason };
  }

  // 2. Attempt to create session
  let session;
  try {
    session = await LanguageModel.create({
      initialPrompts: [{ role: 'system', content: AI_SYSTEM_PROMPT }],
      temperature: 0.1,
      topK: 1
    });
    await session.ready; // Wait for model if downloading
  } catch (e) {
    console.error('[uichecker] AI session creation failed:', e);
    return { success: false, reason: e.message };
  }

  // 3. Run prompt
  try {
    const prompt = buildAuditPrompt(findings);
    const response = await session.prompt(prompt);
    return { success: true, data: parseAIResponse(response) };
  } catch (e) {
    console.error('[uichecker] AI prompt failed:', e);
    session.destroy();
    return { success: false, reason: e.message };
  }
}
```

### Key Principle: AI is Augmentative, Not Essential

The existing deterministic scan provides value without AI. The AI audit is a **bonus feature** that:
- Adds intelligent prioritization and fix suggestions
- Filters false positives
- Provides a quality score
- Should never block or break the core scanning functionality

---

## 12. Performance Considerations

### On-Device Inference is Async and Slow

- **First prompt:** 2-10 seconds (model loading + inference)
- **Subsequent prompts:** 0.5-3 seconds (inference only)
- **Session creation:** 1-5 seconds (or longer if model needs download)
- **Context limit:** ~1,024 tokens (~4,000 characters)

### Optimization Strategies

#### 1. Pre-warm the AI Session

```javascript
// Create the session early (when panel opens) so it's ready when user clicks "AI Audit"
let prewarmedSession = null;

async function prewarmAI() {
  if (!('LanguageModel' in self)) return;
  try {
    const availability = await LanguageModel.availability();
    if (availability === 'available') {
      prewarmedSession = await LanguageModel.create({
        initialPrompts: [{ role: 'system', content: AI_SYSTEM_PROMPT }],
        temperature: 0.1,
        topK: 1
      });
    }
  } catch (e) {
    // Silently fail — prewarming is best-effort
  }
}

// Call on panel load
prewarmAI();
```

#### 2. Condense Input Aggressively

```javascript
function condenseFindings(findings) {
  // Strip verbose data, keep only what the AI needs
  return findings.map(f => ({
    id: f.id,
    name: f.name,
    selector: f.selector,
    // Omit: full HTML snippet, computed styles, overlay data
  }));
}
```

#### 3. Batch Multiple Questions

Instead of multiple small prompts, use a single comprehensive prompt:

```javascript
// BAD: Multiple prompts (slow, uses more context)
const severity = await session.prompt('Rank severity of: ' + ...);
const fixes = await session.prompt('Suggest fixes for: ' + ...);
const score = await session.prompt('Rate quality of: ' + ...);

// GOOD: Single batched prompt
const response = await session.prompt(`Analyze these findings and provide:
1. Severity ranking
2. Fix suggestions
3. Overall quality score
Findings: ${condensedData}`);
```

#### 4. Use Low Temperature and Top-K

```javascript
// For deterministic analysis (not creative writing)
temperature: 0.1,  // Near-deterministic output
topK: 1           // Most focused token selection
```

#### 5. Show Progress During Inference

```javascript
// Use streaming for perceived performance
const stream = await session.promptStreaming(prompt);
let partial = '';
for await (const chunk of stream) {
  partial += chunk;
  renderPartialAIResult(partial);  // Show results as they arrive
}
```

### Memory Considerations

- Each `LanguageModel.create()` allocates GPU/memory resources
- Only **one active session** should exist at a time
- Always `destroy()` sessions when the panel closes
- The MV3 service worker lifecycle (30s idle timeout) doesn't apply to the DevTools panel page — it stays alive while DevTools is open

---

## 13. Manifest Requirements

### Minimal Changes Needed for UI Checker

```json
{
  "manifest_version": 3,
  "name": "UI Checker",
  "minimum_chrome_version": "138",
  "permissions": [
    "activeTab",
    "scripting",
    "storage",
    "webNavigation"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/service-worker.js"
  },
  "devtools_page": "devtools/devtools.html",
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": { ... }
  },
  "icons": { ... },
  "web_accessible_resources": [
    {
      "resources": ["detector/detect.js"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

### No New Permissions Required

The `LanguageModel` API is available in extension pages without any special permissions. The only change is adding `minimum_chrome_version: "138"`.

### If Using Summarizer API (Optional)

If UI Checker also wants to use the Summarizer API for generating page-level summaries:

```json
{
  "trial_tokens": [
    "YOUR_ORIGIN_TRIAL_TOKEN_HERE"
  ]
}
```

But the LanguageModel (Prompt API) is shipping stable in Chrome 138+ — no trial tokens needed.

---

## Summary: Key Integration Decisions

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| Where to run AI | DevTools panel page | AI APIs not available in service worker |
| Which API | `LanguageModel` (Prompt API) | General-purpose, shipping stable, no trial tokens |
| Session lifecycle | Create on panel open, destroy on close | Matches sample patterns, avoids resource leaks |
| Prompt strategy | Post-process deterministic findings | Respects context limit, leverages existing detector |
| Temperature/top-K | 0.1 / 1 | Deterministic analysis, not creative generation |
| Fallback | Skip AI entirely if unavailable | Core scan still works; AI is augmentative |
| Streaming | Use `promptStreaming()` | Better UX with incremental results |
| Input format | Condensed JSON of findings | Fits in ~4K char context window |
| Output format | JSON with error fallback to raw text | Structured data for UI rendering |
| Manifest | Add `minimum_chrome_version: "138"` only | No new permissions needed |

---

*Analysis based on Google Chrome Extensions Samples repository:*
- *`functional-samples/ai.gemini-on-device` (LanguageModel/Prompt API)*
- *`functional-samples/ai.gemini-on-device-summarization` (Summarizer API)*
