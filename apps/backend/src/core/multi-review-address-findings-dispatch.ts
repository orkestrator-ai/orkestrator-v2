import { wrapSystemInstructions } from "@orkestrator/protocol/review-evidence-frames";
import {
  MULTI_REVIEW_ADDRESS_FINDINGS_PROMPT,
  MULTI_REVIEW_ADDRESS_FINDINGS_TAB_TITLE,
  MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION,
  MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
  multiReviewCustomAddressFindingsPrompt,
  type MultiReviewAddressFindingsSession,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { createHash } from "node:crypto";
import {
  NativeAgentProviderSessionMissingError,
  type NativeAgentService,
} from "./native-agent-service.js";
import { addressFindingsReportPrompt } from "./build-pipeline-prompts.js";
import { MULTI_REVIEW_INTERACTIVE_ADDRESS_FINDINGS } from "./multi-review-steps.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("review");

export class MissingMultiReviewAddressFindingsSessionError extends Error {
  constructor() {
    super("The consolidation session is no longer available");
    this.name = "MissingMultiReviewAddressFindingsSessionError";
  }
}

export class InvalidMultiReviewAddressFindingsStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMultiReviewAddressFindingsStateError";
  }
}

export class MultiReviewAddressFindingsDispatchError extends Error {
  constructor(
    message: string,
    readonly preparedSession?: MultiReviewAddressFindingsSession,
  ) {
    super(message);
    this.name = "MultiReviewAddressFindingsDispatchError";
  }
}

export interface MultiReviewAddressFindingsDispatchResult {
  fixSession: MultiReviewAddressFindingsSession;
  tabId: string;
  presentationError?: string;
}

export interface MultiReviewAddressFindingsSessionReplacement {
  expectedProviderSessionId: string;
  replacementProviderSessionId: string;
  tabId: string;
}

type AddressFindingsNativeAgents = Pick<
  NativeAgentService,
  "adoptSession" | "ensureSession" | "dispatchIntent"
>;

function replacementRequestId(workflow: MultiReviewWorkflow, providerSessionId: string): string {
  const replacement = createHash("sha256").update(providerSessionId).digest("hex").slice(0, 24);
  return `multi-review-address-replacement:${workflow.id}:${replacement}`;
}

/**
 * Rebind an Address Findings tab whose provider rollout disappeared and seed the replacement
 * with the authoritative consolidated report before the renderer can use it.
 */
