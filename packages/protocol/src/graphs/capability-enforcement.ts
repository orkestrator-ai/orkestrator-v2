/**
 * How strongly each provider holds a capability policy (plan P1.6, report
 * §6.4): `enforced`, `provider-configured` or `advisory`, per policy (or
 * profile), provider and host.
 *
 * This is the one place that judgement is made. The coordinator's provider
 * qualification (`apps/backend/src/core/coordinator-providers.ts`) asks it
 * about the coordinator policy, the graph compiler asks it about each node's
 * compiled profile, and the designer shows the same matrix, so the three
 * cannot drift apart. The tiers mean what they mean for the coordinator
 * (`docs/architecture/coordinator.md#provider-qualification`):
 *
 * - `enforced`: the provider or the OS blocks the action whatever the agent
 *   attempts;
 * - `provider-configured`: the SDK is told to deny it, and exposes no way to
 *   verify that it does;
 * - `advisory`: the agent is told; a tool that does not ask is not stopped.
 *   Post-hoc guards (item 209) still detect the result.
 *
 * A policy is judged axis by axis. Boundary axes (workspace writes, the shell,
 * network, commits, remote writes) decide the overall tier; secondary axes
 * (sub-agents, MCP servers, hosted search alone, the shell inside a read-only
 * turn) are reported but do not lower it, because none of them can change the
 * workspace or reach a remote on its own: a sub-agent inherits its parent's
 * sandbox and denials, and an MCP server reachable from a read-only turn is
 * already outside the boundary the read-only tier describes.
 *
 * Browser-safe: the host's sandbox probe is an input, never run here.
 */
import { AGENT_PLATFORMS, type AgentPlatform } from "../agent-platforms.js";
import { coordinatorCapabilityPolicy } from "../coordinator-web-research.js";
import {
  nativeAgentDeniedCapabilities,
  nativeAgentDenialsAreReadOnly,
  type NativeAgentExecutionPolicy,
} from "../native-agent.js";
import { GRAPH_ENFORCEMENT_TIERS, type GraphEnforcementTier } from "./template-model.js";

export type AgentEnforcementTier = GraphEnforcementTier;
export const AGENT_ENFORCEMENT_TIERS = GRAPH_ENFORCEMENT_TIERS;

/** Strongest first. */
const TIER_RANK: Readonly<Record<AgentEnforcementTier, number>> = Object.freeze({
  enforced: 0,
  "provider-configured": 1,
  advisory: 2,
});

/** Whether `tier` is at least as strong as `floor`. */
export function agentEnforcementTierSatisfies(
  tier: AgentEnforcementTier,
  floor: AgentEnforcementTier,
): boolean {
  return TIER_RANK[tier] <= TIER_RANK[floor];
}

/** The weakest of several tiers; `enforced` for none. */
export function weakestAgentEnforcementTier(
  tiers: Iterable<AgentEnforcementTier>,
): AgentEnforcementTier {
  let weakest: AgentEnforcementTier = "enforced";
  for (const tier of tiers) if (TIER_RANK[tier] > TIER_RANK[weakest]) weakest = tier;
  return weakest;
}

/**
 * What the host offers the providers' own sandboxes. The backend fills this
 * from its probe (`defaultCoordinatorHostCapabilities`); the designer, which
 * cannot probe, uses `agentEnforcementHostForOs`.
 */
export interface AgentEnforcementHost {
  /** Whether the Claude Agent SDK's command sandbox can run commands here. */
  claudeSandbox: boolean;
  /** Why it cannot, when known; shown in place of the generic reason. */
  claudeSandboxReason?: string;
}

export const AGENT_ENFORCEMENT_OSES = ["darwin", "linux", "win32"] as const;
export type AgentEnforcementOs = (typeof AGENT_ENFORCEMENT_OSES)[number];

/**
 * A host description for a platform the caller cannot probe. Seatbelt ships
 * with macOS; the pinned CLI's Windows sandbox is off; Linux depends on
 * bubblewrap being able to nest a user namespace, which only a probe can tell,
 * so it counts as unavailable unless the caller says otherwise.
 */
