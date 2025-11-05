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
const codeWrapEl = qs('#codeWrap');
const codeHighlightEl = qs('#codeHighlight');
const exportBtn = qs('#export');
const rerenderBtn = qs('#rerender');
const themeSel = qs('#theme');
const structureSel = qs('#structure');
const zoomInBtn = qs('#zoomIn');
const zoomOutBtn = qs('#zoomOut');
const fitBtn = qs('#fit');
const openTabBtn = qs('#openTab');
const openSideBtn = qs('#openSide');
const toggleCodeBtn = qs('#toggleCode');
const ontopChk = qs('#ontop');
const lintPanel = qs('#lintPanel');
const lintToggle = qs('#lintToggle');
const lintResults = qs('#lintResults');

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

// Fit behavior: zoom in a bit more by default
const FIT_EXTRA_ZOOM = 2.50; // previously 1.15 — make initial view closer
const FIT_PADDING = 6; // slightly reduce padding to gain visual space
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

  // Fallback for testing outside extension context
  if (typeof chrome === 'undefined' || !chrome.storage) {
    // Return test data
    const testMermaidCode = `graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Process]
    B -->|No| D[End]
    C --> E[Another Step]
    E --> D`;
    return testMermaidCode;
  }

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
  // Guard against simultaneous renders
  if (isRendering) {
    console.warn('Render already in progress, skipping...');
    return;
  }

  isRendering = true;
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
    isRendering = false;
    return;
  }
  mermaid.run({ querySelector: '#canvas .mermaid' })
    .then(() => {
      // Capture SVG and prepare viewport
      lastSvg = canvasEl.querySelector('svg');
      if (lastSvg) {
        const vb = lastSvg.viewBox && lastSvg.viewBox.baseVal;
        let w = 0, h = 0;
        if (vb && isFinite(vb.width) && isFinite(vb.height)) {
          w = vb.width; h = vb.height;
        } else {
          try {
            const bcr = lastSvg.getBoundingClientRect && lastSvg.getBoundingClientRect();
            if (bcr && isFinite(bcr.width) && isFinite(bcr.height) && (bcr.width > 0 || bcr.height > 0)) {
              w = bcr.width; h = bcr.height;
            } else if (lastSvg.getBBox) {
              const bb = lastSvg.getBBox();
              if (bb && isFinite(bb.width) && isFinite(bb.height)) { w = bb.width; h = bb.height; }
            }
          } catch (_) {
            // ignore and fallback below
          }
        }
        // Final fallback to avoid NaN/0 sizes
        if (!isFinite(w) || !isFinite(h) || (w === 0 && h === 0)) {
          w = 100; h = 100;
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
      isRendering = false;
    })
    .catch((err) => {
      console.error(err);
      setStatus('Error — see console');
      isRendering = false;
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
  const cfg = getMermaidThemeConfig(theme);
  resolvedTheme = cfg.theme;
  if (cfg.isDark) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    // If not dark, remove attribute for light to use default vars
    document.documentElement.removeAttribute('data-theme');
  }
  // Guard against calling before Mermaid is loaded
  if (!mermaid || typeof mermaid.initialize !== 'function') {
    setStatus('Mermaid not loaded yet');
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose', // allows links & HTML labels; use 'strict' if you prefer
    theme: cfg.theme,
    themeVariables: cfg.themeVariables,
    flowchart: cfg.flowchart
  });
}

async function main() {
  try {
    setStatus('Loading…');
    await setupWindowInfo();
    await restoreLayout();
    // Initialize lint panel state after the controller is defined
    if (typeof LintController !== 'undefined' && LintController.initializePanel) {
      await LintController.initializePanel();
    }
    await restorePreferences();
    code = await getCodeFromSession();
    code = normalizeBracketLabelParens(code);
    rawEl.value = code;
    // Initialize syntax highlight overlay
    if (codeHighlightEl) updateHighlight();
    // Initialize lint analysis
    if (lintResults) updateLintResults();
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

// Auto-render system
let autoRenderTimeout = null;
let isRendering = false; // Guard against simultaneous renders

function cancelAutoRender() {
  if (autoRenderTimeout) {
    clearTimeout(autoRenderTimeout);
    autoRenderTimeout = null;
  }
}

function scheduleAutoRender() {
  cancelAutoRender();
  autoRenderTimeout = setTimeout(() => {
    autoRenderTimeout = null;
    if (!isRendering) {
      initMermaid(themeSel.value || currentTheme);
      render();
    }
  }, 1000);
}

// UI bindings
rawEl.addEventListener('input', () => {
  code = rawEl.value;
  scheduleHighlightUpdate();
  scheduleLintUpdate();
  scheduleAutoRender();
});
rawEl.addEventListener('scroll', syncHighlightScroll);
rawEl.addEventListener('select', updateOverlaySelectionVisibility);
rawEl.addEventListener('mouseup', updateOverlaySelectionVisibility);
rawEl.addEventListener('keyup', updateOverlaySelectionVisibility);
rawEl.addEventListener('focus', updateOverlaySelectionVisibility);
rawEl.addEventListener('blur', () => setOverlayHidden(false));
document.addEventListener('selectionchange', updateOverlaySelectionVisibility);

rerenderBtn.addEventListener('click', () => {
  // Cancel any pending auto-render since user triggered manual render
  cancelAutoRender();
  // Reinitialize to apply theme changes too
  initMermaid(themeSel.value || currentTheme);
  render();
});

exportBtn.addEventListener('click', exportSVG);
themeSel.addEventListener('change', async () => {
  // Cancel any pending auto-render since theme change triggers immediate render
  cancelAutoRender();
  try {
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({ theme: themeSel.value });
    }
  } catch (_) {}
  initMermaid(themeSel.value);
  // Recolor code overlay if needed (mainly for dark/light backgrounds)
  scheduleHighlightUpdate();
  render();
});

structureSel.addEventListener('change', async () => {
  // Cancel any pending auto-render since structure change triggers immediate render
  cancelAutoRender();
  try {
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({ structure: structureSel.value });
    }
  } catch (_) {}
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
  try {
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({ alwaysOnTop: ontopChk.checked });
    }
  } catch (_) {}
  applyAlwaysOnTop();
});

