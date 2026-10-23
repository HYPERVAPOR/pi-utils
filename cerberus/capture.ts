/**
 * The capture path (`/cerberus on`): run every bash command and hand pi its exit code.
 *
 * Nothing is formatted here. The command runs as a normal task under the existing
 * supervisor, so `out.log` and `rc` mean what they always meant and `log`/`rc`/`wait`/
 * `stop`/`ls` work on it. This module only streams `out.log` into pi's `onData` and,
 * once the task has an rc, returns `{ exitCode }`. pi then builds content, truncation
 * notice, `details`, `isError` and `structuredContent` itself - which is exactly why
 * a command that finishes inside the budget looks byte-identical to a built-in run.
 *
 * A command that outlives `CERBERUS_CAPTURE_BUDGET_MS` (10s by default) throws
 * `SlowTask`; the tool wrapper turns that into one line and the task keeps running.
 *
 * In `gate` mode nothing here happens: the call goes straight to pi's own
 * `createLocalBashOperations`, so the legacy gate keeps behaving exactly as before.
 */
import { closeSync, existsSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  allocateTask,
  claimTask,
  cmdHash,
  readMode,
  readRc,
  writeMeta,
  type Task,
  type TaskMeta,
} from "./paths.ts";
import { TIMEOUT_RC, logPath, startBackground, terminate } from "./runner.ts";

export const DEFAULT_BUDGET_MS = 10_000;
export const BUDGET_ENV = "CERBERUS_CAPTURE_BUDGET_MS";
const POLL_MS = 50;

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
 * One operations object for both modes. `local` is pi's own bash backend, used
 * untouched in `gate` mode; the mode is read per call so a flip needs no restart.
 */
export function createOperations(local: Operations, budgetMs: () => number = captureBudgetMs): Operations {
  return {
    exec: (command, cwd, options) =>
      readMode() === "capture" ? capture(command, cwd, options, budgetMs()) : local.exec(command, cwd, options),
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
  const owner = options.env?.PI_SESSION_ID ?? process.env.PI_SESSION_ID ?? "no-session";
  const task = stage(owner, cwd, command);
  startBackground(task, options.timeout, options.env);

  const fd = openSync(logPath(task.dir), "r");
  const buffer = Buffer.alloc(64 * 1024);
  // Copy out of `buffer`: it is reused, and pi may keep the chunk it is given.
  const flush = () => {
    for (let n = readSync(fd, buffer, 0, buffer.length, null); n > 0; n = readSync(fd, buffer, 0, buffer.length, null)) {
      options.onData(Buffer.from(buffer.subarray(0, n)));
    }
  };

  const deadline = Date.now() + budgetMs;
  try {
    for (;;) {
      flush();
      const rc = readRc(task.dir);
      if (rc !== undefined) {
        flush();
        // The bash call's own `timeout` is pi's deadline, not a command result: pi
        // reports it as an error with that wording, and so do we.
        if (rc === TIMEOUT_RC && options.timeout !== undefined && existsSync(join(task.dir, "timedout"))) {
          throw new Error(`timeout:${options.timeout}`);
        }
        return { exitCode: rc };
      }
      if (options.signal?.aborted) {
        await terminate(task);
        throw new Error("aborted");
      }
      if (Date.now() >= deadline) throw new SlowTask(task.id);
      await delay(POLL_MS);
    }
  } finally {
    closeSync(fd);
  }
}
