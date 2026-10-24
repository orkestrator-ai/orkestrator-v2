import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import {
  coordinatorCapabilityPolicy,
  coordinatorResearchMcpServersFromEnv,
  coordinatorWebResearchFromEnv,
} from "@orkestrator/protocol/coordinator-web-research";
import {
  nativeAgentPolicyDeniesWebSearch,
  type NativeAgentCapability,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import type { CoordinatorCommandSandbox } from "@orkestrator/protocol/coordinator";
import { claudeMcpToolPrefix } from "./mcp-tool-prefix.js";

/**
 * Translation of the coordinator's read-only policy into this SDK's terms.
 *
 * The policy's `toolPolicy` cannot serve here: its strings are Codex's tool
 * names, and handing them to `disallowedTools` produces a rule that matches
 * nothing at all. The `capabilityPolicy` names the operation instead, and this
 * module is the only place that decides what Claude calls it.
 */

const CAPABILITY_TOOLS: ReadonlyMap<NativeAgentCapability, readonly string[]> = new Map([
  ["file.write", ["Write", "NotebookEdit"]],
  ["file.patch", ["Edit", "MultiEdit", "ApplyPatch"]],
  ["shell", ["Bash", "BashOutput", "KillShell"]],
  // Shell itself stays available for reads; the hook is what separates a
  // `git log` from a `git commit`, which no tool-name rule can express.
  ["shell.mutate", []],
  // WebSearch runs on Anthropic's servers and WebFetch from the CLI process,
  // so the sandbox's network allowlist reaches neither. A `network` denial
  // takes both, unless the policy's `allow` names `web.search`.
  ["network", ["WebFetch", "WebSearch"]],
  ["web.search", ["WebSearch"]],
]);

/** Tools a read-only coordinator turn may use, before MCP is added. */
export const READ_ONLY_TOOLS = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "Task",
  "Agent",
  "TodoWrite",
  "AskUserQuestion",
]);

/**
 * Tools whose purpose is to make a turn last longer.
 *
 * The allowlist above already excludes them, so this is not what stops them —
 * it is what explains them. A coordinator reaching for `Monitor` or
 * `ScheduleWakeup` has misunderstood the delegation contract, and an
 * unexplained "tool not available" invites it to try the next one on the list
 * rather than to finish its turn. Named separately so the refusal can say why.
 */
export const WAITING_TOOLS: ReadonlySet<string> = new Set([
  "Monitor",
  "ScheduleWakeup",
  "CronCreate",
  "CronList",
  "CronDelete",
  "SendMessage",
]);

/**
 * Commands whose whole purpose is to read.
 *
 * An allowlist rather than a denylist of dangerous verbs: a denylist has to
 * anticipate every way to write, and the first one it misses is a write that
 * happened. Anything not listed here is refused with an explanation, which is
 * recoverable — the user can delegate it to a worker.
 *
 * A program that runs another program does not belong here whatever it is
 * called, because the allowlist would then be checking the launcher rather than
 * the thing that runs: `env` is absent for exactly that reason.
 */
const READ_ONLY_COMMANDS = Object.freeze(
  new Set([
    "awk",
    "basename",
    "cat",
    "cksum",
    "column",
    "comm",
    "cut",
    "date",
    "diff",
    "dirname",
    "du",
    "echo",
    "file",
    "find",
    "fd",
    "grep",
    "head",
    "hostname",
    "jq",
    "ls",
    "md5sum",
    "nl",
    "od",
    "printf",
    "pwd",
    "readlink",
    "realpath",
    "rg",
    "sha1sum",
    "sha256sum",
    "sort",
    "stat",
    "tail",
    "tr",
    "true",
    "uniq",
    "wc",
    "which",
    "whoami",
    "xxd",
    "yq",
  ]),
);

/**
 * Arguments that turn an otherwise-reading program into a writing one.
 *
 * The program name alone is not the whole command: `find . -delete` removes
 * files, `sort -o` and `yq -i` write in place, and `fd -x` / `rg --pre` run a
 * program of the model's choosing. Each of those is refused by argument, so the
 * reading forms of the same tools stay available. A one-letter flag also
 * matches inside a cluster or with its value attached (`-ofile`, `-iP`), which
 * is how getopt reads it.
 */
