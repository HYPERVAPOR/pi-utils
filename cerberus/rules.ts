/**
 * "Does this command look long-running?" - the gate's only question.
 *
 * The table is deliberately small and conservative: a miss is harmless (the command
 * runs in the foreground exactly as before), while a false positive costs the model
 * an extra turn. Rules look at one simple command's argv[0] and flags, never at a
 * regex over the whole string, so `echo "sleep 600"` cannot trigger them.
 *
 * Wrappers that merely prefix another command (`sudo`, `env`, `nice`, `nohup`,
 * `timeout`, ...) are unwrapped first, and `bash -c '<script>'` / `eval '<script>'`
 * are re-parsed recursively. `timeout N cmd` is a wrapper, not an exemption: the
 * inner command still decides — unless N is a short leash (<= 15s), because then
 * the wrapper bounds the whole line whatever it wraps. The project runners
 * `uv run`, `poetry run`, `pipenv run`, `pdm run`, `hatch run` unwrap the same way,
 * and `python -m pytest` is recognised as pytest. A script file passed to bash or
 * python is not read: a miss is preferred.
 *
 * The gate's own CLI is exempt in both directions: `cerberus fg/bg/ls/...` is never
 * long (it is the answer to a gate, and staging it would nest the protocol), and
 * `invokesGate()` tells the CLI when a staged command would run the gate itself.
 *
 * Three syntax-only refinements keep false positives off the table: a `--version`,
 * `--help` or `--dry-run` flag means the tool is not doing the work; `timeout`
 * with N <= 15s caps the command itself; and `git clone`/`rsync`/`scp` only earn a
 * gate when an operand is remote (`scheme://...` or `[user@]host:path`), since a
 * local copy needs no answer.
 */

export interface SimpleCommand {
  argv: string[];
  /** true when the command was terminated by a single `&` */
  background: boolean;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** Leading shell syntax that is not part of the command that follows it. */
export const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "while", "until", "do", "done", "!", "{",
  "case", "esac", "for", "select", "function",
]);
const WRAPPERS = new Set([
  "sudo", "env", "command", "time", "nice", "stdbuf", "nohup", "setsid", "exec", "xargs",
  "timeout",
]);
/** `<runner> run <cmd>` / `<runner> exec <cmd>`: the inner command decides. */
const RUNNERS = new Set(["uv", "poetry", "pipenv", "pdm", "hatch"]);
/** Flags of `uv run` & friends that consume the next argument. */
const RUNNER_VALUE_FLAGS = new Set([
  "--group", "--with", "--without", "--only-group", "--python", "-p", "--project",
  "--directory", "--extra", "--index", "--default-index", "--cache-dir", "--env-file",
  "-e", "--package", "--lockfile", "--config-file", "-C",
]);

