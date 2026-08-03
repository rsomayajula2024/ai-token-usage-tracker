// Shared utilities used by all content scripts.
// Token estimation is a heuristic approximation (~4 chars/token for English text,
// roughly matching GPT/Claude BPE tokenizers on average prose). It will not match
// exact billed token counts, which only the provider APIs can report.

const TokenTracker = {
  estimateTokens(text) {
    if (!text) return 0;
    const trimmed = text.trim();
    if (!trimmed) return 0;
    // Blend of char-based and word-based estimate for better accuracy across
    // short/punctuation-heavy and long prose messages.
    const charEstimate = trimmed.length / 4;
    const wordEstimate = trimmed.split(/\s+/).length * 1.33;
    return Math.max(1, Math.round((charEstimate + wordEstimate) / 2));
  },

  // Sends a usage event to the background service worker for storage.
  record(service, role, text) {
    const tokens = this.estimateTokens(text);
    if (tokens <= 0) return;
    try {
      chrome.runtime.sendMessage({
        type: "RECORD_USAGE",
        payload: {
          service,       // "claude" | "chatgpt"
          role,          // "user" | "assistant"
          tokens,
          textHash: this.hashText(text),
          timestamp: Date.now()
        }
      });
    } catch (e) {
      // Extension context can be invalidated on reload; fail silently.
    }
  },

  // Cheap non-cryptographic hash so background can dedupe repeated observations
  // of the same message (MutationObserver often fires multiple times per node).
  hashText(text) {
    const s = text.trim();
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) | 0;
    }
    return `${s.length}:${hash}`;
  }
};

