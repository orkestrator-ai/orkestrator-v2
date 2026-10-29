// One Claude CLI per bridge session.
//
// A Claude session is a single conversation, and only one CLI process may run
// its root agent loop. A turn that ends while that process still owns
// background work (agents, background Bash) leaves the process running, so the
// next prompt must be written into the same process rather than spawning
// another one on the same transcript. Two processes resumed from one rollout
// each answer their own task notifications as the coordinator: duplicated
// agents, interleaved edits and two transcripts appending to one file.
//
// The runtime owns the process, its input stream and the single consumer of
// its frames. Turns are what `sendPrompt` creates: each one handles the frames
// routed to it, and the newest one owns the root conversation.

import { createHash } from "node:crypto";
import { runtimeEnvironmentForSessionQuery } from "./runtime-env.js";
import type {
  CanUseTool,
  HookCallback,
  SDKMessage,
  SDKUserMessage,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { WorkflowResultTurn } from "@orkestrator/protocol/workflow-results";
import type {
  ClaudeQueryControl,
  PermissionMode,
  PromptOptions,
  SessionState,
} from "../types/index.js";
import type { HeldSdkPrompt } from "./session-manager-persistence.js";
import type { ClaudeRuntimeMcp } from "./session-manager-prompt-mcp-sync.js";
import type { ToolTracker } from "./session-manager-messages.js";
import {
  claudeAsksForApproval,
  effectiveClaudeChrome,
  claudePolicyPermissionMode,
  claudeSettingSources,
  claudeTurnPolicy,
  claudeWorkspaceCwd,
  resolveClaudeTurnPlugins,
} from "./claude-query-config.js";
import { claudeReadOnlyCommandSandbox } from "./claude-execution-sandbox.js";
import { isCoordinatorReadOnlyPolicy } from "./read-only-policy.js";
import {
  claudeRuntimeOwnsLiveWork,
  type ClaudeRuntimeTasks,
  createClaudeRuntimeTasks,
} from "./session-manager-background-tasks.js";
import { sessionOperationError } from "./session-manager-core.js";
import { sessionHasPendingInteractions } from "./session-manager-lifecycle.js";
import type { ClaudeRuntimeIdleTimer } from "./session-manager-runtime-idle.js";
import { requestsUltracode } from "./ultracode.js";

/**
 * What a turn needs from the runtime it runs on.
 *
 * Every member is called by the runtime's single consumer or by the hooks and
 * callbacks the SDK invokes on the runtime's behalf, never concurrently with a
 * frame for the same turn.
 */
export interface ClaudeRuntimeTurn {
  /** Handle one frame routed to this turn. A throw ends the runtime. */
  handleMessage(message: SDKMessage): Promise<void>;
  pushSteerInput(message: SDKUserMessage): boolean | "capacity-exceeded";
  canUseTool: CanUseTool;
  recordBackgroundTaskHook: HookCallback;
  recordPreCompact: HookCallback;
  recordPostCompact: HookCallback;
  /** The workflow-result attempt this turn declared, if any. */
  workflowResultTurn(): WorkflowResultTurn | undefined;
  applyCommandChanges(toolUseId: string, change: MeasuredWorkspaceChange): void;
  /**
   * A newer turn now owns the root conversation. Frames for tools this turn
   * started still reach it; everything else goes to the newer turn.
   */
  supersede(): void;
  /** The process is gone. `failure` is set only for the turn whose frame failed. */
  runtimeEnded(failure?: { error: unknown }): void;
  /** True while this turn waits for the root continuation a notification owes. */
  isAwaitingContinuation(): boolean;
  /** Take over a continuation the superseded turn was still waiting for. */
  inheritContinuation(): void;
}

/** Settings a running CLI can change through control requests. */
export interface ClaudeLiveSettings {
  model: string | undefined;
  permissionMode: PermissionMode;
  effort: string;
  /** `parameterValues.thinking`: `adaptive`, `disabled` or `budget-<n>`. */
  thinking: string;
  fastMode: boolean;
  ultracode: boolean;
}

/**
 * Launch-only configuration: what the CLI read when it started and cannot
 * change afterwards.
 *
 * `agent` and `settingSources` are undefined in a request that does not say,
 * which mail delivery, the control MCP and the public API all omit. A request
 * that does not say inherits whatever the running process has.
 */
export interface ClaudeLaunchProfile {
  context1m: boolean;
  promptSuggestions: boolean;
  chrome: boolean;
  thinking: string;
  bypassCapable: boolean;
  plugins?: string;
  credentials?: string;
  cwd: string;
  /**
   * The turn's execution policy, which fixes the tool allow/deny lists, the
   * sandbox and the read-only hook: the execution boundary.
   */
  boundary: string;
  /** The decision used for SDK options, including the reason reported on joined turns. */
  readOnlyCommandSandbox?: ReturnType<typeof claudeReadOnlyCommandSandbox>;
  /** JSON of the structured-output schema, or null for an ordinary turn. */
  outputSchema: string | null;
  agent: string | undefined;
  settingSources: string | undefined;
}

/**
 * The launch-only configuration `options` asks for.
 *
 * Synchronous on purpose: the prompt route checks it against a running process
 * before anything is journaled, so a prompt that cannot run is refused rather
 * than accepted and dropped.
 */
export function claudeLaunchProfile(
  session: SessionState,
  options: PromptOptions | undefined,
  readOnlyCommandSandbox?: ReturnType<typeof claudeReadOnlyCommandSandbox>,
): ClaudeLaunchProfile {
  const policy = claudeTurnPolicy(session.executionPolicy, options?.readOnly);
  const sandbox = isCoordinatorReadOnlyPolicy(policy)
    ? (readOnlyCommandSandbox ?? claudeReadOnlyCommandSandbox())
    : undefined;
  return {
    readOnlyCommandSandbox: sandbox,
    context1m: effectiveClaudeContext1m(options),
    promptSuggestions: options?.promptSuggestions === true,
    chrome: effectiveClaudeChrome(policy, options),
    thinking:
      typeof options?.parameterValues?.thinking === "string"
        ? options.parameterValues.thinking
        : "adaptive",
    // A prompt cannot lift an `ask` or `deny` policy into bypass mode (see
    // `claudePermissionMode`), so only the policy decides.
    bypassCapable: claudePolicyPermissionMode(policy) === "bypassPermissions",
    cwd: claudeWorkspaceCwd(),
    boundary: JSON.stringify({
      policy: policy ?? null,
      // The allow list narrows to reading tools when the user approves the
      // rest, so switching approval modes across that line needs a new CLI.
      // An `ask` policy is already distinguished by the policy itself.
      ...(policy?.approvals !== "ask" && claudeAsksForApproval(policy, options)
        ? { asksForApproval: true }
        : {}),
      // A coordinator's allow-list names the Orkestrator MCP server only when
      // the turn has one. After resolution, use the query plan's sandbox
      // decision; early admission checks probe for a prospective boundary.
      // A changed boundary requires a new CLI.
      ...(isCoordinatorReadOnlyPolicy(policy)
        ? {
            agentMcp: options?.agentMcp !== undefined,
            commandSandbox: sandbox!.commandSandbox,
          }
        : {}),
    }),
    outputSchema: options?.outputSchema === undefined ? null : JSON.stringify(options.outputSchema),
    agent: options?.agent,
    settingSources:
      options?.includeLocalSettings === undefined
        ? undefined
        : JSON.stringify(claudeSettingSources(policy, options.includeLocalSettings)),
  };
}

/** The effective beta is a launch option even when the requested model changes. */
export function effectiveClaudeContext1m(options: PromptOptions | undefined): boolean {
  const model = options?.model?.trim();
  return (
    options?.parameterValues?.context1m === true &&
    (!model || model === "default" || /opus|sonnet/i.test(model))
  );
}

/** Hash only managed credential fields; never retain their values in the profile. */
export function claudeLaunchResourceProfile(
  plugins: readonly { path: string }[],
  environment: NodeJS.ProcessEnv,
): Pick<ClaudeLaunchProfile, "plugins" | "credentials"> {
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    plugins: digest(plugins.map((plugin) => plugin.path)),
    credentials: digest([
      environment.GH_TOKEN ?? null,
      environment.GITHUB_TOKEN ?? null,
      environment.GITHUB_PERSONAL_ACCESS_TOKEN ?? null,
    ]),
  };
}

