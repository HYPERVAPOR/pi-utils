/**
 * Self-check for extensions/cerberus/widget.ts: the indicator's text, its cycle order,
 * and the component's render/click/dispose behaviour with a fake theme and TUI. The
 * wiring (session_start, timer, shutdown) is covered in hook.test.ts.
 *
 *   node extensions/cerberus/test/widget.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = mkdtempSync(join(tmpdir(), "cerberus-widget-state-"));
process.env.XDG_STATE_HOME = state;

const { createIndicator, cycleMode, indicatorText, ORDER, WIDGET_KEY } = await import("../widget.ts");
const { readMode, writeMode } = await import("../../../cerberus/paths.ts");

// --- the text and the order are the contract -------------------------------
{
  assert.equal(indicatorText("capture"), "cerberus:on");
  assert.equal(indicatorText("disabled"), "cerberus:off");
  for (const mode of ORDER) assert.ok(indicatorText(mode).length <= 24, `${mode} fits in 24 columns`);
  assert.equal(WIDGET_KEY, "cerberus");
  assert.deepEqual([...ORDER], ["capture", "disabled"], "two modes");

  assert.equal(cycleMode("capture"), "disabled", "a double click turns it off");
  assert.equal(cycleMode("disabled"), "capture", "and on again");
}

/** A theme that shows the colour name instead of an escape sequence. */
const theme = { fg: (color: string, text: string) => `${color}|${text}` };

/** Just enough of pi's TUI: count the render requests. */
function fakeTui() {
  const seen = { renders: 0 };
  return { seen, requestRender: () => void seen.renders++ };
}

/** A stand-in for `MouseRegion` that keeps the handler reachable. */
function fakeMouseRegion() {
  const seen: { onClick?: (event: any) => any } = {};
  class Region {
    constructor(child: any, onClick: (event: any) => any) {
      seen.onClick = onClick;
      Object.assign(this, child);
    }
    render(width: number) {
      return (this as any).render(width);
    }
  }
  return { seen, Region: Region as any };
}

const click = (button = "left", clickCount = 2) => ({ type: "click", button, clickCount });

// --- render follows the mode, and never reads the disk itself --------------
{
  let shown: "capture" | "disabled" = "capture";
  const indicator = createIndicator({ mode: () => shown, cycle: () => {}, notify: () => {} });
  const tui = fakeTui();
  const component = indicator(tui, theme);

  assert.deepEqual(component.render(80), ["success|cerberus:on"]);
  assert.equal(tui.seen.renders, 0, "rendering is not a reason to repaint");

  shown = "disabled";
  assert.deepEqual(component.render(80), ["dim|cerberus:off"]);

  // A narrow editor: the label is cut, never wider than what is offered.
  for (const width of [0, 5, 9, 16]) {
    const [line] = component.render(width);
    assert.equal(line.split("|")[1].length, Math.min(width, "cerberus:off".length), `width ${width}`);
  }
}

// --- this session's value only --------------------------------------------
{
  writeMode("disabled");
  writeMode("capture", "sess-a");
  writeMode("capture", "sess-b");
  // What the extension does: refresh the cached value, then repaint.
  let shown = readMode("sess-a");
  const component = createIndicator({ mode: () => shown, cycle: () => {}, notify: () => {} })(fakeTui(), theme);
  assert.deepEqual(component.render(80), ["success|cerberus:on"]);

  writeMode("disabled", "sess-b");
  shown = readMode("sess-a");
  assert.deepEqual(component.render(80), ["success|cerberus:on"], "another session's switch does not leak in");

  writeMode("disabled", "sess-a");
  shown = readMode("sess-a");
  assert.deepEqual(component.render(80), ["dim|cerberus:off"], "and following its own does work");
}

// --- clicks: only a double click cycles, and a failure is reported ---------
{
  const events: string[] = [];
  const fake = fakeMouseRegion();
  let cycles = 0;
  let boom: Error | undefined;
  const indicator = createIndicator({
    mode: () => "capture",
    cycle: () => {
      cycles++;
      if (boom) throw boom;
    },
    notify: (message, level) => events.push(`${level}: ${message}`),
    MouseRegion: fake.Region,
  });
  const tui = fakeTui();
  const component = indicator(tui, theme);
  const onClick = fake.seen.onClick as (event: any) => any;
  assert.ok(onClick, "the widget wraps itself in a mouse region");

  assert.deepEqual(onClick({ type: "press", button: "left" }), { handled: true }, "the press is claimed");
  assert.equal(onClick({ type: "press", button: "right" }), undefined, "other presses are left alone");
  onClick(click("left", 1));
  assert.equal(cycles, 0, "a single click must not change the mode");
  onClick(click("right", 2));
  onClick(click("middle", 2));
  assert.equal(cycles, 0, "only the left button matters");
  onClick(click("left", 3));
  assert.equal(cycles, 0, "clickCount 3 is not a double click (it wraps to 1)");
  assert.equal(tui.seen.renders, 0, "a no-op click repaints nothing");

  onClick(click("left", 2));
  assert.equal(cycles, 1, "double click cycles");
  assert.equal(tui.seen.renders, 1, "and repaints");
  assert.deepEqual(events, [], "a working click says nothing");

  boom = new Error("cannot write config\nsecond line");
  assert.deepEqual(onClick(click("left", 2)), { handled: true }, "a throwing cycle does not escape");
  assert.equal(cycles, 2);
  assert.deepEqual(events, ["warning: cerberus: cannot write config"], "reported, one line, as a warning");
  boom = undefined;
}

// --- without the TUI package the indicator still renders, it just cannot click
{
  const component = createIndicator({ mode: () => "disabled", cycle: () => {}, notify: () => {} })(fakeTui(), theme);
  assert.deepEqual(component.render(80), ["dim|cerberus:off"]);
  assert.equal((component as any).handleMouse, undefined, "no mouse region, no handler");
  assert.equal(typeof component.dispose, "undefined", "and nothing to dispose");
}

// --- dispose stops the repaints (session switch, /reload, exit) -----------
{
  const fake = fakeMouseRegion();
  let cycles = 0;
  const tui = fakeTui();
  const component = createIndicator({
    mode: () => "disabled",
    cycle: () => void cycles++,
    notify: () => {},
    MouseRegion: fake.Region,
  })(tui, theme);
  const onClick = fake.seen.onClick as (event: any) => any;

  component.dispose?.();
  onClick(click("left", 2));
  assert.equal(cycles, 0, "a disposed widget does not change the mode");
  assert.equal(tui.seen.renders, 0, "nor ask for a repaint");
  component.dispose?.();   // idempotent
}

rmSync(state, { recursive: true, force: true });
console.log("widget.test.ts: ok");
