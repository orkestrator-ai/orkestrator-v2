import type {
  AgentPartInput,
  FilePartInput,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2/types";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  appendNativeAgentPolicyNote,
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  nativeAgentPolicyDeniesNetwork,
  nativeAgentPolicyDeniesWebSearch,
  normalizeOpenCodeModelProviders,
  withoutProviderSandbox,
  type NativeAgentExecutionPolicy,
  type NativeAgentDefaultModelResolution,
  type NativeAgentResumeEntry,
} from "@orkestrator/protocol/native-agent";
import {
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  type OpenCodeMessageIdCoordinator,
} from "@orkestrator/protocol/opencode-message-id";
import {
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_MCP_SERVER_NAME,
  REPORT_FINDING_TOOL_NAME,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
import type { BridgeConnection, ProviderSendOptions } from "./agent-provider-contract.js";
import { PromptRejectedError } from "./agent-provider-contract.js";
import { asRecord, assertSdkResponse, nonEmptyString } from "./agent-provider-runtime.js";
import {
  normalizeOpenCodeComposerCatalog,
  selectOpenCodeComposerCatalog,
  openCodeModelDispatchability,
  openCodeSessionModelRef,
} from "./opencode-model-catalog.js";
import type { OpenCodeCommandChangeOptions } from "./opencode-command-changes.js";
import { COORDINATOR_CONTROL_TOOL_NAMES } from "@orkestrator/protocol/coordinator";
import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import { ARTIFACT_TOOL_NAMES } from "@orkestrator/protocol/transcript-artifacts";
import { ORKESTRATOR_AGENT_MCP_SERVER_NAME } from "./agent-tools.js";
import { MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS } from "./opencode-snapshots.js";
import {
  mimeTypeForFilename,
  mimeTypeForImageData,
  promptAttachmentUrl,
  type PromptAttachment,
} from "./prompt-attachments.js";

export type OpenCodePromptPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MONITOR_RETRY_MS = 1_000;
/**
 * Repeated monitor failures back off to at most this multiple of the initial
 * retry (30 s by default), and a stream must stay up this long before the
 * next failure counts as a first failure again.
 */
export const MONITOR_RETRY_CAP_FACTOR = 30;
export const MONITOR_HEALTHY_AFTER_MS = 30_000;
export const DEFAULT_OPENCODE_EXISTENCE_CACHE_TTL_MS = 10_000;
export const OPENCODE_SUBAGENT_MAX_SESSIONS = 16;
export const OPENCODE_SUBAGENT_MESSAGE_LIMIT = OPEN_CODE_MESSAGE_HISTORY_LIMIT;
export const OPENCODE_SUBAGENT_FETCH_CONCURRENCY = 4;

export interface OpenCodeProviderDependencies {
  openCodeClient?: OpencodeClient;
  openCodeClientFactory?: typeof createOpencodeClient;
  openCodeMessageIdCoordinator?: OpenCodeMessageIdCoordinator;
  /** First reconnect delay of the event monitor; repeated failures back off from it. */
  monitorRetryMs?: number;
  /** Upper bound of the monitor's reconnect backoff. */
  monitorRetryMaxMs?: number;
  /** Jitter source for the monitor's reconnect backoff; uniform in [0, 1). */
  monitorRetryRandom?: () => number;
  /** Test seam for the monitor's cancellable reconnect wait. */
  waitForMonitorRetry?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  openCodeExistenceCacheTtlMs?: number;
  openCodeStatusReconcileIntervalMs?: number;
  /** See `ProviderCommonDependencies.onObservationHint`. */
  onObservationHint?: (sessionId: string | undefined) => void;
  resolveOpenCodeModelProviders?: () =>
    | readonly string[]
    | undefined
    | Promise<readonly string[] | undefined>;
  /**
   * Measure what each shell call changed in the worktree (the row's +N −M
   * badge). Opt-in, and effective only when the connection names a
   * `directory` this backend can read: see `opencode-command-changes.ts`.
   */
  commandChanges?: OpenCodeCommandChangeOptions;
  /** A coordinator's research tool ids, read when permission rules are built. */
  coordinatorResearchToolIds?: () => readonly string[];
  ensureCoordinatorResearch?: () => Promise<void>;
  invalidateCoordinatorResearch?: () => void;
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

/**
 * `promptAsync` returns before OpenCode resolves the requested model. When a
 * provider is disconnected, OpenCode can therefore accept and persist only
 * the user message, publish a transient error, and leave the session idle.
 * Preflight the live connectivity snapshot so that failure is definitive and
 * no apparently stuck turn is created.
 *
 * The preflight only ever *rejects* on the positive signal it exists for: a
 * catalogue that was read successfully and that reports the selected model's
 * provider as not connected. An unreadable catalogue — a thrown transport
 * error, a timeout, an error envelope, or a build that does not serve
 * `/provider` — is no evidence about the model, so dispatch proceeds. Failing
 * closed there would let one flaky read on a *secondary* endpoint block every
 * prompt, which is strictly worse than the stuck turn this guards against;
 * the provider's catalogue read tolerates the same call failing for the same
 * reason.
 */
export async function preflightOpenCodeModel(input: {
  client: OpencodeClient;
  model: string | undefined;
  defaultModelId?: string;
  requestOptions: { signal: AbortSignal };
  allowedProviders: () => Promise<readonly string[]>;
  publishCatalog: (
    catalog: ReturnType<typeof normalizeOpenCodeComposerCatalog>,
    allowedProviders: readonly string[],
  ) => void;
}): Promise<void> {
  if (!input.model || !input.model.includes("/")) return;
  const provider = asRecord(asRecord(input.client)?.provider);
  if (typeof provider?.list !== "function") return;
  let response: unknown;
  try {
    response = await (
      provider.list as (parameters: Record<string, unknown>, options: unknown) => Promise<unknown>
    ).call(provider, {}, input.requestOptions);
  } catch {
    return;
  }
  const envelope = asRecord(response);
  if (envelope?.error) return;
  const allowedProviders = await input.allowedProviders();
  const catalog = normalizeOpenCodeComposerCatalog(envelope?.data ?? {}, allowedProviders, {
    requireConnected: true,
    configuredModelId: input.defaultModelId,
  });
  if (catalog.connectedProviderIds !== undefined || catalog.models.length > 0) {
    input.publishCatalog(catalog, allowedProviders);
  }
  if (openCodeModelDispatchability(envelope?.data ?? {}, input.model) === "unavailable") {
    throw new PromptRejectedError(
      "The selected OpenCode model is not connected or is no longer available. Choose an available model and retry.",
    );
  }
}

/** Read the effective config alongside the provider catalogue, with legacy fallback. */
export async function readOpenCodeComposerCatalog(
  client: OpencodeClient,
  requestOptions: { signal: AbortSignal },
  allowedProviders: readonly string[],
  options: { requireConnected: boolean; priorityProviders: readonly string[] },
): Promise<ReturnType<typeof normalizeOpenCodeComposerCatalog>> {
  const [providerResult, fallbackResult, configResult] = await Promise.allSettled([
    optionalOpenCodeSdkCall(client, requestOptions, "provider", "list", {}),
    optionalOpenCodeSdkCall(client, requestOptions, "config", "providers", {}),
    optionalOpenCodeSdkCall(client, requestOptions, "config", "get", {}),
  ]);
  const payload = (result: PromiseSettledResult<unknown>): unknown =>
    result.status === "fulfilled" ? (asRecord(result.value)?.data ?? {}) : {};
  const configuredModelId = nonEmptyString(asRecord(payload(configResult))?.model) ?? undefined;
  return selectOpenCodeComposerCatalog(
    payload(providerResult),
    () => payload(fallbackResult),
    allowedProviders,
    { ...options, configuredModelId },
  );
}

/** Recover the durable selection before resolving a model-less send's default. */
export async function resolveOpenCodePromptModel(
  client: OpencodeClient,
  sessionId: string,
  selectedModel: string | undefined,
  requestOptions: { signal: AbortSignal },
  resolveDefaultModel: () => Promise<NativeAgentDefaultModelResolution>,
): Promise<string | undefined> {
  if (selectedModel) return selectedModel;
  // Session.model survives provider recreation; an in-memory map does not.
  const response = await client.session.get({ sessionID: sessionId }, requestOptions);
  assertSdkResponse(response, "OpenCode session model read");
  return openCodeSessionModelRef(response.data).modelId ?? (await resolveDefaultModel()).modelId;
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

export function openCodeRequestTimeoutMs(connection: BridgeConnection): number {
  return Math.max(1, connection.requestTimeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS);
}

export function openCodeRequestOptions(
  connection: BridgeConnection,
  monitorSignal: AbortSignal,
): { signal: AbortSignal } {
  const timeoutMs = openCodeRequestTimeoutMs(connection);
  return { signal: AbortSignal.any([monitorSignal, AbortSignal.timeout(timeoutMs)]) };
}

/**
 * OpenCode's permission ids for the tools a read-only coordinator may use.
 *
 * The base rule for a coordinator is `{"*": deny}`, so without an explicit
 * allow list here the session could not even read a file — which is the one
 * thing a coordinator is for. `skill` loads a discovered skill's SKILL.md and
 * lists the files beside it, and nothing more on 1.19.4: no hooks, tool grants
 * or inline shell, so it reads what `read` already could. Running a script a
 * skill ships still needs `bash`, which stays denied.
 */
const OPENCODE_READ_ONLY_PERMISSIONS = Object.freeze([
  "read",
  "list",
  "glob",
  "grep",
  "todoread",
  "todowrite",
  "task",
  "skill",
]);

/**
 * The coordinator's own Orkestrator tools, as OpenCode names MCP tools
 * (`<server>_<tool>`). Without these the `{"*": deny}` base refuses the
 * coordinator its mail and delegation tools, so it could neither read a
 * worker's report nor launch one. Listed by name, not `orkestrator_*`, so a
 * project `opencode.json` server whose name merely starts with "orkestrator"
 * gains nothing.
 */
const OPENCODE_COORDINATOR_TOOL_PERMISSIONS = Object.freeze(
  COORDINATOR_CONTROL_TOOL_NAMES.map((name) => `${ORKESTRATOR_AGENT_MCP_SERVER_NAME}_${name}`),
);

/**
 * A worker's always-allowed Orkestrator tools — mail and transcript artifacts,
 * which write only to Orkestrator's own stores — in OpenCode's
 * `<server>_<tool>` naming.
 */
const OPENCODE_AGENT_MAIL_PERMISSIONS = Object.freeze(
  [...AGENT_MAIL_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES].map(
    (name) => `${ORKESTRATOR_AGENT_MCP_SERVER_NAME}_${name}`,
  ),
);

/**
 * OpenCode's page-fetch tool, denied by name whenever a policy denies `network`.
 *
 * A coordinator's `{"*": deny}` base already covers it, but that is a side
 * effect of the base rule, which an explicit `toolPolicy.allow` replaces. Named
 * denies hold whatever the base is, and a `task` subagent inherits every deny
 * rule of its parent session (OpenCode 1.19.0), so they reach subagents too.
 */
const OPENCODE_FETCH_PERMISSIONS = Object.freeze(["webfetch"]);

/**
 * OpenCode's hosted search tools: denied with the network unless the policy's
 * `allow` names `web.search`, and then allowed by name over a `*: deny` base.
 * Both send a query to a hosted search service and return its results.
 * `codesearch` is not a 1.19.0 tool; it is listed because earlier releases
 * shipped it as a hosted search, and a rule for an absent permission is inert.
 */
const OPENCODE_SEARCH_PERMISSIONS = Object.freeze(["websearch", "codesearch"]);

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

export function openCodeWorkflowResultToolId(toolName: string): string {
  return `${WORKFLOW_RESULT_MCP_SERVER_NAME}_${toolName}`;
}

const OPENCODE_WORKFLOW_RESULT_SUBMISSION_TOOLS = new Set(
  WORKFLOW_RESULT_KINDS.map(workflowResultToolName),
);

export function isOpenCodeWorkflowResultToolName(toolName: string): boolean {
  return OPENCODE_WORKFLOW_RESULT_SUBMISSION_TOOLS.has(toolName);
}

/**
 * The broker tools a turn that submits `selectedTool` may call. A reviewer's
 * turn also gets `report_finding`; the broker still answers only a live Multi
 * Review reviewer's own signed capability.
 */
function openCodeWorkflowResultTurnToolNames(selectedTool: string): string[] {
  return [
    selectedTool,
    WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    "get_workflow_result_status",
    ...(selectedTool === workflowResultToolName("review-report") ? [REPORT_FINDING_TOOL_NAME] : []),
  ];
}

/** Hide the persistent broker by default and expose only this turn's tools. */
export function openCodeWorkflowResultTurnTools(selectedTool?: string): Record<string, boolean> {
  const tools = Object.fromEntries(
    [
      ...WORKFLOW_RESULT_KINDS.map((kind) =>
        openCodeWorkflowResultToolId(workflowResultToolName(kind)),
      ),
      openCodeWorkflowResultToolId(WORKFLOW_RESULT_VALIDATION_TOOL_NAME),
      openCodeWorkflowResultToolId("get_workflow_result_status"),
      openCodeWorkflowResultToolId(REPORT_FINDING_TOOL_NAME),
    ].map((tool) => [tool, false]),
  );
  if (selectedTool) {
    for (const tool of openCodeWorkflowResultTurnToolNames(selectedTool)) {
      tools[openCodeWorkflowResultToolId(tool)] = true;
    }
  }
  return tools;
}

export function openCodeWorkflowResultPermissionRules(selectedTool: string) {
  return [
    ...openCodeWorkflowResultDenyPermissionRules(),
    ...openCodeWorkflowResultTurnToolNames(selectedTool).map((tool) => ({
      permission: openCodeWorkflowResultToolId(tool),
      pattern: "*",
      action: "allow" as const,
    })),
  ];
}

export function openCodeWorkflowResultDenyPermissionRules() {
  return Object.keys(openCodeWorkflowResultTurnTools()).map((permission) => ({
    permission,
    pattern: "*",
    action: "deny" as const,
  }));
}

export function effectiveOpenCodePolicy(
  policy: NativeAgentExecutionPolicy,
): NativeAgentExecutionPolicy {
  // OpenCode resolves its session directory from the checkout's own
  // configuration and offers no way to opt out, so this axis cannot be
  // honoured. Reported rather than silently dropped: it is why OpenCode is
  // `provider-configured` and not `enforced`.
  const withResources = policy.projectResources
    ? policy
    : appendNativeAgentPolicyNote(
        { ...policy, projectResources: true },
        policy.id === "coordinator-read-only"
          ? "OpenCode always loads the checkout's project configuration, including any MCP servers it declares."
          : "OpenCode always reads project configuration for its session directory.",
      );
  // Nor does it have a sandbox: only the permission rules stand between its
  // commands and the network.
  return withoutProviderSandbox(withResources, {
    agent: "OpenCode",
    toolsetBlocksNetwork: openCodeRulesBlockNetwork(openCodePermissionRules(policy)),
  });
}

/**
 * Whether a rule set refuses every command and page fetch. OpenCode takes the
 * last rule that matches, which is why `openCodePermissionRules` puts denials
 * last.
 */
export function openCodeRulesBlockNetwork(
  rules: readonly { permission: string; pattern: string; action: string }[],
): boolean {
  const action = (permission: string) =>
    rules.findLast((rule) => rule.permission === permission || rule.permission === "*")?.action;
  return ["bash", "webfetch"].every((permission) => action(permission) === "deny");
}

export function openCodePermissionRules(
  policy: NativeAgentExecutionPolicy,
  options: {
    /**
     * A coordinator's research server tools, by the exact ids OpenCode
     * registered them under (`opencode-coordinator-research.ts`).
     */
    researchTools?: readonly string[];
  } = {},
) {
  const action =
    policy.approvals === "auto-approve"
      ? ("allow" as const)
      : policy.approvals === "deny"
        ? ("deny" as const)
        : ("ask" as const);
  const coordinatorAllow =
    policy.id === "coordinator-read-only" && !policy.toolPolicy?.allow
      ? [
          ...OPENCODE_READ_ONLY_PERMISSIONS,
          ...OPENCODE_COORDINATOR_TOOL_PERMISSIONS,
          ...(nativeAgentPolicyDeniesWebSearch(policy) ? [] : OPENCODE_SEARCH_PERMISSIONS),
          ...(options.researchTools ?? []),
        ]
      : [];
  // A worker can always report back: its mail tools are allowed whatever the
  // ask/deny default. An explicit deny below still wins.
  const mailAllow =
    action === "allow" || policy.id === "coordinator-read-only"
      ? []
      : OPENCODE_AGENT_MAIL_PERMISSIONS;
  return [
    { permission: "*", pattern: "*", action },
    ...[...coordinatorAllow, ...mailAllow, ...(policy.toolPolicy?.allow ?? [])].map(
      (permission) => ({
        permission,
        pattern: "*",
        action: "allow" as const,
      }),
    ),
    // Last, so a deny always wins a collision with the read allowances above.
    ...[
      ...(policy.toolPolicy?.deny ?? []),
      ...(nativeAgentPolicyDeniesNetwork(policy) ? OPENCODE_FETCH_PERMISSIONS : []),
      ...(nativeAgentPolicyDeniesWebSearch(policy) ? OPENCODE_SEARCH_PERMISSIONS : []),
    ].map((permission) => ({
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
 * `fallback` is omitted for a slash command: OpenCode applies a command's own
 * agent first and otherwise its default agent, which "build" would override.
 */
export function openCodeAgentFor(
  policy: NativeAgentExecutionPolicy | undefined,
  options: { executionAgent?: string; mode?: string },
  fallback?: string,
): string | undefined {
  return openCodeCoordinatorAgent(policy) ?? options.executionAgent ?? options.mode ?? fallback;
}

/**
 * The media type an attachment's file part declares to OpenCode.
 *
 * OpenCode routes a `file://` part by this type alone. `text/plain` runs its
 * Read tool, which reads text, returns images and PDFs as attachments, and
 * refuses binary content in a message the model still receives. Any other
 * non-image type is inlined as a data URL, and an image type is decoded as an
 * image: a text file labelled `image/png` failed decoding in the background
 * and the prompt never became a message (todo 0166).
 */
export function openCodeAttachmentMime(attachment: PromptAttachment): string {
  const name = attachment.filename ?? attachment.path;
  if (attachment.type === "file") return "text/plain";
  // Staging derives the data URL's MIME from the bytes; its display name may
  // still have the clipboard's original extension.
  const inline = /^data:(image\/[^;,]+)[;,]/.exec(attachment.dataUrl ?? "");
  if (inline) return inline[1]!;
  return mimeTypeForFilename(name);
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
      mime: openCodeAttachmentMime(attachment),
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

/** `session.create` uses `{ id, providerID }`, not the prompt `{ modelID, providerID }`. */
export function openCodeSessionCreateModel(
  model: string | undefined,
  variant?: string,
): { providerID: string; id: string; variant?: string } | undefined {
  const selection = openCodeModelSelection(model);
  if (!selection) return undefined;
  const reasoning = variant?.trim();
  return {
    providerID: selection.providerID,
    id: selection.modelID,
    ...(reasoning && reasoning !== "default" ? { variant: reasoning } : {}),
  };
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

/** Keep plain prompt tool masks consistent with the session permission grant. */
/**
 * Per-prompt tool options: the read-only turn's tool map, and the trusted
 * `system` instruction carrying this turn's artifact grant when one exists.
 */
export function openCodePromptToolOptions(
  options: Pick<ProviderSendOptions, "readOnly" | "workflowResultTool" | "artifactGrant">,
  reviewEnabled: boolean,
): { tools?: Record<string, boolean>; system?: string } {
  const system = options.artifactGrant
    ? { system: openCodeArtifactGrantInstruction(options.artifactGrant) }
    : {};
  if (!options.readOnly || reviewEnabled) return system;
  return {
    ...system,
    tools: {
      ...OPENCODE_READ_ONLY_TURN_TOOLS,
      ...openCodeWorkflowResultTurnTools(options.workflowResultTool),
    },
  };
}

/**
 * Trusted per-turn instruction carrying the artifact-only `scopeCapability`.
 *
 * OpenCode's Orkestrator tool connection is environment-wide, so the artifact
 * tools cannot tell which conversation called them. The backend mints a grant
 * bound to this conversation and turn and hands it to the model through the
 * prompt's system field (not the visible user text). The grant authorizes
 * artifact operations only, expires, and is revoked when the turn settles.
 */
export function openCodeArtifactGrantInstruction(grant: string): string {
  return [
    "Orkestrator transcript-artifact tools (create_artifact, update_artifact, preview_artifact,",
    "publish_artifact, get_artifact, get_artifact_operation, cancel_artifact_operation) require",
    `the argument scopeCapability set exactly to "${grant}" in this turn.`,
    "It authorizes artifact operations for this conversation only. Do not repeat it in replies.",
  ].join(" ");
}
