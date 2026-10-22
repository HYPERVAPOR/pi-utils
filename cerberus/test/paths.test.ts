/**
 * Self-check for paths.ts. Run with plain node (type stripping, no deps):
 *
 *   node cerberus/test/paths.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cerberus-paths-"));
process.env.XDG_STATE_HOME = root;

const {
  allocateTask,
  cerberusRoot,
  claimTask,
  cleanup,
  clearDecisions,
  cmdHash,
  cwdHash,
  decisionKey,
  decisionsPath,
  dirBytes,
  findStaged,
  listOwner,
  listTasks,
  ownerDir,
  readDecision,
  readMeta,
  readPid,
  readRc,
  RETENTION_BYTES,
  taskDir,
  tasksRoot,
  writeDecision,
  writeMeta,
  writePid,
  writeRc,
} = await import("../paths.ts");

const DAY = 24 * 60 * 60 * 1000;

// --- paths ----------------------------------------------------------------
assert.equal(cerberusRoot(), join(root, "cerberus"));
assert.equal(tasksRoot(), join(root, "cerberus", "tasks"));
assert.equal(ownerDir("sess-1"), join(root, "cerberus", "tasks", "sess-1"));
assert.equal(taskDir("sess-1", "abcd1234-2"), join(root, "cerberus", "tasks", "sess-1", "abcd1234-2"));

// Session ids are directory names, so separators cannot escape.
assert.equal(ownerDir("a/b"), join(root, "cerberus", "tasks", "a_b"));

// Without XDG_STATE_HOME the default is ~/.local/state. os.homedir() reads $HOME.
{
  const savedHome = process.env.HOME;
  const savedXdg = process.env.XDG_STATE_HOME;
  process.env.HOME = "/home/example";
  delete process.env.XDG_STATE_HOME;
  assert.equal(tasksRoot(), join("/home/example", ".local", "state", "cerberus", "tasks"));
  process.env.XDG_STATE_HOME = savedXdg;
  process.env.HOME = savedHome;
}

// --- id / attempt ---------------------------------------------------------
assert.match(cmdHash("echo hi"), /^[0-9a-f]{8}$/);
assert.equal(cmdHash("echo hi"), cmdHash("echo hi"));
assert.notEqual(cmdHash("echo hi"), cmdHash("echo hi "));
assert.equal(cmdHash(Buffer.from("echo hi")), cmdHash("echo hi"));
assert.match(cwdHash("/tmp/work"), /^[0-9a-f]{4}$/);

const hash = cmdHash("echo hi");
const first = allocateTask("owner-a", hash);
const second = allocateTask("owner-a", hash);
assert.equal(first.id, `${hash}-1`);
assert.equal(second.id, `${hash}-2`);
assert.equal(first.dir, taskDir("owner-a", first.id));
assert.equal(readdirSync(ownerDir("owner-a")).sort().join(","), `${hash}-1,${hash}-2`);

// The cwd is part of the directory name, so repo A and repo B cannot collide.
const inA = allocateTask("owner-a", hash, "/tmp/repo-a");
const inB = allocateTask("owner-a", hash, "/tmp/repo-b");
assert.equal(inA.id, `${hash}-${cwdHash("/tmp/repo-a")}-1`);
assert.equal(inB.id, `${hash}-${cwdHash("/tmp/repo-b")}-1`);
assert.notEqual(inA.id, inB.id);

// A different command gets its own attempt space.
assert.equal(allocateTask("owner-a", cmdHash("echo bye")).id, `${cmdHash("echo bye")}-1`);

// --- meta ----------------------------------------------------------------
const startedAt = Date.now() - 1234;
const meta = {
  owner: "owner-a",
  cwd: "/tmp/work",
  cmdHash: hash,
  startedAt,
  state: "running" as const,
  pid: 4242,
};
writeMeta(first.dir, meta);
assert.deepEqual(readMeta(first.dir), meta);

// Atomic: tmp file is renamed, never left behind, and a rewrite replaces cleanly.
assert.deepEqual(readdirSync(first.dir).filter((name) => name.includes(".tmp")), []);
writeMeta(first.dir, { ...meta, durationMs: 4321 });
assert.equal(readMeta(first.dir)?.durationMs, 4321);
assert.deepEqual(readdirSync(first.dir).filter((name) => name.includes(".tmp")), []);

writePid(first.dir, 4242);
assert.equal(readPid(first.dir), 4242);

assert.equal(readRc(first.dir), undefined);
writeRc(first.dir, 7);
assert.equal(readRc(first.dir), 7);
writeRc(first.dir, 0);
assert.equal(readRc(first.dir), 0);

// --- staged lookup is keyed by owner + cwd + hash, and only `staged` ------
{
  const staged = allocateTask("owner-stage", hash, "/tmp/repo-a");
  writeMeta(staged.dir, { ...meta, owner: "owner-stage", cwd: "/tmp/repo-a", state: "staged", asked: 1, pid: undefined });
  writeFileSync(join(staged.dir, "cmd.sh"), "echo hi\n");

  assert.equal(findStaged("owner-stage", "/tmp/repo-a", hash)?.id, staged.id);
  assert.equal(findStaged("owner-stage", "/tmp/repo-a/", hash)?.id, staged.id);
  assert.equal(findStaged("owner-stage", "/tmp/repo-b", hash), undefined);
  assert.equal(findStaged("owner-stage", "/tmp/repo-a", cmdHash("nope")), undefined);
  assert.equal(findStaged("other-owner", "/tmp/repo-a", hash), undefined);

  // Claim is atomic: exactly one winner.
  assert.equal(claimTask(staged), true);
  assert.equal(claimTask(staged), false);

  // Consumed / running / finished are never "still waiting for an answer".
  writeMeta(staged.dir, { ...meta, owner: "owner-stage", cwd: "/tmp/repo-a", state: "consumed", asked: 0 });
  assert.equal(findStaged("owner-stage", "/tmp/repo-a", hash), undefined);
  writeMeta(staged.dir, { ...meta, owner: "owner-stage", cwd: "/tmp/repo-a", state: "running" });
  assert.equal(findStaged("owner-stage", "/tmp/repo-a", hash), undefined);
}

// --- decisions survive reloads, are keyed by cwd, and can be cleared ------
{
  const cwd = "/tmp/repo-a";
  assert.equal(readDecision("owner-dec", cwd, hash), undefined);
  writeDecision("owner-dec", cwd, hash, "fg");
  assert.equal(readDecision("owner-dec", cwd, hash), "fg");
  assert.equal(readDecision("owner-dec", cwd, hash), readDecision("owner-dec", cwd + "/", hash));
  assert.equal(readDecision("owner-dec", "/tmp/repo-b", hash), undefined);
  assert.ok(decisionsPath("owner-dec").endsWith("decisions.json"));
  assert.match(decisionKey(cwd, hash), /^[0-9a-f]{8}:[0-9a-f]{8}$/);
  assert.deepEqual(readdirSync(ownerDir("owner-dec")).filter((name) => name.includes(".tmp")), []);

  writeDecision("owner-dec", cwd, hash, "bg");
  assert.equal(readDecision("owner-dec", cwd, hash), "bg");

  assert.deepEqual(clearDecisions("owner-dec"), ["owner-dec"]);
  assert.equal(existsSync(decisionsPath("owner-dec")), false);
  assert.equal(readDecision("owner-dec", cwd, hash), undefined);
  assert.deepEqual(clearDecisions("owner-dec"), []);
}

// --- retention: age, staged TTL ------------------------------------------
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "cerberus-age-"));
{
  const mk = (name: string, state: "staged" | "consumed" | "running" | "finished", ageMs: number, rc?: number) => {
    const task = allocateTask("owner-old", cmdHash(name));
    writeMeta(task.dir, {
      owner: "owner-old",
      cwd: "/tmp",
      cmdHash: cmdHash(name),
      startedAt: Date.now() - ageMs,
      state,
      pid: state === "running" ? process.pid : 1,
    });
    writeFileSync(join(task.dir, "cmd.sh"), `${name}\n`);
    if (rc !== undefined) writeRc(task.dir, rc);
    return task;
  };
  const old = mk("old", "finished", 8 * DAY, 0);
  const fresh = mk("fresh", "finished", 60_000, 0);
  const live = mk("live", "running", 30 * DAY);
  const stagedOld = mk("staged-old", "staged", 2 * 60 * 60 * 1000);
  const stagedFresh = mk("staged-fresh", "staged", 60_000);
  const consumedOld = mk("consumed-old", "consumed", 2 * 60 * 60 * 1000);

  const report = cleanup({ now: Date.now() });
  assert.deepEqual(report.expired, [old.id]);
  assert.deepEqual(report.staged.sort(), [consumedOld.id, stagedOld.id].sort());
  assert.deepEqual(
    listTasks().map((task) => task.id).sort(),
    [fresh.id, live.id, stagedFresh.id].sort(),
  );
  assert.equal(listOwner("owner-old").length, 3);
}

// --- retention: 500 MB ---------------------------------------------------
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "cerberus-size-"));
{
  const huge = 300 * 1024 * 1024;
  const mk = (name: string, ageMs: number) => {
    const task = allocateTask("owner-size", cmdHash(name));
    writeMeta(task.dir, {
      owner: "owner-size",
      cwd: "/tmp",
      cmdHash: cmdHash(name),
      startedAt: Date.now() - ageMs,
      state: "finished",
      pid: 1,
    });
    writeRc(task.dir, 0);
    writeFileSync(join(task.dir, "cmd.sh"), `${name}\n`);
    // Sparse file: 300 MB of logical size, no real disk usage.
    writeFileSync(join(task.dir, "out.log"), "");
    truncateSync(join(task.dir, "out.log"), huge);
    return task;
  };
  const oldTask = mk("old", 2 * 60 * 60 * 1000);
  const newTask = mk("new", 60 * 60 * 1000);
  // Running tasks count toward the total but must survive eviction.
  const liveTask = allocateTask("owner-size", cmdHash("live"));
  writeMeta(liveTask.dir, {
    owner: "owner-size",
    cwd: "/tmp",
    cmdHash: cmdHash("live"),
    startedAt: Date.now() - 3 * DAY,
    state: "running",
    pid: process.pid,
  });
  writeFileSync(join(liveTask.dir, "out.log"), "x".repeat(1024));

  assert.ok(dirBytes(oldTask.dir) >= huge);
  const report = cleanup();
  assert.deepEqual(report.evicted, [oldTask.id]);
  assert.deepEqual(
    listTasks().map((task) => task.id).sort(),
    [newTask.id, liveTask.id].sort(),
  );
  assert.ok(listTasks().reduce((sum, task) => sum + dirBytes(task.dir), 0) <= RETENTION_BYTES);
}

// --- cleanup leaves running tasks and empty state alone ------------------
{
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "cerberus-empty-"));
  assert.deepEqual(cleanup(), { expired: [], evicted: [], staged: [], freedBytes: 0 });
  assert.deepEqual(listTasks(), []);
}

rmSync(root, { recursive: true, force: true });
console.log("paths.test.ts: ok");
