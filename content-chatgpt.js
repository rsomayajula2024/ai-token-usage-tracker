// Content script for chatgpt.com / chat.openai.com
// ChatGPT marks each turn with data-message-author-role="user"|"assistant",
// which has been stable across recent UI revisions.

(function () {
  const SEEN = new Set();
  TokenWidget.mount("chatgpt");

  function extractText(node) {
    return (node.innerText || node.textContent || "").trim();
  }

  function scan() {
    document.querySelectorAll('[data-message-author-role]').forEach((node) => {
      const role = node.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") return;
      const text = extractText(node);
      if (!text) return;
      const key = role + ":" + TokenTracker.hashText(text);
      if (SEEN.has(key)) return;
      SEEN.add(key);
      TokenTracker.record("chatgpt", role, text);
      TokenWidget.addTokens(TokenTracker.estimateTokens(text));
    });
  }

  setTimeout(scan, 1500);

  const observer = new MutationObserver(() => {
    clearTimeout(observer._debounce);
    observer._debounce = setTimeout(scan, 800);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      SEEN.clear();
      setTimeout(scan, 1500);
    }
  }, 1000);
})();
