import {
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  isAgentInteractionPolicy,
  type AgentInteractionOrigin,
  type AgentInteractionPolicy,
} from "@orkestrator/protocol/agent-interactions";
import { parseNativeAgentCommandIntent } from "@orkestrator/protocol/agent-command-catalogue";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { isNativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { isTrustedUserPromptPresentation } from "@orkestrator/protocol/review-evidence-frames";
import { isAgentSessionOwner } from "@orkestrator/protocol/coordinator";
import { NATIVE_AGENT_SESSION_VERSION, type PersistedNativeAgentSession } from "./models.js";
import { isNonBlankString, isRecord } from "./storage-shared-core.js";

export const MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES = 32 * 1024 * 1024;
// Worst-case JSON escaping for a 64 KiB instruction plus bounded ids and fields.
export const MAX_PERSISTED_NATIVE_AGENT_PENDING_STEER_BYTES = 400 * 1024;

export function isPersistedNativeAgentSession(
  value: unknown,
  expectedKey?: string,
): value is PersistedNativeAgentSession {
  return (
    isRecord(value) &&
    value.version === NATIVE_AGENT_SESSION_VERSION &&
    isNonBlankString(value.key) &&
    (expectedKey === undefined || value.key === expectedKey) &&
    isNonBlankString(value.environmentId) &&
    isAgentPlatform(value.agent) &&
    isNonBlankString(value.logicalSessionKey) &&
    isNonBlankString(value.providerSessionId) &&
    (value.owner === undefined || isAgentSessionOwner(value.owner)) &&
    (value.executionPolicy === undefined || value.executionPolicy === "coordinator-read-only") &&
    (value.policy === undefined || isNativeAgentExecutionPolicy(value.policy)) &&
    (value.initialPromptPresentation === undefined ||
      isTrustedUserPromptPresentation(value.initialPromptPresentation)) &&
    (value.origin === "interactive-native" ||
      value.origin === "interactive-tmux" ||
      value.origin === "coordinator" ||
      value.origin === "build-pipeline" ||
      value.origin === "automated-review") &&
    isAgentInteractionPolicy(value.interactionPolicy) &&
    (value.inferredComposerSelection === undefined ||
      (isRecord(value.inferredComposerSelection) &&
        Object.keys(value.inferredComposerSelection).every(
          (key) => key === "modelId" || key === "reasoningId",
        ) &&
        isNonBlankString(value.inferredComposerSelection.modelId) &&
        (value.inferredComposerSelection.reasoningId === undefined ||
          isNonBlankString(value.inferredComposerSelection.reasoningId)))) &&
    (value.controls === undefined ||
      (isRecord(value.controls) &&
        Object.keys(value.controls).every(
          (key) =>
            key === "modelId" ||
            key === "reasoningId" ||
            key === "fastMode" ||
            key === "mode" ||
            key === "executionProfileId" ||
            key === "includeLocalSettings" ||
            key === "promptSuggestions" ||
            key === "parameterValues" ||
            key === "persistDefaults" ||
            key === "approvalMode",
        ) &&
        (value.controls.modelId === undefined || isNonBlankString(value.controls.modelId)) &&
        (value.controls.reasoningId === undefined ||
          isNonBlankString(value.controls.reasoningId)) &&
        (value.controls.fastMode === undefined || typeof value.controls.fastMode === "boolean") &&
        (value.controls.executionProfileId === undefined ||
          value.controls.executionProfileId === null ||
          isNonBlankString(value.controls.executionProfileId)) &&
        (value.controls.includeLocalSettings === undefined ||
          typeof value.controls.includeLocalSettings === "boolean") &&
        (value.controls.promptSuggestions === undefined ||
          typeof value.controls.promptSuggestions === "boolean") &&
        (value.controls.persistDefaults === undefined ||
          typeof value.controls.persistDefaults === "boolean") &&
        (value.controls.approvalMode === undefined ||
          isNonBlankString(value.controls.approvalMode)) &&
        (value.controls.parameterValues === undefined ||
          (isRecord(value.controls.parameterValues) &&
            Object.keys(value.controls.parameterValues).length <= 64 &&
            Object.entries(value.controls.parameterValues).every(
              ([key, candidate]) =>
                key.length > 0 &&
                key.length <= 128 &&
                (typeof candidate === "boolean" ||
                  (typeof candidate === "string" && candidate.length <= 1_024)),
            ))) &&
        (value.controls.mode === undefined ||
          value.controls.mode === "build" ||
          value.controls.mode === "plan"))) &&
    (value.dispatchedRequestIds === undefined ||
      (Array.isArray(value.dispatchedRequestIds) &&
        value.dispatchedRequestIds.length <= 1_000 &&
        value.dispatchedRequestIds.every(isNonBlankString))) &&
    (value.pendingDispatch === undefined ||
      (isRecord(value.pendingDispatch) &&
        (value.pendingDispatch.mailRefused === undefined ||
          value.pendingDispatch.mailRefused === true) &&
        isNonBlankString(value.pendingDispatch.requestId) &&
        isNonBlankString(value.pendingDispatch.prompt) &&
        typeof value.pendingDispatch.createdAt === "string" &&
        Number.isFinite(Date.parse(value.pendingDispatch.createdAt)) &&
        (value.pendingDispatch.model === undefined ||
          isNonBlankString(value.pendingDispatch.model)) &&
        (value.pendingDispatch.reasoningEffort === undefined ||
          isNonBlankString(value.pendingDispatch.reasoningEffort)) &&
        (value.pendingDispatch.mode === undefined ||
          value.pendingDispatch.mode === "plan" ||
          value.pendingDispatch.mode === "build") &&
        (value.pendingDispatch.fastMode === undefined ||
          typeof value.pendingDispatch.fastMode === "boolean") &&
        (value.pendingDispatch.subAgent === undefined ||
          isNonBlankString(value.pendingDispatch.subAgent)) &&
        (value.pendingDispatch.executionAgent === undefined ||
          isNonBlankString(value.pendingDispatch.executionAgent)) &&
        (value.pendingDispatch.includeLocalSettings === undefined ||
          typeof value.pendingDispatch.includeLocalSettings === "boolean") &&
        (value.pendingDispatch.promptSuggestions === undefined ||
          typeof value.pendingDispatch.promptSuggestions === "boolean") &&
        (value.pendingDispatch.schema === undefined || isRecord(value.pendingDispatch.schema)) &&
        (value.pendingDispatch.command === undefined ||
          parseNativeAgentCommandIntent(value.pendingDispatch.command) !== undefined) &&
        (value.pendingDispatch.images === undefined ||
          (Array.isArray(value.pendingDispatch.images) &&
            value.pendingDispatch.images.length <= 64 &&
            value.pendingDispatch.images.every(
              (image) =>
                isRecord(image) && isNonBlankString(image.filename) && isNonBlankString(image.data),
            ))) &&
        (value.pendingDispatch.attachments === undefined ||
          (Array.isArray(value.pendingDispatch.attachments) &&
            value.pendingDispatch.attachments.length <= 64 &&
            value.pendingDispatch.attachments.every(
              (attachment) =>
                isRecord(attachment) &&
                (attachment.type === "image" || attachment.type === "file") &&
                isNonBlankString(attachment.path) &&
                (attachment.dataUrl === undefined || typeof attachment.dataUrl === "string") &&
                (attachment.filename === undefined || typeof attachment.filename === "string"),
            ))) &&
        (() => {
          try {
            return (
              Buffer.byteLength(JSON.stringify(value.pendingDispatch), "utf8") <=
              MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES
            );
          } catch {
            return false;
          }
        })())) &&
    (value.pendingSteer === undefined ||
      (isRecord(value.pendingSteer) &&
        isNonBlankString(value.pendingSteer.requestId) &&
        Buffer.byteLength(value.pendingSteer.requestId, "utf8") <= 512 &&
        isNonBlankString(value.pendingSteer.text) &&
        Buffer.byteLength(value.pendingSteer.text, "utf8") <= 64 * 1024 &&
        isNonBlankString(value.pendingSteer.inputDigest) &&
        /^[a-f0-9]{64}$/.test(value.pendingSteer.inputDigest) &&
        isNonBlankString(value.pendingSteer.expectedRunId) &&
        Buffer.byteLength(value.pendingSteer.expectedRunId, "utf8") <= 512 &&
        (value.pendingSteer.state === "prepared" || value.pendingSteer.state === "unknown") &&
        (value.pendingSteer.sourceQueue === undefined || value.pendingSteer.sourceQueue === true) &&
        (value.pendingSteer.queueSettlement === undefined ||
          (value.pendingSteer.sourceQueue === true &&
            typeof value.pendingSteer.queueSettlement === "string" &&
            ["applied", "restore", "discard"].includes(value.pendingSteer.queueSettlement))) &&
        typeof value.pendingSteer.createdAt === "string" &&
        Number.isFinite(Date.parse(value.pendingSteer.createdAt)) &&
        (() => {
          try {
            return (
              Buffer.byteLength(JSON.stringify(value.pendingSteer), "utf8") <=
              MAX_PERSISTED_NATIVE_AGENT_PENDING_STEER_BYTES
            );
          } catch {
            return false;
          }
        })())) &&
    (value.openCodeIncompleteTurnNotice === undefined ||
      (isRecord(value.openCodeIncompleteTurnNotice) &&
        (value.openCodeIncompleteTurnNotice.kind === "failed" ||
          value.openCodeIncompleteTurnNotice.kind === "exhausted") &&
        isNonBlankString(value.openCodeIncompleteTurnNotice.assistantMessageId) &&
        typeof value.openCodeIncompleteTurnNotice.updatedAt === "string" &&
        Number.isFinite(Date.parse(value.openCodeIncompleteTurnNotice.updatedAt)))) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

/** Restores pre-policy records without changing provider or dispatch identity. */
export function migratePersistedNativeAgentSession(
  value: unknown,
  expectedKey: string,
): PersistedNativeAgentSession | null {
  if (isPersistedNativeAgentSession(value, expectedKey)) return value;
  if (!isRecord(value)) return null;
  if (
    value.version !== undefined ||
    value.origin !== undefined ||
    value.interactionPolicy !== undefined
  ) {
    return null;
  }
  const migrated = {
    ...value,
    version: NATIVE_AGENT_SESSION_VERSION,
    origin: "interactive-native",
    interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
  };
  return isPersistedNativeAgentSession(migrated, expectedKey) ? migrated : null;
}

export interface LoadedNativeAgentSessions {
  /** Records this build can read. */
  sessions: Record<string, PersistedNativeAgentSession>;
  /** Records this build cannot read, preserved verbatim and never reused. */
  opaque: Record<string, unknown>;
}

export function resolveNativeAgentInteractionMetadata(input: {
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
}): Pick<PersistedNativeAgentSession, "origin" | "interactionPolicy"> | null {
  const origin = input.origin ?? "interactive-native";
  const interactionPolicy =
    input.interactionPolicy ??
    (origin === "build-pipeline" || origin === "automated-review"
      ? UNATTENDED_AGENT_INTERACTION_POLICY
      : INTERACTIVE_AGENT_INTERACTION_POLICY);
  if (
    ![
      "interactive-native",
      "interactive-tmux",
      "coordinator",
      "build-pipeline",
      "automated-review",
    ].includes(origin) ||
    !isAgentInteractionPolicy(interactionPolicy) ||
    (origin === "build-pipeline" || origin === "automated-review") !==
      (interactionPolicy.mode === "unattended")
  ) {
    return null;
  }
  return { origin, interactionPolicy };
}
