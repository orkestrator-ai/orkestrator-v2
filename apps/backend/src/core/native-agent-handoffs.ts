/**
 * The native-agent side of "Continue in…": reading a source session's whole
 * transcript to build a handoff from, and delivering a pending handoff with
 * the destination tab's first dispatch.
 *
 * Delivery used to be the renderer's: it prepended the history to the first
 * message *it* sent, so a first message from another client, the CLI or the
 * queue silently dropped it. The backend now decides at dispatch, for every
 * sender, under the session's delivery lease:
 *
 * - A handoff is pending while the destination tab references it, the tab has
 *   not marked it consumed, the session's dispatch journal has not recorded it
 *   delivered (`deliveredAgentHandoffIds`), and the destination's transcript
 *   has not started.
 * - The carrier is prepended inside the at-most-once window, and the delivery
 *   is recorded in the same session write that journals the request as
 *   dispatched. An ambiguous dispatch parks with the handoff id on its pending
 *   record: a retry under the same request id re-sends the same carrier, a
 *   confirmation records the delivery, and a discard leaves it pending for
 *   the next message. History is never sent twice and never dropped.
 * - A provider command cannot carry history (its text must reach the
 *   executor as typed), so while a handoff is pending one is refused, as is a
 *   goal being set or resumed.
 */
import {
  AGENT_HANDOFF_PROVIDER_LABELS,
  parseAgentHandoffSnapshot,
  prependAgentHandoffHistory,
  textCarriesAgentHandoff,
} from "@orkestrator/protocol/agent-handoff";
import { NATIVE_INLINE_ERROR_MESSAGE_ID_PREFIX } from "@orkestrator/protocol/native-agent";
import { parseGoalCommandArguments } from "@orkestrator/protocol/native-agent-goal";
import { NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX } from "@orkestrator/protocol/native-terminal-rows";
import {
  PromptRejectedError,
  readProviderStatus,
  type NativeAgentRuntimeProvider,
} from "./agent-provider-contract.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import type { PersistedNativeAgentSession } from "./models.js";
import type { CommandDispatchPlan } from "./native-agent-command-dispatch.js";
import {
  nativeAgentSessionStorageKey,
  type EnsureNativeAgentSessionInput,
  type NativeAgentProjectionInput,
} from "./native-agent-service-shared.js";
import { normalizeOpenCodeDisplayEntries } from "./opencode-display-transcript.js";
import { deliveredAgentHandoffIds } from "./storage-shared-native-sessions.js";
import { pendingPaneLayoutAgentHandoffId } from "./storage-shared-pane-layout.js";
import type { StorageService } from "./storage.js";

/** Refusal for a command sent while a handoff is still waiting to be delivered. */
export const AGENT_HANDOFF_PENDING_COMMAND_MESSAGE =
  "Send a normal message first to complete the agent handoff; slash commands cannot carry transferred history.";

/** Refusal for a goal set or resumed while a handoff is still waiting to be delivered. */
export const AGENT_HANDOFF_PENDING_GOAL_MESSAGE =
  "Send a normal message first to complete the agent handoff; a goal cannot carry transferred history.";

/** Refusal when the destination's transcript cannot be read to rule out a double send. */
export const AGENT_HANDOFF_UNVERIFIED_MESSAGE =
  "The transferred conversation could not be checked against this session yet, so nothing was sent. Retry in a moment.";

/** Newest rows read to tell an untouched destination from one a prompt reached. */
const DESTINATION_PROBE_MESSAGES = 16;

export interface PendingAgentHandoff {
  id: string;
  bootstrapPrompt: string;
}

export interface NativeAgentHandoffsHost {
  storage: StorageService;
  provider: (input: EnsureNativeAgentSessionInput) => Promise<NativeAgentRuntimeProvider>;
}

/** The environment tab a session belongs to, or "" for a session no tab owns. */
function sessionTabId(session: PersistedNativeAgentSession): string {
  if (session.owner?.kind === "coordinator") return "";
  const prefix = `env-${session.environmentId}:`;
  return session.logicalSessionKey.startsWith(prefix)
    ? session.logicalSessionKey.slice(prefix.length)
    : "";
}

/**
 * Whether a destination transcript row proves a prompt reached the provider.
 * Local error rows do not: a definite rejection leaves one behind, and the
 * history must still go with the retry.
 */
function rowProvesDestinationStarted(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const id = (row as { id?: unknown }).id;
  if (typeof id !== "string") return true;
  return !(
    id.startsWith(NATIVE_INLINE_ERROR_MESSAGE_ID_PREFIX) ||
    id.startsWith(NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX) ||
    id.startsWith("system-")
  );
}

/**
 * The refusal, if any, for a submission that cannot carry a pending handoff. A
 * command's text must reach its executor as typed, and a goal's first turn is
 * a backend-authored carrier of its own.
 */
export function pendingHandoffCommandRefusal(plan: CommandDispatchPlan): string | undefined {
  if (plan.kind === "prompt") {
    return plan.command ? AGENT_HANDOFF_PENDING_COMMAND_MESSAGE : undefined;
  }
  if (plan.kind !== "goal") return undefined;
  const goal = parseGoalCommandArguments(plan.arguments);
  return goal.kind === "set" || goal.kind === "resume"
    ? AGENT_HANDOFF_PENDING_GOAL_MESSAGE
    : undefined;
}

/**
 * The prompt a dispatch sends: `prompt` with the pending handoff's carrier in
 * front, unless the journal already recorded it delivered or the prompt
 * already carries it (an older renderer prepends the history itself).
 * `deliveredId` is the handoff this send delivers, for the journal.
 */
