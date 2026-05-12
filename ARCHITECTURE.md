# UI Checker — Architecture

Technical reference for contributors and AI agents working in this codebase.

---

## Overview

UI Checker is a **Manifest V3 Chrome DevTools extension**. It detects 27 deterministic UI anti-patterns by running a detection engine directly in the page's JavaScript context, then surfacing findings through DevTools panel and sidebar UI.

No build step. No bundler. No framework. Pure vanilla JS across every file.

---

## Three-context model

Chrome extensions run in isolated execution environments. UI Checker spans three:

```
┌──────────────────────────────────────────────────────────────┐
│  DEVTOOLS CONTEXT                                            │
│  devtools/devtools.js  →  panel.js / sidebar.js             │
│  Has: chrome.devtools.*, $0, inspectedWindow.eval()         │
└────────────────┬─────────────────────────────────────────────┘
                 │  chrome.runtime.connect (port) + sendMessage
┌────────────────▼─────────────────────────────────────────────┐
│  SERVICE WORKER (background)                                 │
│  background/service-worker.js                                │
│  Has: chrome.tabs, chrome.scripting, chrome.storage         │
│  State: tabState Map, panelPorts Map, devtoolsTabs Set       │
└────────────────┬─────────────────────────────────────────────┘
                 │  chrome.tabs.sendMessage
┌────────────────▼─────────────────────────────────────────────┐
│  CONTENT SCRIPT — isolated world                             │
│  content/content-script.js                                   │
│  Has: chrome.runtime, shared DOM access                      │
└────────────────┬─────────────────────────────────────────────┘
                 │  window.postMessage (source: uichecker-command/results/ready)
┌────────────────▼─────────────────────────────────────────────┐
│  DETECTOR — page MAIN world                                  │
│  detector/detect.js (injected via chrome.scripting)          │
│  Has: full DOM, computed styles, page globals                │
└──────────────────────────────────────────────────────────────┘
```

Three distinct message transports — never mix them:

| Transport | Between | Used for |
|---|---|---|
| `chrome.runtime.sendMessage` | Popup/Panel ↔ SW | One-shot requests (scan, get-state, findings) |
| `chrome.runtime.connect` (port) | Panel/Sidebar ↔ SW | Persistent connection, findings push, heartbeat |
| `window.postMessage` | Content script ↔ Detector | Commands and results within the page context |

---

## File map

```
manifest.json                      MV3 manifest
background/
  service-worker.js                Hub: routes all messages, owns tabState
content/
  content-script.js                Bridge: CS → Detector injection and relay
detector/
  detect.js                        All 27 rules, overlay rendering (IIFE, MAIN world)
  antipatterns.json                Rule metadata (id, name, category, description)
devtools/
  devtools.html / devtools.js      DevTools page: creates panel + sidebar, lifecycle port
  panel.html / panel.css / panel.js  Findings panel UI
  sidebar.html / sidebar.css / sidebar.js  Elements panel sidebar
popup/
  popup.html / popup.css / popup.js  Toolbar popup
icons/
  icon-16/32/48/128.png            Extension icons
```

---

## Scan lifecycle

### First scan on a page

```
1. User triggers scan (popup button, panel auto-scan, or port message)
2. SW: ensureContentScriptInjected(tabId)
   → chrome.scripting.executeScript({ files: ['content/content-script.js'] })
   → CS IIFE runs; idempotency guard: if (__UICHECKER_CS_LOADED__) return
3. SW: chrome.tabs.sendMessage(tabId, { action: 'scan', config })
4. CS: injectAndScan()
   → Probes detector: window.postMessage({ source: 'uichecker-command', action: 'ping' })
   → Waits 120ms for uichecker-ready response
5a. If detector responds (already loaded): sendScanCommand() directly
5b. If no response: chrome.runtime.sendMessage({ action: 'inject-fallback' })
    → SW: chrome.scripting.executeScript({ world: 'MAIN', files: ['detector/detect.js'] })
    → Detector IIFE runs in page context
    → Posts window.postMessage({ source: 'uichecker-ready' })
6. CS receives uichecker-ready → sets injected=true → sendScanCommand()
7. Detector runs scan phases:
   - Phase 1: per-element DOM walk (9 check functions)
   - Phase 2: page-level aggregates
   - Phase 3: HTML regex on cloned outerHTML
8. Detector posts: window.postMessage({ source: 'uichecker-results', findings, count })
9. CS receives → chrome.runtime.sendMessage({ action: 'findings', findings })
10. SW: stores in tabState, updates badge, notifies all panel ports
11. Panel/Sidebar: renders findings
```

### Subsequent scans (same page, DevTools reopened)

The content script's `injected` flag resets to `false` when DevTools closes (SW sends `remove` action). The detector stays alive in page memory.

On next scan: CS pings the detector. Detector responds with `uichecker-ready` (ping handler). CS scans without re-injecting.

Idempotency is maintained by:
- CS: `window.__UICHECKER_CS_LOADED__` prevents double-injection
- Detector: `window.__UICHECKER_PREV_HANDLER__` stores and removes the prior message listener before attaching a new one on re-injection

### Navigation

`webNavigation.onCompleted` → SW resets `csInjected` and `injected` flags in tabState, rescans if DevTools was open.

SPA navigation (`popstate`, `hashchange`) → CS sends rescan after 500ms debounce.

---

## Service worker state

The SW is an MV3 service worker — it can be terminated after ~30s of inactivity. All state is in-memory (`tabState`, `panelPorts`, `devtoolsTabs`). On restart, state is empty but port reconnect and re-injection rebuild it transparently.

