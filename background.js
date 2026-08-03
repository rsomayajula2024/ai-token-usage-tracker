// Background service worker: receives usage events from content scripts,
// dedupes them, and persists aggregated daily totals in chrome.storage.local.
//
// Storage shape:
// {
//   dailyStats: {
//     "2026-08-03": {
//       claude:  { user: 1234, assistant: 5678 },
//       chatgpt: { user: 234,  assistant: 999 }
//     },
//     ...
//   },
//   seenHashes: ["<hash>", ...]   // capped ring buffer for dedupe across restarts
// }

const MAX_SEEN_HASHES = 5000;

function dateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function getStore() {
  const data = await chrome.storage.local.get(["dailyStats", "seenHashes"]);
  return {
    dailyStats: data.dailyStats || {},
    seenHashes: data.seenHashes || []
  };
}

async function setStore(store) {
  await chrome.storage.local.set(store);
}

async function recordUsage(payload) {
  const { service, role, tokens, textHash, timestamp } = payload;
  if (!service || !role || !tokens) return;

  const store = await getStore();
  const dedupeKey = `${service}:${role}:${textHash}`;

  if (store.seenHashes.includes(dedupeKey)) return;

  store.seenHashes.push(dedupeKey);
  if (store.seenHashes.length > MAX_SEEN_HASHES) {
    store.seenHashes = store.seenHashes.slice(-MAX_SEEN_HASHES);
  }

  const key = dateKey(timestamp || Date.now());
  if (!store.dailyStats[key]) store.dailyStats[key] = {};
  if (!store.dailyStats[key][service]) store.dailyStats[key][service] = { user: 0, assistant: 0 };
  store.dailyStats[key][service][role] = (store.dailyStats[key][service][role] || 0) + tokens;

  await setStore(store);
}

async function getStats() {
  const store = await getStore();
  return store.dailyStats;
}

async function resetStats() {
  await chrome.storage.local.set({ dailyStats: {}, seenHashes: [] });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "RECORD_USAGE") {
    recordUsage(message.payload).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "GET_STATS") {
    getStats().then((dailyStats) => sendResponse({ dailyStats }));
    return true;
  }
  if (message?.type === "RESET_STATS") {
    resetStats().then(() => sendResponse({ ok: true }));
    return true;
  }
});
