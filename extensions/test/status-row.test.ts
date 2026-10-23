/**
 * Self-check for extensions/status-row.ts: one widget, several plugins, one line.
 *
 *   node extensions/test/status-row.test.ts
 */
import assert from "node:assert/strict";

const { loadTui } = await import("../../cerberus/pi-package.ts");
const { createIndicator } = await import("../cerberus/widget.ts");
const { ROW_KEY, joinStatusRow, leaveStatusRow, statusRowAvailable } = await import("../status-row.ts");

const api = await loadTui();
const GLOBAL_KEY = "__piStatusRow";
const WIDGET_KEY = "cerberus";

/** What a `ctx.ui` stub records. */
function fakeUi() {
  const calls: Array<{ key: string; content: unknown }> = [];
  return {
    calls,
    setWidget: (key: string, content: unknown) => void calls.push({ key, content }),
  };
}

const plain = (line: string) => line.replace(/\x1B\[[0-9;]*m/g, "").replace(/\x1B\]8;;\x07/g, "").trimEnd();
const theme = { fg: (color: string, text: string) => `${color}|${text}` };
const tui = () => ({ renders: 0, requestRender() { this.renders++; } });

/** A part that renders a fixed string, optionally wrapped in a MouseRegion. */
function stubPart(label: string, hits: string[] = [], MouseRegion = api.MouseRegion) {
  const face = { render: () => [label], invalidate() {} };
  if (!MouseRegion) return () => face;
  return () => new MouseRegion(face, (event: any) => {
    if (event.type === "press" && event.button === "left") return { handled: true };
    if (event.type === "click" && event.button === "left") return hits.push(`${label}@${event.x}`), { handled: true };
    return undefined;
  });
}

const clickAt = (x: number, clickCount = 2) => ({
  type: "click", button: "left", clickCount, x, y: 0, width: 200, height: 1,
  screenX: x, screenY: 0, shift: false, alt: false, ctrl: false,
});

const reset = () => delete (globalThis as any)[GLOBAL_KEY];

// --- 1. two parts, one widget, concatenated in join order -----------------
{
  reset();
  const ui = fakeUi();
  const hits: string[] = [];
  let shown: "capture" | "gate" | "disabled" = "capture";
  const cerberus = createIndicator({
    mode: () => shown,
    cycle: () => void (shown = shown === "capture" ? "disabled" : "capture"),
    notify: () => {},
    MouseRegion: api.MouseRegion,
  });

  const t = tui();
  joinStatusRow(ui, "hb_block", stubPart("hb_block:true", hits), api);
  assert.equal(ui.calls.length, 1, "the first part sets the widget");
  assert.equal(ui.calls[0].key, ROW_KEY);
  assert.equal(typeof ui.calls[0].content, "function");
  const row = (ui.calls[0].content as any)(t, theme);   // pi renders it once
  assert.deepEqual(row.render(200).map(plain), ["hb_block:true"], "one part, no padding");
  assert.equal(t.renders, 0, "rendering alone asks for nothing");

  joinStatusRow(ui, "cerberus", cerberus, api);
  assert.equal(ui.calls.length, 1, "the second join does not re-set the widget");
  assert.equal(t.renders, 1, "it repaints through the tui the render remembered");
  assert.deepEqual(row.render(200).map(plain), ["hb_block:true  success|cerberus:on"], "join order, PART_GAP between");

  // The indicator part keeps working inside the row.
  shown = "disabled";
  assert.deepEqual(row.render(200).map(plain), ["hb_block:true  dim|cerberus:off"]);

  // 4. Column routing: the click lands on the part that owns those columns.
  // `hb_block:true` is 13 columns, then PART_GAP, so the cerberus part starts at x=15.
  assert.equal(row.render(200).length, 1);
  row.handleMouse(clickAt(3));
  assert.deepEqual(hits, ["hb_block:true@3"], "the left part gets its own x");
  row.handleMouse(clickAt(12));
  assert.deepEqual(hits, ["hb_block:true@3", "hb_block:true@12"], "still the left part");
  assert.equal(shown, "disabled", "cerberus did not see those clicks");

  // The gap columns belong to nobody: x=13 and x=14 are the two spaces.
  row.handleMouse(clickAt(13));
  row.handleMouse(clickAt(14));
  assert.equal(hits.length, 2, "a click in the gap reaches no part");
  assert.equal(shown, "disabled", "and does not reach cerberus either");

  row.handleMouse(clickAt(15));   // the cerberus part owns [15, 15 + label)
  assert.equal(shown, "capture", "the double click reached cerberus's cycle");
  assert.equal(hits.length, 2, "and not the other part's handler");
  assert.deepEqual(row.render(200).map(plain), ["hb_block:true  success|cerberus:on"]);

  // A single click, the right button and a click past both parts do nothing.
  row.handleMouse(clickAt(15, 1));
  row.handleMouse({ ...clickAt(15), button: "right" });
  row.handleMouse(clickAt(190));
  assert.equal(shown, "capture", "no other click changes the mode");

  // 2. Leaving one part re-renders with only the other, and the last one clears.
  leaveStatusRow(ui, "hb_block");
  assert.equal(ui.calls.length, 1, "leaving a part does not touch the widget");
  assert.deepEqual(row.render(200).map(plain), ["success|cerberus:on"], "only the remaining part");
  leaveStatusRow(ui, "cerberus");
  assert.deepEqual(ui.calls.at(-1), { key: ROW_KEY, content: undefined }, "the row is removed");
  assert.equal(ui.calls.length, 2);

  // Repeated leaves, unknown ids: harmless.
  leaveStatusRow(ui, "cerberus");
  leaveStatusRow(ui, "nobody");
  assert.equal(ui.calls.length, 2, "nothing more is written");
  assert.equal((globalThis as any)[GLOBAL_KEY].parts.size, 0);
}

