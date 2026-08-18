/** Every coding-agent system Orkestrator can provision and surface. */
export const AGENT_PLATFORMS = Object.freeze([
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
] as const);

export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

export const AGENT_PLATFORM_LABELS: Readonly<Record<AgentPlatform, string>> = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor Agent",
  grok: "Grok Build",
  opencode: "OpenCode",
});

/** Existing installations keep their pre-selection behavior after upgrading. */
export const LEGACY_ENABLED_AGENT_PLATFORMS: readonly AgentPlatform[] = Object.freeze([
  "claude",
  "codex",
  "opencode",
]);

export function isAgentPlatform(value: unknown): value is AgentPlatform {
  return AGENT_PLATFORMS.includes(value as AgentPlatform);
}

export function normalizeAgentPlatforms(
  value: unknown,
  fallback: readonly AgentPlatform[] = LEGACY_ENABLED_AGENT_PLATFORMS,
): AgentPlatform[] {
  if (!Array.isArray(value)) return [...fallback];
  const selected = new Set(value.filter(isAgentPlatform));
  return AGENT_PLATFORMS.filter((platform) => selected.has(platform));
}

export function firstEnabledAgentPlatform(
  enabled: readonly AgentPlatform[],
  preferred?: AgentPlatform,
): AgentPlatform {
  if (preferred && enabled.includes(preferred)) return preferred;
  return enabled[0] ?? "claude";
}
