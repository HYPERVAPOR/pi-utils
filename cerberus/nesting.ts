/**
 * Nesting the gate inside a task is refused, never staged.
 *
 * The CLI is the control plane: `cerberus log/wait/...` reads or drives a task. A
 * task that invokes it nests the protocol - the call becomes a task of its own, so
 * the model has to wait for the waiter - and `sleep 20 && cerberus log <id>` is the
 * common shape.
 *
 * A line is stopped in two places:
 *
 *   - capture, before staging, via `nestsGate(command)` in `rules.ts`: cheap, so the
 *     model gets the error immediately and nothing is run;
 *   - the CLI itself, via `CERBERUS_TASK_ID`, which every task's command inherits
 *     (`runner.ts`). That catches what no parser can see - a script file, a `sh -c`
 *     body built at runtime, `$BIN`, an alias, `xargs`. It is a guardrail, not a
 *     sandbox: a command that clears the variable can still nest.
 */
export const TASK_ENV = "CERBERUS_TASK_ID";

export interface NestingContext {
  /** The line or argv that tried to nest; shown for context. */
  snippet?: string;
  /** CLI name to show in the examples (may be a quoted absolute path). */
  bin?: string;
  /** The task the command was already running inside, when the CLI caught it. */
  inTask?: string;
}

/** The first line, short enough that the error stays a few lines. */
function preview(text: string, max = 160): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One message for both layers, so the model learns the same thing either way. */
export function nestingError(options: NestingContext = {}): string {
  const bin = options.bin ?? "cerberus";
  const where = options.inTask === undefined ? " inside a task" : ` inside task ${options.inTask}`;
  const lines = [`cerberus: error: refusing to run cerberus${where}`];
  if (options.snippet && options.snippet.trim()) lines.push(`  ${preview(options.snippet)}`);
  lines.push(
    "",
    "Why: cerberus is the control plane. A task that invokes it nests the protocol:",
    "the call becomes a task of its own, so you have to wait on the waiter.",
    options.inTask === undefined ? "Nothing was run." : "The cerberus call did not run.",
    "",
    "Do this instead: run the CLI as the whole bash call, where it runs locally:",
    `  ${bin} wait <id>     # block for the result (up to 60s)`,
    `  ${bin} log <id>      # or: rc <id>, ls`,
    `Never poll with sleep: \`${bin} wait <id>\` already blocks.`,
    "If you also need a real command, run it as a separate call.",
  );
  return lines.join("\n");
}
