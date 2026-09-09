/**
 * Session lifecycle: creating, attaching, resuming and closing an SDK agent.
 *
 * A session is durable; the agent object that serves it is not. The bridge
 * keeps the transcript, the prompt journal and the composer selection, and
 * attaches an SDK agent lazily around them. That split is what lets a bridge
 * restart, an idle detach or a crashed child all recover without the renderer
 * seeing anything other than a session that was briefly connecting.
 */
import { randomBytes } from "node:crypto";
import {
  Agent,
  type AgentOptions,
  type LocalAgentRunDocument,
  type Run,
  type SDKAgent,
  type SDKAgentInfo,
  type ToolName,
} from "@cursor/sdk";
import { CATALOG_TIMEOUT_MS, MAX_RESUME_ENTRIES, workingDirectory } from "./config.js";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { CURSOR_AUTHENTICATION_REQUIRED_MESSAGE, resolveCredential } from "./credentials.js";
import { schedulePlanAccountRefresh } from "./plan-usage.js";
import { emptyComposer, hydrateComposer, modelSelection } from "./models.js";
import { renderToolCall } from "./tool-rendering.js";
import { cursorMcpServers } from "./mcp.js";
import { cursorLocalAgentStore, prewarmCursorWorkspace } from "./sdk-runtime.js";
import { boundTranscript, chargeTranscript } from "./transcript.js";
import {
  clientSessionKeys,
  isObject,
  nonBlank,
  sessionCreations,
  sessions,
  type BridgeMessage,
  type BridgeMessagePart,
  type JsonObject,
  type SessionState,
} from "./state.js";

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export function newSessionState(
  clientSessionKey?: string,
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
): SessionState {
  return {
    id: randomBytes(16).toString("hex"),
    ...(policy ? { policy } : {}),
    ...(clientSessionKey ? { clientSessionKey } : {}),
    status: "idle",
    messages: [],
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
    steerJournal: new Map(),
    activeSubagentDescriptors: new Map(),
    subagentLimitExceeded: false,
    todos: [],
    composer: emptyComposer(),
    agent: null,
    dispatching: false,
    promptSequence: 0,
    openTextParts: new Map(),
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    lastAccessed: Date.now(),
    health: new RuntimeHealthRecorder(),
  };
}

/**
 * Create a session, or return the one this client key already owns.
 *
 * Idempotent by `clientSessionKey` because the backend retries session
 * creation through a short bridge-startup race: without this, a retry that
 * lands after the first call succeeded would leave the user with two agents
 * and a tab pointed at only one of them.
 */
export async function createSession(
  clientSessionKey: string | undefined,
  patch: ComposerPatch | undefined,
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
  readOnly?: boolean,
): Promise<SessionState> {
  if (clientSessionKey) {
    const existingId = clientSessionKeys.get(clientSessionKey);
    const existing = existingId ? sessions.get(existingId) : undefined;
    if (existing) {
      if (policy) existing.policy = resolveCursorExecutionPolicy(policy);
      // The boundary of a session that already exists is moved by the caller
      // of this function, which owns the HTTP status a conflicting move
      // deserves. `readOnly` here only seeds a session being created.
      return existing;
    }
    const inFlight = sessionCreations.get(clientSessionKey);
    if (inFlight) return inFlight;
  }

  const work = (async () => {
    const state = newSessionState(clientSessionKey, resolveCursorExecutionPolicy(policy));
    if (typeof readOnly === "boolean") state.readOnly = readOnly;
    applyComposerPatch(state, patch);
    state.composer = await hydrateComposer(state.composer);
    sessions.set(state.id, state);
    if (clientSessionKey) clientSessionKeys.set(clientSessionKey, state.id);
    return state;
  })();

  if (!clientSessionKey) return work;
  sessionCreations.set(clientSessionKey, work);
  try {
    return await work;
  } finally {
    sessionCreations.delete(clientSessionKey);
  }
}

/**
 * Attach an SDK agent to this session, reusing an in-flight attach.
 *
 * Without the shared promise this is a check-then-act race: the function reads
 * `state.agent`, then awaits a create, so two concurrent callers each see null
 * and each start an agent. Attach is reachable from the prompt route, the
 * config route and the explicit attach route, so that race is ordinary
 * concurrency rather than a corner case.
 */
