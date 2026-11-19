/**
 * What each provider can honestly do with each component kind, and which
 * physical locations each provider reads
 * (docs/architecture/agent-capabilities-management.md, "Provider support").
 *
 * Support is reported per operation, and the answer depends on the provider
 * version, the bridge version and where the agent runs (host or container),
 * never one global boolean. The table here is the qualified baseline for the
 * pinned toolchain; `describeCapabilitySupport` narrows it with the runtime
 * context the backend observed.
 *
 * Levels:
 *
 * - `supported`: implemented and covered by a conformance test against the
 *   pinned binary or bridge.
 * - `unqualified`: Orkestrator can write the native files, but no test proves
 *   the pinned binary loads them. The result is reported as "installed; not
 *   runtime-verified" and never as ready.
 * - `unsupported`: no safe path exists; the reason says why.
 *
 * The location table mirrors `rootSpecsFor` in
 * `apps/backend/src/core/agent-skills.ts`: several providers read the same
 * directory (`~/.agents/skills`, Claude-compatible roots), so writing a skill
 * for one provider can make it visible to another. The planner below picks
 * the fewest locations covering the requested providers and names every
 * provider that also sees them, so the UI never promises isolation it cannot
 * enforce.
 *
 * Browser-safe.
 */
import { AGENT_PLATFORM_LABELS, AGENT_PLATFORMS, type AgentPlatform } from "./agent-platforms.js";
import type {
  CapabilityLiveSemantics,
  ComponentKind,
  CapabilityVerificationLevel,
} from "./capability-resources.js";

export const CAPABILITY_OPERATIONS = [
  "discover",
  "install",
  "update",
  "remove",
  "enable",
  "runtimeRefresh",
  "runtimeInventory",
  "isolate",
] as const;
export type CapabilityOperation = (typeof CAPABILITY_OPERATIONS)[number];

export type CapabilitySupportLevel = "supported" | "unqualified" | "unsupported";

export interface CapabilitySupportEntry {
  level: CapabilitySupportLevel;
  /** Why the level is not `supported`; always set otherwise. */
  reason?: string;
}

export type CapabilityKindSupport = Record<CapabilityOperation, CapabilitySupportEntry>;

export interface CapabilitySupportMatrix {
  provider: AgentPlatform;
  context: CapabilitySupportContext;
  kinds: Record<ComponentKind, CapabilityKindSupport>;
}

export interface CapabilitySupportContext {
  location: "host" | "container";
  providerVersion?: string;
  bridgeVersion?: string;
  /** False when the provider's CLI or bridge is not installed on the machine. */
  available?: boolean;
}

// --- Physical locations ----------------------------------------------------

/**
 * One directory (or configuration file) Orkestrator can write a component
 * into. Ids are opaque and stable; the backend maps each to a path under the
 * machine's own home, so no client ever names a host path.
 */
export interface CapabilityLocation {
  id: string;
  kind: ComponentKind;
  /** The provider whose own location this is. */
  owner: AgentPlatform | "shared";
  /** Every provider that discovers components written here. */
  readBy: readonly AgentPlatform[];
  /** Layout of one component: a directory (`<name>/SKILL.md`) or a file (`<name>.md`). */
  layout: "directory" | "file";
  /** Display only, home-relative. */
  label: string;
  /** Deprecated by its provider: chosen only when nothing else covers it. */
  deprecated?: boolean;
}

