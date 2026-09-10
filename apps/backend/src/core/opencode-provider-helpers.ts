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

/**
 * OpenCode's permission ids for the tools a read-only coordinator may use.
 *
 * The base rule for a coordinator is `{"*": deny}`, so without an explicit
 * allow list here the session could not even read a file — which is the one
 * thing a coordinator is for.
 */
const OPENCODE_READ_ONLY_PERMISSIONS = Object.freeze([
  "read",
  "list",
  "glob",
  "grep",
  "todoread",
  "todowrite",
  "task",
]);

/** Per-message tool mask for a structured report turn that must not mutate state. */
export const OPENCODE_READ_ONLY_TURN_TOOLS: Readonly<Record<string, boolean>> = Object.freeze({
  write: false,
  edit: false,
  patch: false,
  apply_patch: false,
  bash: false,
  shell: false,
  task: false,
  todowrite: false,
  webfetch: false,
  websearch: false,
});

export function effectiveOpenCodePolicy(
  policy: NativeAgentExecutionPolicy,
): NativeAgentExecutionPolicy {
  return {
    ...policy,
    // OpenCode resolves its session directory from the checkout's own
    // configuration and offers no way to opt out, so this axis cannot be
    // honoured. Reported rather than silently dropped: it is why OpenCode is
    // `provider-configured` and not `enforced`.
    projectResources: true,
    ...(policy.projectResources
      ? {}
      : {
          note:
            policy.id === "coordinator-read-only"
              ? "OpenCode always loads the checkout's project configuration, including any MCP servers it declares."
              : "OpenCode always reads project configuration for its session directory.",
        }),
  };
}

export function openCodePermissionRules(policy: NativeAgentExecutionPolicy) {
  const action =
    policy.approvals === "auto-approve"
      ? ("allow" as const)
      : policy.approvals === "deny"
        ? ("deny" as const)
        : ("ask" as const);
  const coordinatorAllow =
    policy.id === "coordinator-read-only" && !policy.toolPolicy?.allow
      ? OPENCODE_READ_ONLY_PERMISSIONS
      : [];
  return [
    { permission: "*", pattern: "*", action },
    ...[...coordinatorAllow, ...(policy.toolPolicy?.allow ?? [])].map((permission) => ({
      permission,
      pattern: "*",
      action: "allow" as const,
    })),
    // Last, so a deny always wins a collision with the read allowances above.
    ...(policy.toolPolicy?.deny ?? []).map((permission) => ({
      permission,
      pattern: "*",
      action: "deny" as const,
    })),
  ];
}

/**
 * Whole commands a reviewer may run through OpenCode's shell tools.
 *
 * OpenCode patterns are simple globs, not a shell parser. The broad forms are
 * followed by mutation/injection denies below; last match wins in OpenCode.
 */
const OPENCODE_REVIEW_SHELL_ALLOW_PATTERNS = Object.freeze([
  "pwd",
  "ls",
  "ls *",
  "cat *",
  "head *",
  "tail *",
  "wc *",
  "stat *",
  "grep *",
  "rg *",
  "find *",
  "git status",
  "git status *",
  "git diff",
  "git diff *",
  "git log",
  "git log *",
  "git show",
  "git show *",
  "git blame *",
  "git cat-file *",
  "git describe",
  "git describe *",
  "git grep *",
  "git ls-files",
  "git ls-files *",
  "git ls-tree *",
  "git merge-base *",
  "git name-rev *",
  "git rev-list *",
  "git rev-parse *",
  "git shortlog",
  "git shortlog *",
  "git show-ref",
  "git show-ref *",
  "git whatchanged",
  "git whatchanged *",
]);

/** Later than the allows, so command chaining and write-capable flags lose. */
const OPENCODE_REVIEW_SHELL_DENY_PATTERNS = Object.freeze([
  "*&*",
  "*|*",
  "*;*",
  "*<*",
  "*>*",
  "*`*",
  "*$(*",
  "*\n*",
  "*\r*",
  "*--output *",
  "*--output=*",
  "*-o *",
  "*--ext-diff*",
  "*--textconv*",
  "*--filters*",
  "*--open-files-in-pager*",
  "*--pre*",
  "*--hostname-bin*",
  "*-delete*",
  "*-exec*",
  "*-execdir*",
  "*-fls*",
  "*-fprint*",
  "*-fprintf*",
  "*-ok*",
  "*-okdir*",
]);

function openCodeReviewShellAction(policy: NativeAgentExecutionPolicy): "allow" | "ask" | "deny" {
  const denied = new Set(policy.toolPolicy?.deny ?? []);
  // OpenCode has used both ids for the same capability. A deny under either
  // spelling is a deny under both, including the coordinator's `shell` rule.
  if (denied.has("*") || denied.has("bash") || denied.has("shell")) return "deny";
  const allowed = new Set(policy.toolPolicy?.allow ?? []);
  if (allowed.has("*") || allowed.has("bash") || allowed.has("shell")) return "allow";
  return policy.approvals === "auto-approve"
    ? "allow"
    : policy.approvals === "deny"
      ? "deny"
      : "ask";
}

/** Reviewers inspect evidence through constrained shell commands. */
export function openCodeReviewPermissionRules(policy: NativeAgentExecutionPolicy) {
  const shellAction = openCodeReviewShellAction(policy);
  return [
    ...openCodePermissionRules(policy),
    ...Object.keys(OPENCODE_READ_ONLY_TURN_TOOLS)
      .filter((permission) => permission !== "bash" && permission !== "shell")
      .map((permission) => ({ permission, pattern: "*", action: "deny" as const })),
    ...["bash", "shell"].flatMap((permission) => [
      { permission, pattern: "*", action: "deny" as const },
      ...(shellAction === "deny"
        ? []
        : OPENCODE_REVIEW_SHELL_ALLOW_PATTERNS.map((pattern) => ({
            permission,
            pattern,
            action: shellAction,
          }))),
      ...OPENCODE_REVIEW_SHELL_DENY_PATTERNS.map((pattern) => ({
        permission,
        pattern,
        action: "deny" as const,
      })),
    ]),
  ];
}

/**
 * OpenCode's read-only agent, pinned for coordinator prompts.
 *
 * Its permission rules are the boundary, but the agent selection decides which
 * tools are offered at all, and `build` advertises writing tools the model
 * would then repeatedly try and have denied.
 */
export function openCodeCoordinatorAgent(
  policy: NativeAgentExecutionPolicy | undefined,
): string | undefined {
  return policy?.id === "coordinator-read-only" ? "plan" : undefined;
}

/**
 * The agent a dispatch runs as, with the coordinator override applied.
 *
 * `fallback` is omitted for a slash command, which OpenCode resolves itself:
 * naming "build" there would override a command that declares its own agent.
 */
export function openCodeAgentFor(
  policy: NativeAgentExecutionPolicy | undefined,
  options: { executionAgent?: string; mode?: string },
  fallback?: string,
): string | undefined {
  return openCodeCoordinatorAgent(policy) ?? options.executionAgent ?? options.mode ?? fallback;
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

/**
 * OpenCode reasoning travels as the composer's reasoning selection, never as a
 * model parameter. An earlier catalog briefly advertised a `reasoning`
 * parameter alongside the built-in picker, so sessions from that window can
 * still carry a `parameterValues.reasoning` entry that no control writes or
 * clears any more. Reading it here would let that dead value outrank the
 * picker, so the selection is the only input.
 */
export function openCodeReasoningVariant(
  options: ProviderSendOptions,
  fallback: string | undefined,
): string | undefined {
  const variant = options.effort ?? fallback;
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
