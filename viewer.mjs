// Import the ESM build of Mermaid (ship this file in your extension folder)
import mermaid from './mermaid.esm.min.mjs';

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

function render() {
  setStatus('Rendering…');
  diagramEl.innerHTML = ''; // clear previous render

  // Create a target with the mermaid class and set textContent (not innerHTML)
  const target = document.createElement('div');
  target.className = 'mermaid';
  target.textContent = code;
  diagramEl.appendChild(target);

  // Run Mermaid
  mermaid.run({ querySelector: '#diagram .mermaid' })
    .then(() => setStatus('Done'))
    .catch((err) => {
      console.error(err);
      setStatus('Error — see console');
    });
}

async function exportSVG() {
  try {
    const id = `exportGraph-${++renderCounter}`;
    const { svg } = await mermaid.render(id, code);
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
    rawEl.value = code;
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
