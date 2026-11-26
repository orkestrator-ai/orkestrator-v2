import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import type { CoordinatorUpstreamMergeCheck } from "@orkestrator/protocol/coordinator-upstream-merge";
import { backendForScope } from "@/lib/backend/scope-backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import { clearLegacyPersistedState } from "@/lib/legacy-local-state";

/**
 * The key earlier releases kept "don't merge" answers under (per machine).
 * Nothing asks any more, so the copy is only deleted.
 */
export const LEGACY_UPSTREAM_DECLINE_KEY = "coordinator-upstream-declines";

let legacyCleared = false;

export interface UpstreamCheckOptions {
  /** Receives the refreshed checkout status as soon as it is known. */
  onStatus?: (status: ProjectGitStatus) => void;
  /** The project's node (plan item 4007); the app's command scope when omitted. */
  scope?: NodeScope;
}

/**
 * Whether to fast-forward the checkout before a message to the main
 * coordinator. The backend decides (running turns, a cooldown-bound fetch,
 * fast-forward blockers). Any offer is merged without asking.
 */
export async function checkUpstreamMergeOffer(
  projectId: string,
  options: UpstreamCheckOptions,
): Promise<CoordinatorUpstreamMergeCheck | null> {
  if (!legacyCleared) {
    legacyCleared = true;
    clearLegacyPersistedState(LEGACY_UPSTREAM_DECLINE_KEY);
  }
  const scope = options.scope ?? appCommandScope();
  const node = backendForScope(scope);
  const check = await node.checkCoordinatorUpstreamMerge(projectId);
  if (check?.status) options.onStatus?.(check.status);
  return check;
}

export function resetUpstreamCheckForTests(): void {
  legacyCleared = false;
}
