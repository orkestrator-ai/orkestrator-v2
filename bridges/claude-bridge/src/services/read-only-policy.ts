import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type {
  NativeAgentCapability,
  NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";

/**
 * Translation of the coordinator's read-only policy into this SDK's terms.
 *
 * The policy's `toolPolicy` cannot serve here: its strings are Codex's tool
 * names, and handing them to `disallowedTools` produces a rule that matches
 * nothing at all. The `capabilityPolicy` names the operation instead, and this
 * module is the only place that decides what Claude calls it.
 */

const CAPABILITY_TOOLS: Readonly<Record<NativeAgentCapability, readonly string[]>> = Object.freeze({
  "file.write": ["Write", "NotebookEdit"],
  "file.patch": ["Edit", "MultiEdit", "ApplyPatch"],
  shell: ["Bash", "BashOutput", "KillShell"],
  // Shell itself stays available for reads; the hook is what separates a
  // `git log` from a `git commit`, which no tool-name rule can express.
  "shell.mutate": [],
  network: ["WebFetch", "WebSearch"],
});

/** Tools a read-only coordinator turn may use, before MCP is added. */
const READ_ONLY_TOOLS = Object.freeze([
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
 * Commands whose whole purpose is to read.
 *
 * An allowlist rather than a denylist of dangerous verbs: a denylist has to
 * anticipate every way to write, and the first one it misses is a write that
 * happened. Anything not listed here is refused with an explanation, which is
 * recoverable — the user can delegate it to a worker.
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
    "env",
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

/** Git subcommands that only inspect. `git` alone is far too coarse. */
const READ_ONLY_GIT_SUBCOMMANDS = Object.freeze(
  new Set([
    "blame",
    "branch",
    "cat-file",
    "config",
    "describe",
    "diff",
    "difftool",
    "grep",
    "log",
    "ls-files",
    "ls-remote",
    "ls-tree",
    "merge-base",
    "name-rev",
    "remote",
    "rev-list",
    "rev-parse",
    "shortlog",
    "show",
    "show-ref",
    "status",
    "tag",
    "whatchanged",
  ]),
);

/** `gh` subcommands that only read. Anything that writes to GitHub is refused. */
const READ_ONLY_GH_SUBCOMMANDS = Object.freeze(new Set(["api", "browse", "search", "status"]));

/**
 * Shell metacharacters that let one command become several.
 *
 * A read-only allowlist is only worth anything if the thing checked is the
 * thing that runs. Redirection and command substitution both defeat that:
 * `cat x > y` writes, and `echo $(rm -rf .)` runs something the check never
 * saw. Refusing the whole command is deliberate — a coordinator does not need
 * shell composition, and partial parsing here is how a bypass gets in.
 */
const COMPOSITION_PATTERN = /[;&|><`$(){}]|\bsudo\b|\bexec\b/;

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
    for (const tool of CAPABILITY_TOOLS[capability] ?? []) tools.add(tool);
  }
  return [...tools];
}

/**
 * The allowlist for a read-only turn.
 *
 * `mcp__orkestrator__*` has to be in here explicitly. Supplying an allowlist
 * replaces the SDK's default one, and `dontAsk` denies anything that reaches
 * the callback step — so omitting it would leave the coordinator unable to
 * delegate, which is the one thing it exists to do.
 */
export function claudeReadOnlyAllowedTools(options: {
  agentMcpServerNames?: readonly string[];
}): string[] {
  return [
    ...READ_ONLY_TOOLS,
    ...(options.agentMcpServerNames ?? []).map((name) => `mcp__${name}__*`),
  ];
}

export function claudeReadOnlySandbox(policy: NativeAgentExecutionPolicy): {
  enabled: true;
  failIfUnavailable: boolean;
  autoAllowBashIfSandboxed: true;
  allowUnsandboxedCommands: false;
  excludedCommands: string[];
  network: {
    allowLocalBinding: boolean;
    strictAllowlist: true;
    allowedDomains: string[];
  };
} {
  return {
    enabled: true,
    // Fail rather than silently running unsandboxed. A host without the
    // sandbox is reported as a weaker tier before it gets here, so reaching
    // this point with no sandbox means the probe was wrong.
    failIfUnavailable: true,
    // The hook has already vetted the command by the time the sandbox sees it,
    // and `dontAsk` has no way to ask, so a prompt here would deny a command
    // the policy allows.
    autoAllowBashIfSandboxed: true,
    // Closes the model's own escape hatch: with this on, it could set
    // `dangerouslyDisableSandbox` and fall back to the permission system.
    allowUnsandboxedCommands: false,
    excludedCommands: [],
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
  if (COMPOSITION_PATTERN.test(trimmed)) {
    return {
      allowed: false,
      reason:
        "Coordinator shells cannot use pipes, redirection, substitution or command chaining, because the command that runs would not be the one checked.",
    };
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const program = tokens[0]?.split("/").at(-1) ?? "";
  if (!program) return { allowed: true };
  if (program === "git" || program === "gh") {
    const subcommand = tokens.slice(1).find((token) => !token.startsWith("-"));
    const permitted = program === "git" ? READ_ONLY_GIT_SUBCOMMANDS : READ_ONLY_GH_SUBCOMMANDS;
    if (subcommand && permitted.has(subcommand)) return { allowed: true };
    return {
      allowed: false,
      reason: `Coordinator is read-only, so \`${program} ${subcommand ?? ""}\`.trim() is not available here. Delegate it to a worker environment.`,
    };
  }
  if (READ_ONLY_COMMANDS.has(program)) return { allowed: true };
  return {
    allowed: false,
    reason: `Coordinator is read-only, so \`${program}\` is not available here. Delegate commands that change the checkout to a worker environment.`,
  };
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
export function createCoordinatorReadOnlyHook(policy: NativeAgentExecutionPolicy): HookCallback {
  const deniedTools = new Set(claudeDeniedTools(policy));
  const allowedMcpPrefixes = ["mcp__orkestrator__"];
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolName = input.tool_name;
    if (deniedTools.has(toolName)) {
      return deny(
        `Coordinator is read-only, so ${toolName} is not available. Delegate file changes to a worker environment.`,
      );
    }
    if (toolName.startsWith("mcp__")) {
      // Project MCP servers are arbitrary programs. Only Orkestrator's own
      // scoped server is reachable, which is also the only one whose
      // capabilities the coordinator credential bounds.
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
export function coordinatorProcessPolicy(): NativeAgentExecutionPolicy {
  return {
    id: "coordinator-read-only",
    sandbox: "provider",
    approvals: "deny",
    projectResources: false,
    capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
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