// Lint panel event handlers

// Lint panel toggle
if (lintToggle) {
  lintToggle.addEventListener('click', () => {
    if (lintPanel) {
      lintPanel.classList.toggle('collapsed');
      const isCollapsed = lintPanel.classList.contains('collapsed');
      LintController.savePanelState(isCollapsed);
    }
  });
}

// Quick fix button delegation
// Quick fix button handler
if (lintResults) {
  lintResults.addEventListener('click', (e) => {
    if (e.target.classList.contains('lint-fix-btn')) {
      e.preventDefault();
      e.stopPropagation();
      applyQuickFix(e.target);
    }
  });
}

// Kick off moved to bottom after controllers are defined
main();

// --------- Helpers & new features ---------

// ---------- Mermaid Lint Analysis ----------
// ========== MERMAID LINT ANALYSIS SYSTEM ==========

/**
 * Configuration constants for lint analysis
 */
const LINT_CONFIG = {
  VALID_DIRECTIONS: ['TD', 'TB', 'BT', 'RL', 'LR'],
  MERMAID_KEYWORDS: ['graph', 'flowchart', 'subgraph', 'end', 'TD', 'TB', 'BT', 'RL', 'LR'],
  TYPO_DETECTION: {
    MAX_DISTANCE: 2,
    MAX_LENGTH_DIFF: 2,
    MIN_NODE_LENGTH: 2
  },
  PATTERNS: {
    DIRECTION: /^(graph|flowchart)\s+([A-Z]{1,2})\b/i,
    SUBGRAPH_START: /^\s*subgraph\b/i,
    SUBGRAPH_END: /^\s*end\s*$/i,
    NODE_DEFINITION: /^\s*([A-Za-z0-9_]+)\s*[\[\(]/,
    NODE_REFERENCE: /\b([A-Za-z0-9_]+)\b/g,
    EDGE_SOURCE: /([A-Za-z0-9_]+)\s*(?:-->|---|\.-\.|===>|\|\|[^\|]*\|\||[^=\-](?:-+>|=+>))/g,
    EDGE_TARGET: /(?:-->|---|\.-\.|===>|\|\|[^\|]*\|\||[^=\-](?:-+>|=+>))\s*([A-Za-z0-9_]+)/g
  }
};

/**
 * Utility functions for lint analysis
 */
const LintUtils = {
  /**
   * Calculate Levenshtein distance between two strings
   */
  levenshteinDistance(str1, str2) {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(0));
    
    // Initialize first row and column
    for (let i = 0; i <= str2.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= str1.length; j++) matrix[0][j] = j;
    
    // Fill the matrix
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  },

  /**
   * Create a standardized lint issue object
   */
  createIssue(type, line, column, message, suggestion = null, quickFix = null) {
    return { type, line, column, message, suggestion, quickFix };
  },

  /**
   * Check if a string is a Mermaid keyword
   */
  isKeyword(text) {
    return LINT_CONFIG.MERMAID_KEYWORDS.includes(text);
  },

  /**
   * Check if two nodes are similar enough to be potential typos
   */
  areSimilarNodes(node1, node2) {
    const { MAX_DISTANCE, MAX_LENGTH_DIFF } = LINT_CONFIG.TYPO_DETECTION;
    const distance = this.levenshteinDistance(node1.toLowerCase(), node2.toLowerCase());
    const lengthDiff = Math.abs(node1.length - node2.length);
    
    return distance <= MAX_DISTANCE && lengthDiff <= MAX_LENGTH_DIFF;
  }
};

/**
 * Individual analyzers for different types of lint issues
 */
const LintAnalyzers = {
  /**
   * Analyze graph direction declarations
   */
  analyzeDirections(lines) {
    const issues = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;
      
      if (!line || line.startsWith('%%')) continue;
      
      const match = line.match(LINT_CONFIG.PATTERNS.DIRECTION);
      if (match) {
        const direction = match[2].toUpperCase();
        if (!LINT_CONFIG.VALID_DIRECTIONS.includes(direction)) {
          const column = line.indexOf(match[2]) + 1;
          const message = `Unknown direction "${direction}". Valid directions are: ${LINT_CONFIG.VALID_DIRECTIONS.join(', ')}`;
          const suggestion = `Change "${direction}" to one of: ${LINT_CONFIG.VALID_DIRECTIONS.join(', ')}`;
          
          issues.push(LintUtils.createIssue(
            'unknown-direction',
            lineNum,
            column,
            message,
            suggestion,
            {
              type: 'replace',
              text: direction,
              replacements: LINT_CONFIG.VALID_DIRECTIONS
            }
          ));
        }
      }
    }
    
    return issues;
  },

  /**
   * Analyze subgraph structure for missing end statements
   */
  analyzeSubgraphs(lines) {
    const issues = [];
    const subgraphStack = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;
      
      if (!line || line.startsWith('%%')) continue;
      
      if (LINT_CONFIG.PATTERNS.SUBGRAPH_START.test(line)) {
        subgraphStack.push(lineNum);
      } else if (LINT_CONFIG.PATTERNS.SUBGRAPH_END.test(line)) {
        if (subgraphStack.length === 0) {
          issues.push(LintUtils.createIssue(
            'unexpected-end',
            lineNum,
            1,
            'Unexpected "end" statement - no matching subgraph',
            'Remove this "end" statement or add a matching subgraph'
          ));
        } else {
          subgraphStack.pop();
        }
      }
    }
    
    // Check for unclosed subgraphs
    for (const startLine of subgraphStack) {
      issues.push(LintUtils.createIssue(
        'missing-end',
        startLine,
        1,
        'Subgraph is missing closing "end" statement',
        'Add "end" statement to close this subgraph',
        {
          type: 'add-end',
          afterLine: lines.length
        }
      ));
    }
    
    return issues;
  },

  /**
   * Extract all node definitions and references from the code
   */
  extractNodes(lines) {
    const nodes = new Set();
    const referencedNodes = new Set();
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('%%')) continue;
      
      // Extract explicit node definitions
      const nodeDefMatch = trimmed.match(LINT_CONFIG.PATTERNS.NODE_DEFINITION);
      if (nodeDefMatch) {
        nodes.add(nodeDefMatch[1]);
      }
      
      // Extract all potential node references
      const allMatches = trimmed.matchAll(LINT_CONFIG.PATTERNS.NODE_REFERENCE);
      for (const match of allMatches) {
        const nodeId = match[1];
        if (!LintUtils.isKeyword(nodeId)) {
          nodes.add(nodeId);
        }
      }
      
      // Extract nodes from edge definitions
      const edgeSourceMatches = trimmed.matchAll(LINT_CONFIG.PATTERNS.EDGE_SOURCE);
      for (const match of edgeSourceMatches) {
        referencedNodes.add(match[1]);
      }
      
      const edgeTargetMatches = trimmed.matchAll(LINT_CONFIG.PATTERNS.EDGE_TARGET);
      for (const match of edgeTargetMatches) {
        referencedNodes.add(match[1]);
      }
    }
    
    return { nodes, referencedNodes };
  },

  /**
   * Analyze for potential typos in node references
   */
  analyzeTypos(lines, nodes, referencedNodes) {
    const issues = [];
    const { MIN_NODE_LENGTH } = LINT_CONFIG.TYPO_DETECTION;
    
    for (const nodeRef of referencedNodes) {
      // Skip if node exists, is too short, or is a keyword
      if (nodes.has(nodeRef) || nodeRef.length < MIN_NODE_LENGTH || LintUtils.isKeyword(nodeRef)) {
        continue;
      }
      
      // Check for similar existing nodes
      let isPossibleTypo = false;
      for (const existingNode of nodes) {
        if (LintUtils.areSimilarNodes(nodeRef, existingNode)) {
          isPossibleTypo = true;
          break;
        }
      }
      
      if (isPossibleTypo) {
        // Find the line where this node is referenced
        const lineIndex = lines.findIndex(line => line.includes(nodeRef));
        if (lineIndex !== -1) {
          const line = lines[lineIndex];
          issues.push(LintUtils.createIssue(
            'dangling-edge',
            lineIndex + 1,
            line.indexOf(nodeRef) + 1,
            `Node "${nodeRef}" might be a typo - similar to existing nodes`,
            `Check for typos in node name "${nodeRef}"`,
            {
              type: 'define-node',
              nodeId: nodeRef
            }
          ));
        }
      }
    }
    
    return issues;
  }
};

