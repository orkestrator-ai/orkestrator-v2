/**
 * Session lifecycle: creating, attaching, resuming, forking and detaching.
 *
 * A bridge session is durable; the Pi `AgentSession` that serves it is not.
 * The bridge keeps the rendered transcript, the prompt journal and the composer
 * selection, and attaches a Pi session lazily around them. That split is what
 * lets a bridge restart, an idle detach or a crashed process all recover
 * without the renderer seeing anything other than a session that was briefly
 * connecting.
 *
 * The model's own memory does not live here at all: Pi persists it to its own
 * JSONL session file, and re-attaching reopens that file. Losing this bridge's
 * state costs a rendered transcript; it never costs the conversation.
 */
import { randomBytes } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
  NativeAgentResumeEntry,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import {
  agentDirectory,
  CATALOG_TIMEOUT_MS,
  MAX_RESUME_ENTRIES,
  MAX_SLASH_COMMANDS,
  projectResourcesEnabled,
  sessionDirectory,
  workingDirectory,
} from "./config.js";
import { assertAuthenticated } from "./credentials.js";
import { requestToolApproval } from "./interactions.js";
import {
  emptyComposer,
  hydrateComposer,
  resolveModel,
  thinkingLevel,
  type ThinkingLevelDefaults,
} from "./models.js";
import { modelRuntime } from "./runtime.js";
import { withTimeout } from "./timeout.js";
import { applySessionEvent } from "./translate.js";
import { boundTranscript, chargeTranscript } from "./transcript.js";
import { renderToolCall } from "./tool-rendering.js";
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
    approvals: new Map(),
    todos: [],
    composer: emptyComposer(),
    session: null,
    dispatching: false,
    promptSequence: 0,
    openTextParts: new Map(),
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    queue: { steering: [], followUp: [] },
    slashCommands: [],
    compacting: false,
    lastAccessed: Date.now(),
  };
}

/**
 * Create a session, or return the one this client key already owns.
 *
 * Idempotent by `clientSessionKey` because the backend retries session
 * creation through a short bridge-startup race: without this, a retry that
 * lands after the first call succeeded would leave the user with two Pi
 * sessions and a tab pointed at only one of them.
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
 * Attach a Pi session to this bridge session, reusing an in-flight attach.
 *
 * Without the shared promise this is a check-then-act race: the function reads
 * `state.session`, then awaits a create, so two concurrent callers each see
 * null and each build a session — and each would open its own JSONL file for
 * the same conversation. Attach is reachable from the prompt route, the config
 * route and the explicit attach route, so that race is ordinary concurrency
 * rather than a corner case.
 */
export async function ensureSession(state: SessionState): Promise<AgentSession> {
  if (state.session) return state.session;
  state.attaching ??= attach(state).finally(() => {
    state.attaching = undefined;
  });
  return state.attaching;
}

async function attach(state: SessionState): Promise<AgentSession> {
  // Checked before anything expensive: an environment with no authenticated
  // provider must say so, rather than failing inside the first turn the user
  // paid to start.
  await assertAuthenticated();

  const runtime = await modelRuntime();
  const agentDir = agentDirectory() ?? getAgentDir();
  const settingsManager = SettingsManager.create(workingDirectory, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workingDirectory,
    agentDir,
    settingsManager,
    // `.pi/` in the workspace holds extensions, which are arbitrary TypeScript
    // this process would execute. Cloning a repository must not be enough to
    // run its code, so discovery is opt-in and only the container launcher
    // opts in. The gate is on every project-local resource family rather than
    // extensions alone, because a skill and a prompt template are also
    // repository-controlled text the model is told to act on.
    noExtensions: !projectResourcesEnabled,
    noSkills: !projectResourcesEnabled,
    noPromptTemplates: !projectResourcesEnabled,
    // The approval gate. Always loaded, discovery setting or not.
    extensionFactories: [{ name: "orkestrator", factory: approvalExtension(state) }],
  });
  await resourceLoader.reload();

  const model = await resolveModel(state.composer.selectedModelId);
  // Rebuilt with this workspace's settings now that there are some. A session
  // created before any catalogue read still gets the user's `/thinking` choice.
  state.composer = await hydrateComposer(state.composer, thinkingDefaults(settingsManager));
  const created = await createAgentSession({
    cwd: workingDirectory,
    agentDir,
    modelRuntime: runtime,
    resourceLoader,
    settingsManager,
    sessionManager: sessionManagerFor(state),
    ...(model ? { model } : {}),
    thinkingLevel: thinkingLevel(state.composer.selectedReasoningId, model) as never,
  });

  const session = created.session;
  state.session = session;
  state.piSessionId = session.sessionId;
  state.sessionFile = session.sessionFile;
  // The one subscription that builds the transcript. Held so detaching can
  // release it: a listener left attached to a disposed session keeps the whole
  // object graph — messages, tools, extension runner — alive.
  state.unsubscribe = session.subscribe((event) => applySessionEvent(state, event));
  state.slashCommands = readSlashCommands(session);
  // The catalogue read at create time may have preceded a provider signing in.
  // Re-selecting from the live session is what makes the picker agree with what
  // the turn will actually use.
  if (session.model) {
    state.composer = {
      ...state.composer,
      selectedModelId: `${session.model.provider}/${session.model.id}`,
    };
  }
  state.revision += 1;
  return session;
}

