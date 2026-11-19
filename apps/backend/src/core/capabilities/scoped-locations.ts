/**
 * Where a scoped copy goes (docs/architecture/agent-capabilities-management.md,
 * "Shared locations and isolation"): the project directories inside one local
 * worktree, and the staged portable-input directories of one container.
 *
 * Machine-wide copies use the protocol's `CAPABILITY_LOCATIONS`. A project's
 * own toolkits must not land there (every session of every project would see
 * them), so they go into the directories each provider reads from the
 * checkout it runs in. `readBy` lists the providers whose project discovery
 * is documented for that directory and is the only thing coverage counts;
 * `mayAlsoRead` lists providers that read the user-level equivalent and may
 * also pick up the project copy, so `alsoVisibleTo` errs towards saying more.
 *
 * Sources: OpenCode (skills docs: `.opencode/skills`, `.claude/skills`,
 * `.agents/skills`, walking up to the worktree root), Pi (skills docs:
 * `.pi/skills`, `.agents/skills`; `.pi/prompts`; all behind project trust,
 * and the Pi bridge adds `.claude/skills` for a coordinator), Codex
 * (`.agents/skills` from the working directory up to the repository root;
 * Codex has no project prompts), Claude Code (`.claude/skills`,
 * `.claude/commands`, `.claude/agents`), Cursor (`.cursor/skills`,
 * `.cursor/commands`) and Grok (`.grok/skills`, read once the folder is
 * trusted; see `acp-provider-config.ts`).
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { ComponentKind } from "@orkestrator/protocol/capability-resources";
import {
  CAPABILITY_LOCATIONS,
  type CapabilityLocation,
} from "@orkestrator/protocol/capability-resources-support";

/** A location relative to a root this module does not know (a worktree, a staged revision). */
export interface ScopedLocation extends CapabilityLocation {
  /** Directory under the root, `/`-separated. */
  relative: string;
  /** Providers that may also discover a copy here, beyond `readBy`. */
  mayAlsoRead?: readonly AgentPlatform[];
}

export const PROJECT_CAPABILITY_LOCATIONS: readonly ScopedLocation[] = Object.freeze([
  {
    id: "project-claude-skills",
    kind: "skill",
    owner: "claude",
    readBy: ["claude", "opencode"],
    mayAlsoRead: ["cursor", "grok", "pi"],
    layout: "directory",
    label: ".claude/skills",
    relative: ".claude/skills",
  },
  {
    id: "project-agents-skills",
    kind: "skill",
    owner: "shared",
    readBy: ["codex", "opencode", "pi"],
    mayAlsoRead: ["cursor", "grok"],
    layout: "directory",
    label: ".agents/skills",
    relative: ".agents/skills",
  },
  {
    id: "project-cursor-skills",
    kind: "skill",
    owner: "cursor",
    readBy: ["cursor"],
    layout: "directory",
    label: ".cursor/skills",
    relative: ".cursor/skills",
  },
  {
    id: "project-grok-skills",
    kind: "skill",
    owner: "grok",
    readBy: ["grok"],
    layout: "directory",
    label: ".grok/skills",
    relative: ".grok/skills",
  },
  {
    id: "project-pi-skills",
    kind: "skill",
    owner: "pi",
    readBy: ["pi"],
    layout: "directory",
    label: ".pi/skills",
    relative: ".pi/skills",
  },
  {
    id: "project-opencode-skills",
    kind: "skill",
    owner: "opencode",
    readBy: ["opencode"],
    layout: "directory",
    label: ".opencode/skills",
    relative: ".opencode/skills",
  },
  {
    id: "project-claude-commands",
    kind: "command",
    owner: "claude",
    readBy: ["claude"],
    layout: "file",
    label: ".claude/commands",
    relative: ".claude/commands",
  },
  {
    id: "project-cursor-commands",
    kind: "command",
    owner: "cursor",
    readBy: ["cursor"],
    layout: "file",
    label: ".cursor/commands",
    relative: ".cursor/commands",
  },
  {
    id: "project-opencode-commands",
    kind: "command",
    owner: "opencode",
    readBy: ["opencode"],
    layout: "file",
    label: ".opencode/command",
    relative: ".opencode/command",
  },
  {
    id: "project-pi-prompts",
    kind: "prompt",
    owner: "pi",
    readBy: ["pi"],
    layout: "file",
    label: ".pi/prompts",
    relative: ".pi/prompts",
  },
  {
    id: "project-claude-agents",
    kind: "subagent",
    owner: "claude",
    readBy: ["claude"],
    layout: "file",
    label: ".claude/agents",
    relative: ".claude/agents",
  },
  {
    id: "project-opencode-agents",
    kind: "subagent",
    owner: "opencode",
    readBy: ["opencode"],
    layout: "file",
    label: ".opencode/agent",
    relative: ".opencode/agent",
  },
]);