// --- the gap is exactly two columns, only between parts ------------------
// The same three labels are asserted in herdr-pair-coding's copy, so the two
// implementations are pinned to the same composed line.
{
  reset();
  const ui = fakeUi();
  const label = (text: string) => () => ({ render: () => [text], invalidate() {} });
  for (const [id, text] of [["a", "aaa"], ["b", "bbb"], ["c", "ccc"]]) {
    joinStatusRow(ui, id, label(text) as any, api);
  }
  const row = (ui.calls[0].content as any)(tui(), theme);
  assert.deepEqual(row.render(200).map(plain), ["aaa  bbb  ccc"], "two spaces between parts, none at the ends");

  leaveStatusRow(ui, "b");
  leaveStatusRow(ui, "c");
  assert.deepEqual(row.render(200).map(plain), ["aaa"], "a lone part gets no padding");
  leaveStatusRow(ui, "a");
}

// --- 3. a registry created by the other plugin first is reused ------------
{
  // Exactly the shape the spec documents, as another package would leave it.
  const theirCalls: string[] = [];
  const ui = fakeUi();
  const theirs = { render: () => ({ render: () => ["theirs"], invalidate() {} }) };
  (globalThis as any)[GLOBAL_KEY] = {
    version: 1,
    parts: new Map([["hb_block", () => ({ render: () => ["hb_block:false"], invalidate() {} })]]),
    widgetSet: true,
    render: (t: any, th: any) => {
      theirCalls.push("render");
      return theirs.render();
    },
  };
  joinStatusRow(ui, "cerberus", stubPart("cerberus:on"), api);
  assert.deepEqual(ui.calls, [], "no second setWidget: they already own the widget");
  const row = (globalThis as any)[GLOBAL_KEY];
  assert.deepEqual([...row.parts.keys()], ["hb_block", "cerberus"], "the existing part was kept");
  assert.equal(row.render, (globalThis as any)[GLOBAL_KEY].render);
  leaveStatusRow(ui, "cerberus");
  leaveStatusRow(ui, "hb_block");
  assert.deepEqual(ui.calls.at(-1), { key: ROW_KEY, content: undefined }, "the last leave still clears the row");
}

// --- 5. no HStack: the join refuses, and nothing is created --------------
{
  reset();
  const ui = fakeUi();
  assert.equal(statusRowAvailable({} as any), false);
  assert.throws(() => joinStatusRow(ui, "cerberus", stubPart("cerberus:on"), {} as any), /no HStack/);
  assert.deepEqual(ui.calls, [], "no widget was written");
  assert.equal((globalThis as any)[GLOBAL_KEY], undefined, "and no registry was created");

  // What the extension does with that: its own line under its own key.
  ui.setWidget(WIDGET_KEY, stubPart("cerberus:on"));
  assert.deepEqual(ui.calls.map((call) => call.key), [WIDGET_KEY]);
}

// --- a throwing setWidget leaves the registry as it was -------------------
{
  reset();
  const ui = fakeUi();
  let fail = true;
  const throwingUi = {
    calls: ui.calls,
    setWidget: (key: string, content: unknown) => {
      if (fail) throw new Error("setWidget refused");
      ui.setWidget(key, content);
    },
  };
  assert.throws(() => joinStatusRow(throwingUi, "cerberus", stubPart("cerberus:on"), api), /refused/);
  const row = (globalThis as any)[GLOBAL_KEY];
  assert.equal(row.parts.size, 0, "the part did not stay behind");
  assert.equal(row.widgetSet, false, "and we do not think we own a widget");
  fail = false;
  joinStatusRow(throwingUi, "cerberus", stubPart("cerberus:on"), api);
  assert.equal(ui.calls.length, 1, "a retry works");
  leaveStatusRow(ui, "cerberus");
}

reset();
console.log("status-row.test.ts: ok");