/**
 * Pi's stored thinking-level preferences, as the catalogue's two lookups.
 *
 * These are exactly what `/thinking` writes in a Pi terminal tab, so reading
 * them is what makes one preference serve both surfaces rather than each
 * remembering its own.
 */
function thinkingDefaults(settingsManager: SettingsManager): ThinkingLevelDefaults {
  return {
    perModel: (providerId, modelId) => settingsManager.getModelThinkingLevel(providerId, modelId),
    global: () => settingsManager.getDefaultThinkingLevel(),
  };
}

/**
 * Where Pi persists this session's own transcript.
 *
 * A session that has run before names its file and is reopened, which is what
 * keeps the model's context across a bridge restart. A file that no longer
 * exists degrades to a fresh session rather than a failed attach: a new
 * conversation with the transcript we already hold is a far better outcome
 * than a tab that can never send again.
 */
function sessionManagerFor(state: SessionState): SessionManager {
  const directory = sessionDirectory();
  if (state.sessionFile) {
    try {
      return SessionManager.open(state.sessionFile, directory, workingDirectory);
    } catch {
      state.sessionFile = undefined;
    }
  }
  return SessionManager.create(workingDirectory, directory);
}

/**
 * The approval gate, as a Pi extension.
 *
 * Registered inline rather than discovered, because it is this bridge's own
 * policy and must not be something a workspace can switch off. `tool_call` is
 * allowed to be async, which is the only reason a gate that waits for a human
 * can exist at all.
 */
function approvalExtension(state: SessionState): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const decision = await requestToolApproval(
        state,
        event.toolCallId,
        event.toolName,
        event.input,
      );
      return decision.block ? { block: true, reason: decision.reason } : undefined;
    });
  };
}

/**
 * Release the Pi session without touching the bridge session.
 *
 * Called on idle detach and on shutdown. The transcript, journal and session
 * file all survive, so the next request re-attaches transparently — and
 * because the file survives, it re-attaches to the *same* conversation.
 */
export async function detachSession(state: SessionState): Promise<void> {
  const session = state.session;
  const unsubscribe = state.unsubscribe;
  state.session = null;
  state.unsubscribe = undefined;
  unsubscribe?.();
  if (!session) return;
  try {
    session.dispose();
  } catch {
    // Disposal is best-effort. A session that refuses to release its listeners
    // must not stop the sweep releasing every other session behind it.
  }
}

export interface ComposerPatch {
  modelId?: string;
  reasoningId?: string;
}

