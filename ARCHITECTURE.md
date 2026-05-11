# UI Checker — Architecture Documentation

> A Chrome DevTools extension that detects 27 deterministic UI anti-patterns in any web page. Forked from the open-source [Impeccable](https://github.com/pbakaus/impeccable) project (Apache 2.0) with all original branding removed and replaced.

---

## Table of Contents

1. [Overview](#overview)
2. [Extension Architecture](#extension-architecture)
3. [Detection Engine](#detection-engine)
4. [Anti-Pattern Rule Catalog](#anti-pattern-rule-catalog)
5. [Communication Protocol](#communication-protocol)
6. [Scan Lifecycle](#scan-lifecycle)
7. [Build Pipeline](#build-pipeline)
8. [Permissions Justification](#permissions-justification)
9. [File Structure](#file-structure)
10. [Rebranding Changes](#rebranding-changes)

---

## Overview

UI Checker is a Manifest V3 Chrome DevTools extension that scans web pages for common UI anti-patterns — visual tells of AI-generated interfaces ("slop") and general design/accessibility quality issues. The detection is entirely deterministic and runs offline with no AI/LLM dependencies.

**Key characteristics:**
- **27 deterministic rules** organized into two categories: "slop" (15 AI-tell rules) and "quality" (12 design/a11y rules)
- **Three execution phases**: HTML regex scan, element-by-element DOM walk, page-level aggregate checks
- **Page-context execution**: The detector runs in the page's main world (not isolated) to access `getComputedStyle` and `document.styleSheets.cssRules`
- **On-demand injection**: Content script and detector are only loaded when the user engages with the extension
- **SPA-aware**: Detects navigation via `popstate`/`hashchange` and auto-rescans
- **Tailwind-aware**: Detects patterns via both CSS computed styles and Tailwind utility classes

---

## Extension Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Browser                            │
│                                                              │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │  Popup   │   │ DevTools     │   │ DevTools           │  │
│  │  popup.js│   │ Panel        │   │ Sidebar            │  │
│  │          │   │ panel.js     │   │ sidebar.js         │  │
│  └────┬─────┘   └──────┬───────┘   └────────┬───────────┘  │
│       │                │                     │              │
│       │   chrome.runtime.sendMessage         │              │
│       │                │   chrome.runtime.connect            │
│       ▼                ▼                     ▼              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Service Worker                          │    │
│  │         background/service-worker.js                 │    │
│  │  • tabState Map  • panelPorts Map  • devtoolsTabs   │    │
│  │  • Badge updates  • Scan orchestration              │    │
│  └────────────────────┬────────────────────────────────┘    │
│                       │ chrome.tabs.sendMessage              │
│                       ▼                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           Content Script (isolated world)            │    │
│  │         content/content-script.js                    │    │
│  │  • Bridge between extension ↔ page context           │    │
│  │  • Idempotency: __UICHECKER_CS_LOADED__              │    │
│  └────────────────────┬────────────────────────────────┘    │
│                       │ window.postMessage                   │
│                       ▼                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           Detector (page main world)                 │    │
│  │            detector/detect.js                        │    │
│  │  • 27 anti-pattern checks                           │    │
│  │  • Overlay rendering & spotlight                     │    │
│  │  • Config: __UICHECKER_CONFIG__                      │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Detection Engine

The detection engine (`detector/detect.js`) is built from `cli/engine/detect-antipatterns.mjs` via a build script. It runs in the page's main world inside an IIFE with a `typeof window` guard.

### Execution Phases

The scan function executes in this order:

#### Phase 1: Element-by-Element DOM Walk
```javascript
for (const el of document.querySelectorAll('*')) {
  // Skip extension's own elements
  if (el.closest('.uichecker-overlay, .uichecker-label, ...')) continue;
  
  const findings = [
    ...checkElementBordersDOM(el),
    ...checkElementColorsDOM(el),
    ...checkElementMotionDOM(el),
    ...checkElementGlowDOM(el),
    ...checkElementAIPaletteDOM(el),
    ...checkElementIconTileDOM(el),
    ...checkElementItalicSerifDOM(el),
    ...checkElementHeroEyebrowDOM(el),
    ...checkElementQualityDOM(el),
  ];
}
```

9 per-element check functions run on every DOM element, each returning an array of findings.

#### Phase 2: Page-Level Aggregate Checks
- **`checkTypography()`**: Font usage analysis (overused fonts, single font, flat hierarchy)
- **`checkLayout()`**: Nested cards detection, everything-centered detection
- **`checkPageQualityDOM()`**: Skipped heading levels

#### Phase 3: HTML Regex Scan
- **`checkHtmlPatterns(html)`**: Regex checks on the cloned document's outerHTML
  - Pure black background in CSS
  - Purple/violet accent colors
  - Gradient text (background-clip: text + gradient)
  - Monotonous spacing values
  - Bounce/elastic animation names
  - Overshoot cubic-bezier curves
  - Layout property transitions
  - Dark backgrounds with colored glows

### Color Analysis

The engine supports parsing colors in these formats:
- `rgb()` / `rgba()` — primary format used for contrast calculations
- `oklch()` / `lch()` — chroma extraction for neutrality detection
- `oklab()` / `lab()` — a/b axis for chroma calculation
- `hsl()` / `hsla()` — saturation extraction
- `hwb()` — whiteness/blackness for gray detection
- Hex (`#RGB`, `#RRGGBB`) — direct parsing

### Background Resolution

The `resolveBackground()` function walks up the DOM tree from an element to find the first ancestor with an opaque background color. If the effective background is a gradient (not a solid color), it falls back to `resolveGradientStops()` which extracts individual color stops for worst-case contrast calculations.

### Selector Generation

Findings are tagged with CSS selectors generated by `generateSelector()`, which:
- Anchors on element IDs when available
- Filters out CSS-in-JS hashed classes (`css-*`, `sc-*`, `_*`)
- Filters out extension's own classes (`uichecker-*`)
- Uses `:nth-of-type()` for disambiguation among siblings
- Limits traversal depth to 10 levels

---

## Anti-Pattern Rule Catalog

### Slop Category (AI Tells) — 15 Rules

| ID | Name | Detection Method |
|----|------|-----------------|
| `side-tab` | Side-tab accent border | Thick colored border (≥2px) on one side only of a card element, with non-neutral color |
| `border-accent-on-rounded` | Border accent on rounded element | Thick accent border on an element with border-radius > 0 |
| `overused-font` | Overused font | Inter, Roboto, Geist, Plus Jakarta Sans etc. used as primary font for ≥15% of text elements (min 20 elements) |
| `single-font` | Single font for everything | Only one distinct primary font across all text elements |
| `flat-type-hierarchy` | Flat type hierarchy | Font size ratio between largest and smallest < 2.0 (with ≥3 distinct sizes) |
| `gradient-text` | Gradient text | `background-clip: text` combined with a gradient background-image (or Tailwind `bg-clip-text + bg-gradient-to-*`) |
| `ai-color-palette` | AI color palette | Purple/violet (hue 260-310) or cyan (hue 160-200) on headings, in gradients, or as neon text on dark backgrounds |
| `nested-cards` | Nested cards | Card-like element (shadow/border + radius/background) inside another card-like element |
| `monotonous-spacing` | Monotonous spacing | Single spacing value used for >60% of all spacing declarations with ≤3 unique values (min 10 values) |
| `everything-centered` | Everything centered | >70% of text elements have `text-align: center` (min 5 elements) |
| `bounce-easing` | Bounce or elastic easing | Animation names containing "bounce/elastic/wobble/jiggle/spring", or cubic-bezier with y values outside [0, 1] |
| `dark-glow` | Dark mode with glowing accents | Colored box-shadow with blur > 4px on a background with luminance < 0.1 |
| `icon-tile-stack` | Icon tile stacked above heading | 32-128px squarish tile with icon above a heading element |
| `italic-serif-display` | Italic serif display headline | Italic serif font on h1 or h2 at ≥48px |
| `hero-eyebrow-chip` | Hero eyebrow / pill chip | Uppercase, tracked (≥1.6px), small (≤14px) text directly above a hero h1 (≥48px) |

### Quality Category — 12 Rules

| ID | Name | Detection Method |
|----|------|-----------------|
| `pure-black-white` | Pure black background | Background color is exactly `#000000` (or Tailwind `bg-black`) |
| `gray-on-color` | Gray text on colored background | Low-chroma text on a chromatic background |
| `low-contrast` | Low contrast text | WCAG AA contrast ratio < 4.5:1 (body) or < 3:1 (large text/headings) |
| `layout-transition` | Layout property animation | Transition on width, height, padding, margin, or min/max variants |
| `line-length` | Line length too long | Characters per line > 80 (strict) or > 120 (lax) based on element width |
| `cramped-padding` | Cramped padding | Vertical padding < max(4px, fontSize×0.3) or horizontal < max(8px, fontSize×0.5) in bordered/bg containers |
| `tight-leading` | Tight line height | Line-height / font-size ratio < 1.3 on multi-line body text (>50 chars) |
| `skipped-heading` | Skipped heading level | Heading levels skip (e.g., h1 → h3 without h2) |
| `justified-text` | Justified text | `text-align: justify` without `hyphens: auto` |
| `tiny-text` | Tiny body text | Font size < 12px on body content (>20 chars, not in UI contexts) |
| `all-caps-body` | All-caps body text | `text-transform: uppercase` on >30 chars of non-heading body text |
| `wide-tracking` | Wide letter spacing on body text | Letter-spacing > 0.05em on non-uppercase body text |

---

## Communication Protocol

### Message Channels

The extension uses three communication mechanisms:

#### 1. Chrome Runtime Messaging (`chrome.runtime.sendMessage`)
Used for one-off request/response between content script ↔ service worker and popup ↔ service worker.

| Action | Direction | Payload |
|--------|-----------|---------|
| `scan` | SW → CS / Popup → SW | `{ action: 'scan', tabId, config? }` |
| `findings` | CS → SW | `{ action: 'findings', findings, count }` |
| `findings-updated` | SW → Popup | `{ action: 'findings-updated', tabId, findings }` |
| `toggle-overlays` | Popup → SW → CS | `{ action: 'toggle-overlays', tabId }` |
| `overlays-toggled` | CS → SW | `{ action: 'overlays-toggled', visible }` |
| `overlays-toggled-broadcast` | SW → Popup | `{ action: 'overlays-toggled-broadcast', tabId, visible }` |
| `get-state` | Popup → SW | `{ action: 'get-state', tabId }` |
| `inject-fallback` | CS → SW | `{ action: 'inject-fallback', tabId }` |
| `disabled-rules-changed` | Panel → SW | Triggers rescan on all injected tabs |
| `page-pointer-active` | CS → SW | Cursor activity signal for panel hover tracking |

#### 2. Long-Lived Ports (`chrome.runtime.connect`)
Used for persistent connections from DevTools pages/panels to the service worker.

| Port Name Pattern | Purpose | Auto-Reconnect |
|-------------------|---------|----------------|
| `uichecker-devtools-{tabId}` | Lifecycle port — tracks DevTools open/close | Yes (100ms delay) |
| `uichecker-panel-{tabId}` | Panel port — findings display, scan, highlight | Yes (lazy on next use) |
| `uichecker-sidebar-{tabId}` | Sidebar port — element-specific findings | Yes (lazy on next use) |

All ports implement heartbeat pings every 20 seconds to keep the MV3 service worker alive.

#### 3. Window PostMessage
Used for communication between the content script (isolated world) and the detector (page main world).

| Source | Direction | Purpose |
|--------|-----------|---------|
| `uichecker-command` | CS → Detector | Scan, toggle overlays, highlight, remove |
| `uichecker-results` | Detector → CS | Scan findings data |
| `uichecker-overlays-toggled` | Detector → CS | Overlay visibility state |
| `uichecker-ready` | Detector → CS | Detector loaded and ready |

---

## Scan Lifecycle

```
1. User triggers scan (popup button / DevTools panel / auto-scan)
2. Service Worker calls ensureContentScriptInjected(tabId)
   └─ If csInjected: skip
   └─ Else: chrome.scripting.executeScript(content-script.js)
3. Service Worker sends chrome.tabs.sendMessage({ action: 'scan', config })
4. Content Script receives message
   └─ If detector not yet loaded: injectAndScan()
       └─ Create <script src="detector/detect.js">
       └─ Set dataset.uicheckerExtension = 'true'
       └─ On error: fallback to chrome.scripting.executeScript(MAIN world)
   └─ If detector already loaded: sendScanCommand() via postMessage
5. Detector receives 'scan' command
   └─ Reads __UICHECKER_CONFIG__ for disabledRules, lineLengthMax, spotlightBlur
   └─ Runs querySelectorAll('*') loop (9 per-element checks)
   └─ Runs page-level checks (typography, layout, headings)
   └─ Runs HTML regex checks on cloned document
   └─ Creates overlay elements for each finding
   └─ Posts { source: 'uichecker-results', findings, count }
6. Content Script relays findings to Service Worker
7. Service Worker updates tabState, badge, and notifies panels
8. Panel/Sidebar render findings
```

### SPA Navigation Handling

When SPA navigation is detected (via `popstate`/`hashchange`), the content script sends a rescan command to the already-loaded detector after a 500ms delay. On full page navigation, `webNavigation.onCompleted` resets the content script state and triggers a rescan if DevTools is open.

---

## Build Pipeline

The original project uses `scripts/build-extension.js` to generate `detector/detect.js` from `cli/engine/detect-antipatterns.mjs`:

```
detect-antipatterns.mjs (source of truth)
        │
        ├─ 1. Strip shebang
        ├─ 2. Strip @browser-strip-start/end sections (Node-only code)
        ├─ 3. Set IS_BROWSER = true
        ├─ 4. Wrap in IIFE with window guard
        │
        ▼
detector/detect.js (build artifact — do not edit directly)
        
        ┌─ Parallel: Extract ANTIPATTERNS array → detector/antipatterns.json
```

**Critical**: `detector/detect.js` is a GENERATED file. All edits must be made to `cli/engine/detect-antipatterns.mjs`, then rebuilt. The `antipatterns.json` file is also generated — it's extracted FROM the source, not injected INTO it.

---

## Permissions Justification

| Permission | Justification |
|-----------|---------------|
| `activeTab` | Access the current tab for scanning |
| `scripting` | Inject content script and detector on demand |
| `storage` | Store user preferences (disabled rules, line length mode, etc.) |
| `webNavigation` | Detect page navigation for state reset and auto-rescan |
| `<all_urls>` host permission | Scan any website the user navigates to |

---

## File Structure

```
uicheck-extension/
├── manifest.json                    # Manifest V3 entry point
├── ARCHITECTURE.md                  # This documentation
├── background/
│   └── service-worker.js            # Central message hub, badge, tab state
├── content/
│   └── content-script.js            # Bridge: extension ↔ page context
├── detector/
│   ├── detect.js                    # Detection engine (build artifact)
│   └── antipatterns.json            # Rule metadata (build artifact)
├── devtools/
│   ├── devtools.html                # DevTools page entry point
│   ├── devtools.js                  # Creates panel + sidebar, lifecycle port
│   ├── panel.html                   # Findings panel UI
│   ├── panel.js                     # Panel logic, settings, copy, highlight
│   ├── panel.css                    # Panel styles (light + dark theme)
│   ├── sidebar.html                 # Elements sidebar UI
│   ├── sidebar.js                   # Element-specific findings via $0
│   └── sidebar.css                  # Sidebar styles
├── popup/
│   ├── popup.html                   # Quick scan popup UI
│   ├── popup.js                     # Popup logic
│   └── popup.css                    # Popup styles
└── icons/
    ├── icon.svg                     # Vector icon (checkmark on dark bg)
    ├── icon-16.png                  # 16×16 icon
    ├── icon-32.png                  # 32×32 icon
    ├── icon-48.png                  # 48×48 icon
    └── icon-128.png                 # 128×128 icon
```

---

## Rebranding Changes

This extension was rebranded from the original "Impeccable" extension. The following changes were made:

### Visual Identity
| Property | Original | Rebranded |
|----------|----------|-----------|
| Name | Impeccable | UI Checker |
| Brand color | `oklch(55% 0.25 350)` (pinkish-red) | `oklch(55% 0.18 250)` (cool blue) |
| Hover color | `oklch(45% 0.25 350)` | `oklch(45% 0.18 250)` |
| Badge color | `#d6336c` | `#2563eb` |
| Logo symbol | `/` (slash) | `✓` (checkmark) |
| Icon | Slash on dark bg | Checkmark on dark bg |

### Code Identifiers
| Original | Rebranded |
|----------|-----------|
| `__IMPECCABLE_CS_LOADED__` | `__UICHECKER_CS_LOADED__` |
| `__IMPECCABLE_CONFIG__` | `__UICHECKER_CONFIG__` |
| `dataset.impeccableExtension` | `dataset.uicheckerExtension` |
| `impeccable-command` | `uichecker-command` |
| `impeccable-results` | `uichecker-results` |
| `impeccable-ready` | `uichecker-ready` |
| `impeccable-overlays-toggled` | `uichecker-overlays-toggled` |
| `impeccable-devtools-{id}` | `uichecker-devtools-{id}` |
| `impeccable-panel-{id}` | `uichecker-panel-{id}` |
| `impeccable-sidebar-{id}` | `uichecker-sidebar-{id}` |
| `window.impeccableScan` | `window.uiCheckerScan` |
| `.impeccable-*` CSS classes | `.uichecker-*` |
| `@keyframes impeccable-reveal` | `@keyframes uichecker-reveal` |
| `[impeccable]` console prefix | `[uichecker]` |
| `_impeccableOverlay` | `_uicheckerOverlay` |

### Removed
- Chrome Web Store `update_url` from manifest
- `https://impeccable.style` link from popup footer
- "Detected by [Impeccable](https://impeccable.style)" attribution in copy text

### Preserved
- Apache 2.0 license attribution (Copyright Paul Bakaus)
- All 27 detection rules with identical logic and thresholds
- `FIX_SKILLS` map values (functional skill identifiers: distill, polish, typeset, etc.)
- Complete detection algorithm and color analysis logic

---

*Based on the Impeccable extension by Paul Bakaus, licensed under Apache 2.0.*