export const CAPABILITY_LOCATIONS: readonly CapabilityLocation[] = Object.freeze([
  // Skills. Order is preference among equally good covers.
  {
    id: "claude-user-skills",
    kind: "skill",
    owner: "claude",
    readBy: ["claude", "cursor", "grok", "opencode", "pi"],
    layout: "directory",
    label: "~/.claude/skills",
  },
  {
    id: "agents-shared-skills",
    kind: "skill",
    owner: "shared",
    readBy: ["codex", "cursor", "grok", "opencode", "pi"],
    layout: "directory",
    label: "~/.agents/skills",
  },
  {
    id: "cursor-user-skills",
    kind: "skill",
    owner: "cursor",
    readBy: ["cursor"],
    layout: "directory",
    label: "~/.cursor/skills",
  },
  {
    id: "grok-user-skills",
    kind: "skill",
    owner: "grok",
    readBy: ["grok"],
    layout: "directory",
    label: "~/.grok/skills",
  },
  {
    id: "pi-user-skills",
    kind: "skill",
    owner: "pi",
    readBy: ["pi"],
    layout: "directory",
    label: "~/.pi/agent/skills",
  },
  {
    id: "opencode-user-skills",
    kind: "skill",
    owner: "opencode",
    readBy: ["opencode"],
    layout: "directory",
    label: "~/.config/opencode/skills",
  },
  {
    id: "codex-user-skills",
    kind: "skill",
    owner: "codex",
    readBy: ["codex", "cursor"],
    layout: "directory",
    label: "$CODEX_HOME/skills",
    deprecated: true,
  },
  // Commands and prompts: one Markdown file per command.
  {
    id: "claude-user-commands",
    kind: "command",
    owner: "claude",
    readBy: ["claude"],
    layout: "file",
    label: "~/.claude/commands",
  },
  {
    id: "cursor-user-commands",
    kind: "command",
    owner: "cursor",
    readBy: ["cursor"],
    layout: "file",
    label: "~/.cursor/commands",
  },
  {
    id: "opencode-user-commands",
    kind: "command",
    owner: "opencode",
    readBy: ["opencode"],
    layout: "file",
    label: "~/.config/opencode/command",
  },
  {
    id: "codex-user-prompts",
    kind: "prompt",
    owner: "codex",
    readBy: ["codex"],
    layout: "file",
    label: "$CODEX_HOME/prompts",
  },
  {
    id: "pi-user-prompts",
    kind: "prompt",
    owner: "pi",
    readBy: ["pi"],
    layout: "file",
    label: "~/.pi/agent/prompts",
  },
  {
    id: "claude-user-agents",
    kind: "subagent",
    owner: "claude",
    readBy: ["claude"],
    layout: "file",
    label: "~/.claude/agents",
  },
  {
    id: "opencode-user-agents",
    kind: "subagent",
    owner: "opencode",
    readBy: ["opencode"],
    layout: "file",
    label: "~/.config/opencode/agent",
  },
]);

const LOCATIONS_BY_ID = new Map(CAPABILITY_LOCATIONS.map((location) => [location.id, location]));

export function capabilityLocation(id: string): CapabilityLocation | undefined {
  return LOCATIONS_BY_ID.get(id);
}

/**
 * Commands and prompts are one family: a provider without a command
 * directory takes a command as a prompt template where it has one.
 */
function locationKindsFor(kind: ComponentKind): ComponentKind[] {
  if (kind === "command" || kind === "prompt") return ["command", "prompt"];
  return [kind];
}

export interface CapabilityLocationPlan {
  locations: Array<{ id: string; providers: AgentPlatform[] }>;
  /** Requested providers no location reaches. */
  uncovered: AgentPlatform[];
  /** Providers that will also see the component although it was not requested for them. */
  alsoVisibleTo: AgentPlatform[];
  /** True only when no unrequested provider sees any chosen location. */
  isolated: boolean;
}

/**
 * The fewest locations that make a `kind` component visible to every
 * requested provider. Greedy set cover: first locations seen only by
 * requested providers (largest new coverage first, private and
 * non-deprecated preferred), then, only for providers left over, locations
 * that leak to others. Writing one physical copy per location also
 * deduplicates providers that share a directory.
 */
export function planCapabilityLocations(
  kind: ComponentKind,
  requested: readonly AgentPlatform[],
): CapabilityLocationPlan {
  const wanted = new Set(requested);
  const kinds = locationKindsFor(kind);
  const candidates = CAPABILITY_LOCATIONS.filter((location) => kinds.includes(location.kind));
  const covered = new Set<AgentPlatform>();
  const chosen: Array<{ id: string; providers: AgentPlatform[] }> = [];
  const leaks = new Set<AgentPlatform>();

  const pick = (allowLeak: boolean): boolean => {
    let best: CapabilityLocation | undefined;
    let bestGain = 0;
    for (const location of candidates) {
      if (chosen.some((entry) => entry.id === location.id)) continue;
      const leaking = location.readBy.some((provider) => !wanted.has(provider));
      if (leaking && !allowLeak) continue;
      const gain = location.readBy.filter(
        (provider) => wanted.has(provider) && !covered.has(provider),
      ).length;
      if (gain === 0) continue;
      const better =
        gain > bestGain ||
        (gain === bestGain && best !== undefined && rankLocation(location) < rankLocation(best));
      if (better) {
        best = location;
        bestGain = gain;
      }
    }
    if (!best) return false;
    const providers = best.readBy.filter((provider) => wanted.has(provider));
    chosen.push({ id: best.id, providers });
    for (const provider of providers) covered.add(provider);
    for (const provider of best.readBy) if (!wanted.has(provider)) leaks.add(provider);
    return true;
  };

  while ([...wanted].some((provider) => !covered.has(provider)) && pick(false)) {
    // keep picking leak-free locations
  }
  while ([...wanted].some((provider) => !covered.has(provider)) && pick(true)) {
    // only providers with no private location are left
  }
  const uncovered = AGENT_PLATFORMS.filter(
    (provider) => wanted.has(provider) && !covered.has(provider),
  );
  const alsoVisibleTo = AGENT_PLATFORMS.filter((provider) => leaks.has(provider));
  return { locations: chosen, uncovered, alsoVisibleTo, isolated: alsoVisibleTo.length === 0 };
}

