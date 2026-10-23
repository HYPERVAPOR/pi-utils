/**
 * `cerberus` CLI: bg / fg / ls / log / rc / stop / reap / wait (+ internal __supervise).
 *
 * Every exported command takes an `Io` so tests can capture text without spawning
 * a process; `main(argv)` is the only thing bin/cerberus needs.
 */
import { accessSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { constants } from "node:os";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanup,
  clearDecisions,
  claimTask,
  isAlive,
  listOwner,
  listTasks,
  pidOf,
  readRc,
  safeName,
  taskStartedAt,
  tildify,
  writeDecision,
  type Task,
} from "./paths.ts";
import {
  TIMEOUT_RC,
  backgroundBanner,
  logPath,
  rcPath,
  readCapped,
  runForeground,
  startBackground,
  supervise,
  terminate,
} from "./runner.ts";
import { invokesGate } from "./rules.ts";

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** This package's own bin shim: cerberus/cli.ts -> <package>/bin/cerberus. */
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cerberus");
const SHIM_NAME = "cerberus";

export const DEFAULT_WAIT_FOR = 60;
export const MAX_WAIT_FOR = 300;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const stdIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Every diagnostic line starts here, so `cerberus: ` exists once. */
const note = (text: string): string => `cerberus: ${text}\n`;
/** Errors get one more level: `cerberus: error: …`. */
const fail = (text: string): string => `cerberus: error: ${text}\n`;

export const USAGE = `usage: cerberus <bg|fg|wait|ls|log|rc|stop|reap|shim> ...

  bg <id> [--timeout <sec>]  start a staged task in the background
  fg <id> [--timeout <sec>]  run a staged task in the foreground
  wait [<id>] [--for N]      block on an existing task (default 60s, max 300s)
  ls [--all] [--json] [--full] [--owner <sid>]   (--full prints the whole command)
  log [<id>] [-n N]
  rc [<id>]
  stop <id> [--force]
  reap [--owner <sid> | --all-stale] [--decisions] [--quiet] [--json]
  shim [--dir <dir>] [--remove] [--quiet]   link this CLI into a directory on PATH

With no <id>, log/rc/wait use the most recent task of the current owner.
`;

const VALUE_FLAGS = new Set(["owner", "for", "timeout", "n", "dir"]);

export interface Args {
  values: Record<string, string>;
  bools: Set<string>;
  pos: string[];
}

/** Tiny flag parser: `--k v`, `--k=v`, `-n v`, `--` ends flag parsing. */
export function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        values[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const name = arg.slice(2);
      if (VALUE_FLAGS.has(name)) values[name] = argv[++i] ?? "";
      else bools.add(name);
    } else if (arg.startsWith("-") && arg.length > 1) {
      const name = arg.slice(1);
      if (VALUE_FLAGS.has(name)) values[name] = argv[++i] ?? "";
      else bools.add(name);
    } else {
      pos.push(arg);
    }
  }
  return { values, bools, pos };
}

export function ownerFrom(args: Args): string | undefined {
  return args.values.owner || process.env.PI_SESSION_ID || undefined;
}

/** Newest task with this id: the current owner wins, then any owner. */
export function findTask(id: string, owner?: string): Task | undefined {
  const pick = (tasks: Task[]) =>
    tasks.filter((task) => task.id === id).sort((a, b) => taskStartedAt(b) - taskStartedAt(a))[0];
  if (owner) {
    const own = pick(listOwner(owner));
    if (own) return own;
  }
  return pick(listTasks());
}

/** Most recent usable task of one owner; ties fall back to the directory name. */
export function mostRecentTask(owner: string): Task | undefined {
  return listOwner(owner)
    .filter((task) => task.meta?.state !== "consumed")
    .sort((a, b) => {
      const byTime = taskStartedAt(b) - taskStartedAt(a);
      if (byTime !== 0) return byTime;
      return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
    })[0];
}

interface ReadTarget {
  task: Task;
  mostRecent: boolean;
}