export function agentEnforcementHostForOs(
  os: AgentEnforcementOs,
  linuxSandboxAvailable = false,
): AgentEnforcementHost {
  if (os === "darwin") return { claudeSandbox: true };
  if (os === "linux" && linuxSandboxAvailable) return { claudeSandbox: true };
  return {
    claudeSandbox: false,
    ...(os === "linux"
      ? {
          claudeSandboxReason:
            "Claude's command sandbox needs Linux whose bubblewrap can nest a user namespace, which this host has not shown.",
        }
      : {}),
  };
}

/** Generic reason where the probe has no specific cause (Windows, or none given). */
export const CLAUDE_SANDBOX_UNAVAILABLE_REASON =
  "Claude's command sandbox is unavailable on this host (it needs macOS, or Linux whose bubblewrap can nest a user namespace).";

/** The hook sentence every unsandboxed Claude read-only reason ends with. */
export const CLAUDE_UNSANDBOXED_BOUNDARY_REASON =
  "File tools are removed and the bridge admits only reading commands, but nothing outside the agent enforces it.";

export const AGENT_ENFORCEMENT_AXES = [
  "workspace",
  "shell",
  "network",
  "commit",
  "remote",
  "web-search",
  "subagents",
  "mcp",
] as const;
export type AgentEnforcementAxisId = (typeof AGENT_ENFORCEMENT_AXES)[number];

export interface AgentEnforcementAxis {
  axis: AgentEnforcementAxisId;
  tier: AgentEnforcementTier;
  /** Whether this axis decides the overall tier. */
  boundary: boolean;
  /** Why the tier is not `enforced`, or how it is held when that matters. */
  reason?: string;
}

export interface AgentEnforcementJudgement {
  tier: AgentEnforcementTier;
  /** The reason of the weakest boundary axis, when it has one. */
  reason?: string;
  /** Whether the policy is dispatched as a read-only turn. */
  readOnly: boolean;
  axes: AgentEnforcementAxis[];
}

/** The parts of a policy the judgement reads. */
export type AgentEnforcementPolicy = Pick<
  NativeAgentExecutionPolicy,
  "capabilityPolicy" | "sandbox" | "networkAccess"
>;

/** The coordinator's policy as the matrix sees it; research changes no tier. */
export function coordinatorEnforcementPolicy(): AgentEnforcementPolicy {
  return {
    capabilityPolicy: coordinatorCapabilityPolicy("off"),
    sandbox: "provider",
    networkAccess: "restricted",
  };
}

interface TierAndReason {
  tier: AgentEnforcementTier;
  reason?: string;
}

/**
 * The read-only boundary: a read-only turn on each platform. This is the
 * coordinator's qualification table, moved here unchanged; coordinator.md
 * describes what each platform does to earn its tier.
 */
function readOnlyBoundary(platform: AgentPlatform, host: AgentEnforcementHost): TierAndReason {
  switch (platform) {
    case "codex":
      // A Codex permission profile denies the filesystem and the network in the
      // child process itself, and the bridge refuses to run a turn unless
      // app-server echoes the profile back. Hosted web search is outside that
      // profile (OpenAI's servers fetch the page), so it is switched off in
      // configuration and the bridge refuses a thread unless `config/read`
      // confirms it. A Codex that cannot do that would not be `enforced`.
      return { tier: "enforced" };
    case "claude":
      return host.claudeSandbox
        ? { tier: "enforced" }
        : {
            tier: "provider-configured",
            reason: `${host.claudeSandboxReason ?? CLAUDE_SANDBOX_UNAVAILABLE_REASON} ${CLAUDE_UNSANDBOXED_BOUNDARY_REASON}`,
          };
    case "pi":
      // Pi's gate runs inside the bridge on every tool call and cannot be
      // switched off by the workspace.
      return { tier: "enforced" };
    case "opencode":
      return {
        tier: "provider-configured",
        reason:
          "OpenCode denies mutating tools through its own permission rules, but always loads the checkout's project configuration.",
      };
    case "cursor":
      return {
        tier: "provider-configured",
        reason:
          "Cursor applies the sandbox and tool restrictions, but its SDK exposes no approval callback to verify them.",
      };
    case "grok":
      return {
        tier: "advisory",
        reason:
          "Grok's write, edit, shell, subagent, web search and web fetch tools are removed. Remaining permission requests are denied; other tools that do not ask, including xAI's hosted X search tools, remain advisory.",
      };
  }
}