/** The concrete profile a launch records, with nothing left to inherit. */
export function claudeLaunchedProfile(
  session: SessionState,
  options: PromptOptions | undefined,
  readOnlyCommandSandbox?: ReturnType<typeof claudeReadOnlyCommandSandbox>,
): ClaudeLaunchProfile {
  const profile = claudeLaunchProfile(session, options, readOnlyCommandSandbox);
  return {
    ...profile,
    settingSources: JSON.stringify(
      claudeSettingSources(
        claudeTurnPolicy(session.executionPolicy, options?.readOnly),
        options?.includeLocalSettings,
      ),
    ),
  };
}

/**
 * The settings sources whose `enabledPlugins` decide this turn's plugin set
 * (`resolveClaudeTurnPlugins`): the ones the prompt asks for; else, when it leaves
 * them unsaid and could join the running CLI, the ones that CLI was launched
 * with, since a joining turn inherits them; else a new launch's default.
 */
export function claudeTurnSettingSources(
  session: SessionState,
  options: PromptOptions | undefined,
): SettingSource[] {
  const policy = claudeTurnPolicy(session.executionPolicy, options?.readOnly);
  const running = openClaudeRuntime(session);
  if (
    options?.includeLocalSettings === undefined &&
    running?.launch.settingSources !== undefined &&
    !claudeLaunchConflict(running.launch, claudeLaunchProfile(session, options))
  )
    return JSON.parse(running.launch.settingSources) as SettingSource[];
  return claudeSettingSources(policy, options?.includeLocalSettings);
}

