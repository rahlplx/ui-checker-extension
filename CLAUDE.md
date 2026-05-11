# CLAUDE.md

Guidance for Claude Code (and other AI agents) when working in this repo.

## What this repo is

UI Checker — a Manifest V3 Chrome DevTools extension that detects 27 deterministic UI anti-patterns (15 "AI slop" tells + 12 quality/a11y rules). **Hard fork of [Impeccable](https://github.com/pbakaus/impeccable)** (Apache 2.0, © Paul Bakaus) with branding stripped and replaced. All detection logic preserved verbatim.

## Stack

- **Vanilla JS, no framework, no bundler, no build step inside this repo.**
- Manifest V3. Service worker + content script + page-context detector.
- No `package.json`, no `node_modules`, no test suite.
- Storage: `chrome.storage.sync`.

## Install / run locally

1. `chrome://extensions/` → enable Developer mode.
2. "Load unpacked" → select repo root.
3. Open DevTools (`F12`) on any page → **UI Checker** panel.

Nothing else. Do not look for npm scripts; there are none.

## Architecture (three contexts, one bridge)

```
Popup / DevTools panel / Elements sidebar
        │  chrome.runtime.connect (port) + sendMessage
        ▼
Service Worker (background/service-worker.js)
   • tabState Map, panelPorts Map, badge, scan orchestration
        │  chrome.tabs.sendMessage
        ▼
Content Script — isolated world (content/content-script.js)
   • Idempotency guard: __UICHECKER_CS_LOADED__
   • Bridge only — no detection logic here
        │  window.postMessage
        ▼
Detector — page main world (detector/detect.js)
   • All 27 rules, color parsing, selector gen, overlay rendering
   • Config read from window.__UICHECKER_CONFIG__
```

Three message transports, do not confuse them:
- `chrome.runtime.sendMessage` — popup/panel ↔ SW (one-shot)
- `chrome.runtime.connect` — panel/sidebar ↔ SW (persistent ports, 20s heartbeat to keep MV3 SW alive)
- `window.postMessage` — content script ↔ detector (channel names: `uichecker-command`, `uichecker-results`, `uichecker-ready`, `uichecker-overlays-toggled`)

## File map

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest. Perms: `activeTab`, `scripting`, `storage`, `webNavigation`, host `<all_urls>` |
| `background/service-worker.js` | Central hub. Owns tabState, panelPorts, devtoolsTabs. Injects CS on demand. |
| `content/content-script.js` | Isolated-world bridge. Injects `detector/detect.js` as a `<script>` into the page; falls back to `chrome.scripting.executeScript({world:'MAIN'})` on error. |
| `detector/detect.js` | **GENERATED ARTIFACT.** ~112KB IIFE, all detection logic. See "Build pipeline caveat" below. |
| `detector/antipatterns.json` | Rule metadata, extracted from the same source as `detect.js`. |
| `devtools/devtools.{html,js}` | DevTools entrypoint. Creates panel + Elements sidebar, opens lifecycle port. |
| `devtools/panel.{html,js,css}` | Findings panel UI, settings, copy, highlight, scan trigger. |
| `devtools/sidebar.{html,js,css}` | Element-specific findings via `$0`. |
| `popup/popup.{html,js,css}` | Toolbar popup — quick scan. |
| `icons/` | 16/32/48/128 PNG + SVG (checkmark on dark bg, `#2563eb`). |
| `ARCHITECTURE.md` | Full technical spec. Authoritative — read it before non-trivial edits. |
| `chrome-ai-integration-patterns.md` | Reference notes on Chrome built-in AI APIs. Not currently used at runtime. |
| `impeccable-branding-audit.json` | Rebrand diff record. Reference for completeness audits. |
| `Impeccable-vs-UIChecker-Analysis.pdf` | Comparison artifact. |

## Build pipeline caveat — read before editing detect.js

`ARCHITECTURE.md` documents that `detector/detect.js` and `detector/antipatterns.json` are **build artifacts** generated from `cli/engine/detect-antipatterns.mjs` via `scripts/build-extension.js`.

**Neither the source file nor the build script exists in this repo.** They live in upstream Impeccable. Practical consequences:

- Editing `detector/detect.js` directly works but diverges from upstream forever. Future Impeccable updates cannot be cleanly merged.
- The clean path is: vendor `detect-antipatterns.mjs` + `build-extension.js` from upstream into this repo, then re-run the rebrand string replacements on every build.
- If asked to "add a new rule" or "change a threshold," flag this trade-off before touching `detect.js`.

Rebrand string substitutions that must be preserved on any upstream re-pull (see `ARCHITECTURE.md` §Rebranding for the full table):
- `__IMPECCABLE_*__` → `__UICHECKER_*__`
- `impeccable-*` message channels / CSS classes / dataset keys → `uichecker-*`
- `window.impeccableScan` → `window.uiCheckerScan`
- Brand color `oklch(55% 0.25 350)` → `oklch(55% 0.18 250)` (and the `45%` hover variant)
- Badge `#d6336c` → `#2563eb`
- Logo `/` → `✓`

## Scan lifecycle (one paragraph)

User triggers scan → SW calls `ensureContentScriptInjected(tabId)` → SW `sendMessage({action:'scan', config})` → CS injects detector if not loaded (sets `dataset.uicheckerExtension='true'`; falls back to `chrome.scripting` MAIN world on CSP failure) → detector reads `__UICHECKER_CONFIG__`, runs Phase 1 (per-element DOM walk, 9 check fns), Phase 2 (page-level aggregates), Phase 3 (HTML regex on cloned outerHTML) → posts `{source:'uichecker-results', findings, count}` → CS relays to SW → SW updates `tabState`, badge, notifies panels.

SPA nav (`popstate`/`hashchange`) → CS sends rescan after 500ms. Full nav (`webNavigation.onCompleted`) → SW resets CS state, rescans if DevTools open.

## Conventions and traps

- **Idempotency.** CS checks `window.__UICHECKER_CS_LOADED__` and detector checks for prior `window.uiCheckerScan` before re-binding. Do not break these guards.
- **Selector generator** (`generateSelector`) filters CSS-in-JS hashes (`css-*`, `sc-*`, `_*`) and own classes (`uichecker-*`). When adding overlay/UI elements, prefix classes with `uichecker-` so they are auto-excluded from scans.
- **Color parsing** supports `rgb/rgba/hsl/hsla/hex/oklch/lch/oklab/lab/hwb`. `resolveBackground()` walks ancestors for first opaque bg; gradients fall back to `resolveGradientStops()` worst-case contrast.
- **Three categories of findings** in `detector/antipatterns.json`: `slop` (15), `quality` (12). Each has `FIX_SKILLS` identifiers (`distill`, `polish`, `typeset`, ...) — these are referenced by name in upstream tooling; do not rename.
- **MV3 SW lifecycle:** ports are kept alive by 20s heartbeat pings. If you add new long-lived connections, mirror this pattern.
- **CSP-strict pages** (e.g. some banks, GitHub itself) block `<script>` injection; CS must fall back to `chrome.scripting.executeScript({world:'MAIN'})`. Test any new injection path against both.

## What this extension does NOT do

- No network calls. Fully offline. No telemetry. (Verify before any PR that adds `fetch`/`XHR`.)
- No LLM/AI calls at runtime. The Chrome AI integration doc is reference only.
- No tests. Zero. Adding even smoke tests would be a high-value change.

## Common task playbook

| Task | Path |
|---|---|
| Add a new detection rule | Edit upstream `detect-antipatterns.mjs`, rebuild, re-apply rebrand. Or edit `detector/detect.js` + `detector/antipatterns.json` directly and accept divergence. |
| Change a threshold | Same as above — `detect.js` is the artifact. |
| New setting toggle | `getSettings()` defaults in `background/service-worker.js`, UI in `devtools/panel.{html,js}`, plumb through `buildScanConfig()` → `__UICHECKER_CONFIG__`. |
| New finding overlay style | `detector/detect.js` overlay-creation block; CSS lives inline (page world cannot reach `panel.css`). Use `uichecker-` class prefix. |
| Rebrand audit / verify no `impeccable` leaks | `grep -ri 'impeccable' --include='*.js' --include='*.json' --include='*.html' --include='*.css'` (excluding `ARCHITECTURE.md` and `impeccable-branding-audit.json`). |

## License

Apache 2.0. Upstream copyright retained: © Paul Bakaus (Impeccable). `LICENSE` file present.

## Known soft spots (flagged for future hardening)

- Build source missing from repo → upstream sync is manual and error-prone.
- No tests, no CI.
- No CWS listing artifacts (privacy policy, screenshots, store description) — required if you ever publish.
- `chrome-ai-integration-patterns.md` exists but no runtime hook — either wire it up or move to `docs/`.
- `Impeccable-vs-UIChecker-Analysis.pdf` (68KB) and `impeccable-branding-audit.json` (60KB) are large artifacts in repo root. Consider moving to `docs/audit/`.
