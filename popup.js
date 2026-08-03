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
  for (const service of Object.values(dayStats)) {
    total += (service.user || 0) + (service.assistant || 0);
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

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function drawChart(dailyStats) {
  const canvas = document.getElementById("chart");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 360;
  const cssH = 140;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const keys = last7Keys();
  const claudeVals = keys.map((k) => {
    const s = dailyStats[k]?.claude;
    return s ? (s.user || 0) + (s.assistant || 0) : 0;
  });
  const chatgptVals = keys.map((k) => {
    const s = dailyStats[k]?.chatgpt;
    return s ? (s.user || 0) + (s.assistant || 0) : 0;
  });

  const maxVal = Math.max(1, ...claudeVals, ...chatgptVals);
  const chartH = cssH - 24;
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
    ctx.font = "9px -apple-system, sans-serif";
    ctx.textAlign = "center";
    const label = k.slice(5); // MM-DD
    ctx.fillText(label, groupX + groupW / 2, chartH + 14);
  });
}

async function refresh() {
  const { dailyStats } = await chrome.runtime.sendMessage({ type: "GET_STATS" });

  const today = dateKey(new Date());
  document.getElementById("todayTotal").textContent = formatNum(dayTotal(dailyStats[today]));

  const weekKeys = last7Keys();
  const weekSum = weekKeys.reduce((acc, k) => acc + dayTotal(dailyStats[k]), 0);
  document.getElementById("weekTotal").textContent = formatNum(weekSum);

  const allTime = Object.values(dailyStats).reduce((acc, day) => acc + dayTotal(day), 0);
  document.getElementById("allTimeTotal").textContent = formatNum(allTime);

  document.getElementById("claudeTotal").textContent = formatNum(serviceTotal(dailyStats, "claude")) + " tokens";
  document.getElementById("chatgptTotal").textContent = formatNum(serviceTotal(dailyStats, "chatgpt")) + " tokens";

  drawChart(dailyStats);
}

document.getElementById("resetBtn").addEventListener("click", async () => {
  if (!confirm("Clear all recorded token usage data?")) return;
  await chrome.runtime.sendMessage({ type: "RESET_STATS" });
  refresh();
});

document.getElementById("showWidgetBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "SHOW_WIDGET" }, () => {
    // Ignore errors (e.g. tab isn't claude.ai/chatgpt.com — no listener there).
    void chrome.runtime.lastError;
  });
});

refresh();
