import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { nativeTabLogicalSessionKey } from "@orkestrator/protocol/public-api-resources";
import type { CommandContext } from "./commands-context.js";
import type { NativeAgentJobCompletionAction } from "./models.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { queueString } from "./native-agent-queue-message.js";
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
  for (const tab of tabs) {
    const session = await context.storage.getNativeAgentSession(
      nativeAgentSessionStorageKey(
        input.environmentId,
        tab.agent,
        nativeTabLogicalSessionKey(input.environmentId, tab.tabId),
      ),
    );
    const updatedAt = session?.updatedAt ?? "";
    if (!latest || updatedAt >= latest.updatedAt) latest = { tab, updatedAt };
  }
  return latest?.tab ?? null;
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
  const tab = await mostRecentJobTab(context, input);
  if (!tab) return null;
  const selection = input.tabReuse === "same-agent" ? input.selection : {};
  if (!selectionApplies(tab.agent, selection)) return null;

  const logicalSessionKey = nativeTabLogicalSessionKey(input.environmentId, tab.tabId);
  const session = { environmentId: input.environmentId, agent: tab.agent, logicalSessionKey };
  const readiness = await nativeAgents.promptReadiness(session);
  if (readiness === "unavailable") return null;
  const resent = { tabId: tab.tabId, agent: tab.agent, logicalSessionKey, reused: true as const };

  if (readiness === "idle") {
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
    if (outcome.outcome === "rejected") return null;
    return outcome.outcome === "unknown"
      ? { ...resent, status: "unknown", ...(outcome.error ? { error: outcome.error } : {}) }
      : { ...resent, status: "accepted" };
  }

  const queueKey = nativePromptQueueKey(tab.agent, logicalSessionKey);
  try {
    // Pressing the button twice during a long turn should not run the same
    // prompt twice after it. The waiting copy already does what the press asked.
    // A dialog's choice is a different request, so it still queues.
    const queue = await context.storage.getPromptQueue(queueKey);
    if (
      input.tabReuse === "any-agent" &&
      queue?.messages.some((message) => queueString(message, "text") === input.prompt)
    ) {
      return { ...resent, status: "accepted", queued: true };
    }
    await context.storage.enqueuePromptQueueMessageIfAbsent(queueKey, input.environmentId, {
      id: input.requestId,
      requestId: input.requestId,
      text: input.prompt,
      mode: input.mode,
      // Claude's queue entries carry the composer's plan flag instead.
      ...(tab.agent === "claude" ? { planModeEnabled: input.mode === "plan" } : {}),
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      ...(typeof selection.fastMode === "boolean" ? { fastMode: selection.fastMode } : {}),
    });
  } catch (error) {
    console.warn(
      `[native-agent-job] Could not queue a resend for ${input.environmentId}:`,
      error instanceof Error ? error.name : "unknown error",
    );
    return null;
  }
  try {
    nativeAgents.notifyPromptQueueChanged?.(queueKey);
  } catch {
    // The drainer's periodic sweep is the safety net for a missed wake-up.
  }
  return { ...resent, status: "accepted", queued: true };
}