const MUTATING_ARGUMENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["date", new Set(["-s", "--set"])],
  ["fd", new Set(["-x", "-X", "--exec", "--exec-batch"])],
  // `-C` compiles a magic file into `<name>.mgc` beside it.
  ["file", new Set(["-C", "--compile"])],
  [
    "find",
    new Set([
      "-delete",
      "-exec",
      "-execdir",
      "-fls",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-ok",
      "-okdir",
    ]),
  ],
  ["hostname", new Set(["-F", "--file", "-b", "--boot"])],
  ["rg", new Set(["--hostname-bin", "--pre"])],
  // `-T` puts temporary files where the model says; `--compress-program` runs one.
  ["sort", new Set(["-o", "--output", "-T", "--temporary-directory", "--compress-program"])],
  ["yq", new Set(["-i", "--in-place", "--inplace", "-s", "--split-exp"])],
]);

/**
 * Programs that write a positional argument rather than a flagged one.
 *
 * `uniq in out` and `xxd in out` write `out`, with no flag and no shell
 * metacharacter to refuse. Each may take at most `max` positionals. Options
 * that consume the next token are named, so their values are not counted; an
 * unlisted option's value is counted, which can only refuse a reading command,
 * never admit a writing one.
 */
const POSITIONAL_LIMITS: ReadonlyMap<string, { max: number; valueOptions: ReadonlySet<string> }> =
  new Map([
    ["hostname", { max: 0, valueOptions: new Set<string>() }],
    ["uniq", { max: 1, valueOptions: new Set(["-f", "-s", "-w"]) }],
    [
      "xxd",
      {
        max: 1,
        valueOptions: new Set([
          "-c",
          "-cols",
          "-g",
          "-groupsize",
          "-l",
          "-len",
          "-n",
          "-name",
          "-o",
          "-offset",
          "-s",
          "-seek",
        ]),
      },
    ],
  ]);

/**
 * Programs whose options are admitted by allowlist. Every listed option takes a
 * value, attached (`-F,`) or as the next token; anything else is refused.
 *
 * gawk alone has `-i inplace`, `-o`, `-p`, `-d` and `-D` that write files and
 * `-f`, `-E` and `-l` that load a program, and any of them can hide in a short
 * option cluster. Field separators and variable assignments are what reading
 * needs.
 */
const OPTION_ALLOWLISTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["awk", new Set(["-F", "-v", "--field-separator", "--assign"])],
]);

/** Git options that redirect output to a file or choose a program to run. */
const GIT_MUTATING_ARGUMENTS: ReadonlySet<string> = new Set([
  "--config-env",
  "--exec-path",
  "--ext-diff",
  "--filters",
  "--output",
  "--textconv",
]);

/** Per-subcommand git options with the same effect. */
const GIT_SUBCOMMAND_MUTATING_ARGUMENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["grep", new Set(["-O", "--open-files-in-pager"])],
]);

/**
 * Git subcommands that only inspect, whatever arguments they are given.
 *
 * `difftool` is deliberately absent even though it reads: its whole purpose is
 * to launch `diff.tool`, an arbitrary command the checkout's own git config can
 * name. `git diff` covers the reading use without handing the repository a way
 * to choose what runs.
 */
const READ_ONLY_GIT_SUBCOMMANDS = Object.freeze(
  new Set([
    "blame",
    "cat-file",
    "describe",
    "diff",
    "grep",
    "log",
    "ls-files",
    "ls-tree",
    "merge-base",
    "name-rev",
    "rev-list",
    "rev-parse",
    "shortlog",
    "show",
    "show-ref",
    "status",
    "whatchanged",
  ]),
);

/** Flags that make `git branch` or `git tag` change a ref rather than list it. */
const GIT_REF_WRITE_FLAGS = Object.freeze(
  new Set([
    "-C",
    "-D",
    "-M",
    "-c",
    "-d",
    "-f",
    "-m",
    "-u",
    "--copy",
    "--delete",
    "--edit-description",
    "--force",
    "--move",
    "--set-upstream-to",
    "--unset-upstream",
  ]),
);

/** Flags that make `git branch` or `git tag` list rather than create. */
const GIT_REF_LIST_FLAGS = Object.freeze(
  new Set([
    "-l",
    "--list",
    "--contains",
    "--no-contains",
    "--merged",
    "--no-merged",
    "--points-at",
    "--show-current",
  ]),
);

const GIT_CONFIG_READ_FLAGS = Object.freeze(
  new Set(["-l", "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list"]),
);