/**
 * Main lint analysis engine
 */
const MermaidLint = {
  /**
   * Analyze Mermaid code and return list of issues
   */
  analyze(code) {
    if (!code || !code.trim()) return [];
    
    const lines = code.split(/\r?\n/);
    const issues = [];
    
    // Run individual analyzers
    issues.push(...LintAnalyzers.analyzeDirections(lines));
    issues.push(...LintAnalyzers.analyzeSubgraphs(lines));
    
    // Extract node information for typo analysis
    const { nodes, referencedNodes } = LintAnalyzers.extractNodes(lines);
    issues.push(...LintAnalyzers.analyzeTypos(lines, nodes, referencedNodes));
    
    return issues;
  }
};

/**
 * Main analysis function (public API)
 */
function analyzeMermaidCode(code) {
  return MermaidLint.analyze(code);
}

// ========== MERMAID LINT UI SYSTEM ==========

/**
 * UI configuration and templates
 */
const LINT_UI_CONFIG = {
  ISSUE_TYPES: {
    'dangling-edge': { severity: 'error', icon: 'error' },
    'unknown-direction': { severity: 'warning', icon: 'warning' },
    'missing-end': { severity: 'warning', icon: 'warning' },
    'unexpected-end': { severity: 'warning', icon: 'warning' }
  },
  EMPTY_MESSAGE: 'No issues found ✓',
  LINE_HEIGHT_APPROX: 18
};