/** Options of wrapper commands that consume the following argument. */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set([
    "-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from",
    "-D", "--chdir", "-r", "--role", "-t", "--type", "-T", "--command-timeout",
    "-U", "--other-user",
  ]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  nice: new Set(["-n", "--adjustment"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  time: new Set(["-o", "--output", "-f", "--format"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  xargs: new Set([
    "-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace",
    "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars",
  ]),
  exec: new Set(["-a"]),
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a shell line into simple commands on unquoted `;`, `&&`, `||`, `|`, `&`,
 * newlines and grouping parentheses. Quotes and backslash escapes are honoured,
 * and `>&` redirections are not mistaken for a background `&`.
 */
export function splitCommands(input: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let argv: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | undefined;

  const pushToken = () => {
    if (started) {
      argv.push(token);
      token = "";
      started = false;
    }
  };
  const end = (background: boolean) => {
    pushToken();
    if (argv.length > 0) commands.push({ argv, background });
    // `(...) &`: the `&` follows a group that already closed its command.
    else if (background && commands.length > 0) commands[commands.length - 1].background = true;
    argv = [];
    started = false;
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < input.length) token += input[++i];
      else token += char;
      continue;
    }
    if (char === "\\") {
      started = true;
      if (i + 1 < input.length) token += input[++i];
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      pushToken();
      continue;
    }
    if (char === "(" || char === ")") {
      // Grouping / subshell / `$(...)`: the body is its own command *and* the
      // tokens after `)` start a fresh one, so `X=$(mktemp -d) timeout 900 uv
      // run pytest` keeps the real command instead of folding it into argv[0].
      end(false);
      continue;
    }
    if (char === "\n" || char === ";") {
      end(false);
      continue;
    }
    if (char === "&") {
      if (input[i + 1] === "&") {
        end(false);
        i++;
      } else if (token.endsWith(">") || input[i + 1] === ">") {
        // `2>&1`, `&>file`: part of a redirection, not a background operator.
        token += char;
        started = true;
      } else {
        end(true);
      }
      continue;
    }
    if (char === "|") {
      end(false);
      if (input[i + 1] === "|") i++;
      continue;
    }
    if (char === "#" && !started) {
      while (i + 1 < input.length && input[i + 1] !== "\n") i++;
      continue;
    }
    token += char;
    started = true;
  }
  end(false);
  return commands;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

interface Unwrapped {
  target: string[];
  /** true when a `setsid --fork`/`-f` prefix detaches before the command runs */
  forks: boolean;
  /** true when a `timeout N` prefix bounds the command to <= 15s */
  capped: boolean;
}

/**
 * Drop assignments, shell keywords and prefix wrappers so `target[0]` is the
 * command that actually decides how long this simple command takes.
 */
function unwrap(argv: string[]): Unwrapped {
  let i = 0;
  let forks = false;
  let capped = false;
  for (;;) {
    while (i < argv.length && (ASSIGNMENT.test(argv[i]) || SHELL_KEYWORDS.has(argv[i]))) i++;
    if (i >= argv.length) break;
    const exec = basename(argv[i]);
    if (RUNNERS.has(exec)) {
      let j = i + 1;
      while (j < argv.length && argv[j].startsWith("-")) {
        const eq = argv[j].indexOf("=");
        const name = eq > 0 ? argv[j].slice(0, eq) : argv[j];
        j += RUNNER_VALUE_FLAGS.has(name) && eq < 0 ? 2 : 1;
      }
      if (j < argv.length && (argv[j] === "run" || argv[j] === "exec")) {
        i = j + 1;
        // Flags of `run` itself, then the inner command.
        while (i < argv.length && argv[i].startsWith("-")) {
          const eq = argv[i].indexOf("=");
          const name = eq > 0 ? argv[i].slice(0, eq) : argv[i];
          i += RUNNER_VALUE_FLAGS.has(name) && eq < 0 ? 2 : 1;
        }
        continue;
      }
      break;
    }
    if (!WRAPPERS.has(exec)) break;
    if (exec === "setsid") {
      for (let j = i + 1; j < argv.length && argv[j].startsWith("-"); j++) {
        const arg = argv[j];
        if (arg === "--fork" || (!arg.startsWith("--") && arg.slice(1).includes("f"))) forks = true;
      }
    }
    i++;
    const valueFlags = WRAPPER_VALUE_FLAGS[exec];
    while (i < argv.length) {
      const arg = argv[i];
      if (ASSIGNMENT.test(arg)) {
        i++;
        continue;
      }
      if (arg === "--") {
        i++;
        break;
      }
      if (arg.startsWith("-")) {
        const eq = arg.indexOf("=");
        const name = eq > 0 ? arg.slice(0, eq) : arg;
        i += valueFlags?.has(name) && eq < 0 ? 2 : 1;
        continue;
      }
      break;
    }
    // `timeout <duration> <command>`: the duration is not the command. A duration
    // the wrapper honours in 15s or less makes the whole line short, whatever it
    // wraps. N = 0 means *no* limit to coreutils, so it is not a cap; an unparsable
    // duration keeps the old behaviour (the inner command decides).
    if (exec === "timeout" && i < argv.length && !argv[i].startsWith("-")) {
      const seconds = parseSleepSeconds(argv[i]);
      if (seconds !== undefined && seconds > 0 && seconds <= 15) capped = true;
      i++;
    }
  }
  return { target: argv.slice(i), forks, capped };
}

function firstNonFlag(args: string[], from = 1): string | undefined {
  for (let i = from; i < args.length; i++) {
    if (!args[i].startsWith("-")) return args[i];
  }
  return undefined;
}

function hasShortFlag(args: string[], letters: string): boolean {
  return args.some((arg) => arg.startsWith("-") && !arg.startsWith("--") && [...letters].some((l) => arg.includes(l)));
}

function hasAnyFlag(args: string[], names: string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function parseSleepSeconds(value: string | undefined): number | undefined {
  if (value === "infinity") return Infinity;
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(value ?? "");
  if (!match) return undefined;
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] || "s"] ?? 1;
  return Number(match[1]) * factor;
}

function sleepIsLong(args: string[]): boolean {
  let total = 0;
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-")) continue;
    const seconds = parseSleepSeconds(arg);
    if (seconds === undefined) continue;
    if (!Number.isFinite(seconds)) return true;
    total += seconds;
  }
  return total >= 15;
}

const PACKAGE_SUBCOMMANDS = new Set(["install", "ci", "build", "test", "start", "dev"]);
/** Flags that select a workspace; their value is not the subcommand. */
const PACKAGE_VALUE_FLAGS = new Set([
  "--filter", "-F", "-C", "--prefix", "--dir", "--cwd", "--workspace", "-w", "--scope",
  "--registry", "--tag", "--cache", "--store-dir",
]);

/** Like `firstNonFlag`, but also skips the value of workspace-selecting flags. */
function firstNonFlagValueAware(args: string[], from = 1): string | undefined {
  for (let i = from; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) return arg;
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (PACKAGE_VALUE_FLAGS.has(name) && eq < 0) i++;
  }
  return undefined;
}

function packageManagerIsLong(args: string[]): boolean {
  const sub = firstNonFlagValueAware(args);
  if (sub === undefined) return false;
  if (PACKAGE_SUBCOMMANDS.has(sub)) return true;
  if (sub === "run") {
    const scriptIndex = args.indexOf("run");
    return firstNonFlagValueAware(args, scriptIndex + 1) !== undefined;
  }
  return false;
}

function hasSubcommand(args: string[], allowed: Set<string>): boolean {
  const sub = firstNonFlag(args);
  return sub !== undefined && allowed.has(sub);
}

function pipIsLong(args: string[]): boolean {
  return firstNonFlag(args) === "install";
}

function uvIsLong(args: string[]): boolean {
  const sub = firstNonFlag(args);
  if (sub === "install" || sub === "sync" || sub === "add") return true;
  if (sub === "pip") {
    const after = args.indexOf("pip");
    return firstNonFlag(args, after + 1) === "install";
  }
  return false;
}

/**
 * `scheme://...` or `[user@]host:path` (colon before the first slash). A bare
 * relative name, `.`, `~`, `./x` or `/abs` is a copy on this machine.
 */
function isRemoteOperand(operand: string): boolean {
  if (operand.includes("://")) return true;
  const colon = operand.indexOf(":");
  if (colon <= 0) return false;
  const slash = operand.indexOf("/");
  return slash < 0 || colon < slash;
}

function hasRemoteOperand(args: string[]): boolean {
  return args.some((arg) => !arg.startsWith("-") && isRemoteOperand(arg));
}

function sshHasRemoteCommand(args: string[]): boolean {
  // Options that take a value; without this `ssh -p 22 host` would look remote.
  const valueFlags = new Set([
    "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l",
    "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w",
  ]);
  let i = 1;
  while (i < args.length && args[i].startsWith("-")) {
    i += valueFlags.has(args[i]) ? 2 : 1;
  }
  if (i >= args.length) return false;
  return i + 1 < args.length;
}

/** `bash -c '<script>'` / `bash -lc '<script>'` -> the script argument. */
function shellScriptArg(args: string[]): string | undefined {
  // Only options before the script name can be `-c`; `bash script.sh -c ...`
  // passes `-c` to the script, not to bash.
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--" || !arg.startsWith("-")) return undefined;
    const cluster = arg.startsWith("--") ? "" : arg.slice(1);
    if (cluster.includes("c")) return args[i + 1];
  }
  return undefined;
}

