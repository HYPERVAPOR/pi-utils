/**
 * cerberus state layout.
 *
 *   $XDG_STATE_HOME (or ~/.local/state)/cerberus/
 *     tasks/<ownerSessionId>/<id>/   cmd.sh out.log rc pid meta.json
 *
 * <id> = sha256(cmdText).slice(0, 8) + "-" + cwd fingerprint + "-" + attempt
 * (from 1). The cwd keeps identical commands from two checkouts apart, and the
 * attempt keeps a re-run of the same command from colliding with the old task.
 *
 * `startedAt` is epoch milliseconds. meta.json is written atomically (tmp + rename)
 * so a reader never sees a half-written file.
 *
 * A task starts `staged`: the gate saved the command and asked the model whether to
 * run it in the foreground or the background. `bg` / `fg` then move it to `running`.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RETENTION_BYTES = 500 * 1024 * 1024;
/** An unanswered staged command is dropped after an hour. */
export const STAGED_TTL_MS = 60 * 60 * 1000;

/**
 * How the bash tool behaves.
 *
 * `gate` keeps the original gate: rules pick the few commands that look long and
 * ask before anything runs. `capture` runs every command and only gives up on the
 * result after the budget, leaving the rest of the task running. `disabled` is
 * cerberus out of the way: no rules, no questions, no tasks, plain pi.
 */
export type Mode = "gate" | "capture" | "disabled";

export const MODES: readonly Mode[] = ["gate", "capture", "disabled"];

export const DEFAULT_MODE: Mode = "gate";

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export interface TaskMeta {
  owner: string;
  cwd: string;
  cmdHash: string;
  /** epoch ms */
  startedAt: number;
  state: "staged" | "consumed" | "running" | "finished";
  /** how many times the gate blocked this command; 0 once the model answered */
  asked?: number;
  pid?: number;
  /** set once the task finished */
  durationMs?: number;
}

export interface Task {
  owner: string;
  id: string;
  dir: string;
  meta?: TaskMeta;
}

export function cerberusRoot(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "cerberus");
}

export function tasksRoot(): string {
  return join(cerberusRoot(), "tasks");
}

export function configPath(): string {
  return join(cerberusRoot(), "config.json");
}

/** `{"default": ..., "sessions": {...}}`, with the pre-v2.1 `{"mode": ...}` read as default. */
export interface Config {
  default: Mode;
  sessions: Record<string, Mode>;
}

export function readConfig(): Config {
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return { default: DEFAULT_MODE, sessions: {} };
  }
  const sessions: Record<string, Mode> = {};
  for (const [owner, mode] of Object.entries(parsed?.sessions ?? {})) {
    if (isMode(mode)) sessions[owner] = mode;
  }
  // `{"mode": "capture"}` was the whole machine's mode; it becomes the default.
  const fallback = isMode(parsed?.default) ? parsed.default : isMode(parsed?.mode) ? parsed.mode : DEFAULT_MODE;
  return { default: fallback, sessions };
}

/**
 * The mode that applies to `owner`: the session entry first, then the default, then
 * `DEFAULT_MODE`. Read per call, so a switch takes effect without a restart.
 */
export function readMode(owner?: string): Mode {
  const config = readConfig();
  return (owner ? config.sessions[owner] : undefined) ?? config.default;
}

/** Where `readMode(owner)` got its answer, for `status` to say out loud. */
export function modeSource(owner?: string): "session" | "default" {
  const config = readConfig();
  return owner && config.sessions[owner] ? "session" : "default";
}

/**
 * Set the mode for one session (`owner`) or for the machine (`default`). Other
 * sessions keep theirs, and nothing is written unless asked.
 */
