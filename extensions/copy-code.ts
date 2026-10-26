// @ts-nocheck
/**
 * copy-code - the /copy-code shell. It lives in extensions/ because it contains
 * zero business logic.
 *
 * It does three things: map argv (`/copy-code 3` -> 3), adapt ctx into the shape
 * run.ts expects, and register the command + keybinding. Everything else (fence
 * parsing, session entries -> candidates, interaction flow, picker) is in
 * copy-code/.
 *
 * Loading: use `-e extensions/copy-code.ts` in a pi profile. Profiles run
 * `pi -ne -ns -np --no-mcp`, and `-ne` disables auto-discovery, so the command
 * does not exist without this line.
 *
 * Picker: typing filters immediately (fuzzy match on language + full code text;
 * a plain number matches the block ID exactly). Up/down selects, Enter copies,
 * Esc cancels. Everything uses public pi / pi-tui exports (Input, fuzzyFilter,
 * SelectList, getSelectListTheme), not internal paths.
 *
 * It also registers a Markdown transformer that tags each code block with a
 * stable `lang-id` label (e.g. `py-5`, `text-9`) at render time (gutter.ts). The
 * model never sees it: the transformer runs only on the render path, while the
 * model receives the archived message text. The tag table is rebuilt at session
 * start and at the end of every assistant message (one scan, ~18 ms on the
 * largest session).
 *
 * Moving/renaming: these relative paths are resolved at load time. Leave a
 * compatibility link at the old path before moving anything.
 */
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { scan, type Candidate, type GutterBlock } from "../copy-code/candidates.ts";
import { withBlockIds } from "../copy-code/gutter.ts";
import { CodePicker } from "../copy-code/picker.ts";
import { copyCodeBlock } from "../copy-code/run.ts";

function pick(ctx: ExtensionContext, candidates: readonly Candidate[]): Promise<Candidate | undefined> {
  return ctx.ui.custom<Candidate | undefined>((_tui, theme, _keybindings, done) =>
    new CodePicker(candidates, theme, done),
  );
}

function run(ctx: ExtensionContext, requested?: number): Promise<void> {
  return copyCodeBlock({
    entries: ctx.sessionManager.getBranch(),
    ui: {
      hasUi: ctx.hasUI,
      notify: (message, type) => ctx.ui.notify(message, type),
      pick: (candidates) => pick(ctx, candidates),
    },
    copy: copyToClipboard,
  });
}

export default function (pi: ExtensionAPI) {
  // Render-time annotation: reads the session, never writes to the context.
  let blocksByPart: ReadonlyMap<string, readonly GutterBlock[]> = new Map();
  // message_end fires before persistence (the extension listener runs first, then
  // public listeners, then the message is archived), so the message that just
  // finished is not in the branch yet. Scanning it as a tail is what gives the
  // newest answer an id; nothing calls the transformer again afterwards. The tag
  // is the same as a re-scan after persistence would produce.
  const refresh = (ctx: ExtensionContext, tail?: unknown): void => {
    const entries = ctx.sessionManager.getBranch();
    blocksByPart = scan(tail === undefined ? entries : [...entries, { type: "message", message: tail }]).blocksByPart;
  };
  // session_start also covers reason=reload, so /reload does not drop old IDs.
  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("message_end", (event, ctx) => {
    if (event.message?.role === "assistant") refresh(ctx, event.message);
  });
  pi.registerMarkdownTransformer((markdown, context) => withBlockIds(markdown, context, blocksByPart));

  pi.registerCommand("copy-code", {
    description: "Copy a code block from an earlier answer (usage: /copy-code [block id])",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (raw !== "" && !/^\d+$/.test(raw)) {
        ctx.ui.notify("Usage: /copy-code [block id]", "warning");
        return;
      }
      await run(ctx, raw === "" ? undefined : Number(raw));
    },
  });

  // alt+c: free in both the app and the editor defaults (alt+b/d/f/y are taken
  // by the editor; alt+p/q/v/z/up/down by the app). On macOS, Option+C is eaten
  // by the input method, so use a different key there.
  pi.registerShortcut("alt+c", {
    description: "Copy a code block from an earlier answer",
    handler: (ctx) => run(ctx),
  });
}