function isLongCommand(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const exec = basename(argv[0]);
  const args = argv;

  // Asking a tool for its version, its help or a dry run never runs the work.
  // (`-h`/`-v` are left alone: hostname/verbose mean the opposite.)
  if (hasAnyFlag(args, ["--version", "--help", "--dry-run"])) return false;

  switch (exec) {
    case "sleep":
      return sleepIsLong(args);
    case "tail":
      return hasShortFlag(args, "fF") || hasAnyFlag(args, ["--follow"]);
    case "journalctl":
      return hasShortFlag(args, "f") || hasAnyFlag(args, ["--follow"]);
    case "watch":
      return true;
    case "ping":
      return !hasShortFlag(args, "c") && !hasAnyFlag(args, ["--count"]);
    case "npm":
    case "yarn":
    case "pnpm":
    case "bun":
      return packageManagerIsLong(args);
    case "cargo":
      return hasSubcommand(args, new Set(["build", "test", "run", "watch"]));
    case "go":
      return hasSubcommand(args, new Set(["build", "test", "run"]));
    case "make":
      return !hasAnyFlag(args, ["--version", "--help"]);
    case "cmake":
      return hasAnyFlag(args, ["--build"]);
    case "pytest":
      return true;
    case "python":
    case "python3": {
      // `python -m pytest` is pytest; a script file is not read (miss preferred).
      const m = args.indexOf("-m");
      return m > 0 && args[m + 1] === "pytest";
    }
    case "gh": {
      // Watching a run / waiting on checks streams until CI finishes.
      const sub = firstNonFlag(args);
      const rest = args.slice(1);
      if (sub === "run" && (rest.includes("watch") || hasAnyFlag(rest, ["--log", "--log-failed"]))) return true;
      if (sub === "pr" && (rest.includes("watch") || hasAnyFlag(rest, ["--watch", "-w"]))) return true;
      return false;
    }
    case "herdr": {
      const sub = firstNonFlag(args);
      return (sub === "agent" || sub === "pane") && args.includes("wait");
    }
    case "jest":
    case "vitest":
    case "playwright":
      return true;
    case "docker":
      return hasSubcommand(args, new Set(["build", "run", "compose"]));
    case "kubectl":
      return hasSubcommand(args, new Set(["wait", "rollout"]));
    case "git": {
      // A clone of a local path is a copy; only a remote one can stall on a network.
      const sub = firstNonFlag(args);
      if (sub === "clone") return hasRemoteOperand(args.slice(args.indexOf(sub) + 1));
      return hasSubcommand(args, new Set(["fetch", "pull", "push", "lfs"]));
    }
    case "pip":
    case "pip3":
      return pipIsLong(args);
    case "poetry":
      return firstNonFlag(args) === "install";
    case "uv":
      return uvIsLong(args);
    case "mvn":
    case "gradle":
    case "gradlew":
      return firstNonFlag(args) !== undefined;
    case "rsync":
    case "scp":
      return hasRemoteOperand(args.slice(1));
    case "ssh":
      return sshHasRemoteCommand(args);
    case "terraform":
      return firstNonFlag(args) === "apply";
    default:
      return false;
  }
}