const GIT_CONFIG_WRITE_FLAGS = Object.freeze(
  new Set([
    "-e",
    "--add",
    "--edit",
    "--remove-section",
    "--rename-section",
    "--replace-all",
    "--set",
    "--set-all",
    "--unset",
    "--unset-all",
  ]),
);

const GIT_CONFIG_READ_SUBCOMMANDS = Object.freeze(new Set(["get", "list"]));
const GIT_CONFIG_WRITE_SUBCOMMANDS = Object.freeze(
  new Set(["edit", "remove-section", "rename-section", "set", "unset"]),
);

/** `git remote` operations that only report. Everything else rewrites remotes. */
const GIT_REMOTE_READ_SUBCOMMANDS = Object.freeze(new Set(["get-url"]));

function hasFlag(args: readonly string[], flags: ReadonlySet<string>): boolean {
  // A one-letter flag can be clustered (`-no out` is `-n -o out`) or carry its
  // value (`-oout`), so any short-option token holding the letter counts. That
  // can refuse a reading cluster whose value happens to contain the letter;
  // it cannot admit a writing one.
  const letters = [...flags].flatMap((flag) => (/^-[A-Za-z0-9]$/.test(flag) ? [flag[1]!] : []));
  return args.some(
    (arg) =>
      // `--output=x` is the same flag as `--output x`, so match the prefix too.
      flags.has(arg) ||
      flags.has(arg.split("=", 1)[0] ?? arg) ||
      // GNU and Git parsers accept unambiguous long-option abbreviations.
      (arg.startsWith("--") &&
        [...flags].some(
          (flag) => flag.startsWith("--") && flag.startsWith(arg.split("=", 1)[0]!),
        )) ||
      (/^-[^-]/.test(arg) && letters.some((letter) => arg.slice(1).includes(letter))),
  );
}

/**
 * `git branch` and `git tag` list with no positional and create with one.
 *
 * Admitting the subcommand alone is what let `git branch -D feature` and
 * `git tag -d v1` through: both name a subcommand this file called read-only.
 */
function listsRefsOnly(args: readonly string[]): boolean {
  if (hasFlag(args, GIT_REF_WRITE_FLAGS)) return false;
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  return positionals.length === 0 || hasFlag(args, GIT_REF_LIST_FLAGS);
}

/**
 * `git config <name>` reads; `git config <name> <value>` writes.
 *
 * A second positional is the value, which is the whole difference — including
 * for `--global`, where the write lands outside the checkout entirely.
 */
function readsConfigOnly(args: readonly string[]): boolean {
  if (hasFlag(args, GIT_CONFIG_WRITE_FLAGS)) return false;
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  const first = positionals[0];
  if (first && GIT_CONFIG_WRITE_SUBCOMMANDS.has(first)) return false;
  if (hasFlag(args, GIT_CONFIG_READ_FLAGS)) return true;
  if (first && GIT_CONFIG_READ_SUBCOMMANDS.has(first)) return true;
  return positionals.length <= 1;
}

/**
 * Git subcommands whose effect depends on their arguments.
 *
 * Previously these sat in the flat read-only set, so the subcommand name alone
 * admitted every mutating form of it. A `Map` rather than an object literal
 * because the key comes from the model: a plain-object lookup for `constructor`
 * or `toString` returns an inherited function, and calling it yields a truthy
 * value — an allow decision reached without any rule matching.
 */
const CONDITIONAL_GIT_SUBCOMMANDS: ReadonlyMap<string, (args: readonly string[]) => boolean> =
  new Map([
    ["branch", listsRefsOnly],
    ["config", readsConfigOnly],
    [
      "remote",
      (args: readonly string[]) => {
        const first = args.find((arg) => !arg.startsWith("-"));
        return first === undefined || GIT_REMOTE_READ_SUBCOMMANDS.has(first);
      },
    ],
    ["tag", listsRefsOnly],
  ]);

/**
 * Programs whose only purpose here is the network.
 *
 * Coordinator commands run with the network off, so these fail inside the
 * sandbox anyway. Where the sandbox cannot start they are worse than useless:
 * `gh api -f` writes to GitHub, and `git ls-remote <url>` reaches any host the
 * model names, with `--upload-pack` choosing a program to run.
 */
const NETWORK_COMMANDS: ReadonlySet<string> = new Set(["curl", "gh", "wget"]);
const NETWORK_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["fetch", "ls-remote", "pull"]);

