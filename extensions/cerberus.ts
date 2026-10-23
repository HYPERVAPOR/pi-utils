/**
 * cerberus - capture every bash command, or stay out of the way.
 *
 * Two modes, per session: picked with `/cerberus on|off` (or `cerberus mode ...`,
 * `--default` for the machine) and stored in `$XDG_STATE_HOME/cerberus/config.json`,
 * read once per tool call. A TUI session shows its own in a widget beside the editor
 * (`widget.ts`), which a double click toggles.
 *
 * `capture` (on) - cerberus replaces pi's `bash` tool with the same definition built on
 *   its own operations (`cerberus/capture.ts`). Every command runs under the task
 *   supervisor; whatever finishes inside the budget comes back byte-identically, and a
 *   command that outlives it keeps running while the model gets one line to act on.
 *
 * `disabled` (off, the default) - cerberus does nothing at all: no capture, no rules,
 *   no questions, no tasks. The bash tool is pi's own.
 *
 * The third mode, `gate`, is retired: `GATE_ENABLED` below turns the whole of it back
 * on (the question flow, the prompt section, its tests). While it is off, `off` means
 * inert - a retired gate must never start asking or capturing on its own. The gate code
 * is all still here:
 *
 *     BIN fg <id>  runs the saved command in the foreground (streamed, exit code)
 *     BIN bg <id>  runs it in the background, output in a log
 *
 * A `timeout` on the bash call is not an exemption: it only bounds the foreground
 * run that pi does after a pass-through. The gate preserves it untouched.
 *
 * The command bytes are saved under tasks/<owner>/<hash>-<cwd>-<n>/cmd.sh, so `fg`
 * or `bg` can run exactly what was asked, from the same cwd, exactly once. Answering
 * by resending the identical command is still accepted as `fg`.
 */
import { spawn } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  allocateTask,
  claimTask,
  cmdHash,
  findStaged,
  readDecision,
  modeSource,
  readMode,
  writeDecision,
  writeMeta,
  writeMode,
  type Mode,
  type Task,
  type TaskMeta,
} from "../cerberus/paths.ts";
import { createOperations, runningNotice, SlowTask } from "../cerberus/capture.ts";
import { loadPi, loadTui } from "../cerberus/pi-package.ts";
import { isBackgrounded, needsLongRun, SHELL_KEYWORDS } from "../cerberus/rules.ts";
import { backgroundBanner, startBackground } from "../cerberus/runner.ts";
import {
  createIndicator,
  cycleMode,
  WIDGET_KEY,
  type Component,
  type MouseRegionCtor,
  type Theme,
  type Tui,
} from "./cerberus/widget.ts";
import { joinStatusRow, leaveStatusRow } from "./status-row.ts";

/**
 * The gate is retired for now: `on` captures, `off` does nothing, and no configuration
 * can reach the "ask before long commands" flow. Flip this to true to bring back the
 * whole of it - `tool_call` (rules, staging, the question), the prompt section, and the
 * gate's tests, which are skipped while it is false (`hook`, `e2e`, and the `/cerberus`
 * switch cases that expect a question). Nothing was deleted: `rules.ts`, `question()`,
 * the decision memory and `cerberus fg|bg` all still sit behind this one constant.
 */
export const GATE_ENABLED = false;

/** This package's own CLI, whatever directory the package happens to live in. */
const LOCAL_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cerberus");

/**
 * The name to print in the prompt and the tool result.
 *
 * A bare `cerberus` keeps every hint short; an absolute path costs ~66 characters per
 * mention, nine times in the prompt alone. PATH is only trusted when it resolves to
 * this very file: a second install (dev checkout next to the package) must never be
 * driven by the extension that is actually loaded. Create the shim with
 * `cerberus shim`; without one this falls back to the absolute path.
 */
function resolveBin(): string {
  const name = "cerberus";
  const path = process.env.PATH;
  if (!path) return LOCAL_BIN;
  let self: string;
  try {
    self = realpathSync(LOCAL_BIN);
  } catch {
    return LOCAL_BIN;
  }
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      if (realpathSync(join(dir, name)) === self) return name;
    } catch {
      // not in this directory
    }
  }
  return LOCAL_BIN;
}

