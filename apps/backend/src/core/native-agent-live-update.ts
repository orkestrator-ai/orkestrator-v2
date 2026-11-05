import {
  NATIVE_AGENT_LIVE_UPDATE_VERSION,
  NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
  type NativeAgentLiveUpdate,
  type NativeAgentPendingUpdate,
  type NativeAgentSessionStateUpdate,
  type NativeAgentTranscriptUpdate,
} from "@orkestrator/protocol/native-agent";
import type {
  NativeAgentLiveUpdateInput,
  NativeAgentProgressiveInput,
  NativeAgentTranscriptUpdateInput,
} from "./native-agent-service-shared.js";

/**
 * How long a combined read waits for its slower part. The reads were separate
 * requests so that a slow transcript could not hold back session state, which
 * carries pending approvals and the turn phase. A part still running when this
 * passes is answered `pending`, and the client reads it on its own; that read
 * joins the provider read already in flight.
 */
export const NATIVE_AGENT_LIVE_UPDATE_PART_DEADLINE_MS = 250;

export interface NativeAgentLiveUpdateReads {
  getTranscriptUpdate(
    input: NativeAgentTranscriptUpdateInput,
  ): Promise<NativeAgentTranscriptUpdate>;
  getSessionStateUpdate(input: NativeAgentProgressiveInput): Promise<NativeAgentSessionStateUpdate>;
}

const PENDING: NativeAgentPendingUpdate = {
  viewVersion: NATIVE_AGENT_LIVE_UPDATE_VERSION,
  status: "pending",
};

/**
 * Answer a session's transcript and state in one request. Each part runs the
 * same read and token comparison as its own command, and a part that throws
 * becomes that part's `unavailable` answer, so one failure never costs the
 * other part its answer.
 */
export async function readNativeAgentLiveUpdate(
  reads: NativeAgentLiveUpdateReads,
  input: NativeAgentLiveUpdateInput,
  deadlineMs: number = NATIVE_AGENT_LIVE_UPDATE_PART_DEADLINE_MS,
): Promise<NativeAgentLiveUpdate> {
  const session = {
    environmentId: input.environmentId,
    agent: input.agent,
    logicalSessionKey: input.logicalSessionKey,
    viewVersion: NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
  };
  let transcript: NativeAgentLiveUpdate["transcript"] = PENDING;
  let state: NativeAgentLiveUpdate["state"] = PENDING;
  // Neither of these rejects, so a part that outlives the deadline settles
  // with nobody listening rather than as an unhandled rejection.
  const parts = [
    settleUpdate(() =>
      reads.getTranscriptUpdate({
        ...session,
        liveWindow: input.liveWindow,
        ...(input.transcriptToken === undefined ? {} : { knownToken: input.transcriptToken }),
        ...(input.patchVersion === undefined ? {} : { patchVersion: input.patchVersion }),
      }),
    ).then((update) => {
      transcript = update;
    }),
    settleUpdate(() =>
      reads.getSessionStateUpdate({
        ...session,
        ...(input.stateToken === undefined ? {} : { knownToken: input.stateToken }),
      }),
    ).then((update) => {
      state = update;
    }),
  ];
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(parts),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
    }),
  ]);
  clearTimeout(timer);
  return { viewVersion: NATIVE_AGENT_LIVE_UPDATE_VERSION, transcript, state };
}

async function settleUpdate<T>(
  read: () => Promise<T>,
): Promise<T | Extract<NativeAgentSessionStateUpdate, { status: "unavailable" }>> {
  try {
    return await read();
  } catch (error) {
    return {
      viewVersion: NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
      status: "unavailable",
      retryable: true,
      error: error instanceof Error ? error.message.slice(0, 4_000) : "Session read failed",
    };
  }
}