function rankLocation(location: CapabilityLocation): number {
  return (location.deprecated ? 100 : 0) + (location.owner === "shared" ? 1 : 0);
}

/** Every provider that discovers a component written at `locationId`. */
export function providersReadingLocation(locationId: string): AgentPlatform[] {
  return [...(capabilityLocation(locationId)?.readBy ?? [])];
}

// --- The support table --------------------------------------------------------

const S: CapabilitySupportEntry = { level: "supported" };
const unq = (reason: string): CapabilitySupportEntry => ({ level: "unqualified", reason });
const no = (reason: string): CapabilitySupportEntry => ({ level: "unsupported", reason });

const SHARED_ROOT_ISOLATION = no(
  "Other providers read this provider's skill directory, and it has no per-skill disable switch, so exclusion cannot be enforced without an isolated home.",
);
const NO_LIVE_SKILL_INVENTORY = no(
  "The bridge reports no live skill inventory, so a loaded skill can only be seen when it is used.",
);
const NEXT_SESSION = no("Skills are read when a session starts; a running session keeps its set.");

function kindSupport(
  entries: Partial<CapabilityKindSupport>,
  fallback: string,
): CapabilityKindSupport {
  const result = {} as CapabilityKindSupport;
  for (const operation of [
    "discover",
    "install",
    "update",
    "remove",
    "enable",
    "runtimeRefresh",
    "runtimeInventory",
    "isolate",
  ] as const) {
    result[operation] = entries[operation] ?? no(fallback);
  }
  return result;
}

function skillSupport(
  isolate: CapabilitySupportEntry,
  inventory: CapabilitySupportEntry,
  enable: CapabilitySupportEntry,
): CapabilityKindSupport {
  return kindSupport(
    {
      discover: S,
      install: S,
      update: S,
      remove: S,
      enable,
      runtimeRefresh: NEXT_SESSION,
      runtimeInventory: inventory,
      isolate,
    },
    "Not applicable to skills.",
  );
}

function mcpSupport(provider: AgentPlatform): CapabilityKindSupport {
  return kindSupport(
    {
      discover: S,
      install: S,
      update: S,
      remove: S,
      enable:
        provider === "claude" || provider === "pi"
          ? no(
              "The provider has no persisted enable flag for MCP servers; remove the entry instead.",
            )
          : S,
      runtimeRefresh: S,
      runtimeInventory: S,
      isolate: no(
        "MCP servers are delivered per session by Orkestrator's MCP grants, not by a separate home.",
      ),
    },
    "Not applicable to MCP servers.",
  );
}

const FILE_COMMAND = (reason?: string): CapabilityKindSupport =>
  kindSupport(
    {
      discover: S,
      install: reason ? unq(reason) : S,
      update: reason ? unq(reason) : S,
      remove: reason ? unq(reason) : S,
      runtimeRefresh: NEXT_SESSION,
      runtimeInventory: S,
      isolate: S,
    },
    "Commands have no separate enable switch; remove the file to disable it.",
  );

const NO_COMMAND_DIR = (provider: string): CapabilityKindSupport =>
  kindSupport(
    { discover: unq(`${provider} commands are discovered only from a running session.`) },
    `${provider} has no command or prompt directory Orkestrator has qualified on the pinned version.`,
  );

const STANDALONE_HOOK = kindSupport(
  {
    discover: S,
  },
  "Standalone hooks run programs outside the session's permission policy. Orkestrator installs hooks only inside a native plugin, through the provider's own plugin lifecycle, after approval.",
);

const NO_HOOKS = (provider: string): CapabilityKindSupport =>
  kindSupport({}, `${provider} has no hook mechanism Orkestrator's bridge loads.`);

const NO_SUBAGENTS = (provider: string): CapabilityKindSupport =>
  kindSupport({}, `${provider} has no subagent definition directory Orkestrator has qualified.`);