export function parseComposerPatch(body: unknown): ComposerPatch | undefined {
  if (!isObject(body)) return undefined;
  const patch: ComposerPatch = {};
  if (nonBlank(body.modelId)) patch.modelId = body.modelId.trim();
  if (nonBlank(body.model)) patch.modelId ??= body.model.trim();
  if (nonBlank(body.reasoningId)) patch.reasoningId = body.reasoningId.trim();
  if (nonBlank(body.effort)) patch.reasoningId ??= body.effort.trim();
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * Apply a composer selection to the bridge state.
 *
 * Recorded here and pushed to the live session by {@link applyComposerToSession},
 * which is async because setting a model validates its auth. Splitting the two
 * keeps this callable from the synchronous prompt path, where the selection has
 * to be recorded before the turn is claimed.
 */
export function applyComposerPatch(state: SessionState, patch: ComposerPatch | undefined): boolean {
  if (!patch) return false;
  let changed = false;
  if (patch.modelId && patch.modelId !== state.composer.selectedModelId) {
    state.composer = {
      ...state.composer,
      selectedModelId: patch.modelId,
      // A model change invalidates the reasoning selection unless the caller
      // sent one alongside: thinking levels are per-model, so carrying the old
      // id over would send a level the new model marks unsupported.
      selectedReasoningId: patch.reasoningId,
    };
    changed = true;
  } else if (patch.reasoningId && patch.reasoningId !== state.composer.selectedReasoningId) {
    state.composer = { ...state.composer, selectedReasoningId: patch.reasoningId };
    changed = true;
  }
  if (changed) state.revision += 1;
  return changed;
}

/**
 * Push the recorded composer selection onto the attached session.
 *
 * Best-effort by design: a model the runtime rejects (its provider signed out
 * between the picker and the send) leaves the session on the model it already
 * had, which still runs, rather than failing a turn the user has already sent.
 */
export async function applyComposerToSession(state: SessionState): Promise<void> {
  const session = state.session;
  if (!session) return;
  const model = await resolveModel(state.composer.selectedModelId);
  if (model && (session.model?.id !== model.id || session.model?.provider !== model.provider)) {
    await session.setModel(model as never).catch(() => undefined);
  }
  // `off` is a level like any other here — Pi's own `ThinkingLevel` includes it,
  // and skipping it made "Off" the one selection in the picker that could never
  // be applied.
  const level = thinkingLevel(state.composer.selectedReasoningId, model);
  if (session.thinkingLevel !== level) session.setThinkingLevel(level as never);
}

/**
 * Sessions this workspace can be resumed into.
 *
 * Scoped to `cwd` so the picker offers this environment's own history rather
 * than every session the user has ever run on this machine.
 */
export async function listResumableSessions(): Promise<NativeAgentResumeEntry[]> {
  const listed = await withTimeout(
    SessionManager.list(workingDirectory, sessionDirectory()),
    CATALOG_TIMEOUT_MS,
    "Pi session list timed out",
  ).catch(() => []);

  return listed.slice(0, MAX_RESUME_ENTRIES).map((info) => ({
    // The *path* is the resume handle: two sessions can share an id across
    // session directories, and `SessionManager.open` takes a path.
    sessionId: info.path,
    ...(info.name?.trim() ? { title: info.name.trim() } : {}),
    ...(info.created ? { createdAt: new Date(info.created).toISOString() } : {}),
    ...(info.modified ? { updatedAt: new Date(info.modified).toISOString() } : {}),
    status: "idle" as const,
    ...(info.firstMessage?.trim() ? { detail: info.firstMessage.trim().slice(0, 200) } : {}),
  }));
}

/**
 * Adopt an existing Pi session file as a new bridge session, replaying it.
 *
 * The replay is best-effort and deliberately so. A resumed conversation whose
 * history could not be rendered is still a working session — Pi retains its own
 * context regardless of what this transcript shows — so a failed replay
 * degrades to an empty transcript rather than a failed resume.
 */
export async function resumeSession(
  sessionFile: string,
  patch: ComposerPatch | undefined,
): Promise<SessionState> {
  const state = newSessionState();
  state.sessionFile = sessionFile;
  applyComposerPatch(state, patch);
  state.composer = await hydrateComposer(state.composer);
  hydrateHistory(state);
  sessions.set(state.id, state);
  return state;
}

/**
 * Fork a session at one of its user messages.
 *
 * `createBranchedSession` writes a *new* JSONL file holding the path from the
 * root to that entry, so the fork is a genuinely independent conversation
 * rather than a copy of the rendered transcript — and the original keeps every
 * entry after the branch point. The new bridge session replays the forked
 * file, which is why the result is the same shape as a resume.
 *
 * `messageId` is a Pi entry id. The renderer passes back the id it was given,
 * and a fork with no id branches at the newest user message, which is what
 * "fork from here" means on a session nobody scrolled.
 */
export async function forkSession(
  state: SessionState,
  messageId: string | undefined,
): Promise<SessionState> {
  const session = await ensureSession(state);
  const entryId = messageId?.trim() || lastUserEntryId(session);
  if (!entryId) throw new Error("This session has no user message to fork from");
  const forkedFile = session.sessionManager.createBranchedSession(entryId);
  if (!forkedFile) throw new Error("Pi did not persist the forked session");
  return resumeSession(forkedFile, {
    ...(state.composer.selectedModelId ? { modelId: state.composer.selectedModelId } : {}),
    ...(state.composer.selectedReasoningId
      ? { reasoningId: state.composer.selectedReasoningId }
      : {}),
  });
}

function lastUserEntryId(session: AgentSession): string | undefined {
  const messages = session.getUserMessagesForForking();
  return messages[messages.length - 1]?.entryId;
}

/**
 * Rebuild the rendered transcript from Pi's own session file.
 *
 * Synchronous on purpose: `SessionManager` reads the file eagerly, so there is
 * no await to hide, and keeping it synchronous means a resume cannot interleave
 * with a live turn writing into the same transcript.
 */
function hydrateHistory(state: SessionState): void {
  const file = state.sessionFile;
  if (!file) return;
  let manager: SessionManager;
  try {
    manager = SessionManager.open(file, sessionDirectory(), workingDirectory);
  } catch {
    return;
  }
  state.piSessionId = manager.getSessionId();
  const name = manager.getSessionName();
  if (name?.trim()) state.title = name.trim();

  for (const entry of manager.getBranch()) appendHistoricEntry(state, entry);
  boundTranscript(state);
  state.revision += 1;
}

/**
 * Render one persisted session entry.
 *
 * Only the message entries carry conversation. The rest — model changes,
 * thinking-level changes, compaction bookkeeping — are session mechanics that
 * the live path also does not render, so replaying them would make a resumed
 * transcript strictly noisier than the one it is reproducing.
 */
function appendHistoricEntry(state: SessionState, entry: unknown): void {
  if (!isObject(entry) || entry.type !== "message") return;
  const message = entry.message;
  if (!isObject(message) || !nonBlank(message.role)) return;

  if (message.role === "user") {
    const text = readContentText(message.content);
    if (text) pushMessage(state, "user", text, []);
    return;
  }
  if (message.role === "toolResult") {
    applyHistoricToolResult(state, message);
    return;
  }
  if (message.role !== "assistant") return;

  const messageId = randomBytes(12).toString("hex");
  const parts: BridgeMessagePart[] = [];
  let content = "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const block of blocks) {
    if (!isObject(block)) continue;
    if (block.type === "text" && nonBlank(block.text)) {
      content += block.text;
      parts.push({
        type: "text",
        content: block.text,
        sourcePartId: `${messageId}:${parts.length}`,
        sourceMessageId: messageId,
      });
    } else if (block.type === "thinking" && nonBlank(block.thinking)) {
      parts.push({
        type: "thinking",
        content: block.thinking,
        sourcePartId: `${messageId}:${parts.length}`,
        sourceMessageId: messageId,
      });
    } else if (block.type === "toolCall") {
      const rendered = renderToolCall({
        toolName: nonBlank(block.name) ? block.name : "tool",
        input: block.arguments,
      });
      parts.push({
        type: "tool-invocation",
        content: rendered.toolTitle ?? rendered.toolName,
        sourcePartId: `${messageId}:${parts.length}`,
        sourceMessageId: messageId,
        // Keyed on the call id when the entry kept one, so a tool result
        // entry later in the branch patches the right card.
        toolUseId: nonBlank(block.id) ? block.id : `${messageId}:tool:${parts.length}`,
        toolName: rendered.toolName,
        toolTitle: rendered.toolTitle,
        ...(rendered.toolArgs ? { toolArgs: rendered.toolArgs } : {}),
        ...(rendered.toolDiff ? { toolDiff: rendered.toolDiff } : {}),
        // Replayed history is settled by definition. A result entry may refine
        // this to a failure; nothing can make it pending again.
        toolState: "success",
      });
    }
  }
  if (parts.length > 0) pushMessage(state, "assistant", content, parts, messageId);
}

