import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { nativeTabLogicalSessionKey } from "@orkestrator/protocol/public-api-resources";
import type { CommandContext } from "./commands-context.js";
import { nativeAgentJobReceiptIsActive, type NativeAgentJobCompletionAction } from "./models.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { createHash } from "node:crypto";
import { nativePromptQueueKey } from "./public-api/prompt-delivery.js";
import { nativeTabsOfLayout, type NativeTabInfo } from "./public-api/summaries.js";

/**
 * Which open tab a job may resend to. `any-agent` keeps the tab's own agent and
 * model (a plain button press). `same-agent` is an explicit choice from a launch
 * dialog: it applies to that provider's conversation or to none.
 */
export type NativeAgentJobTabReuse = "any-agent" | "same-agent";

export function isNativeAgentJobTabReuse(value: unknown): value is NativeAgentJobTabReuse {
  return value === "any-agent" || value === "same-agent";
}

interface ResendInput {
  environmentId: string;
  requestId: string;
  completionAction: NativeAgentJobCompletionAction;
  tabReuse: NativeAgentJobTabReuse;
  agent: AgentPlatform;
  enabledAgents: readonly AgentPlatform[];
  prompt: string;
  mode: "plan" | "build";
  /** Only what the caller chose itself; an absent field keeps the tab's own value. */
  selection: { model?: string; reasoningEffort?: string; fastMode?: boolean };
}

export interface ResentJob {
  tabId: string;
  agent: AgentPlatform;
  logicalSessionKey: string;
  status: "accepted" | "unknown";
  error?: string;
  reused: true;
  /** The prompt waits behind the tab's current work instead of running now. */
  queued?: true;
}

/** The candidate whose conversation was used last; a tab with no session ranks below any other. */
async function mostRecentJobTab(
  context: CommandContext,
  input: ResendInput,
): Promise<NativeTabInfo | null> {
  const tabs = nativeTabsOfLayout(await context.storage.getPaneLayout(input.environmentId)).filter(
    (tab) =>
      tab.jobCompletionAction === input.completionAction &&
      input.enabledAgents.includes(tab.agent) &&
      (input.tabReuse === "any-agent" || tab.agent === input.agent),
  );
  let latest: { tab: NativeTabInfo; updatedAt: string } | null = null;
  let pending: NativeTabInfo | null = null;
  for (const tab of tabs) {
    const session = await context.storage.getNativeAgentSession(
      nativeAgentSessionStorageKey(
        input.environmentId,
        tab.agent,
        nativeTabLogicalSessionKey(input.environmentId, tab.tabId),
      ),
    );
    if (session?.pendingDispatch || session?.pendingSteer) pending ??= tab;
    const queue = await context.storage.getPromptQueue(
      nativePromptQueueKey(tab.agent, nativeTabLogicalSessionKey(input.environmentId, tab.tabId)),
    );
    if (
      queue?.jobReceipts?.some(
        (receipt) =>
          receipt.status === "unknown" &&
          !session?.dispatchedRequestIds?.includes(receipt.dispatchRequestId ?? receipt.requestId),
      )
    )
      pending ??= tab;
    if (
      input.tabReuse === "any-agent" &&
      queue?.jobReceipts?.some(
        (receipt) =>
          receipt.fingerprint === jobPromptFingerprint(input.prompt, input.mode) &&
          nativeAgentJobReceiptIsActive(receipt, session, queue),
      )
    )
      pending ??= tab;
    const updatedAt = session?.updatedAt ?? "";
    if (!latest || updatedAt >= latest.updatedAt) latest = { tab, updatedAt };
  }
  return pending ?? latest?.tab ?? null;
}

/** Whether the provider lets an existing conversation change what the dialog chose. */
function selectionApplies(agent: AgentPlatform, selection: ResendInput["selection"]): boolean {
  const { composer } = nativeAgentCapabilities(agent);
  return (
    (selection.model === undefined || composer.model) &&
    (selection.reasoningEffort === undefined || composer.reasoning) &&
    (selection.fastMode === undefined || composer.speed)
  );
}

export function jobPromptFingerprint(
  prompt: string,
  mode: "plan" | "build",
  selection: ResendInput["selection"] = {},
): string {
  return createHash("sha256")
    .update(JSON.stringify([prompt, mode, selection]))
    .digest("hex");
}

