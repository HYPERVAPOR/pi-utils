/**
 * A finished task's output, formatted the way pi would have shown it.
 *
 * When a bash call finishes inside the capture budget pi formats the result itself,
 * so the model sees pi's own output. `cerberus wait` is the other way to that result:
 * it has to produce the same text from `out.log`, including the truncation pi
 * applies (last 2000 lines / 50KB) and the notice naming the full output - here the
 * log itself, which is where pi would have written its temp file.
 *
 * The truncation itself is pi's (`truncateTail`), so the boundaries, the "line is
 * 195KB" edge case and `formatSize` are identical instead of merely similar. Only the
 * three notice strings are spelled out here, because pi builds them inside the tool
 * definition it does not export.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { tildify } from "./paths.ts";
import { loadPi } from "./pi-package.ts";

/** Where the full output of a task lives; the notice points here. */
export function fullOutputPath(dir: string): string {
  return tildify(join(dir, "out.log"));
}

interface LogScan {
  totalBytes: number;
  totalLines: number;
  /** Bytes of the last line, unterminated: what pi reports as "line is 195KB". */
  lastLineBytes: number;
  /** The tail of the file, at least twice the byte limit: enough for any truncation. */
  tail: string;
}

function countLines(text: string): number {
  if (text === "") return 0;
  let lines = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return text.endsWith("\n") ? lines : lines + 1;
}

/**
 * Read the log's totals and tail without ever holding the whole log: a command can
 * print gigabytes, and only the last 50KB of it can reach the model.
 */
function scanLog(path: string, window: number): LogScan {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { totalBytes: 0, totalLines: 0, lastLineBytes: 0, tail: "" };
  }
  if (size <= window) {
    const text = readFileSync(path, "utf8");
    return {
      totalBytes: size,
      totalLines: countLines(text),
      lastLineBytes: text.length === 0 ? 0 : Buffer.byteLength(text.slice(text.lastIndexOf("\n") + 1)),
      tail: text,
    };
  }

  const fd = openSync(path, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  const kept = Buffer.alloc(window);
  let keptBytes = 0;
  let totalBytes = 0;
  let newlines = 0;
  let lastNewline = -1;
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      const slice = chunk.subarray(0, read);
      for (let i = slice.indexOf(0x0a); i !== -1; i = slice.indexOf(0x0a, i + 1)) {
        newlines++;
        lastNewline = totalBytes + i;
      }
      // Keep only the last `window` bytes: shift the window left, then fill it.
      if (read >= window) {
        slice.copy(kept, 0, read - window);
        keptBytes = window;
      } else {
        const drop = Math.max(0, keptBytes + read - window);
        if (drop > 0) {
          kept.copyWithin(0, drop, keptBytes);
          keptBytes -= drop;
        }
        slice.copy(kept, keptBytes);
        keptBytes += read;
      }
      totalBytes += read;
    }
  } finally {
    closeSync(fd);
  }
  const tail = kept.subarray(0, keptBytes).toString("utf8");
  const terminated = totalBytes > 0 && kept[keptBytes - 1] === 0x0a;
  return {
    totalBytes,
    totalLines: totalBytes === 0 ? 0 : newlines + (terminated ? 0 : 1),
    lastLineBytes: lastNewline === -1 ? totalBytes : totalBytes - (lastNewline + 1),
    tail,
  };
}

/** The text pi would return for this task's output, notice and all. */
export async function resultText(dir: string): Promise<string> {
  const pi = await loadPi();
  const scan = scanLog(join(dir, "out.log"), 2 * pi.DEFAULT_MAX_BYTES);
  if (scan.totalBytes === 0) return "(no output)";
  const truncated =
    scan.totalLines > pi.DEFAULT_MAX_LINES || scan.totalBytes > pi.DEFAULT_MAX_BYTES;
  if (!truncated) return scan.tail;

  // The tail window is twice the byte limit, so pi's truncation of it is the
  // truncation of the whole log; only the totals come from the scan.
  const kept = pi.truncateTail(scan.tail);
  const startLine = scan.totalLines - kept.outputLines + 1;
  const full = fullOutputPath(dir);
  if (kept.lastLinePartial) {
    const lineSize = pi.formatSize(scan.lastLineBytes);
    return `${kept.content}\n\n[Showing last ${pi.formatSize(kept.outputBytes)} of line ${scan.totalLines} (line is ${lineSize}). Full output: ${full}]`;
  }
  if (kept.truncatedBy === "lines") {
    return `${kept.content}\n\n[Showing lines ${startLine}-${scan.totalLines} of ${scan.totalLines}. Full output: ${full}]`;
  }
  return `${kept.content}\n\n[Showing lines ${startLine}-${scan.totalLines} of ${scan.totalLines} (${pi.formatSize(pi.DEFAULT_MAX_BYTES)} limit). Full output: ${full}]`;
}