/** Platforms whose bridge removes named tools from the agent (`disallowedTools` or rules). */
function removesTools(platform: AgentPlatform): boolean {
  return platform === "claude" || platform === "cursor";
}

/** File tools denied while the shell may still write (a verifier). */
function fileToolBoundary(platform: AgentPlatform): TierAndReason {
  if (removesTools(platform)) {
    return {
      tier: "provider-configured",
      reason:
        "File-writing tools are removed; the shell can still write, so a post-hoc guard checks the workspace.",
    };
  }
  const why: Record<Exclude<AgentPlatform, "claude" | "cursor">, string> = {
    codex:
      "Codex cannot remove its file tools without a read-only sandbox, which would also stop the shell.",
    opencode: "OpenCode is not given file-tool denials outside a read-only turn.",
    pi: "Pi applies no capability denial outside its read-only gate.",
    grok: "Grok asks before edits, but an unattended run has nobody to refuse them.",
  };
  return {
    tier: "advisory",
    reason: `${why[platform as keyof typeof why]} A post-hoc guard checks the workspace.`,
  };
}

/** The shell denied (or its writes denied) outside a read-only turn. */
function shellBoundary(platform: AgentPlatform, wholeShell: boolean): TierAndReason {
  // Cursor's only shell lever removes the shell tool, which holds both.
  if (platform === "cursor" || (platform === "claude" && wholeShell)) {
    return { tier: "provider-configured" };
  }
  if (platform === "claude") {
    return {
      tier: "advisory",
      reason:
        "Bash stays available: only a read-only turn's command allowlist separates reading commands from writing ones.",
    };
  }
  return {
    tier: "advisory",
    reason: "This platform's bridge does not restrict the shell outside a read-only turn.",
  };
}

/** Providers with a sandbox of their own that can contain commands. */
function hasProviderSandbox(platform: AgentPlatform): boolean {
  return platform === "claude" || platform === "codex" || platform === "cursor";
}

/** A network denial outside a read-only turn. */
function networkBoundary(platform: AgentPlatform, policy: AgentEnforcementPolicy): TierAndReason {
  const commandsContained =
    policy.networkAccess === "restricted" &&
    (policy.sandbox === "container" ||
      (policy.sandbox === "provider" && hasProviderSandbox(platform)));
  if (!commandsContained) {
    return {
      tier: "advisory",
      reason: "Commands can still reach the network: nothing sandboxes them with the network off.",
    };
  }
  if (platform === "grok") {
    return {
      tier: "advisory",
      reason: "xAI's hosted X search tools cannot be removed.",
    };
  }
  return {
    tier: "provider-configured",
    reason:
      "Commands are sandboxed without the network, and the provider is told to remove its hosted web tools.",
  };
}

/** `git.commit` with the workspace otherwise writable. */
function commitBoundary(platform: AgentPlatform): TierAndReason {
  return {
    tier: "advisory",
    reason:
      platform === "claude" || platform === "opencode"
        ? "Commit commands are denied as written; another spelling runs, so the HEAD guard checks for new commits."
        : "This platform cannot deny one command while the shell may write; the HEAD guard checks for new commits.",
  };
}

const REMOTE_GUARD_REASON =
  "Push and GitHub writes are held by Orkestrator's guards (remote-ref check, withheld GitHub credential), not by the provider.";