/**
 * Fold a persisted tool-result message onto the card that requested it.
 *
 * Pi stores the call and its result as separate entries, so without this a
 * resumed transcript shows every tool as having produced nothing.
 */
function applyHistoricToolResult(state: SessionState, message: JsonObject): void {
  const toolCallId = nonBlank(message.toolCallId) ? message.toolCallId : undefined;
  if (!toolCallId) return;
  const rendered = renderToolCall({
    toolName: nonBlank(message.toolName) ? message.toolName : "tool",
    input: {},
    result: message,
    isError: message.isError === true,
  });
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    for (const part of state.messages[index]!.parts) {
      if (part.type !== "tool-invocation" || part.toolUseId !== toolCallId) continue;
      if (rendered.toolOutput !== undefined) part.toolOutput = rendered.toolOutput;
      if (rendered.toolError !== undefined) part.toolError = rendered.toolError;
      part.toolState = rendered.toolError === undefined ? "success" : "failure";
      return;
    }
  }
}

function readContentText(content: unknown): string {
  if (nonBlank(content)) return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const block of content) {
    if (nonBlank(block)) chunks.push(block);
    else if (isObject(block) && block.type === "text" && nonBlank(block.text))
      chunks.push(block.text);
  }
  return chunks.join("\n");
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

/**
 * The slash commands this session offers.
 *
 * Pi's are file-backed: prompt templates and skills discovered from the agent
 * directory and, when project resources are enabled, from the workspace. They
 * are read from the attached session rather than the loader so an extension
 * that registered one is included too.
 */
function readSlashCommands(session: AgentSession): NativeAgentSlashCommand[] {
  const commands: NativeAgentSlashCommand[] = [];
  for (const template of session.promptTemplates) {
    if (commands.length >= MAX_SLASH_COMMANDS) break;
    commands.push({
      name: `/${template.name}`,
      ...(template.description?.trim() ? { description: template.description.trim() } : {}),
      ...(template.argumentHint?.trim() ? { argumentHint: template.argumentHint.trim() } : {}),
    });
  }
  return commands;
}
