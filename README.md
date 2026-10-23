# pi-utils

Small extensions for everyday pi sessions.

| Extension | Surface | Context cost | What it does |
|---|---|---|---|
| [`keepctx`](extensions/keepctx.ts) | `/keepctx` | 0 | Compact the conversation while keeping background, state, facts, goals and this pane's role |
| [`tools`](extensions/tools.ts) | `/tools` | 0 | Show which tools are declared to the model (`✓`) and which are registered but inactive (`·`) |
| [`copy-code`](copy-code/README.md) | `/copy-code`, `alt+c` | 0 | Copy the raw source of an earlier code block, without TUI re-wrapping |
| [`deepseek-search`](extensions/deepseek-search.ts) | `web_search` | tool schema | Web search through the DeepSeek Search API |
| [`cerberus`](extensions/cerberus.ts) | `bash`, `cerberus` | prompt section | Two ways to keep a long `bash` call from blocking the turn: ask first (gate), or run it and hand back a task handle after 10s (capture) |

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

### cerberus

Hints print a bare `cerberus` when a shim is on PATH, and the absolute path of the
package otherwise: an install path costs ~66 characters per mention and appears nine
times in the prompt alone. `pi install` runs `npm install` in the clone, so the
`postinstall` script links the CLI automatically (first writable directory on PATH of
`$PI_BIN_DIR`, `~/.pi/agent/bin`, `~/.local/bin`); otherwise run `cerberus shim`
yourself (`--dir <dir>`, `--remove`, `--quiet`). A `cerberus` on PATH is trusted only
when it resolves to the very file the extension was loaded from, so a dev checkout
and the installed package never drive each other.

The shim is created on install, not on `pi update`: updating only fetches the clone,
it runs no scripts. `-e` users (a checkout or a profile) never install, so they need
`cerberus shim` once.

Two modes, switched at runtime with `/cerberus on|off|status` or `cerberus mode
on|off|status` and stored in `$XDG_STATE_HOME/cerberus/config.json` (read once per tool
call, so a flip needs no restart). The default is `gate`.

**`capture` (`/cerberus on`)** replaces the built-in `bash` tool with the same
definition - pi's own `createBashToolDefinition`, so schema, description, truncation
and result formatting are the built-in's - and runs every command through the task
machinery. A command that finishes within the budget comes back exactly as the
built-in would have returned it, byte for byte, and leaves no task behind (the id was
never shown to anyone). A command that outlives the budget keeps running as a normal
task and the tool result is one line:
`cerberus: still running id=<id> (cerberus wait <id>)`. The budget is 10s, or
`CERBERUS_CAPTURE_BUDGET_MS`. `cerberus wait <id>` then prints what pi would have
returned - the same truncation (last 2000 lines / 50KB), the same notice, and the
task's `out.log` where pi's temp file would be. Cancelling the call stops the task.
In this mode the gate below is a no-op: no rules, no questions.

A `timeout` on the bash call is the *task's* deadline in capture mode, not this
call's - the tool always gives up after the budget. If the deadline is shorter than
the budget, the task is killed at the deadline and the result is pi's usual
`Command timed out after N seconds` (rc 124). If the deadline is at or past the
budget, the model gets `still running` first; the supervisor kills the task when the
deadline comes, so `cerberus wait`/`rc` report rc 124 later.

**`gate` (`/cerberus off`, the default)**: a gate in front of `bash`. Ordinary
commands pass through byte-for-byte, and a
small conservative rule table (package builds/tests, `sleep` >= 15s, `tail -f`,
`docker build`, `git push`, ...) catches only commands that look likely to block.
It looks through wrappers and runners (`timeout`, `sudo`, `env`, `bash -c`,
`uv run`, `poetry run`) at the command that actually decides, recognises
`python -m pytest`, `gh run watch`, `pnpm --filter <pkg> build` and
`herdr agent wait`, and keeps the command that follows a `$(...)` substitution.
When one is caught, nothing runs: the command bytes are saved and the tool result
asks one question with two short answers.

`cerberus` never gates itself: a command whose command word is the gate's own CLI is
never matched by the rule table and never staged (a staged `cerberus fg ...` is
refused rather than run, so the protocol cannot nest). Every control answer - `bg`,
`ls`, `log`, `rc`, `stop`, `reap`, `shim` - returns as soon as the state is read or
the child is spawned; only `fg` waits for the staged command, and `wait` is capped
at 60s by default (300s max).

- `cerberus fg <id>` - run it now in the foreground, streaming output and passing
  the exit code through. This is the "yes".
- `cerberus bg <id>` - run it in the background, output in the task log. This is
  the "no".

A `timeout` given to bash is a budget for the foreground run, not an exemption
from the question: a long command with `timeout: 600` is still caught. When the
gate lets the call through, the value is kept unchanged. The shell's `timeout`
wrapper is unwrapped the same way, so `timeout 600 npm run build` is still
caught. `nohup`/`setsid` without `&` also still block the foreground shell and
are gated; `setsid --fork` is the exception. A background task has no deadline by
default; pass `cerberus bg <id> --timeout N` to set one, or use
`cerberus stop <id>`.

Resending the identical command is also accepted as "yes". The session remembers
the answer for each `(cwd, command)`, so the same command is not asked again; a
remembered "bg" makes the gate start the task itself and reply with its handle.
`cerberus reap --decisions` clears that memory. A task can run only once: after
`fg`, `bg`, or a resend, the old id is consumed and further `fg`/`bg` calls are
rejected.

Background progress: `cerberus log [<id>]` (output), `cerberus rc [<id>]` (exit
code, or `running` while empty), `cerberus wait [<id>]` (wait up to 60s without
killing the task; once it finished, pi's formatted result rather than a log tail),
`cerberus ls` (tasks; `--full` reprints the whole staged
command, since the plain listing shows only its capped first line, and `--json`
carries `cmd` verbatim plus `summary` for display), `cerberus stop <id>`. When `log`, `rc`
or `wait` omit the id, they use this session's most recent task and echo the id
they picked on stderr (`cerberus: id=... (most recent)`), so the payload on
stdout stays clean. A result starting with
`cerberus: background` means the task started successfully (its single line also
carries the log path, with `$HOME` shortened to `~`). Tasks are reaped
when the TUI session shuts down; in `pi -p` / `--json` mode nothing is reaped,
because the process is ending and no one would read the output. Those tasks run
to completion and can be inspected with `cerberus ls` or cleaned later with
`cerberus reap --all-stale`.

## Test

```bash
node copy-code/test/fences.test.ts
node copy-code/test/candidates.test.ts
node copy-code/test/run.test.ts
node copy-code/test/gutter.test.ts
node cerberus/test/paths.test.ts
node cerberus/test/rules.test.ts
node cerberus/test/cli.test.ts
node cerberus/test/e2e.test.ts
node cerberus/test/capture.test.ts
node extensions/cerberus/test/hook.test.ts
```

## License

MIT
