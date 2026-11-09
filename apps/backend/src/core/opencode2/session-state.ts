/**
 * The action-critical state of one OpenCode 2.x session and its full
 * interactive snapshot (docs/todo/agent-engines/0008-opencode-v2.md, build
 * plan phase 4).
 *
 * Read from the server on every call, never from mounted state, so an
 * inactive tab or a restarted backend rehydrates from the same answer:
 *
 * - **Status** from `/api/session/active` plus the pending permission and
 *   form lists (the provider's `status`). A settled run whose `outcome` is
 *   `failed` reads `error` with the run's own error message, and one that was
 *   `interrupted` carries a `stopped` notice, as 1.x reports a failed or
 *   stopped last turn.
 * - **Usage** from the session's lifetime totals plus the newest response
 *   (`usage.ts`).
 * - **Model** from the session's current model and the newest response's.
 *
 * The state read costs `GET /api/session/:id` plus one-row reads of the
 * newest assistant row (and, after a failed run, the newest idle row), so it
 * never reads the transcript itself.
 */
import type {
  NativeAgentContextUsage,
  NativeAgentNotice,
  NativeAgentTurnPhase,
} from "@orkestrator/protocol/native-agent";
import {
  ProviderUnavailableError,
  TURN_STOPPED_BY_USER_MESSAGE,
  type ProviderStatus,
} from "../agent-provider-contract.js";
import { asRecord, nonEmptyString } from "../agent-provider-runtime.js";
import {
  collectNormalizedOpenCodeSubagentIds,
  hydrateNormalizedOpenCodeSubagents,
} from "../opencode-messages.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import { normalizeOpenCode2Transcript } from "./transcript.js";
import type { OpenCode2Message, OpenCode2Session } from "./types.js";
import { openCode2ContextUsage } from "./usage.js";

/** Children hydrated into sub-agent cards, and rows read per child (the 1.x bounds' shape). */
const MAX_SUBAGENT_SESSIONS = 8;
const SUBAGENT_MESSAGE_LIMIT = 50;
const SUBAGENT_FETCH_CONCURRENCY = 4;

export interface OpenCode2SessionState {
  status: ProviderStatus;
  phase: NativeAgentTurnPhase;
  title?: string;
  error?: string;
  notices?: NativeAgentNotice[];
  contextUsage?: NativeAgentContextUsage;
  turnStartedAt?: number;
  sessionModelId?: string;
  sessionReasoningId?: string;
  lastAssistantModelId?: string;
  lastAssistantReasoningId?: string;
}

function modelId(value: unknown): { modelId?: string; reasoningId?: string } {
  const model = asRecord(value);
  const provider = nonEmptyString(model?.providerID);
  const id = nonEmptyString(model?.id);
  const variant = nonEmptyString(model?.variant);
  return {
    ...(provider && id ? { modelId: `${provider}/${id}` } : {}),
    ...(variant ? { reasoningId: variant } : {}),
  };
}

async function newest(
  client: OpenCode2Client,
  sessionId: string,
  type: string,
): Promise<OpenCode2Message | undefined> {
  const page = await client.listMessages(sessionId, { limit: 1, order: "desc", type });
  return page.messages[0];
}

/**
 * State for `sessionStateSnapshot` and the head of `interactiveSnapshot`.
 * `status` is the provider's lifecycle answer; `recentRows` (oldest first),
 * when the caller already read them, replaces the one-row assistant read.
 */
export async function openCode2SessionState(
  client: OpenCode2Client,
  sessionId: string,
  status: ProviderStatus,
  recentRows?: readonly OpenCode2Message[],
): Promise<OpenCode2SessionState> {
  let session: OpenCode2Session;
  try {
    session = await client.getSession(sessionId);
  } catch (error) {
    if (error instanceof OpenCode2RequestError && error.status === 404) {
      return { status: "missing", phase: "idle" };
    }
    throw new ProviderUnavailableError("OpenCode 2 session state is unavailable", { cause: error });
  }
  const settled = status === "idle";
  const [assistant, idle] = await Promise.all([
    recentRows
      ? Promise.resolve(recentRows.filter((row) => row.type === "assistant"))
      : newest(client, sessionId, "assistant").then((row) => (row ? [row] : [])),
    settled && session.outcome === "failed"
      ? newest(client, sessionId, "idle")
      : Promise.resolve(undefined),
  ]);
  const last = assistant.at(-1);
  const lastModel = modelId(asRecord(last)?.model);
  const sessionModel = modelId(session.model);
  const contextUsage = openCode2ContextUsage(session, assistant);
  const failed = settled && session.outcome === "failed";
  const interrupted = settled && session.outcome === "interrupted";
  const error = failed
    ? (nonEmptyString(asRecord(asRecord(idle)?.error)?.message) ??
      "OpenCode 2 reported that the turn failed")
    : undefined;
  const busy = session.time?.busy;
  return {
    status: failed ? "error" : status,
    phase: failed
      ? "error"
      : status === "running"
        ? "running"
        : status === "blocked"
          ? "blocked"
          : "idle",
    ...(error ? { error } : {}),
    ...(interrupted
      ? {
          notices: [
            { kind: "stopped", message: TURN_STOPPED_BY_USER_MESSAGE } as NativeAgentNotice,
          ],
        }
      : failed
        ? { notices: [{ kind: "error", message: error! } as NativeAgentNotice] }
        : {}),
    ...(session.title ? { title: session.title } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(status === "running" && typeof busy === "number" && busy > 0
      ? { turnStartedAt: busy }
      : {}),
    ...(sessionModel.modelId ? { sessionModelId: sessionModel.modelId } : {}),
    ...(sessionModel.reasoningId ? { sessionReasoningId: sessionModel.reasoningId } : {}),
    ...(lastModel.modelId ? { lastAssistantModelId: lastModel.modelId } : {}),
    ...(lastModel.reasoningId ? { lastAssistantReasoningId: lastModel.reasoningId } : {}),
  };
}

/**
 * Normalized rows with each sub-agent card filled from its child session,
 * breadth first and bounded like 1.x (eight children, fifty rows each). A
 * child that cannot be read keeps its bare card.
 */
export async function hydrateOpenCode2Subagents(
  client: OpenCode2Client,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const queued = collectNormalizedOpenCodeSubagentIds(rows).slice(0, MAX_SUBAGENT_SESSIONS);
  if (queued.length === 0) return rows;
  const seen = new Set<string>();
  const children = new Map<string, Record<string, unknown>[]>();
  while (queued.length > 0 && seen.size < MAX_SUBAGENT_SESSIONS) {
    const batch = queued
      .splice(0, SUBAGENT_FETCH_CONCURRENCY)
      .filter((id) => !seen.has(id))
      .slice(0, MAX_SUBAGENT_SESSIONS - seen.size);
    const results = await Promise.allSettled(
      batch.map(async (childId) => {
        const page = await client.listMessages(childId, {
          limit: SUBAGENT_MESSAGE_LIMIT,
          order: "desc",
        });
        return normalizeOpenCode2Transcript([...page.messages].reverse());
      }),
    );
    batch.forEach((childId, index) => {
      seen.add(childId);
      const result = results[index];
      if (result?.status !== "fulfilled") return;
      children.set(childId, result.value);
      for (const nested of collectNormalizedOpenCodeSubagentIds(result.value)) {
        if (
          !seen.has(nested) &&
          !queued.includes(nested) &&
          seen.size + queued.length < MAX_SUBAGENT_SESSIONS
        ) {
          queued.push(nested);
        }
      }
    });
  }
  return hydrateNormalizedOpenCodeSubagents(rows, children);
}
