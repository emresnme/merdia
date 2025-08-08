# Mermaid Diagram from Selection (Chrome Extension)

Render selected Mermaid code from any webpage in a popup window, tweak the theme, and export to SVG.


## Features
- **Context menu rendering**: Right‑click selected Mermaid code → “Mermaid Diagram”.
- **Fence aware**: Automatically strips ```mermaid fences if present.
- **Live preview**: Edit the source in the popup and re‑render.
- **Themes**: `default`, `dark`, `forest`, `neutral`.
- **Export**: Save the rendered diagram as an SVG file.
- **No build step**: Ships the ESM Mermaid bundle in‑repo; CSP‑friendly via `<script type="module">`.


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
   - Diagram preview (left)
   - Source editor (right)
   - Controls: Re‑render, Export SVG, Theme selector
4. Edit the source if needed and click “Re‑render”.
5. Click “Export SVG” to download the current render.

Tip: If you open `viewer.html` directly (without an ID in the URL), you can still paste into the editor and click “Re‑render”.


## Permissions (Why they’re needed)
- `contextMenus`: Add the “Mermaid Diagram” right‑click action.
- `scripting`: Read the actual selection reliably from the page.
- `storage` (session): Pass the selected code from the background to the viewer page.
- `activeTab`: Allow executing the small selection‑reading script in the active tab.

No persistent storage is used; selection text is stored ephemerally in `chrome.storage.session` and removed immediately after the viewer reads it.


## How it works
- `service_worker.js` creates a context menu and, on click:
  - Reads the current selection via `chrome.scripting.executeScript`.
  - Strips optional code fences.
  - Stores the text in `chrome.storage.session` under a UUID.
  - Opens `viewer.html#<id>` as a popup.
- `viewer.mjs` loads the code by reading the hash ID and retrieving it from session storage, then:
  - Initializes Mermaid (`mermaid.initialize`) with the selected theme (default is `default`).
  - Renders into `#diagram` using `mermaid.run`.
  - Exports SVG via `mermaid.render` with a unique render ID.
- `viewer.html` uses a strict CSP compatible with ESM modules.

Security note: Mermaid is initialized with `securityLevel: 'loose'` to allow links/HTML labels. Switch to `'strict'` in `viewer.mjs` if your threat model requires it.


## Project structure
- `manifest.json` — Chrome MV3 manifest.
- `service_worker.js` — Background service worker and context‑menu handler.
- `viewer.html` — Popup UI with CSP and module entry.
- `viewer.mjs` — Viewer logic, Mermaid init/render/export.
- `mermaid.esm.min.mjs` — Mermaid ESM bundle shipped locally.
- `styles.css` — Layout and basic styling.
- `icon16.png`, `icon32.png`, `icon128.png` — Extension icons.


## Development
- No build tooling is required.
- To change themes or Mermaid config, edit `initMermaid()` in `viewer.mjs`.
- To tighten CSP, adjust the `<meta http-equiv="Content-Security-Policy">` in `viewer.html` and ensure imports remain ESM.
- To upgrade Mermaid, replace `mermaid.esm.min.mjs` with a newer ESM build and test rendering and export.

Local testing flow:
- Load the extension unpacked.
- Navigate to any page containing a Mermaid block, select it, and use the context menu.
- Use DevTools in the popup to inspect console logs if rendering fails.


## Troubleshooting
- “No code ID in URL hash.” — You opened `viewer.html` directly. Paste code into the editor and click “Re‑render”, or trigger from the context menu instead.
- “Failed to load code” / “Error — see console” — Open DevTools in the popup; check for Mermaid syntax errors or CSP issues.
- Nothing happens on right‑click — Ensure you selected text, the extension is enabled, and no other extension is suppressing the context menu.


## License
Add your license of choice here (e.g., MIT). Also review Mermaid’s license for the bundled file.
