import { wrapSystemInstructions } from "@orkestrator/protocol/review-evidence-frames";
import {
  MULTI_REVIEW_ADDRESS_FINDINGS_TAB_TITLE,
  MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION,
  MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
  multiReviewAddressFindingsPrompt,
  multiReviewCustomAddressFindingsPrompt,
  type MultiReviewAddressFindingsSession,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { createHash } from "node:crypto";
import { recordedAddressFindingsPreExistingFailurePolicy } from "@orkestrator/protocol/address-findings-pre-existing";
import {
  NativeAgentProviderSessionMissingError,
  type NativeAgentService,
} from "../native-agent/service.js";
import {
  addressFindingsReportPrompt,
  multiReviewAddressFindingsValidationInstruction,
} from "../build-pipeline/index.js";
import { MULTI_REVIEW_INTERACTIVE_ADDRESS_FINDINGS } from "./steps.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  verifyAddressFindingsValidation,
  type AddressFindingsPackageVerifier,
} from "./address-findings-validation.js";

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
  addressFindingsSession: MultiReviewAddressFindingsSession;
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

/**
 * The round's recorded validation and the pipeline's rule for repairing it,
 * judged against this branch's changes (Multi Review has no ticket). Empty for
 * a review persisted without a package. `includeRerunRule` is false only for
 * {@link addressFindingsReportPrompt}, whose tail already says which recorded
 * commands to rerun.
 */
async function validationInstruction(
  workflow: MultiReviewWorkflow,
  includeRerunRule: boolean,
  verify: AddressFindingsPackageVerifier | undefined,
): Promise<string> {
  const checks = await verifyAddressFindingsValidation(
    workflow.environmentId,
    workflow.reviewPackage,
    verify,
  );
  return multiReviewAddressFindingsValidationInstruction(
    workflow.reviewPackage,
    workflow.targetBranch,
    includeRerunRule,
    checks,
    // The policy the launch recorded when it started, never the live setting.
    recordedAddressFindingsPreExistingFailurePolicy(workflow.addressFindingsPreExistingFailures),
  );
}

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
  verifyPackage?: AddressFindingsPackageVerifier,
): Promise<MultiReviewAddressFindingsDispatchResult> {
  const session = workflow.addressFindingsSession;
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
    workflow.addressFindingsTabId ?? workflow.addressTabId ?? `multi-review-fix:${workflow.id}`;
  if (replacement.tabId !== expectedTabId) {
    throw new InvalidMultiReviewAddressFindingsStateError(
      "The Multi Review Address Findings session replacement targeted an unexpected tab",
    );
  }
  const validation = await validationInstruction(workflow, false, verifyPackage);
  const interactiveSessionKeyPrefix = `multi-review:${workflow.id}:interactive`;
  const logicalSessionKey =
    workflow.addressSessionKey ??
    (session.sessionKey.startsWith(interactiveSessionKeyPrefix)
      ? session.sessionKey
      : interactiveSessionKeyPrefix);
  const model =
    workflow.addressFindingsModel.model === "default"
      ? undefined
      : workflow.addressFindingsModel.model;
  const identity = {
    environmentId: workflow.environmentId,
    agent: workflow.addressFindingsModel.agent,
    logicalSessionKey,
    origin: "interactive-native" as const,
    interactionPolicy: MULTI_REVIEW_INTERACTIVE_ADDRESS_FINDINGS.interactionPolicy,
    title: MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
    model,
    reasoningEffort: workflow.addressFindingsModel.reasoningEffort,
    ...(typeof session.fastMode === "boolean"
      ? { fastMode: session.fastMode }
      : typeof workflow.addressFindingsModel.fastMode === "boolean"
        ? { fastMode: workflow.addressFindingsModel.fastMode }
        : {}),
    phase: "address-findings" as const,
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
    prompt: `${addressFindingsReportPrompt(workflow.consolidatedReport, validation)}\n\n${wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION)}`,
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
    addressFindingsSession: {
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
    agent: MultiReviewWorkflow["addressFindingsModel"]["agent"];
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
  verifyPackage?: AddressFindingsPackageVerifier,
): Promise<MultiReviewAddressFindingsDispatchResult> {
  const session = workflow.addressFindingsSession;
  const selection = workflow.customAddressFindingsModel ?? workflow.addressFindingsModel;
  const customAddressFindings = workflow.customAddressFindingsInstruction !== undefined;
  const createsFreshAddressFindingsSession = Boolean(workflow.reviewModel || customAddressFindings);
  if (createsFreshAddressFindingsSession && workflow.consolidatedReport === undefined) {
    throw new InvalidMultiReviewAddressFindingsStateError(
      "The consolidated review report is missing from the Address Findings request",
    );
  }
  const validation = await validationInstruction(
    workflow,
    customAddressFindings || !createsFreshAddressFindingsSession,
    verifyPackage,
  );
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
    phase: "address-findings" as const,
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
        workflow.customAddressFindingsInstruction!,
        validation,
      )
    : createsFreshAddressFindingsSession
      ? addressFindingsReportPrompt(workflow.consolidatedReport!, validation)
      : multiReviewAddressFindingsPrompt(validation);
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
    addressFindingsSession: preparedSession ?? session!,
    tabId: tab.tabId,
    ...(presentationError ? { presentationError } : {}),
  };
}
