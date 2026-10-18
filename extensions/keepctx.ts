/**
 * /keepctx - compact the context with a fixed brevity instruction.
 *
 * Keeps background, current state, facts, goals and this pane's role;
 * drops the reasoning in between; keeps the summary short.
 *
 * Usage: /keepctx [extra instruction]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INSTRUCTIONS =
  "Keep the background, current state, facts, goals, and this pane's role. Omit intermediate reasoning. Keep the summary short.";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("keepctx", {
    description: "Compact, keeping background/state/facts/goals/role and dropping the reasoning",
    handler: async (args, ctx) => {
      const extra = args.trim();
      ctx.ui.notify("Compacting: keep background/state/facts/goals/role, drop reasoning", "info");
      ctx.compact({
        customInstructions: extra ? `${INSTRUCTIONS} Additional requirement: ${extra}` : INSTRUCTIONS,
        onComplete: (result) => {
          ctx.ui.notify(`Compacted from ${result.tokensBefore.toLocaleString()} tokens`, "info");
        },
        onError: (error) => {
          ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
        },
      });
    },
  });
}
