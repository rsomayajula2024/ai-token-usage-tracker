// Content script for claude.ai
// Watches the conversation DOM and records an estimated token count for each
// user and assistant turn as it appears. Selectors are best-effort — Claude's
// UI markup changes periodically, so this uses a couple of fallback strategies.

(function () {
  const SEEN = new Set();
  TokenWidget.mount("claude");

  function getRoleFromNode(node) {
    if (node.matches('[data-testid="user-message"]')) return "user";
    if (node.closest && node.closest('[data-testid="user-message"]')) return "user";

    // Assistant responses in current Claude.ai UI are rendered inside a
    // container carrying a class containing "font-claude-message".
    if (node.className && typeof node.className === "string" &&
        node.className.includes("font-claude-message")) {
      return "assistant";
    }
    if (node.querySelector && node.querySelector('[class*="font-claude-message"]')) {
      return "assistant";
    }
    return null;
  }

  function extractText(node) {
    return (node.innerText || node.textContent || "").trim();
  }

  function scan() {
    // User turns
    document.querySelectorAll('[data-testid="user-message"]').forEach((node) => {
      const text = extractText(node);
      if (!text) return;
      const key = "user:" + TokenTracker.hashText(text);
      if (SEEN.has(key)) return;
      SEEN.add(key);
      TokenTracker.record("claude", "user", text);
      TokenWidget.addTokens(TokenTracker.estimateTokens(text));
    });

    // Assistant turns
    document.querySelectorAll('[class*="font-claude-message"]').forEach((node) => {
      const text = extractText(node);
      if (!text) return;
      const key = "assistant:" + TokenTracker.hashText(text);
      if (SEEN.has(key)) return;
      SEEN.add(key);
      TokenTracker.record("claude", "assistant", text);
      TokenWidget.addTokens(TokenTracker.estimateTokens(text));
    });
  }

  // Initial pass once the app has rendered, then keep watching for new turns.
  setTimeout(scan, 1500);

  const observer = new MutationObserver(() => {
    clearTimeout(observer._debounce);
    observer._debounce = setTimeout(scan, 800);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Claude.ai is a SPA; re-scan on URL change (new conversation navigation).
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      SEEN.clear();
      setTimeout(scan, 1500);
    }
  }, 1000);
})();
