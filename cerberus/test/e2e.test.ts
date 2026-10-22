/**
 * End-to-end check of the gate + CLI chain without starting pi.
 *
 * A fake `pi` collects the extension handlers, so the gate cases can be called
 * directly; then the exact `<BIN> bg <id>` string from the question is executed
 * through `sh -c` the way pi executes bash, and the task is inspected via the CLI.
 *
 *   node cerberus/test/e2e.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = mkdtempSync(join(tmpdir(), "cerberus-e2e-state-"));
const work = mkdtempSync(join(tmpdir(), "cerberus-e2e-work-"));
const cwdA = join(work, "repo-a");
const cwdB = join(work, "repo-b");
const fakeBin = join(work, "fakebin");
mkdirSync(cwdA);
mkdirSync(cwdB);
mkdirSync(fakeBin);
// A stand-in for npm: it records the execution and exits immediately.
const counter = join(work, "counter");
const fakeNpm = join(fakeBin, "npm");
writeFileSync(fakeNpm, `#!/bin/sh\necho run >> "$COUNTER"\nexit 0\n`);
chmodSync(fakeNpm, 0o755);
process.env.XDG_STATE_HOME = state;
process.env.COUNTER = counter;
process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;
delete process.env.PI_SESSION_ID;

const BIN = join(import.meta.dirname, "..", "..", "bin", "cerberus");
const { cmdHash, listOwner, listTasks, readMeta, readPid, readRc, taskDir } = await import("../paths.ts");

type Handler = (event: any, ctx: any) => unknown;
const handlers: Record<string, Handler> = {};
const fakePi = {
  on: (name: string, handler: Handler) => {
    handlers[name] = handler;
    return () => {};
  },
};
const extension = await import("../../extensions/cerberus.ts");
(extension.default as (pi: unknown) => void)(fakePi);

assert.equal(typeof handlers.tool_call, "function");

const context = (cwd: string, owner: string) => ({
  mode: "tui",
  cwd,
  sessionManager: { getSessionId: () => owner },
});

async function callBash(
  command: unknown,
  options: { timeout?: number; cwd?: string; owner?: string; tool?: string } = {},
) {
  const event: any = {
    type: "tool_call",
    toolName: options.tool ?? "bash",
    toolCallId: "t1",
    input: { command, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) },
  };
  const result = await handlers.tool_call(
    event,
    context(options.cwd ?? cwdA, options.owner ?? "e2e-owner"),
  );
  return { event, result: result as { block?: boolean; reason?: string; terminate?: boolean } | undefined };
}

function idOf(reason: string): string {
  const match = / fg (\S+) {3}->/.exec(reason);
  assert.ok(match, `no id in reason: ${reason}`);
  return match[1];
}

function cli(args: string[], owner = "e2e-owner") {
  return spawnSync(BIN, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_STATE_HOME: state,
      PI_SESSION_ID: owner,
      COUNTER: counter,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  });
}

/** Execute exactly what pi would execute for a (possibly rewritten) bash call. */
function sh(command: string, owner = "e2e-owner") {
  return spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    cwd: cwdA,
    env: {
      ...process.env,
      XDG_STATE_HOME: state,
      PI_SESSION_ID: owner,
      COUNTER: counter,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  });
}

function runs(): number {
  try {
    return readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function waitFor<T>(read: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  let value = read();
  while (value === undefined && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50));
    value = read();
  }
  return value;
}

const waitForRc = (dir: string, ms = 8000) => waitFor(() => readRc(dir), ms);