/** Resolved CLI for this process; exported so tests assert the same text pi shows. */
export const BIN = resolveBin();
/** Only a path needs quoting; a bare `cerberus` would only gain noise. */
export const SHOWN_BIN = BIN === "cerberus" ? BIN : shellQuote(BIN);

const GUIDELINE =
  `A bash command intercepted by cerberus has not run yet: answer with \`${SHOWN_BIN} fg <id>\` to wait for it or \`${SHOWN_BIN} bg <id>\` to run it in the background.`;

/** Static on purpose: any per-run content would invalidate the prompt cache. */
const PROMPT = [
  "Some bash commands are intercepted before they run because they look long-running. Nothing has executed when that happens.",
  "",
  `- Wait for the result: run \`${SHOWN_BIN} fg <id>\`.`,
  `- Run it in the background: run \`${SHOWN_BIN} bg <id>\`.`,
  "- Resending the identical command is also accepted as `fg`.",
  `- Check a background task with \`${SHOWN_BIN} log <id>\` (output) and \`${SHOWN_BIN} rc <id>\` (exit code, or \`running\`).`,
  `- \`${SHOWN_BIN} wait <id>\` blocks up to 60s; \`${SHOWN_BIN} ls\` lists tasks (\`--full\` reprints the whole command); \`${SHOWN_BIN} stop <id>\` stops one.`,
  "- For `log`, `rc` or `wait`, omit `<id>` to use the most recent task; the chosen id is echoed on stderr.",
  "- A `timeout` on the bash call does not skip this choice; it only bounds the foreground run.",
  `- Background tasks have no deadline unless you pass \`${SHOWN_BIN} bg <id> --timeout N\`; otherwise stop one with \`${SHOWN_BIN} stop <id>\`.`,
  "- A result beginning with `cerberus: background` is a successful background start, not an error.",
].join("\n");

/** POSIX single-quote escaping: ' -> '\'' */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const SPACE = /[ \t\r]/;
const OPERATOR = /[;|&()]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** End of one shell word, honouring quotes, escapes and unquoted operators. */
function tokenEnd(command: string, start: number): number {
  let quote: "'" | '"' | undefined;
  let i = start;
  while (i < command.length) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) i++;
      i++;
      continue;
    }
    if (char === "\\") {
      i += i + 1 < command.length ? 2 : 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      i++;
      continue;
    }
    if (SPACE.test(char) || OPERATOR.test(char)) break;
    i++;
  }
  return i;
}

/**
 * The bare name `cerberus` is not on PATH (packages are not linked into pi's
 * bin), so a model copying the prompt verbatim needs the absolute path. This
 * expands the command word of every simple command (after `&&`, `||`, `;`, `|`,
 * `&`, parentheses or a newline), leaving arguments and every other byte alone.
 */
function expandCerberusPrefix(command: string): string | undefined {
  let found = false;
  let expectCommand = true;
  let cursor = 0;
  let output = "";
  let i = 0;

  while (i < command.length) {
    const char = command[i];
    if (char === "\n") {
      expectCommand = true;
      i++;
      continue;
    }
    if (SPACE.test(char)) {
      i++;
      continue;
    }
    if (OPERATOR.test(char)) {
      expectCommand = true;
      i++;
      continue;
    }
    if (char === "#") {
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }

    const end = tokenEnd(command, i);
    const word = command.slice(i, end);
    if (expectCommand && (SHELL_KEYWORDS.has(word) || ASSIGNMENT.test(word))) {
      // Shell syntax before the command word, e.g. `then` or `FOO=1`.
      i = end;
      continue;
    }
    if (expectCommand) {
      if (word === "cerberus" || word === BIN) {
        output += command.slice(cursor, i) + SHOWN_BIN;
        cursor = end;
        found = true;
      } else if (word === SHOWN_BIN) {
        found = true; // already runnable, but still a cerberus command
      }
      expectCommand = false;
    }
    i = end;
  }

  if (!found) return undefined;
  return output === "" ? command : output + command.slice(cursor);
}

interface Staged {
  id: string;
  dir: string;
  meta: TaskMeta;
}

/** Save the command bytes and the metadata the CLI needs to run them later. */
function stage(owner: string, cwd: string, command: string, asked: number): Staged {
  const hash = cmdHash(command);
  const { id, dir } = allocateTask(owner, hash, cwd);
  writeFileSync(join(dir, "cmd.sh"), command);
  const meta: TaskMeta = {
    state: "staged",
    asked,
    owner,
    cwd,
    cmdHash: hash,
    startedAt: Date.now(),
  };
  writeMeta(dir, meta);
  return { id, dir, meta };
}