export async function ensureAgent(state: SessionState): Promise<SDKAgent> {
  if (state.agent) return state.agent;
  state.attaching ??= attach(state).finally(() => {
    state.attaching = undefined;
  });
  return state.attaching;
}

/**
 * Cursor's names for denied cross-provider capabilities.
 *
 * The policy's `toolPolicy.deny` carries Codex's vocabulary, so it is never
 * forwarded: unknown names make Agent.create/resume reject the whole session.
 */
const CURSOR_CAPABILITY_TOOLS: Readonly<Record<string, readonly ToolName[]>> = Object.freeze({
  "file.write": ["edit", "delete", "applyAgentDiff", "task"],
  "file.patch": ["edit", "applyAgentDiff", "task"],
  shell: ["shell", "task"],
  "shell.mutate": ["shell", "task"],
  network: ["webFetch", "webSearch", "task"],
});

/**
 * Built-ins that cannot mutate the checkout, escape through MCP, launch an
 * independently tooled subagent, or access the network. An allowlist is
 * deliberate: a new Cursor writing tool stays unavailable until reviewed.
 */
export const CURSOR_READ_ONLY_TOOLS = [
  "read",
  "grep",
  "glob",
  "ls",
  "readLints",
  "semSearch",
  "readTodos",
  "askQuestion",
  "await",
] as const satisfies readonly ToolName[];

const CURSOR_TOOL_ALIASES: Readonly<Record<string, readonly ToolName[]>> = Object.freeze({
  read: ["read"],
  grep: ["grep"],
  glob: ["glob"],
  ls: ["ls"],
  shell: ["shell"],
  bash: ["shell"],
  edit: ["edit"],
  write: ["edit"],
  apply_patch: ["applyAgentDiff"],
});

export function cursorDeniedTools(
  policy: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
): ToolName[] {
  const tools = new Set<ToolName>();
  for (const capability of policy.capabilityPolicy?.deny ?? []) {
    for (const tool of CURSOR_CAPABILITY_TOOLS[capability] ?? []) tools.add(tool);
  }
  return Array.from(tools);
}

function cursorAllowedTools(
  policy: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
): ToolName[] | undefined {
  if (!policy.toolPolicy?.allow) return undefined;
  const tools = new Set<ToolName>();
  for (const name of policy.toolPolicy.allow) {
    for (const tool of CURSOR_TOOL_ALIASES[name] ?? []) tools.add(tool);
  }
  return Array.from(tools);
}

