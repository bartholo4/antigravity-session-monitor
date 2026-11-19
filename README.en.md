# Antigravity Session Monitor (`session-monitor`)

[中文](README.md)

A DSH (DeepSeek Harness)-style realtime session telemetry and control panel plugin for **Antigravity 2.0 Desktop**, mounted in the right-hand Auxiliary Pane (`Aux Pane`). Purely local, read-only parsing of `transcript.jsonl` with zero outbound network requests and zero third-party npm dependencies.

## Features & Metrics

1. **Context Window %**
   - Computes active context length from `input_tokens + cache_read_tokens` of the latest model step.
   - Compact top quick-glance pills + circular progress ring with switchable reference capacities (`128k` / `200k` / `1M` / `2M`, default `1M`), showing step delta, session peak, remaining headroom, and stacked token composition (cache read / uncached input / step output).
   - Displays compaction count only when an actual context drop is detected.
2. **Prefix Cache Hit Rate**
   - Tracks **current-step hit rate** (`cache_read_tokens / (input_tokens + cache_read_tokens)`), **warm cumulative hit rate** (steps after cold start), and **full-session cumulative hit rate**.
   - Reports total cached tokens read, uncached input tokens, and automatic cache-reset detection.
3. **Token Throughput (`tok/s`)**
   - Computes effective per-step output rate (`output_tokens / step duration`, including TTFT and thinking tokens) from step timestamps, alongside step duration, session average/peak `tok/s`, cumulative output tokens, and user-turn / model-step counters.
4. **Trend Chart & Step Telemetry Table**
   - Lightweight inline SVG trend chart switchable across `tok/s`, `Context`, and `Cache Hit Rate`.
   - Recent 25-step breakdown table with tool-call summaries and compaction/reset badges, one-click `/compact` copy button, automatic host light/dark theme sync, and active conversation selector.

## Architecture & Performance

- **Byte-Offset Incremental Parsing**: Reads only newly appended bytes of `transcript.jsonl` via `fs/promises` for O(1) per-step updates while keeping a bounded rolling window (48 steps) in memory.
- **Decoupled Recent List (`/api/recent`)**: Cached with 15s TTL + `brain/` directory watcher invalidation + 32-way concurrent `stat`, reading only the head 16 KB (title) and tail 32 KB (latest context & status) per conversation.
- **Watcher-Driven Long Polling**: Per-conversation ETag + `fs.watch` (60 ms debounce) long-polling in `/api/metrics`; automatically pauses via `visibilitychange` + `AbortController` when the pane is hidden.
- **Granular DOM Updates**: Cached DOM references, targeted context-card redraw when switching window benchmarks, signature-gated SVG/table redraws, and `mtimeMs`-validated static asset caching.

## Installation

Requires **Antigravity 2.0 Desktop** and **Node.js 18+**. Clone this repository into your global Antigravity plugins directory (`~/.gemini/config/plugins/session-monitor`):

### macOS / Linux

```bash
git clone https://github.com/bartholo4/antigravity-session-monitor.git ~/.gemini/config/plugins/session-monitor
```

### Windows (PowerShell)

```powershell
git clone https://github.com/bartholo4/antigravity-session-monitor.git "$HOME\.gemini\config\plugins\session-monitor"
```

After cloning:

1. Open **Plugins / Customizations** in Antigravity Desktop and verify `session-monitor` is enabled (restart Antigravity or toggle the plugin off/on if the sidecar has not started yet).
2. Open the **状态监控** view in the right-hand Auxiliary Pane.

## Data Source & Privacy

- Strictly read-only access to `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` (resolved from `ANTIGRAVITY_EXECUTABLE_DATA_DIR`, falling back to `~/.gemini/antigravity/brain`).
- Never modifies conversation logs or Antigravity config files, and makes zero external network calls.

## Repository Layout

```text
.
├── plugin.json                        # Antigravity global plugin manifest
├── assets/logo.svg                    # Plugin icon
├── sidecars/monitor_pane/
│   ├── sidecar.json                   # Sidecar entrypoint & Aux Pane view config
│   ├── package.json                   # ESM package descriptor
│   ├── main.mjs                       # Node backend (incremental parser, long-poll, static cache)
│   ├── index.html                     # Telemetry panel markup
│   ├── app.js                         # Frontend controller & partial renderer
│   └── styles.css                     # Responsive host-theme-aware styles
└── tests/monitor.test.mjs             # Offline end-to-end test suite (node --test)
```

## Notes & Troubleshooting

- **Windows non-ASCII user directory startup retry**: `sidecar.json` defaults to `"command": "node"`. On Windows machines with non-ASCII user profile paths, the host wrapper may occasionally fail on the first launch and auto-recover within 1–2 seconds via `"restart_policy": "always"`. To eliminate the initial retry log locally, point `"command"` to an ASCII-path `node.exe`.
- **Hot Reload**: Edits to `index.html`, `styles.css`, or `app.js` take effect upon closing and reopening the pane; edits to `main.mjs` require toggling the plugin in Plugins Manager or restarting Antigravity.

## Testing

Run the built-in Node test suite (no external dependencies required):

```bash
node --test tests/monitor.test.mjs
```

## License

[MIT](LICENSE)
