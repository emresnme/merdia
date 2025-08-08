// Load Mermaid dynamically so we can surface errors if chunks are missing
let mermaid = null;

const qs = (sel) => document.querySelector(sel);

const statusEl = qs('#status');
const diagramEl = qs('#diagram');
const canvasEl = qs('#canvas');
const minimapEl = qs('#minimap');
const mmContentEl = qs('#mm-content');
const mmViewportEl = qs('#mm-viewport');
const dividerEl = qs('#divider');
const rawEl = qs('#raw');
const exportBtn = qs('#export');
const rerenderBtn = qs('#rerender');
const themeSel = qs('#theme');
const zoomInBtn = qs('#zoomIn');
const zoomOutBtn = qs('#zoomOut');
const fitBtn = qs('#fit');
const openTabBtn = qs('#openTab');
const openSideBtn = qs('#openSide');
const ontopChk = qs('#ontop');

let code = '';
let renderCounter = 0; // unique id for export renders
let currentTheme = 'default';
let resolvedTheme = 'default';

// Pan/zoom state
let scale = 1;
let tx = 12; // start with padding offset
let ty = 12;
let lastSvg = null; // <svg>
let lastSvgSize = { w: 0, h: 0 };
let isPanning = false;
let startPan = { x: 0, y: 0, tx: 0, ty: 0 };

// Window state for always-on-top fallback
let currentWindowId = null;
// Minimap cache/state
let lastMinimapSource = null;
let mmDragging = false;

// Fit behavior: slightly zoom in over strict fit
const FIT_EXTRA_ZOOM = 1.15; // 15% more than contain-fit
const FIT_PADDING = 8; // px inner padding around diagram
let saveSizeTimer = null;

async function loadMermaid() {
  const candidates = [
    './mermaid.esm.min.mjs',
    './dist/mermaid.esm.min.mjs',
    './mermaid/mermaid.esm.min.mjs'
  ];
  let lastErr;
  for (const p of candidates) {
    try {
      const mod = await import(p);
      return mod?.default ?? mod;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error('Failed to load Mermaid ESM. Ensure the ESM bundle and its chunks are present next to the file (expected ./chunks/mermaid.esm.min/*).', lastErr);
  setStatus('Failed to load Mermaid — missing ESM chunks. Open DevTools for details.');
  throw lastErr;
}

async function getCodeFromSession() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) throw new Error('No code ID in URL hash.');

  const data = await chrome.storage.session.get(id);
  const value = data[id];
  // Clean up after reading to keep session storage small
  if (value !== undefined) {
    await chrome.storage.session.remove(id);
  }
  if (!value || typeof value !== 'string') {
    throw new Error('No Mermaid code found for this ID.');
  }
  return value;
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

// Remove normal parentheses inside square-bracket labels, e.g.
// PP[Post-processing<br/>(re-ranking, cleaning)] -> PP[Post-processing<br/>re-ranking, cleaning]
function normalizeBracketLabelParens(text) {
  if (!text) return text;
  return text.replace(/\[([^\[\]]*)\]/g, (full, inner) => {
    const cleaned = inner.replace(/\(([^()]*)\)/g, '$1');
    return `[${cleaned}]`;
  });
}

function render() {
  setStatus('Rendering…');
  canvasEl.innerHTML = ''; // clear previous render

  // Create a target with the mermaid class and set textContent (not innerHTML)
  const target = document.createElement('div');
  target.className = 'mermaid';
  const sanitized = normalizeBracketLabelParens(code);
  target.textContent = sanitized;
  canvasEl.appendChild(target);

  // Run Mermaid
  if (!mermaid) {
    setStatus('Mermaid not loaded');
    return;
  }
  mermaid.run({ querySelector: '#canvas .mermaid' })
    .then(() => {
      // Capture SVG and prepare viewport
      lastSvg = canvasEl.querySelector('svg');
      if (lastSvg) {
        const vb = lastSvg.viewBox && lastSvg.viewBox.baseVal;
        let w = 0, h = 0;
        if (vb) { w = vb.width; h = vb.height; }
        else {
          const bcr = lastSvg.getBoundingClientRect();
          w = bcr.width; h = bcr.height;
        }
        lastSvgSize = { w, h };
        // Preserve transform if already set, otherwise fit initially
        if (!render.initialized) {
          fitToView();
          render.initialized = true;
        } else {
          applyTransform();
          updateMinimap();
        }
      }
      setStatus('Done');
    })
    .catch((err) => {
      console.error(err);
      setStatus('Error — see console');
    });
}

async function exportSVG() {
  try {
    if (!mermaid) {
      setStatus('Mermaid not loaded');
      return;
    }
    const id = `exportGraph-${++renderCounter}`;
    const sanitized = normalizeBracketLabelParens(code);
    const { svg } = await mermaid.render(id, sanitized);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    setStatus('Export failed');
  }
}

function initMermaid(theme = 'default') {
  currentTheme = theme;
  resolvedTheme = resolveTheme(theme);
  if (resolvedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    // If not dark, remove attribute for light to use default vars
    document.documentElement.removeAttribute('data-theme');
  }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose', // allows links & HTML labels; use 'strict' if you prefer
    theme: resolvedTheme
  });
}

