import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { NATIVE_AGENT_MAIL_CAPABILITIES } from "@orkestrator/protocol/agent-mail";
import {
  COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION,
  DEFAULT_COORDINATOR_PROVIDER_TIER,
  normalizeCoordinatorProviderTierDefaultVersion,
  type CoordinatorProviderQualification,
  type CoordinatorProviderTier,
} from "@orkestrator/protocol/coordinator";
import {
  claudeLinuxSandboxStatus,
  type ClaudeLinuxSandboxStatus,
} from "@orkestrator/protocol/node/claude-linux-sandbox";

/**
 * The one table that decides which providers may run a coordinator.
 *
 * Before this existed the same judgement was spelled out in four places — the
 * workspace service, the runtime resolver, the bridge launcher and the trusted
 * session input — and each of them said "codex" as a literal. A platform could
 * therefore be half-qualified: allowed to hold a conversation but refused a
 * bridge, or vice versa. Every one of those call sites now asks this module.
 */

/** Weakest tier a host will admit, lowest to highest permissiveness. */
export const COORDINATOR_PROVIDER_TIER_SETTINGS = [
  "enforced",
  "provider-configured",
  "advisory",
] as const;
export type CoordinatorProviderTierSetting = (typeof COORDINATOR_PROVIDER_TIER_SETTINGS)[number];

export {
  COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION,
  DEFAULT_COORDINATOR_PROVIDER_TIER,
  normalizeCoordinatorProviderTierDefaultVersion,
};

const TIER_RANK: Readonly<Record<CoordinatorProviderTier, number>> = Object.freeze({
  enforced: 0,
  "provider-configured": 1,
  advisory: 2,
  unavailable: 3,
});

export function coordinatorProviderTierSetting(value: unknown): CoordinatorProviderTierSetting {
  if (value === undefined) return DEFAULT_COORDINATOR_PROVIDER_TIER;
  return (COORDINATOR_PROVIDER_TIER_SETTINGS as readonly unknown[]).includes(value)
    ? (value as CoordinatorProviderTierSetting)
    : "enforced";
}

/**
 * What the host can actually offer a provider sandbox with.
 *
 * Claude's read-only boundary rests on its command sandbox, which does not
 * exist on every platform. Reporting `enforced` where the sandbox cannot start
 * would promise an OS guarantee that is not there, so the probe result is an
 * input to the table rather than an assumption inside it.
 */
export interface CoordinatorHostCapabilities {
  /** Whether the Claude Agent SDK's command sandbox can run commands on this host. */
  claudeSandbox: boolean;
  /** Why it cannot, when the probe knows; shown in place of the generic reason. */
  claudeSandboxReason?: string;
}

export function defaultCoordinatorHostCapabilities(
  platform: NodeJS.Platform = process.platform,
  linuxSandbox: () => ClaudeLinuxSandboxStatus = () => claudeLinuxSandboxStatus(),
): CoordinatorHostCapabilities {
  // Seatbelt on macOS, which ships with the OS. On Linux the CLI runs commands
  // under bubblewrap with a socat network bridge and a seccomp helper that
  // nests a second user namespace, so the probe runs exactly that: a host
  // missing either program, or whose policy refuses the nested namespace
  // (Ubuntu's AppArmor bwrap profile), is reported as configuration rather
  // than containment instead of failing every command. The pinned CLI's
  // Windows sandbox is behind a vendor flag that is off by default, so
  // Windows is configuration too.
  if (platform === "darwin") return { claudeSandbox: true };
  if (platform === "linux") {
    const status = linuxSandbox();
    return status.available
      ? { claudeSandbox: true }
      : { claudeSandbox: false, claudeSandboxReason: status.reason };
  }
  return { claudeSandbox: false };
}

/** Where the probe has no specific cause (Windows, or a host given without one). */
const CLAUDE_SANDBOX_UNAVAILABLE =
  "Claude's command sandbox is unavailable on this host (it needs macOS, or Linux whose bubblewrap can nest a user namespace).";

/** The hook sentence every unsandboxed Claude coordinator reason ends with. */
const CLAUDE_UNSANDBOXED_BOUNDARY =
  "File tools are removed and the bridge admits only reading commands, but nothing outside the agent enforces it.";

interface Qualification {
  tier: CoordinatorProviderTier;
  reason?: string;
  delegation: boolean;
}

/** What the platform itself decides, before the delivery half is applied. */
interface TierJudgement {
  tier: CoordinatorProviderTier;
  reason?: string;
  /** Whether it ships an MCP client that can reach the delegation tools. */
  mcpClient: boolean;
}

/**
 * Delegation is a round trip, so an MCP client alone is not enough.
 *
 * `launch_environment` goes out over MCP, but the worker's result comes back as
 * agent mail — and a native mailbox that cannot be injected into never delivers
 * it. Telling the coordinator to create workers on such a platform produces a
 * conversation that dispatches work and then waits for a reply that the mail
 * store is structurally unable to hand over.
 */