/**
 * Shell metacharacters that let one command become several.
 *
 * A read-only allowlist is only worth anything if the thing checked is the
 * thing that runs. Redirection and command substitution both defeat that:
 * `cat x > y` writes, and `echo $(rm -rf .)` runs something the check never
 * saw. So does a newline: the shell treats it exactly as `;` does, while a
 * whitespace split reduces `ls\nrm -rf .` to the harmless-looking `ls`.
 * Refusing the whole command is deliberate — a coordinator does not need shell
 * composition, and partial parsing here is how a bypass gets in.
 */
// Quotes, escapes and globs transform arguments before execution. This hook
// deliberately accepts only literal words, rather than approximating a shell parser.
const COMPOSITION_PATTERN = /[;&|><`$(){}\n\r'"\\*?[\]]|\bsudo\b|\bexec\b/;

export function isCoordinatorReadOnlyPolicy(
  policy: NativeAgentExecutionPolicy | undefined,
): boolean {
  return policy?.id === "coordinator-read-only";
}

/** Provider tool names for the capabilities this policy denies. */
export function claudeDeniedTools(policy: NativeAgentExecutionPolicy | undefined): string[] {
  const denied = policy?.capabilityPolicy?.deny ?? [];
  const tools = new Set<string>();
  for (const capability of denied) {
    for (const tool of CAPABILITY_TOOLS.get(capability) ?? []) tools.add(tool);
  }
  if (!nativeAgentPolicyDeniesWebSearch(policy)) tools.delete("WebSearch");
  return [...tools];
}

/**
 * `disallowedTools` for a turn that is not a read-only coordinator turn.
 *
 * The override's own names, plus Claude's names for every capability the
 * policy denies. A policy that denies `network` therefore loses WebFetch and
 * WebSearch whatever its id: WebSearch runs on Anthropic's servers, so the
 * command sandbox's network allowlist never sees it. Without a capability
 * denial this is exactly `toolPolicy.deny`, so ordinary sessions are unchanged.
 */
export function claudeDisallowedTools(
  policy: NativeAgentExecutionPolicy | undefined,
): string[] | undefined {
  const denied = claudeDeniedTools(policy);
  if (denied.length === 0) return policy?.toolPolicy?.deny;
  return [...new Set([...(policy?.toolPolicy?.deny ?? []), ...denied])];
}

/**
 * The allowlist for a read-only turn.
 *
 * `mcp__orkestrator__*` has to be in here explicitly. Supplying an allowlist
 * replaces the SDK's default one, and the coordinator's `deny` policy refuses
 * anything that reaches the callback step (`canUseTool`) — so omitting it would
 * leave the coordinator unable to delegate, which is the one thing it exists
 * to do.
 */
export function claudeReadOnlyAllowedTools(options: {
  agentMcpServerNames?: readonly string[];
  /** The turn's policy; WebSearch is allowed only when it is not denied. */
  policy?: NativeAgentExecutionPolicy;
  /** Remote research servers the launcher named and the session loaded. */
  researchMcpServerNames?: readonly string[];
}): string[] {
  return [
    ...READ_ONLY_TOOLS,
    ...(options.policy && !nativeAgentPolicyDeniesWebSearch(options.policy) ? ["WebSearch"] : []),
    ...(options.agentMcpServerNames ?? []).map((name) => `${claudeMcpToolPrefix(name)}*`),
    ...(options.researchMcpServerNames ?? []).map((name) => `${claudeMcpToolPrefix(name)}*`),
  ];
}

export function claudeReadOnlySandbox(
  policy: NativeAgentExecutionPolicy,
  options: {
    /**
     * The checkout and every directory the session may read. The sandbox's
     * default lets a command write its working directory, so without this an
     * allowed reading command with an output argument (`uniq in out`) wrote
     * the user's checkout.
     */
    workspaces?: readonly string[];
    /** The launcher's probe result; see `COORDINATOR_COMMAND_SANDBOX_ENV`. */
    commandSandbox?: CoordinatorCommandSandbox;
  } = {},
): {
  enabled: true;
  failIfUnavailable: boolean;
  autoAllowBashIfSandboxed: true;
  allowUnsandboxedCommands: false;
  excludedCommands: string[];
  filesystem: { denyWrite: string[] };
  network: {
    allowLocalBinding: boolean;
    strictAllowlist: true;
    allowedDomains: string[];
  };
} {
  return {
    enabled: true,
    // Fail rather than silently running unsandboxed where the platform was
    // qualified on the sandbox. A host the launcher's probe found without one
    // was offered at a weaker tier, with the hook as its boundary; requiring
    // the sandbox there would fail every turn.
    failIfUnavailable: options.commandSandbox !== "unavailable",
    // The hook has already vetted the command by the time the sandbox sees it,
    // and a `deny` policy refuses every prompt, so a prompt here would deny a
    // command the policy allows.
    autoAllowBashIfSandboxed: true,
    // Closes the model's own escape hatch: with this on, it could set
    // `dangerouslyDisableSandbox` and fall back to the permission system.
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    // Denials win over the sandbox's own write allowance, which includes the
    // working directory. Temporary directories stay writable for the shell.
    filesystem: { denyWrite: [...new Set(options.workspaces ?? [])] },
    network: {
      allowLocalBinding: policy.networkAccess === "full",
      strictAllowlist: true,
      allowedDomains: [],
    },
  };
}

interface CommandVerdict {
  allowed: boolean;
  reason?: string;
}

/** Whether one shell command only reads. Exported for its own tests. */
export function isReadOnlyShellCommand(command: string): CommandVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: true };
  if (COMPOSITION_PATTERN.test(trimmed) || /(?:^|\s)~/.test(trimmed)) {
    return {
      allowed: false,
      reason:
        "Coordinator shells cannot use quotes, escapes, globs, pipes, redirection, substitution or command chaining, because the command that runs would not be the one checked.",
    };
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const first = tokens[0] ?? "";
  if (!first) return { allowed: true };
  // `bin/cat` is whatever the checkout put at that path, not `cat`.
  if (first.includes("/") || first.includes("\\")) {
    return {
      allowed: false,
      reason: `Coordinator shells run reading programs by name only, so \`${first}\` is not available here. Use the program name, or delegate it to a worker environment.`,
    };
  }
  const program = first;
  if (NETWORK_COMMANDS.has(program)) return networkRefusal(program);
  if (program === "git") {
    const subcommandIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith("-"));
    const subcommand = subcommandIndex > 0 ? tokens[subcommandIndex] : undefined;
    const args = subcommandIndex > 0 ? tokens.slice(subcommandIndex + 1) : [];
    if (
      subcommand &&
      (NETWORK_GIT_SUBCOMMANDS.has(subcommand) ||
        (subcommand === "remote" && args.some((arg) => arg === "show")))
    ) {
      return networkRefusal(`git ${subcommand}`);
    }
    const permitted =
      subcommand !== undefined &&
      (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) ||
        (CONDITIONAL_GIT_SUBCOMMANDS.get(subcommand)?.(args) ?? false));
    const described = ["git", subcommand].filter(Boolean).join(" ");
    if (!permitted) {
      return {
        allowed: false,
        reason: `Coordinator is read-only, so \`${described}\` is not available here. Delegate it to a worker environment.`,
      };
    }
    if (
      hasFlag(tokens.slice(1), GIT_MUTATING_ARGUMENTS) ||
      hasFlag(args, GIT_SUBCOMMAND_MUTATING_ARGUMENTS.get(subcommand) ?? new Set())
    ) {
      return {
        allowed: false,
        reason: `Coordinator is read-only, so \`${described}\` cannot be used with an argument that writes a file or runs another program. Delegate it to a worker environment.`,
      };
    }
    return { allowed: true };
  }
  if (READ_ONLY_COMMANDS.has(program)) {
    const args = tokens.slice(1);
    const mutating = MUTATING_ARGUMENTS.get(program);
    const options = OPTION_ALLOWLISTS.get(program);
    const limit = POSITIONAL_LIMITS.get(program);
    if (
      (mutating && hasFlag(args, mutating)) ||
      (options && !optionsAllowed(args, options)) ||
      (limit && positionalCount(args, limit.valueOptions) > limit.max)
    ) {
      return {
        allowed: false,
        reason: `Coordinator is read-only, so \`${program}\` cannot be used with an argument that writes or runs another program. Delegate it to a worker environment.`,
      };
    }
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Coordinator is read-only, so \`${program}\` is not available here. Delegate commands that change the checkout to a worker environment.`,
  };
}

