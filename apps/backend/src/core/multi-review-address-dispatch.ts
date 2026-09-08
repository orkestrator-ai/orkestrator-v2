import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import {
  MULTI_REVIEW_ADDRESS_PROMPT,
  MULTI_REVIEW_FIX_TAB_TITLE,
  MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION,
  MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
  multiReviewCustomFixPrompt,
  type MultiReviewFixSession,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { createHash } from "node:crypto";
import {
  NativeAgentProviderSessionMissingError,
  type NativeAgentService,
} from "./native-agent-service.js";
import { addressPrompt } from "./build-pipeline-prompts.js";

export class MissingMultiReviewAddressSessionError extends Error {
  constructor() {
    super("The consolidation session is no longer available");
    this.name = "MissingMultiReviewAddressSessionError";
  }
}

export class InvalidMultiReviewAddressStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMultiReviewAddressStateError";
  }
}

export class MultiReviewAddressDispatchError extends Error {
  constructor(
    message: string,
    readonly preparedSession?: MultiReviewFixSession,
  ) {
    super(message);
    this.name = "MultiReviewAddressDispatchError";
  }
}

export interface MultiReviewAddressDispatchResult {
  fixSession: MultiReviewFixSession;
  tabId: string;
  presentationError?: string;
}

export interface MultiReviewFixSessionReplacement {
  expectedProviderSessionId: string;
  replacementProviderSessionId: string;
  tabId: string;
}

type AddressNativeAgents = Pick<
  NativeAgentService,
  "adoptSession" | "ensureSession" | "dispatchIntent"
>;

function replacementRequestId(workflow: MultiReviewWorkflow, providerSessionId: string): string {
  const replacement = createHash("sha256").update(providerSessionId).digest("hex").slice(0, 24);
  return `multi-review-address-replacement:${workflow.id}:${replacement}`;
}

/**
 * Rebind a Fix tab whose provider rollout disappeared and seed the replacement
 * with the authoritative consolidated report before the renderer can use it.
 */
export async function recoverMissingMultiReviewFixSession(
  nativeAgents: AddressNativeAgents,
  workflow: MultiReviewWorkflow,
  replacement: MultiReviewFixSessionReplacement,
): Promise<MultiReviewAddressDispatchResult> {
  const session = workflow.fixSession;
  if (
    workflow.phase !== "interactive" ||
    !workflow.consolidatedReport ||
    !session ||
    session.providerSessionId !== replacement.expectedProviderSessionId
  ) {
    throw new InvalidMultiReviewAddressStateError(
      "The Multi Review Fix session replacement no longer matches the workflow",
    );
  }
  const expectedTabId =
    workflow.fixTabId ?? workflow.addressTabId ?? `multi-review-fix:${workflow.id}`;
  if (replacement.tabId !== expectedTabId) {
    throw new InvalidMultiReviewAddressStateError(
      "The Multi Review Fix session replacement targeted an unexpected tab",
    );
  }
  const interactiveSessionKeyPrefix = `multi-review:${workflow.id}:interactive`;
  const logicalSessionKey =
    workflow.addressSessionKey ??
    (session.sessionKey.startsWith(interactiveSessionKeyPrefix)
      ? session.sessionKey
      : interactiveSessionKeyPrefix);
  const model = workflow.fixModel.model === "default" ? undefined : workflow.fixModel.model;
  const identity = {
    environmentId: workflow.environmentId,
    agent: workflow.fixModel.agent,
    logicalSessionKey,
    origin: "interactive-native" as const,
    interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
    title: MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
    model,
    reasoningEffort: workflow.fixModel.reasoningEffort,
    phase: "fix" as const,
    sessionMode: "build" as const,
  };
  await nativeAgents.adoptSession({
    ...identity,
    providerSessionId: replacement.replacementProviderSessionId,
    expectedProviderSessionId: replacement.expectedProviderSessionId,
  });
  const requestId = replacementRequestId(workflow, replacement.replacementProviderSessionId);
  const outcome = await nativeAgents.dispatchIntent({
    ...identity,
    prompt: `${addressPrompt(workflow.consolidatedReport)}\n\n${MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION}`,
    requestId,
    mode: "build",
  });
  if (outcome.outcome !== "accepted") {
    throw new MultiReviewAddressDispatchError(
      outcome.error ?? "The replacement Fix session prompt was not confirmed",
    );
  }
  return {
    tabId: replacement.tabId,
    fixSession: {
      ...session,
      sessionKey: logicalSessionKey,
      providerSessionId: replacement.replacementProviderSessionId,
      requestIds: session.requestIds.includes(requestId)
        ? session.requestIds
        : [...session.requestIds.slice(-255), requestId],
      status: "idle",
    },
  };
}

