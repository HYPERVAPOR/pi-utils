/**
 * Self-check for extensions/cerberus.ts: prompt text and session shutdown without
 * starting pi. A fake `pi` collects the handlers; the test calls them directly.
 *
 *   node extensions/cerberus/test/hook.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = mkdtempSync(join(tmpdir(), "cerberus-hook-state-"));
const work = mkdtempSync(join(tmpdir(), "cerberus-hook-work-"));
process.env.XDG_STATE_HOME = state;
delete process.env.PI_SESSION_ID;
// When the suite itself runs under capture, its cleanup must still reach the CLI.
delete process.env.CERBERUS_TASK_ID;

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cerberus");

type Handler = (event: any, ctx: any) => unknown;
const handlers: Record<string, Handler> = {};
const tools: any[] = [];
const commands: Record<string, any> = {};
const fakePi = {
  on: (name: string, handler: Handler) => {
    handlers[name] = handler;
    return () => {};
  },
  registerTool: (tool: any) => tools.push(tool),
  registerCommand: (name: string, options: any) => {
    commands[name] = options;
  },
};
const extension = await import("../../cerberus.ts");
// What the prompt/tool result actually prints: a bare `cerberus` when the shim on
// PATH points back at this file, an absolute (quoted) path otherwise.
const SHOWN: string = extension.SHOWN_BIN;
// The gate is retired: `GATE_ENABLED` in the extension is false, so nothing can reach
// the question flow. Its cases are skipped *visibly* rather than deleted - flip that
// constant to true and they run again.
const GATE_ON: boolean = extension.GATE_ENABLED;
let skipped = 0;
const skip = (name: string) => {
  skipped++;
  console.log(`SKIP  ${name} (gate is retired: GATE_ENABLED = false)`);
};
await (extension.default as (pi: unknown) => Promise<void>)(fakePi);

assert.equal(typeof handlers.tool_call, "function");
assert.equal(typeof handlers.before_agent_start, "function");
assert.equal(typeof handlers.session_shutdown, "function");

// --- the bash tool is shadowed, once, with the built-in's own definition ---
{
  assert.equal(tools.length, 1, "exactly one tool is registered");
  const bash = tools[0];
  assert.equal(bash.name, "bash", "registered under the built-in name");
  assert.equal(bash.label, "bash");
  assert.equal(typeof bash.execute, "function");
  assert.equal(typeof bash.renderResult, "function");
  assert.deepEqual(Object.keys(bash.parameters.properties), ["command", "timeout"]);
  assert.ok(commands.cerberus, "the /cerberus switch exists");
  assert.equal(typeof commands.cerberus.handler, "function");
  assert.deepEqual(
    await commands.cerberus.getArgumentCompletions(""),
    [
      { value: "on", label: "on" },
      { value: "off", label: "off" },
      { value: "status", label: "status" },
      { value: "default", label: "default" },
    ],
  );
}

const { allocateTask, claimTask, cmdHash, listOwner, readConfig, readMode, writeMeta, writeMode } =
  await import("../../../cerberus/paths.ts");
const { startBackground } = await import("../../../cerberus/runner.ts");

const context = (owner: string, mode = "tui") => ({
  mode,
  cwd: work,
  sessionManager: { getSessionId: () => owner },
});

const created: Array<{ owner: string; id: string }> = [];

function startTask(owner: string) {
  const script = "sleep 30\n";
  const task = allocateTask(owner, cmdHash(script), work);
  writeFileSync(join(task.dir, "cmd.sh"), script);
  const meta = {
    state: "staged" as const,
    asked: 1,
    owner,
    cwd: work,
    cmdHash: cmdHash(script),
    startedAt: Date.now(),
  };
  writeMeta(task.dir, meta);
  assert.equal(claimTask({ owner, id: task.id, dir: task.dir, meta }), true);
  const started = startBackground({ owner, id: task.id, dir: task.dir, meta });
  created.push({ owner, id: task.id });
  return { owner, id: task.id, rc: join(task.dir, "rc"), pid: started.pid };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const reapers = (owner: string) =>
  execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes("reap") && line.includes(owner)).length;

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
  }
  return predicate();
}

try {
  // --- tool_call: the gate's own CLI is never gated ------------------------
  if (!GATE_ON) skip("tool_call: the gate's own CLI is never gated");
  else {
    const call = async (owner: string, command: string) => {
      const event: any = { type: "tool_call", toolName: "bash", input: { command } };
      const result = await handlers.tool_call(event, context(owner));
      return { event, result };
    };

    // Sanity: a long command is caught, so the assertions below mean something.
    const caught = await call("hook-gate", "sleep 900");
    assert.equal(caught.result?.block, true);

    // Every way of answering a gate passes straight through: no block, no stage.
    const cerberusCalls = [
      `cerberus fg ${caught.result ? "some-id" : "some-id"}`,
      `cerberus bg some-id`,
      `cerberus wait some-id --for 1`,
      `cerberus log`,
      `cerberus rc`,
      `cerberus ls`,
      `cerberus stop some-id`,
      `cerberus reap --decisions`,
      `${BIN} fg some-id`,
      `cd /tmp && cerberus ls`,
      `timeout 30 cerberus fg some-id`,
      `cerberus bg 'sleep 900'`,
    ];
    for (const command of cerberusCalls) {
      const { event, result } = await call("hook-gate", command);
      assert.equal(result, undefined, `must not gate: ${command}`);
      // Rewritten to the runnable path, never staged.
      assert.match(event.input.command, /cerberus/, command);
      assert.equal(event.input.command.includes("<<"), false, command);
    }

    // Only the genuine long command was staged; no control call was.
    const { listOwner } = await import("../../../cerberus/paths.ts");
    const staged = listOwner("hook-gate").map((task) => readFileSync(join(task.dir, "cmd.sh"), "utf8"));
    assert.deepEqual(staged, ["sleep 900"]);
  }

  // --- before_agent_start: static section + guideline ---------------------
  // The section describes the gate's question, so it is only added while the gate is
  // on; the case for it is skipped with the gate's other cases.
  if (!GATE_ON) skip("before_agent_start: static section + guideline");
  else {
    const options = () => ({
      selectedTools: [],
      hiddenTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [] as string[],
      appendSystemPrompt: "",
      sections: {} as Record<string, string>,
      contextFiles: [],
      skills: [],
      cwd: work,
    });
    const first: any = { type: "before_agent_start", messageType: "user", prompt: "hi", systemPromptOptions: options() };
    await handlers.before_agent_start(first, context("hook-prompt"));
    const prompt: string = first.systemPromptOptions.sections.cerberus;
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes(`${SHOWN} fg <id>`), prompt);
    assert.ok(prompt.includes(`${SHOWN} bg <id>`), prompt);
    assert.ok(prompt.includes("bg <id>"), prompt);
    assert.ok(prompt.includes(`${SHOWN} log <id>`), prompt);
    assert.ok(prompt.includes(`${SHOWN} rc <id>`), prompt);
    assert.ok(prompt.includes(`${SHOWN} wait <id>`), prompt);
    assert.ok(prompt.includes(`${SHOWN} ls`), prompt);
    assert.ok(prompt.includes(`${SHOWN} stop <id>`), prompt);
    assert.ok(prompt.includes("omit `<id>` to use the most recent task"), prompt);
    assert.match(prompt, /resending the identical command is also accepted as `fg`/i);
    assert.match(prompt, /cerberus: background/);
    assert.match(prompt, /timeout.*does not skip/i);
    assert.match(prompt, /no deadline/i);
    // No stale wording from the bounded-wait design.
    assert.equal(/15\s*s/i.test(prompt), false, prompt);
    assert.equal(/detached/i.test(prompt), false, prompt);
    assert.equal(/--for|--deadline|cerberus: detached/i.test(prompt), false, prompt);
    // Every invocation carries the path, never a bare command - unless the shim on
    // PATH *is* this file, in which case the bare name is the runnable spelling.
    if (SHOWN !== "cerberus") {
      assert.equal(/(^|[^/'\w])cerberus (log|rc|ls|stop|bg|fg|wait)/.test(prompt), false, prompt);
    } else {
      assert.match(prompt, /`cerberus (log|rc|ls|stop|bg|fg|wait) <id>`/);
    }

    assert.equal(first.systemPromptOptions.promptGuidelines.length, 1);
    assert.ok(first.systemPromptOptions.promptGuidelines[0].includes(`${SHOWN} fg <id>`));
    assert.ok(first.systemPromptOptions.promptGuidelines[0].includes(`${SHOWN} bg <id>`));

    // Same text every run, and repeating the hook does not duplicate guidelines.
    const second: any = { type: "before_agent_start", messageType: "user", prompt: "again", systemPromptOptions: options() };
    await handlers.before_agent_start(second, context("hook-prompt"));
    assert.equal(second.systemPromptOptions.sections.cerberus, prompt);
    const twice: any = { ...second, systemPromptOptions: { ...options() } };
    twice.systemPromptOptions.promptGuidelines = [...first.systemPromptOptions.promptGuidelines];
    await handlers.before_agent_start(twice, context("hook-prompt"));
    assert.equal(twice.systemPromptOptions.promptGuidelines.length, 1);
  }

  // --- /cerberus on|off|disabled|status|default: per session, per tool call -
  {
    const messages: string[] = [];
    const switchTo = (args: string, owner = "hook-switch") =>
      commands.cerberus.handler(args, { ...context(owner), ui: { notify: (text: string) => messages.push(text) } });

    await switchTo("status");
    assert.deepEqual(messages, ["cerberus: mode off (default)"], "off is the default");

    await switchTo("on");
    assert.equal(readMode("hook-switch"), "capture", "/cerberus on persists capture for this session");
    assert.equal(messages.at(-1), "cerberus: mode on (session hook-switch)");
    await switchTo("status");
    assert.equal(messages.at(-1), "cerberus: mode on (session hook-switch)");

    const silent: any = { type: "tool_call", toolName: "bash", input: { command: "sleep 20" } };
    assert.equal(await handlers.tool_call(silent, context("hook-switch")), undefined, "capture mode asks nothing");
    assert.deepEqual(listOwner("hook-switch"), [], "capture mode stages nothing");

    // Another session is untouched: it still reads the default.
    await switchTo("status", "hook-other");
    assert.equal(messages.at(-1), "cerberus: mode off (default)", "the switch is per session");

    // `off` is cerberus out of the way: no question, no task, not even the CLI
    // expansion - the tool itself runs pi's own bash. (With the gate enabled `off` is
    // the old gate again; the loop at the end of this block covers both.)
    await switchTo("off");
    assert.equal(readMode("hook-switch"), "disabled");
    assert.equal(messages.at(-1), "cerberus: mode off (session hook-switch)");
    if (!GATE_ON) {
      for (const command of ["sleep 20", "npm install", "cerberus ls"]) {
        const event: any = { type: "tool_call", toolName: "bash", input: { command } };
        assert.equal(await handlers.tool_call(event, context("hook-switch")), undefined, `${command}: nothing asked`);
        assert.equal(event.input.command, command, `${command}: left exactly as it was`);
      }
    }

    // `gate` is retired: refused with a hint, and nothing is written.
    messages.length = 0;
    await switchTo("gate");
    assert.equal(readMode("hook-switch"), "disabled", "a retired word changes nothing");
    assert.deepEqual(messages, ["cerberus: gate is retired (use on or off)"]);
    await switchTo("default gate");
    assert.deepEqual(messages.at(-1), "cerberus: gate is retired (use on or off)");

    // `default <mode>` moves every session that has no entry of its own.
    await switchTo("default on");
    assert.equal(readConfig().default, "capture");
    assert.equal(readMode("hook-other"), "capture", "the default follows");
    assert.equal(readMode("hook-switch"), "disabled", "an explicit entry still wins");
    await switchTo("default off");
    assert.equal(readMode("hook-other"), "disabled");
    await switchTo("default bogus");
    assert.match(messages.at(-1), /default: unknown argument/);

    await switchTo("bogus");
    assert.equal(readMode("hook-switch"), "disabled", "an unknown word changes nothing");
    assert.match(messages.at(-1), /unknown argument/);

    // With the gate retired, no mode at all can produce a question: `on` is capture,
    // `off` is inert. Flip GATE_ENABLED and `off` asks the old question again.
    for (const word of ["on", "off"]) {
      await switchTo(word);
      const event: any = { type: "tool_call", toolName: "bash", input: { command: "sleep 20" } };
      const answer = (await handlers.tool_call(event, context("hook-switch"))) as any;
      if (GATE_ON && word === "off") {
        assert.equal(answer?.block, true, "with the gate on, off asks again");
        assert.match(answer.reason, /^cerberus: this may block/);
        continue;
      }
      assert.equal(answer, undefined, `${word}: no question`);
      assert.deepEqual(listOwner("hook-switch"), [], `${word}: nothing staged`);
    }
  }

  // --- the mode indicator: a widget beside the editor, per session --------
  {
    // Count timers through the globals, so "nothing left running" is an assertion and
    // not a hope. The widget's own interval is the only one this extension starts.
    const live = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const tickers: Array<() => void> = [];
    (globalThis as any).setInterval = ((fn: () => void, ms: number, ...rest: unknown[]) => {
      const timer = (realSet as any)(fn, ms, ...rest);
      live.add(timer);
      tickers.push(fn);
      return timer;
    }) as any;
    (globalThis as any).clearInterval = ((timer: unknown) => {
      live.delete(timer);
      return (realClear as any)(timer);
    }) as any;

    const widgets: Array<{ key: string; factory: any }> = [];
    const notes: string[] = [];
    const indicatorCtx = (owner: string, hasUI = true) => ({
      ...context(owner),
      hasUI,
      ui: {
        setWidget: (key: string, factory: any) => widgets.push({ key, factory }),
        notify: (text: string) => notes.push(text),
      },
    });

    try {
      // No UI: no widget, no timer.
      await handlers.session_start({ type: "session_start" }, indicatorCtx("ind-no-ui", false));
      assert.deepEqual(widgets, [], "print/json registers no widget");
      assert.equal(live.size, 0, "and starts no timer");

      const owner = "ind-a";
      writeMode("disabled");
      writeMode("capture", owner);
      const ctx = indicatorCtx(owner);
      await handlers.session_start({ type: "session_start" }, ctx);
      assert.equal(widgets.length, 1);
      assert.equal(widgets[0].key, "status-row", "the indicator joins the shared row");
      assert.equal(typeof widgets[0].factory, "function");
      assert.equal(live.size, 1, "one timer, ~2s");
      assert.equal(tickers.length, 1);

      // The row renders this session's mode, with pi's own MouseRegion around it.
      const tui = { renders: 0, requestRender() { this.renders++; } };
      const theme = { fg: (color: string, text: string) => `${color}|${text}` };
      const component = widgets[0].factory(tui, theme);
      // HStack marks segment boundaries with resets; the visible text is what matters.
      const plain = (line: string) =>
        line.replace(/\x1B\[[0-9;]*m/g, "").replace(/\x1B\]8;;\x07/g, "").trimEnd();
      const shown = () => component.render(80).map(plain);
      assert.deepEqual(shown(), ["success|cerberus:on"]);
      const clickAt = (x: number, clickCount = 2) => ({
        type: "click", button: "left", clickCount, x, y: 0, width: 80, height: 1,
        screenX: x, screenY: 0, shift: false, alt: false, ctrl: false,
      });

      // Another session's switch does not leak in; this one's follows on the next tick.
      writeMode("disabled", "ind-b");
      tickers[0]();
      assert.deepEqual(shown(), ["success|cerberus:on"], "session b's mode stays on session b");
      writeMode("disabled", owner);
      tickers[0]();
      assert.deepEqual(shown(), ["dim|cerberus:off"], "the timer picks up this session's mode");
      writeMode("capture", owner);
      tickers[0]();

      // /cerberus repaints without waiting for a tick.
      await commands.cerberus.handler("on", { ...ctx, ui: { notify: (text: string) => notes.push(text) } });
      assert.deepEqual(shown(), ["success|cerberus:on"], "the command refreshes the indicator");
      assert.equal(readMode(owner), "capture");

      // A double click toggles on -> off -> on, and notifies with the word.
      notes.length = 0;
      component.handleMouse(clickAt(2));
      assert.equal(readMode(owner), "disabled", "a double click turns it off for this session");
      assert.deepEqual(shown(), ["dim|cerberus:off"]);
      assert.deepEqual(notes, [`cerberus: mode off (session ${owner})`]);
      component.handleMouse(clickAt(2));
      assert.equal(readMode(owner), "capture", "and on again");
      // A single click does nothing, and so does a click past the indicator.
      component.handleMouse(clickAt(2, 1));
      assert.equal(readMode(owner), "capture", "a single click is not a mode change");
      component.handleMouse(clickAt(79));
      assert.equal(readMode(owner), "capture", "a click in the empty part of the row is not ours");

      // Shutdown clears the widget and leaves no interval behind - twice, for the
      // session switch and /reload paths that converge here.
      await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
      assert.deepEqual(widgets.at(-1), { key: "status-row", factory: undefined }, "the row is removed");
      assert.equal(live.size, 0, "no setInterval survives shutdown");
      await handlers.session_shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
      assert.equal(live.size, 0, "and shutting down twice is harmless");

      // Starting again after a shutdown works (session switch), still one timer.
      widgets.length = 0;
      await handlers.session_start({ type: "session_start" }, indicatorCtx(owner));
      assert.equal(widgets.length, 1);
      assert.equal(live.size, 1);
      await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, indicatorCtx(owner));
      assert.equal(live.size, 0);
      writeMode("disabled");
    } finally {
      (globalThis as any).setInterval = realSet;
      (globalThis as any).clearInterval = realClear;
    }
  }

  // --- session_shutdown: print/json never reap ----------------------------
  for (const mode of ["print", "json"] as const) {
    const task = startTask(`hook-mode-${mode}`);
    await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, context(task.owner, mode));
    await new Promise((done) => setTimeout(done, 1000));
    assert.equal(reapers(task.owner), 0, `${mode} must not spawn reap`);
    assert.equal(existsSync(task.rc), false, `${mode} must not reap`);
    assert.equal(alive(task.pid), true, `${mode} task keeps running`);
  }

  // --- session_shutdown: quitting the TUI reaps this owner's tasks --------
  {
    const task = startTask("hook-mode-tui");
    await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, context(task.owner, "tui"));
    assert.equal(await waitFor(() => existsSync(task.rc), 15_000), true, "tui shutdown must reap");
    assert.equal(alive(task.pid), false);
  }

  // --- session_shutdown: reload never reaps, in either mode ---------------
  for (const mode of ["tui", "print"] as const) {
    const task = startTask(`hook-mode-reload-${mode}`);
    await handlers.session_shutdown({ type: "session_shutdown", reason: "reload" }, context(task.owner, mode));
    await new Promise((done) => setTimeout(done, 1000));
    assert.equal(reapers(task.owner), 0, `reload in ${mode} must not spawn reap`);
    assert.equal(existsSync(task.rc), false, `reload in ${mode} must not reap`);
    assert.equal(alive(task.pid), true);
  }
} finally {
  for (const task of created) {
    spawnSync(BIN, ["stop", task.id, "--owner", task.owner, "--force"], { stdio: "ignore" });
  }
  rmSync(state, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

console.log("hook.test.ts: ok");
