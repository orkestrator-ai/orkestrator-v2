/**
 * `GET /session/:id/status` with its revisions (to-do 8102 task 2, D7).
 *
 * The state revision is settled against everything the backend's state read
 * gets for a Pi session, built from the same functions the side routes serve:
 * the status body, `/queue`, `/approvals` and `/interactions`. The composer
 * enters as its own revision rather than whole, so the model list is digested
 * once (`composerRevisions`). None of these carries a field that moves on
 * every read.
 */
import {
  BRIDGE_KNOWN_COMPOSER_REVISION_PARAM,
  BRIDGE_KNOWN_STATE_REVISION_PARAM,
} from "@orkestrator/protocol/bridge-state-revision";
import type { NativeAgentReadiness } from "@orkestrator/protocol/native-agent";
import { publicApprovals, publicInteractions } from "./interactions.js";
import { composerRevisions, stateRevisions } from "./observation.js";
import { publicQueue, publicStatus } from "./public.js";
import type { JsonObject, SessionState } from "./state.js";

/**
 * What the state revision covers: the status body (its composer as
 * `composerRevision`) and the three side routes, exactly as they answer.
 * Also the revision harness's read.
 */
export function piStateContent(
  state: SessionState,
  readiness?: NativeAgentReadiness,
): { body: JsonObject; status: JsonObject; composerRevision: string; content: JsonObject } {
  const body = publicStatus(state, readiness);
  const { composer, ...status } = body;
  const composerRevision = composerRevisions.settle(state.id, composer);
  return {
    body,
    status,
    composerRevision,
    content: {
      status,
      composerRevision,
      queue: publicQueue(state),
      approvals: publicApprovals(state),
      interactions: publicInteractions(state),
    },
  };
}

/**
 * The status route's answer. `knownStateRevision` still current: the small
 * `{ unchanged, stateRevision }`. Otherwise today's body plus `stateRevision`
 * and `composerRevision`, without `composer` when `knownComposerRevision`
 * names the current one. Synchronous, O(body).
 */
export function piStatusAnswer(
  state: SessionState,
  readiness: NativeAgentReadiness | undefined,
  query: (name: string) => string | null,
): JsonObject {
  const read = piStateContent(state, readiness);
  const answer = stateRevisions.answer(
    state.id,
    read.content,
    query(BRIDGE_KNOWN_STATE_REVISION_PARAM),
  );
  if (answer.unchanged) return { ...answer.body };
  const composerKnown = query(BRIDGE_KNOWN_COMPOSER_REVISION_PARAM) === read.composerRevision;
  return {
    ...(composerKnown ? read.status : read.body),
    composerRevision: read.composerRevision,
    stateRevision: answer.revision,
  };
}
