/**
 * Draws the stable `lang-id` tag above each fenced block, e.g. `py-5`.
 *
 * Render-time only. `registerMarkdownTransformer` is documented as running "before Pi
 * renders it in the interactive transcript", and the model's context is built from the
 * stored message text — so a tag drawn here cannot reach the model. (For the same
 * reason `/copy` and `/export` never contain tags: they read the stored text.)
 *
 * Why the tag goes on a line above the fence instead of on it: pi prints the fence's
 * info string as the block's top border and hands the same string to highlight.js, and
 * marked keeps the whole info string as `lang`. `` ```ts py-7 `` would therefore render
 * the tag but break syntax highlighting, because "ts py-7" is not a known language.
 *
 * No pi import at runtime: the context is a type only, and the tag notation comes from
 * candidates.ts, so plain `node` can run its test.
 */
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { blockTag, type GutterBlock } from "./candidates.ts";
import { fenceOpenLines } from "./fences.ts";

/**
 * The marker line: the language-id tag as an inline code span, which the theme colors as
 * `mdCode` (violet in the default theme) while body text stays near-white — so the label
 * reads as a widget rather than as part of the answer.
 */
function markerLine(block: GutterBlock): string {
  return `\`${blockTag(block)}\``;
}

/**
 * `markdown` with a `lang-id` tag inserted above every fenced block, or `markdown`
 * unchanged when there is nothing authoritative to draw.
 */
export function withBlockIds(
  markdown: string,
  context: MarkdownTransformContext,
  blocksByPart: ReadonlyMap<string, readonly GutterBlock[]>,
): string {
  // User messages and thinking blocks are not in the candidate list, so they must not
  // show a tag that /copy-code cannot resolve.
  if (context.messageType !== "assistant") return markdown;

  const text = markdown.trim();
  const blocks = blocksByPart.get(text);
  if (blocks === undefined || blocks.length === 0) return markdown;

  const lines = text.replace(/\r/g, "").split("\n");
  const opens = fenceOpenLines(text);
  // Defensive: a shape that does not line up (still streaming, or an id assignment that
  // disagrees) would silently shift tags onto the wrong blocks.
  if (opens.length !== blocks.length) return markdown;

  for (let i = opens.length - 1; i >= 0; i--) {
    lines.splice(opens[i]!, 0, markerLine(blocks[i]!));
  }
  return lines.join("\n");
}
