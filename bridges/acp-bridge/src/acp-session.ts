import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  applyConfigOptionUpdate,
  applyCurrentModeUpdate,
  applyGrokCatalogUpdate,
  applyGrokModelChange,
  normalizeAcpSessionConfig,
  planComposerApply,
  type AcpComposerPatch,
} from "./session-config.js";
import { parseAcpTurnUsage } from "./usage.js";
import {
  AcpProcess,
  MAX_APPROVALS_PER_SESSION,
  MAX_MESSAGES,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_MODEL_ID_BYTES,
  MAX_PARTS_PER_MESSAGE,
  MAX_SESSIONS,
  MAX_SESSION_LIST_PAGES,
  MAX_RESUMABLE_SESSIONS,
  MAX_TOOL_ID_BYTES,
  MAX_TOOL_PATH_BYTES,
  MAX_TOOL_TITLE_BYTES,
  RPC_TIMEOUT_MS,
  TRANSCRIPT_CHECK_INTERVAL_BYTES,
  HttpError,
  activeSessionReservations,
  adjustAnonymousSessionCreations,
  clientSessionKeys,
  externalSessionToken,
  isObject,
  isCursorTaskMethod,
  isCursorUpdateTodosMethod,
  parseExternalSessionToken,
  provider,
  rememberCatalog,
  sessionCreations,
  sessionListProbe,
  setSessionListProbe,
  sessionResumes,
  sessions,
  agentRuntime,
  saturatedText,
  shuttingDown,
  supportsSessionCapability,
  workingDirectory,
  type AcpSpawnOptions,
  type BridgeMessage,
  type BridgeTextPart,
  type JsonObject,
  type SessionState,
} from "./acp-context.js";
import {
  appendBounded,
  appendSaturating,
  boundTranscript,
  boundedString,
  contentText,
  failTranscriptLimit,
  findHistoryMessage,
  isTranscriptUpdateKind,
  isTrimNotice,
  rememberHistoryMessage,
  trimPartsTo,
  turnRequiresCompleteOutput,
} from "./acp-transcript.js";
import {
  applyAcpPlanUpdate,
  applyCursorTask,
  applyCursorUpdateTodos,
  applySubagentFinished,
  applySubagentSpawned,
  applyToolCallUpdate,
  boundedModelId,
  restoreCursorTodosFromMessages,
} from "./acp-tools.js";
import { reconcileStaleToolParts } from "./acp-reconciliation.js";
import { emptySessionConfig } from "./acp-persistence.js";
import { persistState, schedulePersist } from "./acp-persist-writer.js";

export async function listResumableSessions(): Promise<JsonObject[]> {
  if (sessionListProbe) return sessionListProbe;
  const operation = listResumableSessionsReserved();
  setSessionListProbe(operation);
  try {
    return await operation;
  } finally {
    if (sessionListProbe === operation) setSessionListProbe(null);
  }
}

