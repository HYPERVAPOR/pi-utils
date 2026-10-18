/**
 * /tools - show which tools are declared to the model in this session.
 *
 * pi has no built-in /tools command (it ships /session /hotkeys /mcp and
 * friends), so this fills the gap. It registers only a command, no tool, so it
 * costs 0 tokens per request.
 *
 * ✓ = declared to the model (pi.getActiveTools(), affected by --tools /
 *     defaultTools)
 * · = registered but not active (e.g. excluded by the --tools whitelist, or
 *     exposed through codemode/deferred)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function toolsExtension(pi: ExtensionAPI) {
  pi.registerCommand("tools", {
    description: "List tools declared to the model in this session (✓) and other registered tools (·)",
    handler: async (_args, ctx) => {
      const active = new Set(pi.getActiveTools());
      const all = pi.getAllTools().sort((a, b) => a.name.localeCompare(b.name));
      if (all.length === 0) {
        ctx.ui.notify("No tools registered", "warning");
        return;
      }

      const row = (name: string, mark: string, exposure: string, source: string) =>
        `${mark} ${name}  · ${exposure}  · ${source}`;

      const options = [
        ...all.filter((t) => active.has(t.name)).map((t) => row(t.name, "✓", t.exposure, t.sourceInfo.source)),
        ...all.filter((t) => !active.has(t.name)).map((t) => row(t.name, "·", t.exposure, t.sourceInfo.source)),
      ];

      const choice = await ctx.ui.select(`Tools (${active.size} active / ${all.length} registered)`, options);
      if (!choice) return;

      // Row format is fixed: "<mark> <name>  · ..."; tool names contain no spaces.
      const name = choice.slice(2).split("  · ")[0];
      const tool = all.find((t) => t.name === name);
      if (!tool) return;
      ctx.ui.notify(
        [
          `${tool.name}  (${tool.exposure}${active.has(tool.name) ? ", declared to model" : ", not declared"})`,
          tool.sourceInfo.path,
          ...(tool.promptGuidelines?.length ? ["", ...tool.promptGuidelines.map((g) => `· ${g}`)] : []),
          "",
          tool.description ?? "",
        ].join("\n"),
        "info",
      );
    },
  });
}