/**
 * Icon definitions for different issue types
 */
const LintIcons = {
  error: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zM8 4a.905.905 0 0 0-.9.995l.35 3.507a.552.552 0 0 0 1.1 0l.35-3.507A.905.905 0 0 0 8 4zm.002 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></svg>',
  warning: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575L6.457 1.047zM8 5a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5A.75.75 0 0 1 8 5zM8 11a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75zM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>'
};

/**
 * Quick fix button generators
 */
const QuickFixGenerators = {
  replace(issue) {
    return issue.quickFix.replacements.map(replacement => 
      `<button class="lint-fix-btn" data-fix-type="replace" data-old-text="${escapeHtml(issue.quickFix.text)}" data-new-text="${escapeHtml(replacement)}" data-line="${issue.line}">
        Fix: Use "${escapeHtml(replacement)}"
      </button>`
    ).join('');
  },

  'add-end'(issue) {
    return `<button class="lint-fix-btn" data-fix-type="add-end" data-line="${issue.quickFix.afterLine}">
      Add "end" statement
    </button>`;
  },

  'define-node'(issue) {
    return `<button class="lint-fix-btn" data-fix-type="define-node" data-node-id="${escapeHtml(issue.quickFix.nodeId)}" data-line="${issue.line}">
      Define node "${escapeHtml(issue.quickFix.nodeId)}"
    </button>`;
  }
};

/**
 * Quick fix handlers
 */
const QuickFixHandlers = {
  replace(button, lines) {
    const line = parseInt(button.getAttribute('data-line')) || 1;
    const oldText = button.getAttribute('data-old-text');
    const newText = button.getAttribute('data-new-text');
    
    if (line <= lines.length) {
      lines[line - 1] = lines[line - 1].replace(oldText, newText);
      return lines;
    }
    return lines;
  },

  'add-end'(button, lines) {
    lines.push('end');
    return lines;
  },

  'define-node'(button, lines) {
    const line = parseInt(button.getAttribute('data-line')) || 1;
    const nodeId = button.getAttribute('data-node-id');
    const insertIndex = Math.max(0, line - 1);
    
    lines.splice(insertIndex, 0, `    ${nodeId}[${nodeId}]`);
    return lines;
  }
};

/**
 * Main lint UI controller
 */
