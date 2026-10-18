# pi-utils

Small extensions for everyday pi sessions.

| Extension | Surface | Context cost | What it does |
|---|---|---|---|
| [`keepctx`](extensions/keepctx.ts) | `/keepctx` | 0 | Compact the conversation while keeping background, state, facts, goals and this pane's role |
| [`tools`](extensions/tools.ts) | `/tools` | 0 | Show which tools are declared to the model (`✓`) and which are registered but inactive (`·`) |
| [`copy-code`](copy-code/README.md) | `/copy-code`, `alt+c` | 0 | Copy the raw source of an earlier code block, without TUI re-wrapping |
| [`deepseek-search`](extensions/deepseek-search.ts) | `web_search` | tool schema | Web search through the DeepSeek Search API |

## Install

```bash
pi install git:github.com/HYPERVAPOR/pi-utils
```

To load only one of them, narrow the package in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/HYPERVAPOR/pi-utils",
      "extensions": ["extensions/copy-code.ts"]
    }
  ]
}
```

Or point `-e` at a file after the clone lands at
`~/.pi/agent/git/github.com/HYPERVAPOR/pi-utils`:

```bash
pi -e ~/.pi/agent/git/github.com/HYPERVAPOR/pi-utils/extensions/copy-code.ts
```

## Details

### keepctx

Compacts the conversation with a fixed brevity instruction: keep background,
current state, facts, goals and this pane's role; drop the reasoning in
between. Keeps long sessions from drifting.

### tools

pi has no built-in `/tools`. This lists every registered tool, marks the ones
actually declared to the model, and shows each tool's source. Useful when a
tool you expected is missing.

### copy-code

The TUI wraps rendered lines to the pane width, so mouse-selection gives you
re-wrapped text with broken indentation. This copies the raw source instead.
Blocks get stable, increasing IDs; `/copy-code` opens a fuzzy picker (a plain
number matches an ID exactly).

### deepseek-search

A single `web_search` tool backed by the DeepSeek Search API, auth from pi's
credential store. It replaces multi-tool web packages that keep several schemas
resident. Set a key with `/login deepseek`.

## Test

```bash
node copy-code/test/fences.test.ts
node copy-code/test/candidates.test.ts
node copy-code/test/run.test.ts
node copy-code/test/gutter.test.ts
```

## License

MIT
