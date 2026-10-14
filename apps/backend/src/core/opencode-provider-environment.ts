/**
 * Derives the environment-scoped dependencies an `OpenCodeProvider` needs from
 * the platform-neutral environment the shared native-agent service describes,
 * so that service never assembles OpenCode's journals or settings itself.
 */
import type { NativeAgentProviderEnvironment } from "./native-agent-provider.js";
import { openCodeCommandChangeJournalDirectory } from "./opencode-command-changes.js";
import type { OpenCodeProviderDependencies } from "./opencode-provider-helpers.js";

export type OpenCodeEnvironmentDependencies = Pick<
  OpenCodeProviderDependencies,
  "commandChanges" | "resolveOpenCodeModelProviders"
>;

export function openCodeEnvironmentDependencies(
  environment: NativeAgentProviderEnvironment | undefined,
): OpenCodeEnvironmentDependencies {
  if (!environment) return {};
  const dependencies: OpenCodeEnvironmentDependencies = {};
  // Shell-change badges, journaled under the backend data directory per
  // environment so environment deletion can drop them. The provider itself
  // decides whether its worktree is measurable (local worktrees only).
  if (environment.dataDir !== undefined) {
    dependencies.commandChanges = {
      journalDirectory: openCodeCommandChangeJournalDirectory(
        environment.dataDir,
        environment.environmentId,
      ),
    };
  }
  const loadConfig = environment.loadConfig;
  if (loadConfig) {
    // Model-picker provider allowlist. The persisted global key keeps its
    // OpenCode name: it is on-disk configuration.
    dependencies.resolveOpenCodeModelProviders = async () =>
      (await loadConfig()).global.openCodeModelProviders;
  }
  return dependencies;
}