function networkRefusal(described: string): CommandVerdict {
  return {
    allowed: false,
    reason: `Coordinator commands have no network access, so \`${described}\` is not available here. Delegate it to a worker environment.`,
  };
}

/** Whether every option in `args` is one of `allowed`, each taking a value. */
function optionsAllowed(args: readonly string[], allowed: ReadonlySet<string>): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return true;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (allowed.has(arg)) {
      index += 1;
      continue;
    }
    const long = arg.startsWith("--") ? arg.split("=", 1)[0]! : undefined;
    const attached = long ?? arg.slice(0, 2);
    if (!allowed.has(attached)) return false;
  }
  return true;
}

/** Positional arguments, not counting the values of `valueOptions`. */
function positionalCount(args: readonly string[], valueOptions: ReadonlySet<string>): number {
  let count = 0;
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      if (valueOptions.has(arg)) index += 1;
      continue;
    }
    count += 1;
  }
  return count;
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * The enforcement point for a read-only coordinator turn.
 *
 * Registered programmatically and never from settings, so a workspace cannot
 * remove it. Hooks run before deny rules, ask rules and the permission mode,
 * and a hook denial is final — which is what makes this, rather than
 * `canUseTool`, the place the boundary can actually be held.
 */
export function createCoordinatorReadOnlyHook(
  policy: NativeAgentExecutionPolicy,
  researchMcpServerNames: readonly string[] = coordinatorResearchMcpServersFromEnv(process.env).map(
    (server) => server.name,
  ),
): HookCallback {
  const deniedTools = new Set(claudeDeniedTools(policy));
  const allowedMcpPrefixes = [
    claudeMcpToolPrefix("orkestrator"),
    ...researchMcpServerNames.map(claudeMcpToolPrefix),
  ];
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolName = input.tool_name;
    if (deniedTools.has(toolName)) {
      return deny(
        `Coordinator is read-only, so ${toolName} is not available. Delegate file changes to a worker environment.`,
      );
    }
    if (WAITING_TOOLS.has(toolName)) {
      return deny(
        `Coordinator turns do not wait, so ${toolName} is not available. Delegated work reports back by waking this conversation with a message when it finishes; end your turn instead.`,
      );
    }
    if (toolName.startsWith("mcp__")) {
      // Project MCP servers are arbitrary programs. Only Orkestrator's own
      // scoped server is reachable, which is also the only one whose
      // capabilities the coordinator credential bounds, plus the remote
      // research servers the launcher named.
      if (!allowedMcpPrefixes.some((prefix) => toolName.startsWith(prefix))) {
        return deny(
          `Coordinator sessions may only use Orkestrator's own tools, so ${toolName} is not available.`,
        );
      }
      return {};
    }
    if (toolName === "Bash") {
      const toolInput = input.tool_input as
        | { command?: unknown; dangerouslyDisableSandbox?: unknown }
        | undefined;
      if (toolInput?.dangerouslyDisableSandbox === true) {
        return deny("Coordinator commands may not run outside the sandbox.");
      }
      const command = typeof toolInput?.command === "string" ? toolInput.command : "";
      const verdict = isReadOnlyShellCommand(command);
      if (!verdict.allowed) return deny(verdict.reason!);
    }
    return {};
  };
}

