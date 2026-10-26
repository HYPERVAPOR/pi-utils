/**
 * Self-check for cli.ts against real processes: bg / fg / ls / log / rc / wait,
 * streaming, timeouts, signal forwarding and staged retention.
 *
 *   node cerberus/test/cli.test.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_ENV } from "../nesting.ts";

const state = mkdtempSync(join(tmpdir(), "cerberus-cli-state-"));
const work = mkdtempSync(join(tmpdir(), "cerberus-cli-work-"));
process.env.XDG_STATE_HOME = state;
delete process.env.PI_SESSION_ID;
// Tests are scaffolding: when this suite runs under capture, its children must be
// able to drive the CLI (the nesting marker is about tasks, not tests).
delete process.env[TASK_ENV];

const BIN = join(import.meta.dirname, "..", "..", "bin", "cerberus");
const { taskShell } = await import("../runner.ts");
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
    assert.equal(bg.stdout, `cerberus: background id=${id} log=${join(dir, "out.log")}\n`);
    assert.match(bg.stdout, /^cerberus: /, "one prefix, lowercase");
    assert.doesNotMatch(bg.stdout, /rc=/, "rc is derivable from the log path");
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

  // --- fg and the supervisor run `<bash> -c <cmd.sh text>` -----------------
  {
    const owner = "cli-shell";
    // One shared helper feeds both paths, so this assertion covers fg and bg.
    const probe = allocateTask(owner, cmdHash("probe"), work);
    const probeText = "echo probe\n";
    writeFileSync(join(probe.dir, "cmd.sh"), probeText);
    const shell = taskShell(probe.dir);
    assert.match(shell.file, /(^|\/)bash$/, "the task shell must be bash");
    assert.deepEqual(shell.args, ["-c", probeText], "bash runs the exact cmd.sh text via -c");

    // The command sees a bash `-c` body, not a script file, and not $SHELL.
    const id = stage(owner, 'echo "shell=$0 flags=$- hasver=${BASH_VERSION:+yes}"\n');
    const savedShell = process.env.SHELL;
    process.env.SHELL = "/bin/false";
    try {
      const fg = cli(["fg", id], owner);
      assert.equal(fg.status, 0, fg.stderr);
      const log = readFileSync(join(taskDir(owner, id), "out.log"), "utf8");
      assert.match(log, /shell=(\S*\/)?bash/, "$0 is bash, so $SHELL was not used");
      assert.match(log, /flags=\S*c/, "the -c flag is set in the command body");
      assert.match(log, /hasver=yes/);
    } finally {
      if (savedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = savedShell;
    }

    // A `bash -c '...'` command survives the extra -c layer.
    const nested = stage(owner, `bash -c 'sleep 0.3; echo nested-ok'\n`);
    const fg = cli(["fg", nested], owner);
    assert.equal(fg.status, 0, fg.stderr);
    assert.match(fg.stdout, /nested-ok/);
    assert.equal(readRc(taskDir(owner, nested)), 0);
  }

  // --- tildify: home prints as ~ in the ls cwd column and the bg banner ---
  {
    const owner = "cli-tildify";
    const savedState = process.env.XDG_STATE_HOME;
    const homeState = mkdtempSync(join(homedir(), ".cerberus-tildify-"));
    process.env.XDG_STATE_HOME = homeState;
    // `cli()` pins the suite's own state root, so point at this one explicitly.
    const cliHere = (args: string[]) =>
      spawnSync(BIN, args, { env: { ...env(owner), XDG_STATE_HOME: homeState }, cwd: work, encoding: "utf8" });
    try {
      const id = stage(owner, "echo tildify\n");
      const bg = cliHere(["bg", id]);
      assert.equal(bg.status, 0, bg.stderr);
      assert.match(
        bg.stdout,
        /^cerberus: background id=\S+ log=~\/\.cerberus-tildify-[^/]+\/cerberus\/tasks\/cli-tildify\/[^/]+\/out\.log\n$/,
      );
      assert.doesNotMatch(bg.stdout, /rc=/);
      assert.equal(await waitFor(() => readRc(taskDir(owner, id)), 10_000), 0);

      const homeCwd = join(homedir(), "tildify-probe");
      stage(owner, "echo cwd\n", homeCwd);
      const ls = cliHere(["ls", "--owner", owner]);
      assert.equal(ls.status, 0, ls.stderr);
      assert.match(ls.stdout, / ~\/tildify-probe /, "the cwd column is tildified");
      const json = cliHere(["ls", "--owner", owner, "--json"]);
      assert.ok(JSON.parse(json.stdout).some((row: { cwd?: string }) => row.cwd === homeCwd), "--json keeps absolute paths");
    } finally {
      process.env.XDG_STATE_HOME = savedState;
      rmSync(homeState, { recursive: true, force: true });
    }
  }

  // --- mode: per session, with --default for the machine -------------------
  {
    const config = join(state, "cerberus", "config.json");
    const read = () => JSON.parse(readFileSync(config, "utf8"));
    const status = cli(["mode"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, "cerberus: mode off (default)\n", "off is the built-in default");

    const on = cli(["mode", "on"]);
    assert.equal(on.stdout, "cerberus: mode on (session cli-owner)\n");
    assert.deepEqual(read(), { default: "disabled", sessions: { "cli-owner": "capture" } });
    assert.equal(cli(["mode", "status"]).stdout, "cerberus: mode on (session cli-owner)\n");
    assert.equal(cli(["mode", "capture"]).stdout, "cerberus: mode on (session cli-owner)\n", "the mode's own word works");

    // Another session is untouched, and reads the switch back as the default.
    assert.equal(cli(["mode", "status"], "other").stdout, "cerberus: mode off (default)\n");
    assert.equal(cli(["mode", "off"], "other").stdout, "cerberus: mode off (session other)\n");
    assert.equal(cli(["mode", "status"]).stdout, "cerberus: mode on (session cli-owner)\n");
    assert.equal(cli(["mode", "--owner", "cli-owner", "disabled"]).stdout, "cerberus: mode off (session cli-owner)\n");
    assert.equal(cli(["mode", "status"]).stdout, "cerberus: mode off (session cli-owner)\n");

    // --default changes what sessions without an entry get; entries survive.
    assert.equal(cli(["mode", "on", "--default"]).stdout, "cerberus: mode on (default)\n");
    assert.equal(cli(["mode", "status"], "fresh").stdout, "cerberus: mode on (default)\n");
    assert.equal(cli(["mode", "status"]).stdout, "cerberus: mode off (session cli-owner)\n");
    assert.deepEqual(read(), { default: "capture", sessions: { "cli-owner": "disabled", other: "disabled" } });
    assert.equal(cli(["mode", "status", "--default"]).stdout, "cerberus: mode on (default)\n");

    // `gate` is retired: refused, with a hint, and nothing written.
    const retired = cli(["mode", "gate"]);
    assert.equal(retired.status, 2);
    assert.equal(retired.stderr, "cerberus: error: mode: gate is retired (use on or off)\n");
    assert.deepEqual(read(), { default: "capture", sessions: { "cli-owner": "disabled", other: "disabled" } });

    // A bad word changes nothing.
    const bad = cli(["mode", "bogus"]);
    assert.equal(bad.status, 2);
    assert.equal(bad.stderr, "cerberus: error: mode: expected on, off or status (got bogus)\n");
    assert.deepEqual(read(), { default: "capture", sessions: { "cli-owner": "disabled", other: "disabled" } });

    // No session and no --default: refuse rather than change the whole machine.
    const none = spawnSync(BIN, ["mode", "on"], {
      env: { ...process.env, XDG_STATE_HOME: state, PI_SESSION_ID: "" },
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(none.status, 2);
    assert.equal(none.stderr, "cerberus: error: mode: no session (pass --owner, set PI_SESSION_ID, or use --default)\n");
    assert.equal(JSON.parse(readFileSync(config, "utf8")).default, "capture", "nothing changed");

    // An old `{"mode": ...}` file is still the default, and a stored `gate` is off.
    writeFileSync(config, JSON.stringify({ mode: "capture" }));
    assert.equal(cli(["mode", "status"]).stdout, "cerberus: mode on (default)\n");
    writeFileSync(config, JSON.stringify({ mode: "gate" }));
    assert.equal(cli(["mode", "status"]).stdout, "cerberus: mode off (default)\n", "retired gate reads as off");
    rmSync(config);
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
    assert.equal(rc.stdout, "running\n", "rc keeps its bare value on stdout");
    assert.equal(rc.stderr, `cerberus: id=${newer} (most recent)\n`);

    const log = cli(["log"], owner);
    assert.equal(log.status, 0, log.stderr);
    assert.equal(log.stdout, "(no output yet)\n", "log output stays unprefixed");
    assert.equal(log.stderr, `cerberus: id=${newer} (most recent)\n`);

    // Still running: wait times out without killing the task.
    const wait = cli(["wait", "--for", "1"], owner);
    assert.equal(wait.status, 124);
    assert.equal(wait.stderr, `cerberus: id=${newer} (most recent)\n`);
    assert.match(wait.stdout, /^cerberus: still running after 1s/);
    assert.equal(readRc(taskDir(owner, newer)), undefined);

    // Finished: wait returns the task's exit code.
    writeRc(taskDir(owner, newer), 0);
    const finished = cli(["wait", "--for", "1"], owner);
    assert.equal(finished.status, 0);
    assert.equal(finished.stderr, `cerberus: id=${newer} (most recent)\n`);
    // A finished task prints what pi would have returned, including its empty text.
    assert.equal(finished.stdout, "(no output)\n");

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
    assert.equal(afterConsumed.stdout, "0\n");
    assert.equal(afterConsumed.stderr, `cerberus: id=${newer} (most recent)\n`);

    // A tie in startedAt resolves by task directory name (largest wins).
    const tieOwner = "cli-recent-tie";
    const tieAt = Date.now() - 2000;
    const first = stage(tieOwner, "echo tie-a\n", work, tieAt);
    const second = stage(tieOwner, "echo tie-b\n", work, tieAt);
    const expected = first > second ? first : second;
    const tie = cli(["rc"], tieOwner);
    assert.equal(tie.status, 0, tie.stderr);
    assert.equal(tie.stderr, `cerberus: id=${expected} (most recent)\n`);

    // Write/danger verbs still require an explicit id.
    for (const verb of ["bg", "fg", "stop"]) {
      const result = cli([verb], owner);
      assert.notEqual(result.status, 0, `${verb} without an id must fail`);
      assert.equal(result.stderr, `cerberus: error: ${verb}: missing id\n`, verb);
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

  // --- the runtime nesting guard ------------------------------------------
  {
    const owner = "cli-nested";
    const refused = spawnSync(BIN, ["ls"], {
      env: { ...env(owner), [TASK_ENV]: "task-abc" },
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(refused.status, 64, "a task's command cannot run the CLI");
    assert.match(refused.stderr, /refusing to run cerberus inside task task-abc/);
    assert.match(refused.stderr, /The cerberus call did not run/);
    assert.match(refused.stderr, /wait <id>/, "points at the right call");

    // Outside a task the very same call works.
    assert.equal(cli(["ls"], owner).status, 0);
  }

} finally {
  for (const task of started) cli(["stop", task.id, "--owner", task.owner, "--force"], task.owner);
  await sleep(100);
  rmSync(state, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

console.log("cli.test.ts: ok");
