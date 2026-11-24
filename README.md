# Antigravity Token Meter

A native **Antigravity MCP App** plugin for visualizing local token usage, estimated API cost, and Google AI Ultra subscription value directly inside the Antigravity App — in the **left sidebar** (full-page), the **right side pane** (`+` menu), or **inline in chat**.

- **Zero binary patching**: Uses Antigravity's official MCP App plugin mechanism (`~/.gemini/config/plugins/`), never touches `app.asar` or breaks macOS code signing.
- **100% local & read-only**: Reads first-party token counts from `~/.gemini/antigravity*/brain/*/.system_generated/logs/transcript.jsonl`, conversation & project metadata from `conversation_summaries.db` and `~/.gemini/config/projects/*.json`, plus optional RTK savings from `rtk gain --format json`.
- **Native light/dark theming**: Follows Antigravity's live CSS host variables.
- **Zero runtime dependencies**: Both the MCP server (`dist/server.mjs`) and the single-file HTML dashboard (`dist/app.html`) are pre-bundled.

## Features

- **API Cost & Ultra Value Conversion**: Estimates USD & CNY API cost per step by model rate, and converts usage into Google AI Ultra / Pro monthly share & equivalent days (`Ultra 20x $199.99`, `Ultra 5x $99.99`, `Ultra $249.99`, `Pro $19.99`).
- **By Project Aggregation**: Groups conversations by Antigravity Project / Workspace with click-to-filter.
- **By Conversation & Per-Prompt Turn Breakdown**: Shows current context size, cumulative tokens, cache hit rate, prompt count, and average cost per prompt. Click any conversation to inspect **every individual user prompt turn** (`#1`, `#2`, …) with its exact token count and cost.
- **Daily Stacked Bar Chart & Model Breakdown**: SVG daily trend (Cache Read / Input / Output) with hover readout and per-model cost split.

## Quick Install

```bash
git clone https://github.com/DaDerekkk/antigravity-token-meter.git
cd antigravity-token-meter
npm install
npm run build
bash scripts/install.sh
```

Antigravity automatically discovers `~/.gemini/config/plugins/token-meter/` with no restart required. Open **Token Meter** from the left sidebar or the side pane `+` menu.

## Development & Test

```bash
npm run build
npm test
```

## License

MIT
