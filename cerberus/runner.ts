/**
 * Running a staged command: background (`bg`) or foreground (`fg`).
 *
 * `bg` starts a detached supervisor (`cerberus __supervise <dir>`) whose stdout and
 * stderr are the task's out.log fd; it is the process-group leader, so `stop` can
 * kill the whole tree. `fg` streams the child's output to both out.log and our
 * stdout, and exits with the child's status.
 *
 * Both run the command the same way pi's bash tool does: `<bash> -c <cmd.sh text>`
 * (see `taskShell`). cmd.sh stays the exact record of what was asked; it is read as
 * text, never executed as a file.
 *
 * Both write `rc` atomically when the command ends. A timeout kills the tree and
 * records 124, the same code as coreutils `timeout`.
 */
import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAlive,
  readMeta,
  readPid,
  readRc,
  writeMeta,
  writePid,
  writeRc,
  type Task,
} from "./paths.ts";

export const TIMEOUT_RC = 124;
export const LOG_CAP_BYTES = 256 * 1024;

/** Absolute path of the bin shim, so the CLI works without PATH. */
export const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cerberus");

/**
 * The same bash pi's bash tool picks: /bin/bash, then bash on PATH. `$SHELL` is not
 * consulted (it is a login shell, often zsh, not what pi runs commands under).
 */
function findBash(): string | undefined {
  try {
    accessSync("/bin/bash", fsConstants.X_OK);
    return "/bin/bash";
  } catch {
    // fall through to PATH
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "bash");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/**
 * How a staged command runs, for both `fg` and the supervisor: `<bash> -c <text>`,
 * the shape pi's bash tool uses, so the gate never changes the shell a command sees.
 * cmd.sh is the record and is read as text; it is not executed as a file, and $SHELL
 * (often zsh) is ignored. `sh -c` only when no bash exists anywhere.
 */
export function taskShell(dir: string): { file: string; args: string[] } {
  const text = readFileSync(join(dir, "cmd.sh"), "utf8");
  return { file: findBash() ?? "sh", args: ["-c", text] };
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function logPath(dir: string): string {
  return join(dir, "out.log");
}

export function rcPath(dir: string): string {
  return join(dir, "rc");
}

/** Last `cap` bytes of a file. Big output is cut from the front, never the tail. */
export function readCapped(path: string, cap: number = LOG_CAP_BYTES): {
  text: string;
  truncated: boolean;
  totalBytes: number;
} {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { text: "", truncated: false, totalBytes: 0 };
  }
  if (size <= cap) return { text: readFileSync(path, "utf8"), truncated: false, totalBytes: size };
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(cap);
    const read = readSync(fd, buffer, 0, cap, size - cap);
    return { text: buffer.subarray(0, read).toString("utf8"), truncated: true, totalBytes: size };
  } finally {
    closeSync(fd);
  }
}

export interface BackgroundStart {
  pid: number;
  log: string;
  rc: string;
}

