# Mermaid Diagram from Selection (Chrome Extension)

Render selected Mermaid code from any webpage in a popup window, tweak the theme, and export to SVG.

## Features

- **Context menu rendering**: Right‑click selected Mermaid code → “Mermaid Diagram”.
- **Fence aware**: Automatically strips ```mermaid fences if present.
- **Live preview**: Edit the source in the popup and re‑render.
- **Themes**: `default`, `dark`, `forest`, `neutral`, plus `Auto` (matches system theme).
- **Export**: Save the rendered diagram as an SVG file.
- **Pan & Zoom**: Drag to pan; Ctrl/Cmd + wheel to zoom at cursor; Zoom In/Out/ Fit buttons.
- **Text scales with zoom**: Fonts scale proportionally with shapes for readability at any zoom.
- **Better Fit & default view**: Initial view and “Fit” are zoomed‑in for readability.
- **Open elsewhere**: Open in a new tab or in Chrome’s side panel (with graceful fallback).
- **Always‑on‑top (best‑effort)**: Keeps the popup in front by refocusing when it blurs.
- **Resizable split view**: Drag divider; double‑click to reset; layout persists.
- **Bigger, persistent window**: Larger default popup (1200×800). Your resized size is remembered.
- **Robust selection**: Reads selection directly from the page for reliability.
- **Code normalization**: Removes parentheses inside bracketed labels to avoid Mermaid label issues.
- **No build step**: Ships the ESM Mermaid bundle in‑repo; CSP‑friendly via `<script type="module">`.
- **Modern UI**: Clean toolbar, accessible controls, focus rings, keyboard‑friendly.
- **Code panel toggle**: “Code” button shows/hides the editor (default collapsed, state persists).

## Quick start (Load Unpacked)

1. Open Chrome → `chrome://extensions/`.
2. Enable “Developer mode”.
3. Click “Load unpacked” and select this folder (the one containing `manifest.json`).
4. Ensure the extension is enabled.

Minimum Chrome version: 102 (Manifest V3, ESM support).

## Usage

1. Select Mermaid code on any page. Both raw Mermaid and fenced blocks work, e.g.

    ```mermaid
    graph TD
      A[Start] --> B{Choice}
      B -->|Yes| C[Done]
      B -->|No|  D[Retry]
    ```

2. Right‑click the selection → choose “Mermaid Diagram”.
3. A popup opens with:
    - Diagram preview
    - Code panel (toggle via “Code”; default collapsed)
    - Controls: Re‑render, Export SVG, Zoom In/Out/Fit, Theme, Always on top, Open in tab/side panel
4. Edit the source if needed and click “Re‑render”.
5. Click “Export SVG” to download the current render.

Tip: If you open `viewer.html` directly (without an ID in the URL), you can still paste into the editor and click “Re‑render”.

## Permissions (Why they’re needed)

- `contextMenus`: Add the “Mermaid Diagram” right‑click action.
- `scripting`: Read the actual selection reliably from the page.
- `activeTab`: Allow executing the small selection‑reading script in the active tab.
- `storage`:
  - `session` for ephemeral code handoff from background → viewer.
  - `local` for preferences (theme, split ratio, always‑on‑top, popup size).
- `tabs`: Open a new tab for the viewer when requested.
- `windows`: Create/manage popup windows (default flow and side‑panel fallback).
- `sidePanel`: Open the viewer in Chrome’s side panel (Chrome 114+). The manifest also sets a `side_panel.default_path`.

No persistent storage is used; selection text is stored ephemerally in `chrome.storage.session` and removed immediately after the viewer reads it.

## How it works

- `service_worker.js` creates a context menu and, on click:
  - Reads the current selection via `chrome.scripting.executeScript`.
  - Strips optional code fences.
  - Normalizes labels (removes parentheses inside `[...]`).
  - Stores the text in `chrome.storage.session` under a UUID.
  - Opens `viewer.html#<id>` as a popup, using your last popup size if available.
- `viewer.mjs` loads the code by reading the hash ID and retrieving it from session storage, then:
  - Dynamically imports the Mermaid ESM bundle with error handling (ensure ESM and its chunks exist, see Troubleshooting).
  - Initializes Mermaid with the selected theme (supports `Auto`).
  - Renders into `#diagram` using `mermaid.run`.
  - Enables pan/zoom with zoom‑aware text; “Fit” and default view are slightly closer than strict contain.
  - Exports SVG via `mermaid.render` with a unique render ID.
- `viewer.html` uses a strict CSP compatible with ESM modules.

Security note: Mermaid is initialized with `securityLevel: 'loose'` to allow links/HTML labels. Switch to `'strict'` in `viewer.mjs` if your threat model requires it.

## Project structure

- `manifest.json` — Chrome MV3 manifest.
- `service_worker.js` — Background service worker and context‑menu handler.
- `viewer.html` — Popup UI with CSP and module entry.
- `viewer.mjs` — Viewer logic, Mermaid init/render/export.
- `mermaid.esm.min.mjs` — Mermaid ESM bundle shipped locally (plus its chunk files under `./chunks/mermaid.esm.min/`). Place either at repo root, `./dist/`, or `./mermaid/` (the viewer tries these in order).
- `styles.css` — Layout and basic styling.
- `icon16.png`, `icon32.png`, `icon128.png` — Extension icons.

Stored preferences/keys in `chrome.storage.local`:

- `theme` — Selected theme or `auto`.
- `splitRatio` — Divider position between preview and editor.
- `alwaysOnTop` — Best‑effort focus‑on‑blur toggle.
- `popupSize` — Last popup window size `{ width, height }`.
- `codeCollapsed` — Whether the code panel is hidden.

## Development

- No build tooling is required.
- To change themes or Mermaid config, edit `initMermaid()` in `viewer.mjs`.
- To tighten CSP, adjust the `<meta http-equiv="Content-Security-Policy">` in `viewer.html` and ensure imports remain ESM.
- To upgrade Mermaid, replace `mermaid.esm.min.mjs` with a newer ESM build and test rendering and export.

Local testing flow:

- Load the extension unpacked.
- Navigate to any page containing a Mermaid block, select it, and use the context menu.
- Use DevTools in the popup to inspect console logs if rendering fails.

Tips:

- Drag the diagram area to pan. Click links inside the SVG normally; panning ignores link clicks.
- Ctrl/Cmd + mouse wheel zooms at the cursor. Use the toolbar for Zoom In/Out/Fit.
- Use the “Code” button to show/hide the code panel. Your choice is remembered.

## Troubleshooting

- “No code ID in URL hash.” — You opened `viewer.html` directly. Paste code into the editor and click “Re‑render”, or trigger from the context menu instead.
- “Failed to load Mermaid — missing ESM chunks.” — Ensure `mermaid.esm.min.mjs` is present and its chunks exist under `./chunks/mermaid.esm.min/` relative to the loaded path. The viewer tries `./mermaid.esm.min.mjs`, `./dist/mermaid.esm.min.mjs`, then `./mermaid/mermaid.esm.min.mjs`.
- “Failed to load code” / “Error — see console” — Open DevTools in the popup; check for Mermaid syntax errors or CSP issues.
- Side panel doesn’t open — `chrome.sidePanel` requires newer Chrome (114+). The UI falls back to a right‑side popup window.
- Popup size isn’t remembered — Resize the window; it saves size on resize and reuses it next time.

## License

Add your license of choice here (e.g., MIT). Also review Mermaid’s license for the bundled file.