/** Resolve an optional id for a read-only verb; a number means the exit code. */
function readTarget(args: Args, command: string, io: Io): ReadTarget | number {
  const id = args.pos[0];
  const owner = ownerFrom(args);
  if (id) {
    const task = findTask(id, owner);
    if (!task) {
      io.err(fail(`${command}: no task ${id}`));
      return 1;
    }
    return { task, mostRecent: false };
  }
  if (!owner) {
    io.err(fail(`${command}: missing id (no owner for the most recent task)`));
    return 2;
  }
  const task = mostRecentTask(owner);
  if (!task) {
    io.err(fail(`${command}: no task for owner ${owner}`));
    return 1;
  }
  return { task, mostRecent: true };
}

/** Which task a bare `log`/`rc`/`wait` picked: stderr, so stdout stays the payload. */
function echoMostRecent(target: ReadTarget, io: Io): void {
  if (target.mostRecent) io.err(note(`id=${target.task.id} (most recent)`));
}

/** The staged command exactly as it was asked, multi-line and all. */
export function commandText(dir: string): string {
  try {
    return readFileSync(join(dir, "cmd.sh"), "utf8").replace(/\s+$/, "");
  } catch {
    return "";
  }
}

/** One compact line for `ls`: first line, capped, with a marker for the rest. */
export function commandSummary(dir: string): string {
  const text = commandText(dir);
  if (text === "") return "?";
  const lines = text.split("\n");
  const head = lines[0].trim();
  const shown = head.length > 100 ? `${head.slice(0, 97)}...` : head;
  return lines.length > 1 ? `${shown} (+${lines.length - 1} lines)` : shown;
}

export interface TaskRow {
  id: string;
  owner: string;
  state: string;
  elapsedMs: number;
  cwd?: string;
  /** the command verbatim, every line */
  cmd: string;
  /** first line, capped: what the text listing shows */
  summary: string;
  startedAt: number;
  pid?: number;
  rc: number | null;
  log: string;
  dir: string;
}

function finishedAt(task: Task): number | undefined {
  try {
    return statSync(rcPath(task.dir)).mtimeMs;
  } catch {
    return undefined;
  }
}

export function taskRows(tasks: Task[], now = Date.now()): TaskRow[] {
  return tasks.map((task) => {
    const rc = readRc(task.dir);
    const pid = pidOf(task);
    const startedAt = taskStartedAt(task);
    const state =
      task.meta?.state === "staged" || task.meta?.state === "consumed"
        ? task.meta.state
        : rc !== undefined
          ? `exit=${rc}`
          : isAlive(pid)
            ? "running"
            : "dead";
    const elapsedMs =
      rc === undefined ? now - startedAt : (task.meta?.durationMs ?? (finishedAt(task) ?? now) - startedAt);
    return {
      id: task.id,
      owner: task.meta?.owner ?? task.owner,
      state,
      elapsedMs,
      cwd: task.meta?.cwd,
      cmd: commandText(task.dir),
      summary: commandSummary(task.dir),
      startedAt,
      pid,
      rc: rc ?? null,
      log: logPath(task.dir),
      dir: task.dir,
    };
  });
}