function secondaryAxis(
  axis: "subagents" | "mcp" | "web-search",
  platform: AgentPlatform,
  readOnly: boolean,
): TierAndReason {
  switch (axis) {
    case "subagents":
      return platform === "claude" || platform === "cursor" || platform === "opencode"
        ? { tier: "provider-configured" }
        : {
            tier: "advisory",
            reason:
              "This platform's bridge cannot remove its sub-agent tool; a sub-agent inherits the parent's limits.",
          };
    case "mcp":
      if (platform === "claude" || platform === "opencode") return { tier: "provider-configured" };
      // The bridge disables (Codex), never connects (Pi) or never passes
      // (Cursor) a denied server.
      if (platform === "codex" || platform === "cursor") return { tier: "provider-configured" };
      if (platform === "pi") return { tier: "enforced" };
      if (readOnly && platform !== "grok") {
        return {
          tier: "provider-configured",
          reason: "Read-only turns load no repository MCP servers.",
        };
      }
      return {
        tier: "advisory",
        reason:
          "Repository configuration is switched off instead; servers from the user's own configuration still load.",
      };
    case "web-search":
      if (platform === "grok") {
        return { tier: "advisory", reason: "Grok's hosted search cannot be removed on its own." };
      }
      // Pi has no hosted search to remove.
      return platform === "pi" ? { tier: "enforced" } : { tier: "provider-configured" };
  }
}

/**
 * How strongly `platform` loads only the configured MCP servers a policy
 * selects (`capabilityPolicy.userMcpServers`, item 404). Never more than the
 * selection on the first five; Grok cannot be narrowed at all.
 */
function userMcpSelectionAxis(platform: AgentPlatform, readOnly: boolean): TierAndReason {
  switch (platform) {
    case "pi":
      // The bridge's own MCP client is the only one in the session.
      return { tier: "enforced" };
    case "claude":
      return {
        tier: "provider-configured",
        reason: "The CLI loads only the bridge's inline MCP set (strict MCP configuration).",
      };
    case "codex":
      return {
        tier: "provider-configured",
        reason: "app-server disables every other configured server for this thread.",
      };
    case "opencode":
      return {
        tier: "provider-configured",
        reason:
          "Other servers still run in OpenCode's shared process; this session's permission rules refuse their tools.",
      };
    case "cursor":
      return readOnly
        ? {
            tier: "provider-configured",
            reason: "Read-only turns load only Orkestrator's own MCP server.",
          }
        : {
            tier: "provider-configured",
            reason:
              "The SDK gets only the selected servers inline; user and project settings are not loaded.",
          };
    case "grok":
      return {
        tier: "advisory",
        reason: "Grok loads every MCP server in its own configuration; none can be removed.",
      };
  }
}

/**
 * How strongly `platform` holds `policy` on `host`.
 *
 * Read-only policies (no file tool may write, the shell may not mutate) are
 * judged by the read-only boundary, which also holds their network, commit and
 * remote denials: that is the coordinator's table, so the coordinator policy
 * gets exactly its qualification tier and reason. Other policies are judged
 * per denied axis; their commit and remote denials are advisory unless a shell
 * or network denial already rules them out.
 */