/**
 * Send a job's prompt again in the most recent open tab that ran the same job.
 *
 * An idle tab gets the prompt now, through the same exactly-once dispatch as a
 * new launch. A busy one gets it through the durable queue, so it runs when the
 * current work ends and nothing is interrupted. Answers `null` when no prompt
 * has run and the caller should open a new tab instead. An `unknown` dispatch is
 * returned rather than falling back, because the prompt may be running.
 */
export async function resendToOpenJobTab(
  context: CommandContext,
  input: ResendInput,
): Promise<ResentJob | null> {
  const nativeAgents = context.nativeAgents;
  if (!nativeAgents) return null;
  // A durable receipt outranks recency, availability and even a closed tab.
  // Once a request may have crossed the provider boundary it cannot be retargeted.
  for (const queue of await context.storage.listPromptQueues(input.environmentId)) {
    const receipt = queue.jobReceipts?.find((entry) => entry.requestId === input.requestId);
    if (!receipt) continue;
    const separator = queue.queueKey.indexOf("\0");
    const agent = queue.queueKey.slice(0, separator) as AgentPlatform;
    const logicalSessionKey = queue.queueKey.slice(separator + 1);
    const fingerprint = jobPromptFingerprint(
      input.prompt,
      input.mode,
      input.tabReuse === "same-agent" ? input.selection : {},
    );
    if (receipt.fingerprint !== fingerprint) throw new Error("Job request ID conflict");
    if (receipt.status === "unknown")
      await nativeAgents.promptReadiness({
        environmentId: input.environmentId,
        agent,
        logicalSessionKey,
      });
    const session = await context.storage.getNativeAgentSession(
      nativeAgentSessionStorageKey(input.environmentId, agent, logicalSessionKey),
    );
    const status = session?.dispatchedRequestIds?.includes(
      receipt.dispatchRequestId ?? receipt.requestId,
    )
      ? "accepted"
      : receipt.status;
    if (status !== receipt.status)
      await context.storage.settleNativeAgentJobRequest(
        queue.queueKey,
        receipt.dispatchRequestId ?? receipt.requestId,
        status,
      );
    return {
      tabId: logicalSessionKey.slice(`env-${input.environmentId}:`.length),
      agent,
      logicalSessionKey,
      reused: true,
      status,
      ...(receipt.queued ? { queued: true } : {}),
    };
  }
  const tab = await mostRecentJobTab(context, input);
  if (!tab) return null;
  const selection = input.tabReuse === "same-agent" ? input.selection : {};
  if (!selectionApplies(tab.agent, selection)) return null;

  const logicalSessionKey = nativeTabLogicalSessionKey(input.environmentId, tab.tabId);
  const session = { environmentId: input.environmentId, agent: tab.agent, logicalSessionKey };
  const readiness = await nativeAgents.promptReadiness(session);
  const persisted = await context.storage.getNativeAgentSession(
    nativeAgentSessionStorageKey(input.environmentId, tab.agent, logicalSessionKey),
  );
  const queueKey = nativePromptQueueKey(tab.agent, logicalSessionKey);
  const queue = await context.storage.getPromptQueue(queueKey);
  const ambiguous =
    persisted?.pendingDispatch ||
    persisted?.pendingSteer ||
    queue?.jobReceipts?.some(
      (receipt) =>
        receipt.status === "unknown" &&
        !persisted?.dispatchedRequestIds?.includes(receipt.dispatchRequestId ?? receipt.requestId),
    );
  const activeReceipt =
    input.tabReuse === "any-agent" &&
    queue?.jobReceipts?.find(
      (receipt) =>
        receipt.fingerprint === jobPromptFingerprint(input.prompt, input.mode) &&
        nativeAgentJobReceiptIsActive(receipt, persisted, queue),
    );
  if (readiness === "unavailable" && !ambiguous && !activeReceipt) return null;
  const resent = { tabId: tab.tabId, agent: tab.agent, logicalSessionKey, reused: true as const };

  const fingerprint = jobPromptFingerprint(input.prompt, input.mode, selection);
  const queuedMessage = {
    id: input.requestId,
    requestId: input.requestId,
    text: input.prompt,
    mode: input.mode,
    ...(tab.agent === "claude" ? { planModeEnabled: input.mode === "plan" } : {}),
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    ...(typeof selection.fastMode === "boolean" ? { fastMode: selection.fastMode } : {}),
  };
  if (ambiguous) {
    const matching =
      input.tabReuse === "any-agent" &&
      queue?.jobReceipts?.find((receipt) => receipt.fingerprint === fingerprint);
    const pendingMatches =
      input.tabReuse === "any-agent" &&
      (persisted?.pendingDispatch?.prompt === input.prompt ||
        persisted?.pendingSteer?.text === input.prompt);
    const dispatchRequestId = matching
      ? (matching.dispatchRequestId ?? matching.requestId)
      : pendingMatches
        ? (persisted?.pendingDispatch?.requestId ?? persisted?.pendingSteer?.requestId)
        : undefined;
    // Identical presses follow the original ambiguous admission. Distinct
    // choices wait durably on that same tab until its admission is settled.
    const queued = !dispatchRequestId || (matching && matching.queued);
    await context.storage.reserveNativeAgentJobRequest(
      queueKey,
      input.environmentId,
      {
        requestId: input.requestId,
        fingerprint,
        status: dispatchRequestId ? "unknown" : "accepted",
        ...(dispatchRequestId ? { dispatchRequestId } : {}),
        ...(queued ? { queued: true } : {}),
      },
      dispatchRequestId ? undefined : queuedMessage,
    );
    if (queued) {
      try {
        nativeAgents.notifyPromptQueueChanged?.(queueKey);
      } catch {
        /* Periodic sweep recovers missed wake-ups. */
      }
    }
    return {
      ...resent,
      status: dispatchRequestId ? "unknown" : "accepted",
      ...(queued ? { queued: true } : {}),
    };
  }

  if (readiness === "unavailable" && activeReceipt) {
    const receipt = await context.storage.reserveNativeAgentJobRequest(
      queueKey,
      input.environmentId,
      {
        requestId: input.requestId,
        fingerprint,
        status: activeReceipt.status,
      },
      undefined,
      true,
    );
    return { ...resent, status: receipt.status, ...(receipt.queued ? { queued: true } : {}) };
  }

  if (readiness === "idle") {
    const receipt = await context.storage.reserveNativeAgentJobRequest(
      queueKey,
      input.environmentId,
      {
        requestId: input.requestId,
        fingerprint,
        status: "unknown",
      },
      undefined,
      input.tabReuse === "any-agent",
    );
    if (receipt.dispatchRequestId && receipt.dispatchRequestId !== input.requestId) {
      return { ...resent, status: receipt.status, ...(receipt.queued ? { queued: true } : {}) };
    }
    const outcome = await nativeAgents.dispatchIntent({
      ...session,
      origin: "interactive-native",
      prompt: input.prompt,
      requestId: input.requestId,
      mode: input.mode,
      ...(selection.model ? { model: selection.model, modelSource: "explicit" as const } : {}),
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      ...(typeof selection.fastMode === "boolean" ? { fastMode: selection.fastMode } : {}),
    });
    await context.storage.settleNativeAgentJobRequest(queueKey, input.requestId, outcome.outcome);
    if (outcome.outcome === "rejected") return null;
    return outcome.outcome === "unknown"
      ? { ...resent, status: "unknown", ...(outcome.error ? { error: outcome.error } : {}) }
      : { ...resent, status: "accepted" };
  }

  let queuedReceipt;
  try {
    queuedReceipt = await context.storage.reserveNativeAgentJobRequest(
      queueKey,
      input.environmentId,
      {
        requestId: input.requestId,
        fingerprint,
        status: "accepted",
        queued: true,
      },
      queuedMessage,
      input.tabReuse === "any-agent",
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Native job receipt capacity reached")
      throw error;
    console.warn(
      `[native-agent-job] Could not queue a resend for ${input.environmentId}:`,
      error instanceof Error ? error.name : "unknown error",
    );
    // A write may have committed before a notification or connection failed.
    // Fall back only after a durable read proves there is no published request.
    const receipt = (await context.storage.getPromptQueue(queueKey))?.jobReceipts?.find(
      (entry) => entry.requestId === input.requestId,
    );
    if (receipt)
      return { ...resent, status: receipt.status, ...(receipt.queued ? { queued: true } : {}) };
    return null;
  }
  try {
    nativeAgents.notifyPromptQueueChanged?.(queueKey);
  } catch {
    // The drainer's periodic sweep is the safety net for a missed wake-up.
  }
  return {
    ...resent,
    status: queuedReceipt.status,
    ...(queuedReceipt.queued ? { queued: true } : {}),
  };
}
