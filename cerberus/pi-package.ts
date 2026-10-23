/**
 * pi's own package, resolved at runtime.
 *
 * `@earendil-works/pi-coding-agent` is a peer dependency. Inside pi the extension is
 * loaded through jiti aliases, so the bare specifier resolves; a plain
 * `node cerberus/test/...` run has no `node_modules` here, so the lookup then falls
 * back to the install pi runs itself. Either way the caller gets the real built-in
 * factory and the real truncation helpers - never a copy of pi's formatting.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE = "@earendil-works/pi-coding-agent";
/** Same install, same fallback: the TUI package ships beside the agent package. */
const TUI_PACKAGE = "@earendil-works/pi-tui";

/** The parts of pi this package builds on. */
export interface PiApi {
  /** pi's bash tool definition factory: same schema, description and formatting. */
  createBashToolDefinition: (cwd: string, options?: { operations?: unknown }) => any;
  /** pi's own local shell execution. */
  createLocalBashOperations: (options?: { shellPath?: string }) => any;
  /** The truncation pi applies to bash output, so a replayed result matches. */
  truncateTail: (content: string, options?: { maxLines?: number; maxBytes?: number }) => {
    content: string;
    truncated: boolean;
    truncatedBy: "lines" | "bytes" | null;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
    lastLinePartial: boolean;
  };
  formatSize: (bytes: number) => string;
  DEFAULT_MAX_LINES: number;
  DEFAULT_MAX_BYTES: number;
}

function entryOf(dir: string): string | undefined {
  const index = join(dir, "dist", "index.js");
  return existsSync(index) ? index : undefined;
}

function candidates(pkg: string): string[] {
  const urls: string[] = [pkg];

  const override = process.env.CERBERUS_PI_PACKAGE;
  if (override) {
    const index = override.endsWith(".js") ? override : entryOf(override);
    if (index && existsSync(index)) urls.push(pathToFileURL(index).href);
  }

  const releases = join(homedir(), ".pi", "agent", "install", "releases");
  try {
    const versions = readdirSync(releases).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    for (const version of versions.reverse()) {
      const index = entryOf(join(releases, version, "node_modules", pkg));
      if (index) urls.push(pathToFileURL(index).href);
    }
  } catch {
    // no pi install on this machine
  }
  return urls;
}

let loaded: Promise<PiApi> | undefined;

/** pi's own package, or a failure that names every place that was tried. */
export function loadPi(): Promise<PiApi> {
  loaded ??= (async () => {
    const tried: string[] = [];
    for (const specifier of candidates(PACKAGE)) {
      tried.push(specifier);
      try {
        const module = await import(specifier);
        if (typeof module.createBashToolDefinition === "function") return module as PiApi;
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`cannot load ${PACKAGE}; tried:\n  ${tried.join("\n  ")}`);
  })();
  return loaded;
}

/** The parts of pi's TUI package the status widgets use. */
export interface TuiApi {
  MouseRegion: new (child: { render(width: number): string[]; invalidate(): void }, onMouse: (event: any) => unknown) => any;
  /** Lays components out side by side - what the shared status row is made of. */
  HStack: new (children?: any[], options?: { gap?: number }) => any;
  /** Terminal columns of a rendered line, escape sequences excluded. */
  visibleWidth: (text: string) => number;
}

let loadedTui: Promise<TuiApi> | undefined;
let resolvedTui: TuiApi | undefined;

/**
 * The TUI module if it has already loaded. `joinStatusRow` has to be synchronous, so
 * it reads the module through here after `loadTui()` has been awaited.
 */
export function tuiApi(): TuiApi | undefined {
  return resolvedTui;
}

/** pi's TUI package, or a failure that names every place that was tried. */
export function loadTui(): Promise<TuiApi> {
  loadedTui ??= (async () => {
    const tried: string[] = [];
    for (const specifier of candidates(TUI_PACKAGE)) {
      tried.push(specifier);
      try {
        const module = await import(specifier);
        if (typeof module.MouseRegion === "function") return (resolvedTui = module as TuiApi);
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`cannot load ${TUI_PACKAGE}; tried:\n  ${tried.join("\n  ")}`);
  })();
  return loadedTui;
}
