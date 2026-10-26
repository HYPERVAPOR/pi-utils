/**
 * The /copy-code flow: collect candidate blocks, pick one, copy it.
 *
 * No pi import on purpose. The UI and the clipboard write come in as arguments,
 * so test/run.test.ts drives every branch with plain node — no stub package, no
 * real clipboard, no model call. The picker itself is picker.ts, supplied by the
 * shell through `ui.pick`.
 */
import { candidateById, collectCandidates, idLabel, type Candidate } from "./candidates.ts";

/** The slice of ctx.ui this flow needs. */
export interface CopyCodeUi {
  /** False when no interactive picker is available (non-TUI modes). */
  hasUi: boolean;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** Ask which candidate to copy; undefined when the user cancels. */
  pick(candidates: readonly Candidate[]): Promise<Candidate | undefined>;
}

export interface CopyCodeIo {
  /** Session entries, newest last (ctx.sessionManager.getBranch()). */
  entries: readonly unknown[];
  ui: CopyCodeUi;
  /** Clipboard writer. */
  copy(text: string): Promise<void>;
}

/**
 * Copy one code block. `requested` is a block id (see candidates.ts), i.e. the number in
 * the `lang-N` tag above each block (`py-5` -> 5) and in the picker; without it the picker
 * runs when there is more than one candidate.
 */
export async function copyCodeBlock(io: CopyCodeIo, requested?: number): Promise<void> {
  const { ui } = io;
  const candidates = collectCandidates(io.entries);
  if (candidates.length === 0) {
    ui.notify("No code blocks in this session's assistant messages.", "warning");
    return;
  }

  let chosen: Candidate | undefined;
  if (requested !== undefined) {
    chosen = candidateById(candidates, requested);
    if (chosen === undefined) {
      ui.notify(`No code block with id ${requested} (this session has ${candidates.length} blocks).`, "error");
      return;
    }
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else if (ui.hasUi) {
    chosen = await ui.pick(candidates);
  } else {
    ui.notify(`Several code blocks (${candidates.length}); pass a number, e.g. /copy-code 2.`, "warning");
    return;
  }

  if (chosen === undefined) return;

  try {
    await io.copy(chosen.block.code);
  } catch (error) {
    ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  const lines = chosen.block.code === "" ? 0 : chosen.block.code.split("\n").length;
  const from = chosen.distance === 1 ? "the last message" : `${chosen.distance} messages back`;
  ui.notify(
    `Copied ${idLabel(chosen.id)} — ${lines} line${lines === 1 ? "" : "s"}${
      chosen.block.lang ? ` (${chosen.block.lang})` : ""
    } from ${from}.`,
    "info",
  );
}
