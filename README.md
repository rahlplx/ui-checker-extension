# UI Checker

A Chrome DevTools extension that detects **27 deterministic UI anti-patterns** in any web page — in real time, with zero configuration.

Open DevTools on any page. Issues appear as red overlays directly on the offending elements.

---

## What it detects

**15 AI tells** — patterns that signal AI-generated or template-copied UI:

| Pattern | What it flags |
|---|---|
| Side-tab navigation | Vertical tab bars that break standard nav conventions |
| Border accent on rounded cards | Coloured left/top border strip on already-rounded containers |
| Overused display font | Decorative fonts applied to body text |
| Single font weight | Pages using only one font weight throughout |
| Flat type hierarchy | Headings and body at near-identical sizes |
| Gradient text | CSS gradient applied to text |
| AI colour palette | Purple/teal/coral combinations common in AI-generated designs |
| Nested cards | Cards inside cards inside cards |
| Monotonous spacing | Every gap the same size — no rhythm |
| Everything centred | Page-wide centre alignment applied to all content |
| Bounce easing | Spring/elastic animation on UI transitions |
| Dark glow effects | Coloured box-shadows used as ambient glow |
| Icon tile stacked above heading | Grid of icon + label cards with icon on top |
| Pure black or white | #000 or #fff used as primary colours |
| Grey on colour | Low-contrast grey text on coloured backgrounds |

**12 quality issues** — accessibility and typography problems:

Low contrast · Long lines · Cramped padding · Tight leading · Skipped heading levels · Justified text · Tiny text · All-caps body · Wide letter tracking · Layout shift on hover · Page-level missing landmarks · Form inputs without labels

---

## Install

### Load unpacked (immediate, no account needed)

1. Download or clone this repo
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the repo folder
5. Open DevTools on any page → **UI Checker** panel

### Chrome Web Store

Coming soon.

---

## How to use

### Scan

Click the **✓ UI Checker** toolbar icon → **Scan page**, or open DevTools → UI Checker panel → the scan runs automatically.

Red boxes appear on the page over every detected element. Each box shows the anti-pattern name on hover.

### Panel (DevTools → UI Checker tab)

- Findings grouped by category: **AI tells** (purple) and **Quality issues** (amber)
- Click any finding to scroll to and inspect that element
- Hover a finding to spotlight it on the page
- **Clone Page** — copies the full rendered HTML to clipboard
- **Clone Component** — select an element in the Elements panel first, then click; copies that element's HTML with computed styles inlined
- **Copy all** — copies all findings as a Markdown report

### Sidebar (DevTools → Elements → UI Checker pane)

Shows findings for whichever element is selected in the Elements panel. **Clone Component** is also available here — select the element, click once.

### Toggle overlays

The eye icon in the popup or panel toolbar hides/shows the red overlay boxes without clearing the findings.

---

## Features

- **Zero config** — works on any page immediately
- **Non-destructive** — overlays are injected as an isolated layer, never modifying the page
- **Re-scan aware** — existing findings stay visible while a re-scan runs
- **SPA-ready** — detects `pushState` and hash changes and rescans automatically
- **Offline** — no network calls, no telemetry, fully local
- **Dual theme** — respects Chrome DevTools light/dark setting

---

## Settings

In the panel toolbar → gear icon:

| Setting | Options | Default |
|---|---|---|
| Auto-scan | When panel opens / When DevTools opens | Panel opens |
| Line length | Strict (80 chars) / Lax (120 chars) | Strict |
| Spotlight blur | On / Off | On |
| Rule toggles | Enable/disable any of the 27 rules individually | All on |

---

## Development

No build step. Pure vanilla JS, Manifest V3.

```bash
git clone https://github.com/rahlplx/ui-checker-extension
# Load unpacked in chrome://extensions
```

**Stack:** Service worker · Content script · DevTools panel · Elements sidebar · Popup · `chrome.scripting` (MAIN world injection) · `chrome.storage.sync`

**Key files:**

```
manifest.json
background/service-worker.js   — state, routing, badge
content/content-script.js      — bridge between SW and detector
detector/detect.js             — all 27 detection rules (IIFE, runs in page context)
detector/antipatterns.json     — rule metadata
devtools/panel.{html,css,js}   — main findings panel
devtools/sidebar.{html,css,js} — Elements panel sidebar
popup/popup.{html,css,js}      — toolbar popup
```

**Debug logging** — open DevTools console (or `chrome://inspect` for the service worker) and filter by `[uichecker:` to see per-component logs.

---

## Release

Download `ui-checker-v1.1.0.zip` from [Releases](https://github.com/rahlplx/ui-checker-extension/releases) and load unpacked, or submit to the Chrome Web Store.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
