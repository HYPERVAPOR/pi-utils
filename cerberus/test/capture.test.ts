/**
 * Acceptance for the capture path (section D of the v2 spec).
 *
 * The reference is always pi's own bash tool: the same `createBashToolDefinition`
 * built on `createLocalBashOperations`. Our side is the tool this extension actually
 * registers, so the wrapper (and its one-line slow-path notice) is covered too.
 *
 *   node cerberus/test/capture.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = mkdtempSync(join(tmpdir(), "cerberus-capture-state-"));
const work = mkdtempSync(join(tmpdir(), "cerberus-capture-work-"));
process.env.XDG_STATE_HOME = state;
delete process.env.PI_SESSION_ID;
delete process.env.CERBERUS_CAPTURE_BUDGET_MS;

const capture = await import("../capture.ts");
const paths = await import("../paths.ts");
const { loadPi } = await import("../pi-package.ts");
const extension = await import("../../extensions/cerberus.ts");

const BIN = join(import.meta.dirname, "..", "..", "bin", "cerberus");
const pi = await loadPi();

/** Collect what the extension registers; no pi UI is involved in these calls. */
const tools: any[] = [];
const commands: any[] = [];
const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
await extension.default({
  on: (name: string, handler: (event: any, ctx: any) => unknown) => {
    handlers[name] = handler;
    return () => {};
  },
  registerTool: (tool: any) => tools.push(tool),
  registerCommand: (name: string, options: any) => commands.push({ name, ...options }),
} as any);

const ours = tools[0];
const reference = pi.createBashToolDefinition(work, { operations: pi.createLocalBashOperations() });

const context = (owner: string) => ({
  mode: "print",
  cwd: work,
  sessionManager: { getSessionId: () => owner, getSessionFile: () => undefined },
});

async function run(tool: any, owner: string, command: string, timeout?: number) {
  return await tool.execute("tool-call", { command, timeout }, undefined, undefined, context(owner));
}

const textOf = (result: any) => result.content.map((part: any) => part.text ?? "").join("");

/** pi names its full-output temp file per run; that name is not part of the result. */
const FULL_OUTPUT = /\/tmp\/pi-bash-[A-Za-z0-9._-]+/g;

function shrink(result: any, files: string[] = []) {
  const structured = result.structuredContent;
  if (structured?.full_output_path) files.push(structured.full_output_path);
  return {
    text: textOf(result).replaceAll(FULL_OUTPUT, "<full>"),
    details: result.details
      ? { truncation: result.details.truncation, fullOutputPath: result.details.fullOutputPath ? "<full>" : undefined }
      : undefined,
    isError: result.isError === true,
    structuredContent: {
      output: structured.output.replaceAll(FULL_OUTPUT, "<full>"),
      truncated: structured.truncated,
      full_output_path: structured.full_output_path ? "<full>" : undefined,
      exit_code: structured.exit_code,
      // Wall-clock time cannot be identical between two runs; only its type can.
      wall_time_seconds: typeof structured.wall_time_seconds,
    },
  };
}

/** Everything pi formats, plus the full-output file behind a truncation notice. */
function compare(name: string, a: any, b: any) {
  const filesA: string[] = [];
  const filesB: string[] = [];
  const left = shrink(a, filesA);
  const right = shrink(b, filesB);
  assert.deepEqual(left, right, name);
  assert.equal(filesA.length, filesB.length, `${name}: same truncation`);
  for (let i = 0; i < filesA.length; i++) {
    assert.equal(
      readFileSync(filesA[i]).compare(readFileSync(filesB[i])),
      0,
      `${name}: the full-output files are byte-identical too`,
    );
  }
  return [...filesA, ...filesB];
}

const litter: string[] = [];

