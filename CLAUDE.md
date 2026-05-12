# CLAUDE.md

Agent onboarding guide for UI Checker. Read this before making any changes.

---

## What this is

UI Checker is a **Manifest V3 Chrome DevTools extension** that detects 27 deterministic UI anti-patterns (15 AI tells + 12 quality/accessibility rules) in any web page. Findings are shown as red overlay boxes directly on the page and listed in the DevTools panel and Elements sidebar.

**No build step. No bundler. No framework. Pure vanilla JS.**

---

## Install / run locally

1. `chrome://extensions` → enable Developer mode
2. Load unpacked → select repo root
3. Open DevTools (`F12`) on any page → **UI Checker** tab

---

## Architecture in one paragraph

The extension has four execution contexts. The **service worker** (`background/service-worker.js`) owns all state and routes messages. The **content script** (`content/content-script.js`) is a bridge injected into every scanned page — it injects the detector and relays messages. The **detector** (`detector/detect.js`) is a large IIFE injected into the page's MAIN world — it has full DOM access and runs all 27 checks. The **DevTools panel and sidebar** (`devtools/`) connect to the SW via chrome.runtime ports and display findings. Full details in `ARCHITECTURE.md`.

---

## File map

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `activeTab`, `scripting`, `storage`, `webNavigation`, `clipboardWrite`, host `<all_urls>` |
| `background/service-worker.js` | Central hub. Owns `tabState`, `panelPorts`, `devtoolsTabs`. Badge updates. |
| `content/content-script.js` | Isolated-world bridge. Probe-then-inject pattern for detector. Relays findings to SW. |
| `detector/detect.js` | All detection logic. IIFE, runs in page MAIN world. Idempotency via `window.__UICHECKER_PREV_HANDLER__`. |
| `detector/antipatterns.json` | Rule metadata (id, name, category, description). 27 rules: 15 slop + 12 quality. |
| `devtools/devtools.{html,js}` | DevTools entrypoint. Creates panel + Elements sidebar. Lifecycle port with heartbeat. |
| `devtools/panel.{html,css,js}` | Main findings panel. Clone Page, Clone Component (uses `$0`), settings, findings list. |
| `devtools/sidebar.{html,css,js}` | Elements sidebar. Shows findings for selected `$0`. Clone Component available here. |
| `popup/popup.{html,css,js}` | Toolbar popup. Scan, overlay toggle, Clone Page, Clone Component redirect. |
| `icons/` | 16/32/48/128 PNG icons |

---

## Critical rules — do not break these

**Idempotency guards — never remove:**
- CS: `window.__UICHECKER_CS_LOADED__` prevents double content script injection
- Detector: `window.__UICHECKER_PREV_HANDLER__` removes stale listener before re-attaching

**Probe pattern — CS injectAndScan():**
Sends `ping` via `window.postMessage` first. Waits 120ms. If detector responds → scan directly. If no response → request SW `inject-fallback` (uses `chrome.scripting.executeScript` with `world:'MAIN'` — always re-executes, bypasses URL cache).

**Never use `<script src="...">` to inject detect.js** — browsers cache the URL and won't re-execute it on the same page.

**Port heartbeat — never remove:**
`devtools.js` and `panel.js` ping the SW every 20 seconds to keep the MV3 service worker alive.

**escapeHtml before any innerHTML** — `panel.js` and `sidebar.js` both define and use `escapeHtml()`. Never remove.

---

## Scan lifecycle (brief)

```
User triggers scan
→ SW: ensureContentScriptInjected → sends { action: 'scan', config } to tab
→ CS: injectAndScan() → ping probe → (inject if needed) → sendScanCommand()
→ Detector: runs 3-phase detection → posts uichecker-results
→ CS: relays findings → SW: stores + notifies panels + updates badge
→ Panel/Sidebar: renders findings
```

---

## Message channels

| Transport | Between | Actions |
|---|---|---|
| `chrome.runtime.sendMessage` | Popup/Panel → SW | `scan`, `get-state`, `findings`, `toggle-overlays`, `inject-fallback`, `disabled-rules-changed` |
| `chrome.runtime.connect` (port) | Panel/Sidebar ↔ SW | `ping`, `scan`, `toggle-overlays`, `highlight`, `unhighlight` + pushed: `findings`, `navigated`, `overlays-toggled` |
| `window.postMessage` | CS ↔ Detector | source `uichecker-command` (actions: `scan`, `ping`, `toggle-overlays`, `highlight`, `remove`) + source `uichecker-results`, `uichecker-ready`, `uichecker-overlays-toggled` |

---

## Clone Component — DevTools only

`$0` (the Elements panel selected element) is only accessible inside DevTools contexts. The panel and sidebar both use `chrome.devtools.inspectedWindow.eval()` to access it. The popup cannot — its Clone Component button redirects to the DevTools panel instead.

---

## Adding a new detection rule

1. Add to `detector/antipatterns.json`: `{ "id": "...", "name": "...", "category": "slop|quality", "description": "..." }`
2. Add detection in `detector/detect.js` in the appropriate phase function — return a finding object with `type`, `name`, `category`, `detail`, `description`
3. Add a `FIX_SKILLS` entry in `panel.js` if relevant

---

## Design system

**Popup:** Dark (#07090e base), CSS grid texture, semantic token system (surfaces s0–s4, borders b0–b3, text t1–t4). Score block with hero number + mini bar chart. Glass-blur toast.

**Panel:** Dual theme (light default / `.theme-dark`). Purple `#a855f7` = AI tells. Amber `#f59e0b` = quality. Left-border accent on finding items by category. Ring spinner for navigation scan.

**Sidebar:** Same token system. `.cat-slop` / `.cat-quality` drive left-border colouring.

**Page overlays:** `oklch(60% 0.27 25)` (vivid red), 3px outline, subtle glow.

---

## Debug logging

All files use `console.debug('[uichecker:namespace]', ...)`. Never use `console.log`.

| `[uichecker:sw]` | `[uichecker:cs]` | `[uichecker:panel]` | `[uichecker:sidebar]` | `[uichecker:popup]` |

View SW logs at `chrome://inspect` → Service workers → inspect.

---

## Common tasks

| Task | Where |
|---|---|
| Add detection rule | `detector/detect.js` + `detector/antipatterns.json` |
| Change overlay colour | `detector/detect.js` → `OUTLINE_COLOR` constant |
| Change overlay thickness | `detector/detect.js` → `outline: Npx solid` in injected CSS |
| Add setting toggle | `buildScanConfig()` in SW + setting UI in `panel.html/js` + pass through `__UICHECKER_CONFIG__` |
| Add panel toolbar button | `panel.html` + handler in `panel.js` |
| Add popup action | `popup.html` + handler in `popup.js` |
| Debug scan not running | Check `[uichecker:cs]` in page console — look for probe/inject log |
| Debug findings not showing | Check `[uichecker:sw]` in `chrome://inspect` — look for findings received log |

---

## Known limitations

- Restricted pages (`chrome://`, Web Store, `file://` without flag) block injection — scan silently fails
- No automated tests — all testing is manual via `chrome://extensions` → Load unpacked
- Service worker state resets on termination; reconnect rebuilds it transparently
