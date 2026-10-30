import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

/**
 * Resume-critical provider state preserved on an environment's persistent
 * `state` volume. Each entry is mounted by sub-path at exactly one path, so a
 * provider home's credentials, configuration, caches and host binaries stay in
 * the container layer and are never part of the preserved set.
 *
 * Traced against the versions in `PROVIDER_STATE_TRACED_VERSIONS`; the
 * inventory of what each provider preserves and excludes is in
 * docs/architecture/container-lifecycle.md ("Provider state").
 * The bridge's own state is preserved with each provider's transcripts: for
 * Codex, Cursor, Grok and Pi the host's provider session id cannot be resolved
 * without it.
 */
export interface ProviderStateEntry {
  provider: AgentPlatform;
  /** Sub-directory of the state volume. */
  subdir: string;
  /** Absolute mount point inside the container. */
  containerPath: string;
  /** What the path holds; recorded for review, never used as a path. */
  holds: string;
  /** Whether a SQLite database lives here (writers must stop before a copy). */
  sqlite: boolean;
}

/**
 * The provider versions whose on-disk state this layout was last traced
 * against: the CLI for every provider but Cursor, whose state is written by
 * `@cursor/sdk` in the bridge. A test fails when a pin moves away from these,
 * so an upgrade cannot land until the paths below are re-traced
 * (docs/development/upgrade-agents.md, "Re-trace preserved provider state").
 */
export const PROVIDER_STATE_TRACED_VERSIONS: Record<AgentPlatform, string> = {
  claude: "2.1.314",
  codex: "0.164.0",
  opencode: "1.19.5",
  pi: "1.4.0",
  cursor: "1.2.0",
  grok: "1.0.67",
};

/** Codex runtime databases on persistent storage (`CODEX_SQLITE_HOME`). */
export const CODEX_SQLITE_HOME = "/home/node/.codex/orkestrator-sqlite";
/** OpenCode's session database directory on persistent storage. */
export const OPENCODE_DB_DIRECTORY = "/home/node/.local/share/opencode/orkestrator-db";
export const OPENCODE_DB_PATH = `${OPENCODE_DB_DIRECTORY}/opencode.db`;

export const PROVIDER_STATE_LAYOUT: readonly ProviderStateEntry[] = [
  {
    provider: "claude",
    subdir: "claude/projects",
    containerPath: "/home/node/.claude/projects",
    holds: "Claude Agent SDK session transcripts",
    sqlite: false,
  },
  {
    provider: "claude",
    subdir: "claude/file-history",
    containerPath: "/home/node/.claude/file-history",
    holds: "Claude rewind checkpoints",
    sqlite: false,
  },
  {
    provider: "claude",
    subdir: "claude/orkestrator",
    containerPath: "/home/node/.claude/orkestrator",
    holds: "Claude bridge dispatch/steer journals and session preferences",
    sqlite: false,
  },
  {
    provider: "codex",
    subdir: "codex/sessions",
    containerPath: "/home/node/.codex/sessions",
    holds: "Codex rollouts (including fork lineage)",
    sqlite: false,
  },
  {
    provider: "codex",
    subdir: "codex/archived_sessions",
    containerPath: "/home/node/.codex/archived_sessions",
    holds: "Archived Codex rollouts",
    sqlite: false,
  },
  {
    provider: "codex",
    subdir: "codex/orkestrator-bridge",
    containerPath: "/home/node/.codex/orkestrator-bridge",
    holds: "Codex bridge session registry, title index and dispatch journal",
    sqlite: false,
  },
  {
    provider: "codex",
    subdir: "codex/sqlite",
    containerPath: CODEX_SQLITE_HOME,
    holds: "Codex runtime databases (relocated with CODEX_SQLITE_HOME)",
    sqlite: true,
  },
  {
    provider: "opencode",
    subdir: "opencode/db",
    containerPath: OPENCODE_DB_DIRECTORY,
    holds: "OpenCode session database (relocated with OPENCODE_DB)",
    sqlite: true,
  },
  {
    provider: "pi",
    subdir: "pi/sessions",
    containerPath: "/home/node/.pi/agent/sessions",
    holds: "Pi session files",
    sqlite: false,
  },
  {
    provider: "pi",
    subdir: "pi/bridge-state",
    containerPath: "/tmp/orkestrator-pi-state",
    holds: "Pi bridge prompt/steer journal and session pointer",
    sqlite: false,
  },
  {
    provider: "cursor",
    subdir: "cursor/bridge-state",
    containerPath: "/tmp/orkestrator-cursor-sdk-state",
    holds: "Cursor SDK agent store and bridge journals",
    sqlite: false,
  },
  {
    provider: "grok",
    subdir: "grok/sessions",
    containerPath: "/home/node/.grok/sessions",
    holds: "Grok session histories and search index",
    sqlite: true,
  },
  {
    provider: "grok",
    subdir: "grok/bridge-state",
    containerPath: "/tmp/orkestrator-acp-state",
    holds: "ACP bridge session map and interjection journal",
    sqlite: false,
  },
];

/**
 * Shell fragment that relocates a provider's SQLite store only when its
 * persistent mount is present. A legacy runtime keeps its databases where they
 * already are; moving them there would hide the user's existing sessions.
 */
export function persistentStateExports(provider: "codex" | "opencode"): string {
  return provider === "codex"
    ? `if mountpoint -q ${CODEX_SQLITE_HOME} 2>/dev/null; then export CODEX_SQLITE_HOME=${CODEX_SQLITE_HOME}; fi`
    : `if mountpoint -q ${OPENCODE_DB_DIRECTORY} 2>/dev/null; then export OPENCODE_DB=${OPENCODE_DB_PATH}; fi`;
}

export type PreservationLevel = "full" | "partial";

/**
 * What survives a runtime rebuild on persistent storage, per provider. This is
 * what the product may claim; nothing is advertised as preserved beyond it.
 */
export const PROVIDER_PRESERVATION: Record<
  AgentPlatform,
  { level: PreservationLevel; limitations: string | null }
> = {
  claude: { level: "full", limitations: null },
  codex: {
    level: "partial",
    limitations:
      "Rollouts, archived rollouts, the runtime databases and the bridge session map and title index are preserved, and a conversation continues from them after a rebuild. Codex's own thread-name index at its home root is not, so a name set inside the Codex CLI rather than in Orkestrator is lost.",
  },
  opencode: {
    level: "partial",
    limitations:
      "The session database is preserved. Revert/diff snapshots and full copies of truncated tool output are not, so earlier turns cannot be reverted after a rebuild.",
  },
  pi: { level: "full", limitations: null },
  cursor: { level: "full", limitations: null },
  grok: {
    level: "partial",
    limitations:
      "Session histories, the search index and the bridge session map are preserved. Grok's own worktree registry (worktrees.db) and opt-in memory-v2 directory are not preserved; provider resume after a rebuild is pending qualification.",
  },
};

export function providerStatePreserved(provider: AgentPlatform): boolean {
  return PROVIDER_STATE_LAYOUT.some((entry) => entry.provider === provider);
}
