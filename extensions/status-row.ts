/**
 * One line for several plugins.
 *
 * pi renders every `ctx.ui.setWidget(key, …)` as a child of a vertical container
 * (`renderWidgetContainer` just adds them in order), so two plugins that both want a
 * status line always get two lines. `setWidget` is keyed, though, so plugins can agree
 * on one key, keep a registry on `globalThis` and lay their parts out with pi-tui's
 * `HStack` - one line, several owners.
 *
 * The registry is the contract between the packages that use it: whoever gets there
 * first creates it, it survives being created by the other side, and the last part to
 * leave removes the widget.
 *
 * A part is a component factory, not a component: `render` builds fresh children every
 * frame, so a part keeps its own `MouseRegion` and clicks keep landing on the part that
 * owns the column.
 */
import type { Component, Theme, Tui } from "./cerberus/widget.ts";
import { tuiApi, type TuiApi } from "../cerberus/pi-package.ts";

/** The widget key every participant uses - one key, one line. */
export const ROW_KEY = "status-row";

/** Blank columns between two parts, so two labels never read as one word. */
export const PART_GAP = 2;

/**
 * Version of the *composition* (how parts become a line), separate from the shape
 * version of the registry. 2 = parts separated by `PART_GAP`.
 *
 * It exists because `globalThis.__piStatusRow` outlives the code that made it: after
 * `/reload` the registry - and the widget holding its `render` - are from the old
 * build. A join from newer code has to notice and take the composition over.
 */
export const RENDER_VERSION = 2;

/** A part's component factory: the same shape as a `setWidget` factory. */
export type Part = (tui: Tui, theme: Theme) => Component;

export interface RowUi {
  setWidget(key: string, content: Part | undefined): void;
}

export interface Registry {
  version: 1;
  /** absent on registries written before the gap: those compose the glued line */
  renderVersion?: number;
  parts: Map<string, Part>;
  /** true while this registry owns the widget under `ROW_KEY` */
  widgetSet: boolean;
  /** remembered from the last render, so a later join can ask for a repaint */
  tui?: Tui;
  render(tui: Tui, theme: Theme): Component;
}

const GLOBAL_KEY = "__piStatusRow";

/** True when this pi-tui can lay parts out side by side (older builds cannot). */
export function statusRowAvailable(api: TuiApi | undefined = tuiApi()): api is TuiApi {
  return typeof api?.HStack === "function";
}

function existing(): Registry | undefined {
  const row = (globalThis as any)[GLOBAL_KEY] as Registry | undefined;
  // Any shape version we still understand: an older copy of this file may have made it.
  return typeof row?.version === "number" && row.version >= 1 ? row : undefined;
}

/**
 * The composition: how this build turns a registry's parts into a line. Separate from
 * the registry so a stale registry can be given the current composition without
 * losing its parts.
 */
function composeRender(api: TuiApi, self: () => Registry): Registry["render"] {
  return (tui: Tui, theme: Theme): Component => {
    const row = self();
    row.tui = tui;
    // One HStack for the life of the widget, refilled on every render: a part that
    // joins later (or leaves) shows up on the next frame, without re-setting the
    // widget. `render(width)` returns the lines `Container` would, so pi's layout
    // engine owns the horizontal allocation. `gap` puts PART_GAP columns *between*
    // parts only - `HStack` never pads the ends.
    const stack: any = new api.HStack([], { gap: PART_GAP });
    let children: Component[] = [];
    return {
      render(width: number): string[] {
        stack.clear();
        children = [...row.parts.values()].map((part) => part(tui, theme));
        for (const child of children) stack.addChild(child);
        return stack.render(width);
      },
      invalidate() {
        stack.invalidate?.();
      },
      // pi's `Container.handleMouse` finds children by row only, which for a
      // horizontal stack would hand every click to the first part.
      handleMouse(event: any) {
        let start = 0;
        for (const [index, child] of children.entries()) {
          // The width `HStack` gives this child when the parts fit - which is every
          // terminal wide enough to show two short labels on one line.
          const width = child
            .render(event.width)
            .reduce((widest: number, line: string) => Math.max(widest, api.visibleWidth(line)), 0);
          if (event.x >= start && event.x < start + width) {
            return child.handleMouse?.({ ...event, x: event.x - start });
          }
          // The gap belongs to nobody: a click in it reaches no part.
          start += width + (index === children.length - 1 ? 0 : PART_GAP);
        }
        return undefined;
      },
    };
  };
}

function buildRegistry(api: TuiApi): Registry {
  let row: Registry;
  row = {
    version: 1,
    renderVersion: RENDER_VERSION,
    parts: new Map(),
    widgetSet: false,
    render: composeRender(api, () => row),
  };
  return row;
}

function registry(api: TuiApi | undefined = tuiApi()): Registry {
  const built = existing();
  // Someone else's registry: add to it, but keep its parts and its keys.
  if (built) return built;
  if (!statusRowAvailable(api)) throw new Error("status row: this pi-tui has no HStack");
  const row = buildRegistry(api);
  (globalThis as any)[GLOBAL_KEY] = row;
  return row;
}

/**
 * Add (or replace) this plugin's part. The widget is set once, by whoever arrives
 * first; later joins only add a part and repaint.
 *
 * A registry left over from an older build (no `renderVersion`, or an older one) gets
 * *this* build's composition, keeping its parts. `widgetSet` then has to be set again:
 * the widget in pi holds the old `render` function, so replacing the field alone would
 * keep the old line.
 */
export function joinStatusRow(ui: RowUi, id: string, part: Part, api: TuiApi | undefined = tuiApi()): void {
  const row = registry(api);
  const previous = row.parts.get(id);
  row.parts.set(id, part);
  if (!row.widgetSet || (row.renderVersion ?? 0) < RENDER_VERSION) {
    // A stale registry (older build, maybe after `/reload`) keeps its parts but gets
    // this build's composition - and the widget has to be set again, because pi holds
    // the old `render` function, not the registry.
    if ((row.renderVersion ?? 0) < RENDER_VERSION) {
      if (!statusRowAvailable(api)) throw new Error("status row: this pi-tui has no HStack");
      row.render = composeRender(api, () => row);
      row.renderVersion = RENDER_VERSION;
    }
    try {
      ui.setWidget(ROW_KEY, row.render);
      row.widgetSet = true;
    } catch (err) {
      // Put the registry back the way we found it: a caller that falls back to its own
      // widget must not leave a part behind in a row nobody can see.
      if (previous) row.parts.set(id, previous);
      else row.parts.delete(id);
      throw err;
    }
  }
  row.tui?.requestRender();
}

/** Remove this plugin's part. Idempotent, and harmless for an id nobody joined with. */
export function leaveStatusRow(ui: RowUi, id: string): void {
  const row = existing();
  if (!row) return;
  row.parts.delete(id);
  if (row.parts.size > 0) {
    row.tui?.requestRender();
    return;
  }
  row.tui = undefined;
  if (row.widgetSet) {
    // Reset before the call: a throwing setWidget must not leave us thinking we own
    // a widget that is gone.
    row.widgetSet = false;
    ui.setWidget(ROW_KEY, undefined);
  }
  // Nobody is using it any more, so do not leave it for the next build to find: a
  // reload (or a session switch) then starts from a registry the current code made.
  if (existing() === row) delete (globalThis as any)[GLOBAL_KEY];
}
