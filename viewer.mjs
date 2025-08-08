// Load Mermaid dynamically so we can surface errors if chunks are missing
let mermaid = null;

const qs = (sel) => document.querySelector(sel);

const statusEl = qs('#status');
const diagramEl = qs('#diagram');
const rawEl = qs('#raw');
const exportBtn = qs('#export');
const rerenderBtn = qs('#rerender');
const themeSel = qs('#theme');

let code = '';
let renderCounter = 0; // unique id for export renders
let currentTheme = 'default';

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
  diagramEl.innerHTML = ''; // clear previous render

  // Create a target with the mermaid class and set textContent (not innerHTML)
  const target = document.createElement('div');
  target.className = 'mermaid';
  const sanitized = normalizeBracketLabelParens(code);
  target.textContent = sanitized;
  diagramEl.appendChild(target);

  // Run Mermaid
  if (!mermaid) {
    setStatus('Mermaid not loaded');
    return;
  }
  mermaid.run({ querySelector: '#diagram .mermaid' })
    .then(() => setStatus('Done'))
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
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose', // allows links & HTML labels; use 'strict' if you prefer
    theme: theme
  });
}

async function main() {
  try {
    setStatus('Loading…');
    code = await getCodeFromSession();
    code = normalizeBracketLabelParens(code);
    rawEl.value = code;
    // Load Mermaid ESM (with fallbacks) and initialize
    mermaid = await loadMermaid();
    initMermaid(themeSel.value || 'default');
    render();
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
themeSel.addEventListener('change', () => {
  initMermaid(themeSel.value);
  render();
});

// Kick off
main();
