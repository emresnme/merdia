# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **Merdia**, a Chrome extension that renders Mermaid diagrams from selected text on webpages. It's built using:
- Chrome Extension Manifest V3
- ES Modules (no build tools required)
- Bundled Mermaid library (ESM format)
- Vanilla JavaScript (no frameworks)

## Key Architecture

### File Structure
- `manifest.json` - Chrome MV3 extension manifest with permissions
- `service_worker.js` - Background script handling context menu and popup creation
- `viewer.html` - Main UI with strict CSP for ESM modules
- `viewer.mjs` - Core application logic (Mermaid rendering, pan/zoom, theming)
- `mermaid.esm.min.mjs` - Bundled Mermaid library with chunks in `chunks/mermaid.esm.min/`
- `styles.css` - CSS for layout and theming

### Data Flow
1. User selects Mermaid code → right-click context menu
2. `service_worker.js` processes selection, strips fences, normalizes labels
3. Code stored in `chrome.storage.session` with UUID
4. Opens `viewer.html#<uuid>` as popup window
5. `viewer.mjs` retrieves code, initializes Mermaid, renders diagram
6. User can edit, re-render, export SVG, adjust themes

### Key Features
- **Preprocessing**: Strips ```mermaid fences and normalizes bracket labels (removes parentheses inside `[...]`)
- **Live editing**: Syntax-highlighted code editor with real-time preview
- **Pan/zoom**: Canvas manipulation with minimap, mouse/keyboard controls
- **Theming**: Built-in + 9 custom theme presets, auto system theme detection
- **Export**: SVG download functionality
- **Layout**: Resizable split view with persistent state

## Development Commands

### Extension Loading
```bash
# Load unpacked extension in Chrome
# 1. chrome://extensions/
# 2. Enable Developer mode
# 3. Click "Load unpacked" → select this directory
```

### Testing
```bash
# No build step required - direct file editing
# Test by selecting Mermaid code on any webpage and using context menu
```

### Local Development
- Edit files directly (no build tools)
- Use Chrome DevTools in popup for debugging
- Check console for Mermaid rendering errors
- Ensure ESM chunks exist in `chunks/mermaid.esm.min/`

## Common Tasks

### Adding New Themes
Edit `getMermaidThemeConfig()` in `viewer.mjs:382` - add new case with theme variables and update HTML select options.

### Updating Mermaid
Replace `mermaid.esm.min.mjs` and ensure chunks are present. Test rendering and export functionality.

### Modifying CSP
Update `<meta http-equiv="Content-Security-Policy">` in `viewer.html:7` while maintaining ESM compatibility.

## Storage Schema

### chrome.storage.local (persistent)
- `theme` - Selected theme identifier
- `splitRatio` - Editor/preview split position
- `alwaysOnTop` - Window focus preference
- `popupSize` - Last window dimensions `{width, height}`
- `codeCollapsed` - Code panel visibility state

### chrome.storage.session (ephemeral)
- `<uuid>` - Mermaid code for current render (auto-cleaned after read)

## Security Notes

- Mermaid initialized with `securityLevel: 'loose'` (allows HTML/links)
- No external network requests - all resources bundled
- Strict CSP prevents inline scripts/eval
- Session storage auto-cleaned to prevent accumulation