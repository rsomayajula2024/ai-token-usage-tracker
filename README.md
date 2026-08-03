# AI Token Usage Tracker (Chrome Extension)

Tracks estimated token usage on claude.ai and chatgpt.com/chat.openai.com, and shows a dashboard in the toolbar popup.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin the extension, then browse claude.ai or ChatGPT as usual. Open the toolbar icon anytime to see totals.

## On-page widget

A small floating widget appears in the bottom-right corner of claude.ai and chatgpt.com while you chat, showing your session total and today's total live — no need to click the toolbar icon. Drag it by the header to reposition, click **–** to collapse it to a small pill, or **×** to hide it entirely. If you hide it, bring it back from the toolbar popup's **Show on-page widget** button.

## What it tracks

For each message you send and receive on Claude and ChatGPT, a content script reads the message text and estimates its token count (roughly `chars/4` blended with a word-count estimate). Totals are grouped by day and by user/assistant role, stored locally via `chrome.storage.local`, and never leave your browser.

## Limitations — read before relying on this

- **These are estimates, not exact billed token counts.** Neither claude.ai's nor ChatGPT's web UI exposes real token counts in the page — the actual number the provider bills you for depends on their specific tokenizer (Claude's vs. OpenAI's BPE), which can differ from this approximation by 10-20%.
- For **exact** usage/billing numbers, you'd need to pull data from each provider's API/usage dashboard (console.anthropic.com, platform.openai.com/usage) using an API key — that's a different data source than your normal chat login and wasn't in scope here.
- DOM selectors (`data-testid="user-message"` on Claude, `data-message-author-role` on ChatGPT) can change if either site redesigns its UI, which would stop new messages from being counted until the selectors are updated.
- Only tracks activity in tabs where the page is open while you're chatting; it doesn't backfill history from before install.

## Reset

Click **Reset** in the popup to clear all stored data.