/**
 * The qualified baseline. Narrowed by `describeCapabilitySupport` for the
 * observed context. Changing a level to `supported` requires a conformance
 * test (docs/architecture/agent-capabilities-management.md, "Qualification").
 */
export const BASELINE_CAPABILITY_SUPPORT: Readonly<
  Record<AgentPlatform, Record<ComponentKind, CapabilityKindSupport>>
> = Object.freeze({
  claude: {
    skill: skillSupport(
      SHARED_ROOT_ISOLATION,
      S,
      no("Claude has no per-skill enable switch outside plugins; remove the skill to disable it."),
    ),
    // Qualified against the pinned binary by provider-conformance.live.test.ts:
    // the approved artifact is served from Orkestrator's own marketplace and
    // every write is verified by reading `claude plugin list --json` back.
    "native-plugin": kindSupport(
      {
        discover: S,
        install: S,
        update: S,
        remove: S,
        enable: no(
          "Orkestrator enables a plugin when it installs it; to switch one off, remove it from the setup.",
        ),
        runtimeRefresh: no("A plugin change reaches Claude at the next session."),
        runtimeInventory: S,
        isolate: no(
          "Plugins are installed at Claude's user scope, so every Claude session on the machine loads them.",
        ),
      },
      "Not applicable to Claude plugins.",
    ),
    "mcp-server": mcpSupport("claude"),
    command: FILE_COMMAND(),
    prompt: FILE_COMMAND(),
    hook: STANDALONE_HOOK,
    subagent: FILE_COMMAND(),
  },
  codex: {
    skill: skillSupport(
      no(
        "Codex reads ~/.agents/skills, which Cursor, Grok, OpenCode and Pi also read; exclusion needs an isolated CODEX_HOME.",
      ),
      S,
      no("Per-skill enablement is not exposed by the pinned Codex app-server."),
    ),
    "native-plugin": kindSupport(
      {
        discover: S,
        runtimeInventory: S,
      },
      "Codex plugins are installed and enabled through Codex itself; the pinned app-server has no plugin install method.",
    ),
    "mcp-server": mcpSupport("codex"),
    command: kindSupport(
      { discover: S },
      "Codex takes reusable prompts as prompt templates; the command is installed as a prompt.",
    ),
    prompt: FILE_COMMAND(
      "Codex custom prompts are deprecated in favour of skills; the pinned binary is not tested to load them.",
    ),
    hook: NO_HOOKS("Codex"),
    subagent: NO_SUBAGENTS("Codex"),
  },
  cursor: {
    skill: skillSupport(
      no("Cursor reads Claude, Codex and shared skill directories as well as its own."),
      NO_LIVE_SKILL_INVENTORY,
      no("Cursor has no per-skill enable switch."),
    ),
    "native-plugin": kindSupport(
      { discover: unq("The Cursor SDK reports no plugin inventory.") },
      "The bundled Cursor SDK has no plugin API.",
    ),
    "mcp-server": mcpSupport("cursor"),
    command: FILE_COMMAND(
      "The bundled Cursor SDK is not tested to load ~/.cursor/commands on the pinned version.",
    ),
    prompt: kindSupport({ discover: S }, "Cursor takes reusable prompts as commands."),
    hook: NO_HOOKS("The Cursor SDK"),
    subagent: NO_SUBAGENTS("Cursor"),
  },
  grok: {
    skill: skillSupport(
      no("Grok reads shared and Claude-compatible skill directories as well as its own."),
      NO_LIVE_SKILL_INVENTORY,
      no("Grok has no per-skill enable switch."),
    ),
    "native-plugin": kindSupport(
      { discover: S },
      "Grok Build plugins are managed by Grok; plugin changes need a Grok restart Orkestrator does not trigger.",
    ),
    "mcp-server": mcpSupport("grok"),
    command: NO_COMMAND_DIR("Grok Build"),
    prompt: NO_COMMAND_DIR("Grok Build"),
    hook: NO_HOOKS("Grok Build"),
    subagent: NO_SUBAGENTS("Grok Build"),
  },
  opencode: {
    skill: skillSupport(
      no("OpenCode reads Claude-compatible and shared skill directories as well as its own."),
      NO_LIVE_SKILL_INVENTORY,
      no("OpenCode has no per-skill enable switch."),
    ),
    "native-plugin": kindSupport(
      { discover: S },
      "Orkestrator's OpenCode 2 configuration mirror strips user plugins, so a plugin never loads in an Orkestrator session.",
    ),
    "mcp-server": mcpSupport("opencode"),
    command: FILE_COMMAND(
      "OpenCode 2's command directory is not covered by a conformance test on the pinned version.",
    ),
    prompt: kindSupport({ discover: S }, "OpenCode takes reusable prompts as commands."),
    hook: NO_HOOKS("OpenCode"),
    subagent: FILE_COMMAND(
      "OpenCode 2's agent directory is not covered by a conformance test on the pinned version.",
    ),
  },
  pi: {
    skill: skillSupport(
      no("Pi reads shared and Claude-compatible skill directories as well as its own."),
      NO_LIVE_SKILL_INVENTORY,
      no("Pi has no per-skill enable switch."),
    ),
    "native-plugin": kindSupport(
      { discover: S },
      "The Pi bridge excludes discovered extensions and configured packages: they would run inside the bridge process, where they could answer another session's approvals.",
    ),
    "mcp-server": mcpSupport("pi"),
    command: kindSupport({ discover: S }, "Pi takes reusable prompts as prompt templates."),
    prompt: FILE_COMMAND(),
    hook: NO_HOOKS("Pi"),
    subagent: NO_SUBAGENTS("Pi"),
  },
});

