/**
 * Draws the stable block id above each fenced block.
 *
 * Render-time only. `registerMarkdownTransformer` is documented as running "before Pi
 * renders it in the interactive transcript", and the model's context is built from the
 * stored message text — so an id drawn here cannot reach the model. (For the same
 * reason `/copy` and `/export` never contain ids: they read the stored text.)
 *
 * Why the id goes on a line above the fence instead of on it: pi prints the fence's
 * info string as the block's top border and hands the same string to highlight.js, and
 * marked keeps the whole info string as `lang`. `` ```ts code block 7 `` would therefore
 * render the id but break syntax highlighting, because "ts code block 7" is not a known
 * language.
 *
 * No pi import at runtime: the context is a type only, and the id notation comes from
 * candidates.ts, so plain `node` can run its test.
 */
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { idLabel } from "./candidates.ts";
import { fenceOpenLines } from "./fences.ts";

/**
 * The marker line: the id as an inline code span, which the theme colors as `mdCode`
 * (violet in the default theme) while body text stays near-white — so the label reads as
 * a widget rather than as part of the answer.
 */
function markerLine(id: number): string {
  return `\`${idLabel(id)}\``;
}

/**
 * `markdown` with `#id ──────` inserted above every fenced block, or `markdown`
 * unchanged when there is nothing authoritative to draw.
 */
export function withBlockIds(
  markdown: string,
  context: MarkdownTransformContext,
  idsByPart: ReadonlyMap<string, readonly number[]>,
): string {
  // User messages and thinking blocks are not in the candidate list, so they must not
  // show an id that /copy-code cannot resolve.
  if (context.messageType !== "assistant") return markdown;

  const text = markdown.trim();
  const ids = idsByPart.get(text);
  if (ids === undefined || ids.length === 0) return markdown;

  const lines = text.replace(/\r/g, "").split("\n");
  const opens = fenceOpenLines(text);
  // Defensive: a shape that does not line up (still streaming, or an id assignment that
  // disagrees) would silently shift ids onto the wrong blocks.
  if (opens.length !== ids.length) return markdown;

  for (let i = opens.length - 1; i >= 0; i--) {
    lines.splice(opens[i]!, 0, markerLine(ids[i]!));
  }
  return lines.join("\n");
}