/**
 * Refuse a prompt the session's running process cannot take.
 *
 * Launch-only settings cannot change on a live CLI, and starting a second one
 * on the same conversation is the defect this module exists to prevent, so a
 * prompt that changes them waits until the background work the running process
 * owns has finished, or the user stops it. A warm CLI that owes nothing is
 * retired for the new launch instead (`runTurnOnRuntime`).
 */
export function assertClaudeRuntimeStaticAccepts(
  session: SessionState,
  options: PromptOptions | undefined,
): void {
  const runtime = openClaudeRuntime(session);
  if (!runtime || !claudeRuntimeOwesWork(runtime)) return;
  const conflict = claudeLaunchConflict(runtime.launch, claudeLaunchProfile(session, options));
  if (conflict)
    throw sessionOperationError(
      "conflict",
      `Claude is still running background work in this session, so a prompt that changes its ${conflict} cannot start until that work finishes or is stopped`,
    );
}

export async function assertClaudeRuntimeAccepts(
  session: SessionState,
  options: PromptOptions | undefined,
  resources?: Pick<ClaudeLaunchProfile, "plugins" | "credentials"> & { settingSources?: string },
  readOnlyCommandSandbox?: ReturnType<typeof claudeReadOnlyCommandSandbox>,
): Promise<void> {
  const runtime = openClaudeRuntime(session);
  if (!runtime || !claudeRuntimeOwesWork(runtime)) return;
  const request = claudeLaunchProfile(session, options, readOnlyCommandSandbox);
  const refuse = (conflict: string | undefined) => {
    if (conflict)
      throw sessionOperationError(
        "conflict",
        `Claude is still running background work in this session, so a prompt that changes its ${conflict} cannot start until that work finishes or is stopped`,
      );
  };
  refuse(claudeLaunchConflict(runtime.launch, request));
  if (!resources) {
    const policy = claudeTurnPolicy(session.executionPolicy, options?.readOnly);
    const [{ plugins }, environment] = await Promise.all([
      resolveClaudeTurnPlugins(request.cwd, policy, claudeTurnSettingSources(session, options)),
      runtimeEnvironmentForSessionQuery(policy),
    ]);
    resources = claudeLaunchResourceProfile(plugins, environment);
  }
  refuse(claudeLaunchConflict(runtime.launch, { ...request, ...resources }));
}