export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m${rem}s` : `${min}m`;
  const hours = Math.floor(min / 60);
  const min2 = min % 60;
  return min2 ? `${hours}h${min2}m` : `${hours}h`;
}

function logTailOf(dir: string, lines: number): string {
  const capped = readCapped(logPath(dir), 4 * 1024 * 1024);
  if (capped.totalBytes === 0) return "";
  const all = capped.text.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const tail = all.slice(-Math.max(1, lines));
  return tail.length > 0 ? `${tail.join("\n")}\n` : "";
}

/** Same shape for `log` and `wait`, including the empty-log case. */
function logText(dir: string, lines = 50): string {
  const text = logTailOf(dir, lines);
  return text === "" ? "(no output yet)\n" : text;
}

function positiveSeconds(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : undefined;
}

function alreadyConsumed(id: string, io: Io): number {
  io.err(fail(`already consumed: ${id}`));
  return 1;
}

/** The full staged command bytes, or "" when they cannot be read. */
function readCmd(dir: string): string {
  try {
    return readFileSync(join(dir, "cmd.sh"), "utf8");
  } catch {
    return "";
  }
}

/** A task can be started only if it is still staged and has never run. */
function claimable(task: Task, id: string, io: Io): boolean {
  if (task.meta?.state !== "staged" || readRc(task.dir) !== undefined) {
    alreadyConsumed(id, io);
    return false;
  }
  if (invokesGate(readCmd(task.dir))) {
    // A staged `cerberus fg ...` is the gate answering itself: the inner call would
    // wait on a task while this one waits on the inner call. Refuse, never hang.
    io.err(fail(`${id}: staged command is the gate itself; not running it`));
    return false;
  }
  if (!claimTask(task)) {
    alreadyConsumed(id, io);
    return false;
  }
  return true;
}

function recordDecision(task: Task, decision: "fg" | "bg"): void {
  const meta = task.meta;
  if (!meta) return;
  try {
    writeDecision(meta.owner, meta.cwd, meta.cmdHash, decision);
  } catch {
    // remembering an answer is best-effort; the run already happened
  }
}

export function bgCommand(args: Args, io: Io = stdIo): number {
  const id = args.pos[0];
  if (!id) {
    io.err(fail("bg: missing id"));
    return 2;
  }
  const task = findTask(id, ownerFrom(args));
  if (!task) {
    io.err(fail(`bg: no task ${id}`));
    return 1;
  }
  if (!claimable(task, id, io)) return 1;
  const started = startBackground(task, positiveSeconds(args.values.timeout));
  recordDecision(task, "bg");
  io.out(`${backgroundBanner(task.id, started.log)}\n`);
  return 0;
}

export async function fgCommand(args: Args, io: Io = stdIo): Promise<number> {
  const id = args.pos[0];
  if (!id) {
    io.err(fail("fg: missing id"));
    return 2;
  }
  const task = findTask(id, ownerFrom(args));
  if (!task) {
    io.err(fail(`fg: no task ${id}`));
    return 1;
  }
  if (!claimable(task, id, io)) return 1;
  const code = await runForeground(task, positiveSeconds(args.values.timeout));
  recordDecision(task, "fg");
  return code;
}

export function lsCommand(args: Args, io: Io = stdIo): number {
  const all = args.bools.has("all");
  const owner = ownerFrom(args);
  if (!all && !owner) {
    io.err(fail("ls: no owner (pass --owner, set PI_SESSION_ID, or use --all)"));
    return 2;
  }
  let tasks = listTasks();
  if (!all && owner) {
    const wanted = safeName(owner);
    tasks = tasks.filter((task) => task.owner === wanted);
  }
  const rows = taskRows(tasks).sort((a, b) => b.startedAt - a.startedAt);
  if (args.bools.has("json")) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    io.out("no tasks\n");
    return 0;
  }
  const full = args.bools.has("full");
  for (const row of rows) {
    io.out(
      `${row.id}  ${row.state}  ${formatElapsed(row.elapsedMs)}  ${row.cwd ? tildify(row.cwd) : "?"}  ${row.summary}\n`,
    );
    if (!full) continue;
    // The whole command, so a truncated or multi-line one is still readable.
    for (const line of row.cmd.split("\n")) io.out(`  | ${line}\n`);
  }
  return 0;
}

export function logCommand(args: Args, io: Io = stdIo): number {
  const target = readTarget(args, "log", io);
  if (typeof target === "number") return target;
  echoMostRecent(target, io);
  const lines = Number(args.values.n ?? 50);
  io.out(logText(target.task.dir, Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 50));
  return 0;
}

export function rcCommand(args: Args, io: Io = stdIo): number {
  const target = readTarget(args, "rc", io);
  if (typeof target === "number") return target;
  echoMostRecent(target, io);
  const rc = readRc(target.task.dir);
  io.out(rc === undefined ? "running\n" : `${rc}\n`);
  return 0;
}

/** `--for` for `wait`: 60s by default, never more than 300s. */
export function clampWaitSec(value: unknown): number {
  const sec = Number(value);
  if (value === undefined || value === "" || !Number.isFinite(sec) || sec <= 0) return DEFAULT_WAIT_FOR;
  return Math.min(MAX_WAIT_FOR, Math.max(1, Math.floor(sec)));
}

/**
 * Wait for an existing task, not for a command: it only reads `rc` and the log, so
 * interrupting it drops the wait and leaves the task running.
 */
export async function waitCommand(args: Args, io: Io = stdIo): Promise<number> {
  const target = readTarget(args, "wait", io);
  if (typeof target === "number") return target;
  echoMostRecent(target, io);
  const task = target.task;
  const seconds = clampWaitSec(args.values.for);
  const startedAt = taskStartedAt(task);
  const deadline = Date.now() + seconds * 1000;
  let rc = readRc(task.dir);
  while (rc === undefined && Date.now() < deadline) {
    await delay(100);
    rc = readRc(task.dir);
  }

  if (rc !== undefined) {
    io.out(logText(task.dir));
    return rc;
  }

  const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  io.out(note(`still running after ${seconds}s (${elapsed}s total); rc empty`));
  io.out(logText(task.dir));
  return TIMEOUT_RC;
}

export async function stopCommand(args: Args, io: Io = stdIo): Promise<number> {
  const id = args.pos[0];
  if (!id) {
    io.err(fail("stop: missing id"));
    return 2;
  }
  const owner = ownerFrom(args);
  const task = findTask(id, owner);
  if (!task) {
    io.err(fail(`stop: no task ${id}`));
    return 1;
  }
  if (!args.bools.has("force") && owner && task.owner !== safeName(owner)) {
    io.err(fail(`stop: ${id} belongs to owner ${task.meta?.owner ?? task.owner}; pass --force`));
    return 1;
  }
  const before = readRc(task.dir);
  if (before !== undefined) {
    io.out(note(`${id} already finished (rc=${before})`));
    return 0;
  }
  const signalled = await terminate(task);
  if (!signalled) {
    io.out(note(`${id} is not running`));
    return 0;
  }
  const rc = readRc(task.dir);
  io.out(note(`stopped ${id}${rc === undefined ? "" : ` (rc=${rc})`}`));
  return 0;
}

/** True when some live process belongs to this owner session. */
export function ownerLive(owner: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return true; // no /proc: never call anything orphaned
  }
  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(owner)) return true;
    } catch {
      // gone or unreadable
    }
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PI_SESSION_ID=${owner}`)) return true;
    } catch {
      // gone or unreadable
    }
  }
  return false;
}