/**
 * The staged portable-input directory a container's entrypoint copies into
 * each user location (`docker/entrypoint.sh`: `copy_agent_directory_entries`
 * for Claude's commands/skills/agents, Codex's skills and prompts, Grok's
 * skills, Pi's skills and prompts, OpenCode's whole config directory, and
 * the shared `/agents-skills`). Cursor's skills and commands are not staged
 * (only its `mcp.json` is), so a container cannot take them.
 */
const CONTAINER_STAGE_PATHS: Readonly<Record<string, { stage: string; relative: string }>> = {
  "claude-user-skills": { stage: "claude", relative: "claude-config/skills" },
  "claude-user-commands": { stage: "claude", relative: "claude-config/commands" },
  "claude-user-agents": { stage: "claude", relative: "claude-config/agents" },
  "agents-shared-skills": { stage: "agents-skills", relative: "agents-skills" },
  "codex-user-skills": { stage: "codex", relative: "codex-home/skills" },
  "codex-user-prompts": { stage: "codex", relative: "codex-home/prompts" },
  "grok-user-skills": { stage: "grok", relative: "grok-home/skills" },
  "pi-user-skills": { stage: "pi", relative: "pi-config/agent/skills" },
  "pi-user-prompts": { stage: "pi", relative: "pi-config/agent/prompts" },
  "opencode-user-skills": { stage: "opencode", relative: "opencode-config/skills" },
  "opencode-user-commands": { stage: "opencode", relative: "opencode-config/command" },
  "opencode-user-agents": { stage: "opencode", relative: "opencode-config/agent" },
};

/**
 * The user locations a container can receive, given which portable inputs
 * are staged for it (`"claude"`, `"codex"`, ..., and `"agents-skills"` when
 * the image copies the shared skills root).
 */
export function containerCapabilityLocations(staged: ReadonlySet<string>): ScopedLocation[] {
  return CAPABILITY_LOCATIONS.flatMap((location) => {
    const stage = CONTAINER_STAGE_PATHS[location.id];
    if (!stage || !staged.has(stage.stage)) return [];
    return [{ ...location, relative: stage.relative }];
  });
}

/**
 * The project MCP file each provider reads from a worktree, as MCP
 * management models it (`mcp-management/providers.ts`): the source id it
 * gives that file, which delivery requires, so a server is written only
 * through MCP management's own editor for exactly that file. `alsoVisibleTo`
 * names providers that also read the file (Grok reads Claude's `.mcp.json`
 * unless its Claude import prompt was dismissed).
 */
export interface ProjectMcpLocation {
  id: string;
  provider: AgentPlatform;
  /** The file under the worktree, `/`-separated. */
  relative: string;
  /** MCP management's source id for that file in an environment target. */
  sourceId: string;
  format: "json" | "toml";
  /** The key holding the server map. */
  serverKey: string;
  alsoVisibleTo: readonly AgentPlatform[];
}

