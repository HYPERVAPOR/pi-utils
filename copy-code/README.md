# copy-code

Copy the raw source of a code block from any earlier assistant message.

The TUI wraps rendered lines to the pane width, so mouse selection gives you
broken indentation. This copies from the original Markdown instead.

## Usage

```
/copy-code      fuzzy picker (copies directly when there is only one block)
/copy-code 7    copy code block 7
alt+c           same as /copy-code
```

IDs are stable and increase over time. Each block gets a `code block N` line
above it. Typing a plain number matches the ID exactly; anything else
fuzzy-matches language and code text.

Load with `-e extensions/copy-code.ts` in a profile (profiles use `-ne`, so
auto-discovery is off).

## Cost

IDs are added at render time, so they never enter the model context. The
extension registers no tool: **0 context tokens**. A full scan takes about
18 ms on a 1.5 MB assistant history.

## Limits

- Only the current branch is scanned.
- Only fenced code blocks are recognized.
- Identical text fragments appearing twice get no ID (ambiguous).
- `/copy` and `/export` read archived text, so they contain no IDs.

## Test

```bash
cd copy-code
node test/fences.test.ts
node test/candidates.test.ts
node test/run.test.ts
node test/gutter.test.ts
```
