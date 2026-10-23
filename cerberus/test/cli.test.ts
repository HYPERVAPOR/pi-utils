/**
 * Self-check for cli.ts against real processes: bg / fg / ls / log / rc / wait,
 * streaming, timeouts, signal forwarding and staged retention.
 *
 *   node cerberus/test/cli.test.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = mkdtempSync(join(tmpdir(), "cerberus-cli-state-"));
const work = mkdtempSync(join(tmpdir(), "cerberus-cli-work-"));
process.env.XDG_STATE_HOME = state;
delete process.env.PI_SESSION_ID;

const BIN = join(import.meta.dirname, "..", "..", "bin", "cerberus");
const {
  allocateTask,
  cmdHash,
  isAlive,
  readMeta,
  readPid,
  readRc,
  taskDir,
  writeMeta,
  writeRc,
} = await import("../paths.ts");

const env = (owner: string) => ({
  ...process.env,
  XDG_STATE_HOME: state,
  PI_SESSION_ID: owner,
});

function cli(args: string[], owner = "cli-owner") {
  return spawnSync(BIN, args, { env: env(owner), cwd: work, encoding: "utf8" });
}

function cliAsync(args: string[], owner = "cli-owner") {
  return spawn(BIN, args, { env: env(owner), cwd: work, stdio: ["ignore", "pipe", "pipe"] });
}

function stage(owner: string, command: string, cwd = work, startedAt = Date.now()): string {
  const task = allocateTask(owner, cmdHash(command), cwd);
  writeFileSync(join(task.dir, "cmd.sh"), command);
  writeMeta(task.dir, {
    state: "staged",
    asked: 1,
    owner,
    cwd,
    cmdHash: cmdHash(command),
    startedAt,
  });
  return task.id;
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

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const started: Array<{ owner: string; id: string }> = [];

try {
  // --- bg starts a staged task, prints a handle, rc lands ------------------
  {
    const owner = "cli-bg";
    const id = stage(owner, "echo bg-ok\n");
    const bg = cli(["bg", id], owner);
    assert.equal(bg.status, 0, bg.stderr);
    const dir = taskDir(owner, id);
    assert.equal(
      bg.stdout,
      `[cerberus] background id=${id} log=${join(dir, "out.log")} rc=${join(dir, "rc")}\n`,
    );
    assert.equal(readMeta(taskDir(owner, id))?.state, "running");
    assert.ok((readPid(taskDir(owner, id)) ?? 0) > 0);

    const rc = await waitFor(() => readRc(taskDir(owner, id)), 10_000);
    assert.equal(rc, 0);
    assert.match(readFileSync(join(taskDir(owner, id), "out.log"), "utf8"), /bg-ok/);
    assert.equal(readMeta(taskDir(owner, id))?.state, "finished");

    const rcOut = cli(["rc", id], owner);
    assert.equal(rcOut.status, 0);
    assert.equal(rcOut.stdout.trim(), "0");

    const logOut = cli(["log", id], owner);
    assert.match(logOut.stdout, /bg-ok/);

    // A second bg must not execute the consumed task again.
    const again = cli(["bg", id], owner);
    assert.equal(again.status, 1);
    assert.match(again.stderr, new RegExp(`already consumed: ${id}`));
    assert.equal(readRc(taskDir(owner, id)), 0);
  }

  // --- ls shows staged tasks; log/rc work before they start ---------------
  {
    const owner = "cli-staged";
    const id = stage(owner, "sleep 30\n");
    const ls = cli(["ls", "--owner", owner], owner);
    assert.equal(ls.status, 0, ls.stderr);
    assert.match(ls.stdout, new RegExp(`${id}  staged`));

    const json = cli(["ls", "--owner", owner, "--json"], owner);
    const rows = JSON.parse(json.stdout);
    assert.equal(rows[0].state, "staged");
    assert.equal(rows[0].rc, null);

    assert.equal(cli(["rc", id], owner).stdout.trim(), "running");
    assert.equal(cli(["log", id], owner).stdout, "(no output yet)\n");

    // bg/fg refuse a task that already has rc, whichever command asks first.
    const running = stage(owner, "sleep 30\n");
    const bg = cli(["bg", running], owner);
    assert.equal(bg.status, 0, bg.stderr);
    started.push({ owner, id: running });
    const fg = cli(["fg", running], owner);
    assert.equal(fg.status, 1);
    assert.match(fg.stderr, new RegExp(`already consumed: ${running}`));
    const bgAgain = cli(["bg", running], owner);
    assert.equal(bgAgain.status, 1);
    assert.match(bgAgain.stderr, new RegExp(`already consumed: ${running}`));
  }

  // --- bg --timeout N hard-kills and records 124 --------------------------
  {
    const owner = "cli-timeout";
    const id = stage(owner, "sleep 30\n");
    const startedAt = Date.now();
    const bg = cli(["bg", id, "--timeout", "2"], owner);
    assert.equal(bg.status, 0, bg.stderr);
    const rc = await waitFor(() => readRc(taskDir(owner, id)), 8000);
    const wall = Date.now() - startedAt;
    assert.equal(rc, 124);
    assert.ok(wall >= 1800, `killed too early: ${wall}ms`);
    assert.ok(wall < 6000, `killed too late: ${wall}ms`);
    const pid = readPid(taskDir(owner, id)) as number;
    assert.equal(await waitFor(() => (isAlive(pid) ? undefined : true), 3000), true, "process tree is gone");
    assert.equal(cli(["rc", id], owner).stdout.trim(), "124");
  }

  // --- bg has no deadline unless --timeout is explicit ---------------------
  {
    const owner = "cli-bg-no-deadline";
    const id = stage(owner, "sleep 5\n");
    const startedAt = Date.now();
    const bg = cli(["bg", id], owner);
    assert.equal(bg.status, 0, bg.stderr);
    const rc = await waitFor(() => readRc(taskDir(owner, id)), 12_000);
    assert.equal(rc, 0);
    assert.ok(Date.now() - startedAt >= 4500, "bg must not impose a default deadline");
  }
  {
    const owner = "cli-bg-deadline";
    const id = stage(owner, "sleep 30\n");
    const bg = cli(["bg", id, "--timeout", "1"], owner);
    assert.equal(bg.status, 0, bg.stderr);
    assert.equal(await waitFor(() => readRc(taskDir(owner, id)), 8000), 124);
  }

  // --- fg streams: the first line arrives before the process ends ----------
  {
    const owner = "cli-fg-stream";
    const id = stage(owner, "echo first-line\nsleep 2\necho second-line\n");
    const child = cliAsync(["fg", id], owner);
    let output = "";
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    const firstLine = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no streaming output: ${output}`)), 5000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("first-line")) {
          clearTimeout(timer);
          resolve(output);
        }
      });
    });
    assert.match(firstLine, /first-line/);
    assert.equal(exited, false, "the first line must arrive while fg is still running");

    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    assert.match(output, /second-line/);
    assert.equal(readRc(taskDir(owner, id)), 0);
    assert.match(readFileSync(join(taskDir(owner, id), "out.log"), "utf8"), /first-line[\s\S]*second-line/);
  }

  // --- fg passes the child's exit code through ----------------------------
  {
    const owner = "cli-fg-rc";
    const id = stage(owner, "echo boom\nexit 7\n");
    const fg = cli(["fg", id], owner);
    assert.equal(fg.status, 7);
    assert.match(fg.stdout, /boom/);
    assert.equal(readRc(taskDir(owner, id)), 7);

    // Already finished: never run it again.
    const again = cli(["fg", id], owner);
    assert.equal(again.status, 1);
    assert.match(again.stderr, new RegExp(`already consumed: ${id}`));
  }

  // --- fg --timeout hard-kills and returns 124 ---------------------------
  {
    const owner = "cli-fg-timeout";
    const id = stage(owner, "sleep 30\n");
    const fg = cli(["fg", id, "--timeout", "2"], owner);
    assert.equal(fg.status, 124);
    assert.equal(readRc(taskDir(owner, id)), 124);
  }

  // --- fg forwards TERM to the child's process group ----------------------
  {
    const owner = "cli-fg-term";
    const id = stage(owner, "sleep 30\n");
    const child = cliAsync(["fg", id], owner);
    const pid = await waitFor(() => {
      const candidate = readPid(taskDir(owner, id));
      return candidate && isAlive(candidate) ? candidate : undefined;
    }, 5000);
    assert.ok(pid, "fg should publish the child pid");
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(-1), 8000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    assert.equal(code, 143, `fg should exit 143, got ${code}`);
    assert.equal(await waitFor(() => (isAlive(pid) ? undefined : true), 5000), true, "child tree is killed");
    assert.equal(readRc(taskDir(owner, id)), 143);
  }

  // --- wait --for 1 does not kill a long-running task ---------------------
  {
    const owner = "cli-wait";
    const id = stage(owner, "sleep 30\n");
    const bg = cli(["bg", id], owner);
    assert.equal(bg.status, 0, bg.stderr);
    started.push({ owner, id });

    const wait = cli(["wait", id, "--for", "1"], owner);
    assert.equal(wait.status, 124);
    assert.match(wait.stdout, /still running after 1s/);
    assert.equal(readRc(taskDir(owner, id)), undefined, "wait must not kill the task");
    const pid = readPid(taskDir(owner, id)) as number;
    assert.equal(isAlive(pid), true);

    const stop = cli(["stop", id, "--owner", owner], owner);
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, new RegExp(`stopped ${id}`));
    const rc = await waitFor(() => readRc(taskDir(owner, id)), 5000);
    assert.ok(rc === 143 || rc === 137, `stop rc=${rc}`);
  }

  // --- staged but never started is cleaned up after an hour ----------------
  {
    const owner = "cli-cleanup";
    const staleId = stage(owner, "sleep 30\n", work, Date.now() - 2 * 60 * 60 * 1000);
    const freshId = stage(owner, "sleep 31\n");
    const ls = cli(["ls", "--owner", owner], owner);
    assert.equal(ls.status, 0, ls.stderr);
    assert.equal(existsSync(taskDir(owner, staleId)), false, "stale staged task is removed");
    assert.equal(existsSync(taskDir(owner, freshId)), true, "fresh staged task survives");
  }

  // --- read-only verbs default to the owner's most recent task -------------
  {
    const owner = "cli-recent";
    const older = stage(owner, "echo older\n", work, Date.now() - 5000);
    const newer = stage(owner, "echo newer\n", work, Date.now() - 1000);
    writeRc(taskDir(owner, older), 3);

    const rc = cli(["rc"], owner);
    assert.equal(rc.status, 0, rc.stderr);
    assert.equal(rc.stdout, `[cerberus] id=${newer} (most recent)\nrunning\n`);

    const log = cli(["log"], owner);
    assert.equal(log.status, 0, log.stderr);
    assert.equal(log.stdout, `[cerberus] id=${newer} (most recent)\n(no output yet)\n`);

    // Still running: wait times out without killing the task.
    const wait = cli(["wait", "--for", "1"], owner);
    assert.equal(wait.status, 124);
    assert.match(wait.stdout, new RegExp(`\\[cerberus\\] id=${newer} \\(most recent\\)`));
    assert.match(wait.stdout, /still running after 1s/);
    assert.equal(readRc(taskDir(owner, newer)), undefined);

    // Finished: wait returns the task's exit code.
    writeRc(taskDir(owner, newer), 0);
    const finished = cli(["wait", "--for", "1"], owner);
    assert.equal(finished.status, 0);
    assert.match(finished.stdout, new RegExp(`\\[cerberus\\] id=${newer} \\(most recent\\)`));
    assert.match(finished.stdout, /\(no output yet\)/);

    // A consumed tombstone is newer but has no runnable output, so it is skipped.
    const consumed = stage(owner, "echo consumed\n", work, Date.now());
    writeMeta(taskDir(owner, consumed), {
      state: "consumed",
      asked: 0,
      owner,
      cwd: work,
      cmdHash: cmdHash("echo consumed\n"),
      startedAt: Date.now(),
    });
    const afterConsumed = cli(["rc"], owner);
    assert.equal(afterConsumed.status, 0, afterConsumed.stderr);
    assert.equal(afterConsumed.stdout, `[cerberus] id=${newer} (most recent)\n0\n`);

    // A tie in startedAt resolves by task directory name (largest wins).
    const tieOwner = "cli-recent-tie";
    const tieAt = Date.now() - 2000;
    const first = stage(tieOwner, "echo tie-a\n", work, tieAt);
    const second = stage(tieOwner, "echo tie-b\n", work, tieAt);
    const expected = first > second ? first : second;
    const tie = cli(["rc"], tieOwner);
    assert.equal(tie.status, 0, tie.stderr);
    assert.match(tie.stdout, new RegExp(`\\[cerberus\\] id=${expected} \\(most recent\\)`));

    // Write/danger verbs still require an explicit id.
    for (const verb of ["bg", "fg", "stop"]) {
      const result = cli([verb], owner);
      assert.notEqual(result.status, 0, `${verb} without an id must fail`);
      assert.match(result.stderr, /missing id/, verb);
    }
  }

  // --- decisions: reap --decisions clears the memory ----------------------
  {
    const owner = "cli-decisions";
    const id = stage(owner, "echo hi\n");
    const bg = cli(["bg", id], owner);
    assert.equal(bg.status, 0, bg.stderr);
    assert.equal(await waitFor(() => readRc(taskDir(owner, id)), 10_000), 0);
    const decisions = join(state, "cerberus", "tasks", owner, "decisions.json");
    assert.equal(existsSync(decisions), true);

    const reap = cli(["reap", "--decisions", "--owner", owner], owner);
    assert.equal(reap.status, 0, reap.stderr);
    assert.match(reap.stdout, /cleared decisions/);
    assert.equal(existsSync(decisions), false);

    const none = cli(["reap", "--decisions", "--owner", owner], owner);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /no decisions to clear/);
  }
  // --- shim: link this CLI on PATH, refuse to clobber a real file ---------
  {
    const dir = mkdtempSync(join(tmpdir(), "cerberus-shim-"));
    const target = join(dir, "cerberus");

    const made = cli(["shim", "--dir", dir]);
    assert.equal(made.status, 0, made.stderr);
    assert.equal(readlinkSync(target), realpathSync(BIN));
    assert.match(cli(["shim", "--dir", dir]).stdout, /already present/);

    const removed = cli(["shim", "--dir", dir, "--remove"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(target), false);

    writeFileSync(target, "#!/bin/sh\n");
    const refused = cli(["shim", "--dir", dir]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not a symlink/);
    assert.equal(readFileSync(target, "utf8"), "#!/bin/sh\n");
    rmSync(dir, { recursive: true, force: true });
  }
  // --- ls shows the command: summary by default, everything with --full ----
  {
    const owner = "cli-ls";
    const multi = `${"cd /home/hv/projs/proj && ".padEnd(0)}for f in $(find tests -name 'test_*.py' | sort); do timeout 300 uv run --group test pytest -q "$f" >/tmp/l.log 2>&1 || echo "FAIL $f"; done\necho "done"
rm -f /tmp/l.log`;
    const oneLine = "timeout 1800 uv run --group test python -m pytest tests/ -q";
    const idMulti = stage(owner, multi);
    const idOne = stage(owner, oneLine);

    const plain = cli(["ls", "--owner", owner], owner);
    assert.equal(plain.status, 0, plain.stderr);
    const lineMulti = plain.stdout.split("\n").find((line) => line.includes(idMulti)) ?? "";
    const lineOne = plain.stdout.split("\n").find((line) => line.includes(idOne)) ?? "";
    // Multi-line commands are marked, not silently shortened.
    assert.match(lineMulti, /\(\+2 lines\)/);
    assert.ok(lineMulti.endsWith("... (+2 lines)"), lineMulti);
    // A single line that fits is shown whole, with no marker.
    assert.ok(lineOne.endsWith(oneLine), lineOne);
    assert.equal(plain.stdout.includes("echo \"done\""), false, "plain ls stays one line per task");

    const full = cli(["ls", "--owner", owner, "--full"], owner);
    assert.equal(full.status, 0, full.stderr);
    assert.match(full.stdout, /  \| echo "done"/);
    assert.match(full.stdout, /  \| rm -f \/tmp\/l\.log/);
    assert.match(full.stdout, /  \| timeout 1800 uv run --group test python -m pytest/);

    const json = JSON.parse(cli(["ls", "--owner", owner, "--json"], owner).stdout);
    const rowMulti = json.find((row: { id: string }) => row.id === idMulti);
    const rowOne = json.find((row: { id: string }) => row.id === idOne);
    assert.equal(rowMulti.cmd, multi, "json cmd is the command verbatim");
    assert.match(rowMulti.summary, /\(\+2 lines\)/);
    assert.equal(rowOne.cmd, oneLine);
    assert.equal(rowOne.summary, oneLine);
    assert.equal(rowMulti.dir, taskDir(owner, idMulti));
  }

  // --- the gate's own CLI answers immediately, never blocking --------------
  {
    const owner = "cli-fast";
    // A task that would block for a minute, plus a staged gate call.
    const slow = stage(owner, "sleep 60\n");
    const bg = cli(["bg", slow], owner);
    assert.equal(bg.status, 0, bg.stderr);
    started.push({ owner, id: slow });
    const gate = stage(owner, "cerberus fg 42\n");
    const doomed = stage(owner, "sleep 60\n");
    assert.equal(cli(["bg", doomed], owner).status, 0);
    const shimDir = mkdtempSync(join(tmpdir(), "cerberus-fast-"));

    const cases: Array<[string, string[]]> = [
      ["ls", ["ls", "--owner", owner]],
      ["log", ["log", slow]],
      ["rc", ["rc", slow]],
      ["reap --decisions", ["reap", "--decisions", "--owner", owner]],
      ["reap --all-stale", ["reap", "--all-stale"]],
      ["shim --quiet", ["shim", "--dir", shimDir, "--quiet"]],
      ["shim --remove", ["shim", "--dir", shimDir, "--remove"]],
      ["help", ["help"]],
      ["bg of a staged gate call", ["bg", gate]],
      ["fg of a staged gate call", ["fg", gate]],
      ["wait --for 1", ["wait", slow, "--for", "1"]],
    ];
    for (const [label, argv] of cases) {
      const began = Date.now();
      const out = cli(argv, owner);
      const ms = Date.now() - began;
      assert.ok(ms < 3000, `${label} must not block (took ${ms}ms)`);
      assert.equal(typeof out.status, "number", `${label}: ${out.stderr}${out.stdout}`);
    }

    // `stop` signals and reaps a real process; it must still be bounded.
    {
      const began = Date.now();
      const stopped = cli(["stop", doomed, "--force"], owner);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.ok(Date.now() - began < 5000, "stop must not block on the task");
      assert.notEqual(readRc(taskDir(owner, doomed)), undefined);
    }

    // A staged `cerberus ...` command is refused, never executed: running it would
    // make the gate wait on the gate.
    for (const verb of ["bg", "fg"]) {
      const refused = cli([verb, gate], owner);
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /staged command is the gate itself/);
    }
    assert.equal(readRc(taskDir(owner, gate)), undefined);
    assert.equal(readMeta(taskDir(owner, gate))?.state, "staged");

    // `wait` is the only command that waits, and it is capped (1s here).
    const began = Date.now();
    assert.equal(cli(["wait", slow, "--for", "1"], owner).status, 124);
    assert.ok(Date.now() - began < 3000, "wait --for 1 must be short");

    rmSync(shimDir, { recursive: true, force: true });
  }

} finally {
  for (const task of started) cli(["stop", task.id, "--owner", task.owner, "--force"], task.owner);
  await sleep(100);
  rmSync(state, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

console.log("cli.test.ts: ok");