let sequence = 0;
const owner = (label: string) => `e2e-${label}-${++sequence}`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let liveTaskId = "";
let liveOwner = "";
try {
  // --- other tools are untouched -----------------------------------------
  {
    const { event, result } = await callBash("/tmp/a.ts", { tool: "read" });
    assert.deepEqual(event.input, { command: "/tmp/a.ts" });
    assert.equal(result, undefined);
  }

  // --- non-hits pass through byte-for-byte, with no side effects ----------
  {
    const passOwner = owner("pass");
    const samples = [
      "echo hi",
      "ls -la\n",
      `printf '%s\\n' "中文 ✅" && echo 'single "double"'`,
      "npm install &",
      `echo "sleep 600"`,
      `grep 'npm run build' log`,
      "sleep 5",
      "true",
    ];
    for (const command of samples) {
      const { event, result } = await callBash(command, { owner: passOwner });
      assert.equal(result, undefined, `should not block: ${command}`);
      assert.equal(event.input.command, command, `should not rewrite: ${command}`);
    }
    assert.deepEqual(listOwner(passOwner), [], "no task is staged for a pass-through");
  }

  // --- a bash timeout is a budget, not an exemption ------------------------
  {
    const timeoutOwner = owner("timeout");
    const command = "npm run build";
    const first = await callBash(command, { timeout: 600, owner: timeoutOwner });
    assert.equal(first.result?.block, true, "timeout: 600 must still ask");
    assert.equal(first.event.input.command, command);
    assert.equal(first.event.input.timeout, 600);

    // The resend is the fg answer; pi keeps the timeout and we must not touch it.
    const again = await callBash(command, { timeout: 600, owner: timeoutOwner });
    assert.equal(again.result, undefined, "the resend must not block");
    assert.equal(again.event.input.command, command);
    assert.equal(again.event.input.timeout, 600, "the model's timeout is preserved byte for byte");

    // Any positive value, including a fraction, is still only a budget.
    for (const timeout of [0.5, 0]) {
      const own = owner(`timeout-${timeout}`);
      const { event, result } = await callBash("npm install", { timeout, owner: own });
      assert.equal(result?.block, true, `timeout: ${timeout} must still ask`);
      assert.equal(event.input.timeout, timeout);
    }
  }

  // --- timeout / nohup / setsid / keywords do not create an exemption -------
  {
    const own = owner("wrappers");

    const timed = await callBash("timeout 600 npm run build", { owner: own });
    assert.equal(timed.result?.block, true, "timeout N must not bypass the gate");
    assert.equal(timed.event.input.command, "timeout 600 npm run build");

    const timedShort = await callBash("timeout 600 grep foo bar", { owner: own });
    assert.equal(timedShort.result, undefined, "timeout + non-long command stays a miss");
    assert.equal(timedShort.event.input.command, "timeout 600 grep foo bar");

    // The resend is the fg answer: the wrapper is passed through untouched.
    const timedAgain = await callBash("timeout 600 npm run build", { owner: own });
    assert.equal(timedAgain.result, undefined);
    assert.equal(timedAgain.event.input.command, "timeout 600 npm run build");

    // Without `&`, nohup still blocks the foreground shell, so it is gated.
    const stuck = "nohup npm start > out.log 2>&1";
    const blocked = await callBash(stuck, { owner: own });
    assert.equal(blocked.result?.block, true, "bare nohup is not backgrounded");
    assert.equal(blocked.event.input.command, stuck);
    const id = idOf(blocked.result?.reason ?? "");
    assert.deepEqual(readFileSync(join(taskDir(own, id), "cmd.sh")), Buffer.from(stuck, "utf8"));

    const detached = `${stuck} &`;
    const detachedCall = await callBash(detached, { owner: own });
    assert.equal(detachedCall.result, undefined, "`&` still backgrounded");
    assert.equal(detachedCall.event.input.command, detached);

    assert.equal((await callBash("setsid npm start", { owner: own })).result?.block, true);
    assert.equal(
      (await callBash("setsid --fork npm start", { owner: own })).result,
      undefined,
      "setsid --fork returns immediately",
    );

    assert.equal(
      (await callBash("if [ -f x ]; then npm run build; fi", { owner: own })).result?.block,
      true,
      "if/then/fi is unwrapped",
    );
    assert.equal(
      (await callBash("for d in a b; do npm run build; done", { owner: own })).result?.block,
      true,
      "for/do/done is unwrapped",
    );
  }

  // --- `cerberus` / the absolute BIN is expanded, never gated --------------
  {
    const quoted = `'${BIN}'`;
    const expanded = await callBash("cerberus ls");
    assert.equal(expanded.event.input.command, `${quoted} ls`);
    assert.equal(expanded.result, undefined);

    const withArgs = await callBash("cerberus bg abc1234-dead-1");
    assert.equal(withArgs.event.input.command, `${quoted} bg abc1234-dead-1`);

    // Every simple command's command word, not just the first token of the line.
    const prefixed: Array<[string, string]> = [
      ["cd /tmp && cerberus ls", `cd /tmp && ${quoted} ls`],
      ["(cerberus rc x)", `(${quoted} rc x)`],
      ["foo; cerberus ls", `foo; ${quoted} ls`],
      ["foo || cerberus rc x", `foo || ${quoted} rc x`],
      ["foo | cerberus log x", `foo | ${quoted} log x`],
      ["foo & cerberus ls", `foo & ${quoted} ls`],
      ["cerberus ls && cerberus rc x", `${quoted} ls && ${quoted} rc x`],
      [`cd /tmp && ${BIN} log x`, `cd /tmp && ${quoted} log x`],
      ["cd /tmp &&\n  cerberus ls", `cd /tmp &&\n  ${quoted} ls`],
      ["if true; then cerberus ls; fi", `if true; then ${quoted} ls; fi`],
      ["for d in a b; do cerberus ls; done", `for d in a b; do ${quoted} ls; done`],
      ["FOO=1 cerberus ls", `FOO=1 ${quoted} ls`],
      ["{ cerberus ls; }", `{ ${quoted} ls; }`],
    ];
    for (const [command, expected] of prefixed) {
      const { event, result } = await callBash(command);
      assert.equal(result, undefined, `cerberus command is not gated: ${command}`);
      assert.equal(event.input.command, expected, command);
    }

    // An unquoted absolute BIN is quoted; a quoted one is left alone.
    for (const command of [`${BIN} log abc-1`, `${quoted} ls`, "cerberusx --version"]) {
      const { event, result } = await callBash(command);
      assert.equal(result, undefined);
      assert.equal(event.input.command, command.startsWith(BIN) ? `${quoted}${command.slice(BIN.length)}` : command);
    }

    // argv[0] only: arguments, quoted text and comments are byte-for-byte intact.
    for (const command of [
      "echo cerberus",
      "cat cerberus",
      "echo cerberus ls",
      "grep cerberus file",
      "foo && echo cerberus",
      "sudo cerberus ls",
      `echo "cerberus ls && cerberus rc"`,
      "echo hi # cerberus ls",
    ]) {
      const { event, result } = await callBash(command);
      assert.equal(result, undefined, `no gate for an argument: ${command}`);
      assert.equal(event.input.command, command, `must not touch: ${command}`);
    }

    // Not a shell command: nothing to do.
    for (const command of ["", null, undefined, 42]) {
      const { event } = await callBash(command);
      assert.equal(event.input.command, command);
    }
  }

  // --- hit: block, save exact bytes, do not execute, do not terminate ------
  {
    const hitOwner = owner("hit");
    const command = "npm install";
    const { event, result } = await callBash(command, { owner: hitOwner });

    assert.equal(result?.block, true);
    assert.equal(result?.terminate, undefined, "terminate would prevent the answer");
    const reason = result?.reason ?? "";
    assert.equal(
      reason,
      [
        "Cerberus: this may block for a long time. Nothing has run yet. Answer by running exactly one:",
        `  ${BIN} fg <id>   -> I must wait: run it in the foreground and return the output`,
        `  ${BIN} bg <id>   -> I do not need it now: run it in the background, I will check later`,
        `  (background has no deadline; stop it with ${BIN} stop <id>)`,
        "Do not answer in prose.",
      ]
        .join("\n")
        .replaceAll("<id>", idOf(reason)),
      "the question is emitted verbatim",
    );
    assert.match(reason, /Cerberus: this may block for a long time\. Nothing has run yet\./);
    assert.match(reason, /Do not answer in prose\./);
    assert.ok(reason.includes("(background has no deadline;"), reason);
    assert.equal(event.input.command, command, "a blocked call keeps its command");

    const id = idOf(reason);
    assert.ok(reason.includes(`${BIN} fg ${id}`), reason);
    assert.ok(reason.includes(`${BIN} bg ${id}`), reason);
    assert.ok(BIN.startsWith("/"), "the question carries the absolute BIN");
    assert.match(id, new RegExp(`^${cmdHash(command)}-[0-9a-f]{4}-1$`), id);

    const meta = readMeta(taskDir(hitOwner, id));
    assert.ok(meta);
    assert.equal(meta.state, "staged");
    assert.equal(meta.asked, 1);
    assert.equal(meta.owner, hitOwner);
    assert.equal(meta.cwd, cwdA);
    assert.equal(meta.cmdHash, cmdHash(command));
    assert.equal(typeof meta.startedAt, "number");
    assert.deepEqual(
      readFileSync(join(taskDir(hitOwner, id), "cmd.sh")),
      Buffer.from(command, "utf8"),
      "cmd.sh is the original command byte for byte",
    );

    // The command did not run yet.
    assert.equal(existsSync(counter), false);
    assert.equal(listOwner(hitOwner).length, 1);

    // Resending the identical command is the tolerated "fg" answer.
    const again = await callBash(command, { owner: hitOwner });
    assert.equal(again.result, undefined, "the resend must not block");
    assert.equal(again.event.input.command, command);
    assert.equal(listOwner(hitOwner).length, 1, "no new staged task");
    assert.equal(readMeta(taskDir(hitOwner, id))?.state, "consumed");
    assert.equal(readMeta(taskDir(hitOwner, id))?.asked, 0);

    // pi executes the resend: exactly once.
    const run = sh(again.event.input.command, hitOwner);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(runs(), 1);

    // The staged task is consumed, so the old id cannot run it again.
    const stale = cli(["fg", id], hitOwner);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, new RegExp(`already consumed: ${id}`));
    assert.equal(runs(), 1, "fg on a consumed task must not execute anything");

    // A third identical call is still answered by the remembered decision.
    const third = await callBash(command, { owner: hitOwner });
    assert.equal(third.result, undefined);
    assert.equal(third.event.input.command, command);
    assert.equal(runs(), 1);
  }

  // --- fg is the yes button: one run, then consumed ------------------------
  {
    const fgOwner = owner("fg");
    const command = "npm install";
    const blocked = await callBash(command, { owner: fgOwner });
    const id = idOf(blocked.result?.reason ?? "");
    assert.equal(runs(), 1, "previous test's single run is still the only one");

    const fg = cli(["fg", id], fgOwner);
    assert.equal(fg.status, 0, fg.stderr);
    assert.equal(runs(), 2, "fg runs the saved command once");
    assert.equal(readRc(taskDir(fgOwner, id)), 0);
    assert.equal(readMeta(taskDir(fgOwner, id))?.state, "finished");

    const second = cli(["fg", id], fgOwner);
    assert.equal(second.status, 1);
    assert.match(second.stderr, new RegExp(`already consumed: ${id}`));
    assert.equal(runs(), 2, "a second fg must be refused");

    // The decision is remembered: the same command is never gated again.
    const again = await callBash(command, { owner: fgOwner });
    assert.equal(again.result, undefined);
    assert.equal(again.event.input.command, command);
    const run = sh(again.event.input.command, fgOwner);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(runs(), 3, "the pass-through runs directly, exactly once");
  }

  // --- bg is the no button; a remembered bg is started by the gate ---------
  {
    const bgOwner = owner("bg");
    const command = "npm install";
    const blocked = await callBash(command, { owner: bgOwner });
    const firstId = idOf(blocked.result?.reason ?? "");
    const before = runs();

    const bg = cli(["bg", firstId], bgOwner);
    assert.equal(bg.status, 0, bg.stderr);
    const firstDir = taskDir(bgOwner, firstId);
    assert.equal(
      bg.stdout,
      `[cerberus] background id=${firstId} log=${join(firstDir, "out.log")} rc=${join(firstDir, "rc")}\n`,
    );
    assert.equal(await waitForRc(firstDir), 0);
    assert.equal(runs(), before + 1);

    // Same command again: no question and no rewrite. The gate starts it itself
    // and blocks with a handle, so pi cannot run the command a second time.
    const again = await callBash(command, { owner: bgOwner });
    assert.equal(again.result?.block, true, "a remembered bg still blocks execution");
    assert.equal(again.result?.terminate, undefined);
    assert.equal(again.event.input.command, command, "no rewrite to `bg <id>`");
    const reason = again.result?.reason ?? "";
    const started = /^\[cerberus\] background id=(\S+) log=(\S+) rc=(\S+)$/m.exec(reason);
    assert.ok(started, reason);
    const secondId = started[1];
    assert.notEqual(secondId, firstId);
    assert.equal(started[2], join(taskDir(bgOwner, secondId), "out.log"));
    assert.equal(started[3], join(taskDir(bgOwner, secondId), "rc"));
    assert.ok(reason.includes(`'${BIN}' log ${secondId}`), reason);
    assert.ok(reason.includes(`'${BIN}' rc ${secondId}`), reason);
    assert.ok(reason.includes(`'${BIN}' wait ${secondId}`), reason);
    assert.equal(await waitForRc(taskDir(bgOwner, secondId)), 0);
    assert.equal(runs(), before + 2, "the gate-spawned task ran exactly once");
    assert.equal(readMeta(taskDir(bgOwner, secondId))?.state, "finished");
  }

  // --- the staged key includes cwd ----------------------------------------
  {
    const cwdOwner = owner("cwd");
    const command = "npm install";
    const a = await callBash(command, { owner: cwdOwner, cwd: cwdA });
    const b = await callBash(command, { owner: cwdOwner, cwd: cwdB });
    assert.equal(a.result?.block, true);
    assert.equal(b.result?.block, true, "repo B must be asked separately");
    const idA = idOf(a.result?.reason ?? "");
    const idB = idOf(b.result?.reason ?? "");
    assert.notEqual(idA, idB, "the same hash in two cwds must not share a task");
    assert.equal(readMeta(taskDir(cwdOwner, idA))?.cwd, cwdA);
    assert.equal(readMeta(taskDir(cwdOwner, idB))?.cwd, cwdB);
    assert.equal(listOwner(cwdOwner).length, 2);
  }

  // --- `bash -c` bodies are gated too -------------------------------------
  {
    const shellOwner = owner("shell");
    const command = `bash -c 'npm run build'`;
    const { event, result } = await callBash(command, { owner: shellOwner });
    assert.equal(result?.block, true);
    assert.equal(event.input.command, command);
    const id = idOf(result?.reason ?? "");
    assert.deepEqual(
      readFileSync(join(taskDir(shellOwner, id), "cmd.sh")),
      Buffer.from(command, "utf8"),
    );
  }

  // --- a staged task already asked twice is let through --------------------
  {
    const askedOwner = owner("asked");
    const command = "npm install";
    const hash = cmdHash(command);
    const { allocateTask, writeMeta } = await import("../paths.ts");
    const task = allocateTask(askedOwner, hash, cwdA);
    writeFileSync(join(task.dir, "cmd.sh"), command);
    writeMeta(task.dir, {
      state: "staged",
      asked: 2,
      owner: askedOwner,
      cwd: cwdA,
      cmdHash: hash,
      startedAt: Date.now(),
    });
    const { event, result } = await callBash(command, { owner: askedOwner });
    assert.equal(result, undefined, "asked >= 2 must not block again");
    assert.equal(event.input.command, command);
  }

  // --- no owner: fail open, never block -----------------------------------
  {
    const { event, result } = await callBash("npm install", { owner: "" });
    assert.equal(result, undefined);
    assert.equal(event.input.command, "npm install");
  }

  // --- the real chain: question -> bg -> ls/log/rc/stop --------------------
  {
    liveOwner = "e2e-session";
    const command = "echo started && sleep 30";
    const event: any = { type: "tool_call", toolName: "bash", toolCallId: "e2e", input: { command } };
    const result = (await handlers.tool_call(event, {
      mode: "tui",
      cwd: work,
      sessionManager: { getSessionId: () => liveOwner },
    })) as { block?: boolean; reason?: string } | undefined;

    assert.equal(result?.block, true);
    const reason = result?.reason ?? "";
    const match = new RegExp(`^  ${escapeRegExp(BIN)} bg (\\S+) {3}->`, "m").exec(reason);
    assert.ok(match, reason);
    liveTaskId = match[1];
    assert.equal(event.input.command, command, "blocked call keeps its bytes");

    const dir = taskDir(liveOwner, liveTaskId);
    assert.deepEqual(readFileSync(join(dir, "cmd.sh")), Buffer.from(command, "utf8"));

    // This is the exact string from the question, run the way pi runs bash.
    const bgCommand = `${BIN} bg ${liveTaskId}`;
    const bg = spawnSync("/bin/sh", ["-c", bgCommand], {
      env: { ...process.env, XDG_STATE_HOME: state, PI_SESSION_ID: liveOwner },
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(bg.status, 0, bg.stderr);
    assert.equal(
      bg.stdout,
      `[cerberus] background id=${liveTaskId} log=${join(dir, "out.log")} rc=${join(dir, "rc")}\n`,
    );

    // The task runs in the background: output appears while rc is still absent.
    const logged = await waitFor(() => {
      try {
        const text = readFileSync(join(dir, "out.log"), "utf8");
        return text.includes("started") ? text : undefined;
      } catch {
        return undefined;
      }
    }, 8000);
    assert.ok(logged, "background output lands in out.log");
    assert.equal(existsSync(join(dir, "rc")), false, "still running");

    const ls = cli(["ls", "--owner", liveOwner], liveOwner);
    assert.equal(ls.status, 0, ls.stderr);
    assert.match(ls.stdout, new RegExp(liveTaskId));
    assert.match(ls.stdout, /running/);
    assert.match(ls.stdout, /echo started && sleep 30/);

    const log = cli(["log", liveTaskId, "--owner", liveOwner], liveOwner);
    assert.equal(log.status, 0, log.stderr);
    assert.match(log.stdout, /started/);

    assert.equal(cli(["rc", liveTaskId, "--owner", liveOwner], liveOwner).stdout.trim(), "running");

    const stop = cli(["stop", liveTaskId, "--owner", liveOwner], liveOwner);
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, new RegExp(`stopped ${liveTaskId}`));
    const rc = await waitFor(() => {
      try {
        const raw = readFileSync(join(dir, "rc"), "utf8").trim();
        return raw === "" ? undefined : raw;
      } catch {
        return undefined;
      }
    }, 5000);
    assert.match(rc ?? "", /^(143|137)$/);
    assert.equal(cli(["rc", liveTaskId, "--owner", liveOwner], liveOwner).stdout.trim(), rc);
  }
} finally {
  if (liveTaskId && liveOwner) {
    cli(["stop", liveTaskId, "--owner", liveOwner, "--force"], liveOwner);
  }
  for (const task of listTasks()) {
    if (readRc(task.dir) !== undefined || readPid(task.dir) === undefined) continue;
    spawnSync(BIN, ["stop", task.id, "--owner", task.owner, "--force"], {
      env: { ...process.env, XDG_STATE_HOME: state },
      stdio: "ignore",
    });
  }
  rmSync(state, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

console.log("e2e.test.ts: ok");