const LintUI = {
  /**
   * Display lint results in the UI
   */
  displayResults(issues) {
    if (!lintResults) return;
    
    lintResults.innerHTML = '';
    
    if (issues.length === 0) {
      this.showEmptyState();
      return;
    }
    
    issues.forEach(issue => this.createIssueElement(issue));
  },

  /**
   * Show empty state (no issues found)
   */
  showEmptyState() {
    lintResults.innerHTML = `<div class="lint-empty">${LINT_UI_CONFIG.EMPTY_MESSAGE}</div>`;
  },

  /**
   * Create a single issue element
   */
  createIssueElement(issue) {
    const issueEl = document.createElement('div');
    issueEl.className = 'lint-issue';
    
    const config = LINT_UI_CONFIG.ISSUE_TYPES[issue.type] || { icon: 'warning' };
    const iconSvg = LintIcons[config.icon] || LintIcons.warning;
    
    issueEl.innerHTML = this.buildIssueHTML(issue, config.icon, iconSvg);
    issueEl.addEventListener('click', () => this.jumpToLine(issue));
    
    lintResults.appendChild(issueEl);
  },

  /**
   * Build HTML for an issue element
   */
  buildIssueHTML(issue, iconType, iconSvg) {
    const suggestionHTML = issue.suggestion 
      ? `<div class="lint-suggestion">${escapeHtml(issue.suggestion)}</div>` 
      : '';
    
    const quickFixHTML = issue.quickFix 
      ? `<div class="lint-actions">${this.buildQuickFixButtons(issue)}</div>` 
      : '';
    
    return `
      <div class="lint-icon ${iconType}">
        ${iconSvg}
      </div>
      <div class="lint-content">
        <div class="lint-message">${escapeHtml(issue.message)}</div>
        <div class="lint-location">Line ${issue.line}, Column ${issue.column}</div>
        ${suggestionHTML}
        ${quickFixHTML}
      </div>
    `;
  },

  /**
   * Build quick fix buttons for an issue
   */
  buildQuickFixButtons(issue) {
    const generator = QuickFixGenerators[issue.quickFix.type];
    return generator ? generator(issue) : '';
  },

  /**
   * Jump to the line/column of an issue in the editor
   */
  jumpToLine(issue) {
    if (!rawEl) return;
    
    const lines = rawEl.value.split('\n');
    let charPos = 0;
    
    // Calculate character position
    for (let i = 0; i < issue.line - 1; i++) {
      charPos += lines[i].length + 1; // +1 for newline
    }
    charPos += issue.column - 1;
    
    // Focus and position cursor
    rawEl.focus();
    rawEl.setSelectionRange(charPos, charPos);
    rawEl.scrollTop = (issue.line - 1) * LINT_UI_CONFIG.LINE_HEIGHT_APPROX;
  },

  /**
   * Apply a quick fix from a button click
   */
  applyQuickFix(button) {
    const fixType = button.getAttribute('data-fix-type');
    const handler = QuickFixHandlers[fixType];
    
    if (!handler || !rawEl) return;
    
    const lines = rawEl.value.split('\n');
    const updatedLines = handler(button, lines);
    
    // Update the editor and trigger re-analysis
    rawEl.value = updatedLines.join('\n');
    code = rawEl.value;
    scheduleHighlightUpdate();
    scheduleLintUpdate();
  }
};

/**
 * Public API functions (maintain backward compatibility)
 */
function displayLintResults(issues) {
  LintUI.displayResults(issues);
}

function applyQuickFix(button) {
  LintUI.applyQuickFix(button);
}

// ========== LINT CONTROLLER ==========

/**
 * Lint update scheduling and coordination
 */
const LintController = {
  _updatePending: false,

  /**
   * Schedule a lint update to be run on the next animation frame
   */
  scheduleUpdate() {
    if (this._updatePending) return;
    
    this._updatePending = true;
    requestAnimationFrame(() => {
      this._updatePending = false;
      this.updateResults();
    });
  },

  /**
   * Perform lint analysis and update UI
   */
  updateResults() {
    if (!rawEl || !lintResults) return;
    
    const currentCode = rawEl.value || '';
    const issues = analyzeMermaidCode(currentCode);
    displayLintResults(issues);
  },

  /**
   * Initialize lint panel state from storage
   */
  async initializePanel() {
    if (!lintPanel) return;

    try {
      // Fallback for testing outside extension context
      if (typeof chrome === 'undefined' || !chrome.storage) {
        return;
      }

      const { lintCollapsed } = await chrome.storage.local.get(['lintCollapsed']);
      if (lintCollapsed) {
        lintPanel.classList.add('collapsed');
      }
    } catch (error) {
      console.warn('Failed to initialize lint panel state:', error);
    }
  },

  /**
   * Save lint panel state to storage
   */
  async savePanelState(collapsed) {
    try {
      // Fallback for testing outside extension context
      if (typeof chrome === 'undefined' || !chrome.storage) {
        return;
      }

      await chrome.storage.local.set({ lintCollapsed: collapsed });
    } catch (error) {
      console.warn('Failed to save lint panel state:', error);
    }
  }
};

/**
 * Public API functions for backward compatibility
 */
let lintPending = false; // Kept for backward compatibility

function scheduleLintUpdate() {
  LintController.scheduleUpdate();
}

function updateLintResults() {
  LintController.updateResults();
}

// ---------- Lightweight Mermaid syntax highlighting overlay ----------
let highlightPending = false;

function scheduleHighlightUpdate() {
  if (highlightPending) return;
  highlightPending = true;
  requestAnimationFrame(() => {
    highlightPending = false;
    updateHighlight();
  });
}

function syncHighlightScroll() {
  if (!codeHighlightEl || !rawEl) return;
  codeHighlightEl.scrollTop = rawEl.scrollTop;
  codeHighlightEl.scrollLeft = rawEl.scrollLeft;
}

function hasTextSelection() {
  if (!rawEl) return false;
  const { selectionStart, selectionEnd } = rawEl;
  return typeof selectionStart === 'number' && typeof selectionEnd === 'number' && selectionStart !== selectionEnd;
}

function setOverlayHidden(hidden) {
  if (!codeWrapEl) return;
  codeWrapEl.classList.toggle('hide-overlay', !!hidden);
}

