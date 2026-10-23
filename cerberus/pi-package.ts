/**
 * pi's own bash tool factories, resolved at runtime.
 *
 * `@earendil-works/pi-coding-agent` is a peer dependency. Inside pi the extension is
 * loaded through jiti aliases, so the bare specifier resolves; a plain
 * `node cerberus/test/...` run has no `node_modules` here, so the lookup then falls
 * back to the install pi runs itself. Either way the caller gets the real built-in
 * factory - never a copy of its schema, description or formatting.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE = "@earendil-works/pi-coding-agent";

/** The two bash factories this package builds on. */
export interface PiBash {
  /** pi's bash tool definition factory: same schema, description and formatting. */
  createBashToolDefinition: (cwd: string, options?: { operations?: unknown }) => any;
  /** pi's own local shell execution. */
  createLocalBashOperations: (options?: { shellPath?: string }) => any;
}

function entryOf(dir: string): string | undefined {
  const index = join(dir, "dist", "index.js");
  return existsSync(index) ? index : undefined;
}

function candidates(): string[] {
  const urls: string[] = [PACKAGE];

  const override = process.env.CERBERUS_PI_PACKAGE;
  if (override) {
    const index = override.endsWith(".js") ? override : entryOf(override);
    if (index && existsSync(index)) urls.push(pathToFileURL(index).href);
  }

  const releases = join(homedir(), ".pi", "agent", "install", "releases");
  try {
    const versions = readdirSync(releases).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    for (const version of versions.reverse()) {
      const index = entryOf(join(releases, version, "node_modules", PACKAGE));
      if (index) urls.push(pathToFileURL(index).href);
    }
  } catch {
    // no pi install on this machine
  }
  return urls;
}

let loaded: Promise<PiBash> | undefined;

/** pi's bash factories, or a failure that names every place that was tried. */
export function loadPiBash(): Promise<PiBash> {
  loaded ??= (async () => {
    const tried: string[] = [];
    for (const specifier of candidates()) {
      tried.push(specifier);
      try {
        const module = await import(specifier);
        if (typeof module.createBashToolDefinition === "function") {
          return {
            createBashToolDefinition: module.createBashToolDefinition,
            createLocalBashOperations: module.createLocalBashOperations,
          };
        }
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`cannot load ${PACKAGE}; tried:\n  ${tried.join("\n  ")}`);
  })();
  return loaded;
}
