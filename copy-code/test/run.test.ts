/**
 * Self-check for run.ts: every branch of the pick/copy flow, with a fake UI and
 * a fake clipboard. Run with plain node:
 *
 *   node copy-code/test/run.test.ts
 */
import assert from "node:assert/strict";
import type { Candidate } from "../candidates.ts";
import { copyCodeBlock, type CopyCodeIo } from "../run.ts";

const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });

let notes: string[] = [];
let copied: string[] = [];
let offered: readonly Candidate[] = [];
let pickCalls = 0;

/** `picked` is an index into the candidate list, or undefined to cancel. */
function makeIo(entries: readonly unknown[], picked?: number, hasUi = true): CopyCodeIo {
  return {
    entries,
    ui: {
      hasUi,
      notify: (message, type) => notes.push(`${type ?? "info"}: ${message}`),
      pick: async (candidates) => {
        pickCalls++;
        offered = candidates;
        return picked === undefined ? undefined : candidates[picked];
      },
    },
    copy: async (text) => void copied.push(text),
  };
}

function reset() {
  notes = [];
  copied = [];
  offered = [];
  pickCalls = 0;
}

// Three assistant messages, newest last: 1 block, then 2, then 3.
const branch = [
  user("start"),
  assistant("```python\nprint(1)\n```"),
  user("more"),
  assistant("```go\npackage main\n```\n\n```ts\nconst a = 1;\n```"),
  user("go on"),
  assistant("```bash\nls\n```\n\n```sh\npwd\n```\n\n```lua\nreturn 1\n```"),
];

// The picker is offered every block, newest message first, and its choice is copied.
// Ids are chronological, so the newest block the picker shows first is #4.
reset();
await copyCodeBlock(makeIo(branch, 3));
assert.equal(pickCalls, 1);
assert.deepEqual(
  offered.map((c) => [c.block.code, c.id]),
  [
    ["ls", 4],
    ["pwd", 5],
    ["return 1", 6],
    ["package main", 2],
    ["const a = 1;", 3],
    ["print(1)", 1],
  ],
);
assert.deepEqual(offered.map((c) => c.distance), [1, 1, 1, 2, 2, 3]);
assert.deepEqual(copied, ["package main"]);
assert.deepEqual(notes, ["info: Copied go-2 — 1 line from 2 messages back."]);

// `/copy-code <id>` picks by the number in the gutter tag, not by list position.
reset();
await copyCodeBlock(makeIo(branch), 4);
assert.deepEqual(copied, ["ls"]);
assert.deepEqual(notes, ["info: Copied bash-4 — 1 line from the last message."]);
reset();
await copyCodeBlock(makeIo(branch), 1);
assert.deepEqual(copied, ["print(1)"]);
assert.deepEqual(notes, ["info: Copied python-1 — 1 line from 3 messages back."]);
reset();
await copyCodeBlock(makeIo(branch), 3);
assert.deepEqual(copied, ["const a = 1;"]);

// Cancelling copies nothing and says nothing.
reset();
await copyCodeBlock(makeIo(branch, undefined));
assert.equal(pickCalls, 1);
assert.deepEqual(copied, []);
assert.deepEqual(notes, []);

// Out of range, at both boundaries.
reset();
await copyCodeBlock(makeIo(branch), 7);
assert.deepEqual(notes, ["error: No code block with id 7 (this session has 6 blocks)."]);
assert.equal(pickCalls, 0);
reset();
await copyCodeBlock(makeIo(branch), 0);
assert.deepEqual(notes, ["error: No code block with id 0 (this session has 6 blocks)."]);

// Nothing to copy.
reset();
await copyCodeBlock(makeIo([user("hi"), assistant("prose only")]));
assert.deepEqual(notes, ["warning: No code blocks in this session's assistant messages."]);
assert.equal(pickCalls, 0);
reset();
await copyCodeBlock(makeIo([]));
assert.deepEqual(notes, ["warning: No code blocks in this session's assistant messages."]);

// A single block anywhere in the branch copies without opening the picker.
reset();
await copyCodeBlock(makeIo([assistant("```sh\nls\n```"), user("hi"), assistant("no code here")]));
assert.equal(pickCalls, 0);
assert.deepEqual(copied, ["ls"]);
assert.deepEqual(notes, ["info: Copied sh-1 — 1 line from 2 messages back."]);

// No picker available: several blocks asks for a number.
reset();
await copyCodeBlock(makeIo(branch, undefined, false));
assert.equal(pickCalls, 0);
assert.deepEqual(copied, []);
assert.deepEqual(notes, ["warning: Several code blocks (6); pass a number, e.g. /copy-code 2."]);

// A failing clipboard is reported, not swallowed.
reset();
await copyCodeBlock(
  {
    entries: branch,
    ui: { hasUi: true, notify: (m, t) => notes.push(`${t ?? "info"}: ${m}`), pick: async () => undefined },
    copy: async () => {
      throw new Error("no clipboard");
    },
  },
  1,
);
assert.deepEqual(notes, ["error: Copy failed: no clipboard"]);

// A non-Error throw is stringified (the WSL clipboard helpers can throw strings).
reset();
await copyCodeBlock(
  {
    entries: branch,
    ui: { hasUi: true, notify: (m, t) => notes.push(`${t ?? "info"}: ${m}`), pick: async () => undefined },
    copy: async () => {
      throw "boom";
    },
  },
  1,
);
assert.deepEqual(notes, ["error: Copy failed: boom"]);

// Lines and plurals.
reset();
await copyCodeBlock(makeIo([assistant("```ts\nconst a = 1;\nconst b = 2;\n```")]), 1);
assert.deepEqual(notes, ["info: Copied ts-1 — 2 lines from the last message."]);
reset();
await copyCodeBlock(makeIo([assistant("```\n```")]), 1);
assert.deepEqual(notes, ["info: Copied text-1 — 0 lines from the last message."]);

// A block with no language uses the `text-1` fallback tag.
reset();
await copyCodeBlock(makeIo([assistant("```\nplain\n```")]), 1);
assert.deepEqual(notes, ["info: Copied text-1 — 1 line from the last message."]);

console.log("run.test.ts: ok");
