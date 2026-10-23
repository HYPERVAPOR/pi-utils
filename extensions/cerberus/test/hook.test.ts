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

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cerberus");

type Handler = (event: any, ctx: any) => unknown;
const handlers: Record<string, Handler> = {};
const fakePi = {
  on: (name: string, handler: Handler) => {
    handlers[name] = handler;
    return () => {};
  },
};
const extension = await import("../../cerberus.ts");
// What the prompt/tool result actually prints: a bare `cerberus` when the shim on
// PATH points back at this file, an absolute (quoted) path otherwise.
const SHOWN: string = extension.SHOWN_BIN;
(extension.default as (pi: unknown) => void)(fakePi);

assert.equal(typeof handlers.tool_call, "function");
assert.equal(typeof handlers.before_agent_start, "function");
assert.equal(typeof handlers.session_shutdown, "function");

const { allocateTask, claimTask, cmdHash, writeMeta } = await import("../../../cerberus/paths.ts");
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
  {
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
  {
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
    assert.match(prompt, /\[cerberus\] background/);
    assert.match(prompt, /timeout.*does not skip/i);
    assert.match(prompt, /no deadline/i);
    // No stale wording from the bounded-wait design.
    assert.equal(/15\s*s/i.test(prompt), false, prompt);
    assert.equal(/detached/i.test(prompt), false, prompt);
    assert.equal(/--for|--deadline|\[cerberus\] detached/i.test(prompt), false, prompt);
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