export async function listResumableSessionsReserved(): Promise<JsonObject[]> {
  const child = new AcpProcess();
  try {
    const initialized = await child.initialize();
    const capabilities = isObject(initialized.agentCapabilities)
      ? initialized.agentCapabilities
      : undefined;
    if (!supportsSessionCapability(initialized, "list") || capabilities?.loadSession !== true) {
      throw new HttpError(410, `${provider} cannot list resumable ACP sessions`);
    }
    const knownSessions = new Map(
      [...sessions.values()].map((state) => [state.acpSessionId, state.id]),
    );
    const listed: JsonObject[] = [];
    const seenSessionIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (
      let page = 0;
      page < MAX_SESSION_LIST_PAGES && listed.length < MAX_RESUMABLE_SESSIONS;
      page += 1
    ) {
      const result = await child.request("session/list", {
        cwd: workingDirectory,
        ...(cursor ? { cursor } : {}),
      });
      if (!isObject(result) || !Array.isArray(result.sessions)) {
        throw new Error(`${provider} returned an invalid ACP session list`);
      }
      for (const candidate of result.sessions) {
        if (!isObject(candidate)) continue;
        const acpSessionId = boundedString(candidate.sessionId, 512)?.trim();
        if (!acpSessionId || seenSessionIds.has(acpSessionId)) continue;
        const cwd = boundedString(candidate.cwd, MAX_TOOL_PATH_BYTES)?.trim();
        if (!cwd || resolve(cwd) !== workingDirectory) continue;
        seenSessionIds.add(acpSessionId);
        const meta = isObject(candidate._meta) ? candidate._meta : undefined;
        const messageCount =
          Number.isSafeInteger(meta?.messageCount) && Number(meta?.messageCount) >= 0
            ? Number(meta!.messageCount)
            : undefined;
        const createdAt = boundedString(candidate.createdAt, 64);
        const updatedAt = boundedString(candidate.updatedAt, 64);
        listed.push({
          id: knownSessions.get(acpSessionId) ?? externalSessionToken(acpSessionId),
          ...(boundedString(candidate.title, MAX_TOOL_TITLE_BYTES)
            ? { title: boundedString(candidate.title, MAX_TOOL_TITLE_BYTES) }
            : {}),
          ...(createdAt ? { createdAt } : {}),
          ...(updatedAt ? { updatedAt } : {}),
          ...(messageCount === undefined ? {} : { messageCount }),
        });
        if (listed.length >= MAX_RESUMABLE_SESSIONS) break;
      }
      const nextCursor = boundedString(result.nextCursor, 4_096)?.trim();
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return listed;
  } finally {
    await child.close();
  }
}

export async function resumeSession(
  selectedSessionId: string,
  signal?: AbortSignal,
  patch?: AcpComposerPatch,
): Promise<SessionState> {
  const existing = sessions.get(selectedSessionId);
  if (existing) return resumeExistingSession(existing, signal, patch);
  const acpSessionId = parseExternalSessionToken(selectedSessionId);
  if (!acpSessionId) throw new HttpError(404, "ACP session was not found");
  // Checked before the `sessions` scan below: an adoption registers its state
  // before `session/load` returns, so a racing caller would otherwise find a
  // still-dispatching session and be told 409 for work it should simply join.
  // The in-flight adoption also carries the *first* caller's controls, so this
  // caller has to apply its own rather than inherit them silently.
  const pending = sessionResumes.get(acpSessionId);
  if (pending) {
    const adopted = await pending;
    return patch ? resumeExistingSession(adopted, signal, patch) : adopted;
  }
  const alreadyLoaded = [...sessions.values()].find((state) => state.acpSessionId === acpSessionId);
  if (alreadyLoaded) return resumeExistingSession(alreadyLoaded, signal, patch);
  if (activeSessionReservations() >= MAX_SESSIONS)
    throw new HttpError(429, "ACP session limit reached");
  const operation = resumeSessionReserved(acpSessionId, signal, patch);
  sessionResumes.set(acpSessionId, operation);
  try {
    return await operation;
  } finally {
    if (sessionResumes.get(acpSessionId) === operation) sessionResumes.delete(acpSessionId);
  }
}

export async function resumeExistingSession(
  state: SessionState,
  signal?: AbortSignal,
  patch?: AcpComposerPatch,
): Promise<SessionState> {
  if (state.status === "running" || state.dispatching) {
    throw new HttpError(409, "Session is already running");
  }
  state.dispatching = true;
  try {
    await ensureSessionProcess(state, signal);
    if (patch) await applyComposerPatch(state, patch, signal);
    return state;
  } finally {
    state.dispatching = false;
  }
}

export async function resumeSessionReserved(
  acpSessionId: string,
  signal?: AbortSignal,
  patch?: AcpComposerPatch,
): Promise<SessionState> {
  const child = new AcpProcess();
  let state: SessionState | undefined;
  try {
    const initialized = await child.initialize(signal);
    const capabilities = isObject(initialized.agentCapabilities)
      ? initialized.agentCapabilities
      : undefined;
    if (capabilities?.loadSession !== true) {
      throw new HttpError(410, `${provider} cannot reload persisted ACP sessions`);
    }
    state = {
      id: randomBytes(16).toString("hex"),
      acpSessionId,
      status: "idle",
      messages: [],
      activeSubagentToolIds: new Set(),
      activeSubagentDescriptors: new Map(),
      settledCursorAgentIds: new Set(),
      subagentLimitExceeded: false,
      subagentToolIds: new Map(),
      cursorTodos: [],
      historyMessageIds: new Map(),
      child,
      revision: 0,
      structured: new Map(),
      promptJournal: new Map(),
      approvals: new Map(),
      outputTruncated: false,
      uncheckedTranscriptBytes: 0,
      currentTurnOutput: null,
      promptSequence: 0,
      droppedMessages: 0,
      droppedParts: 0,
      transcriptTruncated: false,
      sessionConfig: emptySessionConfig(),
      dispatching: true,
      historyReplay: "hydrate",
    };
    attachChild(state, child);
    sessions.set(state.id, state);
    const loaded = await child.request(
      "session/load",
      {
        cwd: workingDirectory,
        additionalDirectories: [],
        mcpServers: [],
        sessionId: acpSessionId,
      },
      RPC_TIMEOUT_MS,
      signal,
    );
    state.historyReplay = false;
    // session/load is a projection of work owned by another ACP process. Its
    // historical active markers cannot describe children of this new process.
    reconcileStaleToolParts(state, true);
    state.cursorTodos = restoreCursorTodosFromMessages(state.messages);
    if (isObject(loaded)) {
      const sessionConfig = normalizeAcpSessionConfig(provider, {
        ...loaded,
        sessionId: acpSessionId,
      });
      if (sessionConfig.composer.models.length > 0 || sessionConfig.composer.modes.length > 0) {
        state.sessionConfig = sessionConfig;
        rememberCatalog(sessionConfig.composer);
      }
    }
    state.status = "idle";
    state.error = undefined;
    if (patch) await applyComposerPatch(state, patch, signal);
    state.dispatching = false;
    await persistState();
    return state;
  } catch (error) {
    if (state && sessions.get(state.id) === state) sessions.delete(state.id);
    if (state) clearApprovals(state);
    await child.close();
    await persistState().catch(() => undefined);
    throw error;
  }
}

export async function createSession(
  clientSessionKey?: string,
  signal?: AbortSignal,
  spawnOptions: AcpSpawnOptions & AcpComposerPatch = {},
): Promise<SessionState> {
  if (clientSessionKey) {
    const existingId = clientSessionKeys.get(clientSessionKey);
    if (existingId) {
      const existing = sessions.get(existingId);
      if (existing) return existing;
    }
    const pending = sessionCreations.get(clientSessionKey);
    if (pending) return pending;
  }
  if (activeSessionReservations() >= MAX_SESSIONS)
    throw new HttpError(429, "ACP session limit reached");

  const operation = createSessionReserved(clientSessionKey, signal, spawnOptions);
  if (clientSessionKey) sessionCreations.set(clientSessionKey, operation);
  else adjustAnonymousSessionCreations(1);
  try {
    return await operation;
  } finally {
    if (clientSessionKey) {
      if (sessionCreations.get(clientSessionKey) === operation)
        sessionCreations.delete(clientSessionKey);
    } else {
      adjustAnonymousSessionCreations(-1);
    }
  }
}

export async function createSessionReserved(
  clientSessionKey?: string,
  signal?: AbortSignal,
  spawnOptions: AcpSpawnOptions & AcpComposerPatch = {},
): Promise<SessionState> {
  const child = new AcpProcess({
    model: spawnOptions.model,
    effort: spawnOptions.effort ?? spawnOptions.reasoningId,
  });
  try {
    await child.initialize(signal);
    const created = await child.request(
      "session/new",
      { cwd: workingDirectory, additionalDirectories: [], mcpServers: [] },
      RPC_TIMEOUT_MS,
      signal,
    );
    if (!isObject(created) || typeof created.sessionId !== "string") {
      throw new Error(`${provider} returned an invalid ACP session`);
    }
    const id = randomBytes(16).toString("hex");
    const sessionConfig = normalizeAcpSessionConfig(provider, created);
    rememberCatalog(sessionConfig.composer);
    const state: SessionState = {
      id,
      ...(clientSessionKey ? { clientSessionKey } : {}),
      acpSessionId: created.sessionId,
      status: "idle",
      messages: [],
      activeSubagentToolIds: new Set(),
      activeSubagentDescriptors: new Map(),
      settledCursorAgentIds: new Set(),
      subagentLimitExceeded: false,
      subagentToolIds: new Map(),
      cursorTodos: [],
      historyMessageIds: new Map(),
      child,
      revision: 0,
      structured: new Map(),
      promptJournal: new Map(),
      approvals: new Map(),
      outputTruncated: false,
      uncheckedTranscriptBytes: 0,
      currentTurnOutput: null,
      promptSequence: 0,
      droppedMessages: 0,
      droppedParts: 0,
      transcriptTruncated: false,
      sessionConfig,
      // The session is reachable from `sessions` before its initial
      // configuration finishes, so hold the same claim the config and prompt
      // routes take rather than leaving a window where both see it idle.
      dispatching: true,
      historyReplay: false,
    };
    attachChild(state, child);
    sessions.set(id, state);
    if (clientSessionKey) clientSessionKeys.set(clientSessionKey, id);
    try {
      const patch = composerPatchFromSpawn(spawnOptions);
      if (patch) await applyComposerPatch(state, patch, signal);
      await persistState();
      state.dispatching = false;
      return state;
    } catch (error) {
      state.dispatching = false;
      if (sessions.get(id) === state) sessions.delete(id);
      if (clientSessionKey && clientSessionKeys.get(clientSessionKey) === id) {
        clientSessionKeys.delete(clientSessionKey);
      }
      clearApprovals(state);
      throw error;
    }
  } catch (error) {
    await child.close();
    throw error;
  }
}

export function attachChild(state: SessionState, child: AcpProcess): void {
  state.child = child;
  child.onUpdate = (params) => applySessionUpdate(state, params);
  child.onVendor = (method, params) => {
    // Same generation rule as `onClose` below: a superseded child can emit long
    // after a replacement attached, and letting it rewrite `sessionConfig`
    // would point the live session — and the process-wide catalogue — at a
    // catalogue the attached agent never advertised.
    if (state.child !== child || sessions.get(state.id) !== state) return;
    applyVendorUpdate(state, method, params);
  };
  child.onPermission = (requestId, params) => parkPermission(state, requestId, params);
  child.onClose = (error) => {
    // Only the currently attached child owns this session's approvals. A
    // superseded child can exit long after a replacement attached (close()
    // gives up waiting after three seconds), and clearing here would drop the
    // live child's parked approvals along with the timers that would have
    // denied them — leaving the agent waiting on a permission forever.
    if (state.child !== child || sessions.get(state.id) !== state || shuttingDown) return;
    clearApprovals(state);
    state.child = null;
    state.status = "error";
    state.error = error.message;
    // The agent is gone, so nothing will ever complete the tools it had open.
    reconcileStaleToolParts(state, true);
    state.revision += 1;
    schedulePersist();
  };
}

/**
 * Wait for `promise`, but stop waiting if `signal` aborts.
 *
 * The work itself is deliberately left running: an attach is shared between
 * callers, so one client disconnecting must not cancel the spawn another is
 * waiting on, and a finished attach is exactly what the next request needs.
 */
export async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Request aborted");
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The one attach in flight for this session, created on demand.
 *
 * `spawnAndLoadSession` reads `state.child` and then awaits a spawn, so without
 * a shared promise two concurrent callers would each start an agent process and
 * the loser's child would be orphaned. The prompt route's `dispatching` claim
 * does not cover this: the config route and the attach route reach the same
 * code without it.
 */
export function attachSessionProcess(state: SessionState): Promise<AcpProcess> {
  if (state.attaching) return state.attaching;
  const attach = spawnAndLoadSession(state);
  state.attaching = attach;
  const clear = (): void => {
    if (state.attaching === attach) state.attaching = undefined;
  };
  // Settling here also owns the rejection. A caller that gave up on its own
  // signal leaves this promise with no waiter, and an unhandled rejection under
  // Node semantics would take the bridge down with every session on it.
  attach.then(clear, clear);
  return attach;
}

export async function ensureSessionProcess(
  state: SessionState,
  signal?: AbortSignal,
): Promise<AcpProcess> {
  if (state.attaching) {
    return signal ? raceAbort(state.attaching, signal) : state.attaching;
  }
  if (state.child) return state.child;
  const attach = attachSessionProcess(state);
  return signal ? raceAbort(attach, signal) : attach;
}

export async function spawnAndLoadSession(state: SessionState): Promise<AcpProcess> {
  if (state.child) return state.child;
  const child = new AcpProcess();
  try {
    const initialized = await child.initialize();
    const capabilities = isObject(initialized.agentCapabilities)
      ? initialized.agentCapabilities
      : undefined;
    if (capabilities?.loadSession !== true) {
      throw new HttpError(410, `${provider} cannot reload persisted ACP sessions`);
    }
    attachChild(state, child);
    state.historyReplay = state.messages.length === 0 ? "hydrate" : "ignore";
    const hydratedHistory = state.historyReplay === "hydrate";
    const loaded = await child.request(
      "session/load",
      {
        cwd: workingDirectory,
        additionalDirectories: [],
        mcpServers: [],
        sessionId: state.acpSessionId,
      },
      RPC_TIMEOUT_MS,
    );
    state.historyReplay = false;
    if (hydratedHistory) reconcileStaleToolParts(state, true);
    state.cursorTodos = restoreCursorTodosFromMessages(state.messages);
    if (isObject(loaded)) {
      const sessionConfig = normalizeAcpSessionConfig(provider, {
        ...loaded,
        sessionId: state.acpSessionId,
      });
      if (sessionConfig.composer.models.length > 0 || sessionConfig.composer.modes.length > 0) {
        state.sessionConfig = sessionConfig;
        rememberCatalog(sessionConfig.composer);
      }
    }
    state.status = "idle";
    state.error = undefined;
    state.revision += 1;
    await persistState();
    return child;
  } catch (error) {
    if (state.child === child) state.child = null;
    state.historyReplay = false;
    await child.close();
    throw error;
  }
}

export function clearApprovals(state: SessionState): void {
  for (const approval of state.approvals.values()) clearTimeout(approval.timer);
  state.approvals.clear();
}

export function parkPermission(state: SessionState, requestId: number, params: JsonObject): void {
  const child = state.child;
  if (
    !child ||
    params.sessionId !== state.acpSessionId ||
    state.approvals.size >= MAX_APPROVALS_PER_SESSION
  ) {
    child?.respond(requestId, { outcome: { outcome: "cancelled" } });
    return;
  }
  const options = Array.isArray(params.options)
    ? params.options
        .flatMap((candidate) => {
          if (!isObject(candidate) || typeof candidate.optionId !== "string") return [];
          return [
            {
              optionId: candidate.optionId.slice(0, 256),
              name: (typeof candidate.name === "string"
                ? candidate.name
                : candidate.optionId
              ).slice(0, 256),
              ...(typeof candidate.kind === "string" ? { kind: candidate.kind.slice(0, 64) } : {}),
            },
          ];
        })
        .slice(0, 20)
    : [];
  const id = randomBytes(12).toString("hex");
  const requestedAt = Date.now();
  const expiresAt = requestedAt + 5 * 60_000;
  const finish = (optionId?: string) => {
    const approval = state.approvals.get(id);
    if (!approval) return;
    clearTimeout(approval.timer);
    state.approvals.delete(id);
    if (optionId && approval.options.some((option) => option.optionId === optionId)) {
      child.respond(requestId, { outcome: { outcome: "selected", optionId } });
    } else {
      child.respond(requestId, { outcome: { outcome: "cancelled" } });
    }
    state.revision += 1;
    schedulePersist();
  };
  const timer = setTimeout(() => finish(), expiresAt - requestedAt);
  timer.unref();
  state.approvals.set(id, {
    id,
    title: permissionTitle(params),
    options,
    requestedAt,
    expiresAt,
    respond: finish,
    timer,
  });
  state.revision += 1;
  schedulePersist();
}

export function permissionTitle(params: JsonObject): string {
  const toolCall = isObject(params.toolCall) ? params.toolCall : undefined;
  const title =
    typeof params.title === "string"
      ? params.title
      : typeof toolCall?.title === "string"
        ? toolCall.title
        : "Permission requested";
  return title.slice(0, 500);
}

export function applySessionUpdate(state: SessionState, params: JsonObject): void {
  if (params.sessionId !== state.acpSessionId || !isObject(params.update)) return;
  const update = params.update;
  const kind =
    typeof update.sessionUpdate === "string"
      ? update.sessionUpdate
      : typeof update.type === "string"
        ? update.type
        : "";
  if (kind === "usage_update" || kind === "state_update") {
    // Standard ACP occupancy (`usage_update`) and v2 turn-complete usage
    // (`state_update.usage`). Neither mutates the transcript. Cursor's CLI
    // adapter does not emit these yet; when it does, this is the path that
    // fills the agent info panel.
    //
    // A reconnect replays reports for turns this session already accounted for
    // and restored from its own state file, so they are dropped like the
    // replayed transcript around them. Re-latching them would stamp
    // `updatedAt` with the reconnect and merge an older turn's breakdown into
    // the newest one. `isTranscriptUpdateKind` cannot express this — usage
    // never touches the transcript — so the guard is spelled out here. A
    // hydrating load holds no snapshot of its own, and there its replay is the
    // only record the panel will ever get for that turn.
    if (state.historyReplay !== "ignore") recordTurnUsage(state, update);
    return;
  }
  if (kind === "config_option_update") {
    state.sessionConfig = applyConfigOptionUpdate(provider, state.sessionConfig, update);
    rememberCatalog(state.sessionConfig.composer);
    state.revision += 1;
    schedulePersist();
    return;
  }
  if (kind === "available_commands_update") {
    if (Array.isArray(update.availableCommands)) {
      state.commandCount = update.availableCommands.length;
      state.revision += 1;
      schedulePersist();
    }
    return;
  }
  if (kind === "current_mode_update") {
    const modeId =
      typeof update.currentModeId === "string"
        ? update.currentModeId
        : typeof update.modeId === "string"
          ? update.modeId
          : "";
    if (modeId) {
      state.sessionConfig = applyCurrentModeUpdate(state.sessionConfig, modeId);
      state.revision += 1;
      schedulePersist();
    }
    return;
  }
  // A reconnect replays a transcript the bridge already holds, so every update
  // that would mutate it has to be dropped — tool calls included. `tool_call`
  // upserts by id against the *trailing* message only, so a replayed historical
  // call finds no owner and appends a duplicate to whatever is at the tail.
  if (state.historyReplay === "ignore" && isTranscriptUpdateKind(kind)) return;
  if (kind === "subagent_spawned") {
    applySubagentSpawned(state, update);
    return;
  }
  if (kind === "subagent_finished") {
    applySubagentFinished(state, update);
    return;
  }
  if (state.outputTruncated) return;
  if (kind === "tool_call" || kind === "tool_call_update") {
    applyToolCallUpdate(state, update, kind === "tool_call");
    return;
  }
  if (kind === "plan" || kind === "plan_update") {
    applyAcpPlanUpdate(state, update);
    return;
  }
  if (
    kind !== "user_message" &&
    kind !== "user_message_chunk" &&
    kind !== "agent_message" &&
    kind !== "agent_message_chunk" &&
    kind !== "agent_thought_chunk"
  )
    return;
  // User content is authored by `/session/prompt`, which pushes the
  // authoritative message before dispatching the turn. An agent that echoes the
  // prompt back mid-turn would append the same text onto that message a second
  // time — and for a structured turn the echo carries the appended JSON Schema
  // instructions too. Only a `session/load` replay, where the bridge has no
  // record of its own, may introduce user messages.
  if (
    (kind === "user_message" || kind === "user_message_chunk") &&
    state.historyReplay !== "hydrate"
  )
    return;
  const text = contentText(update.content);
  if (!text) return;
  const role = kind === "user_message" || kind === "user_message_chunk" ? "user" : "assistant";
  const partType = kind === "agent_thought_chunk" ? "thinking" : "text";
  // A non-chunk update carries a complete message, so it always begins one.
  // Only chunks continue the message before them.
  const isChunk =
    kind === "user_message_chunk" ||
    kind === "agent_message_chunk" ||
    kind === "agent_thought_chunk";
  const providerMessageId = boundedString(update.messageId, MAX_TOOL_ID_BYTES)?.trim();
  let message = providerMessageId ? findHistoryMessage(state, providerMessageId) : undefined;
  const last = state.messages.at(-1);
  // With no provider message id there is no explicit boundary, so a chunk
  // continues the message before it regardless of part type: a thought chunk
  // followed by a text chunk is one assistant turn, not two.
  if (
    !message &&
    !providerMessageId &&
    isChunk &&
    last?.role === role &&
    (state.status === "running" || state.historyReplay === "hydrate")
  ) {
    message = last;
  }
  if (!message) {
    const modelId =
      role === "assistant"
        ? boundedModelId(state.sessionConfig.composer.selectedModelId)
        : undefined;
    message = {
      id: randomBytes(12).toString("hex"),
      role,
      content: "",
      parts: [],
      createdAt: new Date().toISOString(),
      ...(modelId ? { modelId } : {}),
    };
    state.messages.push(message);
  }
  if (providerMessageId) rememberHistoryMessage(state, providerMessageId, message.id);
  const lastPart = message.parts.at(-1);
  // The trim notice is a marker, not a stream. Appending a chunk to it would
  // rewrite the notice into agent output and lose the announcement.
  const previous = isTrimNotice(message, lastPart) ? undefined : lastPart;
  if (previous?.type !== partType && message.parts.length >= MAX_PARTS_PER_MESSAGE) {
    if (turnRequiresCompleteOutput(state)) {
      failTranscriptLimit(state);
      return;
    }
    state.droppedParts += trimPartsTo(message, MAX_PARTS_PER_MESSAGE - 1);
    state.transcriptTruncated = true;
  }
  const streaming = previous?.type === partType ? previous : undefined;
  const currentPartText = streaming?.content ?? "";
  const nextPartText = appendSaturating(streaming, currentPartText, text, MAX_MESSAGE_TEXT_BYTES);
  if (streaming) streaming.content = nextPartText.value;
  else {
    const created: BridgeTextPart = {
      type: partType,
      content: nextPartText.value,
      sourcePartId: `${message.id}:${message.parts.length}`,
      sourceMessageId: message.id,
      createdAt: new Date().toISOString(),
    };
    message.parts.push(created);
    // A single chunk can exceed the cap on its own, so the freshly pushed part
    // can already be saturated.
    if (nextPartText.truncated) saturatedText.add(created);
  }
  const nextContent =
    partType === "text"
      ? appendSaturating(message, message.content, text, MAX_MESSAGE_TEXT_BYTES)
      : { value: message.content, truncated: false };
  message.content = nextContent.value;
  if (role === "assistant" && partType === "text" && state.currentTurnOutput !== null) {
    const captured = appendBounded(state.currentTurnOutput, text, MAX_MESSAGE_TEXT_BYTES);
    state.currentTurnOutput = captured.value;
    if (captured.truncated) state.outputTruncated = true;
  }
  state.revision += 1;
  state.uncheckedTranscriptBytes += Buffer.byteLength(text) * (partType === "text" ? 2 : 1);
  const transcriptTruncated =
    state.messages.length > MAX_MESSAGES ||
    state.uncheckedTranscriptBytes >= TRANSCRIPT_CHECK_INTERVAL_BYTES
      ? boundTranscript(state)
      : false;
  if (
    (nextPartText.truncated || nextContent.truncated || transcriptTruncated) &&
    turnRequiresCompleteOutput(state)
  ) {
    failTranscriptLimit(state);
    return;
  }
  schedulePersist();
}

export function composerPatchFromSpawn(
  options: AcpSpawnOptions & AcpComposerPatch,
): AcpComposerPatch | undefined {
  const patch: AcpComposerPatch = {};
  if (options.modelId || options.model) patch.modelId = options.modelId ?? options.model;
  if (options.reasoningId || options.effort)
    patch.reasoningId = options.reasoningId ?? options.effort;
  if (options.fastMode !== undefined) patch.fastMode = options.fastMode;
  if (options.mode) patch.mode = options.mode;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function parseComposerPatch(body: JsonObject): AcpComposerPatch | undefined {
  const mode = body.mode === "plan" || body.mode === "build" ? body.mode : undefined;
  const modelId =
    typeof body.modelId === "string"
      ? body.modelId.trim()
      : typeof body.model === "string"
        ? body.model.trim()
        : "";
  const reasoningId =
    typeof body.reasoningId === "string"
      ? body.reasoningId.trim()
      : typeof body.reasoningEffort === "string"
        ? body.reasoningEffort.trim()
        : "";
  const patch: AcpComposerPatch = {
    ...(modelId ? { modelId } : {}),
    ...(reasoningId ? { reasoningId } : {}),
    ...(typeof body.fastMode === "boolean" ? { fastMode: body.fastMode } : {}),
    ...(mode ? { mode } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export async function applyComposerPatch(
  state: SessionState,
  patch: AcpComposerPatch,
  signal?: AbortSignal,
): Promise<void> {
  if (!patch.modelId && !patch.reasoningId && patch.fastMode === undefined && !patch.mode) return;
  const child = await ensureSessionProcess(state, signal);
  const calls = planComposerApply(state.acpSessionId, state.sessionConfig, patch);
  for (const call of calls) {
    const result = await child.request(call.method, call.params, RPC_TIMEOUT_MS, signal);
    if (call.method === "session/set_config_option") {
      state.sessionConfig = applyConfigOptionUpdate(
        provider,
        state.sessionConfig,
        isObject(result) ? result : {},
      );
    } else if (call.method === "session/set_mode") {
      state.sessionConfig = applyCurrentModeUpdate(state.sessionConfig, call.params.modeId);
    } else if (call.method === "session/set_model") {
      const meta = isObject(result) && isObject(result._meta) ? result._meta : {};
      const model = isObject(meta.model) ? meta.model : {};
      state.sessionConfig = applyGrokModelChange(provider, state.sessionConfig, {
        model_id: typeof model.Ok === "string" ? model.Ok : call.params.modelId,
        reasoning_effort: call.params._meta?.reasoningEffort,
      });
    }
  }
  rememberCatalog(state.sessionConfig.composer);
  state.revision += 1;
  await persistState();
}

export function applyVendorUpdate(state: SessionState, method: string, params: JsonObject): void {
  if (isCursorTaskMethod(method)) {
    applyCursorTask(state, params);
    return;
  }
  if (isCursorUpdateTodosMethod(method)) {
    applyCursorUpdateTodos(state, params);
    return;
  }
  const update = isObject(params.update) ? params.update : params;
  const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  if (method.endsWith("/models/update") || kind === "models_update") {
    state.sessionConfig = applyGrokCatalogUpdate(provider, state.sessionConfig, update);
    rememberCatalog(state.sessionConfig.composer);
    state.revision += 1;
    schedulePersist();
    return;
  }
  if (kind === "model_changed") {
    state.sessionConfig = applyGrokModelChange(provider, state.sessionConfig, update);
    rememberCatalog(state.sessionConfig.composer);
    state.revision += 1;
    schedulePersist();
    return;
  }
  if (kind !== "turn_completed" && kind !== "response_completed") return;
  // Unlike a model update, this is scoped to one conversation, so a superseded
  // or unrelated child must not write another session's token counts.
  if (params.sessionId !== undefined && params.sessionId !== state.acpSessionId) return;
  recordTurnUsage(state, update);
}

/**
 * Latch the usage an agent reports for the turn that just ended.
 *
 * Grok announces the same numbers up to three times (`response_completed`,
 * `turn_completed`, and the prompt result), each with a different subset of the
 * fields, so later reports merge into earlier ones instead of replacing them —
 * otherwise the panel would lose the reasoning or cache breakdown the moment a
 * sparser carrier arrived for the same turn. ACP `usage_update` occupancy is
 * merged the same way so a later PromptResponse.usage cannot drop the window.
 */
export function recordTurnUsage(state: SessionState, payload: unknown): void {
  const turn = parseAcpTurnUsage(payload);
  if (!turn) return;
  const accumulatedTurn =
    state.turnStartedAt === undefined
      ? { ...state.usage?.turn, ...turn }
      : { ...state.currentTurnUsage, ...turn };
  if (state.turnStartedAt !== undefined) state.currentTurnUsage = accumulatedTurn;
  const durationMs =
    state.turnStartedAt === undefined
      ? state.usage?.durationMs
      : Math.max(0, Date.now() - state.turnStartedAt);
  const modelId = state.sessionConfig.composer.selectedModelId;
  state.usage = {
    turn: accumulatedTurn,
    ...(modelId ? { modelId } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    updatedAt: new Date().toISOString(),
  };
  state.revision += 1;
  schedulePersist();
}

/**
 * Record what the ACP handshake says about the agent binary. ACP standardizes
 * `agentInfo`; Grok predates that and answers with `_meta.agentVersion`, so both
 * are read and neither is required.
 *
 * The handshake's `_meta.mcpServers` is deliberately ignored: it reflects the
 * servers configured at that instant, which is none, and the agent announces
 * the real inventory moments later. Reporting the handshake value would state
 * that an agent has no MCP servers when it is about to load several.
 */
export function rememberAgentRuntime(initialized: JsonObject): void {
  const meta = isObject(initialized._meta) ? initialized._meta : {};
  const agentInfo = isObject(initialized.agentInfo) ? initialized.agentInfo : {};
  const version =
    typeof agentInfo.version === "string"
      ? agentInfo.version
      : typeof meta.agentVersion === "string"
        ? meta.agentVersion
        : undefined;
  if (version) agentRuntime.version = version.slice(0, 64);
}

/** Vendor notifications that describe the agent process rather than a session. */
export function rememberVendorRuntime(method: string, params: JsonObject): void {
  // The count only. These entries carry launch commands and arguments, which is
  // where an MCP server's API key lives.
  if (!method.endsWith("/mcp/servers_updated") || !Array.isArray(params.mcpServers)) return;
  if (agentRuntime.mcpServers === params.mcpServers.length) return;
  agentRuntime.mcpServers = params.mcpServers.length;
  // Every session reports this count, so every session's snapshot just changed.
  // Without the bump a mounted tab would keep serving the previous inventory
  // until something else happened to move its revision.
  for (const state of sessions.values()) state.revision += 1;
}
