# UI Checker — Chrome DevTools Extension

A Chrome DevTools extension that detects 27 deterministic UI anti-patterns in any web page. Identifies both AI-generated "slop" tells and general design/accessibility quality issues.

> Forked from [Impeccable](https://github.com/pbakaus/impeccable) (Apache 2.0) with original branding removed.

## Features

- **27 anti-pattern checks** — 15 AI slop tells + 12 quality/a11y issues
- **Zero AI dependency** — Fully deterministic, offline detection
- **Tailwind-aware** — Detects patterns in both computed CSS and Tailwind utility classes
- **DevTools integration** — Dedicated panel + Elements sidebar
- **SPA support** — Auto-rescans on navigation
- **Configurable** — Disable individual rules, adjust line length thresholds, toggle blur effects

## Installation

### From Source (Developer Mode)

1. Clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable "Developer mode" (top right)
4. Click "Load unpacked"
5. Select the `uicheck-extension/` directory

### Usage

1. Open DevTools (`F12` or `Ctrl+Shift+I`)
2. Find the **UI Checker** panel in the DevTools tab bar
3. The page will be scanned automatically when you open the panel
4. Click any finding to scroll to and inspect the element
5. Hover over findings to highlight them on the page
6. Use the Elements panel sidebar to see findings for the currently selected element

## Detection Categories

### AI Slop Tells (15 rules)
Side-tab borders, overused fonts, gradient text, AI color palettes, nested cards, bounce easing, dark glows, icon-tile stacks, italic serif heroes, eyebrow chips, and more.

### Quality Issues (12 rules)
Low contrast, cramped padding, tight leading, skipped headings, justified text, tiny text, layout transitions, line length, and more.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for complete technical documentation.

## License

Apache License 2.0 — Based on the [Impeccable](https://github.com/pbakaus/impeccable) project by Paul Bakaus.