/**
 * The support matrix for one provider in one observed context. A provider
 * that is not installed supports discovery of nothing it would have to run;
 * a container run delivers files through the portable inputs, so a plugin
 * lifecycle that needs the provider's CLI on the host is unsupported there.
 */
export function describeCapabilitySupport(
  provider: AgentPlatform,
  context: CapabilitySupportContext,
): CapabilitySupportMatrix {
  const baseline = BASELINE_CAPABILITY_SUPPORT[provider];
  const kinds = {} as Record<ComponentKind, CapabilityKindSupport>;
  for (const [kind, support] of Object.entries(baseline) as Array<
    [ComponentKind, CapabilityKindSupport]
  >) {
    const copy = { ...support };
    if (context.available === false) {
      for (const operation of Object.keys(copy) as CapabilityOperation[]) {
        if (copy[operation].level === "unsupported") continue;
        if (operation === "discover") continue;
        copy[operation] = {
          level: "unsupported",
          reason: `${AGENT_PLATFORM_LABELS[provider]} is not installed on this machine.`,
        };
      }
    }
    if (context.location === "container" && kind === "native-plugin") {
      for (const operation of ["install", "update", "remove", "enable"] as const) {
        if (copy[operation].level !== "unsupported") {
          copy[operation] = {
            level: "unsupported",
            reason:
              "Native plugins are installed by the provider's CLI on the host; a container receives them only through a rebuild of its portable inputs.",
          };
        }
      }
    }
    kinds[kind] = copy;
  }
  return { provider, context, kinds };
}

export function capabilitySupportFor(
  matrix: CapabilitySupportMatrix,
  kind: ComponentKind,
  operation: CapabilityOperation,
): CapabilitySupportEntry {
  return matrix.kinds[kind][operation];
}

/**
 * The highest verification level an adapter can ever report for a kind. An
 * adapter with no live inventory stops at `present`/`enabled`; the badge for
 * that is "installed; not runtime-verified".
 */
export function maxVerificationLevel(
  matrix: CapabilitySupportMatrix,
  kind: ComponentKind,
): CapabilityVerificationLevel {
  return matrix.kinds[kind].runtimeInventory.level === "supported" ? "advertised" : "present";
}

/**
 * What changing a component means for a session that is already running.
 * Never a silent restart, and a newly executable hook never switches on
 * while the agent is processing a task.
 */
export function capabilityLiveSemantics(input: {
  matrix: CapabilitySupportMatrix;
  kind: ComponentKind;
  sessionRunning: boolean;
  exclusive: boolean;
  blocked: boolean;
}): CapabilityLiveSemantics {
  if (input.blocked) return "blocked-by-policy";
  const support = input.matrix.kinds[input.kind];
  if (input.exclusive && support.isolate.level !== "supported") {
    return "cannot-enforce-without-isolated-home";
  }
  if (input.kind === "hook" || input.kind === "native-plugin" || input.kind === "subagent") {
    return "new-session-required";
  }
  if (input.kind === "mcp-server") {
    return input.sessionRunning ? "queued-until-idle" : "available-next-turn";
  }
  if (support.runtimeRefresh.level === "supported") return "reload-supported";
  return "new-session-required";
}

/** The baseline matrices for every provider, host context. */
export function baselineCapabilitySupport(): CapabilitySupportMatrix[] {
  return AGENT_PLATFORMS.map((provider) =>
    describeCapabilitySupport(provider, { location: "host" }),
  );
}
