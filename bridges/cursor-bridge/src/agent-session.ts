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
  CATALOG_TIMEOUT_MS,
  MAX_RESUME_ENTRIES,
  sandboxEnabled,
  settingSources,
  workingDirectory,
} from "./config.js";
import { Agent, type SDKAgent } from "@cursor/sdk";
import { resolveCredential } from "./credentials.js";
import { emptyComposer, hydrateComposer, modelSelection } from "./models.js";
import { renderToolCall } from "./tool-rendering.js";
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

export function newSessionState(clientSessionKey?: string): SessionState {
  return {
    id: randomBytes(16).toString("hex"),
    ...(clientSessionKey ? { clientSessionKey } : {}),
    status: "idle",
    messages: [],
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
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
): Promise<SessionState> {
  if (clientSessionKey) {
    const existingId = clientSessionKeys.get(clientSessionKey);
    const existing = existingId ? sessions.get(existingId) : undefined;
    if (existing) return existing;
    const inFlight = sessionCreations.get(clientSessionKey);
    if (inFlight) return inFlight;
  }

  const work = (async () => {
    const state = newSessionState(clientSessionKey);
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

async function attach(state: SessionState): Promise<SDKAgent> {
  const { apiKey } = await resolveCredential();
  if (!apiKey) {
    throw new CredentialError(
      "Cursor is not signed in. Sign in from Settings › Cursor, or set a Cursor API key.",
    );
  }
  const options = {
    apiKey,
    model: modelSelection(state.composer),
    mode: state.composer.selectedModeId === "plan" ? ("plan" as const) : ("agent" as const),
    local: {
      cwd: workingDirectory,
      settingSources,
      sandboxOptions: { enabled: sandboxEnabled },
    },
  };

  // A session that already ran holds an agent id, and resuming it is what
  // keeps the model's own context across a bridge restart. A resume that fails
  // is not fatal: the id may name an agent the store no longer has, and a new
  // agent with the transcript we already hold is a far better outcome than a
  // tab that can never send again.
  if (state.agentId) {
    try {
      const resumed = await Agent.resume(state.agentId, options);
      state.agent = resumed;
      return resumed;
    } catch {
      state.agentId = undefined;
    }
  }

  const created = await Agent.create({ ...options, name: "Orkestrator" });
  state.agent = created;
  state.agentId = created.agentId;
  return created;
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
  state.agent = null;
  if (!agent) return;
  await agent[Symbol.asyncDispose]().catch(() => undefined);
}

export interface ComposerPatch {
  modelId?: string;
  reasoningId?: string;
  modeId?: "build" | "plan";
  fastMode?: boolean;
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
  if (patch.modelId && patch.modelId !== state.composer.selectedModelId) {
    state.composer = {
      ...state.composer,
      selectedModelId: patch.modelId,
      // A model change invalidates the reasoning selection unless the caller
      // sent one alongside: the axis is per-model, so carrying the old id over
      // would send parameters the new model does not define.
      selectedReasoningId: patch.reasoningId,
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
  const listed = await Agent.list({
    runtime: "local",
    cwd: workingDirectory,
    limit: MAX_RESUME_ENTRIES,
  }).catch(() => ({ items: [] }));

  return listed.items.slice(0, MAX_RESUME_ENTRIES).map((item) => ({
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
): Promise<SessionState> {
  const state = newSessionState();
  state.agentId = agentId;
  applyComposerPatch(state, patch);
  state.composer = await hydrateComposer(state.composer);
  await hydrateHistory(state).catch(() => undefined);
  sessions.set(state.id, state);
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
  const runs = await withTimeout(
    Agent.listRuns(state.agentId, { runtime: "local", cwd: workingDirectory }),
    CATALOG_TIMEOUT_MS,
  );
  for (const run of runs.items) {
    if (!run.supports("conversation")) continue;
    const turns = await run.conversation().catch(() => []);
    for (const turn of turns) appendHistoricTurn(state, turn);
  }
  boundTranscript(state);
  state.revision += 1;
}

function appendHistoricTurn(state: SessionState, turn: unknown): void {
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
  if (userText) pushMessage(state, "user", userText, []);
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
      const rendered = renderToolCall(step.message);
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
  if (parts.length > 0) pushMessage(state, "assistant", content, parts, messageId);
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
