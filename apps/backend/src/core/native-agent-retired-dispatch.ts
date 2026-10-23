import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  NATIVE_AGENT_RETIRED_DISPATCH_TTL_MS,
  dispatchOutcomeLostMessage,
  dispatchOutcomeLostOccurrenceId,
  type NativeAgentNotice,
  type NativeAgentRetiredDispatch,
} from "@orkestrator/protocol/native-agent";
import type { PersistedNativeAgentSession } from "./models.js";

/**
 * The retired-dispatch marker a projection carries, or undefined.
 *
 * The persisted record is not validated with the session, so this is where a
 * malformed one is dropped. It is also where the lifetime is enforced: a
 * marker older than `NATIVE_AGENT_RETIRED_DISPATCH_TTL_MS`, or dated further
 * ahead than that (a clock that jumped), is not shown.
 */
export function projectedRetiredDispatch(
  agent: AgentPlatform,
  session: Pick<PersistedNativeAgentSession, "retiredDispatch">,
  now: number,
): NativeAgentRetiredDispatch | undefined {
  const record: unknown = session.retiredDispatch;
  if (!record || typeof record !== "object") return undefined;
  const { requestId, retiredAt } = record as Record<string, unknown>;
  if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 512) {
    return undefined;
  }
  if (typeof retiredAt !== "string") return undefined;
  const at = Date.parse(retiredAt);
  if (!Number.isFinite(at) || Math.abs(now - at) >= NATIVE_AGENT_RETIRED_DISPATCH_TTL_MS) {
    return undefined;
  }
  return { requestId, retiredAt, message: dispatchOutcomeLostMessage(agent) };
}

/**
 * The same message as a warning notice, for renderers that predate
 * `retiredDispatch`. Keyed by request id so a dismissal sticks to it.
 */
export function retiredDispatchNotice(retired: NativeAgentRetiredDispatch): NativeAgentNotice {
  return {
    kind: "warning",
    message: retired.message,
    occurrenceId: dispatchOutcomeLostOccurrenceId(retired.requestId),
  };
}