```javascript
// tabState shape
{
  tabId: {
    findings:       [],      // last scan results
    overlaysVisible: true,   // current overlay toggle state
    injected:       false,   // whether detector is loaded in page
    csInjected:     false,   // whether content script is injected
  }
}
```

Panel ports are kept alive by a 20-second heartbeat ping from `devtools.js` and `panel.js`.

---

## Detector (detect.js)

The detector is a large IIFE (~2700 lines) that runs in the page's MAIN world. It has direct access to the DOM, computed styles, and page globals.

### Idempotency

On every injection, the detector checks `window.__UICHECKER_PREV_HANDLER__` and removes the stale listener before attaching a new one. This prevents duplicate scans when the detector is re-injected after a DevTools close/reopen cycle.

### Detection phases

**Phase 1 — per-element walk:** Queries all visible, non-uichecker elements. Runs 9 check functions against each:
- `checkContrast` — WCAG AA contrast ratio
- `checkTypography` — font size, weight, tracking, leading, line length, text-transform
- `checkLayout` — padding, alignment, nesting depth
- `checkColor` — pure black/white, grey-on-colour
- `checkAnimation` — easing functions, transition properties
- `checkHeadings` — heading level sequence
- `checkNav` — navigation patterns
- `checkCard` — card nesting, border accent
- `checkShadow` — glow effects

**Phase 2 — page-level aggregates:** Checks that require a full-page view:
- Font weight variety across all text
- Spacing monotony (how many unique gap values)
- Colour palette composition
- Heading hierarchy

**Phase 3 — HTML patterns:** Regex on `document.documentElement.cloneNode(true).outerHTML` for patterns that need raw HTML structure (gradient text, icon tile layout).

### Overlay system

Overlays are absolutely positioned `div` elements injected into `document.body`. They track element position via `IntersectionObserver` and `ResizeObserver`. CSS is injected once as a `<style>` element.

Overlay colour: `oklch(60% 0.27 25)` — vivid red, 3px outline with subtle glow.

---

## Clone features

### Clone Page

Available in: popup, panel toolbar.

```javascript
chrome.devtools.inspectedWindow.eval(`
  (function() {
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('.uichecker-overlay, ...').forEach(el => el.remove());
    return '<!DOCTYPE html>\\n' + clone.outerHTML;
  })()
`, (result) => { navigator.clipboard.writeText(result.html); });
```

### Clone Component

Available in: panel toolbar, Elements sidebar.

Requires `$0` (currently selected element in Elements panel). Extracts outerHTML with 40 critical computed CSS properties inlined as a `style` attribute.

Only available in DevTools context (panel/sidebar), not in the popup, because `$0` is a DevTools-only variable. The popup's Clone Component button redirects users to the DevTools panel.

---

## Settings

Stored in `chrome.storage.sync` (syncs across devices):

| Key | Type | Default | Effect |
|---|---|---|---|
| `autoScan` | `'panel'` \| `'devtools'` | `'panel'` | When to auto-trigger scan |
| `lineLengthMode` | `'strict'` \| `'lax'` | `'strict'` | 80 or 120 char threshold |
| `spotlightBlur` | `boolean` | `true` | Blur/dim page on hover |
| `disabledRules` | `string[]` | `[]` | Rule IDs to skip |

Config is built by `buildScanConfig()` in the SW and passed to the detector via the `scan` message as `window.__UICHECKER_CONFIG__`.

---

## Design system

**Popup:** AI-Native Precision Dark. Token system: surfaces (`--s0` through `--s4`), borders (`--b0` through `--b3`), text (`--t1` through `--t4`). Background grid texture via CSS `repeating-linear-gradient`.

**Panel:** Dual theme (light = default DevTools, dark = `.theme-dark`). Semantic palette: purple `#a855f7` for AI tells, amber `#f59e0b` for quality issues, emerald for clean state. Left-border accent on finding items by category.

**Sidebar:** Matches panel token system. `cat-slop` / `cat-quality` classes on `.finding` elements drive left-border colouring.

---

## Adding a new rule

1. Add the rule metadata to `detector/antipatterns.json`:
   ```json
   { "id": "my-rule", "name": "My Rule", "category": "slop", "description": "..." }
   ```

2. Add detection logic in `detector/detect.js` inside the appropriate phase function. Return a finding object:
   ```javascript
   { type: 'my-rule', name: 'My Rule', category: 'slop', detail: '...', description: '...' }
   ```

3. Add a `FIX_SKILLS` entry in `panel.js` if there's a relevant fix workflow.

---

## Debug logging

Every file logs via `console.debug('[uichecker:*]', ...)`. Namespaces:

| Namespace | Where to see it |
|---|---|
| `[uichecker:sw]` | `chrome://inspect` → service workers |
| `[uichecker:cs]` | Page DevTools console |
| `[uichecker:panel]` | DevTools panel's own console (right-click panel → Inspect) |
| `[uichecker:sidebar]` | Same as panel |
| `[uichecker:popup]` | Right-click popup → Inspect |

---

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Access the current tab for scan |
| `scripting` | Inject content script and detector |
| `storage` | Persist settings via chrome.storage.sync |
| `webNavigation` | Detect page navigations for auto-rescan |
| `clipboardWrite` | Clone Page / Clone Component copy to clipboard |
| `<all_urls>` (host) | Scan any page |

---

## Known limitations

- Restricted pages (`chrome://`, Web Store, `file://` without flag) cannot be scanned
- CSP-strict pages may block detector injection via script tag; the fallback uses `chrome.scripting.executeScript` with `world: 'MAIN'` which bypasses CSP
- Service worker state is lost on termination; all state is rebuilt on reconnect
- No automated tests — manual testing required after changes to `detect.js`