interface AddressTabPublisher {
  ensureNativeAgentJobTab(input: {
    environmentId: string;
    tabId: string;
    agent: MultiReviewWorkflow["fixModel"]["agent"];
    providerSessionId?: string;
    title?: string;
    isReviewTab?: boolean;
    activate?: boolean;
  }): Promise<unknown>;
}

/** Prepare the interactive session and deliver the stable, at-most-once address request. */
export async function dispatchMultiReviewAddressPrompt(
  nativeAgents: AddressNativeAgents,
  workflow: MultiReviewWorkflow,
  tabs?: AddressTabPublisher,
  activateTab = false,
): Promise<MultiReviewAddressDispatchResult> {
  const session = workflow.fixSession;
  if (!session) throw new MissingMultiReviewAddressSessionError();
  const selection = workflow.customFixModel ?? workflow.fixModel;
  const customFix = workflow.customFixInstruction !== undefined;
  if (customFix && workflow.consolidatedReport === undefined) {
    throw new InvalidMultiReviewAddressStateError(
      "The consolidated review report is missing from the custom fix request",
    );
  }
  const logicalSessionKey = workflow.addressSessionKey ?? `multi-review:${workflow.id}:interactive`;
  const model = selection.model === "default" ? undefined : selection.model;
  const identity = {
    environmentId: workflow.environmentId,
    agent: selection.agent,
    logicalSessionKey,
    origin: "interactive-native" as const,
    interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
    title: MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
    model,
    reasoningEffort: selection.reasoningEffort,
    phase: "fix" as const,
    sessionMode: "build" as const,
  };
  const tab = {
    environmentId: workflow.environmentId,
    tabId: workflow.addressTabId ?? `multi-review-fix:${workflow.id}`,
    agent: selection.agent,
    title: MULTI_REVIEW_FIX_TAB_TITLE,
    isReviewTab: true,
    activate: activateTab,
  };
  let providerSessionId: string;
  if (customFix) {
    const ensured = await nativeAgents.ensureSession(identity);
    providerSessionId = ensured.providerSessionId;
  } else {
    try {
      await nativeAgents.adoptSession({
        ...identity,
        providerSessionId: session.providerSessionId,
      });
      providerSessionId = session.providerSessionId;
    } catch (error) {
      if (error instanceof NativeAgentProviderSessionMissingError) {
        throw new MissingMultiReviewAddressSessionError();
      }
      throw error;
    }
  }
  const requestId = workflow.addressRequestId ?? `multi-review-address:${workflow.id}`;
  const prompt = !customFix
    ? MULTI_REVIEW_ADDRESS_PROMPT
    : multiReviewCustomFixPrompt(workflow.consolidatedReport!, workflow.customFixInstruction!);
  const preparedSession: MultiReviewFixSession | undefined = customFix
    ? {
        ...selection,
        sessionKey: logicalSessionKey,
        providerSessionId,
        requestIds: [requestId],
        status: "idle",
        startedAt: new Date().toISOString(),
      }
    : undefined;
  let outcome: Awaited<ReturnType<AddressNativeAgents["dispatchIntent"]>>;
  try {
    outcome = await nativeAgents.dispatchIntent({
      ...identity,
      prompt,
      requestId,
      mode: "build",
    });
  } catch (error) {
    throw new MultiReviewAddressDispatchError(
      error instanceof Error ? error.message : String(error),
      preparedSession,
    );
  }
  if (outcome.outcome !== "accepted") {
    throw new MultiReviewAddressDispatchError(
      outcome.error ?? "The address prompt dispatch was not confirmed",
      preparedSession,
    );
  }

  // Publish only after the intended prompt is authoritative. Exposing the
  // session sooner lets a user submit another turn before the fix request.
  let presentationError: string | undefined;
  try {
    await tabs?.ensureNativeAgentJobTab({ ...tab, providerSessionId });
  } catch (error) {
    presentationError =
      "The fix request was delivered, but its tab could not be opened. Close another tab if needed, then use Open fix session.";
    console.warn(
      "[multi-review] Fix tab publication failed:",
      error instanceof Error ? error.message : error,
    );
  }
  return {
    fixSession: preparedSession ?? session,
    tabId: tab.tabId,
    ...(presentationError ? { presentationError } : {}),
  };
}