/** Start a task the session already chose to background, without asking again. */
function startStaged(staged: Staged): { id: string; log: string; rc: string } | undefined {
  const task: Task = { owner: staged.meta.owner, id: staged.id, dir: staged.dir, meta: staged.meta };
  if (!claimTask(task)) return undefined;
  return { id: staged.id, ...startBackground(task) };
}

/**
 * The indicator's state: what this session's mode is, the widget that draws it, and
 * the timer that re-reads it.
 *
 * `shownMode` is what the widget renders. It is refreshed on the timer and after
 * `/cerberus`, never inside `render()`: the state root is not read once per frame.
 */
let shownMode: Mode = "disabled";
let shownOwner: string | undefined;
let shownTui: Tui | undefined;
let indicatorTimer: ReturnType<typeof setInterval> | undefined;
/** true when the indicator is a part of the shared status row rather than its own line */
let indicatorShared = false;

/** Re-read this session's mode and repaint. Cheap, and safe to call when nothing is shown. */
function refreshIndicator(): void {
  if (!shownOwner) return;
  shownMode = readMode(shownOwner);
  shownTui?.requestRender();
}

/** Stop drawing and reading. Idempotent: shutdown, reload and a second start may all call it. */
function stopIndicator(ui?: ExtensionContext["ui"]): void {
  if (indicatorTimer !== undefined) {
    clearInterval(indicatorTimer);
    indicatorTimer = undefined;
  }
  // Only the path that put the widget there takes it away again.
  if (ui) {
    if (indicatorShared) leaveStatusRow(ui, INDICATOR_ID);
    else ui.setWidget(WIDGET_KEY, undefined);
  }
  indicatorShared = false;
  shownTui = undefined;
  shownOwner = undefined;
}

/** How often the indicator re-reads the mode: fast enough to follow another pane. */
const INDICATOR_MS = 2000;
/** The indicator's id inside the shared status row. */
const INDICATOR_ID = "cerberus";

/** Words the switch accepts. `capture`/`disabled` stay as aliases for old fingers. */
const MODE_WORDS: Record<string, Mode> = {
  on: "capture",
  off: "disabled",
  capture: "capture",
  disabled: "disabled",
};

/** What `gate` and friends get instead of a mode change. */
const RETIRED = "gate is retired (use on or off)";

/** `on`/`off` for a mode: the words the rest of the switch speaks. */
function modeWord(mode: Mode): string {
  return mode === "capture" ? "on" : "off";
}

/** Where the effective mode came from, in the words a user can act on. */
function modeStatus(owner: string | undefined): string {
  const source = modeSource(owner);
  const mode = readMode(owner);
  return `cerberus: mode ${modeWord(mode)} (${source}${source === "session" && owner ? ` ${owner}` : ""})`;
}

function question(id: string): string {
  return [
    "cerberus: this may block for a long time. Nothing has run yet. Answer by running exactly one:",
    `  ${SHOWN_BIN} fg ${id}   -> I must wait: run it in the foreground and return the output`,
    `  ${SHOWN_BIN} bg ${id}   -> I do not need it now: run it in the background, I will check later`,
    `  (background has no deadline; stop it with ${SHOWN_BIN} stop ${id})`,
    "Do not answer in prose.",
  ].join("\n");
}

/**
 * pi's own bash tool definition with cerberus operations behind it.
 *
 * Same factory as the built-in, so name, schema, description, prompt snippet,
 * truncation and result formatting are the built-in's; only `exec` differs. It is
 * registered under `bash`, and extension tools are applied after built-ins, so this
 * one replaces the built-in in the registry (there is still exactly one `bash`).
 */
async function registerBash(pi: ExtensionAPI): Promise<void> {
  const piPackage = await loadPi();
  const definition = piPackage.createBashToolDefinition(process.cwd(), {
    operations: createOperations(piPackage.createLocalBashOperations()),
  });
  const run = definition.execute.bind(definition);

  pi.registerTool({
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        return await run(toolCallId, params, signal, onUpdate, ctx);
      } catch (err) {
        // The command outlived the budget: it keeps running and the model gets one
        // line it can act on instead of output that does not exist yet.
        if (err instanceof SlowTask) {
          return {
            content: [{ type: "text" as const, text: runningNotice(err.id, SHOWN_BIN) }],
            details: undefined,
            isError: false,
          };
        }
        throw err;
      }
    },
  });
}

