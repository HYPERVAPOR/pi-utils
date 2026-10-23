/**
 * The mode indicator: one line next to the editor showing *this* session's mode.
 *
 * `ctx.ui.setStatus()` takes a string and cannot receive clicks, so the indicator is a
 * widget with a `MouseRegion` around it - the same technique as herdr-watchdog's
 * `hb_block`. Only presentation lives here: the mode itself is `cerberus/paths.ts`, and
 * the wiring (session id, timer, refresh on `/cerberus`) is in `extensions/cerberus.ts`.
 *
 * `render()` never touches the disk. It reads the mode the extension last refreshed, so
 * a busy editor does not pay for an indicator, and a slow state root cannot make the
 * TUI stutter.
 */
import type { Mode } from "../../cerberus/paths.ts";

/** The widget key, so shutdown can remove exactly the widget it added. */
export const WIDGET_KEY = "cerberus";

/** The two modes, in the order a double click walks them: on -> off -> on. */
export const ORDER: readonly Mode[] = ["capture", "disabled"];

/** What a double click does: on -> off, off -> on. */
export function cycleMode(mode: Mode): Mode {
  const index = ORDER.indexOf(mode);
  return ORDER[(index + 1) % ORDER.length] ?? ORDER[0];
}

/** `cerberus:on` / `cerberus:off` - the words the switch uses, and short enough to fit. */
export function indicatorText(mode: Mode): string {
  return `cerberus:${mode === "capture" ? "on" : "off"}`;
}

/** Colour by meaning: cerberus is running every command, or it is not there. */
const COLORS: Record<Mode, string> = { capture: "success", disabled: "dim" };

/** The parts of pi's TUI this module uses, structurally - no runtime import. */
export interface Theme {
  fg(color: string, text: string): string;
}

export interface Tui {
  requestRender(): void;
}

export interface Component {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

export interface MouseEvent {
  type?: string;
  button?: string;
  clickCount?: number;
}

/** `MouseRegion` from `@earendil-works/pi-tui`, passed in by the caller. */
export type MouseRegionCtor = new (child: Component, onMouse: (event: MouseEvent) => unknown) => Component;

export interface IndicatorOptions {
  /** The mode to show. A cached value: called per render, but never reads the disk. */
  mode: () => Mode;
  /** Double click: change the mode for this session. May throw; the click reports it. */
  cycle: () => void;
  /** Where a failed click is reported instead of throwing into the renderer. */
  notify: (message: string, level: "info" | "warning") => void;
  /** Without it the indicator still renders, it just takes no clicks. */
  MouseRegion?: MouseRegionCtor;
}

function oneLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split("\n")[0].trim();
}

/**
 * The widget factory pi calls: `setWidget(WIDGET_KEY, createIndicator(...))`.
 *
 * A single click is deliberately a no-op - a mode change must not happen by accident -
 * and so is the right or middle button.
 */
export function createIndicator(options: IndicatorOptions) {
  return (tui: Tui, theme: Theme): Component => {
    let disposed = false;

    const face: Component = {
      render(width: number) {
        const mode = options.mode();
        // ASCII only, so `length` is the visible width: the label either fits or is cut.
        const label = indicatorText(mode);
        return [theme.fg(COLORS[mode], label.length > width ? label.slice(0, width) : label)];
      },
      invalidate() {},
    };

    const onClick = (event: MouseEvent) => {
      if (disposed) return undefined;
      // The alt screen only routes a click to a component that claimed the preceding
      // press, so claim the left press before looking at clicks.
      if (event.type === "press" && event.button === "left") return { handled: true };
      if (event.type !== "click" || event.button !== "left") return undefined;
      // Exactly a double click: clickCount wraps 1,2,3,1, so "< 2" would cycle twice.
      if (event.clickCount !== 2) return { handled: true };
      try {
        options.cycle();
      } catch (err) {
        // A click must not throw into the renderer and has nowhere else to report.
        options.notify(`cerberus: ${oneLine(err)}`, "warning");
      }
      if (!disposed) tui.requestRender();
      return { handled: true };
    };

    if (!options.MouseRegion) return face;
    const region: Component = new options.MouseRegion(face, onClick);
    // Take the region's own cleanup before ours replaces it, or dispose() recurses.
    const innerDispose = region.dispose?.bind(region);
    return Object.assign(region, {
      dispose() {
        disposed = true;
        innerDispose?.();
      },
    });
  };
}