export interface ClaudeRuntime {
  readonly session: SessionState;
  /** The query, and the session's control handle while a turn runs. */
  readonly control: NonNullable<SessionState["queryControl"]>;
  readonly input: HeldSdkPrompt;
  /** Passed to `query()`; aborting it ends the process. */
  readonly abortController: AbortController;
  /** Shared by every turn, so a report finds its tool row whoever started it. */
  readonly toolTracker: ToolTracker;
  readonly activeTaskIds: Set<string>;
  /** The background work this process owns: its tasks, Bash candidates and parked edges. */
  readonly tasks: ClaudeRuntimeTasks;
  /** The turn whose transcript row holds each tool call. */
  readonly toolOwners: Map<string, ClaudeRuntimeTurn>;
  /** Turns whose `sendPrompt` is still waiting on this runtime. */
  readonly waitingTurns: Set<ClaudeRuntimeTurn>;
  readonly launch: ClaudeLaunchProfile;
  /** Digest of applied inline MCP servers; empty means a failed update must retry. */
  mcpServers: string;
  /** The servers the CLI was given and still runs; see `session-manager-prompt-mcp-sync.ts`. */
  readonly mcp: ClaudeRuntimeMcp;
  /** The newest turn: it owns the root conversation. */
  latestTurn: ClaudeRuntimeTurn;
  /** `draining` once input is closed: the CLI can no longer start a turn. */
  state: "open" | "draining" | "ended";
  /** The idle window while it runs; see `session-manager-runtime-idle.ts`. */
  idleTimer: ClaudeRuntimeIdleTimer | undefined;
  /** When the last frame arrived; orders idle CLIs past the warm cap. */
  lastFrameAt: number;
  supportedAgents: Array<{ name: string; description?: string; model?: string }>;
  ended: Promise<void>;
}

/**
 * Bound on remembered tool owners. Past it the oldest entries go; a frame for
 * a forgotten tool falls back to the latest turn, which costs only where its
 * row is drawn.
 */
export const MAX_RUNTIME_TOOL_OWNERS = 4_096;

/**
 * How long a new turn waits for a draining CLI to exit on its own before
 * closing it. A draining CLI has closed input and owns no live work, so this
 * only bounds how long its exit may overlap the next process.
 */
export const DRAINING_RUNTIME_EXIT_WAIT_MS = 5_000;

export function createClaudeRuntime(input: {
  session: SessionState;
  control: NonNullable<SessionState["queryControl"]>;
  heldInput: HeldSdkPrompt;
  abortController: AbortController;
  toolTracker: ToolTracker;
  activeTaskIds: Set<string>;
  launch: ClaudeLaunchProfile;
  mcpServers: string;
  mcp: ClaudeRuntimeMcp;
  firstTurn: ClaudeRuntimeTurn;
}): { runtime: ClaudeRuntime; markEnded: () => void } {
  let markEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  const runtime: ClaudeRuntime = {
    session: input.session,
    control: input.control,
    input: input.heldInput,
    abortController: input.abortController,
    toolTracker: input.toolTracker,
    activeTaskIds: input.activeTaskIds,
    tasks: createClaudeRuntimeTasks(),
    toolOwners: new Map(),
    waitingTurns: new Set([input.firstTurn]),
    launch: input.launch,
    mcpServers: input.mcpServers,
    mcp: input.mcp,
    latestTurn: input.firstTurn,
    state: "open",
    idleTimer: undefined,
    lastFrameAt: Date.now(),
    supportedAgents: [],
    ended,
  };
  return { runtime, markEnded };
}

/** The session's runtime when it can still take a turn. */
export function openClaudeRuntime(session: SessionState): ClaudeRuntime | undefined {
  const runtime = session.claudeRuntime;
  // An aborted runtime's process is already being killed by the SDK.
  return runtime?.state === "open" && !runtime.abortController.signal.aborted ? runtime : undefined;
}