export const PROJECT_MCP_LOCATIONS: readonly ProjectMcpLocation[] = Object.freeze([
  {
    id: "project-mcp-claude",
    provider: "claude",
    relative: ".mcp.json",
    sourceId: "claude:project",
    format: "json",
    serverKey: "mcpServers",
    alsoVisibleTo: ["grok"],
  },
  {
    id: "project-mcp-codex",
    provider: "codex",
    relative: ".codex/config.toml",
    sourceId: "codex:project",
    format: "toml",
    serverKey: "mcp_servers",
    alsoVisibleTo: [],
  },
  {
    id: "project-mcp-cursor",
    provider: "cursor",
    relative: ".cursor/mcp.json",
    sourceId: "cursor:project",
    format: "json",
    serverKey: "mcpServers",
    alsoVisibleTo: ["grok"],
  },
  {
    id: "project-mcp-grok",
    provider: "grok",
    relative: ".grok/config.toml",
    sourceId: "grok:project",
    format: "toml",
    serverKey: "mcp_servers",
    alsoVisibleTo: [],
  },
  {
    id: "project-mcp-opencode",
    provider: "opencode",
    relative: "opencode.json",
    sourceId: "opencode:project-opencode.json",
    format: "json",
    serverKey: "mcp",
    alsoVisibleTo: [],
  },
  {
    id: "project-mcp-pi",
    provider: "pi",
    relative: ".pi/mcp.json",
    sourceId: "pi:project",
    format: "json",
    serverKey: "mcpServers",
    alsoVisibleTo: [],
  },
]);

export function projectMcpLocation(id: string): ProjectMcpLocation | undefined {
  return PROJECT_MCP_LOCATIONS.find((location) => location.id === id);
}

export function projectMcpLocationFor(provider: AgentPlatform): ProjectMcpLocation | undefined {
  return PROJECT_MCP_LOCATIONS.find((location) => location.provider === provider);
}

export function projectCapabilityLocation(id: string): ScopedLocation | undefined {
  return PROJECT_CAPABILITY_LOCATIONS.find((location) => location.id === id);
}

function kindsFor(kind: ComponentKind): ComponentKind[] {
  return kind === "command" || kind === "prompt" ? ["command", "prompt"] : [kind];
}

export interface ScopedLocationPlan {
  locations: Array<{ location: ScopedLocation; providers: AgentPlatform[] }>;
  uncovered: AgentPlatform[];
}

/**
 * The fewest locations of `table` covering `requested`, preferring locations
 * no unrequested provider reads, then the widest. The same greedy cover as
 * `planCapabilityLocations`, over a scoped table.
 */
export function planScopedLocations(
  table: readonly ScopedLocation[],
  kind: ComponentKind,
  requested: readonly AgentPlatform[],
): ScopedLocationPlan {
  const wanted = new Set(requested);
  const candidates = table.filter((location) => kindsFor(kind).includes(location.kind));
  const covered = new Set<AgentPlatform>();
  const chosen: ScopedLocationPlan["locations"] = [];
  const pick = (allowLeak: boolean): boolean => {
    let best: ScopedLocation | undefined;
    let bestGain = 0;
    for (const location of candidates) {
      if (chosen.some((entry) => entry.location.id === location.id)) continue;
      const visible = [...location.readBy, ...(location.mayAlsoRead ?? [])];
      if (!allowLeak && visible.some((provider) => !wanted.has(provider))) continue;
      const gain = location.readBy.filter(
        (provider) => wanted.has(provider) && !covered.has(provider),
      ).length;
      const better =
        gain > bestGain ||
        (gain > 0 && gain === bestGain && best?.deprecated === true && !location.deprecated);
      if (better) {
        best = location;
        bestGain = gain;
      }
    }
    if (!best) return false;
    const providers = best.readBy.filter(
      (provider) => wanted.has(provider) && !covered.has(provider),
    );
    for (const provider of providers) covered.add(provider);
    chosen.push({ location: best, providers });
    return true;
  };
  while (pick(false));
  while ([...wanted].some((provider) => !covered.has(provider)) && pick(true));
  return {
    locations: chosen,
    uncovered: requested.filter((provider) => !covered.has(provider)),
  };
}

/** Every provider that sees a copy at `location` besides the requested ones. */
export function alsoVisibleAt(
  location: ScopedLocation,
  requested: readonly AgentPlatform[],
): AgentPlatform[] {
  const visible = new Set([...location.readBy, ...(location.mayAlsoRead ?? [])]);
  return [...visible].filter((provider) => !requested.includes(provider)).sort();
}
