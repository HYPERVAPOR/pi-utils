/**
 * Session entries → code-block candidates, with the numbering everything else uses.
 *
 * Split out from the shell so it can be checked without the pi runtime: entries
 * arrive as `unknown`, are narrowed at runtime, and nothing is imported except the
 * fence scanner. No pi import, so plain `node` can run its test.
 *
 * Two orderings live here and they are different on purpose:
 *   - `id`      stable, chronological (1 = the oldest block in the session). Written
 *               down, shown in the gutter, typed back as `/copy-code <id>`.
 *   - array order  newest message first, because that is what you want to look at.
 */
import { extractFencedBlocks, type FencedBlock } from "./fences.ts";

export interface Candidate {
  block: FencedBlock;
  /** Stable 1-based id, assigned in chronological order. Never renumbered. */
  id: number;
  /** 1 = the newest assistant message that contains any text. */
  distance: number;
}

export interface Scan {
  /** Newest message first, for the picker. */
  candidates: Candidate[];
  /** Trimmed assistant text part → ids of the blocks inside it, for the gutter. */
  idsByPart: Map<string, number[]>;
}

const PREVIEW_WIDTH = 44;

/**
 * Non-empty text parts of one entry, trimmed, in order. Undefined when the entry is
 * not an assistant message with text.
 *
 * Parts are kept separate rather than joined because the transcript renders one
 * Markdown component per part, and the gutter has to key its ids by that same string
 * (the renderer passes `content.text.trim()` to the transformer).
 */
function assistantTextParts(entry: unknown): string[] | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { type, message } = entry as { type?: unknown; message?: unknown };
  if (type !== "message" || typeof message !== "object" || message === null) return undefined;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "assistant" || !Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const { type: partType, text } = part as { type?: unknown; text?: unknown };
    if (partType !== "text" || typeof text !== "string") continue;
    const trimmed = text.trim();
    if (trimmed !== "") parts.push(trimmed);
  }
  return parts.length > 0 ? parts : undefined;
}

/**
 * Walk the branch once and return both orderings.
 *
 * A text part that appears more than once in the session gets no ids: the gutter keys
 * by text, so it could not tell the two apart, and showing a wrong id is worse than
 * showing none. Such blocks are still listed and copyable.
 */
export function scan(entries: readonly unknown[]): Scan {
  const messages: { blocks: FencedBlock[]; ids: number[] }[] = [];
  const idsByPart = new Map<string, number[]>();
  let ambiguous = new Set<string>();
  let nextId = 1;

  for (const entry of entries) {
    const parts = assistantTextParts(entry);
    if (parts === undefined) continue;

    const blocks: FencedBlock[] = [];
    const ids: number[] = [];
    for (const part of parts) {
      const partBlocks = extractFencedBlocks(part);
      if (partBlocks.length === 0) continue;
      const partIds: number[] = [];
      for (let i = 0; i < partBlocks.length; i++) partIds.push(nextId++);
      if (idsByPart.has(part)) {
        // Same text twice in one session: drop the ids for it entirely.
        idsByPart.delete(part);
        ambiguous.add(part);
      } else if (!ambiguous.has(part)) {
        idsByPart.set(part, partIds);
      }
      blocks.push(...partBlocks);
      ids.push(...partIds);
    }
    messages.push({ blocks, ids });
  }

  const total = messages.length;
  const candidates: Candidate[] = [];
  for (let group = total - 1; group >= 0; group--) {
    const distance = total - group;
    const { blocks, ids } = messages[group]!;
    for (let i = 0; i < blocks.length; i++) {
      candidates.push({ block: blocks[i]!, id: ids[i]!, distance });
    }
  }

  return { candidates, idsByPart };
}

/** Newest-first candidates for the picker, dropping the gutter map. */
export function collectCandidates(entries: readonly unknown[]): Candidate[] {
  return scan(entries).candidates;
}

/** First non-blank line of the code, clipped to fit one label row. */
export function previewOf(block: FencedBlock): string {
  const firstLine = block.code.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  return firstLine.length > PREVIEW_WIDTH ? `${firstLine.slice(0, PREVIEW_WIDTH - 1)}…` : firstLine;
}

/** How far back the block is: "last" or "3 back". */
export function whereOf(candidate: Candidate): string {
  return candidate.distance === 1 ? "last" : `${candidate.distance} back`;
}

/**
 * How a block id is written to the user: picker rows, notifications. Kept in one place
 * because it is pure notation. Spelled out rather than `#7` (which reads like an issue
 * reference) or `[7]` (shorter, but still needs explaining).
 */
export function idLabel(id: number): string {
  return `code block ${id}`;
}

/** Picker row label. The id comes from the candidate, so it cannot drift. */
export function labelOf(candidate: Candidate): string {
  return `${idLabel(candidate.id)} · ${candidate.block.lang || "text"} · ${previewOf(candidate.block)}`;
}

/**
 * Text the picker's search matches against: the bare id, language, and the whole block.
 *
 * The id is left as digits on purpose: spelling out "code block" here would make every
 * block match a search for "code". Digits-only queries are an exact id lookup anyway.
 * Including the full code is what makes "find the block that mentions X" work; on a
 * 2000-block session one keystroke still costs only a few milliseconds.
 */
export function searchTextOf(candidate: Candidate): string {
  return `${candidate.id} ${candidate.block.lang || "text"} ${candidate.block.code}`;
}

/** One picker row. Structurally a pi-tui SelectItem. */
export interface PickerItem {
  /** The block id: the row's identity, unchanged by filtering. */
  value: string;
  label: string;
  description: string;
}

export function pickerItems(candidates: readonly Candidate[]): PickerItem[] {
  return candidates.map((candidate) => ({
    value: String(candidate.id),
    label: labelOf(candidate),
    description: whereOf(candidate),
  }));
}

export function candidateById(candidates: readonly Candidate[], id: number): Candidate | undefined {
  return candidates.find((candidate) => candidate.id === id);
}

/** The candidate a picker row value refers to — the inverse of pickerItems. */
export function candidateOfValue(candidates: readonly Candidate[], value: string): Candidate | undefined {
  const id = Number(value);
  return Number.isInteger(id) ? candidateById(candidates, id) : undefined;
}

/**
 * Candidates matching what the user typed.
 *
 * A digits-only query is an exact id lookup rather than a fuzzy search: fuzzy would
 * match every block whose text happens to contain those digits in order, which makes
 * searching by id useless. `fuzzy` is injected so this file keeps importing nothing.
 */
export function matchCandidates(
  candidates: readonly Candidate[],
  query: string,
  fuzzy: (query: string) => readonly Candidate[],
): Candidate[] {
  const trimmed = query.trim();
  if (trimmed === "") return [...candidates];
  if (/^\d+$/.test(trimmed)) {
    const byId = candidateById(candidates, Number(trimmed));
    return byId ? [byId] : [];
  }
  return [...fuzzy(trimmed)];
}