/**
 * Whether the process still owes something beyond a foreground turn: a live
 * task it started, the continuation a task notification triggers, or a card
 * waiting on the user. Such a process cannot be replaced or stopped without
 * losing that work; one that owes nothing is merely warm.
 */
export function claudeRuntimeOwesWork(runtime: ClaudeRuntime): boolean {
  return (
    claudeRuntimeOwnsLiveWork(runtime) ||
    runtime.latestTurn.isAwaitingContinuation() ||
    sessionHasPendingInteractions(runtime.session.id)
  );
}

/**
 * Why `request` cannot run on `runtime`, or undefined when it can.
 *
 * Thinking resets and bypass mode are limited by launch capabilities; other
 * live settings are restated on the existing process.
 */
export function claudeLaunchConflict(
  runtime: ClaudeLaunchProfile,
  request: ClaudeLaunchProfile,
): string | undefined {
  if (runtime.chrome !== request.chrome) return "Chrome setting";
  if (runtime.context1m !== request.context1m) return "1M context setting";
  if (runtime.promptSuggestions !== request.promptSuggestions) return "prompt suggestions";
  if (request.thinking === "adaptive" && runtime.thinking !== "adaptive")
    return "adaptive thinking";
  if (request.bypassCapable && !runtime.bypassCapable) return "bypass permission capability";
  if (request.plugins !== undefined && runtime.plugins !== request.plugins) return "plugins";
  if (request.credentials !== undefined && runtime.credentials !== request.credentials)
    return "managed credentials";
  if (runtime.cwd !== request.cwd) return "working directory";
  if (runtime.boundary !== request.boundary) return "execution policy";
  if (runtime.outputSchema !== request.outputSchema) return "structured output";
  if (request.agent !== undefined && runtime.agent !== request.agent) return "agent";
  if (request.settingSources !== undefined && runtime.settingSources !== request.settingSources) {
    return "settings sources";
  }
  return undefined;
}

/** Remember which turn's row holds `toolUseId`, within the bound. */
export function recordClaudeToolOwner(
  runtime: ClaudeRuntime,
  toolUseId: string,
  turn: ClaudeRuntimeTurn,
): void {
  const owners = runtime.toolOwners;
  if (owners.get(toolUseId) === turn) return;
  owners.delete(toolUseId);
  owners.set(toolUseId, turn);
  while (owners.size > MAX_RUNTIME_TOOL_OWNERS) {
    const oldest = owners.keys().next().value;
    if (oldest === undefined) break;
    owners.delete(oldest);
  }
}

/**
 * The turn a frame belongs to.
 *
 * A subagent's frames name the tool call that started it, and render inside
 * that call's row — which may belong to a turn the user has since moved on
 * from. Everything else is the root conversation, owned by the latest turn.
 */
export function routeClaudeFrame(runtime: ClaudeRuntime, message: SDKMessage): ClaudeRuntimeTurn {
  const parent = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  if (typeof parent === "string" && parent.length > 0) {
    const owner = runtime.toolOwners.get(parent);
    if (owner) return owner;
  }
  return runtime.latestTurn;
}

/**
 * Make `turn` the runtime's latest turn and write its prompt.
 *
 * The superseded turn keeps receiving frames for the tools it started, and
 * hands over any continuation it was still waiting for, so the newer turn holds
 * input open until that continuation has answered.
 */
export function submitClaudeTurn(
  runtime: ClaudeRuntime,
  turn: ClaudeRuntimeTurn,
  messages: readonly SDKUserMessage[],
): boolean {
  // A teardown fence or aborted signal excludes a process that is ending.
  if (runtime.state !== "open" || runtime.abortController.signal.aborted) return false;
  // A turn holds the process again; it re-arms the idle window when it ends.
  runtime.idleTimer?.cancel();
  runtime.idleTimer = undefined;
  // Written before ownership moves, so input that turns out to be closed (the
  // SDK stops reading when its process dies) leaves this runtime untouched for
  // caller to refuse safely. Nothing can answer before this function returns.
  for (const message of messages) {
    if (!runtime.input.push(message)) return false;
  }
  const previous = runtime.latestTurn;
  const inheritedContinuation = previous.isAwaitingContinuation();
  runtime.latestTurn = turn;
  runtime.waitingTurns.delete(previous);
  runtime.waitingTurns.add(turn);
  previous.supersede();
  if (inheritedContinuation) turn.inheritContinuation();
  return true;
}

