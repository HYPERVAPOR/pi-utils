/**
 * The capture path (`/cerberus on`): run every bash command and hand pi its exit code.
 *
 * Nothing is formatted here. The command runs under the existing supervisor, so
 * `out.log` and `rc` mean what they always meant and a task that outlives the budget
 * stays an ordinary task (`log`/`rc`/`wait`/`stop`/`ls` all work on it). This module
 * only streams `out.log` into pi's `onData` and,
 * once the task has an rc, returns `{ exitCode }`. pi then builds content, truncation
 * notice, `details`, `isError` and `structuredContent` itself - which is exactly why
 * a command that finishes inside the budget looks byte-identical to a built-in run.
 *
 * The mode is per session (`paths.ts`): `readMode(owner)` answers for the session the
 * call belongs to, so one pane can capture while another asks and a third has cerberus
 * out of the way entirely.
 *
 * A command that outlives `CERBERUS_CAPTURE_BUDGET_MS` (10s by default) throws
 * `SlowTask`; the tool wrapper turns that into one line and the task keeps running.
 * A command that finishes in time leaves nothing behind: the model never saw the id,
 * its output has been streamed to pi, so the task directory is discarded.
 *
 * The bash call's own `timeout` is the *task's* deadline, not this call's - the tool
 * still gives up after the budget, and the order of the two decides what happens:
 *
 *   timeout <  budget: the supervisor kills the task at the deadline, and the result
 *                      is pi's `Command timed out after N seconds` (rc 124 plus the
 *                      `timedout` marker the supervisor leaves for exactly this);
 *   timeout >= budget: the model gets `still running` first and keeps a task handle;
 *                      the supervisor still kills it at the deadline (rc 124).
 *
 * Lines that are nothing but the gate's own CLI (`cerberus wait 42`, `cerberus ls`)
 * also run locally, via pi's own operations: they are the control plane, not work, and
 * capturing `wait` would make it wait on a task of itself. See `onlyInvokesGate` in
 * `rules.ts` - one command that is not `cerberus` puts the whole line back on the
 * capture path.
 *
 * In `gate` and `disabled` modes nothing here happens: the call goes straight to pi's
 * own `createLocalBashOperations`, so the gate keeps behaving exactly as before and
 * `disabled` is plain pi.
 */
import { closeSync, existsSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  allocateTask,
  claimTask,
  cmdHash,
  isAlive,
  readMode,
  readPid,
  readRc,
  writeMeta,
  type Task,
  type TaskMeta,
} from "./paths.ts";
import { onlyInvokesGate } from "./rules.ts";
import { TIMEOUT_RC, logPath, startBackground, terminate } from "./runner.ts";

export const DEFAULT_BUDGET_MS = 10_000;
export const BUDGET_ENV = "CERBERUS_CAPTURE_BUDGET_MS";

/** The part of pi's `BashOperations.exec` signature this module needs. */
export interface ExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

/** pi's `BashOperations`, structurally: no runtime import of the package here. */
export interface Operations {
  exec(command: string, cwd: string, options: ExecOptions): Promise<{ exitCode: number | null }>;
}

/** The session this call belongs to; pi passes it in the shell environment. */
export function ownerOf(options: { env?: NodeJS.ProcessEnv }): string | undefined {
  return options.env?.PI_SESSION_ID ?? process.env.PI_SESSION_ID ?? undefined;
}

export function captureBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[BUDGET_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_MS;
}

/** A command that outlived the budget. Its task is still running. */
export class SlowTask extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`cerberus: still running id=${id}`);
    this.name = "SlowTask";
    this.id = id;
  }
}

/** The one line the model gets instead of output that does not exist yet. */
export function runningNotice(id: string, bin = "cerberus"): string {
  return `cerberus: still running id=${id} (${bin} wait ${id})`;
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Poll fast at first - a command that finishes in milliseconds should not wait half a
 * poll interval for it - then back off, so a task that runs for the whole budget is
 * not woken a hundred times a second.
 */
function pollDelay(startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  if (elapsed < 250) return 10;
  if (elapsed < 1000) return 20;
  return 50;
}

/**
 * The fast path's task directory goes away again: its command finished inside the
 * budget, its output is already pi's result, and the id was never shown to anyone.
 * `rc` is written before the supervisor exits, so wait for it to go instead of pulling
 * the directory it is still writing meta.json into.
 */
async function discard(task: Task): Promise<void> {
  const pid = readPid(task.dir);
  for (let i = 0; i < 20 && isAlive(pid); i++) await delay(5);
  try {
    rmSync(task.dir, { recursive: true, force: true });
  } catch {
    // A directory that will not go is retention's problem, not the command's.
  }
}

/**
 * One operations object for every mode. `local` is pi's own bash backend, used
 * untouched in `gate`/`disabled` modes and for lines that are only the gate's own CLI;
 * the mode is read per session per call, so a flip needs no restart.
 */
export function createOperations(local: Operations, budgetMs: () => number = captureBudgetMs): Operations {
  return {
    exec: (command, cwd, options) => {
      // Only `capture` runs tasks, and only for lines that are not just the CLI itself.
      if (readMode(ownerOf(options)) !== "capture" || onlyInvokesGate(command)) {
        return local.exec(command, cwd, options);
      }
      return capture(command, cwd, options, budgetMs());
    },
  };
}

/** Save the command exactly as asked, like a staged task, and start it. */
function stage(owner: string, cwd: string, command: string): Task {
  const hash = cmdHash(command);
  const { id, dir } = allocateTask(owner, hash, cwd);
  writeFileSync(join(dir, "cmd.sh"), command);
  const meta: TaskMeta = { state: "staged", asked: 0, owner, cwd, cmdHash: hash, startedAt: Date.now() };
  writeMeta(dir, meta);
  const task: Task = { owner, id, dir, meta };
  claimTask(task);
  return task;
}

async function capture(
  command: string,
  cwd: string,
  options: ExecOptions,
  budgetMs: number,
): Promise<{ exitCode: number | null }> {
  if (options.signal?.aborted) throw new Error("aborted");
  const owner = ownerOf(options) ?? "no-session";
  const task = stage(owner, cwd, command);
  // `timeout` is the task's deadline; the budget below is this call's. See the module
  // comment for what each order of the two produces.
  startBackground(task, options.timeout, options.env);

  const fd = openSync(logPath(task.dir), "r");
  const buffer = Buffer.alloc(64 * 1024);
  // Copy out of `buffer`: it is reused, and pi may keep the chunk it is given.
  const flush = () => {
    for (let n = readSync(fd, buffer, 0, buffer.length, null); n > 0; n = readSync(fd, buffer, 0, buffer.length, null)) {
      options.onData(Buffer.from(buffer.subarray(0, n)));
    }
  };

  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  try {
    for (;;) {
      flush();
      const rc = readRc(task.dir);
      if (rc !== undefined) {
        flush();
        // A deadline shorter than the budget: the supervisor killed the task and left
        // its marker, so this is pi's timeout error, not a command that exited 124.
        const timedOut =
          rc === TIMEOUT_RC && options.timeout !== undefined && existsSync(join(task.dir, "timedout"));
        await discard(task);
        if (timedOut) throw new Error(`timeout:${options.timeout}`);
        return { exitCode: rc };
      }
      if (options.signal?.aborted) {
        await terminate(task);
        throw new Error("aborted");
      }
      if (Date.now() >= deadline) throw new SlowTask(task.id);
      await delay(pollDelay(startedAt));
    }
  } finally {
    closeSync(fd);
  }
}
