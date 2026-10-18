/**
 * Self-check for candidates.ts. Run with plain node:
 *
 *   node copy-code/test/candidates.test.ts
 */
import assert from "node:assert/strict";
import {
  candidateById,
  candidateOfValue,
  collectCandidates,
  labelOf,
  matchCandidates,
  pickerItems,
  previewOf,
  scan,
  searchTextOf,
  whereOf,
} from "../candidates.ts";

const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const thinkingOnly = () => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
});
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const compaction = { type: "compaction", summary: "earlier" };

// Nothing to collect.
assert.deepEqual(collectCandidates([]), []);
assert.deepEqual(collectCandidates([user("```sh\nls\n```"), compaction]), []);
assert.deepEqual(collectCandidates([thinkingOnly()]), []);

const oldest = "```python\nold1\n```\n\n```go\nold2\n```";
const middle = "```ts\nmid\n```";
const newest = "```bash\nnewest1\n```\n\n```sh\nnewest2\n```";
const branch = [assistant(oldest), user("next"), compaction, assistant(middle), assistant(newest)];

// The array is newest message first, and its blocks keep reading order inside a message.
const found = collectCandidates(branch);
assert.deepEqual(
  found.map((c) => [c.block.code, c.id, c.distance]),
  [
    ["newest1", 4, 1],
    ["newest2", 5, 1],
    ["mid", 3, 2],
    ["old1", 1, 3],
    ["old2", 2, 3],
  ],
);

// Ids are chronological and stable: a later message appends, it never renumbers.
const grown = collectCandidates([...branch, assistant("```lua\nlater\n```")]);
assert.equal(grown[0]?.block.code, "later");
assert.equal(grown[0]?.id, 6);
assert.deepEqual(
  grown.slice(1).map((c) => c.id),
  [4, 5, 3, 1, 2],
);

// Assistant messages with blank text do not consume a distance step.
assert.deepEqual(
  collectCandidates([assistant("```a\n1\n```"), assistant("   \n")]).map((c) => [c.id, c.distance]),
  [[1, 1]],
);

// A message with text but no blocks still counts towards the distance.
assert.deepEqual(
  collectCandidates([assistant(middle), assistant("prose only")]).map((c) => [c.block.code, c.distance]),
  [["mid", 2]],
);

// Non-message entries and odd shapes are ignored, not thrown on.
assert.deepEqual(collectCandidates([null, 7, "x", { type: "message" }, { type: "message", message: null }]), []);
assert.deepEqual(collectCandidates([{ type: "message", message: { role: "assistant", content: "text" } }]), []);

// Entries before a compaction are still reachable.
assert.deepEqual(
  collectCandidates([assistant("```a\n1\n```"), compaction, assistant("```b\n2\n```")]).map((c) => c.block.code),
  ["2", "1"],
);

// The gutter map is keyed by the trimmed part text, exactly what the renderer passes in.
const gutter = scan(branch).idsByPart;
assert.deepEqual(gutter.get(oldest), [1, 2]);
assert.deepEqual(gutter.get(middle), [3]);
assert.deepEqual(gutter.get(newest), [4, 5]);
assert.equal(gutter.size, 3);

// The same text twice in one session cannot be told apart, so it gets no ids at all.
const ambiguous = scan([assistant(middle), assistant("prose"), assistant(middle)]).idsByPart;
assert.equal(ambiguous.has(middle), false);
assert.deepEqual(ambiguous.get("prose"), undefined);
// …and its blocks are still listed and copyable.
assert.deepEqual(
  collectCandidates([assistant(middle), assistant(middle)]).map((c) => [c.block.code, c.id]),
  [
    ["mid", 2],
    ["mid", 1],
  ],
);

// Labels: id, language, first non-blank line; distance separately.
assert.equal(labelOf(found[0]!), "code block 4 · bash · newest1");
assert.equal(labelOf(found[2]!), "code block 3 · ts · mid");
assert.equal(whereOf(found[0]!), "last");
assert.equal(whereOf(found[2]!), "2 back");
assert.equal(labelOf({ block: { lang: "", code: "\n\n" }, id: 9, distance: 1 }), "code block 9 · text · ");
assert.equal(previewOf({ lang: "", code: "\n\n" }), "");
assert.equal(previewOf({ lang: "ts", code: `${"x".repeat(80)}\n` }), `${"x".repeat(43)}…`);

// Search text carries the bare id, the language, and the whole block ("code block" would
// make a search for "code" match everything).
assert.equal(searchTextOf(found[0]!), "4 bash newest1");
assert.equal(searchTextOf({ block: { lang: "", code: "plain" }, id: 9, distance: 1 }), "9 text plain");
assert.equal(
  searchTextOf({ block: { lang: "ts", code: "a\nworktree\nb" }, id: 12, distance: 1 }),
  "12 ts a\nworktree\nb",
);

// Picker rows: the row value is the id, and it maps back to the right candidate.
const rows = pickerItems(found);
assert.deepEqual(
  rows.map((r) => r.value),
  ["4", "5", "3", "1", "2"],
);
assert.equal(rows[2]!.label, "code block 3 · ts · mid");
assert.equal(rows[2]!.description, "2 back");
assert.equal(candidateOfValue(found, rows[2]!.value)?.block.code, "mid");
assert.equal(candidateById(found, 5)?.block.code, "newest2");
assert.equal(candidateById(found, 99), undefined);
assert.equal(candidateOfValue(found, "1")?.block.code, "old1");
assert.equal(candidateOfValue(found, "99"), undefined);
assert.equal(candidateOfValue(found, ""), undefined);
assert.equal(candidateOfValue(found, "nope"), undefined);
assert.equal(candidateOfValue(found, "1.5"), undefined);

// Matching: empty shows everything, digits are an exact id lookup, text goes fuzzy.
const fuzzyCalls: string[] = [];
const fuzzy = (query: string) => {
  fuzzyCalls.push(query);
  return found.filter((c) => searchTextOf(c).includes(query));
};
assert.equal(matchCandidates(found, "", fuzzy).length, 5);
assert.equal(matchCandidates(found, "   ", fuzzy).length, 5);
assert.deepEqual(
  matchCandidates(found, "3", fuzzy).map((c) => c.block.code),
  ["mid"],
);
assert.deepEqual(matchCandidates(found, " 3 ", fuzzy).map((c) => c.block.code), ["mid"]);
assert.deepEqual(matchCandidates(found, "99", fuzzy), []);
assert.deepEqual(matchCandidates(found, "0", fuzzy), []);
assert.deepEqual(
  matchCandidates(found, "newest", fuzzy).map((c) => c.block.code),
  ["newest1", "newest2"],
);
assert.deepEqual(fuzzyCalls, ["newest"], "digits never reach the fuzzy matcher");

console.log("candidates.test.ts: ok");
