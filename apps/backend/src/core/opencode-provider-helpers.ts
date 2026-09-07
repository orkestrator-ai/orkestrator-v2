import type {
  AgentPartInput,
  FilePartInput,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2/types";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  normalizeOpenCodeModelProviders,
  type NativeAgentExecutionPolicy,
  type NativeAgentResumeEntry,
} from "@orkestrator/protocol/native-agent";
import {
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  type OpenCodeMessageIdCoordinator,
} from "@orkestrator/protocol/opencode-message-id";
import type {
  BridgeConnection,
  ProviderInteractionObservationEvent,
  ProviderSendOptions,
} from "./agent-provider-contract.js";
import { asRecord, assertSdkResponse, nonEmptyString } from "./agent-provider-runtime.js";
import { MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS } from "./opencode-snapshots.js";
import {
  mimeTypeForFilename,
  mimeTypeForImageData,
  promptAttachmentUrl,
} from "./prompt-attachments.js";

export type OpenCodePromptPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MONITOR_RETRY_MS = 1_000;
export const DEFAULT_OPENCODE_EXISTENCE_CACHE_TTL_MS = 10_000;
export const OPENCODE_SUBAGENT_MAX_SESSIONS = 16;
export const OPENCODE_SUBAGENT_MESSAGE_LIMIT = OPEN_CODE_MESSAGE_HISTORY_LIMIT;
export const OPENCODE_SUBAGENT_FETCH_CONCURRENCY = 4;
export const OPENCODE_COMMAND_NAME_TTL_MS = 30_000;

export interface OpenCodeProviderDependencies {
  openCodeClient?: OpencodeClient;
  openCodeClientFactory?: typeof createOpencodeClient;
  openCodeMessageIdCoordinator?: OpenCodeMessageIdCoordinator;
  monitorRetryMs?: number;
  now?: () => number;
  openCodeExistenceCacheTtlMs?: number;
  openCodeStatusReconcileIntervalMs?: number;
  autoAnswerRequests?: boolean;
  onInteractionObservation?: (event: ProviderInteractionObservationEvent) => void | Promise<void>;
  resolveOpenCodeModelProviders?: () =>
    | readonly string[]
    | undefined
    | Promise<readonly string[] | undefined>;
}

export async function optionalOpenCodeSdkCall(
  client: OpencodeClient,
  requestOptions: { signal: AbortSignal },
  namespace: string,
  method: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const owner = asRecord(asRecord(client)?.[namespace]);
  const operation = owner?.[method];
  if (typeof operation !== "function") return { data: {} };
  return (
    operation as (parameters: Record<string, unknown>, options: unknown) => Promise<unknown>
  ).call(owner, parameters, requestOptions);
}

export async function resolveAllowedOpenCodeModelProviders(
  resolveProviders: OpenCodeProviderDependencies["resolveOpenCodeModelProviders"],
): Promise<readonly string[]> {
  if (!resolveProviders) return DEFAULT_OPENCODE_MODEL_PROVIDERS;
  try {
    return normalizeOpenCodeModelProviders(await resolveProviders());
  } catch {
    return DEFAULT_OPENCODE_MODEL_PROVIDERS;
  }
}

export async function listOpenCodeResumableSessions(
  client: OpencodeClient,
  directory: string | undefined,
  requestOptions: { signal: AbortSignal },
): Promise<NativeAgentResumeEntry[]> {
  const response = await client.session.list(
    { directory, limit: MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS },
    requestOptions,
  );
  assertSdkResponse(response, "OpenCode resumable session list");
  if (!Array.isArray(response.data)) return [];
  return response.data.slice(0, 512).flatMap((candidate) => {
    const session = asRecord(candidate);
    const id = nonEmptyString(session?.id);
    if (!id) return [];
    const time = asRecord(session?.time);
    const toIso = (value: unknown) => {
      const date = typeof value === "number" || typeof value === "string" ? new Date(value) : null;
      return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
    };
    const createdAt = toIso(time?.created);
    const updatedAt = toIso(time?.updated);
    return [
      {
        sessionId: id,
        ...(typeof session?.title === "string" ? { title: session.title } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      },
    ];
  });
}

export function openCodeRequestOptions(
  connection: BridgeConnection,
  monitorSignal: AbortSignal,
): { signal: AbortSignal } {
  const timeoutMs = Math.max(1, connection.requestTimeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS);
  return { signal: AbortSignal.any([monitorSignal, AbortSignal.timeout(timeoutMs)]) };
}

export function effectiveOpenCodePolicy(
  policy: NativeAgentExecutionPolicy,
): NativeAgentExecutionPolicy {
  if (policy.id === "coordinator-read-only" && !policy.projectResources) {
    throw new Error("OpenCode cannot enforce the coordinator project-resource boundary");
  }
  return {
    ...policy,
    projectResources: true,
    ...(policy.projectResources
      ? {}
      : { note: "OpenCode always reads project configuration for its session directory." }),
  };
}

export function openCodePermissionRules(policy: NativeAgentExecutionPolicy) {
  const action =
    policy.approvals === "auto-approve"
      ? ("allow" as const)
      : policy.approvals === "deny"
        ? ("deny" as const)
        : ("ask" as const);
  return [
    { permission: "*", pattern: "*", action },
    ...(policy.toolPolicy?.allow ?? []).map((permission) => ({
      permission,
      pattern: "*",
      action: "allow" as const,
    })),
    ...(policy.toolPolicy?.deny ?? []).map((permission) => ({
      permission,
      pattern: "*",
      action: "deny" as const,
    })),
  ];
}

export function openCodePromptParts(
  prompt: string,
  options: ProviderSendOptions,
): OpenCodePromptPart[] {
  const parts: OpenCodePromptPart[] = [{ type: "text", text: prompt }];
  for (const image of options.images ?? []) {
    const mimeType = mimeTypeForImageData(image.filename, image.data);
    parts.push({
      type: "file",
      mime: mimeType,
      filename: image.filename,
      url: `data:${mimeType};base64,${image.data}`,
    });
  }
  for (const attachment of options.attachments ?? []) {
    parts.push({
      type: "file",
      mime: mimeTypeForFilename(attachment.filename ?? attachment.path),
      filename: attachment.filename,
      url: promptAttachmentUrl(attachment),
    });
  }
  return parts;
}

export function openCodeFileParts(parts: OpenCodePromptPart[]): FilePartInput[] {
  return parts.filter((part): part is FilePartInput => part.type === "file");
}

export function openCodeModelSelection(model: string | undefined) {
  const segments = model?.split("/");
  return segments && segments.length > 1
    ? { providerID: segments[0]!, modelID: segments.slice(1).join("/") }
    : undefined;
}

export function openCodeReasoningVariant(
  options: ProviderSendOptions,
  fallback: string | undefined,
): string | undefined {
  const variant =
    typeof options.parameterValues?.reasoning === "string"
      ? options.parameterValues.reasoning
      : (options.effort ?? fallback);
  return variant === "default" ? undefined : variant;
}

export function openCodeMessageIdScope(connection: BridgeConnection, sessionId: string): string {
  return JSON.stringify([connection.baseUrl, connection.directory, sessionId]);
}

export function waitForOpenCodeRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