async function main() {
  try {
    setStatus('Loading…');
    await setupWindowInfo();
    await restoreLayout();
    await restorePreferences();
    code = await getCodeFromSession();
    code = normalizeBracketLabelParens(code);
    rawEl.value = code;
    // Load Mermaid ESM (with fallbacks) and initialize
    mermaid = await loadMermaid();
    initMermaid(themeSel.value || 'auto');
    render();
    setupInteractions();
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Failed to load code');
  }
}

// UI bindings
rawEl.addEventListener('input', () => {
  code = rawEl.value;
});

rerenderBtn.addEventListener('click', () => {
  // Reinitialize to apply theme changes too
  initMermaid(themeSel.value || currentTheme);
  render();
});

exportBtn.addEventListener('click', exportSVG);
themeSel.addEventListener('change', async () => {
  await chrome.storage.local.set({ theme: themeSel.value });
  initMermaid(themeSel.value);
  render();
});

zoomInBtn.addEventListener('click', () => zoomAroundCenter(1.1));
zoomOutBtn.addEventListener('click', () => zoomAroundCenter(1/1.1));
fitBtn.addEventListener('click', () => { fitToView(); updateMinimap(); });

openTabBtn.addEventListener('click', async () => {
  const url = await storeCurrentCodeAndGetUrl();
  chrome.tabs.create({ url });
});