export function writeMode(mode: Mode, owner?: string): void {
  const config = readConfig();
  if (owner) config.sessions[owner] = mode;
  else config.default = mode;
  mkdirSync(cerberusRoot(), { recursive: true });
  writeAtomic(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

/** Session ids are used as directory names, so keep them to a safe alphabet. */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_") || "_";
}

export function ownerDir(owner: string): string {
  return join(tasksRoot(), safeName(owner));
}

export function taskDir(owner: string, id: string): string {
  return join(ownerDir(owner), id);
}

/**
 * `$HOME/x` -> `~/x`, for paths printed to the model. Only a whole path component
 * matches: `/home/hvx/y` is somebody else's directory and stays as it is.
 */
export function tildify(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function cmdHash(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** A short, stable fingerprint of a working directory. */
export function cwdHash(cwd: string): string {
  return cmdHash(resolve(cwd)).slice(0, 4);
}

export function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function writeMeta(dir: string, meta: TaskMeta): void {
  writeAtomic(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

export function readMeta(dir: string): TaskMeta | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as TaskMeta;
  } catch {
    return undefined;
  }
}

/** undefined means "still running" (no rc yet). */
export function readRc(dir: string): number | undefined {
  try {
    const raw = readFileSync(join(dir, "rc"), "utf8").trim();
    if (raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export function writeRc(dir: string, code: number): void {
  writeAtomic(join(dir, "rc"), `${code}\n`);
}

export function readPid(dir: string): number | undefined {
  try {
    const n = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function writePid(dir: string, pid: number): void {
  writeAtomic(join(dir, "pid"), `${pid}\n`);
}

export function pidOf(task: Task): number | undefined {
  const pid = task.meta?.pid ?? readPid(task.dir);
  return pid && pid > 0 ? pid : undefined;
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Create a fresh task directory. `mkdirSync` without `recursive` doubles as the
 * attempt lock: an existing directory means that attempt is taken.
 *
 * The id carries a short cwd fingerprint so two `npm test` tasks from different
 * checkouts are visibly different and never share a directory prefix.
 */
export function allocateTask(
  owner: string,
  hash: string,
  cwd?: string,
): { id: string; dir: string; attempt: number } {
  const parent = ownerDir(owner);
  mkdirSync(parent, { recursive: true });
  const prefix = cwd === undefined ? hash : `${hash}-${cwdHash(cwd)}`;
  for (let attempt = 1; attempt < 10_000; attempt++) {
    const id = `${prefix}-${attempt}`;
    const dir = join(parent, id);
    try {
      mkdirSync(dir);
      return { id, dir, attempt };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`cerberus: no free attempt for ${prefix}`);
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Every task under `root` (default: all owners). Owners come from directory names. */
export function listTasks(root: string = tasksRoot()): Task[] {
  const tasks: Task[] = [];
  for (const owner of subdirs(root)) {
    for (const id of subdirs(join(root, owner))) {
      const dir = join(root, owner, id);
      tasks.push({ owner, id, dir, meta: readMeta(dir) });
    }
  }
  return tasks;
}

/** Tasks of one owner. */
export function listOwner(owner: string): Task[] {
  const name = safeName(owner);
  const dir = ownerDir(owner);
  return subdirs(dir).map((id) => {
    const taskDirPath = join(dir, id);
    return { owner: name, id, dir: taskDirPath, meta: readMeta(taskDirPath) };
  });
}

/**
 * The unanswered staged task for this command in this directory. Only `staged`
 * counts: a consumed, running or finished task is a past decision, not an answer
 * to the current call.
 */
export function findStaged(owner: string, cwd: string, hash: string): Task | undefined {
  const want = resolve(cwd);
  return listOwner(owner)
    .filter(
      (task) =>
        task.meta?.state === "staged" &&
        task.meta.cmdHash === hash &&
        task.meta.cwd !== undefined &&
        resolve(task.meta.cwd) === want &&
        readRc(task.dir) === undefined,
    )
    .sort((a, b) => taskStartedAt(b) - taskStartedAt(a))[0];
}

/**
 * Atomically claim a staged task for exactly one run. The `started` marker is
 * created with O_EXCL, so two concurrent `fg`/`bg` calls cannot both win.
 */
export function claimTask(task: Task): boolean {
  try {
    writeFileSync(join(task.dir, "started"), `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Per-session answers, keyed by (cwd, command hash) and stored next to the tasks.
 * They survive extension reloads and `/new` changes the owner, so they expire with
 * the session. `reap --decisions` is the manual escape hatch.
 */
export type Decision = "fg" | "bg";

interface DecisionEntry {
  decision: Decision;
  cwd: string;
  cmdHash: string;
  at: number;
}

type DecisionFile = Record<string, DecisionEntry>;

export function decisionsPath(owner: string): string {
  return join(ownerDir(owner), "decisions.json");
}

export function decisionKey(cwd: string, hash: string): string {
  return `${cmdHash(resolve(cwd))}:${hash}`;
}

function readDecisionFile(owner: string): DecisionFile {
  try {
    const parsed = JSON.parse(readFileSync(decisionsPath(owner), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as DecisionFile) : {};
  } catch {
    return {};
  }
}

export function readDecision(owner: string, cwd: string, hash: string): Decision | undefined {
  const entry = readDecisionFile(owner)[decisionKey(cwd, hash)];
  return entry?.decision === "fg" || entry?.decision === "bg" ? entry.decision : undefined;
}

export function writeDecision(owner: string, cwd: string, hash: string, decision: Decision): void {
  mkdirSync(ownerDir(owner), { recursive: true });
  const all = readDecisionFile(owner);
  all[decisionKey(cwd, hash)] = { decision, cwd: resolve(cwd), cmdHash: hash, at: Date.now() };
  writeAtomic(decisionsPath(owner), JSON.stringify(all, null, 2));
}

/** Remove decision memories: one owner, or every owner when `owner` is omitted. */
export function clearDecisions(owner?: string): string[] {
  const names = owner === undefined ? subdirs(tasksRoot()) : [safeName(owner)];
  const removed: string[] = [];
  for (const name of names) {
    try {
      rmSync(join(tasksRoot(), name, "decisions.json"));
      removed.push(name);
    } catch {
      // no decisions for this owner
    }
  }
  return removed;
}

export function taskStartedAt(task: Task): number {
  if (task.meta?.startedAt) return task.meta.startedAt;
  try {
    return statSync(task.dir).mtimeMs;
  } catch {
    return 0;
  }
}

export function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        total += statSync(join(dir, entry.name)).size;
      } catch {
        // raced with a cleanup; ignore
      }
    }
  } catch {
    return 0;
  }
  return total;
}

export interface CleanupOptions {
  now?: number;
  maxAgeMs?: number;
  maxBytes?: number;
  stagedTtlMs?: number;
}

export interface CleanupResult {
  expired: string[];
  evicted: string[];
  staged: string[];
  freedBytes: number;
}

/**
 * Retention: drop unanswered staged commands after an hour, finished tasks older
 * than 7 days, then evict the oldest finished tasks until the whole tree is back
 * under 500 MB. Running tasks are never touched.
 */
export function cleanup(options: CleanupOptions = {}): CleanupResult {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? RETENTION_MS;
  const maxBytes = options.maxBytes ?? RETENTION_BYTES;
  const stagedTtlMs = options.stagedTtlMs ?? STAGED_TTL_MS;
  const result: CleanupResult = { expired: [], evicted: [], staged: [], freedBytes: 0 };

  for (const task of listTasks()) {
    if (task.meta?.state === "staged" || task.meta?.state === "consumed") {
      if (readRc(task.dir) !== undefined || now - taskStartedAt(task) <= stagedTtlMs) continue;
      result.freedBytes += dirBytes(task.dir);
      try {
        rmSync(task.dir, { recursive: true, force: true });
        result.staged.push(task.id);
      } catch {
        // another process is cleaning up; ignore
      }
      continue;
    }
    if (readRc(task.dir) === undefined) continue;
    if (now - taskStartedAt(task) <= maxAgeMs) continue;
    result.freedBytes += dirBytes(task.dir);
    try {
      rmSync(task.dir, { recursive: true, force: true });
      result.expired.push(task.id);
    } catch {
      // another process is cleaning up; ignore
    }
  }

  const tasks = listTasks();
  const finished = tasks
    .filter((task) => readRc(task.dir) !== undefined)
    .map((task) => ({ task, bytes: dirBytes(task.dir), startedAt: taskStartedAt(task) }))
    .sort((a, b) => a.startedAt - b.startedAt);

  let total = tasks.reduce((sum, task) => sum + dirBytes(task.dir), 0);
  for (const entry of finished) {
    if (total <= maxBytes) break;
    try {
      rmSync(entry.task.dir, { recursive: true, force: true });
      total -= entry.bytes;
      result.freedBytes += entry.bytes;
      result.evicted.push(entry.task.id);
    } catch {
      // ignore
    }
  }

  return result;
}