/**
 * Process-level policy authority, matching the codex bridge's own.
 *
 * The launcher starts a coordinator bridge with this set, so every session in
 * this process is a coordinator session whatever a request body says. Without
 * it, a permissive policy persisted before an upgrade — or supplied by any
 * caller that reached the port — would survive a restart and quietly widen the
 * boundary on a live conversation.
 */
export const BRIDGE_EXECUTION_POLICY_ENV = "ORKESTRATOR_BRIDGE_EXECUTION_POLICY";

export function processExecutionPolicyIsCoordinator(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BRIDGE_EXECUTION_POLICY_ENV] === "coordinator-read-only";
}

/** The policy a coordinator process runs under, regardless of the request. */
export function coordinatorProcessPolicy(
  env: NodeJS.ProcessEnv = process.env,
): NativeAgentExecutionPolicy {
  return {
    id: "coordinator-read-only",
    sandbox: "provider",
    approvals: "deny",
    projectResources: false,
    capabilityPolicy: coordinatorCapabilityPolicy(coordinatorWebResearchFromEnv(env)),
    networkAccess: "restricted",
  };
}

/**
 * Resolve the policy actually in force for a session in this process.
 *
 * Returns the caller's policy unchanged outside a coordinator process, and the
 * coordinator policy inside one — including when the caller supplied none,
 * which is the case a restored session hits.
 */
export function effectiveExecutionPolicy(
  requested: NativeAgentExecutionPolicy | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NativeAgentExecutionPolicy | undefined {
  if (!processExecutionPolicyIsCoordinator(env)) return requested;
  return coordinatorProcessPolicy();
}