function positiveSeconds(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Start the supervisor for a claimed task. The task directory must have cmd.sh. */
export function startBackground(task: Task, timeoutSec?: number): BackgroundStart {
  const meta = task.meta;
  const startedAt = Date.now();
  if (meta) writeMeta(task.dir, { ...meta, state: "running", startedAt, pid: 0 });

  const log = logPath(task.dir);
  const seconds = positiveSeconds(timeoutSec);
  const fd = openSync(log, "a", 0o644);
  let pid = 0;
  try {
    const args = [CLI_PATH, "__supervise", task.dir];
    if (seconds !== undefined) args.push(String(seconds));
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    pid = child.pid ?? 0;
  } finally {
    closeSync(fd);
  }
  if (pid <= 0) {
    writeRc(task.dir, 127);
    throw new Error(`failed to start supervisor for ${task.id}`);
  }
  writePid(task.dir, pid);
  if (meta) writeMeta(task.dir, { ...meta, state: "running", startedAt, pid });
  return { pid, log, rc: rcPath(task.dir) };
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return 128 + ((constants.signals as Record<string, number>)[signal] ?? 1);
}

export function runForeground(task: Task, timeoutSec?: number): Promise<number> {
  const meta = task.meta;
  const startedAt = Date.now();
  if (meta) writeMeta(task.dir, { ...meta, state: "running", startedAt, pid: 0 });

  const { file, args } = taskShell(task.dir);
  const fd = openSync(logPath(task.dir), "a", 0o644);
  const seconds = positiveSeconds(timeoutSec);

  return new Promise<number>((done) => {
    const child = spawn(file, args, {
      cwd: meta?.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.pid) {
      writePid(task.dir, child.pid);
      if (meta) writeMeta(task.dir, { ...meta, state: "running", startedAt, pid: child.pid });
    }

    let timedOut = false;
    let settle: NodeJS.Signals | undefined;

    const onSignal = (signal: NodeJS.Signals) => {
      settle = signal;
      if (child.pid) signalGroup(child.pid, signal);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    process.on("SIGHUP", onSignal);

    const killTimer =
      seconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              signalGroup(child.pid, "SIGTERM");
              const hard = setTimeout(() => {
                if (child.pid) signalGroup(child.pid, "SIGKILL");
              }, 1000);
              hard.unref();
            }
          }, seconds * 1000);

    const forward = (stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream) => {
      stream?.on("data", (chunk: Buffer) => {
        try {
          writeSync(fd, chunk);
        } catch {
          // the disk may be gone; never lose the live stream because of it
        }
        try {
          out.write(chunk);
        } catch {
          // reader went away (pi cancelled); the log still has the output
        }
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);

    let finished = false;
    const finish = (rc: number) => {
      if (finished) return;
      finished = true;
      if (killTimer) clearTimeout(killTimer);
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      process.off("SIGHUP", onSignal);
      writeRc(task.dir, rc);
      if (meta) {
        writeMeta(task.dir, {
          ...meta,
          state: "finished",
          startedAt,
          pid: child.pid,
          durationMs: Date.now() - startedAt,
        });
      }
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      done(rc);
    };

    child.on("error", () => finish(127));
    child.on("close", (code, signal) => {
      const rc = timedOut
        ? TIMEOUT_RC
        : code ?? (signal ? signalNumber(signal) : settle ? signalNumber(settle) : 1);
      finish(rc);
    });
  });
}

/**
 * `cerberus __supervise <dir> [timeoutSec]`: run the staged command with the log fd
 * inherited from the parent, record the exit code, forward signals, enforce the timeout.
 *
 * The parent already opened out.log as our stdout/stderr, so `inherit` writes the
 * command's output straight into the task log.
 */
export function supervise(dir: string, timeoutSec?: number): Promise<number> {
  const meta = readMeta(dir);
  const startedAt = meta?.startedAt ?? Date.now();
  const { file, args } = taskShell(dir);

  return new Promise<number>((done) => {
    const child = spawn(file, args, { cwd: meta?.cwd, stdio: "inherit" });
    let timedOut = false;
    let forwarding = false;

    const forward = (signal: NodeJS.Signals) => {
      if (forwarding || !child.pid) return;
      forwarding = true;
      // We are the group leader (spawned detached); the child shares our group, so
      // a group signal from outside already reached it. Forward for direct signals.
      if (!signalGroup(child.pid, signal)) {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
      forwarding = false;
    };
    process.on("SIGTERM", () => forward("SIGTERM"));
    process.on("SIGINT", () => forward("SIGINT"));
    process.on("SIGHUP", () => forward("SIGHUP"));

    const seconds = positiveSeconds(timeoutSec);
    const timer =
      seconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            // rc first: a SIGKILL that also takes out this supervisor still leaves
            // the outcome behind.
            writeRc(dir, TIMEOUT_RC);
            try {
              process.kill(-process.pid, "SIGTERM");
            } catch {
              forward("SIGTERM");
            }
            const hard = setTimeout(() => {
              try {
                process.kill(-process.pid, "SIGKILL");
              } catch {
                if (child.pid) {
                  try {
                    child.kill("SIGKILL");
                  } catch {
                    // already gone
                  }
                }
              }
            }, 1000);
            hard.unref();
          }, seconds * 1000);

    let finished = false;
    const finish = (rc: number) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      writeRc(dir, rc);
      writeMeta(dir, {
        ...(meta ?? {
          owner: "",
          cwd: dir,
          cmdHash: "",
          startedAt,
          state: "running",
        }),
        state: "finished",
        startedAt,
        pid: process.pid,
        durationMs: Date.now() - startedAt,
      });
      done(0);
      process.exit(0);
    };

    child.on("error", () => finish(127));
    child.on("close", (code, signal) => {
      const rc = timedOut ? TIMEOUT_RC : code ?? (signal ? signalNumber(signal) : 1);
      finish(rc);
    });
  });
}

/** TERM the process group, then KILL after 2s. Returns once the pid is gone. */
export async function terminate(task: Task): Promise<boolean> {
  const pid = task.meta?.pid ?? readPid(task.dir);
  if (!isAlive(pid)) {
    // Nothing was ever started (still staged, or refused): no process can ever
    // write an rc, so do not wait for one.
    if (pid) await waitForRc(task.dir, 500);
    return false;
  }
  const target = pid as number;
  let sent: NodeJS.Signals = "SIGTERM";
  if (!signalGroup(target, "SIGTERM")) {
    try {
      process.kill(target, "SIGTERM");
    } catch {
      // already gone
    }
  }
  for (let i = 0; i < 20 && isAlive(target); i++) await delay(100);
  if (isAlive(target)) {
    sent = "SIGKILL";
    if (!signalGroup(target, "SIGKILL")) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // already gone
      }
    }
    for (let i = 0; i < 10 && isAlive(target); i++) await delay(100);
  }
  await waitForRc(task.dir, 1000);
  // A supervisor killed before it installed its signal handlers cannot record the
  // outcome itself. The caller knows what it sent, so leave an honest rc behind.
  if (!isAlive(target) && readRc(task.dir) === undefined) writeRc(task.dir, signalNumber(sent));
  return true;
}

async function waitForRc(dir: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (readRc(dir) === undefined && Date.now() < deadline) await delay(50);
}
