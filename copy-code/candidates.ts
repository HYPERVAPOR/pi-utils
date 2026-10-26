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

/** A block as the gutter needs it: the stable id and the fence language. */
export interface GutterBlock {
  id: number;
  /** First word of the fence info string, lowercased; empty when none. */
  lang: string;
}

export interface Scan {
  /** Newest message first, for the picker. */
  candidates: Candidate[];
  /** Trimmed assistant text part → the blocks inside it, for the gutter. */
  blocksByPart: Map<string, GutterBlock[]>;
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
  const blocksByPart = new Map<string, GutterBlock[]>();
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
      const partRefs: GutterBlock[] = [];
      for (let i = 0; i < partBlocks.length; i++) {
        const id = nextId++;
        partIds.push(id);
        partRefs.push({ id, lang: partBlocks[i]!.lang });
      }
      if (blocksByPart.has(part)) {
        // Same text twice in one session: drop the ids for it entirely.
        blocksByPart.delete(part);
        ambiguous.add(part);
      } else if (!ambiguous.has(part)) {
        blocksByPart.set(part, partRefs);
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

  return { candidates, blocksByPart };
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
 * The compact tag drawn above a block in the transcript: language and stable id,
 * e.g. `py-5`, or `text-5` when the fence names no language. Used by the gutter,
 * picker rows, search, and notifications so they all name the block the same way.
 */
export function blockTag(block: Pick<GutterBlock, "id" | "lang">): string {
  return `${block.lang || "text"}-${block.id}`;
}

/** The compact tag for a candidate, for picker rows and search. */
export function tagOf(candidate: Candidate): string {
  return blockTag({ id: candidate.id, lang: candidate.block.lang });
}

/** Picker row label. The tag comes from the candidate, so it cannot drift. */
export function labelOf(candidate: Candidate): string {
  return `${tagOf(candidate)} · ${previewOf(candidate.block)}`;
}

/**
 * Text the picker's search matches against: the compact tag and the whole block.
 *
 * The tag already carries both the language and the bare id, so a plain number still
 * matches the exact id lookup in matchCandidates(). Including the full code is what makes
 * "find the block that mentions X" work; on a 2000-block session one keystroke still costs
 * only a few milliseconds.
 */
export function searchTextOf(candidate: Candidate): string {
  return `${tagOf(candidate)} ${candidate.block.code}`;
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
