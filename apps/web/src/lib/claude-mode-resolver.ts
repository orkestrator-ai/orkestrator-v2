// Three-tier resolution for Claude mode + native backend.
// Priority order, highest first:
//   environment override → repository override → global default
//
// Used by tab creation, settings displays, and any code that needs the
// effective Claude configuration for an environment.

import type {
  ClaudeMode,
  ClaudeNativeBackend,
  Environment,
  GlobalConfig,
  RepositoryConfig,
} from "@/types";

export interface ResolvedClaudeConfig {
  /** Effective mode after applying overrides. */
  mode: ClaudeMode;
  /**
   * Effective native backend. Always defined, but only *meaningful* when
   * `mode === "native"`.
   */
  nativeBackend: ClaudeNativeBackend;
}

/**
 * Resolve Claude mode + native backend for a given environment.
 *
 * `environment` and `repositoryConfig` may be `undefined` (e.g. before the
 * environment loads, or for repos with no per-project config); in that case
 * we fall back through to the global level.
 */
export function resolveClaudeConfig(
  global: GlobalConfig,
  repositoryConfig: RepositoryConfig | undefined,
  environment: Pick<Environment, "claudeMode" | "claudeNativeBackend"> | undefined,
): ResolvedClaudeConfig {
  const mode: ClaudeMode =
    environment?.claudeMode ??
    repositoryConfig?.agentStyle ??
    global.claudeMode ??
    "terminal";
  const nativeBackend: ClaudeNativeBackend =
    environment?.claudeNativeBackend ??
    repositoryConfig?.claudeNativeBackend ??
    global.claudeNativeBackend ??
    "sdk";
  return { mode, nativeBackend };
}