try {
  // --- the tool replaces the built-in, and says so ------------------------
  {
    assert.equal(tools.length, 1, "exactly one tool is registered");
    assert.equal(ours.name, "bash", "it is registered under the built-in name");
    assert.equal(ours.label, reference.label);
    assert.equal(ours.description, reference.description, "same description as the built-in");
    assert.equal(ours.promptSnippet, reference.promptSnippet);
    assert.deepEqual(ours.promptGuidelines, reference.promptGuidelines);
    assert.ok(typeof ours.renderResult === "function", "same renderers as the built-in");
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "cerberus");
  }

  // --- D1: byte identity with the built-in --------------------------------
  {
    process.env[capture.BUDGET_ENV] = "8000";
    paths.writeMode("capture");
    const owner = "capture-identity";
    const cases: Array<[string, string]> = [
      ["empty output", "true"],
      ["exit 3", "echo boom; exit 3"],
      // A pause between writes makes the arrival order well defined, so both sides
      // can agree; writes that race cannot (see the next block).
      ["stdout+stderr mixed", "echo one; sleep 0.05; echo two >&2; sleep 0.05; echo three"],
      [">2000 lines", "seq 1 2500"],
      [">50KB", "head -c 200000 /dev/zero | tr '\\0' x"],
      ["no trailing newline", "printf 'no newline at end'"],
      ["command not found", "this-command-does-not-exist-cerberus"],
    ];
    for (const [name, command] of cases) {
      const a = await run(ours, owner, command);
      const b = await run(reference, `${owner}-ref`, command);
      litter.push(...compare(name, a, b));
    }

    // Mixed streams that race: same bytes, but the built-in merges two pipes by
    // arrival while the supervisor writes both into one fd (out.log), so ours keeps
    // the order the command wrote them in. The built-in's own order is scheduling
    // dependent, so only the bytes can be asserted here.
    {
      const command = "echo one; echo two >&2; echo three; echo four >&2";
      const a = await run(ours, owner, command);
      const b = await run(reference, `${owner}-ref`, command);
      const lines = (result: any) => textOf(result).split("\n").filter(Boolean).sort();
      assert.deepEqual(lines(a), lines(b), "mixed streams: same lines");
      assert.equal(textOf(a), "one\ntwo\nthree\nfour\n", "ours keeps the write order");
    }

    // The bash call's own `timeout`: both must report it the way pi does.
    const messages: string[] = [];
    for (const tool of [ours, reference]) {
      await assert.rejects(
        () => run(tool, owner, "sleep 5", 1),
        (err: unknown) => {
          messages.push((err as Error).message);
          return true;
        },
      );
    }
    assert.equal(messages[0], messages[1], "timeout param: same message");
    assert.match(messages[0], /Command timed out after 1 seconds/);
  }

  // --- D2: shell equivalence ----------------------------------------------
  {
    paths.writeMode("capture");
    const command = `printf 'shell=%s\\nbash=%s\\ncwd=%s\\npath0=%s\\n' "$0" "\${BASH_VERSION:+yes}" "$PWD" "\${PATH%%:*}"`;
    const a = await run(ours, "capture-shell", command);
    litter.push(...compare("shell equivalence", a, await run(reference, "capture-shell-ref", command)));
    assert.match(textOf(a), /bash=yes/, "$BASH_VERSION is set, so this is really bash");
    assert.match(textOf(a), new RegExp(`cwd=${work.replaceAll("/", "\\/")}`), "same cwd");
    assert.equal(textOf(a).includes("path0=\n"), false, "PATH is not empty");
  }

  // --- D3: the slow path keeps the task and returns one line ---------------
  {
    process.env[capture.BUDGET_ENV] = "200";
    paths.writeMode("capture");
    const owner = "capture-slow";
    const command = "sleep 1; echo late";
    const started = Date.now();
    const result = await run(ours, owner, command);
    assert.ok(Date.now() - started < 900, "the tool returned without waiting for the command");

    const notice = textOf(result);
    assert.equal(result.isError, false);
    assert.equal(result.details, undefined);
    assert.equal(result.structuredContent, undefined, "no structured output on the slow path");
    assert.match(notice, /^cerberus: still running id=\S+ \(\S+ wait \S+\)$/, notice);
    const id = notice.match(/id=(\S+)/)?.[1] as string;
    assert.equal(notice, capture.runningNotice(id, extension.SHOWN_BIN), "one notice line, nothing else");

    const task = paths.taskDir(owner, id);
    assert.equal(paths.readRc(task), undefined, "the task is still running");
    assert.ok(paths.listOwner(owner).some((entry) => entry.id === id), "the task is a normal task");

    // `cerberus wait <id>` returns the same text and the same rc as a plain run.
    const waited = spawnSync(BIN, ["wait", id, "--owner", owner], { encoding: "utf8" });
    assert.equal(waited.status, 0, waited.stderr);
    const plain = await run(reference, `${owner}-ref`, command);
    assert.equal(waited.stdout, textOf(plain), "wait prints what pi would have shown");
    assert.equal(paths.readRc(task), 0);
  }

  // --- D3b: wait formats big output like pi, not as a log tail -------------
  {
    process.env[capture.BUDGET_ENV] = "200";
    paths.writeMode("capture");
    // Each command outlives the budget first, so there is a task left to wait on.
    const cases: Array<[string, string, RegExp, number]> = [
      [">2000 lines", "sleep 0.5; seq 1 2500", /\[Showing lines \d+-2500 of 2500\. Full output: /, 9_000],
      [
        ">50KB",
        "sleep 0.5; head -c 200000 /dev/zero | tr '\\0' x",
        /\[Showing last .* of line 1 \(line is .*\). Full output: /,
        49_000,
      ],
    ];
    for (const [name, command, notice, minTail] of cases) {
      const owner = `capture-wait-${name.replace(/\W+/g, "")}`;
      const id = textOf(await run(ours, owner, command)).match(/id=(\S+)/)?.[1] as string;
      const waited = spawnSync(BIN, ["wait", id, "--owner", owner], { encoding: "utf8" });
      assert.equal(waited.status, 0, waited.stderr);
      // pi's own formatting: truncation notice, and the task log as the full output.
      const log = paths.taskDir(owner, id) + "/out.log";
      const plain = textOf(await run(reference, `${owner}-ref`, command));
      // Exactly pi's text, with the task log where pi's temp file was.
      assert.equal(waited.stdout, `${plain.replaceAll(FULL_OUTPUT, log)}\n`, `${name}: wait prints pi's result`);
      assert.match(waited.stdout, notice, `${name}: truncation notice`);
      assert.ok(waited.stdout.length > minTail, `${name}: the whole tail, not 50 lines`);
      assert.ok(readFileSync(log, "utf8").length > waited.stdout.length, `${name}: log stays the full output`);
    }
    delete process.env[capture.BUDGET_ENV];
  }

  // --- abort: the task is stopped, and pi renders "Command aborted" --------
  {
    process.env[capture.BUDGET_ENV] = "8000";
    paths.writeMode("capture");
    const owner = "capture-abort";
    const controller = new AbortController();
    const pending = ours.execute("tool-call", { command: "sleep 5" }, controller.signal, undefined, context(owner));
    setTimeout(() => controller.abort(), 300);
    // pi's own wording for a cancelled call; the task behind it must be gone.
    await assert.rejects(pending, (err: unknown) => (err as Error).message === "Command aborted");
    const [task] = paths.listOwner(owner);
    assert.ok(task, "the aborted command was a normal task");
    assert.equal(paths.readRc(task.dir), 143, "the task was terminated, not left running");
  }

  // --- D4: the switch is read per call ------------------------------------
  {
    delete process.env[capture.BUDGET_ENV];
    const owner = "capture-switch";
    const command = "echo switch";
    assert.equal(capture.captureBudgetMs(), capture.DEFAULT_BUDGET_MS, "10s by default");

    paths.writeMode("gate");
    assert.equal((await run(ours, owner, command, undefined)).structuredContent.exit_code, 0);
    assert.equal(paths.listOwner(owner).length, 0, "gate mode leaves the task machinery alone");

    paths.writeMode("capture");
    assert.equal((await run(ours, owner, command, undefined)).structuredContent.exit_code, 0);
    assert.deepEqual(paths.listOwner(owner), [], "a capture run that made it in time leaves no task");

    // Only the slow path keeps a task - and it is an ordinary one.
    process.env[capture.BUDGET_ENV] = "150";
    const slow = textOf(await run(ours, owner, "sleep 0.5"));
    assert.match(slow, /^cerberus: still running id=\S+/, "over budget: one notice");
    assert.equal(paths.listOwner(owner).length, 1, "the slow path keeps its task");
    const slowId = slow.match(/id=(\S+)/)?.[1] as string;
    spawnSync(BIN, ["wait", slowId, "--owner", owner, "--for", "10"], { encoding: "utf8" });
    delete process.env[capture.BUDGET_ENV];

    assert.equal(capture.captureBudgetMs({ [capture.BUDGET_ENV]: "200" }), 200);
    assert.equal(capture.captureBudgetMs({ [capture.BUDGET_ENV]: "nope" }), capture.DEFAULT_BUDGET_MS);
  }

  // --- E1: the gate's own CLI is not captured, so `wait` cannot nest ------
  {
    process.env[capture.BUDGET_ENV] = "300";
    paths.writeMode("capture");
    const owner = "capture-exempt";
    const slow = textOf(await run(ours, owner, "sleep 1.2; echo twentyfive"));
    assert.match(slow, /^cerberus: still running id=\S+/, "the slow command is an ordinary task");
    const id = slow.match(/id=(\S+)/)?.[1] as string;
    assert.equal(paths.listOwner(owner).length, 1);

    // One call collects it: `wait` is control surface, so it runs locally and blocks
    // on the task instead of becoming a task that would need waiting on itself.
    const waited = await run(ours, owner, `${BIN} wait ${id} --owner ${owner} --for 30`);
    assert.doesNotMatch(textOf(waited), /still running/, "no nested notice");
    assert.equal(textOf(waited), "twentyfive\n", "the wait returns the task's output");
    assert.equal(waited.structuredContent.exit_code, 0);
    assert.equal(paths.listOwner(owner).length, 1, "waiting created no task of its own");
    assert.equal(paths.readRc(paths.taskDir(owner, id)), 0, "the task itself finished");

    // The rest of the CLI is control surface too: no task directories at all.
    for (const command of [`${BIN} ls --owner ${owner}`, `${BIN} log ${id} --owner ${owner}`, `${BIN} rc ${id} --owner ${owner}`, `${BIN} mode`]) {
      const before = paths.listOwner(owner).length;
      const result = await run(ours, owner, command);
      assert.equal(result.structuredContent.exit_code, 0, `${command}: ran and exited 0`);
      assert.equal(paths.listOwner(owner).length, before, `${command}: created no task`);
    }
    assert.match(textOf(await run(ours, owner, `${BIN} log ${id} --owner ${owner}`)), /twentyfive/, "log still reads it");
    delete process.env[capture.BUDGET_ENV];
  }

  // --- E2: one real command in the line puts it back on the capture path ---
  {
    // Too short for any node process: every one of these lines must be captured.
    process.env[capture.BUDGET_ENV] = "20";
    paths.writeMode("capture");
    const owner = "capture-mixed";
    const cases: Array<[string, string]> = [
      ["cerberus ls && sleep 12", `${BIN} ls && sleep 1`],
      ["echo hi && cerberus ls", `echo hi && ${BIN} ls`],
      ["cerberus ls && npm run build", `${BIN} ls && sleep 1`],
      ["cerberus log 42 | head -5", `${BIN} log 1 | head -5`],
    ];
    for (const [shape, command] of cases) {
      const result = await run(ours, owner, command);
      assert.match(textOf(result), /^cerberus: still running id=\S+/, `${shape}: captured, so over budget`);
      const id = textOf(result).match(/id=(\S+)/)?.[1] as string;
      assert.ok(paths.listOwner(owner).some((task) => task.id === id), `${shape}: a real task`);
      spawnSync(BIN, ["stop", id, "--owner", owner], { encoding: "utf8" });
    }
    // The mixed line really ran both halves.
    process.env[capture.BUDGET_ENV] = "20";
    const mixed = textOf(await run(ours, owner, `echo hi && ${BIN} ls --owner ${owner}`));
    const mixedId = mixed.match(/id=(\S+)/)?.[1] as string;
    const finished = spawnSync(BIN, ["wait", mixedId, "--owner", owner, "--for", "10"], { encoding: "utf8" });
    assert.match(finished.stdout, /^hi\n/, "the echo ran before the CLI did");
    delete process.env[capture.BUDGET_ENV];
  }
} finally {
  for (const file of litter) {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
  rmSync(state, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

console.log("capture.test.ts: ok");