export async function recoverMissingMultiReviewAddressFindingsSession(
  nativeAgents: AddressFindingsNativeAgents,
  workflow: MultiReviewWorkflow,
  replacement: MultiReviewAddressFindingsSessionReplacement,
): Promise<MultiReviewAddressFindingsDispatchResult> {
  const session = workflow.fixSession;
  if (
    workflow.phase !== "interactive" ||
    !workflow.consolidatedReport ||
    !session ||
    session.providerSessionId !== replacement.expectedProviderSessionId
  ) {
    throw new InvalidMultiReviewAddressFindingsStateError(
      "The Multi Review Address Findings session replacement no longer matches the workflow",
    );
  }
  const expectedTabId =
    workflow.fixTabId ?? workflow.addressTabId ?? `multi-review-fix:${workflow.id}`;
  if (replacement.tabId !== expectedTabId) {
    throw new InvalidMultiReviewAddressFindingsStateError(
      "The Multi Review Address Findings session replacement targeted an unexpected tab",
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
    interactionPolicy: MULTI_REVIEW_INTERACTIVE_ADDRESS_FINDINGS.interactionPolicy,
    title: MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
    model,
    reasoningEffort: workflow.fixModel.reasoningEffort,
    ...(typeof session.fastMode === "boolean"
      ? { fastMode: session.fastMode }
      : typeof workflow.fixModel.fastMode === "boolean"
        ? { fastMode: workflow.fixModel.fastMode }
        : {}),
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
    prompt: `${addressFindingsReportPrompt(workflow.consolidatedReport)}\n\n${wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION)}`,
    requestId,
    mode: MULTI_REVIEW_INTERACTIVE_ADDRESS_FINDINGS.mode,
  });
  if (outcome.outcome !== "accepted") {
    throw new MultiReviewAddressFindingsDispatchError(
      outcome.error ?? "The replacement Address Findings session prompt was not confirmed",
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

interface AddressFindingsTabPublisher {
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
export async function dispatchMultiReviewAddressFindingsPrompt(
  nativeAgents: AddressFindingsNativeAgents,
  workflow: MultiReviewWorkflow,
  tabs?: AddressFindingsTabPublisher,
  activateTab = false,
): Promise<MultiReviewAddressFindingsDispatchResult> {
  const session = workflow.fixSession;
  const selection = workflow.customFixModel ?? workflow.fixModel;
  const customAddressFindings = workflow.customFixInstruction !== undefined;
  const createsFreshAddressFindingsSession = Boolean(workflow.reviewModel || customAddressFindings);
  if (createsFreshAddressFindingsSession && workflow.consolidatedReport === undefined) {
    throw new InvalidMultiReviewAddressFindingsStateError(
      "The consolidated review report is missing from the Address Findings request",
    );
  }
  const logicalSessionKey = workflow.addressSessionKey ?? `multi-review:${workflow.id}:interactive`;
  const model = selection.model === "default" ? undefined : selection.model;
  const identity = {
    environmentId: workflow.environmentId,
    agent: selection.agent,
    logicalSessionKey,
    origin: "interactive-native" as const,
    interactionPolicy: MULTI_REVIEW_INTERACTIVE_ADDRESS_FINDINGS.interactionPolicy,
    title: MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
    model,
    reasoningEffort: selection.reasoningEffort,
    ...(typeof selection.fastMode === "boolean" ? { fastMode: selection.fastMode } : {}),
    phase: "fix" as const,
    sessionMode: "build" as const,
  };
  const tab = {
    environmentId: workflow.environmentId,
    tabId: workflow.addressTabId ?? `multi-review-fix:${workflow.id}`,
    agent: selection.agent,
    title: MULTI_REVIEW_ADDRESS_FINDINGS_TAB_TITLE,
    isReviewTab: true,
    activate: activateTab,
  };
  // Preparation and consolidation deliberately live in a different provider
  // session. The Address Findings handoff always creates (or reuses by logical key) its own
  // interactive session so opening Address Findings can never expose the review coordinator
  // conversation.
  let providerSessionId: string;
  if (createsFreshAddressFindingsSession) {
    const ensured = await nativeAgents.ensureSession(identity);
    providerSessionId = ensured.providerSessionId;
  } else {
    if (!session) throw new MissingMultiReviewAddressFindingsSessionError();
    try {
      await nativeAgents.adoptSession({
        ...identity,
        providerSessionId: session.providerSessionId,
      });
      providerSessionId = session.providerSessionId;
    } catch (error) {
      if (error instanceof NativeAgentProviderSessionMissingError) {
        throw new MissingMultiReviewAddressFindingsSessionError();
      }
      throw error;
    }
  }
  const requestId = workflow.addressRequestId ?? `multi-review-address:${workflow.id}`;
  const prompt = customAddressFindings
    ? multiReviewCustomAddressFindingsPrompt(
        workflow.consolidatedReport!,
        workflow.customFixInstruction!,
      )
    : createsFreshAddressFindingsSession
      ? addressFindingsReportPrompt(workflow.consolidatedReport!)
      : MULTI_REVIEW_ADDRESS_FINDINGS_PROMPT;
  const preparedSession: MultiReviewAddressFindingsSession | undefined =
    createsFreshAddressFindingsSession
      ? {
          ...selection,
          sessionKey: logicalSessionKey,
          providerSessionId,
          requestIds: session?.requestIds?.includes(requestId)
            ? session.requestIds
            : [...(session?.requestIds?.slice(-255) ?? []), requestId],
          status: "idle",
          startedAt: new Date().toISOString(),
        }
      : undefined;
  let outcome: Awaited<ReturnType<AddressFindingsNativeAgents["dispatchIntent"]>>;
  try {
    outcome = await nativeAgents.dispatchIntent({
      ...identity,
      prompt,
      requestId,
      mode: MULTI_REVIEW_INTERACTIVE_ADDRESS_FINDINGS.mode,
    });
  } catch (error) {
    throw new MultiReviewAddressFindingsDispatchError(
      error instanceof Error ? error.message : String(error),
      preparedSession,
    );
  }
  if (outcome.outcome !== "accepted") {
    throw new MultiReviewAddressFindingsDispatchError(
      outcome.error ?? "The address prompt dispatch was not confirmed",
      preparedSession,
    );
  }

  // Publish only after the intended prompt is authoritative. Exposing the
  // session sooner lets a user submit another turn before the Address Findings request.
  let presentationError: string | undefined;
  try {
    await tabs?.ensureNativeAgentJobTab({ ...tab, providerSessionId });
  } catch (error) {
    presentationError =
      "The Address Findings request was delivered, but its tab could not be opened. Close another tab if needed, then use Open Address Findings session.";
    log.warn("fix-tab.publish-failed", { error: formatLogError(error) });
  }
  return {
    fixSession: preparedSession ?? session!,
    tabId: tab.tabId,
    ...(presentationError ? { presentationError } : {}),
  };
}
