/**
 * Self-check for gutter.ts. Run with plain node:
 *
 *   node copy-code/test/gutter.test.ts
 */
import assert from "node:assert/strict";
import { withBlockIds } from "../gutter.ts";

const assistant = { messageType: "assistant", isStreaming: false, availableWidth: 80 } as const;
const thinking = { messageType: "assistant-thinking", isStreaming: false, availableWidth: 80 } as const;
const user = { messageType: "user", isStreaming: false, availableWidth: 80 } as const;

const ref = (id: number, lang: string) => ({ id, lang });

const md = "before\n\n```ts\nconst a = 1;\n```\n\nafter\n";

// The tag lands on its own line directly above the fence, as an inline code span so the
// theme colors it; the code itself is untouched.
assert.equal(
  withBlockIds(md, assistant, new Map([[md.trim(), [ref(7, "ts")]]])),
  "before\n\n`ts-7`\n```ts\nconst a = 1;\n```\n\nafter",
);

// Several blocks get their own tags, in order; a block with no language falls back to
// `text`.
const two = "```a\n1\n```\n\n~~~\n2\n~~~";
assert.equal(
  withBlockIds(two, assistant, new Map([[two, [ref(3, "a"), ref(4, "")]]])),
  "`a-3`\n```a\n1\n```\n\n`text-4`\n~~~\n2\n~~~",
);

// The map is keyed by the trimmed text, which is what the renderer hands over.
const padded = `\n\n${two}\n\n`;
assert.equal(withBlockIds(padded, assistant, new Map([[two, [ref(3, "a"), ref(4, "")]]])).split("\n")[0], "`a-3`");

// Unknown text (still streaming, or a message that never made it into the scan).
assert.equal(withBlockIds(md, assistant, new Map()), md);

// Thinking and user blocks never show tags, even if their text is in the map.
assert.equal(withBlockIds(md, thinking, new Map([[md.trim(), [ref(7, "ts")]]])), md);
assert.equal(withBlockIds(md, user, new Map([[md.trim(), [ref(7, "ts")]]])), md);

// A count mismatch must leave the markdown alone rather than mislabel a block.
assert.equal(withBlockIds(two, assistant, new Map([[two, [ref(3, "a")]]])), two);
assert.equal(withBlockIds(two, assistant, new Map([[two, [ref(3, "a"), ref(4, ""), ref(5, "c")]]])), two);

// CRLF is normalized, and the fence lines are still located correctly. The map is keyed
// by the raw trimmed text (with its \r), which is what both sides see.
const crlf = "```ts\r\nconst a = 1;\r\n```";
assert.equal(
  withBlockIds(crlf, assistant, new Map([[crlf.trim(), [ref(9, "ts")]]])),
  "`ts-9`\n```ts\nconst a = 1;\n```",
);

// Empty input and markdown with no fences.
assert.equal(withBlockIds("", assistant, new Map([["", [ref(1, "ts")]]])), "");
assert.equal(withBlockIds("prose", assistant, new Map([["prose", []]])), "prose");

console.log("gutter.test.ts: ok");