export function promptWithPendingAgentHandoff(
  prompt: string,
  handoff: PendingAgentHandoff | undefined,
  session: PersistedNativeAgentSession,
): { prompt: string; deliveredId?: string } {
  if (!handoff || deliveredAgentHandoffIds(session).includes(handoff.id)) return { prompt };
  if (textCarriesAgentHandoff(prompt, handoff.id)) {
    compatibilityPathUsage.record("agent-handoff.renderer-carried");
    return { prompt, deliveredId: handoff.id };
  }
  return {
    prompt: prependAgentHandoffHistory(handoff.bootstrapPrompt, prompt),
    deliveredId: handoff.id,
  };
}

export class NativeAgentHandoffs {
  constructor(private readonly host: NativeAgentHandoffsHost) {}

  /**
   * The handoff this session's tab still has to deliver, read before the
   * delivery lease (the journal check happens again inside it). Undefined for
   * a session no tab owns, a consumed or missing handoff, one addressed to
   * another platform, or a destination whose transcript has already started.
   *
   * The transcript is the evidence the journal cannot give: a handoff an older
   * renderer delivered, or a queued dispatch settled without a journal write,
   * looks undelivered here and must not be sent twice. A failed read refuses
   * the dispatch before anything is journaled, because neither guess is safe:
   * sending could double the history and not sending could drop it.
   */
  async pending(
    session: PersistedNativeAgentSession,
    provider: Pick<NativeAgentRuntimeProvider, "messages">,
  ): Promise<PendingAgentHandoff | undefined> {
    const tabId = sessionTabId(session);
    if (!tabId) return undefined;
    const layout = await this.host.storage.getPaneLayout(session.environmentId);
    const handoffId = pendingPaneLayoutAgentHandoffId(layout?.root, tabId);
    if (!handoffId || deliveredAgentHandoffIds(session).includes(handoffId)) return undefined;
    const record = await this.host.storage.getAgentHandoff(handoffId);
    if (!record || record.environmentId !== session.environmentId) return undefined;
    // The carrier is rebuilt from validated fields, never trusted as stored.
    const snapshot = parseAgentHandoffSnapshot(record.snapshot);
    if (
      !snapshot ||
      snapshot.id !== handoffId ||
      snapshot.environmentId !== session.environmentId ||
      snapshot.destinationProvider !== session.agent
    ) {
      return undefined;
    }
    let rows: unknown[];
    try {
      rows = await provider.messages(session.providerSessionId, {
        limit: DESTINATION_PROBE_MESSAGES,
      });
    } catch {
      throw new PromptRejectedError(AGENT_HANDOFF_UNVERIFIED_MESSAGE);
    }
    if (rows.some(rowProvesDestinationStarted)) {
      await this.markConsumed(session, handoffId);
      return undefined;
    }
    return { id: handoffId, bootstrapPrompt: snapshot.bootstrapPrompt };
  }

  /**
   * Display state after a delivery: marks the tab's handoff consumed in the
   * pane layout so every client stops offering it as pending. Best-effort; the
   * journal already holds the authoritative record.
   */
  async markConsumed(session: PersistedNativeAgentSession, handoffId: string): Promise<void> {
    const tabId = sessionTabId(session);
    if (!tabId) return;
    await this.host.storage
      .markTabAgentHandoffConsumed(session.environmentId, tabId, handoffId)
      .catch((error: unknown) => {
        console.warn(
          "[native-agent] Marking a delivered handoff consumed failed:",
          error instanceof Error ? error.message : error,
        );
      });
  }

  /**
   * The whole transcript of an idle source session, for building a handoff.
   *
   * The renderer used to build handoffs from whatever window of messages it
   * had loaded. This reads the provider's complete transcript, and refuses
   * when the session is mid-turn or changed while it was read: a handoff of a
   * moving conversation would describe a state that never existed.
   */
  async readSourceTranscript(
    input: NativeAgentProjectionInput & { expectedProviderSessionId: string },
  ): Promise<{ providerSessionId: string; messages: unknown[] }> {
    const label = AGENT_HANDOFF_PROVIDER_LABELS[input.agent];
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.host.storage.getNativeAgentSession(key);
    if (
      !session ||
      session.environmentId !== input.environmentId ||
      session.agent !== input.agent ||
      session.logicalSessionKey !== input.logicalSessionKey ||
      session.providerSessionId !== input.expectedProviderSessionId
    ) {
      throw new Error(`${label} session is unavailable`);
    }
    if (session.pendingDispatch || session.pendingSteer) {
      throw new Error(`Wait for ${label} to finish before continuing in another agent`);
    }
    const provider = await this.host.provider({
      environmentId: input.environmentId,
      agent: input.agent,
      logicalSessionKey: input.logicalSessionKey,
    });
    const idle = async () => {
      const status = await readProviderStatus(provider, session.providerSessionId);
      return status.status === "idle" || status.status === "error";
    };
    if (!(await idle())) {
      throw new Error(`Wait for ${label} to finish before continuing in another agent`);
    }
    // The neutral row shape: OpenCode's `{ info, parts }` envelopes are unwrapped
    // here as they are for its tab, and every other provider's pass through.
    const messages = normalizeOpenCodeDisplayEntries(
      await provider.messages(session.providerSessionId),
    );
    const after = await this.host.storage.getNativeAgentSession(key);
    if (
      !after ||
      after.providerSessionId !== session.providerSessionId ||
      after.dispatchedRequestIds?.at(-1) !== session.dispatchedRequestIds?.at(-1) ||
      after.pendingDispatch ||
      !(await idle())
    ) {
      throw new Error(`${label} conversation changed while it was being transferred`);
    }
    return { providerSessionId: session.providerSessionId, messages };
  }
}