export interface ReapReport {
  killed: string[];
  stale: string[];
  orphaned: string[];
}

export async function reapCommand(args: Args, io: Io = stdIo): Promise<number> {
  const quiet = args.bools.has("quiet");
  if (args.bools.has("decisions")) {
    const all = args.bools.has("all") || args.bools.has("all-stale");
    const owner = all ? undefined : ownerFrom(args);
    if (!all && !owner) {
      io.err(fail("reap --decisions: no owner (pass --owner, set PI_SESSION_ID, or use --all)"));
      return 2;
    }
    const removed = clearDecisions(owner);
    if (!quiet) {
      io.out(
        removed.length === 0
          ? note("no decisions to clear")
          : note(`cleared decisions for ${removed.join(", ")}`),
      );
    }
    return 0;
  }

  const report: ReapReport = { killed: [], stale: [], orphaned: [] };
  const allStale = args.bools.has("all-stale");
  const owner = ownerFrom(args);

  if (allStale) {
    for (const task of listTasks()) {
      if (task.meta?.state === "staged" || task.meta?.state === "consumed") continue;
      if (readRc(task.dir) !== undefined) continue;
      if (!isAlive(pidOf(task))) {
        try {
          rmSync(task.dir, { recursive: true, force: true });
          report.stale.push(task.id);
        } catch {
          // ignore
        }
        continue;
      }
      if (!ownerLive(task.meta?.owner ?? task.owner)) report.orphaned.push(task.id);
    }
  } else if (owner) {
    for (const task of listOwner(owner)) {
      if (task.meta?.state === "staged" || task.meta?.state === "consumed") continue;
      if (readRc(task.dir) !== undefined) continue;
      if (!isAlive(pidOf(task))) continue;
      if (await terminate(task)) report.killed.push(task.id);
    }
  }

  if (!quiet) {
    if (args.bools.has("json")) {
      io.out(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const id of report.killed) io.out(note(`reaped ${id}`));
      for (const id of report.stale) io.out(note(`removed stale ${id}`));
      if (report.orphaned.length > 0) {
        io.out(note(`orphaned: ${report.orphaned.length} (see --json)`));
      }
      if (report.killed.length + report.stale.length + report.orphaned.length === 0) {
        io.out(note("nothing to reap"));
      }
    }
  }
  return 0;
}