openSideBtn.addEventListener('click', async () => {
  const url = await storeCurrentCodeAndGetUrl();
  try {
    if (chrome.sidePanel?.setOptions && chrome.sidePanel?.open) {
      await chrome.sidePanel.setOptions({ path: url.replace(/^.*\//, '') });
      const win = await getCurrentWindow();
      await chrome.sidePanel.open({ windowId: win.id });
    } else {
      await openRightPopup(url);
    }
  } catch (e) {
    await openRightPopup(url);
  }
});

ontopChk.addEventListener('change', async () => {
  await chrome.storage.local.set({ alwaysOnTop: ontopChk.checked });
  applyAlwaysOnTop();
});

// Kick off
main();

// --------- Helpers & new features ---------

function resolveTheme(val) {
  if (val === 'auto') {
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return isDark ? 'dark' : 'default';
  }
  return val || 'default';
}

function setupInteractions() {
  // Zoom with Ctrl+wheel
  diagramEl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // preserve normal scroll
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
    zoomAtPoint(factor, e.clientX, e.clientY);
  }, { passive: false });

  // Pan with mouse drag
  diagramEl.addEventListener('mousedown', (e) => {
    // Ignore if clicking a link inside the SVG
    if (e.target && e.target.closest && (e.target.closest('a') || e.target.closest('#minimap'))) return;
    isPanning = true;
    startPan = { x: e.clientX, y: e.clientY, tx, ty };
    diagramEl.style.cursor = 'grabbing';
    window.addEventListener('mousemove', onPanMove);
    window.addEventListener('mouseup', onPanEnd, { once: true });
  });

  // Resize divider
  if (dividerEl) {
    dividerEl.addEventListener('mousedown', onStartResize);
    dividerEl.addEventListener('dblclick', resetSplit);
  }

  // Minimap click/drag
  if (minimapEl) {
    minimapEl.addEventListener('mousedown', onMinimapDown);
  }

  // System theme listener when in auto
  const mm = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (mm && mm.addEventListener) {
    mm.addEventListener('change', () => {
      if ((themeSel.value || 'auto') === 'auto') {
        initMermaid('auto');
        render();
      }
    });
  }

  // Keep minimap in sync on window resize and persist popup size (throttled)
  window.addEventListener('resize', () => {
    updateMinimap();
    if (saveSizeTimer) clearTimeout(saveSizeTimer);
    saveSizeTimer = setTimeout(savePopupSize, 250);
  });
}

function onPanMove(e) {
  if (!isPanning) return;
  const dx = e.clientX - startPan.x;
  const dy = e.clientY - startPan.y;
  tx = startPan.tx + dx;
  ty = startPan.ty + dy;
  applyTransform();
  updateMinimap();
}
function onPanEnd() {
  isPanning = false;
  diagramEl.style.cursor = '';
}

function zoomAroundCenter(f) {
  const rect = diagramEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  zoomAtPoint(f, cx, cy);
}

function zoomAtPoint(f, clientX, clientY) {
  const rect = diagramEl.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  // New translation to keep (x,y) stable
  tx = x - (x - tx) * f;
  ty = y - (y - ty) * f;
  scale *= f;
  // Clamp scale
  scale = Math.max(0.1, Math.min(4, scale));
  applyTransform();
  updateMinimap();
}

function applyTransform() {
  const rtx = Math.round(tx);
  const rty = Math.round(ty);
  canvasEl.style.transform = `translate(${rtx}px, ${rty}px) scale(${scale})`;
}

function fitToView() {
  if (!lastSvg) return;
  const rect = diagramEl.getBoundingClientRect();
  const pad = FIT_PADDING; // tighter padding overall
  const vw = Math.max(10, rect.width - pad);
  const vh = Math.max(10, rect.height - pad);
  let s = Math.min(vw / lastSvgSize.w, vh / lastSvgSize.h);
  s *= FIT_EXTRA_ZOOM; // slightly zoom in beyond strict fit
  scale = isFinite(s) && s > 0 ? s : 1;
  // Centered translation
  const cx = (rect.width - lastSvgSize.w * scale) / 2;
  const cy = (rect.height - lastSvgSize.h * scale) / 2;
  tx = Math.floor(cx);
  ty = Math.floor(cy);
  applyTransform();
  updateMinimap();
}

function updateMinimap() {
  if (!minimapEl || !lastSvg) return;
  const mmRect = minimapEl.getBoundingClientRect();
  // Clone SVG content only if source changed
  if (lastMinimapSource !== lastSvg || !mmContentEl.firstChild) {
    mmContentEl.innerHTML = '';
    const clone = lastSvg.cloneNode(true);
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.style.width = `${lastSvgSize.w}px`;
    clone.style.height = `${lastSvgSize.h}px`;
    mmContentEl.appendChild(clone);
    lastMinimapSource = lastSvg;
  }
  // Scale to fit minimap box
  const mmScale = Math.min(mmRect.width / lastSvgSize.w, mmRect.height / lastSvgSize.h);
  mmContentEl.style.transformOrigin = '0 0';
  mmContentEl.style.transform = `scale(${mmScale})`;
  // Viewport rectangle
  const viewportW = diagramEl.clientWidth * mmScale / scale;
  const viewportH = diagramEl.clientHeight * mmScale / scale;
  const viewportX = (-tx) * mmScale / scale;
  const viewportY = (-ty) * mmScale / scale;
  mmViewportEl.style.width = `${viewportW}px`;
  mmViewportEl.style.height = `${viewportH}px`;
  mmViewportEl.style.transform = `translate(${viewportX}px, ${viewportY}px)`;
}

function onMinimapDown(e) {
  if (!lastSvg || !lastSvgSize) return;
  e.preventDefault();
  e.stopPropagation();
  mmDragging = true;
  onMinimapMove(e);
  const move = (ev) => onMinimapMove(ev);
  const up = () => {
    mmDragging = false;
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function onMinimapMove(e) {
  if (!mmDragging || !lastSvg || !lastSvgSize) return;
  const mmRect = minimapEl.getBoundingClientRect();
  const mmScale = Math.min(mmRect.width / lastSvgSize.w, mmRect.height / lastSvgSize.h);
  const x = Math.max(0, Math.min(mmRect.width, e.clientX - mmRect.left));
  const y = Math.max(0, Math.min(mmRect.height, e.clientY - mmRect.top));
  // Convert minimap coords to canvas coords and center viewport there
  const targetX = x / mmScale;
  const targetY = y / mmScale;
  const viewW = diagramEl.clientWidth / scale;
  const viewH = diagramEl.clientHeight / scale;
  tx = - (targetX - viewW / 2) * scale;
  ty = - (targetY - viewH / 2) * scale;
  applyTransform();
  updateMinimap();
}

// ----- Split view resize -----
function onStartResize(e) {
  e.preventDefault();
  const content = document.getElementById('content');
  const rect = content.getBoundingClientRect();
  const startX = e.clientX;
  const startLeftWidth = content.children[0].getBoundingClientRect().width; // diagram column
  function onMove(ev) {
    const dx = ev.clientX - startX;
    let leftW = Math.min(rect.width - 150, Math.max(200, startLeftWidth + dx));
    content.style.gridTemplateColumns = `${leftW}px 6px 1fr`;
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    // Persist ratio
    const leftW = content.children[0].getBoundingClientRect().width;
    const ratio = leftW / rect.width;
    chrome.storage.local.set({ splitRatio: ratio });
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function resetSplit() {
  const content = document.getElementById('content');
  content.style.gridTemplateColumns = '';
  chrome.storage.local.remove('splitRatio');
}

async function restoreLayout() {
  const content = document.getElementById('content');
  const { splitRatio } = await chrome.storage.local.get('splitRatio');
  if (splitRatio && content) {
    // Apply after first layout
    requestAnimationFrame(() => {
      const rect = content.getBoundingClientRect();
      const leftW = Math.round(rect.width * splitRatio);
      content.style.gridTemplateColumns = `${leftW}px 6px 1fr`;
    });
  }
}

async function restorePreferences() {
  const { theme, alwaysOnTop } = await chrome.storage.local.get(['theme', 'alwaysOnTop']);
  if (theme) themeSel.value = theme;
  if (typeof alwaysOnTop === 'boolean') ontopChk.checked = alwaysOnTop;
  applyAlwaysOnTop();
}

function setupWindowInfo() {
  return new Promise((resolve) => {
    if (!chrome.windows || !chrome.windows.getCurrent) return resolve();
    chrome.windows.getCurrent((w) => { currentWindowId = w && w.id; resolve(); });
  });
}

function getCurrentWindow() {
  return new Promise((resolve) => chrome.windows.getCurrent(resolve));
}

function openRightPopup(url) {
  return new Promise((resolve) => {
    const width = 420, height = Math.min(900, Math.round(window.screen.availHeight * 0.9));
    const left = window.screen.availLeft + window.screen.availWidth - width;
    const top = window.screen.availTop + 20;
    chrome.windows.create({ url, type: 'popup', width, height, left, top }, resolve);
  });
}

async function storeCurrentCodeAndGetUrl() {
  const id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sanitized = normalizeBracketLabelParens(code);
  await chrome.storage.session.set({ [id]: sanitized });
  return chrome.runtime.getURL(`viewer.html#${encodeURIComponent(id)}`);
}

function applyAlwaysOnTop() {
  if (!chrome.windows?.update) return;
  try {
    if (ontopChk.checked && currentWindowId) {
      // Try focusing back on blur as a best-effort fallback
      window.onblur = () => {
        if (ontopChk.checked) chrome.windows.update(currentWindowId, { focused: true });
      };
    } else {
      window.onblur = null;
    }
  } catch (_) {
    window.onblur = null;
  }
}

function savePopupSize() {
  const width = window.outerWidth || document.documentElement.clientWidth || window.innerWidth;
  const height = window.outerHeight || document.documentElement.clientHeight || window.innerHeight;
  if (width && height) {
    chrome.storage.local.set({ popupSize: { width, height } });
  }
}