// Floating on-page widget: injected into claude.ai / chatgpt.com so usage is
// visible while you're actually chatting, without needing to click the
// toolbar icon. Uses a shadow root so host-page CSS can't leak in or clash.
const TokenWidget = (function () {
  const CONFIG = {
    claude: { label: "Claude", accent: "#d97757" },
    chatgpt: { label: "ChatGPT", accent: "#10a37f" }
  };

  let state = {
    service: null,
    sessionTokens: 0,
    todayTokens: 0,
    minimized: false,
    hidden: false
  };

  let els = {};

  function storageKey(service) {
    return `tokenTrackerWidget_${service}`;
  }

  function loadUiState(service) {
    try {
      const raw = localStorage.getItem(storageKey(service));
      if (raw) {
        const saved = JSON.parse(raw);
        state.minimized = !!saved.minimized;
        state.hidden = !!saved.hidden;
        if (saved.x != null) state.x = saved.x;
        if (saved.y != null) state.y = saved.y;
      }
    } catch (e) { /* ignore */ }
  }

  function saveUiState() {
    try {
      localStorage.setItem(
        storageKey(state.service),
        JSON.stringify({ minimized: state.minimized, hidden: state.hidden, x: state.x, y: state.y })
      );
    } catch (e) { /* ignore */ }
  }

  function formatNum(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function buildStyles(accent) {
    return `
      :host { all: initial; }
      .widget {
        position: fixed;
        z-index: 2147483647;
        bottom: 20px;
        right: 20px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #1f1f23;
        color: #fff;
        border-radius: 12px;
        box-shadow: 0 4px 18px rgba(0,0,0,0.28);
        overflow: hidden;
        min-width: 168px;
        user-select: none;
        transition: opacity 0.15s ease;
      }
      .widget.hidden { display: none; }
      .header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        cursor: grab;
        background: rgba(255,255,255,0.04);
      }
      .header:active { cursor: grabbing; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: ${accent}; flex-shrink: 0; }
      .title { font-size: 12px; font-weight: 600; flex: 1; white-space: nowrap; }
      .btn {
        background: transparent;
        border: none;
        color: rgba(255,255,255,0.55);
        cursor: pointer;
        font-size: 13px;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 4px;
      }
      .btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
      .body { padding: 8px 10px 10px; font-size: 11.5px; }
      .body.collapsed { display: none; }
      .row { display: flex; justify-content: space-between; padding: 2px 0; color: rgba(255,255,255,0.85); }
      .row .val { font-weight: 700; color: #fff; }
      .note { margin-top: 4px; font-size: 9.5px; color: rgba(255,255,255,0.4); line-height: 1.3; }
      .collapsed-pill { display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: grab; }
      .collapsed-pill .val { font-size: 12px; font-weight: 700; }
    `;
  }

  function render() {
    if (!els.root) return;
    els.widget.classList.toggle("hidden", state.hidden);
    els.body.classList.toggle("collapsed", state.minimized);
    els.collapsedPill.style.display = state.minimized ? "flex" : "none";
    els.header.style.display = state.minimized ? "none" : "flex";
    els.sessionVal.textContent = formatNum(state.sessionTokens);
    els.todayVal.textContent = formatNum(state.todayTokens);
    els.collapsedVal.textContent = formatNum(state.todayTokens);
    if (state.x != null && state.y != null) {
      els.widget.style.left = state.x + "px";
      els.widget.style.top = state.y + "px";
      els.widget.style.right = "auto";
      els.widget.style.bottom = "auto";
    }
  }

  function makeDraggable(handle) {
    let dragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      const rect = els.widget.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      state.x = Math.max(0, startLeft + (e.clientX - startX));
      state.y = Math.max(0, startTop + (e.clientY - startY));
      render();
    });

    window.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        saveUiState();
      }
    });
  }

  async function refreshToday() {
    try {
      chrome.runtime.sendMessage({ type: "GET_STATS" }, (res) => {
        if (!res || !res.dailyStats) return;
        const d = new Date();
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const day = res.dailyStats[key];
        const svc = day && day[state.service];
        state.todayTokens = svc ? (svc.user || 0) + (svc.assistant || 0) : 0;
        render();
      });
    } catch (e) { /* extension context invalidated, ignore */ }
  }

  function mount(service) {
    if (els.root) return; // already mounted
    const cfg = CONFIG[service] || { label: service, accent: "#888" };
    state.service = service;
    loadUiState(service);

    const host = document.createElement("div");
    host.id = "ai-token-tracker-host";
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = buildStyles(cfg.accent);
    shadow.appendChild(style);

    const widget = document.createElement("div");
    widget.className = "widget";
    widget.innerHTML = `
      <div class="collapsed-pill" style="display:none;">
        <span class="dot"></span>
        <span class="val collapsed-val">0</span>
        <button class="btn expand-btn" title="Expand">▢</button>
      </div>
      <div class="header">
        <span class="dot"></span>
        <span class="title">${cfg.label} tokens</span>
        <button class="btn min-btn" title="Minimize">–</button>
        <button class="btn hide-btn" title="Hide">×</button>
      </div>
      <div class="body">
        <div class="row"><span>This session</span><span class="val session-val">0</span></div>
        <div class="row"><span>Today</span><span class="val today-val">0</span></div>
        <div class="note">Estimated, not exact billed tokens.</div>
      </div>
    `;
    shadow.appendChild(widget);

    els = {
      root: host,
      widget,
      header: widget.querySelector(".header"),
      body: widget.querySelector(".body"),
      collapsedPill: widget.querySelector(".collapsed-pill"),
      sessionVal: widget.querySelector(".session-val"),
      todayVal: widget.querySelector(".today-val"),
      collapsedVal: widget.querySelector(".collapsed-val")
    };

    widget.querySelector(".min-btn").addEventListener("click", () => {
      state.minimized = true;
      saveUiState();
      render();
    });
    widget.querySelector(".expand-btn").addEventListener("click", () => {
      state.minimized = false;
      saveUiState();
      render();
    });
    widget.querySelector(".hide-btn").addEventListener("click", () => {
      state.hidden = true;
      saveUiState();
      render();
    });

    makeDraggable(els.header);
    makeDraggable(els.collapsedPill);

    render();
    refreshToday();
    setInterval(refreshToday, 15000);
  }

  function addTokens(tokens) {
    if (!els.root) return;
    state.sessionTokens += tokens;
    render();
    // Today's total is authoritative from storage; nudge it locally too so
    // the number updates instantly instead of waiting for the next poll.
    state.todayTokens += tokens;
    render();
  }

  function show() {
    if (!els.root) return;
    state.hidden = false;
    saveUiState();
    render();
  }

  return { mount, addTokens, show };
})();

// Lets the popup bring the on-page widget back if it was hidden.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SHOW_WIDGET") {
    TokenWidget.show();
    sendResponse({ ok: true });
  }
});