async function attach(state: SessionState): Promise<SDKAgent> {
  const sessionPolicy = state.policy;
  const policy = resolveCursorExecutionPolicy(
    state.readOnly
      ? {
          id: "coordinator-read-only",
          // A container is already the process boundary. Reusing it avoids a
          // nested Cursor sandbox that Docker cannot start; the SDK allowlist
          // below independently protects its bind-mounted worktree.
          sandbox: sessionPolicy?.sandbox === "container" ? "container" : "provider",
          approvals: "deny",
          projectResources: false,
          capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
          networkAccess: "restricted",
        }
      : state.policy,
  );
  const readOnly = policy.id === "coordinator-read-only";
  if (policy.approvals === "deny" && !readOnly) {
    throw new Error(
      "Cursor SDK cannot enforce an approvals-deny policy, so this session was refused before attach.",
    );
  }
  // A read-only coordinator is the one deny case Cursor can express: a process
  // boundary plus a closed tool allowlist, with no approval callback behind
  // them. The boundary may be Cursor's sandbox or the outer container.
  // Orkestrator reports this as `provider-configured` rather than enforced.
  if (readOnly && policy.sandbox !== "provider" && policy.sandbox !== "container") {
    throw new Error(
      "Cursor cannot run a read-only coordinator without a sandbox boundary, so this session was refused before attach.",
    );
  }
  const { apiKey } = await resolveCredential();
  if (!apiKey) {
    throw new CredentialError(CURSOR_AUTHENTICATION_REQUIRED_MESSAGE);
  }
  const mcpServers = await cursorMcpServers();
  state.mcpServerNames = Object.keys(mcpServers);
  const options: AgentOptions = {
    apiKey,
    model: modelSelection(state.composer),
    mode: state.composer.selectedModeId === "plan" ? ("plan" as const) : ("agent" as const),
    local: {
      cwd: workingDirectory,
      settingSources: policy.projectResources ? ["user", "project", "team", "plugins"] : ["user"],
      sandboxOptions: { enabled: policy.sandbox === "provider" },
      autoReview: policy.sandbox === "provider" && policy.approvals === "auto-approve",
    },
    ...(readOnly
      ? { tools: [...CURSOR_READ_ONLY_TOOLS] }
      : (() => {
          const allowed = cursorAllowedTools(policy);
          return allowed ? { tools: allowed } : {};
        })()),
    ...(!readOnly
      ? (() => {
          const denied = cursorDeniedTools(policy);
          return denied.length > 0 ? { disallowedTools: denied } : {};
        })()
      : {}),
    ...(state.mcpServerNames.length > 0 ? { mcpServers } : {}),
  };
  const releaseWarmWorkspace = await prewarmCursorWorkspace(options);
  state.workspaceWarmRelease = releaseWarmWorkspace;

  try {
    // A session that already ran holds an agent id, and resuming it is what
    // keeps the model's own context across a bridge restart. A resume that fails
    // is not fatal: the id may name an agent the store no longer has, and a new
    // agent with the transcript we already hold is a far better outcome than a
    // tab that can never send again.
    if (state.agentId) {
      try {
        const resumed = await Agent.resume(state.agentId, options);
        state.agent = resumed;
        schedulePlanAccountRefresh();
        return resumed;
      } catch {
        state.agentId = undefined;
      }
    }

    const created = await Agent.create({ ...options, name: "Orkestrator" });
    // `getUsage()` is scoped to one SDK agent. If resume failed (or a restored
    // state somehow lost its id), the replacement starts its cumulative token
    // and cost counters from zero; retaining the previous agent's floor would
    // reject every valid report from the replacement as stale. Keep the latest
    // turn/context snapshot, which is still useful history, but detach all
    // account-scoped figures once the replacement is known to exist.
    if (clearAgentScopedUsage(state)) state.revision += 1;
    state.agent = created;
    state.agentId = created.agentId;
    schedulePlanAccountRefresh();
    return created;
  } catch (error) {
    state.workspaceWarmRelease = undefined;
    await releaseWarmWorkspace?.().catch(() => undefined);
    throw error;
  }
}

let warnedLegacyPolicy = false;