/**
 * Directories that are usually already on PATH, most specific first: pi's own bin
 * (where its launcher lives), then the conventional user bin.
 */
function shimDirs(): string[] {
  const dirs = [process.env.PI_BIN_DIR, join(homedir(), ".pi", "agent", "bin"), join(homedir(), ".local", "bin")];
  return [...new Set(dirs.filter((dir): dir is string => typeof dir === "string" && dir.length > 0).map((d) => resolve(d)))];
}

function onPath(dir: string): boolean {
  const real = resolve(dir);
  return (process.env.PATH ?? "").split(delimiter).some((entry) => entry !== "" && resolve(entry) === real);
}

function writableDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when `path` is a symlink that resolves to `target`. */
function isLinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && realpathSync(path) === target;
  } catch {
    return false;
  }
}

/**
 * Put a `cerberus` symlink on PATH, so prompts and tool results can show the short
 * name instead of an absolute install path. `npm install` runs this with --quiet
 * (see the postinstall script), so a `pi install git:...` sets it up without a
 * second step. Nothing depends on it: without a shim the extension prints the
 * absolute path of the package it was loaded from.
 */
export function shimCommand(args: Args, io: Io = stdIo): number {
  const self = realpathSync(CLI_PATH);
  const link = (dir: string) => join(dir, SHIM_NAME);
  const explicit = args.values.dir ? resolve(args.values.dir) : undefined;

  if (args.bools.has("remove")) {
    const dir = explicit ?? shimDirs().find((candidate) => isLinkTo(link(candidate), self));
    if (!dir) {
      io.err(fail(`shim: no ${SHIM_NAME} link of this package found`));
      return 1;
    }
    try {
      rmSync(link(dir));
    } catch (err) {
      io.err(fail(`shim: ${(err as Error).message}`));
      return 1;
    }
    io.out(note(`shim removed: ${link(dir)}`));
    return 0;
  }

  const dir = explicit ?? shimDirs().find((d) => writableDir(d) && onPath(d)) ?? shimDirs().find(writableDir);
  if (!dir) {
    io.err(fail(`shim: no writable directory; pass --dir <dir> (tried ${shimDirs().join(", ")})`));
    return 1;
  }
  if (!writableDir(dir)) {
    io.err(fail(`shim: ${dir} is not a writable directory`));
    return 1;
  }

  const target = link(dir);
  if (isLinkTo(target, self)) {
    if (!args.bools.has("quiet")) io.out(note(`shim already present: ${target}`));
    return 0;
  }
  // Only ever replace our own symlink; a real file there belongs to someone else.
  if (isSymlink(target)) rmSync(target);
  else if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    io.err(fail(`shim: ${target} exists and is not a symlink; leaving it alone`));
    return 1;
  }
  symlinkSync(self, target);
  if (args.bools.has("quiet")) return 0;
  io.out(note(`shim -> ${target}${onPath(dir) ? "" : ` (warning: ${dir} is not on PATH)`}`));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  try {
    cleanup();
  } catch {
    // retention is best-effort, never a reason to fail a command
  }
  const [command = "", ...rest] = argv;
  const args = parseArgs(rest);
  try {
    switch (command) {
      case "bg":
        return bgCommand(args);
      case "fg":
        return await fgCommand(args);
      case "__supervise": {
        const dir = args.pos[0];
        if (!dir) {
          process.stderr.write(fail("__supervise: missing task dir"));
          return 2;
        }
        const deadlineSec = args.pos[1] === undefined ? undefined : Number(args.pos[1]);
        return await supervise(resolve(dir), Number.isFinite(deadlineSec) ? deadlineSec : undefined);
      }
      case "wait":
        return await waitCommand(args);
      case "ls":
        return lsCommand(args);
      case "log":
        return logCommand(args);
      case "rc":
        return rcCommand(args);
      case "stop":
        return await stopCommand(args);
      case "reap":
        return await reapCommand(args);
      case "shim":
        return shimCommand(args);
      case "help":
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        return 0;
      default:
        process.stderr.write(USAGE);
        return 2;
    }
  } catch (err) {
    process.stderr.write(fail((err as Error).message));
    return 1;
  }
}