/**
 * `/cerberus on|off|disabled|status|default <mode>`.
 *
 * The switch is per session: `on`/`off`/`disabled` change the session the command was
 * typed in, `default <mode>` changes what every other session gets.
 */
function registerModeCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cerberus", {
    description: "cerberus mode: on (capture every bash call) | off (nothing) | status | default <on|off>",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off", "status", "default"]
        .filter((word) => word.startsWith(prefix))
        .map((word) => ({ value: word, label: word })),
    handler: async (args, ctx) => {
      const owner = ctx.sessionManager.getSessionId() || undefined;
      const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const word = words[0] ?? "status";
      // Every answer repaints the indicator: the mode may have just changed, and
      // `status` is exactly when a stale indicator would be misleading.
      try {
        runModeCommand(word, words, owner, ctx);
      } finally {
        refreshIndicator();
      }
    },
  });
}

/** The switch itself, split out so the indicator refresh cannot be forgotten. */
function runModeCommand(word: string, words: string[], owner: string | undefined, ctx: ExtensionContext): void {
  if (word === "status") {
    ctx.ui.notify(modeStatus(owner), "info");
    return;
  }
  if (word === "gate") {
    ctx.ui.notify(`cerberus: ${RETIRED}`, "warning");
    return;
  }
  if (word === "default") {
    const word = words[1] ?? "";
    if (word === "gate") {
      ctx.ui.notify(`cerberus: ${RETIRED}`, "warning");
      return;
    }
    const global = MODE_WORDS[word];
    if (!global) {
      ctx.ui.notify(`cerberus: default: unknown argument "${word}" (use on or off)`, "warning");
      return;
    }
    writeMode(global);
    ctx.ui.notify(`cerberus: default mode ${modeWord(global)}`, "info");
    return;
  }
  const mode = MODE_WORDS[word];
  if (!mode) {
    ctx.ui.notify(`cerberus: unknown argument "${word}" (use on, off, status or default)`, "warning");
    return;
  }
  // No session id (a one-shot run) leaves only the default to set.
  writeMode(mode, owner);
  ctx.ui.notify(
    owner ? `cerberus: mode ${modeWord(mode)} (session ${owner})` : `cerberus: default mode ${modeWord(mode)}`,
    "info",
  );
}

