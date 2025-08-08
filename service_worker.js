// Create the context menu on install/update
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: "render-mermaid",
      title: "Mermaid Diagram",
      contexts: ["selection"]
    });
  });
  
  function stripFences(text) {
    // Remove ```mermaid fences if present; keep inner content intact
    const fence = /^\s*```(?:\s*mermaid)?\s*\n([\s\S]*?)\n```?\s*$/i;
    const m = text.match(fence);
    return m ? m[1] : text;
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
  
  function safeUUID() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    // Fallback if ever needed
    return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== "render-mermaid") return;
    if (!tab || !tab.id) return;
  
    try {
      // Always read selection directly from the page (reliable for large selections)
      const [{ result: selectedFromPage } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (window.getSelection && window.getSelection().toString()) || ""
      });
  
      const selection = (selectedFromPage || info.selectionText || "").trim();
      if (!selection) return;
  
      const rawCode = stripFences(selection);
      const code = normalizeBracketLabelParens(rawCode);
      const id = safeUUID();
  
      // Store in session storage (ephemeral). Keyed by id.
      await chrome.storage.session.set({ [id]: code });
  
      // Open viewer window with the id
      const url = chrome.runtime.getURL(`viewer.html#${encodeURIComponent(id)}`);
      await chrome.windows.create({
        url,
        type: "popup",
        width: 900,
        height: 620
      });
    } catch (err) {
      // Non-fatal; just log for debugging
      console.error("Mermaid extension error:", err);
    }
  });
  