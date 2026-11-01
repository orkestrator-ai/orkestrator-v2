/**
 * Derives the environment-scoped dependencies an `OpenCodeProvider` needs from
 * the platform-neutral environment the shared native-agent service describes,
 * so that service never assembles OpenCode's journals or settings itself.
 */
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import type { NativeAgentProviderEnvironment } from "./native-agent-provider.js";
import { openCodeCommandChangeJournalDirectory } from "./opencode-command-changes.js";
import type { OpenCodeProviderDependencies } from "./opencode-provider-helpers.js";

export type OpenCodeEnvironmentDependencies = Pick<
  OpenCodeProviderDependencies,
  | "commandChanges"
  | "coordinatorResearchToolIds"
  | "ensureCoordinatorResearch"
  | "invalidateCoordinatorResearch"
  | "resolveOpenCodeModelProviders"
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
  // A coordinator's research tool ids, recorded in its backend when its launch
  // registered them, keyed like the launcher's agent-tools configuration.
  const research = environment.openCodeCoordinatorResearch;
  if (research && coordinatorIdFromRuntimeId(environment.environmentId)) {
    const serverKey = `local:${environment.environmentId}`;
    dependencies.ensureCoordinatorResearch = () => research.ensure(serverKey).then(() => undefined);
    dependencies.invalidateCoordinatorResearch = () => research.invalidate(serverKey);
    dependencies.coordinatorResearchToolIds = () => research.toolIds(serverKey);
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