export function resolveCursorExecutionPolicy(
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
): import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy {
  const fallback: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy =
    policy ??
    ({
      id: "interactive-host",
      sandbox: "provider",
      approvals: "ask",
      projectResources: false,
      networkAccess: "full",
    } as const);
  // Process authority first, so neither a request body nor the deprecated env
  // overrides below can widen what a coordinator bridge runs under.
  if (process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY === "coordinator-read-only") {
    return {
      id: "coordinator-read-only",
      // Keep the outer boundary when the bridge itself runs in a container.
      // Cursor's nested provider sandbox cannot start there, and the closed
      // read-only allowlist still protects the bind-mounted checkout.
      sandbox: policy?.sandbox === "container" ? "container" : "provider",
      approvals: "deny",
      projectResources: false,
      capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
      networkAccess: "restricted",
      note: "Cursor applies these restrictions, but its SDK exposes no approval callback to verify them.",
    };
  }
  const sandboxOverride = process.env.CURSOR_BRIDGE_SANDBOX;
  const resourcesOverride = process.env.CURSOR_BRIDGE_PROJECT_SETTINGS;
  if ((sandboxOverride !== undefined || resourcesOverride !== undefined) && !warnedLegacyPolicy) {
    warnedLegacyPolicy = true;
    console.warn(
      "[cursor-bridge] CURSOR_BRIDGE_SANDBOX/CURSOR_BRIDGE_PROJECT_SETTINGS are deprecated; configure the session execution policy instead.",
    );
  }
  const resolved: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy = {
    ...fallback,
    ...(sandboxOverride !== undefined
      ? { sandbox: sandboxOverride === "1" ? "provider" : "none" }
      : {}),
    ...(resourcesOverride !== undefined ? { projectResources: resourcesOverride === "1" } : {}),
  };
  const notes = resolved.note ? [resolved.note] : [];
  // Cursor's public SDK has no callback surface for interactive approvals.
  // Report ask as the auto-reviewed mode it actually runs, while deny keeps
  // autoReview disabled so any operation requiring escalation fails closed.
  const approvals = resolved.approvals === "ask" ? "auto-approve" : resolved.approvals;
  if (resolved.approvals === "ask") {
    notes.push("Cursor SDK cannot surface interactive approvals; provider auto-review is used.");
  }
  // Its public network control is the provider sandbox switch rather than an
  // independent network policy. Restricted requests therefore force that
  // sandbox on instead of claiming a restriction with an unsandboxed agent.
  const sandbox =
    resolved.networkAccess === "restricted" && resolved.sandbox === "none"
      ? "provider"
      : resolved.sandbox;
  if (resolved.networkAccess === "restricted" && sandbox === "provider") {
    notes.push("Cursor enforces restricted network access through its provider sandbox.");
  } else if (resolved.networkAccess === "restricted" && sandbox === "container") {
    notes.push("Restricted network access is enforced by the outer container boundary.");
  } else if (sandbox === "provider") {
    notes.push("Cursor SDK cannot independently guarantee full network inside its sandbox.");
  }
  return {
    ...resolved,
    sandbox,
    approvals,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

function clearAgentScopedUsage(state: SessionState): boolean {
  const usage = state.usage;
  if (
    !usage ||
    (usage.sessionTokens === undefined &&
      usage.sessionTokenFloor === undefined &&
      usage.costUsd === undefined &&
      usage.account === undefined)
  ) {
    return false;
  }
  const {
    sessionTokens: _sessionTokens,
    sessionTokenFloor: _floor,
    costUsd: _cost,
    account: _account,
    ...rest
  } = usage;
  state.usage = { ...rest, updatedAt: new Date().toISOString() };
  return true;
}

/**
 * Release the SDK agent without touching the session.
 *
 * Called on idle detach and on shutdown. The transcript, journal and agent id
 * all survive, so the next request re-attaches transparently — and because the
 * agent id survives, it re-attaches to the *same* conversation.
 */
export async function detachAgent(state: SessionState): Promise<void> {
  const agent = state.agent;
  const releaseWarmWorkspace = state.workspaceWarmRelease;
  state.agent = null;
  state.workspaceWarmRelease = undefined;
  await Promise.allSettled([
    ...(agent ? [agent[Symbol.asyncDispose]()] : []),
    ...(releaseWarmWorkspace ? [releaseWarmWorkspace()] : []),
  ]);
}

/** Restore the checkpoint captured immediately before the selected user turn. */
export async function rewindSessionHistory(state: SessionState, messageId: string): Promise<void> {
  if (!state.agentId) throw new Error("This Cursor session has no persisted conversation");
  if (state.status === "running" || state.dispatching) {
    throw new Error("The Cursor session is already running");
  }
  const selectedMessage = state.messages.find(
    (message) => message.role === "user" && message.id === messageId,
  );
  if (!selectedMessage) throw new Error("The selected Cursor message is no longer available");
  if (!selectedMessage.runId) {
    throw new Error("Cursor cannot safely map that message to its stored run");
  }

  await detachAgent(state);
  const store = cursorLocalAgentStore;
  const runs: LocalAgentRunDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.runs.list({
      filter: { agentIds: [state.agentId], limit: 200, ...(cursor ? { cursor } : {}) },
    });
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && runs.length < 2_000);
  runs.sort((left, right) => left.turnNumber - right.turnNumber);
  const userIndex = runs.findIndex((run) => run.runId === selectedMessage.runId);
  const targetRun = userIndex < 0 ? undefined : runs[userIndex];
  const checkpoint = targetRun?.startCheckpointRef;
  if (!targetRun || !checkpoint) throw new Error("Cursor has no checkpoint for that message");
  const agent = await store.agents.get({ agentId: state.agentId });
  if (!agent) throw new Error("Cursor no longer has this agent");
  await store.agents.update({
    agent: {
      ...agent,
      status: "idle",
      activeRunId: null,
      latestCheckpoint: checkpoint,
      updatedAt: Date.now(),
    },
  });
  const discardedRunIds = runs.slice(userIndex).map((run) => run.runId);
  if (discardedRunIds.length > 0) {
    await store.runEvents.delete({ filter: { runIds: discardedRunIds } });
    await store.runs.delete({ filter: { agentIds: [state.agentId], runIds: discardedRunIds } });
  }
  const transcriptIndex = state.messages.findIndex((message) => message.id === messageId);
  state.messages.splice(transcriptIndex);
  state.openTextParts.clear();
  state.currentAssistantMessageId = undefined;
  state.error = undefined;
  state.revision += 1;
  boundTranscript(state);
}

export interface ComposerPatch {
  modelId?: string;
  reasoningId?: string;
  modeId?: "build" | "plan";
  fastMode?: boolean;
  parameterValues?: Record<string, string | boolean>;
}

export function parseComposerPatch(body: unknown): ComposerPatch | undefined {
  if (!isObject(body)) return undefined;
  const patch: ComposerPatch = {};
  if (nonBlank(body.modelId)) patch.modelId = body.modelId.trim();
  if (nonBlank(body.model)) patch.modelId ??= body.model.trim();
  if (nonBlank(body.reasoningId)) patch.reasoningId = body.reasoningId.trim();
  if (nonBlank(body.effort)) patch.reasoningId ??= body.effort.trim();
  if (body.mode === "plan" || body.mode === "build") patch.modeId = body.mode;
  if (body.modeId === "plan" || body.modeId === "build") patch.modeId ??= body.modeId;
  if (typeof body.fastMode === "boolean") patch.fastMode = body.fastMode;
  if (isObject(body.parameterValues)) {
    patch.parameterValues = Object.fromEntries(
      Object.entries(body.parameterValues)
        .filter(([, value]) => typeof value === "string" || typeof value === "boolean")
        .slice(0, 64),
    ) as Record<string, string | boolean>;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * Record a composer selection. Deliberately does not touch the attached agent.
 *
 * Model and mode are fixed at `Agent.create`, but `dispatchPrompt` sends both
 * explicitly on every turn, so a change takes effect on the next prompt without
 * throwing away a warm agent — or the conversation it holds. That per-send
 * override in `prompt.ts` is the only thing applying the user's choice: remove
 * it as redundant and model and mode selections silently stop working.
 */
export function applyComposerPatch(state: SessionState, patch: ComposerPatch | undefined): boolean {
  if (!patch) return false;
  let changed = false;
  const modelChanged = Boolean(patch.modelId && patch.modelId !== state.composer.selectedModelId);
  if (modelChanged) {
    state.composer = {
      ...state.composer,
      selectedModelId: patch.modelId,
      // A model change invalidates the reasoning selection unless the caller
      // sent one alongside: the axis is per-model, so carrying the old id over
      // would send parameters the new model does not define.
      selectedReasoningId: patch.reasoningId,
      parameterValues: patch.parameterValues ?? {},
    };
    changed = true;
  } else if (patch.reasoningId && patch.reasoningId !== state.composer.selectedReasoningId) {
    state.composer = { ...state.composer, selectedReasoningId: patch.reasoningId };
    changed = true;
  }
  if (patch.modeId && patch.modeId !== state.composer.selectedModeId) {
    state.composer = { ...state.composer, selectedModeId: patch.modeId };
    changed = true;
  }
  if (patch.fastMode !== undefined && patch.fastMode !== state.composer.fastModeEnabled) {
    state.composer = { ...state.composer, fastModeEnabled: patch.fastMode };
    changed = true;
  }
  if (patch.parameterValues && !modelChanged) {
    state.composer = {
      ...state.composer,
      parameterValues: { ...state.composer.parameterValues, ...patch.parameterValues },
    };
    changed = true;
  }
  if (changed) state.revision += 1;
  return changed;
}

/**
 * Sessions this workspace can be resumed into.
 *
 * Scoped to `cwd` so the picker offers this environment's own history rather
 * than every agent the user has ever run on this machine.
 */
export async function listResumableSessions(): Promise<JsonObject[]> {
  const { apiKey } = await resolveCredential();
  if (!apiKey) return [];
  const items: SDKAgentInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await Agent.list({
      runtime: "local",
      cwd: workingDirectory,
      limit: MAX_RESUME_ENTRIES,
      ...(cursor ? { cursor } : {}),
    }).catch(() => ({ items: [], nextCursor: undefined }));
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < 2_000);

  return items.slice(0, 2_000).map((item) => ({
    // This is the bridge wire shape, not the normalized service shape. The
    // shared backend provider reads `id` here and turns it into `sessionId` for
    // the renderer; returning `sessionId` directly makes it discard every row.
    id: item.agentId,
    ...(item.name?.trim() ? { title: item.name.trim() } : {}),
    ...(item.createdAt ? { createdAt: new Date(item.createdAt).toISOString() } : {}),
    ...(item.lastModified ? { updatedAt: new Date(item.lastModified).toISOString() } : {}),
    status: item.status === "running" ? "running" : item.status === "error" ? "error" : "idle",
    ...(item.summary?.trim() ? { detail: item.summary.trim().slice(0, 200) } : {}),
  }));
}

/**
 * Adopt an existing SDK agent as a new bridge session, replaying its history.
 *
 * The replay is best-effort and deliberately so. A resumed conversation whose
 * history could not be read is still a working session — the model retains its
 * own context regardless of what this transcript shows — so a failed replay
 * degrades to an empty transcript rather than a failed resume.
 */
export async function resumeSession(
  agentId: string,
  patch: ComposerPatch | undefined,
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
): Promise<SessionState> {
  const state = newSessionState(undefined, resolveCursorExecutionPolicy(policy));
  state.agentId = agentId;
  applyComposerPatch(state, patch);
  state.composer = await hydrateComposer(state.composer);
  await hydrateHistory(state).catch(() => undefined);
  sessions.set(state.id, state);
  void recoverActiveRun(state);
  return state;
}

/**
 * Rebuild the transcript from the SDK's own record of past runs.
 *
 * Runs are read rather than messages: `Agent.messages.list` reports only the
 * user and assistant text, which would silently drop every tool call from a
 * resumed session. A run's conversation carries the full step list, and its
 * tool calls are the same shape a live turn emits, so they render identically.
 */
async function hydrateHistory(state: SessionState): Promise<void> {
  if (!state.agentId) return;
  const runs = await listAllRuns(state.agentId);
  for (const run of runs) {
    if (!run.supports("conversation")) continue;
    const turns = await run.conversation().catch(() => []);
    for (const turn of turns) appendHistoricTurn(state, turn, run.id);
  }
  boundTranscript(state);
  state.revision += 1;
}

async function listAllRuns(agentId: string): Promise<Run[]> {
  const runs: Run[] = [];
  let cursor: string | undefined;
  do {
    const page = await withTimeout(
      Agent.listRuns(agentId, {
        runtime: "local",
        cwd: workingDirectory,
        limit: MAX_RESUME_ENTRIES,
        ...(cursor ? { cursor } : {}),
      }),
      CATALOG_TIMEOUT_MS,
    );
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && runs.length < 2_000);
  return runs;
}

/** Re-adopt a local run that survived a bridge restart. */
async function recoverActiveRun(state: SessionState): Promise<void> {
  if (!state.agentId || state.activeRun || state.status === "running") return;
  const runs = await listAllRuns(state.agentId).catch(() => []);
  const active = [...runs].reverse().find((run) => run.status === "running");
  if (!active) return;
  state.activeRun = active;
  state.status = "running";
  state.turnStartedAt = active.createdAt;
  state.cancelTurn = () => active.cancel();
  state.revision += 1;
  const unsubscribe = active.onDidChangeStatus(() => {
    state.revision += 1;
  });
  void (async () => {
    try {
      for await (const _event of active.stream()) {
        // The recovered run had no live onDelta callback. Its authoritative
        // conversation is replayed below once the stream settles.
      }
      await active.wait();
      state.messages = [];
      state.uncheckedTranscriptBytes = 0;
      await hydrateHistory(state);
      state.status = active.status === "error" ? "error" : "idle";
      state.error = active.error?.message;
    } catch (error) {
      state.status = "error";
      state.error = error instanceof Error ? error.message : "Cursor run recovery failed";
    } finally {
      unsubscribe();
      if (state.activeRun === active) state.activeRun = undefined;
      state.cancelTurn = undefined;
      state.revision += 1;
    }
  })();
}

function appendHistoricTurn(state: SessionState, turn: unknown, runId: string): void {
  if (!isObject(turn) || !isObject(turn.turn)) return;
  if (turn.type === "shellConversationTurn") {
    appendHistoricShellTurn(state, turn.turn);
    return;
  }
  const body = turn.turn;
  const userText =
    isObject(body.userMessage) && nonBlank(body.userMessage.text)
      ? body.userMessage.text
      : undefined;
  if (userText) pushMessage(state, "user", userText, [], undefined, { runId });
  if (!Array.isArray(body.steps) || body.steps.length === 0) return;

  const parts: BridgeMessagePart[] = [];
  const messageId = randomBytes(12).toString("hex");
  let content = "";
  for (const step of body.steps) {
    if (!isObject(step) || !isObject(step.message)) continue;
    if (step.type === "assistantMessage" && nonBlank(step.message.text)) {
      content += step.message.text;
      parts.push({
        type: "text",
        content: step.message.text,
        sourcePartId: `${messageId}:${parts.length}`,
        sourceMessageId: messageId,
      });
    } else if (step.type === "thinkingMessage" && nonBlank(step.message.text)) {
      parts.push({
        type: "thinking",
        content: step.message.text,
        sourcePartId: `${messageId}:${parts.length}`,
        sourceMessageId: messageId,
      });
    } else if (step.type === "toolCall") {
      const rendered = renderToolCall(step.message, state.health);
      parts.push({
        type: "tool-invocation",
        content: rendered.toolTitle ?? rendered.toolName,
        sourcePartId: `${messageId}:${parts.length}`,
        sourceMessageId: messageId,
        // A historic call has no live call id, so key it on its position. It
        // only has to be unique within this message: nothing will patch it.
        toolUseId: `${messageId}:tool:${parts.length}`,
        toolName: rendered.toolName,
        toolTitle: rendered.toolTitle,
        ...(rendered.toolArgs ? { toolArgs: rendered.toolArgs } : {}),
        ...(rendered.toolOutput !== undefined ? { toolOutput: rendered.toolOutput } : {}),
        ...(rendered.toolError !== undefined ? { toolError: rendered.toolError } : {}),
        ...(rendered.toolDiff ? { toolDiff: rendered.toolDiff } : {}),
        toolState: rendered.toolError === undefined ? "success" : "failure",
        // Replayed history is settled by definition: whatever these sub-agents
        // were doing, they are not doing it on this bridge's watch.
        ...(rendered.subagent ? { agentState: "finished" as const } : {}),
      });
    }
  }
  if (parts.length > 0) {
    const planReview = parts.some(
      (part) => part.type === "tool-invocation" && isCreatePlanToolName(part.toolName),
    );
    pushMessage(state, "assistant", content, parts, messageId, { planReview });
  }
}

function isCreatePlanToolName(toolName: string | undefined): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return normalized === "createplan" || normalized === "create_plan";
}

function appendHistoricShellTurn(state: SessionState, body: Record<string, unknown>): void {
  const command =
    isObject(body.shellCommand) && nonBlank(body.shellCommand.command)
      ? body.shellCommand.command
      : undefined;
  if (!command) return;
  const rendered = renderToolCall({
    type: "shell",
    args: body.shellCommand,
    ...(isObject(body.shellOutput)
      ? { result: { status: "success", value: body.shellOutput } }
      : {}),
  });
  const messageId = randomBytes(12).toString("hex");
  pushMessage(
    state,
    "assistant",
    "",
    [
      {
        type: "tool-invocation",
        content: rendered.toolTitle ?? command,
        sourcePartId: `${messageId}:0`,
        sourceMessageId: messageId,
        toolUseId: `${messageId}:tool:0`,
        toolName: "shell",
        toolTitle: rendered.toolTitle,
        ...(rendered.toolArgs ? { toolArgs: rendered.toolArgs } : {}),
        ...(rendered.toolOutput !== undefined ? { toolOutput: rendered.toolOutput } : {}),
        toolState: "success",
      },
    ],
    messageId,
  );
}

function pushMessage(
  state: SessionState,
  role: "user" | "assistant",
  content: string,
  parts: BridgeMessagePart[],
  messageId = randomBytes(12).toString("hex"),
  extras?: { runId?: string; planReview?: boolean },
): void {
  const message: BridgeMessage = {
    id: messageId,
    role,
    content,
    parts:
      parts.length > 0 || !content
        ? parts
        : [
            {
              type: "text",
              content,
              sourcePartId: `${messageId}:0`,
              sourceMessageId: messageId,
            },
          ],
    createdAt: new Date().toISOString(),
    ...(extras?.runId ? { runId: extras.runId } : {}),
    ...(extras?.planReview ? { planReview: true } : {}),
  };
  state.messages.push(message);
  chargeTranscript(state, Buffer.byteLength(JSON.stringify(message)));
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cursor history read timed out")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
