/**
 * Minimal fenced-code-block scanner.
 *
 * Pi's transcript wraps every rendered line to the pane width, so copying a
 * block by mouse selection yields the wrapped lines as real line breaks (and
 * loses continuation indentation). Reading the block out of the original
 * Markdown source avoids that. This module is the "read it out" half.
 *
 * Deliberately not a Markdown parser: it handles CommonMark fenced code blocks
 * (``` or ~~~, up to 3 spaces of indent, optional info string) and treats
 * everything else as text. Line endings are normalized to LF on the way out so
 * CRLF sources still copy cleanly.
 *
 * No imports, so it can be tested with plain `node`.
 */

export interface FencedBlock {
  /** First word of the info string, lowercased; empty when the fence has none. */
  lang: string;
  /** Verbatim block content between the fence lines, without a trailing newline. */
  code: string;
}

interface FenceAt {
  /** 0-based index of the opening fence line. */
  openLine: number;
  block: FencedBlock;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;

function scanFences(markdown: string): FenceAt[] {
  const lines = markdown.split(/\r?\n/);
  const found: FenceAt[] = [];

  let i = 0;
  while (i < lines.length) {
    const openLine = i;
    const open = FENCE.exec(lines[i] ?? "");
    if (!open) {
      i++;
      continue;
    }

    const indent = open[1] ?? "";
    const marker = open[2] ?? "";
    const info = (open[3] ?? "").trim();
    const markerChar = marker[0];

    // CommonMark: a backtick fence's info string may not contain a backtick
    // (that is what makes `` `code` `` inline spans, not fences).
    if (markerChar === "`" && info.includes("`")) {
      i++;
      continue;
    }

    const content: string[] = [];
    let closed = false;
    i++;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      const close = FENCE.exec(line);
      const closeMarker = close?.[2] ?? "";
      const isClose =
        closeMarker[0] === markerChar && closeMarker.length >= marker.length && (close?.[3] ?? "").trim() === "";
      if (isClose) {
        closed = true;
        i++;
        break;
      }
      // Up to `indent` leading spaces are not part of the code.
      content.push(indent !== "" && line.startsWith(indent) ? line.slice(indent.length) : line);
      i++;
    }

    // An unterminated fence is a message that is still streaming in; skip it.
    if (!closed) continue;

    found.push({
      openLine,
      block: {
        lang: (info.split(/\s+/)[0] ?? "").toLowerCase(),
        code: content.join("\n"),
      },
    });
  }

  return found;
}

export function extractFencedBlocks(markdown: string): FencedBlock[] {
  return scanFences(markdown).map((fence) => fence.block);
}

/**
 * 0-based line index of each opening fence, in the same order as
 * `extractFencedBlocks`. Used to insert the block id above each fence.
 */
export function fenceOpenLines(markdown: string): number[] {
  return scanFences(markdown).map((fence) => fence.openLine);
}