/**
 * Close the runtime's input: the CLI finishes what it has and exits.
 *
 * Marks the control draining first: until the process has exited, a control
 * request races that exit and fails with "Query closed before response
 * received", so catalogue reads skip it (`readableControl`).
 */
export function drainClaudeRuntime(runtime: ClaudeRuntime): void {
  runtime.idleTimer?.cancel();
  runtime.idleTimer = undefined;
  if (runtime.state === "open") runtime.state = "draining";
  runtime.session.queryControlDraining = runtime.control;
  runtime.input.close();
}

/**
 * Wait for a draining runtime to exit before another process starts.
 *
 * Draining means input is closed and no live work remains, so the CLI cannot
 * start another turn; this only stops two processes overlapping on one
 * transcript. A CLI that does not exit in time is closed.
 */
export async function retireDrainingClaudeRuntime(
  session: SessionState,
  waitMs = DRAINING_RUNTIME_EXIT_WAIT_MS,
): Promise<void> {
  const runtime = session.claudeRuntime;
  if (!runtime || runtime.state === "ended") return;
  if (runtime.state === "open") drainClaudeRuntime(runtime);
  const waitForEnd = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        runtime.ended.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), waitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  if (await waitForEnd()) return;
  // close may throw, reject or never settle. Only the consumer's ended signal
  // proves that this writer is gone; observe close failures without awaiting it.
  try {
    Promise.resolve(runtime.control.close?.()).catch(() => {});
  } catch {
    /* still fenced */
  }
  if (await waitForEnd()) return;
  throw sessionOperationError(
    "conflict",
    "Claude runtime termination is still pending; retry once it has stopped",
  );
}

/** The live settings a turn asks for. */
export function claudeLiveSettings(input: {
  model: string | undefined;
  permissionMode: PermissionMode;
  effort: string;
  parameterValues?: Record<string, string | boolean>;
  fastMode: boolean;
}): ClaudeLiveSettings {
  const thinking = input.parameterValues?.thinking;
  return {
    model: input.model,
    permissionMode: input.permissionMode,
    effort: input.effort,
    thinking: typeof thinking === "string" ? thinking : "adaptive",
    fastMode: input.fastMode,
    ultracode: requestsUltracode(input.parameterValues),
  };
}

/**
 * Bring a running CLI to the settings `next` asks for.
 *
 * Every setting is restated rather than diffed against what the bridge last
 * sent: the CLI changes some of them itself (an approved plan leaves plan mode,
 * a refusal can fall back to another model), so a remembered value can be
 * stale. Each is an idempotent control request on the live process.
 */
export async function applyClaudeLiveSettings(
  runtime: ClaudeRuntime,
  next: ClaudeLiveSettings,
): Promise<void> {
  if (next.thinking === "adaptive" && runtime.launch.thinking !== "adaptive") {
    throw sessionOperationError("conflict", "Adaptive thinking requires a new Claude runtime");
  }
  const control: ClaudeQueryControl = runtime.control;
  await control.setModel?.(next.model);
  await control.setPermissionMode?.(next.permissionMode);
  if (next.thinking === "disabled") await control.setMaxThinkingTokens?.(0, "omitted");
  else if (next.thinking.startsWith("budget-")) {
    const tokens = Number(next.thinking.slice("budget-".length));
    if (Number.isSafeInteger(tokens) && tokens > 0) {
      await control.setMaxThinkingTokens?.(tokens, "summarized");
    }
  } else await control.setMaxThinkingTokens?.(null, "summarized");
  // Ultracode last and always explicit: the CLI drops it on a model change.
  await control.applyFlagSettings?.({
    effortLevel: next.effort,
    fastMode: next.fastMode,
    ultracode: next.ultracode,
  });
  runtime.session.ultracode = next.ultracode;
  runtime.session.ultracodeApplied = next.ultracode;
}