function updateOverlaySelectionVisibility() {
  // Hide overlay only when user has an actual text selection (not just cursor position)
  setOverlayHidden(hasTextSelection());
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function highlightMermaidLine(line) {
  const trimmed = line.trimStart();
  // Comments starting with %% (ignoring leading spaces)
  if (trimmed.startsWith('%%')) {
    return `<span class="tok-comment">${escapeHtml(line)}</span>`;
  }

  // Extract strings to avoid tokenizing inside them
  const strings = [];
  const strRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  let placeholderLine = line.replace(strRe, (m) => {
    const idx = strings.push(m) - 1;
    return `___STR${idx}___`;
  });

  // Escape HTML
  let out = escapeHtml(placeholderLine);

  // Keywords
  const kw = /(\b)(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram-v2|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|subgraph|end|style|linkStyle|classDef|class|click|direction|accTitle|accDescr|accDescription|dateFormat|axisFormat|title|LR|RL|TB|TD|BT)(\b)/g;
  out = out.replace(kw, '$1<span class="tok-keyword">$2</span>$3');

  // Node id at line start before a shape delimiter ( [ ( { )
  out = out.replace(/^(\s*)([A-Za-z][\w:-]*)(\s*)(?=[\[{(])/,
    (m, a, id, b) => `${a}<span class="tok-node">${id}</span>${b}`);

  // Attribute keys before colon (e.g., fill:#fff)
  out = out.replace(/\b([A-Za-z_][\w-]*)\s*:(?=)/g, '<span class="tok-attr">$1</span>:');

  // Arrows and connectors
  out = out.replace(/<?[-.=]{2,}[ox]?>?/g, (m) => `<span class="tok-arrow">${m}</span>`);

  // Numbers
  out = out.replace(/\b\d+(?:\.\d+)?\b/g, (m) => `<span class="tok-number">${m}</span>`);

  // Restore strings
  out = out.replace(/___STR(\d+)___/g, (m, i) => {
    const s = strings[Number(i)] || '';
    return `<span class="tok-string">${escapeHtml(s)}</span>`;
  });

  return out;
}

function highlightMermaid(src) {
  const lines = src.split(/\r?\n/);
  return lines.map(highlightMermaidLine).join('\n');
}

function updateHighlight() {
  if (!codeHighlightEl) return;
  const src = rawEl ? rawEl.value : '';
  codeHighlightEl.innerHTML = highlightMermaid(src || '');
  // Keep overlay scroll in sync after content changes
  syncHighlightScroll();
}

function resolveTheme(val) {
  if (val === 'auto') {
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return isDark ? 'dark' : 'default';
  }
  return val || 'default';
}

function getStructureConfig(val) {
  switch (val) {
    case 'compact':
      return { htmlLabels: true, diagramPadding: 4, nodeSpacing: 25, rankSpacing: 25, curve: 'basis' };
    case 'spacious':
      return { htmlLabels: true, diagramPadding: 16, nodeSpacing: 60, rankSpacing: 60, curve: 'basis' };
    case 'curved':
      return { htmlLabels: true, diagramPadding: 8, nodeSpacing: 40, rankSpacing: 40, curve: 'cardinal' };
    case 'angular':
      return { htmlLabels: true, diagramPadding: 8, nodeSpacing: 40, rankSpacing: 40, curve: 'linear' };
    case 'minimal':
      return { htmlLabels: true, diagramPadding: 2, nodeSpacing: 30, rankSpacing: 35, curve: 'linear' };
    case 'dense':
      return { htmlLabels: true, diagramPadding: 6, nodeSpacing: 20, rankSpacing: 20, curve: 'basis' };
    default:
      return { htmlLabels: true, diagramPadding: 8, nodeSpacing: 40, rankSpacing: 40, curve: 'basis' };
  }
}

function getMermaidThemeConfig(val) {
  const isSysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const font = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"';
  const baseFlow = getStructureConfig(structureSel?.value || 'default');

  const mk = (theme, isDark, vars = {}) => ({ theme, isDark, themeVariables: { fontFamily: font, ...vars }, flowchart: baseFlow });

  switch (val) {
    case 'modern-light':
      return mk('default', false, {
        mainBkg: '#ffffff',
        primaryColor: '#F5F7FB',
        primaryTextColor: '#0B1221',
        primaryBorderColor: '#D1D7E0',
        secondaryColor: '#EEF2FF',
        tertiaryColor: '#E5E7EB',
        textColor: '#0B1221',
        lineColor: '#6B7280',
        clusterBkg: '#F9FAFB',
        clusterBorder: '#D1D5DB',
        edgeLabelBackground: '#ffffff'
      });
    case 'modern-dark':
      return mk('dark', true, {
        mainBkg: '#0B1221',
        primaryColor: '#1F2937',
        primaryTextColor: '#E5E7EB',
        primaryBorderColor: '#374151',
        secondaryColor: '#111827',
        tertiaryColor: '#374151',
        textColor: '#E5E7EB',
        lineColor: '#94A3B8',
        clusterBkg: '#0F172A',
        clusterBorder: '#334155',
        edgeLabelBackground: '#0B1221'
      });
    case 'pastel':
      return mk('default', false, {
        mainBkg: '#ffffff',
        primaryColor: '#F8FAFC',
        primaryTextColor: '#0F172A',
        primaryBorderColor: '#E2E8F0',
        secondaryColor: '#FFE4E6',
        tertiaryColor: '#E9D5FF',
        textColor: '#0F172A',
        lineColor: '#94A3B8',
        clusterBkg: '#FAFAFA',
        clusterBorder: '#E5E7EB',
        edgeLabelBackground: '#ffffff'
      });
    case 'ocean':
      return mk('dark', true, {
        mainBkg: '#0B1E2D',
        primaryColor: '#123B5E',
        primaryTextColor: '#D8EFFF',
        primaryBorderColor: '#1B4965',
        secondaryColor: '#0F2A3D',
        tertiaryColor: '#1B4965',
        textColor: '#D8EFFF',
        lineColor: '#66A3C7',
        clusterBkg: '#0F2A3D',
        clusterBorder: '#1B4965',
        edgeLabelBackground: '#0B1E2D'
      });
    case 'solarized-light':
      return mk('default', false, {
        mainBkg: '#FDF6E3',
        primaryColor: '#EEE8D5',
        primaryTextColor: '#073642',
        primaryBorderColor: '#D6CFB2',
        secondaryColor: '#E1DBBE',
        tertiaryColor: '#EAE2C8',
        textColor: '#073642',
        lineColor: '#586E75',
        clusterBkg: '#F5EFD8',
        clusterBorder: '#D6CFB2',
        edgeLabelBackground: '#FDF6E3'
      });
    case 'solarized-dark':
      return mk('dark', true, {
        mainBkg: '#002B36',
        primaryColor: '#073642',
        primaryTextColor: '#EEE8D5',
        primaryBorderColor: '#094552',
        secondaryColor: '#0B3A46',
        tertiaryColor: '#0B3A46',
        textColor: '#EEE8D5',
        lineColor: '#839496',
        clusterBkg: '#073642',
        clusterBorder: '#0B3A46',
        edgeLabelBackground: '#002B36'
      });
    case 'high-contrast':
      return mk('dark', true, {
        mainBkg: '#000000',
        primaryColor: '#111111',
        primaryTextColor: '#FFFFFF',
        primaryBorderColor: '#FFFFFF',
        secondaryColor: '#000000',
        tertiaryColor: '#000000',
        textColor: '#FFFFFF',
        lineColor: '#FFFFFF',
        clusterBkg: '#000000',
        clusterBorder: '#FFFFFF',
        edgeLabelBackground: '#000000'
      });
    case 'monochrome':
      return mk('default', false, {
        mainBkg: '#FFFFFF',
        primaryColor: '#F8F9FA',
        primaryTextColor: '#111111',
        primaryBorderColor: '#111111',
        secondaryColor: '#FFFFFF',
        tertiaryColor: '#FFFFFF',
        textColor: '#111111',
        lineColor: '#111111',
        clusterBkg: '#FFFFFF',
        clusterBorder: '#111111',
        edgeLabelBackground: '#FFFFFF'
      });
    case 'grape':
      return mk('dark', true, {
        mainBkg: '#100317',
        primaryColor: '#2A0F3B',
        primaryTextColor: '#F5F3FF',
        primaryBorderColor: '#6D28D9',
        secondaryColor: '#1A0B24',
        tertiaryColor: '#6D28D9',
        textColor: '#F5F3FF',
        lineColor: '#A78BFA',
        clusterBkg: '#1A0B24',
        clusterBorder: '#6D28D9',
        edgeLabelBackground: '#100317'
      });
    case 'auto': {
      const dark = !!isSysDark;
      return mk(dark ? 'dark' : 'default', dark);
    }
    default: {
      // built-ins: default, dark, forest, neutral, etc.
      const t = val || 'default';
      const dark = t === 'dark';
      return mk(t, dark);
    }
  }
}

function setupInteractions() {
  // Zoom with wheel
  diagramEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
    zoomAtPoint(factor, e.clientX, e.clientY);
  }, { passive: false });

  // Toggle code panel
  if (toggleCodeBtn) {
    toggleCodeBtn.addEventListener('click', async () => {
      const content = document.getElementById('content');
      if (!content) return;
      const collapsed = content.classList.toggle('collapsed');
      toggleCodeBtn.setAttribute('aria-pressed', String(!collapsed));
      try { await chrome.storage.local.set({ codeCollapsed: collapsed }); } catch (_) {}
      if (collapsed) {
        // Ensure CSS collapsed rule takes effect over any previous inline sizing
        content.style.gridTemplateColumns = '';
      } else {
        // Restoring layout after un-collapsing re-applies saved split ratio
        restoreLayout();
      }
    });
  }

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

  // Cleanup auto-render timer on window unload
  window.addEventListener('beforeunload', () => {
    cancelAutoRender();
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
  // Translate the canvas in CSS for smooth panning
  canvasEl.style.transform = `translate(${rtx}px, ${rty}px)`;
  // Apply zoom inside the SVG to ensure text scales with shapes, even after re-render
  applySvgScale();
}

// Ensure zoom is applied inside the SVG content so fonts scale consistently
function applySvgScale() {
  if (!lastSvg) return;
  try {
    // Find or create a wrapper group to carry the zoom transform
    let wrap = lastSvg.querySelector('[data-zoom-wrapper]');
    if (!wrap) {
      const svgNS = 'http://www.w3.org/2000/svg';
      wrap = document.createElementNS(svgNS, 'g');
      wrap.setAttribute('data-zoom-wrapper', '');
      // Move all children except <defs> and <style> into the wrapper, preserving defs/styles at top level
      const children = Array.from(lastSvg.childNodes);
      for (const node of children) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName.toLowerCase();
          if (tag === 'defs' || tag === 'style') {
            continue;
          }
        }
        wrap.appendChild(node);
      }
      lastSvg.appendChild(wrap);
    }
    // Avoid clipping when scaled content exceeds the original SVG viewport
    // This ensures no white bands appear as we zoom in.
    lastSvg.style.overflow = 'visible';
    // Mermaid sets max-width:100% on the root SVG; override so the root can grow with zoom
    lastSvg.style.maxWidth = 'none';
    // Expand the intrinsic box of the SVG to match the scaled content
    if (lastSvgSize && isFinite(lastSvgSize.w) && isFinite(lastSvgSize.h)) {
      lastSvg.setAttribute('width', String(Math.max(1, Math.round(lastSvgSize.w * scale))));
      lastSvg.setAttribute('height', String(Math.max(1, Math.round(lastSvgSize.h * scale))));
    }
    wrap.setAttribute('transform', `scale(${scale})`);
  } catch (e) {
    // Fallback: apply scale at the canvas level if anything goes wrong
    const rtx = Math.round(tx);
    const rty = Math.round(ty);
    canvasEl.style.transform = `translate(${rtx}px, ${rty}px) scale(${scale})`;
  }
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
    try {
      if (chrome?.storage?.local) {
        chrome.storage.local.set({ splitRatio: ratio });
      }
    } catch (_) {}
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function resetSplit() {
  const content = document.getElementById('content');
  content.style.gridTemplateColumns = '';
  try {
    if (chrome?.storage?.local) {
      chrome.storage.local.remove('splitRatio');
    }
  } catch (_) {}
}

async function restoreLayout() {
  const content = document.getElementById('content');
  
  let splitRatio, codeCollapsed;
  
  // Fallback for testing outside extension context
  if (typeof chrome === 'undefined' || !chrome.storage) {
    splitRatio = null;
    codeCollapsed = false;
  } else {
    const data = await chrome.storage.local.get(['splitRatio', 'codeCollapsed']);
    splitRatio = data.splitRatio;
    codeCollapsed = data.codeCollapsed;
  }
  
  if (content && typeof codeCollapsed === 'boolean') {
    if (codeCollapsed) content.classList.add('collapsed');
    else content.classList.remove('collapsed');
  }
  if (toggleCodeBtn && content) {
    toggleCodeBtn.setAttribute('aria-pressed', String(!content.classList.contains('collapsed')));
  }
  
  // Lint panel state is now handled by LintController.initializePanel()
  
  if (splitRatio && content && !content.classList.contains('collapsed')) {
    // Apply after first layout
    requestAnimationFrame(() => {
      const rect = content.getBoundingClientRect();
      const leftW = Math.round(rect.width * splitRatio);
      content.style.gridTemplateColumns = `${leftW}px 6px 1fr`;
    });
  }
}

async function restorePreferences() {
  let theme, structure, alwaysOnTop;
  
  if (typeof chrome === 'undefined' || !chrome.storage) {
    theme = 'auto';
    structure = 'default';
    alwaysOnTop = false;
  } else {
    const data = await chrome.storage.local.get(['theme', 'structure', 'alwaysOnTop']);
    theme = data.theme;
    structure = data.structure;
    alwaysOnTop = data.alwaysOnTop;
  }
  
  if (theme) themeSel.value = theme;
  if (structure) structureSel.value = structure;
  if (typeof alwaysOnTop === 'boolean') ontopChk.checked = alwaysOnTop;
  applyAlwaysOnTop();
}

function setupWindowInfo() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.windows || !chrome.windows.getCurrent) return resolve();
    chrome.windows.getCurrent((w) => { currentWindowId = w && w.id; resolve(); });
  });
}

function getCurrentWindow() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.windows) return resolve();
    chrome.windows.getCurrent(resolve);
  });
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
  
  try {
    if (chrome?.storage?.session) {
      await chrome.storage.session.set({ [id]: sanitized });
    }
  } catch (_) {}
  
  if (chrome?.runtime?.getURL) {
    return chrome.runtime.getURL(`viewer.html#${encodeURIComponent(id)}`);
  }
  return `viewer.html#${encodeURIComponent(id)}`;
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
    try {
      if (chrome?.storage?.local) {
        chrome.storage.local.set({ popupSize: { width, height } });
      }
    } catch (_) {}
  }
}
