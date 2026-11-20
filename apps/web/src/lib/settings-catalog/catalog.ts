/**
 * Every user-editable setting Settings shows, for search, field navigation
 * and the effective-value explanation (`./types.ts`).
 *
 * Add an entry when a section gains a setting, and wrap the field in
 * `SettingField` with the entry's id (or give it a `locate` fallback).
 * `catalog.test.ts` fails when a form-owned config key has no entry, an
 * entry names a section that does not exist, or an anchor or locator no
 * longer appears in the settings source.
 */
import { createDefaultGlobalConfig } from "@orkestrator/protocol/app-config-defaults";
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  resolveMultiReviewSettings,
  SHIPPED_PLATFORM_MODES,
  normalizeAgentSettings,
  type AgentPlatformSettings,
} from "@orkestrator/protocol/agent-settings";
import {
  normalizeNotificationSoundSettings,
  type NotificationSoundSettings,
} from "@orkestrator/protocol/notification-sounds";
import { isLocalDesktopWindow } from "@/lib/native/window";
import { platformOwnsSpeed } from "@/lib/agent-launch";
import { desktopNotificationPermission } from "@/lib/question-desktop-notification";
import { DEFAULT_AGENT_MESSAGING_SETTINGS } from "@orkestrator/protocol/agent-mail";
import { resolveClaudeBackgroundCommandLimitHours } from "@orkestrator/protocol/claude-background-commands";
import { DEFAULT_COORDINATOR_PROVIDER_TIER } from "@orkestrator/protocol/coordinator";
import {
  coordinatorWebResearchSetting,
  normalizeCoordinatorResearchMcpServers,
} from "@orkestrator/protocol/coordinator-web-research";
import { normalizeDebugLogRetentionDays } from "@orkestrator/protocol/debug-logging";
import { resolveLogDetail } from "@orkestrator/protocol/log-policy";
import { MULTI_REVIEW_DEFAULT_ENGINE } from "@orkestrator/protocol/multi-review";
import { normalizeOpenCodeModelProviders } from "@orkestrator/protocol/native-agent";
import { resolveReviewLensPresets } from "@orkestrator/protocol/review-lens";
import { resolveSessionTitleGenerationPolicy } from "@orkestrator/protocol/session-title-generation";
import { resolveTerminalLinkDefaultTarget } from "@orkestrator/protocol/terminal-link-target";
import { DEFAULT_REVIEW_INSTRUCTION } from "@/prompts";
import type { GlobalConfig } from "@/types";
import type { SettingDescriptor, SettingValueBinding } from "./types";

const DEFAULTS = createDefaultGlobalConfig() as unknown as GlobalConfig;

// --- Formatting ---------------------------------------------------------------

const onOff = (value: unknown) => (value ? "On" : "Off");
const text = (value: unknown, empty = "Not set") =>
  typeof value === "string" && value.trim() ? value : empty;
const count = (unit: string) => (value: unknown) =>
  typeof value === "number" ? `${value.toLocaleString()} ${unit}` : "Not set";
const listOf = (noun: string) => (value: unknown) =>
  Array.isArray(value) ? `${value.length} ${noun}${value.length === 1 ? "" : "s"}` : "Not set";
const labelled = (labels: Record<string, string>) => (value: unknown) =>
  typeof value === "string" ? (labels[value] ?? value) : "Not set";

function binding(
  key: SettingValueBinding["key"],
  read: SettingValueBinding["read"],
  format?: SettingValueBinding["format"],
  defaultValue: unknown = read(DEFAULTS),
): SettingValueBinding {
  return { key, read, defaultValue, ...(format ? { format } : {}) };
}

/** A key the form stores as it holds it, with the new-install default. */
function stored<K extends keyof GlobalConfig & string>(
  key: K,
  fallback: GlobalConfig[K],
  format?: SettingValueBinding["format"],
): SettingValueBinding {
  return binding(key, (global) => global[key] ?? fallback, format);
}

const defaultAgent = binding(
  "agentSettings",
  (global) => normalizeAgentSettings(global.agentSettings).defaultAgent,
  labelled(AGENT_PLATFORM_LABELS),
);

const sound = (field: keyof NotificationSoundSettings): SettingValueBinding => ({
  ...binding(
    "notificationSounds",
    (global) => normalizeNotificationSoundSettings(global.notificationSounds)[field],
  ),
  field,
  ...(field === "questionDesktopNotification"
    ? {
        readEffective: (value, onWindowMachine) => {
          if (!value || !onWindowMachine) return value;
          const permission = desktopNotificationPermission();
          return permission === "granted"
            ? value
            : permission === "denied"
              ? "Off here (notifications blocked)"
              : "Off here (notification permission required)";
        },
      }
    : {}),
});

const messaging = <K extends keyof typeof DEFAULT_AGENT_MESSAGING_SETTINGS>(
  field: K,
  format: (value: unknown) => string,
) =>
  binding(
    "agentMessaging",
    (global) =>
      (global.agentMessaging as Partial<typeof DEFAULT_AGENT_MESSAGING_SETTINGS> | undefined)?.[
        field
      ] ?? DEFAULT_AGENT_MESSAGING_SETTINGS[field],
    format,
    DEFAULT_AGENT_MESSAGING_SETTINGS[field],
  );

const terminalHistoryOn = {
  isAvailable: ({ global }: { global: GlobalConfig }) =>
    (global.terminalHistoryEnabled ?? DEFAULTS.terminalHistoryEnabled) !== false,
  reason: "Turn on Backend history retention in Terminal.",
  via: "terminal.history-retention",
};