export function agentPolicyEnforcement(
  policy: AgentEnforcementPolicy,
  platform: AgentPlatform,
  host: AgentEnforcementHost,
): AgentEnforcementJudgement {
  const denied = new Set<string>(nativeAgentDeniedCapabilities(policy));
  const readOnly = nativeAgentDenialsAreReadOnly(denied);
  const networkDenied = denied.has("network");
  const searchDenied =
    denied.has("web.search") ||
    (networkDenied && !policy.capabilityPolicy?.allow?.includes("web.search"));
  const axes: AgentEnforcementAxis[] = [];
  const add = (axis: AgentEnforcementAxisId, boundary: boolean, judged: TierAndReason) =>
    axes.push({
      axis,
      tier: judged.tier,
      boundary,
      ...(judged.reason ? { reason: judged.reason } : {}),
    });

  if (readOnly) {
    const boundary = readOnlyBoundary(platform, host);
    add("workspace", true, boundary);
    // The read-only turn denies the network on every adapter, hosted fetch
    // included, so a network denial is held exactly as strongly.
    if (networkDenied) add("network", true, { tier: boundary.tier });
    if (denied.has("shell")) {
      add(
        "shell",
        false,
        platform === "pi"
          ? { tier: "enforced" }
          : removesTools(platform) || platform === "opencode"
            ? { tier: "provider-configured" }
            : {
                tier: "advisory",
                reason: "Reading commands stay available; only their writes are refused.",
              },
      );
    }
    // A read-only shell can neither commit nor push.
    if (denied.has("git.commit")) add("commit", true, { tier: boundary.tier });
    if (denied.has("git.push") || denied.has("github.write")) {
      add("remote", true, { tier: boundary.tier });
    }
  } else {
    if (denied.has("file.write") || denied.has("file.patch")) {
      add("workspace", true, fileToolBoundary(platform));
    }
    const shell =
      denied.has("shell") || denied.has("shell.mutate")
        ? shellBoundary(platform, denied.has("shell"))
        : undefined;
    if (shell) add("shell", true, shell);
    const network = networkDenied ? networkBoundary(platform, policy) : undefined;
    if (network) add("network", true, network);
    if (denied.has("git.commit")) {
      add(
        "commit",
        true,
        shell && shell.tier !== "advisory" ? { tier: shell.tier } : commitBoundary(platform),
      );
    }
    if (denied.has("git.push") || denied.has("github.write")) {
      // Pushing and GitHub writes need both a command and the network, so
      // either denial already holds them, as strongly as it holds itself.
      const holders = [shell, network].filter((entry): entry is TierAndReason => !!entry);
      const strongest = holders.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])[0];
      add(
        "remote",
        true,
        strongest && strongest.tier !== "advisory"
          ? { tier: strongest.tier }
          : { tier: "advisory", reason: REMOTE_GUARD_REASON },
      );
    }
  }
  if (!networkDenied && searchDenied) {
    add("web-search", false, secondaryAxis("web-search", platform, readOnly));
  }
  if (denied.has("subagents"))
    add("subagents", false, secondaryAxis("subagents", platform, readOnly));
  if (policy.capabilityPolicy?.userMcpServers !== undefined) {
    add("mcp", false, userMcpSelectionAxis(platform, readOnly));
  } else if ([...denied].some((capability) => capability.startsWith("mcp:"))) {
    add("mcp", false, secondaryAxis("mcp", platform, readOnly));
  }

  const boundaryAxes = axes.filter((axis) => axis.boundary);
  const tier = weakestAgentEnforcementTier(boundaryAxes.map((axis) => axis.tier));
  const reason = boundaryAxes.find((axis) => axis.tier === tier && axis.reason)?.reason;
  return { tier, readOnly, axes, ...(reason ? { reason } : {}) };
}

/** One judgement per platform: a row of the designer's matrix. */
export function agentPolicyEnforcementMatrix(
  policy: AgentEnforcementPolicy,
  host: AgentEnforcementHost,
  platforms: readonly AgentPlatform[] = AGENT_PLATFORMS,
): Partial<Record<AgentPlatform, AgentEnforcementJudgement>> {
  return Object.fromEntries(
    platforms.map((platform) => [platform, agentPolicyEnforcement(policy, platform, host)]),
  );
}

/** The platforms whose tier meets `floor`, in the order given. */
export function agentPlatformsMeetingFloor(
  policy: AgentEnforcementPolicy,
  floor: AgentEnforcementTier,
  host: AgentEnforcementHost,
  platforms: readonly AgentPlatform[] = AGENT_PLATFORMS,
): AgentPlatform[] {
  return platforms.filter((platform) =>
    agentEnforcementTierSatisfies(agentPolicyEnforcement(policy, platform, host).tier, floor),
  );
}