export default async function (pi: ExtensionAPI) {
  // Without pi's own package there is no capture tool; that must not take the gate
  // down with it, so the shadowed `bash` is best-effort and everything else loads.
  try {
    await registerBash(pi);
  } catch {
    // pi keeps its built-in bash; the gate below still works
  }
  registerModeCommand(pi);

  // The mode indicator: a widget beside the editor, this session's mode, double-click
  // to cycle. No UI (print/json/rpc-less runs) means no widget and no timer.
  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    stopIndicator();
    if (!ctx.hasUI) return;
    const owner = ctx.sessionManager.getSessionId() || undefined;
    if (!owner) return;
    let MouseRegion: MouseRegionCtor | undefined;
    try {
      MouseRegion = (await loadTui()).MouseRegion;
    } catch {
      // No TUI package to be found: the indicator still shows the mode, it just
      // cannot take clicks, and session start must not fail over a widget.
    }
    shownOwner = owner;
    shownMode = readMode(owner);
    const part = (tui: Tui, theme: Theme): Component => {
      shownTui = tui;
      return createIndicator({
        mode: () => shownMode,
        cycle: () => {
          const next = cycleMode(shownMode);
          writeMode(next, owner);
          refreshIndicator();
          ctx.ui.notify(`cerberus: mode ${modeWord(next)} (session ${owner})`, "info");
        },
        notify: (message, level) => ctx.ui.notify(message, level),
        MouseRegion,
      })(tui, theme);
    };
    // Share one line with the other plugins if this pi-tui can (`status-row.ts`), and
    // take a line of its own if it cannot - the indicator must never be the reason a
    // session fails to start.
    try {
      joinStatusRow(ctx.ui, INDICATOR_ID, part);
      indicatorShared = true;
    } catch {
      ctx.ui.setWidget(WIDGET_KEY, part);
    }
    // The state file is the truth and anything can write it (another pane, the CLI),
    // so poll it instead of trusting a cached value, but not on every render.
    indicatorTimer ??= setInterval(refreshIndicator, INDICATOR_MS);
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    // Retired: no rules, no staging, no questions, in any mode.
    if (!GATE_ENABLED) return;
    if (event.toolName !== "bash") return;
    // Only `off` asks anything: `on` (capture) owns every bash call inside the tool
    // itself. While the gate is enabled, `off` means the old gate; while it is retired
    // this line is unreachable (the return above already fired).
    if (readMode(ctx.sessionManager.getSessionId() || undefined) !== "disabled") return;
    const original = event.input.command;
    if (typeof original !== "string" || original.length === 0) return;

    // 1. An explicit CLI call is only made runnable; it is never gated.
    const expanded = expandCerberusPrefix(original);
    if (expanded !== undefined) {
      event.input.command = expanded;
      return;
    }

    // 2. Already backgrounded by the command itself: no deadline to negotiate.
    if (isBackgrounded(original)) return;

    // 3. Conservative rules: no match means byte-for-byte pass-through. A
    // positive `timeout` is deliberately NOT an exemption; it only bounds pi's
    // foreground execution after we let the call through.
    if (!needsLongRun(original)) return;

    try {
      const owner = ctx.sessionManager.getSessionId();
      if (!owner) return;
      const cwd = ctx.cwd || process.cwd();
      const hash = cmdHash(original);
      const decision = readDecision(owner, cwd, hash);

      if (decision === "fg") return;

      if (decision === "bg") {
        // The session already answered "do not wait": start it here and tell the
        // model it is running. Blocking keeps the original command from running too.
        const started = startStaged(stage(owner, cwd, original, 0));
        if (started) return { block: true, reason: backgroundBanner(started.id, started.log) };
        return;
      }

      const staged = findStaged(owner, cwd, hash);
      if (staged) {
        // This command was blocked twice already: let it through instead of asking
        // forever when a model keeps changing one character.
        if ((staged.meta?.asked ?? 0) >= 2) return;
        // Resending the identical command is the tolerated "fg" answer. Consume the
        // staged task so a later `fg`/`bg <id>` cannot execute it a second time.
        if (staged.meta) writeMeta(staged.dir, { ...staged.meta, state: "consumed", asked: 0 });
        try {
          writeDecision(owner, cwd, hash, "fg");
        } catch {
          // best-effort memory
        }
        return;
      }

      const created = stage(owner, cwd, original, 1);
      // No `terminate: true`: the model must get a chance to answer.
      return { block: true, reason: question(created.id) };
    } catch {
      // A throwing tool_call handler blocks the tool, so fail open instead.
      event.input.command = original;
      return;
    }
  });

  pi.on("before_agent_start", async (event, _ctx: ExtensionContext) => {
    // The section describes the gate's question; without the gate there is nothing to
    // describe (capture's one-line notices explain `cerberus wait` themselves).
    if (!GATE_ENABLED) return;
    try {
      const options = event.systemPromptOptions;
      if (!options.sections) options.sections = {};
      options.sections.cerberus = PROMPT;
      if (!options.promptGuidelines.includes(GUIDELINE)) options.promptGuidelines.push(GUIDELINE);
    } catch {
      // prompt decoration must never break a run
    }
  });

  pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
    // The widget and its timer go on every path (reload included: the session that
    // loads next registers its own).
    stopIndicator(ctx.hasUI ? ctx.ui : undefined);
    // reload keeps the process: tasks belong to the session that is still loading.
    if (event.reason === "reload") return;
    // In print/json mode the process is about to end and nobody will come back for
    // a task's output, so reaping only destroys work that would otherwise finish.
    // A leftover task at least stays visible through `ls` / `reap --all-stale`.
    if (ctx.mode === "print" || ctx.mode === "json") return;
    try {
      const owner = ctx.sessionManager.getSessionId();
      if (!owner) return;
      // Detached: reaping several tasks can outlast pi's shutdown. The child lives
      // in its own group and runs to completion.
      spawn(BIN, ["reap", "--owner", owner, "--quiet"], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // shutdown cleanup is best-effort
    }
  });
}