function delegationDeliverable(platform: AgentPlatform): boolean {
  return NATIVE_AGENT_MAIL_CAPABILITIES[platform].canInject;
}

const NO_DELIVERY_CAVEAT =
  "Worker delegation is unavailable because this platform's mailbox cannot receive replies. Inspection and planning work normally.";

function judge(platform: AgentPlatform, host: CoordinatorHostCapabilities): TierJudgement {
  switch (platform) {
    case "codex":
      // A Codex permission profile denies the filesystem and the network in the
      // child process itself, and the bridge refuses to run a turn unless
      // app-server echoes the profile back. Hosted web search is outside that
      // profile (OpenAI's servers fetch the page), so it is switched off in
      // configuration and the bridge refuses a thread unless `config/read`
      // confirms it. A Codex that cannot do that would not be `enforced`.
      return { tier: "enforced", mcpClient: true };
    case "claude":
      return host.claudeSandbox
        ? { tier: "enforced", mcpClient: true }
        : {
            tier: "provider-configured",
            reason: `${host.claudeSandboxReason ?? CLAUDE_SANDBOX_UNAVAILABLE} ${CLAUDE_UNSANDBOXED_BOUNDARY}`,
            mcpClient: true,
          };
    case "pi":
      // Pi's gate runs inside the bridge on every tool call and cannot be
      // switched off by the workspace. The bridge-owned MCP client registers
      // Agent MCP tools on that same gate, so coordinator mail is reachable.
      return { tier: "enforced", mcpClient: true };
    case "opencode":
      return {
        tier: "provider-configured",
        reason:
          "OpenCode denies mutating tools through its own permission rules, but always loads the checkout's project configuration.",
        mcpClient: true,
      };
    case "cursor":
      return {
        tier: "provider-configured",
        reason:
          "Cursor applies the sandbox and tool restrictions, but its SDK exposes no approval callback to verify them.",
        mcpClient: true,
      };
    case "grok":
      return {
        tier: "advisory",
        reason:
          "Grok's write, edit, shell, subagent, web search and web fetch tools are removed. Remaining permission requests are denied; other tools that do not ask, including xAI's hosted X search tools, remain advisory.",
        mcpClient: true,
      };
  }
}

function qualify(platform: AgentPlatform, host: CoordinatorHostCapabilities): Qualification {
  const { tier, reason, mcpClient } = judge(platform, host);
  const delegation = mcpClient && delegationDeliverable(platform);
  // The caveat travels with the platform rather than being discovered when a
  // worker never reports back, so it has to reach the reason the picker shows.
  const caveat = delegation ? undefined : NO_DELIVERY_CAVEAT;
  const combined = [reason, mcpClient ? caveat : undefined].filter(Boolean).join(" ") || reason;
  return { tier, delegation, ...(combined ? { reason: combined } : {}) };
}

export function coordinatorProviderQualification(
  platform: AgentPlatform,
  options: {
    tierSetting?: unknown;
    enabledPlatforms?: readonly AgentPlatform[];
    host?: CoordinatorHostCapabilities;
  } = {},
): CoordinatorProviderQualification {
  const host = options.host ?? defaultCoordinatorHostCapabilities();
  const setting = coordinatorProviderTierSetting(options.tierSetting);
  const { tier, reason, delegation } = qualify(platform, host);
  if (options.enabledPlatforms && !options.enabledPlatforms.includes(platform)) {
    return {
      tier,
      available: false,
      reason: "This agent platform is turned off in settings.",
      delegation,
    };
  }
  if (TIER_RANK[tier] > TIER_RANK[setting]) {
    return {
      tier,
      available: false,
      reason:
        reason ??
        "This platform's read-only boundary is weaker than the coordinator safety level allows.",
      delegation,
    };
  }
  return { tier, available: true, ...(reason ? { reason } : {}), delegation };
}

export function coordinatorProviderQualifications(
  options: Parameters<typeof coordinatorProviderQualification>[1] = {},
): Partial<Record<AgentPlatform, CoordinatorProviderQualification>> {
  return Object.fromEntries(
    AGENT_PLATFORMS.map((platform) => [
      platform,
      coordinatorProviderQualification(platform, options),
    ]),
  );
}

export function coordinatorProviderAllowed(
  platform: AgentPlatform,
  options: Parameters<typeof coordinatorProviderQualification>[1] = {},
): boolean {
  return coordinatorProviderQualification(platform, options).available;
}

export function coordinatorProviderUnavailableMessage(
  platform: AgentPlatform,
  options: Parameters<typeof coordinatorProviderQualification>[1] = {},
): string {
  const qualification = coordinatorProviderQualification(platform, options);
  return (
    qualification.reason ?? "This agent platform is not available for Coordinator on this host."
  );
}
