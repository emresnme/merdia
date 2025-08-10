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

  // Remove parentheses, replace pipe characters, and normalize accented Latin characters
  function cleanSelectedCode(text) {
    if (!text) return text;
    return text
      .replace(/[()]/g, '')
      .replace(/\|/g, '-')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
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
      let selectedFromPage = "";
      
      try {
        // Try to read selection directly from the page (reliable for large selections)
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => (window.getSelection && window.getSelection().toString()) || ""
        });
        selectedFromPage = result || "";
      } catch (scriptError) {
        // Script injection blocked by policy - fall back to context menu selection
        console.warn("Script injection blocked, using context menu selection:", scriptError.message);
      }
  
      const selection = (selectedFromPage || info.selectionText || "").trim();
      if (!selection) return;
  
      const rawCode = stripFences(selection);
      const code = cleanSelectedCode(rawCode);
      const id = safeUUID();
  
      // Store in session storage (ephemeral). Keyed by id.
      await chrome.storage.session.set({ [id]: code });
  
      // Open viewer window with the id
      const url = chrome.runtime.getURL(`viewer.html#${encodeURIComponent(id)}`);
      // Use last saved size if available, otherwise a larger default
      const { popupSize } = await chrome.storage.local.get('popupSize');
      const width = (popupSize && popupSize.width) ? popupSize.width : 1200;
      const height = (popupSize && popupSize.height) ? popupSize.height : 800;
      await chrome.windows.create({
        url,
        type: "popup",
        width,
        height
      });
    } catch (err) {
      // Non-fatal; just log for debugging
      console.error("Mermaid extension error:", err);
    }
  });
  