const platformEnabled = (platform: AgentPlatform) => ({
  isAvailable: ({ global }: { global: GlobalConfig }) =>
    (global.enabledAgentPlatforms ?? DEFAULTS.enabledAgentPlatforms ?? []).includes(platform),
  reason: `Enable ${AGENT_PLATFORM_LABELS[platform]} in Platforms.`,
  via: "platforms.enabled",
});

const platformField = (
  platform: AgentPlatform,
  field: keyof AgentPlatformSettings,
  label: string,
  description: string,
  locate: NonNullable<SettingDescriptor["locate"]>,
  fallback?: AgentPlatformSettings[keyof AgentPlatformSettings],
  aliases?: readonly string[],
): SettingDescriptor => {
  const read = (global: GlobalConfig) =>
    normalizeAgentSettings(global.agentSettings).platforms?.[platform]?.[field];
  return {
    id: `${platform}.${field.replace(/^claude([A-Z])/, (_, first: string) => first.toLowerCase()).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    section: platform,
    label,
    description,
    locate,
    aliases,
    appliesWhen: "new-sessions",
    availability: platformEnabled(platform),
    value: {
      ...binding(
        "agentSettings",
        (global) => read(global) ?? fallback,
        (value) => (typeof value === "boolean" ? onOff(value) : text(value, "Provider default")),
      ),
      field: `platforms.${platform}.${field}`,
      isExplicit: (global) => {
        const value = read(global);
        return value !== undefined && value !== read(DEFAULTS);
      },
    },
  };
};

const platformPane = (platform: AgentPlatform): SettingDescriptor[] => {
  const label = AGENT_PLATFORM_LABELS[platform];
  const model = { id: `agent-model-${platform}`, heading: "Default model" };
  return [
    ...(platform === "cursor"
      ? []
      : [
          platformField(
            platform,
            "mode",
            `${label} launch mode`,
            "Choose Native chat or a terminal for new sessions.",
            { ariaLabel: `${label} mode` },
            SHIPPED_PLATFORM_MODES[platform],
            ["native", "terminal mode"],
          ),
        ]),
    platformField(
      platform,
      "model",
      `Default ${label} model`,
      "Choose the model for new sessions.",
      model,
    ),
    platformField(
      platform,
      "reasoningEffort",
      `${label} reasoning effort`,
      "Choose a reasoning level in the default model picker.",
      model,
      undefined,
      ["thinking level"],
    ),
    ...(platformOwnsSpeed(platform)
      ? [
          platformField(
            platform,
            "fastMode",
            `${label} model speed`,
            "Choose normal or fast speed in the default model picker where the model supports it.",
            model,
          ),
        ]
      : []),
  ];
};

const claudeBackend = platformField(
  "claude",
  "claudeNativeBackend",
  "Claude native backend",
  "Choose the Agent SDK or experimental Tmux for Native sessions.",
  { ariaLabel: "Claude native backend" },
  "sdk",
);

const signIn = (platform: AgentPlatform, extra: readonly string[] = []): SettingDescriptor => ({
  id: `${platform}.sign-in`,
  section: platform,
  label: `${AGENT_PLATFORM_LABELS[platform]} sign-in and accounts`,
  description: `Sign ${AGENT_PLATFORM_LABELS[platform]} in on this machine, add accounts and see plan usage.`,
  aliases: ["login", "log in", "account", "subscription", "usage", "plan", ...extra],
  appliesWhen: "new-sessions",
  owner: "machine",
  availability: {
    isAvailable: ({ global }) =>
      (global.enabledAgentPlatforms ?? DEFAULTS.enabledAgentPlatforms ?? []).includes(platform),
    reason: `Enable ${AGENT_PLATFORM_LABELS[platform]} in Platforms.`,
    via: "platforms.enabled",
  },
});

const experimentalOnWindowMachine = {
  isAvailable: ({ isWindowMachine }: { isWindowMachine: boolean }) => isWindowMachine,
  reason: "Experimental settings belong to the machine this window runs on; select it above.",
};

const experimental = (
  id: string,
  key:
    | "experimentalGraphs"
    | "experimentalScheduling"
    | "experimentalSelfImprovement"
    | "experimentalTmux",
  label: string,
  description: string,
  aliases: readonly string[],
): SettingDescriptor => ({
  id: `experimental.${id}`,
  section: "experimental",
  label,
  description,
  aliases: ["experimental", "beta", "feature flag", ...aliases],
  appliesWhen: "immediately",
  value: stored(key, false, onOff),
  availability: experimentalOnWindowMachine,
});

export const SETTINGS_CATALOG: readonly SettingDescriptor[] = [
  // --- General ----------------------------------------------------------------
  {
    id: "general.data-saving",
    section: "general",
    label: "Data saving",
    description:
      "Use less network and battery in this window by refreshing background data less often.",
    aliases: ["bandwidth", "battery", "metered", "low data", "network usage"],
    appliesWhen: "immediately",
    owner: "window",
  },
  {
    id: "general.auto-steer",
    section: "general",
    label: "Auto-steer",
    description:
      "What happens to a message you send while an agent is busy: steer it into the running turn, or queue it for the next one.",
    aliases: ["messages while busy", "queue", "steer", "interrupt", "follow-up"],
    appliesWhen: "immediately",
    value: stored("autoSteer", false, onOff),
  },
  {
    id: "general.preferred-editor",
    section: "general",
    label: "Preferred editor",
    description: 'Editor used by "Open in Editor" (Cmd+O).',
    aliases: ["vscode", "vs code", "cursor", "ide", "open in editor"],
    appliesWhen: "immediately",
    value: stored("preferredEditor", "vscode", labelled({ vscode: "VS Code", cursor: "Cursor" })),
  },
  {
    id: "general.default-projects-folder",
    section: "general",
    label: "Default projects folder",
    description: "Where new and cloned projects are placed on this machine.",
    aliases: ["clone location", "projects directory", "workspace folder", "path"],
    appliesWhen: "immediately",
    value: binding(
      "defaultProjectsDirectory",
      (global) => global.defaultProjectsDirectory ?? "",
      (value) => text(value, "Automatic"),
      "",
    ),
  },
  {
    id: "general.host-claude-credentials",
    section: "general",
    label: "Use host Claude Code credentials",
    description: "Give containers the Claude Code login from this computer.",
    aliases: ["claude login", "claude credentials", "container auth"],
    appliesWhen: "new-environments",
    value: stored("useHostClaudeCredentials", true, onOff),
  },
  {
    id: "general.env-files",
    section: "general",
    label: "Environment files",
    description: "File patterns copied into new environments, such as .env files.",
    aliases: [".env", "dotenv", "secrets files", "env patterns", "copy files"],
    appliesWhen: "new-environments",
    value: stored("envFilePatterns", DEFAULTS.envFilePatterns, listOf("pattern")),
  },

  // --- Version control ---------------------------------------------------------
  {
    id: "version-control.host-github-credentials",
    section: "version-control",
    label: "Use host GitHub CLI credentials",
    description:
      "Use the account signed in with gh auth login for GitHub issues and pull requests.",
    aliases: ["github", "gh", "gh auth", "github login", "pull requests"],
    appliesWhen: "immediately",
    value: stored("useHostGitHubCredentials", true, onOff),
  },
  {
    id: "version-control.github-token",
    section: "version-control",
    label: "GitHub personal access token",
    description: "A fine-grained token Orkestrator uses when host GitHub CLI credentials are off.",
    aliases: ["pat", "github token", "access token"],
    appliesWhen: "immediately",
    sensitive: true,
    configured: (global) => global.githubTokenConfigured === true,
    owner: "machine",
    locate: { id: "github-token" },
    availability: {
      isAvailable: ({ global }) =>
        global.useHostGitHubCredentials === false || global.containerGitHubCredential === "pat",
      reason: "Turn off host GitHub CLI credentials, or give containers a personal access token.",
      via: "version-control.host-github-credentials",
    },
  },
  {
    id: "version-control.container-github-credential",
    section: "version-control",
    label: "GitHub access for containers",
    description:
      "What agents in containers use to clone private repositories, push and open pull requests.",
    aliases: ["container github", "clone private", "push", "git credentials"],
    appliesWhen: "immediately",
    value: stored(
      "containerGitHubCredential",
      "none",
      labelled({
        none: "No GitHub access",
        pat: "Personal access token",
        "host-cli": "Share host GitHub CLI token",
      }),
    ),
  },
  {
    id: "version-control.ssh-agent-socket",
    section: "version-control",
    label: "SSH agent socket",
    description: "The SSH agent local worktrees use when an SSH remote needs a key.",
    aliases: ["ssh", "ssh-agent", "ssh key", "SSH_AUTH_SOCK"],
    appliesWhen: "restart",
    value: binding(
      "sshAgentSocketPath",
      (global) => global.sshAgentSocketPath ?? "",
      (value) => text(value, "Auto-detect"),
      "",
    ),
  },
  {
    id: "version-control.auto-merge-require-checks",
    section: "version-control",
    label: "Require checks to pass before auto-merge",
    description: "Whether auto-merge waits until every check on the pull request has passed.",
    aliases: ["auto merge", "automerge", "ci", "checks", "merge"],
    appliesWhen: "immediately",
    value: stored("autoMergeRequireChecks", true, onOff),
  },

  // --- Machines (command node) -------------------------------------------------
  {
    id: "machines.command-others",
    section: "machines",
    label: "Allow this machine to command others",
    description: "Make this machine a command node that can add and control other machines.",
    aliases: ["federation", "command node", "remote machines", "fleet"],
    appliesWhen: "immediately",
    owner: "command-node",
    locate: { ariaLabel: "Allow this machine to command others" },
  },
  {
    id: "machines.list",
    section: "machines",
    label: "Machines",
    description: "Add, connect, reorder and update the machines this command node controls.",
    aliases: ["add machine", "remote", "nodes", "ssh route", "https address", "update machines"],
    appliesWhen: "immediately",
    owner: "command-node",
    locate: { heading: "Machines" },
  },
  {
    id: "machines.device-connection",
    section: "machines",
    label: "Connection on this device",
    description: "How this device reaches each machine: HTTPS addresses and SSH routes.",
    aliases: ["ssh", "https", "tailscale", "route", "address", "port"],
    appliesWhen: "immediately",
    owner: "command-node",
    locate: { heading: "On this device" },
  },

  // --- Disk usage and usage ----------------------------------------------------
  {
    id: "disk-usage.worktree-locations",
    section: "disk-usage",
    label: "Worktree locations",
    description: "Where new environment and dev worktrees are created on this machine.",
    aliases: ["disk", "storage", "worktree folder", "space", "cleanup"],
    appliesWhen: "new-environments",
    owner: "machine",
    locate: { heading: "Disk usage" },
  },
  {
    id: "usage.overview",
    section: "usage",
    label: "Usage",
    description: "Token and cost usage per day, platform and environment on this machine.",
    aliases: ["cost", "tokens", "spend", "billing", "statistics"],
    appliesWhen: "immediately",
    owner: "machine",
    locate: { heading: "Usage" },
  },

  // --- Defaults and platforms --------------------------------------------------
  {
    id: "defaults.agent-defaults",
    section: "defaults",
    label: "Default agent and models",
    description:
      "The agent, model and modes new sessions start with, unless a project overrides them.",
    aliases: ["default model", "default agent", "favourite models", "favorites", "agent defaults"],
    appliesWhen: "new-sessions",
    value: { ...defaultAgent, field: "defaultAgent" },
  },
  {
    id: "platforms.enabled",
    section: "platforms",
    label: "Agent platforms",
    description: "Which agent systems appear in the toolbar, review picker and build workflow.",
    aliases: ["enable agent", "claude", "codex", "cursor", "grok", "opencode", "pi", "providers"],
    appliesWhen: "immediately",
    value: stored("enabledAgentPlatforms", DEFAULTS.enabledAgentPlatforms, listOf("platform")),
  },
  {
    id: "platforms.session-titles",
    section: "platforms",
    label: "Session titles",
    description: "Which signed-in platform may generate a title for new sessions, or none.",
    aliases: ["title generation", "auto title", "name sessions", "rename"],
    appliesWhen: "new-sessions",
    value: binding(
      "sessionTitleGeneration",
      (global) => resolveSessionTitleGenerationPolicy(global.sessionTitleGeneration),
      labelled({
        "any-signed-in": "Any signed-in platform",
        "own-platform": "Same platform only",
        off: "Off",
      }),
    ),
  },

  // --- Coordinator --------------------------------------------------------------
  {
    id: "coordinator.safety-level",
    section: "coordinator",
    label: "Coordinator safety level",
    description: "How strongly a platform must hold a Coordinator to read-only to be offered.",
    aliases: ["read-only", "coordinator tier", "enforced", "advisory", "safety"],
    appliesWhen: "new-sessions",
    value: binding(
      "coordinatorProviderTiers",
      (global) => global.coordinatorProviderTiers ?? DEFAULT_COORDINATOR_PROVIDER_TIER,
      labelled({
        enforced: "Enforced",
        "provider-configured": "Provider-configured",
        advisory: "Advisory",
      }),
      DEFAULT_COORDINATOR_PROVIDER_TIER,
    ),
  },
  {
    id: "coordinator.web-research",
    section: "coordinator",
    label: "Coordinator web research",
    description: "Whether a Coordinator may search the web and use remote research servers.",
    aliases: ["web search", "research", "internet", "browse", "context7"],
    appliesWhen: "new-sessions",
    value: binding(
      "coordinatorWebResearch",
      (global) => coordinatorWebResearchSetting(global.coordinatorWebResearch),
      labelled({
        off: "Off",
        search: "Web search",
        "search-and-mcp": "Web search and MCP servers",
      }),
    ),
  },
  {
    id: "coordinator.research-servers",
    section: "coordinator",
    label: "Research servers",
    description: "Remote MCP servers a Coordinator may use for research.",
    aliases: ["mcp", "research mcp", "context7", "remote servers"],
    appliesWhen: "new-sessions",
    value: binding(
      "coordinatorResearchMcpServers",
      (global) => normalizeCoordinatorResearchMcpServers(global.coordinatorResearchMcpServers),
      listOf("server"),
    ),
    availability: {
      isAvailable: ({ global }) =>
        coordinatorWebResearchSetting(global.coordinatorWebResearch) === "search-and-mcp",
      reason: "Choose web search and MCP servers for Coordinator web research.",
      via: "coordinator.web-research",
    },
  },

  // --- Review (command node) --------------------------------------------------
  {
    id: "review.multi-review-defaults",
    section: "review",
    label: "Multi Review reviewers",
    description: "The reviewers, models and focus a new Multi Review starts with.",
    aliases: ["multi review", "reviewers", "code review", "review models"],
    appliesWhen: "new-sessions",
    value: {
      ...binding(
        "agentSettings",
        (global) => {
          const tier = normalizeAgentSettings(global.agentSettings);
          const { reviewerCount, additionalReviewers, reviewerLenses } = resolveMultiReviewSettings(
            { global: tier },
          );
          return {
            reviewer: tier.actionDefaults?.review,
            secondReviewer: tier.actionDefaults?.review2,
            reviewerCount,
            additionalReviewers,
            reviewerLenses,
          };
        },
        (value) => {
          const review = value as { reviewerCount: number; reviewer?: { model?: string } };
          return `${review.reviewerCount} reviewers${review.reviewer?.model ? ` · ${review.reviewer.model}` : ""}`;
        },
      ),
      field: "multiReview",
    },
  },
  {
    id: "review.lens-presets",
    section: "review",
    label: "Review focus presets",
    description: "Named review focuses a reviewer can be started with.",
    aliases: ["lens", "lenses", "focus", "presets", "review focus"],
    appliesWhen: "new-sessions",
    value: binding(
      "reviewLensPresets",
      (global) => resolveReviewLensPresets(global.reviewLensPresets),
      listOf("preset"),
    ),
  },
  {
    id: "review.engine",
    section: "review",
    label: "Multi Review engine",
    description: "Which runtime runs new Multi Reviews.",
    aliases: ["graph", "bespoke", "review runtime"],
    appliesWhen: "new-sessions",
    value: binding(
      "multiReviewEngine",
      (global) => global.multiReviewEngine ?? MULTI_REVIEW_DEFAULT_ENGINE,
      labelled({ bespoke: "Bespoke", graph: "Graph" }),
      MULTI_REVIEW_DEFAULT_ENGINE,
    ),
  },
  {
    id: "review.instruction",
    section: "review",
    label: "Code review instruction",
    description: "What reviewers should emphasise in normal, Multi Review and pipeline reviews.",
    aliases: ["review prompt", "review notes", "reviewer instructions", "code review"],
    appliesWhen: "new-sessions",
    value: binding(
      "reviewInstruction",
      (global) =>
        typeof global.reviewInstruction === "string" && global.reviewInstruction.trim()
          ? global.reviewInstruction
          : DEFAULT_REVIEW_INSTRUCTION,
      (value) =>
        value === DEFAULT_REVIEW_INSTRUCTION
          ? "Default instruction"
          : `Custom (${String(value).length.toLocaleString()} characters)`,
      DEFAULT_REVIEW_INSTRUCTION,
    ),
  },

  // --- Platforms ------------------------------------------------------------------
  signIn("claude", ["anthropic", "claude max", "claude pro"]),
  {
    id: "claude.api-key",
    section: "claude",
    label: "Anthropic API key",
    description: "Optional API-key override for Claude Code in containers.",
    aliases: ["anthropic", "api key", "claude key", "sk-ant"],
    appliesWhen: "new-sessions",
    sensitive: true,
    configured: (global) => global.anthropicApiKeyConfigured === true,
    owner: "machine",
  },
  {
    id: "claude.background-limit",
    section: "claude",
    label: "Background task time limit",
    description: "How long a Claude background command may run before it is stopped.",
    aliases: ["background command", "timeout", "long running", "hours"],
    appliesWhen: "new-sessions",
    value: binding(
      "claudeBackgroundCommandLimitHours",
      (global) =>
        resolveClaudeBackgroundCommandLimitHours(global.claudeBackgroundCommandLimitHours),
      count("hours"),
    ),
  },
  ...platformPane("claude"),
  {
    ...claudeBackend,
    availability: {
      isAvailable: ({ global }) =>
        Boolean(
          global.experimentalTmux ||
          normalizeAgentSettings(global.agentSettings).platforms?.claude?.claudeNativeBackend ===
            "tmux",
        ),
      reason: "Turn on Tmux in Experimental.",
      via: "experimental.tmux",
    },
  },
  platformField(
    "claude",
    "claudeThinkingMode",
    "Claude thinking",
    "Set an adaptive or fixed thinking budget.",
    { id: "claude-thinking-mode" },
    "adaptive",
  ),
  platformField(
    "claude",
    "claudeContext1m",
    "1M context beta",
    "Enable the larger Claude context window for supported models.",
    { ariaLabel: "Claude 1M context beta" },
    false,
  ),
  platformField(
    "claude",
    "claudeChrome",
    "Claude in Chrome",
    "Connect the Claude in Chrome extension to new Agent SDK sessions.",
    { ariaLabel: "Claude in Chrome" },
    false,
  ),
  signIn("codex", ["openai", "chatgpt"]),
  {
    id: "codex.concurrent-threads",
    section: "codex",
    label: "Concurrent subagent limit",
    description: "How many Codex subagent threads may run at once.",
    aliases: ["threads", "parallel", "subagents", "concurrency"],
    appliesWhen: "new-sessions",
    value: stored(
      "codexMaxConcurrentThreads",
      DEFAULTS.codexMaxConcurrentThreads,
      count("threads"),
    ),
  },
  ...platformPane("codex"),
  signIn("cursor"),
  {
    id: "cursor.api-key",
    section: "cursor",
    label: "Cursor API key",
    description: "The Cursor API key the Cursor SDK uses on this machine.",
    aliases: ["cursor key", "api key"],
    appliesWhen: "new-sessions",
    sensitive: true,
    configured: (global) => global.cursorApiKeyConfigured === true,
    owner: "machine",
  },
  ...platformPane("cursor"),
  signIn("grok", ["xai"]),
  ...platformPane("grok"),
  signIn("opencode"),
  {
    id: "opencode.zen-api-key",
    section: "opencode",
    label: "OpenCode Zen API key",
    description: "The API key for OpenCode's own Zen provider.",
    aliases: ["zen", "opencode key", "api key"],
    appliesWhen: "new-sessions",
    sensitive: true,
    configured: (global) => global.openCodeZenApiKeyConfigured === true,
    owner: "machine",
  },
  {
    id: "opencode.model-providers",
    section: "opencode",
    label: "OpenCode model providers",
    description: "Which providers' models OpenCode offers.",
    aliases: ["providers", "openrouter", "models", "allowlist"],
    appliesWhen: "new-sessions",
    value: binding(
      "openCodeModelProviders",
      (global) => normalizeOpenCodeModelProviders(global.openCodeModelProviders),
      (value) =>
        Array.isArray(value) && value.length === 0 ? "Every provider" : listOf("provider")(value),
    ),
  },
  ...platformPane("opencode"),
  signIn("pi"),
  ...platformPane("pi"),

  // --- Capabilities, MCP ----------------------------------------------------------
  {
    id: "capabilities.library",
    section: "capabilities",
    label: "Capabilities",
    description: "Manage capability packages and browse installed skills and plugins.",
    aliases: ["skills", "plugins", "slash commands", "extensions", "toolkits"],
    appliesWhen: "new-sessions",
    locate: { heading: "Capabilities" },
  },
  {
    id: "mcp-servers.list",
    section: "mcp-servers",
    label: "MCP servers for your agents",
    description: "MCP servers your agents connect to on this machine.",
    aliases: ["mcp", "tools", "model context protocol", "servers"],
    appliesWhen: "new-sessions",
    owner: "machine",
    locate: { heading: "MCP servers for your agents" },
  },
  {
    id: "mcp.control",
    section: "mcp",
    label: "Control Orkestrator from another agent",
    description: "Credentials that let another agent or voice client drive Orkestrator over MCP.",
    aliases: ["control mcp", "voice", "mcp credentials", "remote control", "token"],
    appliesWhen: "immediately",
    owner: "command-node",
    locate: { heading: "Control Orkestrator from another agent" },
  },

  // --- Terminal --------------------------------------------------------------------
  {
    id: "terminal.font-family",
    section: "terminal",
    label: "Terminal font family",
    description: "The font terminals use.",
    aliases: ["font", "typeface", "nerd font"],
    appliesWhen: "immediately",
    value: binding(
      "terminalAppearance",
      (global) => global.terminalAppearance?.fontFamily ?? DEFAULTS.terminalAppearance.fontFamily,
      (value) => text(value),
      DEFAULTS.terminalAppearance.fontFamily,
    ),
  },
  {
    id: "terminal.font-size",
    section: "terminal",
    label: "Terminal font size",
    description: "The size of terminal text.",
    aliases: ["font size", "text size", "zoom"],
    appliesWhen: "immediately",
    value: binding(
      "terminalAppearance",
      (global) => global.terminalAppearance?.fontSize ?? DEFAULTS.terminalAppearance.fontSize,
      count("px"),
      DEFAULTS.terminalAppearance.fontSize,
    ),
  },
  {
    id: "terminal.background-color",
    section: "terminal",
    label: "Terminal background color",
    description: "The background colour of terminals.",
    aliases: ["colour", "theme", "background"],
    appliesWhen: "immediately",
    value: binding(
      "terminalAppearance",
      (global) =>
        global.terminalAppearance?.backgroundColor ?? DEFAULTS.terminalAppearance.backgroundColor,
      (value) => text(value),
      DEFAULTS.terminalAppearance.backgroundColor,
    ),
  },
  {
    id: "terminal.scrollback",
    section: "terminal",
    label: "Scrollback buffer",
    description: "How many lines a terminal keeps for scrolling back.",
    aliases: ["history lines", "buffer", "scroll"],
    appliesWhen: "immediately",
    value: stored("terminalScrollback", DEFAULTS.terminalScrollback, count("lines")),
  },
  {
    id: "terminal.link-target",
    section: "previews",
    label: "Open terminal links in",
    description: "Whether links clicked in a terminal open in your browser or a browser tab here.",
    aliases: ["links", "urls", "browser", "click"],
    appliesWhen: "immediately",
    value: binding(
      "terminalLinkDefaultTarget",
      (global) => resolveTerminalLinkDefaultTarget(global.terminalLinkDefaultTarget),
      labelled({ external: "External browser", "browser-tab": "Browser tab" }),
    ),
  },
  {
    id: "terminal.history-retention",
    section: "terminal",
    label: "Backend history retention",
    description: "Keep terminal output on this machine so terminals can be restored.",
    aliases: ["terminal history", "restore terminals", "keep output"],
    appliesWhen: "immediately",
    value: stored("terminalHistoryEnabled", DEFAULTS.terminalHistoryEnabled, onOff),
  },
  {
    id: "terminal.history-session-mb",
    section: "terminal",
    label: "Terminal history per terminal",
    description: "The most history kept for one terminal.",
    aliases: ["mib", "megabytes", "size limit", "terminal history"],
    appliesWhen: "immediately",
    value: stored("terminalHistoryRetentionMb", DEFAULTS.terminalHistoryRetentionMb, count("MiB")),
    availability: terminalHistoryOn,
  },
  {
    id: "terminal.history-global-mb",
    section: "terminal",
    label: "Terminal history for all terminals",
    description: "The most history kept across every terminal on this machine.",
    aliases: ["mib", "megabytes", "total size", "terminal history"],
    appliesWhen: "immediately",
    value: stored(
      "terminalHistoryGlobalRetentionMb",
      DEFAULTS.terminalHistoryGlobalRetentionMb,
      count("MiB"),
    ),
    availability: terminalHistoryOn,
  },
  {
    id: "terminal.history-days",
    section: "terminal",
    label: "Completed terminal history",
    description: "How many days the history of a finished terminal is kept.",
    aliases: ["days", "retention", "terminal history"],
    appliesWhen: "immediately",
    value: stored(
      "terminalHistoryRetentionDays",
      DEFAULTS.terminalHistoryRetentionDays,
      count("days"),
    ),
    availability: terminalHistoryOn,
  },

  // --- Network, web client, previews --------------------------------------------------
  {
    id: "network.allowed-domains",
    section: "network",
    label: "Network whitelist",
    description: 'Domains containers may reach in "Restricted" network mode.',
    aliases: ["allowlist", "allow list", "firewall", "domains", "egress", "proxy", "restricted"],
    appliesWhen: "new-environments",
    value: stored("allowedDomains", DEFAULTS.allowedDomains, listOf("domain")),
  },
  {
    id: "web-client.enabled",
    section: "web-client",
    label: "Allow web access",
    description: "Let a browser on orkestrator.dev connect to this machine over Tailscale.",
    aliases: ["web client", "browser", "remote access", "tailscale", "phone", "mobile"],
    appliesWhen: "immediately",
    value: stored("webClientEnabled", true, onOff),
  },
  {
    id: "web-client.gateway-token",
    section: "web-client",
    label: "Gateway token",
    description: "The token a browser signs in to this machine's web client with.",
    aliases: ["password", "sign in", "web token", "access token"],
    appliesWhen: "immediately",
    sensitive: true,
    owner: "command-node",
    locate: { id: "gateway-token" },
  },
  {
    id: "previews.service-previews",
    section: "previews",
    label: "Service previews",
    description:
      "How dev-server previews open: desktop tunnel, private origins or container relay.",
    aliases: ["preview", "dev server", "localhost", "tunnel", "relay", "port"],
    appliesWhen: "immediately",
    owner: "machine",
    locate: { heading: "Service previews" },
  },
  {
    id: "previews.private-origins",
    section: "previews",
    label: "Private preview origins",
    description: "The addresses and ports private browser previews are served on.",
    aliases: ["origin", "listen port", "public port", "preview domain"],
    appliesWhen: "immediately",
    owner: "machine",
    locate: { heading: "Private preview origins" },
  },
  {
    id: "previews.web-annotations",
    section: "previews",
    label: "Web page annotations",
    description: "Whether you can annotate a previewed page and send the notes to an agent.",
    aliases: ["annotate", "comments", "markup", "browser notes"],
    appliesWhen: "immediately",
    owner: "machine",
    locate: { ariaLabel: "Web annotation mode" },
  },

  // --- Messaging (command node, inherited) -------------------------------------------
  {
    id: "messaging.enabled",
    section: "messaging",
    label: "Enable messaging",
    description: "Let agents send each other messages, which Coordinator delegation needs.",
    aliases: ["agent mail", "mail", "inbox", "delegation", "agent messages"],
    appliesWhen: "immediately",
    value: messaging("enabled", onOff),
    locate: { ariaLabel: "Enable messaging" },
  },
  {
    id: "messaging.paused",
    section: "messaging",
    label: "Pause delivery",
    description: "Hold every agent message until delivery is resumed.",
    aliases: ["pause mail", "stop messages", "hold"],
    appliesWhen: "immediately",
    value: messaging("paused", onOff),
    locate: { ariaLabel: "Pause delivery" },
  },
  {
    id: "messaging.cross-project",
    section: "messaging",
    label: "Allow cross-project messages",
    description: "Let agents message agents in other projects.",
    aliases: ["other projects", "cross project mail"],
    appliesWhen: "immediately",
    value: messaging("allowCrossProject", onOff),
    locate: { ariaLabel: "Allow cross-project messages" },
  },
  {
    id: "messaging.wake-peers",
    section: "messaging",
    label: "Wake peers",
    description: "Start an idle agent's turn when a message arrives for it.",
    aliases: ["wake", "idle agents", "auto deliver"],
    appliesWhen: "immediately",
    value: messaging("wakePeers", onOff),
    locate: { ariaLabel: "Wake peers" },
  },
  {
    id: "messaging.exchange-budget",
    section: "messaging",
    label: "Unattended exchange budget",
    description: "How many messages agents may exchange without you before they stop.",
    aliases: ["budget", "loop limit", "runaway", "limit"],
    appliesWhen: "immediately",
    value: messaging("autonomousWakeBudget", count("exchanges")),
    locate: { ariaLabel: "Unattended exchange budget" },
  },
  {
    id: "messaging.hourly-limit",
    section: "messaging",
    label: "Hourly limit per pair",
    description: "The most messages two agents may exchange in an hour.",
    aliases: ["rate limit", "per hour", "throttle"],
    appliesWhen: "immediately",
    value: messaging("hourlyWakeLimit", count("wakes")),
    locate: { ariaLabel: "Hourly limit per pair" },
  },
  {
    id: "messaging.coordinator-status",
    section: "messaging",
    label: "Coordinator status updates",
    description: "Whether workers send their Coordinator status updates as they work.",
    aliases: ["notifications", "progress updates", "worker reports", "status"],
    appliesWhen: "immediately",
    value: messaging(
      "coordinatorStatusWakes",
      labelled({ settled: "When workers settle", off: "Off", stages: "At every stage" }),
    ),
    locate: { ariaLabel: "Coordinator status updates" },
  },
  {
    id: "messaging.retention",
    section: "messaging",
    label: "Message retention",
    description: "How many days delivered agent messages are kept.",
    aliases: ["keep messages", "days", "cleanup mail"],
    appliesWhen: "immediately",
    value: messaging("retentionDays", count("days")),
    locate: { ariaLabel: "Retention days" },
  },
  {
    id: "messaging.default-delivery",
    section: "messaging",
    label: "Default automatic delivery",
    description: "When new agent tabs accept messages without you opening them.",
    aliases: ["inject", "auto inject", "delivery", "idle"],
    appliesWhen: "new-sessions",
    value: messaging("defaultInjectPolicy", labelled({ off: "Off", idle: "When idle" })),
    locate: { ariaLabel: "Default automatic delivery" },
  },

  // --- Schedules, self-improvement ----------------------------------------------------
  {
    id: "schedules.jobs",
    section: "schedules",
    label: "Schedules",
    description: "Prompts and graphs that run on a schedule.",
    aliases: ["cron", "recurring", "timer", "scheduled jobs", "automation"],
    appliesWhen: "immediately",
    owner: "command-node",
    locate: { heading: "Schedules" },
    availability: {
      isAvailable: ({ global }) => global.experimentalScheduling === true,
      reason: "Turn on Scheduling in Experimental.",
      via: "experimental.scheduling",
    },
  },
  {
    id: "self-improvement.settings",
    section: "self-improvement",
    label: "Self-improvement",
    description: "Review past conversations daily and file improvement tickets for a project.",
    aliases: ["daily review", "retrospective", "tickets", "improve"],
    appliesWhen: "immediately",
    owner: "machine",
    locate: { heading: "Self-improvement" },
    availability: {
      isAvailable: ({ global }) => global.experimentalSelfImprovement === true,
      reason: "Turn on Self-improvement in Experimental.",
      via: "experimental.self-improvement",
    },
  },

  // --- Permissions, credentials, sounds --------------------------------------------------
  {
    id: "permissions.rules",
    section: "permissions",
    label: "Permission rules",
    description: "Commands and tools you allowed agents to run without asking again.",
    aliases: ["always allow", "approvals", "remembered", "allowlist", "trust"],
    appliesWhen: "immediately",
    owner: "machine",
    locate: { heading: "Permissions" },
  },
  {
    id: "credentials.saved",
    section: "credentials",
    label: "Saved credentials",
    description: "Secrets agents may request, and the access they currently hold.",
    aliases: ["secrets", "api keys", "passwords", "vault", "grants"],
    appliesWhen: "immediately",
    owner: "machine",
    locate: { heading: "Saved credentials" },
  },
  {
    id: "sounds.agent-stopped",
    section: "sounds",
    label: "Agent stopped sound",
    description: "A cue when an environment finishes its work.",
    aliases: ["notifications", "alert", "audio", "bell", "done"],
    appliesWhen: "immediately",
    value: sound("agentStopped"),
    locate: { ariaLabel: "Agent stopped sound" },
  },
  {
    id: "sounds.agent-question",
    section: "sounds",
    label: "Agent question sound",
    description: "An urgent cue when an agent asks a question or needs your approval.",
    aliases: ["notifications", "alert", "audio", "approval", "attention"],
    appliesWhen: "immediately",
    value: sound("agentQuestion"),
    locate: { ariaLabel: "Agent question sound" },
  },
  {
    id: "sounds.pr-merged",
    section: "sounds",
    label: "Pull request merged sound",
    description: "A cue when a monitored pull request is merged.",
    aliases: ["notifications", "alert", "audio", "merge"],
    appliesWhen: "immediately",
    value: sound("prMerged"),
    locate: { ariaLabel: "Pull request merged sound" },
  },
  {
    id: "sounds.coordinator-report",
    section: "sounds",
    label: "Coordinator report sound",
    description: "A cue when a Coordinator is woken by a worker it was waiting on.",
    aliases: ["notifications", "alert", "audio", "worker"],
    appliesWhen: "immediately",
    value: sound("coordinatorReport"),
    locate: { ariaLabel: "Coordinator report sound" },
  },
  {
    id: "sounds.desktop-notifications",
    section: "sounds",
    label: "Desktop notifications for agent questions",
    description: "Show a system notification when an agent asks a question.",
    aliases: [
      "notifications",
      "alerts",
      "system notification",
      "os notification",
      "review notifications",
    ],
    appliesWhen: "immediately",
    value: sound("questionDesktopNotification"),
    locate: { ariaLabel: "Agent questions desktop notification" },
  },

  // --- Docker, container ------------------------------------------------------------------
  {
    id: "docker.containers",
    section: "docker",
    label: "Containers",
    description:
      "The Docker containers Orkestrator manages on this machine: stop, reattach or delete.",
    aliases: ["docker", "cleanup", "delete container", "images"],
    appliesWhen: "immediately",
    owner: "machine",
    locate: { heading: "Containers" },
  },
  {
    id: "container.resource-limits",
    section: "container",
    label: "Container resource limits",
    description: "CPU, memory and process limits for new container runtimes.",
    aliases: ["cpu", "memory", "ram", "pids", "resources", "budget"],
    appliesWhen: "new-environments",
    owner: "machine",
    locate: { heading: "Container" },
  },

  // --- Experimental --------------------------------------------------------------------------
  experimental("graphs", "experimentalGraphs", "Graphs", "Design and run agent graphs.", [
    "workflow",
    "graph designer",
  ]),
  experimental(
    "scheduling",
    "experimentalScheduling",
    "Scheduling",
    "Run prompts and graphs on a schedule.",
    ["cron", "schedules"],
  ),
  experimental(
    "self-improvement",
    "experimentalSelfImprovement",
    "Self-improvement",
    "Review past conversations and file improvement tickets.",
    ["retrospective"],
  ),
  experimental("tmux", "experimentalTmux", "Tmux mode", "Run terminal agents inside tmux.", [
    "tmux",
    "terminal multiplexer",
  ]),
  {
    id: "experimental.direct-transport",
    section: "experimental",
    label: "Direct transport for new windows",
    description: "Connect new windows straight to the backend instead of through the desktop.",
    aliases: ["transport", "gateway", "connection", "performance"],
    appliesWhen: "new-windows",
    value: stored("localWindowGatewayTransport", true, onOff),
    availability: {
      isAvailable: ({ isWindowMachine }) => isWindowMachine && isLocalDesktopWindow(),
      reason: "Only shown in the desktop app, for the machine this window runs on.",
    },
  },

  // --- Debug ----------------------------------------------------------------------------------
  {
    id: "debug.debug-button",
    section: "debug",
    label: "Debug button",
    description: "Show a button for capturing a bug report in this window.",
    aliases: ["bug report", "report issue", "feedback"],
    appliesWhen: "immediately",
    owner: "window",
  },
  {
    id: "debug.save-logs",
    section: "debug",
    label: "Save logs to disk",
    description: "Write application logs to disk for troubleshooting.",
    aliases: ["logging", "debug logs", "log files", "diagnostics", "verbose"],
    appliesWhen: "immediately",
    value: stored("debugLogging", false, onOff),
  },
  {
    id: "debug.log-retention",
    section: "debug",
    label: "Keep logs for",
    description: "How many days saved logs are kept.",
    aliases: ["log retention", "days", "cleanup logs"],
    appliesWhen: "immediately",
    value: binding(
      "debugLogRetentionDays",
      (global) => normalizeDebugLogRetentionDays(global.debugLogRetentionDays),
      count("days"),
    ),
  },
  {
    id: "debug.log-detail",
    section: "debug",
    label: "Log detail",
    description: "How much each area of Orkestrator logs.",
    aliases: ["log level", "verbose", "trace", "debug level"],
    appliesWhen: "immediately",
    value: binding(
      "logDetail",
      (global) => resolveLogDetail(global),
      () => "Per-area levels",
    ),
  },
  {
    id: "debug.renderer-logging",
    section: "debug",
    label: "Renderer debug logging",
    description: "Log this window's renderer in detail.",
    aliases: ["console", "renderer logs", "devtools"],
    appliesWhen: "immediately",
    owner: "window",
  },
];

const BY_ID = new Map(SETTINGS_CATALOG.map((descriptor) => [descriptor.id, descriptor]));

export function settingDescriptor(id: string): SettingDescriptor | undefined {
  return BY_ID.get(id);
}
