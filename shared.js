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
// toolbar icon. Renders a full mini-dashboard (matching the toolbar popup's
// layout) inside a shadow root so host-page CSS can't leak in or clash.
const TokenWidget = (function () {
  const CONFIG = {
    claude: { label: "Claude", accent: "#d97757" },
    chatgpt: { label: "ChatGPT", accent: "#10a37f" }
  };

  let state = {
    service: null,
    minimized: false,
    hidden: false,
    dailyStats: {}
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
    return String(n || 0);
  }

  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function last7Keys() {
    const keys = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      keys.push(dateKey(d));
    }
    return keys;
  }

  function dayTotal(dayStats) {
    if (!dayStats) return 0;
    let total = 0;
    for (const svc of Object.values(dayStats)) {
      total += (svc.user || 0) + (svc.assistant || 0);
    }
    return total;
  }

  function serviceTotal(dailyStats, service) {
    let total = 0;
    for (const day of Object.values(dailyStats)) {
      if (day[service]) total += (day[service].user || 0) + (day[service].assistant || 0);
    }
    return total;
  }

  function buildStyles(accent) {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .widget {
        position: fixed;
        z-index: 2147483647;
        bottom: 20px;
        right: 20px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #ffffff;
        color: #1f1f23;
        border-radius: 16px;
        box-shadow: 0 10px 34px rgba(0,0,0,0.22);
        overflow: hidden;
        width: 420px;
        max-width: calc(100vw - 32px);
        user-select: none;
        border: 1px solid #ececee;
      }
      .widget.hidden { display: none; }
      .header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 16px 20px;
        cursor: grab;
        border-bottom: 1px solid #f0f0f2;
      }
      .header:active { cursor: grabbing; }
      .dot { width: 12px; height: 12px; border-radius: 50%; background: ${accent}; flex-shrink: 0; }
      .title { font-size: 19px; font-weight: 700; flex: 1; white-space: nowrap; }
      .btn {
        background: transparent;
        border: none;
        color: #8a8a90;
        cursor: pointer;
        font-size: 19px;
        line-height: 1;
        padding: 4px 8px;
        border-radius: 6px;
      }
      .btn:hover { background: #f0f0f2; color: #1f1f23; }
      .body { padding: 16px 20px 20px; }
      .body.collapsed { display: none; }

      .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
      .card { background: #fafafa; border: 1px solid #ececee; border-radius: 12px; padding: 12px; text-align: center; }
      .card-label { font-size: 13px; color: #8a8a90; margin-bottom: 5px; }
      .card-value { font-size: 22px; font-weight: 700; }

      .service-breakdown { background: #fafafa; border: 1px solid #ececee; border-radius: 12px; padding: 12px 14px; margin-bottom: 16px; }
      .service-row { display: flex; align-items: center; padding: 5px 0; font-size: 15px; }
      .service-name { flex: 1; margin-left: 10px; font-weight: 600; }
      .service-value { color: #6b6b70; font-weight: 600; }

      .chart-section { background: #fafafa; border: 1px solid #ececee; border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; }
      .chart-title { font-size: 13px; color: #8a8a90; margin-bottom: 8px; }
      canvas { width: 100%; height: 130px; display: block; }
      .legend { display: flex; gap: 16px; margin-top: 8px; font-size: 13px; color: #6b6b70; }
      .legend span { display: flex; align-items: center; gap: 6px; }

      .note { font-size: 12px; color: #a3a3a8; text-align: center; line-height: 1.4; }

      .collapsed-pill { display: flex; align-items: center; gap: 10px; padding: 12px 20px; cursor: grab; }
      .collapsed-pill .val { font-size: 18px; font-weight: 700; }
      .collapsed-pill .lbl { font-size: 13px; color: #8a8a90; flex: 1; }
    `;
  }

  function drawChart() {
    const canvas = els.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = 380;
    const cssH = 130;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const keys = last7Keys();
    const claudeVals = keys.map((k) => {
      const s = state.dailyStats[k]?.claude;
      return s ? (s.user || 0) + (s.assistant || 0) : 0;
    });
    const chatgptVals = keys.map((k) => {
      const s = state.dailyStats[k]?.chatgpt;
      return s ? (s.user || 0) + (s.assistant || 0) : 0;
    });

    const maxVal = Math.max(1, ...claudeVals, ...chatgptVals);
    const chartH = cssH - 22;
    const groupW = cssW / keys.length;
    const barW = groupW * 0.3;

    keys.forEach((k, i) => {
      const groupX = i * groupW;
      const cH = (claudeVals[i] / maxVal) * chartH;
      const gH = (chatgptVals[i] / maxVal) * chartH;

      ctx.fillStyle = "#d97757";
      ctx.fillRect(groupX + groupW * 0.15, chartH - cH, barW, cH);

      ctx.fillStyle = "#10a37f";
      ctx.fillRect(groupX + groupW * 0.55, chartH - gH, barW, gH);

      ctx.fillStyle = "#a3a3a8";
      ctx.font = "11px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(k.slice(5), groupX + groupW / 2, chartH + 16);
    });
  }

  function render() {
    if (!els.root) return;
    els.widget.classList.toggle("hidden", state.hidden);
    els.body.classList.toggle("collapsed", state.minimized);
    els.collapsedPill.style.display = state.minimized ? "flex" : "none";
    els.header.style.display = state.minimized ? "none" : "flex";

    const today = dateKey(new Date());
    const todayTotal = dayTotal(state.dailyStats[today]);
    const weekTotal = last7Keys().reduce((acc, k) => acc + dayTotal(state.dailyStats[k]), 0);
    const allTime = Object.values(state.dailyStats).reduce((acc, day) => acc + dayTotal(day), 0);

    els.todayVal.textContent = formatNum(todayTotal);
    els.weekVal.textContent = formatNum(weekTotal);
    els.allTimeVal.textContent = formatNum(allTime);
    els.claudeVal.textContent = formatNum(serviceTotal(state.dailyStats, "claude")) + " tokens";
    els.chatgptVal.textContent = formatNum(serviceTotal(state.dailyStats, "chatgpt")) + " tokens";
    els.collapsedVal.textContent = formatNum(todayTotal);

    if (state.x != null && state.y != null) {
      els.widget.style.left = state.x + "px";
      els.widget.style.top = state.y + "px";
      els.widget.style.right = "auto";
      els.widget.style.bottom = "auto";
    }

    drawChart();
  }

  function makeDraggable(handle) {
    let dragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".btn")) return;
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

  function refreshStats() {
    try {
      chrome.runtime.sendMessage({ type: "GET_STATS" }, (res) => {
        if (!res || !res.dailyStats) return;
        state.dailyStats = res.dailyStats;
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
        <span class="lbl">Token Usage — Today</span>
        <span class="val collapsed-val">0</span>
        <button class="btn expand-btn" title="Expand">▢</button>
      </div>
      <div class="header">
        <span class="dot"></span>
        <span class="title">Token Usage</span>
        <button class="btn min-btn" title="Minimize">–</button>
        <button class="btn hide-btn" title="Hide">×</button>
      </div>
      <div class="body">
        <div class="summary-grid">
          <div class="card">
            <div class="card-label">Today</div>
            <div class="card-value today-val">0</div>
          </div>
          <div class="card">
            <div class="card-label">Last 7 days</div>
            <div class="card-value week-val">0</div>
          </div>
          <div class="card">
            <div class="card-label">All time</div>
            <div class="card-value alltime-val">0</div>
          </div>
        </div>
        <div class="service-breakdown">
          <div class="service-row">
            <span class="dot" style="background:#d97757;"></span>
            <span class="service-name">Claude</span>
            <span class="service-value claude-val">0 tokens</span>
          </div>
          <div class="service-row">
            <span class="dot" style="background:#10a37f;"></span>
            <span class="service-name">ChatGPT</span>
            <span class="service-value chatgpt-val">0 tokens</span>
          </div>
        </div>
        <div class="chart-section">
          <div class="chart-title">Last 7 days</div>
          <canvas class="chart-canvas" width="380" height="130"></canvas>
          <div class="legend">
            <span><span class="dot" style="background:#d97757;"></span>Claude</span>
            <span><span class="dot" style="background:#10a37f;"></span>ChatGPT</span>
          </div>
        </div>
        <div class="note">Estimates only — approximated from message length, not exact billed tokens.</div>
      </div>
    `;
    shadow.appendChild(widget);

    els = {
      root: host,
      widget,
      header: widget.querySelector(".header"),
      body: widget.querySelector(".body"),
      collapsedPill: widget.querySelector(".collapsed-pill"),
      todayVal: widget.querySelector(".today-val"),
      weekVal: widget.querySelector(".week-val"),
      allTimeVal: widget.querySelector(".alltime-val"),
      claudeVal: widget.querySelector(".claude-val"),
      chatgptVal: widget.querySelector(".chatgpt-val"),
      collapsedVal: widget.querySelector(".collapsed-val"),
      canvas: widget.querySelector(".chart-canvas")
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
    refreshStats();
    setInterval(refreshStats, 15000);
  }

  function addTokens(tokens) {
    if (!els.root) return;
    const today = dateKey(new Date());
    if (!state.dailyStats[today]) state.dailyStats[today] = {};
    if (!state.dailyStats[today][state.service]) state.dailyStats[today][state.service] = { user: 0, assistant: 0 };
    // Nudge locally for instant feedback; refreshStats() reconciles with the
    // authoritative background copy every 15s.
    state.dailyStats[today][state.service].user += Math.round(tokens / 2);
    state.dailyStats[today][state.service].assistant += tokens - Math.round(tokens / 2);
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
