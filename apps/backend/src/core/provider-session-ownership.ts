import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  isMultiReviewWorkflow,
  multiReviewOwnsProviderSession,
} from "@orkestrator/protocol/multi-review";
import type { StorageService } from "./storage.js";

/**
 * The rules for when an Orkestrator path that stops showing a provider session
 * may close it. Tab teardown and a resume that replaces a tab's session both
 * use them, so a session is closed only by its last owner.
 */

type OwnershipStorage = Pick<
  StorageService,
  "listNativeAgentSessions" | "listMultiReviewWorkflows"
>;

const teardownTails = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * Closes of one provider session run one at a time, keyed by (environment,
 * agent, provider session) within one storage. Without this, two owners
 * letting go together (two tabs closed at once, or a tab close racing a
 * resume in another tab) could each see the other's mapping, both skip the
 * provider close, and leave the session running with no owner.
 */
export async function withProviderSessionTeardownLock<T>(
  storage: object,
  environmentId: string,
  agent: string,
  providerSessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let tails = teardownTails.get(storage);
  if (!tails) {
    tails = new Map();
    teardownTails.set(storage, tails);
  }
  const key = `${environmentId}\0${agent}\0${providerSessionId}`;
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => tail);
  tails.set(key, chained);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === chained) tails.delete(key);
  }
}

/**
 * What still holds a provider session apart from the owner letting go of it,
 * or `null` when nothing does and that owner should close it. Call under
 * {@link withProviderSessionTeardownLock}, after the owner's own mapping has
 * stopped pointing at the session or with `exceptLogicalSessionKey` naming it.
 *
 * - `tab`: another logical tab maps to it (both resumed the same
 *   conversation). Closing it would stop the other tab's session.
 * - `workflow`: a Multi Review step or reviewer session opened in a tab
 *   ("Open session"). The workflow drives it and closes it when the Multi
 *   Review itself is closed.
 */
export async function providerSessionHeldElsewhere(
  storage: OwnershipStorage,
  owner: {
    environmentId: string;
    agent: AgentPlatform;
    providerSessionId: string;
    exceptLogicalSessionKey?: string;
  },
): Promise<"tab" | "workflow" | null> {
  const { environmentId, agent, providerSessionId, exceptLogicalSessionKey } = owner;
  const mappedByAnotherTab = (await storage.listNativeAgentSessions()).some(
    (session) =>
      session.environmentId === environmentId &&
      session.agent === agent &&
      session.logicalSessionKey !== exceptLogicalSessionKey &&
      session.providerSessionId === providerSessionId,
  );
  if (mappedByAnotherTab) return "tab";
  const ownedByWorkflow = (await storage.listMultiReviewWorkflows(environmentId)).some(
    ({ snapshot }) =>
      isMultiReviewWorkflow(snapshot) &&
      multiReviewOwnsProviderSession(snapshot, agent, providerSessionId),
  );
  return ownedByWorkflow ? "workflow" : null;
}