const MAX_DEPTH = 3;

function lineNeedsLongRun(command: string, depth: number): boolean {
  for (const simple of splitCommands(command)) {
    if (simple.background) continue;
    const { target, capped } = unwrap(simple.argv);
    if (capped) continue;
    if (target.length === 0) continue;
    const exec = basename(target[0]);

    // The gate's own CLI is never long, no matter where it appears: `cerberus
    // fg/bg/...` is the *answer* to a gate, and staging or re-asking it would
    // nest the protocol (a `cerberus fg` waiting on a `cerberus fg`).
    if (exec === "cerberus") continue;

    if (SHELLS.has(exec) || exec === "eval") {
      if (depth >= MAX_DEPTH) continue;
      const script = exec === "eval" ? target.slice(1).join(" ") : shellScriptArg(target);
      if (script !== undefined && lineNeedsLongRun(script, depth + 1)) return true;
      continue;
    }
    if (isLongCommand(target)) return true;
  }
  return false;
}

/** True when any simple command in the line (including `-c` bodies) is on the list. */
export function needsLongRun(command: string): boolean {
  return lineNeedsLongRun(command, 0);
}

/**
 * True when the line invokes the gate's own CLI (`cerberus fg 42`,
 * `cd x && cerberus ls`, `timeout 30 cerberus wait`). Such a line is control
 * surface, never work: staging it would nest the protocol, and the CLI answers
 * in milliseconds without waiting for anything but the command it is asked to run.
 */
export function invokesGate(command: string): boolean {
  for (const simple of splitCommands(command)) {
    if (simple.background) continue;
    const { target } = unwrap(simple.argv);
    if (target.length === 0) continue;
    if (basename(target[0]) === "cerberus") return true;
  }
  return false;
}

/**
 * Commands that only read text and pass it on, so piping the CLI's own output into
 * one of them is still the control plane (`cerberus wait 42 | tail -5`).
 */
export const TEXT_FILTERS = new Set([
  "head", "tail", "grep", "sed", "awk", "cat", "wc", "sort", "uniq", "cut", "tr", "nl", "jq", "column",
]);

/**
 * True when the line is the gate's own CLI and nothing else: it *starts* with
 * `cerberus ...` (`cerberus wait 42`, `cerberus ls`, `'.../bin/cerberus' log 42`), and
 * what follows is only the CLI again (`cerberus ls; cerberus rc 42`) or a pure text
 * filter (`cerberus wait 42 | tail -12`, `cerberus log 42 | grep err | head -5`).
 * The capture path runs such a line locally, like the gate does - `wait` is how a task
 * is collected, so staging it would make it wait on itself.
 *
 * The first command has to be the CLI: `grep err | cerberus log 42` reads the pipe
 * rather than the task. And anything else in the line disqualifies it
 * (`cerberus ls && npm run build`, `cerberus ls | head -2 && sleep 12`,
 * `echo hi && cerberus ls`): that line does real work, and the exemption must not
 * become a way around the capture path.
 */
export function onlyInvokesGate(command: string): boolean {
  let seen = false;
  for (const simple of splitCommands(command)) {
    const { target } = unwrap(simple.argv);
    if (target.length === 0) continue;
    const exec = basename(target[0]);
    if (!seen) {
      if (exec !== "cerberus") return false;
      seen = true;
      continue;
    }
    // A second CLI call is still control surface; anything else has to be a filter.
    if (exec !== "cerberus" && !TEXT_FILTERS.has(exec)) return false;
  }
  return seen;
}

/** True when the line detaches itself: `&` or `setsid --fork`/`-f`. */
export function isBackgrounded(command: string): boolean {
  return splitCommands(command).some((simple) => simple.background || unwrap(simple.argv).forks);
}
