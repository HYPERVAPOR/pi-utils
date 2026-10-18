/**
 * Self-check for fences.ts. Run with plain node (type stripping, no deps):
 *
 *   node copy-code/fences.test.ts
 */
import assert from "node:assert/strict";
import { extractFencedBlocks } from "../fences.ts";

// Plain block with a language.
assert.deepEqual(extractFencedBlocks("```ts\nconst a = 1;\n```"), [{ lang: "ts", code: "const a = 1;" }]);

// No info string.
assert.deepEqual(extractFencedBlocks("```\nhi\n```"), [{ lang: "", code: "hi" }]);

// Info string with extra words keeps only the first.
assert.deepEqual(extractFencedBlocks("```ts title=x\nhi\n```"), [{ lang: "ts", code: "hi" }]);

// Tilde fences.
assert.deepEqual(extractFencedBlocks("~~~py\nprint(1)\n~~~"), [{ lang: "py", code: "print(1)" }]);

// A longer closing fence still closes; a shorter one does not.
assert.deepEqual(extractFencedBlocks("````\na\n````"), [{ lang: "", code: "a" }]);
assert.deepEqual(extractFencedBlocks("````\na\n```\nb\n````"), [{ lang: "", code: "a\n```\nb" }]);

// A tilde fence is not closed by a backtick fence.
assert.deepEqual(extractFencedBlocks("~~~\na\n```\nb\n~~~"), [{ lang: "", code: "a\n```\nb" }]);

// Unterminated fence (streaming message) is ignored.
assert.deepEqual(extractFencedBlocks("text\n```ts\nconst a = 1;"), []);

// Surrounding prose is dropped; blank lines inside the block are kept.
assert.deepEqual(extractFencedBlocks("before\n\n```sh\nls\n\necho hi\n```\n\nafter\n"), [
  { lang: "sh", code: "ls\n\necho hi" },
]);

// Several blocks in order.
assert.deepEqual(extractFencedBlocks("```a\n1\n```\nmid\n```b\n2\n```"), [
  { lang: "a", code: "1" },
  { lang: "b", code: "2" },
]);

// Up to 3 spaces of fence indent, stripped from the content (CommonMark).
assert.deepEqual(extractFencedBlocks("   ```ts\n   const a = 1;\n     indented\n   ```"), [
  { lang: "ts", code: "const a = 1;\n  indented" },
]);

// 4 spaces of indent is an indented code block, not a fence.
assert.deepEqual(extractFencedBlocks("    ```ts\n    x\n    ```"), []);

// Inline backticks are not fences.
assert.deepEqual(extractFencedBlocks("use ` ```ts ` inline, or a `` ` `` span"), []);

// Indented inside a list item: the extra indent stays in the code.
assert.deepEqual(extractFencedBlocks("- item\n\n  ```ts\n  const a = 1;\n  ```"), [
  { lang: "ts", code: "const a = 1;" },
]);

// Closing fence with an info string does not close.
assert.deepEqual(extractFencedBlocks("```\na\n``` not-a-close\nb\n```"), [{ lang: "", code: "a\n``` not-a-close\nb" }]);

// CRLF input: line endings are normalized to LF.
assert.deepEqual(extractFencedBlocks("```ts\r\nconst a = 1;\r\n```"), [{ lang: "ts", code: "const a = 1;" }]);

// Empty input and fence-only input.
assert.deepEqual(extractFencedBlocks(""), []);
assert.deepEqual(extractFencedBlocks("```\n```"), [{ lang: "", code: "" }]);

console.log("fences.test.ts: ok");
