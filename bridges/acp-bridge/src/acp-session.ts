import {
  AGENT_MAIL_TOOL_NAMES,
  ORKESTRATOR_MCP_SERVER_NAME,
} from "@orkestrator/protocol/agent-mail";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { WEB_ANNOTATION_TOOL_NAMES } from "@orkestrator/protocol/web-annotations";
import { ARTIFACT_TOOL_NAMES } from "@orkestrator/protocol/transcript-artifacts";
import { isArtifactServerToolCall } from "./acp-artifact-permission.js";
import {
  workflowResultTurnAllows,
  workflowResultTurnToolNames,
  type WorkflowResultTurn,
} from "@orkestrator/protocol/workflow-results";
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
  type AcpNormalizedSessionConfig,
} from "./session-config.js";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import {
  acpUsageTokenCount,
  accumulateAttemptUsage,
  parseAcpTurnUsage,
  type AcpTurnUsage,
} from "./usage.js";
import { acpSignInMissing, assertAcpSignedIn } from "./acp-credentials.js";
import { grokQuestionTimeoutFromEnv } from "./acp-question-timeout.js";
import { syncPromptTurnClock } from "./acp-prompt-clock.js";
import {
  AcpProcess,
  bumpCursorDiscoveryRevision,
  catalogCache,
  MAX_APPROVALS_PER_SESSION,
  MAX_MESSAGES,
  MAX_MESSAGE_TEXT_BYTES,
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
  SESSION_CLOSING_ERROR,
  activeSessionReservations,
  acpToolSourceStates,
  adjustAnonymousSessionCreations,
  clientSessionKeys,
  configuredAcpMcpServers,
  mcpConnectionKey,
  externalSessionToken,
  isObject,
  isCursorTaskMethod,
  isCursorUpdateTodosMethod,
  parseExternalSessionToken,
  provider,
  providerConfig,
  rememberCatalog,
  sessionCreations,
  sessionListProbe,
  setSessionListProbe,
  sessionResumes,
  sessions,
  saturatedText,
  shuttingDown,
  supportsSessionCapability,
  workingDirectory,
  type AcpSpawnOptions,
  type BridgeTextPart,
  type JsonObject,
  type SessionState,
} from "./acp-context.js";
import {
  appendBounded,
  appendSaturating,
  boundTranscript,
  boundedString,
  contentBlockParts,
  contentText,
  failTranscriptLimit,
  findHistoryMessage,
  isTranscriptUpdateKind,
  isTrimNotice,
  rememberHistoryMessage,
  sessionTitle,
  toolArgumentPath,
  trimPartsTo,
  truncateUtf8,
  turnRequiresCompleteOutput,
} from "./acp-transcript.js";
import {
  applyAcpPlanUpdate,
  applyCursorTask,
  applyCursorUpdateTodos,
  applySubagentFinished,
  applySubagentSpawned,
  applyToolCallUpdate,
  GROK_USE_TOOL,
  restoreCursorTodosFromMessages,
} from "./acp-tools.js";
import {
  boundedModelId,
  endsWithToolCall,
  findToolPart,
  noteMessageMutation,
  rowIsFull,
  turnStartIndex,
} from "./acp-rows.js";
import { reconcileStaleToolParts } from "./acp-reconciliation.js";
import { emptySessionConfig } from "./acp-persistence.js";
import { persistState, schedulePersist } from "./acp-persist-writer.js";
import { applyGrokInterjectionBroadcast } from "./grok-interjection.js";
import { effectiveTurnExecutionPolicy } from "./acp-policy.js";
import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_LIMITS,
} from "@orkestrator/protocol/agent-interactions";
import { isSupportedMcpForm } from "@orkestrator/protocol/mcp-elicitation-form";
import { InteractionDeadline } from "@orkestrator/protocol/agent-interaction-deadline";
import { applyCommandInventory } from "./acp-commands.js";
import { applyJournaledCommandChanges, trackCommandChangeWindow } from "./acp-command-changes.js";
import { recordAcpToolApproval, recordAcpToolEvidence } from "./change-evidence.js";

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
  policy?: AcpSpawnOptions["policy"],
  agentMcp?: AcpSpawnOptions["agentMcp"],
): Promise<SessionState> {
  const existing = sessions.get(selectedSessionId);
  if (existing) return resumeExistingSession(existing, signal, patch, policy, agentMcp);
  const acpSessionId = parseExternalSessionToken(selectedSessionId);
  if (!acpSessionId) throw new HttpError(404, "ACP session was not found");
  return adoptAcpSession(acpSessionId, signal, patch, policy, agentMcp);
}

/** Load a vendor session into a bridge session, joining a load already under way. */
export async function adoptAcpSession(
  acpSessionId: string,
  signal?: AbortSignal,
  patch?: AcpComposerPatch,
  policy?: AcpSpawnOptions["policy"],
  agentMcp?: AcpSpawnOptions["agentMcp"],
): Promise<SessionState> {
  // Checked before the `sessions` scan below: an adoption registers its state
  // before `session/load` returns, so a racing caller would otherwise find a
  // still-dispatching session and be told 409 for work it should simply join.
  // The in-flight adoption also carries the *first* caller's controls, so this
  // caller has to apply its own rather than inherit them silently.
  const pending = sessionResumes.get(acpSessionId);
  if (pending) {
    const adopted = await (signal ? raceAbort(pending, signal) : pending);
    // The in-flight adoption carries the first caller's MCP credential. A
    // later tab must apply its own rather than keep reading or sending mail as
    // the first identity — same rule as composer controls.
    return patch || policy || agentMcp
      ? resumeExistingSession(adopted, signal, patch, policy, agentMcp)
      : adopted;
  }
  const alreadyLoaded = [...sessions.values()].find((state) => state.acpSessionId === acpSessionId);
  if (alreadyLoaded) return resumeExistingSession(alreadyLoaded, signal, patch, policy, agentMcp);
  if (activeSessionReservations() >= MAX_SESSIONS)
    throw new HttpError(429, "ACP session limit reached");
  // Adoption is shared by every caller for this vendor session. A single HTTP
  // client disconnecting may stop waiting, but must not SIGTERM the child and
  // fail the other callers joined to the same session/load.
  const operation = resumeSessionReserved(acpSessionId, undefined, patch, policy, agentMcp);
  sessionResumes.set(acpSessionId, operation);
  const clear = (): void => {
    if (sessionResumes.get(acpSessionId) === operation) sessionResumes.delete(acpSessionId);
  };
  operation.then(clear, clear);
  return signal ? raceAbort(operation, signal) : operation;
}

export async function resumeExistingSession(
  state: SessionState,
  signal?: AbortSignal,
  patch?: AcpComposerPatch,
  policy?: AcpSpawnOptions["policy"],
  agentMcp?: AcpSpawnOptions["agentMcp"],
): Promise<SessionState> {
  // A closing session is about to leave the registry; resuming it here would
  // hand the caller an id that answers `missing` a moment later.
  if (state.closing) throw new HttpError(409, SESSION_CLOSING_ERROR);
  if (state.status === "running" || state.dispatching) {
    throw new HttpError(409, "Session is already running");
  }
  if (agentMcp) state.agentMcp = agentMcp;
  state.dispatching = true;
  try {
    if (policy && JSON.stringify(state.policy) !== JSON.stringify(policy)) {
      const previous = state.child;
      state.child = null;
      clearApprovals(state);
      state.policy = policy;
      await previous?.close();
    }
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
  policy?: AcpSpawnOptions["policy"],
  agentMcp?: AcpSpawnOptions["agentMcp"],
): Promise<SessionState> {
  const child = new AcpProcess({ policy });
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
      // No `promptJournalComplete`: the conversation `session/load` adopts may
      // have been prompted by another bridge session or process, so an empty
      // journal here proves nothing.
      promptJournal: new Map(),
      grokInterjectionJournal: new Map(),
      approvals: new Map(),
      interactions: new Map(),
      outputTruncated: false,
      uncheckedTranscriptBytes: 0,
      currentTurnOutput: null,
      promptSequence: 0,
      droppedMessages: 0,
      droppedParts: 0,
      transcriptTruncated: false,
      sessionConfig: emptySessionConfig(),
      ...(policy ? { policy } : {}),
      dispatching: true,
      historyReplay: "hydrate",
      health: new RuntimeHealthRecorder(),
      attachedMcpKey: mcpConnectionKey(agentMcp),
      ...(agentMcp ? { agentMcp } : {}),
    };
    attachChild(state, child);
    sessions.set(state.id, state);
    const loaded = await child.request(
      "session/load",
      {
        cwd: workingDirectory,
        additionalDirectories: [],
        mcpServers: configuredAcpMcpServers(state.agentMcp),
        sessionId: acpSessionId,
      },
      RPC_TIMEOUT_MS,
      signal,
    );
    finalizeHistoryReplayTurnUsage(state);
    state.historyReplay = false;
    // The replay built this history; no reader holds an older copy of a row.
    state.revisedRows?.clear();
    // session/load is a projection of work owned by another ACP process. Its
    // historical active markers cannot describe children of this new process.
    reconcileStaleToolParts(state, true);
    // The vendor replay has no shell measurements; this bridge journaled them.
    await applyJournaledCommandChanges(state);
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
    if (state && sessions.get(state.id) === state) {
      sessions.delete(state.id);
      bumpCursorDiscoveryRevision();
    }
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
      if (existing) {
        if (existing.closing) throw new HttpError(409, SESSION_CLOSING_ERROR);
        // Creation is idempotent by client key, so a retry under a different
        // review boundary must move the session rather than silently keep the
        // looser one. A boundary that did not change closes nothing, and one
        // that did cannot close a child in the middle of its own turn.
        if (typeof spawnOptions.readOnly === "boolean") {
          if (
            (existing.readOnly === true) !== spawnOptions.readOnly &&
            (existing.status === "running" || existing.dispatching)
          ) {
            throw new HttpError(409, "Session is already running");
          }
          await setSessionReadOnly(existing, spawnOptions.readOnly);
          schedulePersist();
        }
        if (spawnOptions.agentMcp) existing.agentMcp = spawnOptions.agentMcp;
        return existing;
      }
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
  if (
    await acpSignInMissing(provider, providerConfig.authMethodEnv, {
      ...process.env,
      ...providerConfig.env,
    })
  ) {
    return createDeferredSession(clientSessionKey, spawnOptions);
  }
  const child = new AcpProcess({
    model: spawnOptions.model,
    effort: spawnOptions.effort ?? spawnOptions.reasoningId,
    // A read-only session spawns its first child under the review boundary.
    // `setSessionReadOnly` would otherwise have to close a permissive child
    // that was already talking to the agent.
    policy: effectiveTurnExecutionPolicy({
      policy: spawnOptions.policy,
      readOnly: spawnOptions.readOnly,
    }),
  });
  try {
    await child.initialize(signal);
    const created = await child.request(
      "session/new",
      {
        cwd: workingDirectory,
        additionalDirectories: [],
        mcpServers: configuredAcpMcpServers(spawnOptions.agentMcp),
      },
      RPC_TIMEOUT_MS,
      signal,
    );
    if (!isObject(created) || typeof created.sessionId !== "string") {
      throw new Error(`${provider} returned an invalid ACP session`);
    }
    const id = randomBytes(16).toString("hex");
    const sessionConfig = normalizeAcpSessionConfig(provider, created);
    rememberCatalog(sessionConfig.composer);
    const state = newSessionState(
      id,
      clientSessionKey,
      created.sessionId,
      child,
      sessionConfig,
      spawnOptions,
    );
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
      if (sessions.get(id) === state) {
        sessions.delete(id);
        bumpCursorDiscoveryRevision();
      }
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

function newSessionState(
  id: string,
  clientSessionKey: string | undefined,
  acpSessionId: string,
  child: AcpProcess | null,
  sessionConfig: AcpNormalizedSessionConfig,
  spawnOptions: AcpSpawnOptions & AcpComposerPatch,
): SessionState {
  return {
    id,
    ...(clientSessionKey ? { clientSessionKey } : {}),
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
    // A session `session/new` created (now, or on a deferred session's first
    // attach) has had no prompt but through this journal.
    promptJournalComplete: true,
    grokInterjectionJournal: new Map(),
    approvals: new Map(),
    interactions: new Map(),
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    promptSequence: 0,
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    sessionConfig,
    ...(spawnOptions.policy ? { policy: spawnOptions.policy } : {}),
    ...(typeof spawnOptions.readOnly === "boolean" ? { readOnly: spawnOptions.readOnly } : {}),
    attachedMcpKey: mcpConnectionKey(spawnOptions.agentMcp),
    ...(spawnOptions.agentMcp ? { agentMcp: spawnOptions.agentMcp } : {}),
    // The session is reachable from `sessions` before its initial
    // configuration finishes, so hold the same claim the config and prompt
    // routes take rather than leaving a window where both see it idle.
    dispatching: true,
    historyReplay: false,
    health: new RuntimeHealthRecorder(),
  };
}

/**
 * A session with no agent behind it yet, for an agent that has no login.
 *
 * Starting the agent would only wait on a sign-in nobody sees, so the tab gets
 * a session that reports `authentication-required` instead of a create error.
 * The requested selection is kept on its composer (which is persisted), and
 * the first attach or prompt after a login creates the ACP session with it
 * (`startDeferredSession`). An empty `acpSessionId` marks it.
 */
async function createDeferredSession(
  clientSessionKey: string | undefined,
  spawnOptions: AcpSpawnOptions & AcpComposerPatch,
): Promise<SessionState> {
  const id = randomBytes(16).toString("hex");
  // The known models only: another session's selection is not this one's, and
  // an unset one lets the agent pick its default once it starts.
  const empty = normalizeAcpSessionConfig(provider, {});
  const sessionConfig = withRequestedSelection(
    { ...empty, composer: { ...empty.composer, models: catalogCache?.models ?? [] } },
    composerPatchFromSpawn(spawnOptions),
  );
  const state = newSessionState(id, clientSessionKey, "", null, sessionConfig, spawnOptions);
  state.dispatching = false;
  sessions.set(id, state);
  if (clientSessionKey) clientSessionKeys.set(clientSessionKey, id);
  await persistState();
  return state;
}

/** Record a selection on a deferred session's composer for its first spawn. */
function withRequestedSelection(
  config: AcpNormalizedSessionConfig,
  patch: AcpComposerPatch | undefined,
): AcpNormalizedSessionConfig {
  if (!patch) return config;
  return {
    ...config,
    composer: {
      ...config.composer,
      ...(patch.modelId ? { selectedModelId: patch.modelId } : {}),
      ...(patch.reasoningId ? { selectedReasoningId: patch.reasoningId } : {}),
      ...(patch.mode ? { selectedModeId: patch.mode } : {}),
      ...(patch.fastMode === undefined ? {} : { fastModeEnabled: patch.fastMode }),
    },
  };
}

/**
 * Create the ACP session a deferred session stands for, with the selection
 * recorded on it. A session the agent created is kept even if configuring it
 * fails, so the next attach loads it rather than creating a second.
 */
async function startDeferredSession(state: SessionState): Promise<AcpProcess> {
  await assertAcpSignedIn(provider, providerConfig.authMethodEnv, {
    ...process.env,
    ...providerConfig.env,
  });
  const requested = state.sessionConfig.composer;
  const patch = composerPatchFromSpawn({
    ...(requested.selectedModelId ? { modelId: requested.selectedModelId } : {}),
    ...(requested.selectedReasoningId ? { reasoningId: requested.selectedReasoningId } : {}),
    ...(requested.selectedModeId ? { mode: requested.selectedModeId } : {}),
    ...(typeof requested.fastModeEnabled === "boolean"
      ? { fastMode: requested.fastModeEnabled }
      : {}),
  });
  const child = new AcpProcess({
    model: requested.selectedModelId,
    effort: requested.selectedReasoningId,
    policy: effectiveTurnExecutionPolicy(state),
  });
  try {
    await child.initialize();
    const created = await child.request(
      "session/new",
      {
        cwd: workingDirectory,
        additionalDirectories: [],
        mcpServers: configuredAcpMcpServers(state.agentMcp),
      },
      RPC_TIMEOUT_MS,
    );
    if (!isObject(created) || typeof created.sessionId !== "string") {
      throw new Error(`${provider} returned an invalid ACP session`);
    }
    state.acpSessionId = created.sessionId;
    state.sessionConfig = normalizeAcpSessionConfig(provider, created);
    rememberCatalog(state.sessionConfig.composer);
    attachChild(state, child);
    if (patch) await applyComposerCalls(state, child, patch);
    state.attachedMcpKey = mcpConnectionKey(state.agentMcp);
    state.status = "idle";
    state.error = undefined;
    state.revision += 1;
    await persistState();
    return child;
  } catch (error) {
    if (state.child === child) state.child = null;
    await child.close();
    if (state.acpSessionId) await persistState().catch(() => undefined);
    throw error;
  }
}

/** Orkestrator tools a person is never asked about (see each list's doc). */
const ORKESTRATOR_AUTO_ALLOWED_TOOL_NAMES: readonly string[] = [
  ...AGENT_MAIL_TOOL_NAMES,
  ...WEB_ANNOTATION_TOOL_NAMES,
  ...ARTIFACT_TOOL_NAMES,
];

const ORKESTRATOR_AUTO_ALLOWED_TOOL_IDS = new Set(
  ORKESTRATOR_AUTO_ALLOWED_TOOL_NAMES.flatMap((name) => [
    `${ORKESTRATOR_MCP_SERVER_NAME}__${name}`,
    `mcp__${ORKESTRATOR_MCP_SERVER_NAME}__${name}`,
    `${ORKESTRATOR_MCP_SERVER_NAME}_${name}`,
    `${ORKESTRATOR_MCP_SERVER_NAME}/${name}`,
    `${ORKESTRATOR_MCP_SERVER_NAME}.${name}`,
  ]),
);

function wrappedToolName(input: unknown): string | undefined {
  return isObject(input) && typeof input.tool_name === "string" ? input.tool_name : undefined;
}

/**
 * The allow option of a permission request for an Orkestrator mail or
 * annotation tool, if it is one.
 *
 * Only a server-qualified name counts: a bare `send_message` could belong to
 * any server. Grok names tools in `_meta["x.ai/tool"].name`; other agents in
 * the tool call's own name. Display titles never identify tools. Grok 1.0.52
 * runs every MCP tool through `use_tool`, whose own permission request names
 * only the wrapper; the wrapped tool is then read from the call's `rawInput`,
 * or from `recordedInput` (the input the bridge already recorded for the same
 * tool call) when the request carries none.
 */
export function orkestratorToolPermissionOption(
  params: JsonObject,
  approvals?: string,
  recordedInput?: unknown,
): string | undefined {
  if (approvals === "deny") return undefined;
  const toolCall = isObject(params.toolCall) ? params.toolCall : undefined;
  if (!toolCall) return undefined;
  const meta = isObject(toolCall._meta) ? toolCall._meta : undefined;
  const xaiTool = meta && isObject(meta["x.ai/tool"]) ? meta["x.ai/tool"] : undefined;
  if (toolCall.kind === "execute" || toolCall.kind === "edit") return undefined;
  const vendorName = xaiTool ? xaiTool.name : toolCall.name;
  const names = [
    typeof vendorName === "string" && vendorName.trim() === GROK_USE_TOOL
      ? wrappedToolName(toolCall.rawInput === undefined ? recordedInput : toolCall.rawInput)
      : vendorName,
  ].filter((value): value is string => typeof value === "string");
  // Grok 1.0.46 names MCP tools `server__tool`, and its tool metadata also
  // carries the server as `namespace` next to a bare `name`.
  const namespaced =
    xaiTool?.namespace === ORKESTRATOR_MCP_SERVER_NAME &&
    typeof xaiTool.name === "string" &&
    ORKESTRATOR_AUTO_ALLOWED_TOOL_NAMES.includes(xaiTool.name.trim());
  if (!namespaced && !names.some((name) => ORKESTRATOR_AUTO_ALLOWED_TOOL_IDS.has(name.trim()))) {
    return undefined;
  }
  return allowOptionId(params);
}

function orkestratorToolIds(name: string): string[] {
  return [
    `${ORKESTRATOR_MCP_SERVER_NAME}__${name}`,
    `mcp__${ORKESTRATOR_MCP_SERVER_NAME}__${name}`,
    `${ORKESTRATOR_MCP_SERVER_NAME}_${name}`,
    `${ORKESTRATOR_MCP_SERVER_NAME}/${name}`,
    `${ORKESTRATOR_MCP_SERVER_NAME}.${name}`,
  ];
}

/** A wrapped call's arguments: Grok's `use_tool` carries them in `tool_input`. */
function wrappedToolArguments(input: unknown): unknown {
  if (!isObject(input)) return undefined;
  const wrapped = input.tool_input;
  if (typeof wrapped !== "string") return wrapped;
  if (wrapped.length > 1024 * 1024) return undefined;
  try {
    return JSON.parse(wrapped) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The allow option for a call to the current turn's own workflow-result
 * attempt: each result slot's submission and validation tool, status, for a
 * reviewer `report_finding`, and a graph activation's listed extra tools.
 * Granted under every approval policy, including a read-only turn's `deny`,
 * but only while the turn declared that attempt (`workflowResultTool` /
 * `workflowResultKey`, and a graph activation's `workflowResultSlots` /
 * `workflowResultExtraTools`, on its prompt) and only for a call whose
 * arguments name the key that tool answers for (`workflowResultTurnAllows`).
 *
 * These tools exist only on the attempt's own capability and write nothing in
 * the workspace. Identity follows `orkestratorToolPermissionOption`: a
 * server-qualified name, Grok's namespaced metadata, or the tool Grok's
 * `use_tool` wraps; never a bare name or a display title.
 */
export function workflowResultPermissionOption(
  params: JsonObject,
  turn: WorkflowResultTurn | undefined,
  recordedInput?: unknown,
): string | undefined {
  if (!turn) return undefined;
  const toolCall = isObject(params.toolCall) ? params.toolCall : undefined;
  if (!toolCall || toolCall.kind === "execute" || toolCall.kind === "edit") return undefined;
  const meta = isObject(toolCall._meta) ? toolCall._meta : undefined;
  const xaiTool = meta && isObject(meta["x.ai/tool"]) ? meta["x.ai/tool"] : undefined;
  const vendorName = xaiTool ? xaiTool.name : toolCall.name;
  const input = toolCall.rawInput === undefined ? recordedInput : toolCall.rawInput;
  const wrapped = typeof vendorName === "string" && vendorName.trim() === GROK_USE_TOOL;
  const name = wrapped ? wrappedToolName(input) : vendorName;
  const allowed = workflowResultTurnToolNames(turn);
  const namespaced =
    !wrapped &&
    xaiTool?.namespace === ORKESTRATOR_MCP_SERVER_NAME &&
    typeof xaiTool.name === "string" &&
    allowed.includes(xaiTool.name.trim())
      ? xaiTool.name.trim()
      : undefined;
  const qualified =
    typeof name === "string"
      ? allowed.find((tool) => orkestratorToolIds(tool).includes(name.trim()))
      : undefined;
  const tool = namespaced ?? qualified;
  if (tool === undefined) return undefined;
  if (!workflowResultTurnAllows(turn, tool, wrapped ? wrappedToolArguments(input) : input)) {
    return undefined;
  }
  return allowOptionId(params);
}

/**
 * The answer to a permission request this session's policy refuses.
 *
 * A refusal, not a cancellation: ACP's `cancelled` outcome says the prompt
 * turn itself was cancelled. Only `reject_once` is chosen. Grok's
 * `reject_always` stores a "never allow" grant in the user's per-project
 * approvals, outliving this session's policy. A request offering no
 * `reject_once` falls back to `cancelled`, which no agent treats as approval.
 *
 * Grok 1.0.52 ends its turn on either answer (`cancellationCategory`
 * `PermissionRejected` or `PermissionCancelled`); the prompt loop continues
 * such a turn (`acp-prompt.ts`).
 */
export function policyDenialOutcome(params: JsonObject): JsonObject {
  const options = Array.isArray(params.options) ? params.options.filter(isObject) : [];
  const reject = options.find((option) => option.kind === "reject_once");
  return typeof reject?.optionId === "string"
    ? { outcome: { outcome: "selected", optionId: reject.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function allowOptionId(params: JsonObject): string | undefined {
  const options = Array.isArray(params.options) ? params.options.filter(isObject) : [];
  const allow =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always");
  return typeof allow?.optionId === "string" ? allow.optionId : undefined;
}

interface RecordedPermissionTool {
  name?: string | null;
  input?: unknown;
}

/** Provider identities only: display titles never authorize a tool. */
function permissionToolNames(params: JsonObject, recorded?: RecordedPermissionTool): string[] {
  const call = isObject(params.toolCall) ? params.toolCall : undefined;
  if (!call) return [];
  const meta = isObject(call._meta) ? call._meta : undefined;
  const vendor = meta && isObject(meta["x.ai/tool"]) ? meta["x.ai/tool"] : undefined;
  const input = call.rawInput === undefined ? recorded?.input : call.rawInput;
  const names = [vendor?.name, call.name, isObject(input) ? input._toolName : undefined]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());
  if (names.length === 0 && recorded?.name) names.push(recorded.name.trim());
  if (typeof vendor?.namespace === "string" && typeof vendor.name === "string") {
    names.push(
      `${vendor.namespace}__${vendor.name.trim()}`,
      `mcp__${vendor.namespace}__${vendor.name.trim()}`,
    );
  }
  if (names.includes(GROK_USE_TOOL)) {
    const wrapped = wrappedToolName(input);
    if (wrapped) names.push(wrapped.trim());
  }
  return names;
}

function explicitlyDeniedPermissionTool(
  params: JsonObject,
  policy: NativeAgentExecutionPolicy | undefined,
  recorded?: RecordedPermissionTool,
): boolean {
  return permissionToolNames(params, recorded).some((name) =>
    policy?.toolPolicy?.deny?.includes(name),
  );
}

const FILE_MUTATION_DENIALS = ["file.write", "file.patch", "write", "edit", "apply_patch"];

/**
 * Policy denials (`capabilityPolicy`, or a Codex-named `toolPolicy` override)
 * that rule out auto-approving an ACP tool kind.
 */
const AUTO_APPROVE_DENIALS_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  read: [],
  search: [],
  think: [],
  edit: FILE_MUTATION_DENIALS,
  delete: FILE_MUTATION_DENIALS,
  move: FILE_MUTATION_DENIALS,
  execute: ["shell", "shell.mutate"],
  fetch: ["network"],
};

const PERMISSION_KIND_BY_TOOL: Readonly<Record<string, string>> = {
  bash: "execute",
  shell: "execute",
  terminal: "execute",
  run_command: "execute",
  run_terminal_cmd: "execute",
  run_terminal_command: "execute",
  execute_command: "execute",
  write: "edit",
  write_file: "edit",
  search_replace: "edit",
  delete_file: "delete",
  apply_patch: "edit",
};

/**
 * The allow option of a permission request under an `auto-approve` policy.
 *
 * Grok runs with `--always-approve` under that policy, but 1.0.52 still asks
 * over ACP before every edit, command, fetch and MCP call, so a session set to
 * auto-approve would wait on a person at every step. Answering here keeps that
 * setting's promise. A request of a kind the policy denies is never granted
 * this way and is left for a person. The kind is the request's own, or
 * `recordedKind` (the one the bridge recorded for the same tool call).
 * Provider tool names and wrapped identities also enforce denials. An
 * unclassified request is granted only while the policy has no denials.
 */
export function autoApprovedPermissionOption(
  params: JsonObject,
  policy: NativeAgentExecutionPolicy | undefined,
  recordedKind?: string,
  recorded?: RecordedPermissionTool,
): string | undefined {
  if (policy?.approvals !== "auto-approve") return undefined;
  if (explicitlyDeniedPermissionTool(params, policy, recorded)) return undefined;
  const toolCall = isObject(params.toolCall) ? params.toolCall : undefined;
  const kind = typeof toolCall?.kind === "string" ? toolCall.kind : recordedKind;
  const denied = new Set<string>([
    ...(policy.capabilityPolicy?.deny ?? []),
    ...(policy.toolPolicy?.deny ?? []),
  ]);
  const kinds = [
    kind,
    ...permissionToolNames(params, recorded).map(
      (name) => PERMISSION_KIND_BY_TOOL[name.toLowerCase()],
    ),
  ];
  const classified = kinds.filter(
    (value): value is string =>
      typeof value === "string" && Object.hasOwn(AUTO_APPROVE_DENIALS_BY_KIND, value),
  );
  // A generic/unknown kind supplies no evidence that a denial is irrelevant.
  if (classified.length === 0 && denied.size > 0) return undefined;
  if (
    classified.some((value) =>
      AUTO_APPROVE_DENIALS_BY_KIND[value]!.some((name) => denied.has(name)),
    )
  ) {
    return undefined;
  }
  return allowOptionId(params);
}

export function attachChild(state: SessionState, child: AcpProcess): void {
  state.child = child;
  state.pendingLateTurnUsage = undefined;
  state.ignoreUncorrelatedVendorUsage = undefined;
  child.onUpdate = (params) => applySessionUpdate(state, params);
  // An inventory announced before this handler existed (see
  // `AcpProcess.earlyCommandsUpdate`) would otherwise be lost until the agent
  // happened to announce again.
  const earlyCommands = child.earlyCommandsUpdate;
  child.earlyCommandsUpdate = null;
  if (earlyCommands) applySessionUpdate(state, earlyCommands);
  child.onVendor = (method, params) => {
    // Same generation rule as `onClose` below: a superseded child can emit long
    // after a replacement attached, and letting it rewrite `sessionConfig`
    // would point the live session — and the process-wide catalogue — at a
    // catalogue the attached agent never advertised.
    if (state.child !== child || sessions.get(state.id) !== state) return;
    applyVendorUpdate(state, method, params);
  };
  child.onPermission = (requestId, params) => {
    // A closing session answers nothing it parked, so it parks nothing new.
    if (state.child !== child || sessions.get(state.id) !== state || state.closing) {
      child.respond(requestId, { outcome: { outcome: "cancelled" } });
      return;
    }
    const policy = effectiveTurnExecutionPolicy(state);
    const toolCallId = isObject(params.toolCall) ? params.toolCall.toolCallId : undefined;
    const recorded =
      typeof toolCallId === "string"
        ? findToolPart(state, toolCallId, turnStartIndex(state))?.part
        : undefined;
    // The call's own input as the agent sent it. A Grok `use_tool` part
    // renders the wrapped tool's arguments, while a permission request that
    // names only the wrapper is matched by the wrapper input kept on its
    // source state.
    const recordedInput = recorded
      ? (acpToolSourceStates.get(recorded)?.toolArgs ?? recorded.toolArgs)
      : undefined;
    const recordedTool = recorded ? { name: recorded.toolName, input: recordedInput } : undefined;
    const toolDenied = explicitlyDeniedPermissionTool(params, policy, recordedTool);
    const attemptAllow = toolDenied
      ? undefined
      : workflowResultPermissionOption(params, state.workflowResultTurn, recordedInput);
    if (attemptAllow) {
      child.respond(requestId, { outcome: { outcome: "selected", optionId: attemptAllow } });
      return;
    }
    const artifactAllow =
      !toolDenied && isArtifactServerToolCall(params, state.agentMcp, recordedInput)
        ? allowOptionId(params)
        : undefined;
    if (artifactAllow) {
      child.respond(requestId, { outcome: { outcome: "selected", optionId: artifactAllow } });
      return;
    }
    const orkestratorAllow = toolDenied
      ? undefined
      : orkestratorToolPermissionOption(params, policy?.approvals, recordedInput);
    if (orkestratorAllow) {
      child.respond(requestId, { outcome: { outcome: "selected", optionId: orkestratorAllow } });
      return;
    }
    if (policy?.approvals === "deny") {
      state.policyDeniedRequests = (state.policyDeniedRequests ?? 0) + 1;
      recordAcpToolApproval(state, toolCallId, "denied");
      child.respond(requestId, policyDenialOutcome(params));
      return;
    }
    const autoAllow = autoApprovedPermissionOption(
      params,
      policy,
      recorded ? acpToolSourceStates.get(recorded)?.kind : undefined,
      recordedTool,
    );
    if (autoAllow) {
      child.respond(requestId, { outcome: { outcome: "selected", optionId: autoAllow } });
      return;
    }
    parkPermission(state, child, requestId, params);
  };
  child.onInteraction = (requestId, method, params) => {
    if (provider !== "grok") return false;
    if (method === "x.ai/mcp/elicit" || method === "_x.ai/mcp/elicit") {
      if (state.child !== child || sessions.get(state.id) !== state || state.closing) {
        child.respond(requestId, { outcome: "cancel" });
        return true;
      }
      parkGrokElicitation(state, child, requestId, params);
      return true;
    }
    if (
      method !== "x.ai/exit_plan_mode" &&
      method !== "_x.ai/exit_plan_mode" &&
      method !== "x.ai/ask_user_question" &&
      method !== "_x.ai/ask_user_question"
    ) {
      return false;
    }
    if (state.child !== child || sessions.get(state.id) !== state || state.closing) {
      child.respond(requestId, { outcome: "cancelled" });
      return true;
    }
    parkGrokInteraction(state, child, requestId, method, params);
    return true;
  };
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
  // Checked here as well as in `ensureSessionProcess`: that function can
  // reach this point after an await, by which time a close may have started.
  // A child spawned now would outlive the close that already collected them.
  if (state.closing) return Promise.reject(new HttpError(409, SESSION_CLOSING_ERROR));
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
  if (state.closing) throw new HttpError(409, SESSION_CLOSING_ERROR);
  if (state.attaching) {
    return signal ? raceAbort(state.attaching, signal) : state.attaching;
  }
  if (state.child && (state.attachedMcpKey ?? "") !== mcpConnectionKey(state.agentMcp)) {
    const previous = state.child;
    state.child = null;
    clearApprovals(state);
    await previous.close();
  }
  if (state.child) return state.child;
  const attach = attachSessionProcess(state);
  return signal ? raceAbort(attach, signal) : attach;
}

export async function setSessionReadOnly(state: SessionState, readOnly: boolean): Promise<void> {
  if ((state.readOnly === true) === readOnly) return;
  const previous = state.child;
  state.child = null;
  clearApprovals(state);
  state.readOnly = readOnly;
  await previous?.close();
}

export async function spawnAndLoadSession(state: SessionState): Promise<AcpProcess> {
  if (state.child) return state.child;
  if (!state.acpSessionId) return startDeferredSession(state);
  const child = new AcpProcess({ policy: effectiveTurnExecutionPolicy(state) });
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
        mcpServers: configuredAcpMcpServers(state.agentMcp),
        sessionId: state.acpSessionId,
      },
      RPC_TIMEOUT_MS,
    );
    finalizeHistoryReplayTurnUsage(state);
    state.historyReplay = false;
    if (hydratedHistory) {
      // The replay built this history; no reader holds an older copy of a row.
      state.revisedRows?.clear();
      reconcileStaleToolParts(state, true);
      // The vendor replay has no shell measurements; this bridge journaled them.
      await applyJournaledCommandChanges(state);
    }
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
    state.attachedMcpKey = mcpConnectionKey(state.agentMcp);
    state.status = "idle";
    state.error = undefined;
    state.revision += 1;
    await persistState();
    return child;
  } catch (error) {
    if (state.child === child) state.child = null;
    state.historyReplay = false;
    state.historyReplayTurnUsage = undefined;
    await child.close();
    throw error;
  }
}

export function clearApprovals(state: SessionState): void {
  for (const approval of state.approvals.values()) approval.deadline.settle();
  state.approvals.clear();
  clearInteractions(state);
}

export function clearInteractions(state: SessionState): void {
  for (const interaction of Array.from(state.interactions.values())) {
    if (interaction.kind === "mcp-form" || interaction.kind === "mcp-url") {
      interaction.respond({ outcome: "cancel" });
    } else {
      interaction.deadline.settle();
    }
  }
  state.interactions.clear();
  syncPromptTurnClock(state);
}

export { GROK_QUESTION_DEFAULT_TIMEOUT_MS } from "./acp-question-timeout.js";

/**
 * How long Grok itself waits on an `ask_user_question` before abandoning it,
 * or undefined when that timeout is off.
 *
 * A child the bridge launched records what it resolved at spawn
 * (`AcpProcess.questionTimeout`, which also raised Grok's default to the hold
 * ceiling). Anything else, a stub in a test, is read from the environment a
 * child would get, with Grok's documented default when nothing sets it.
 */
export function grokQuestionTimeoutMs(
  env: NodeJS.ProcessEnv = { ...process.env, ...providerConfig.env },
  child?: Pick<AcpProcess, "questionTimeout">,
): number | undefined {
  return child?.questionTimeout ? child.questionTimeout.timeoutMs : grokQuestionTimeoutFromEnv(env);
}

/**
 * The turn's deadline as a limit on how long a pause may hold, or undefined
 * when holding a request stops the turn's clock (`acp-prompt-clock.ts`). A
 * turn without that clock still ends every pause at its timeout.
 */
function turnHoldLimit(state: SessionState): number | undefined {
  return state.promptTurnClock ? undefined : state.promptDeadlineAt;
}

/**
 * The countdown of one parked request.
 *
 * `limitAt` is the latest moment the agent still waits, read again at every
 * pause and resume. The first deadline is capped by it and by the turn's
 * timeout as it stands now, so a request raised near the end of a turn never
 * shows more time than the agent will give it. Unref'd, so a parked request
 * cannot by itself keep the bridge alive.
 */
function parkedDeadline(
  state: SessionState,
  requestedAt: number,
  limitAt: () => number | undefined,
  onExpire: () => void,
): InteractionDeadline {
  const limit = earliest(limitAt(), state.promptDeadlineAt);
  const windowEnd = requestedAt + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
  return new InteractionDeadline({
    requestedAt,
    onExpire,
    providerLimitAt: limitAt,
    unref: true,
    ...(limit !== undefined && limit > requestedAt && limit < windowEnd
      ? { expiresAt: limit }
      : {}),
  });
}

function earliest(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

export function parkGrokInteraction(
  state: SessionState,
  child: AcpProcess,
  requestId: number,
  method: string,
  params: JsonObject,
): void {
  const cancelled = () => child.respond(requestId, { outcome: "cancelled" });
  const toolCallId = typeof params.toolCallId === "string" ? params.toolCallId.trim() : "";
  if (
    params.sessionId !== state.acpSessionId ||
    !toolCallId ||
    toolCallId.length > AGENT_INTERACTION_LIMITS.maxIdLength ||
    state.interactions.size >= AGENT_INTERACTION_LIMITS.maxPendingRequests
  ) {
    cancelled();
    return;
  }

  const existing = state.interactions.get(toolCallId);
  if (existing) existing.respond({ outcome: "cancelled" });
  const requestedAt = Date.now();
  const promptSequence = state.promptSequence;
  const finish = (result: JsonObject) => {
    const interaction = state.interactions.get(toolCallId);
    if (!interaction) return;
    interaction.deadline.settle();
    state.interactions.delete(toolCallId);
    syncPromptTurnClock(state);
    child.respond(requestId, result);
    state.revision += 1;
    schedulePersist();
  };
  const expire = () => {
    // An older request may outlive its turn. It cannot fail a newer turn or
    // overwrite evidence of a request that expired in that newer turn.
    if (state.promptSequence === promptSequence) {
      state.expiredRequestPromptSequence = promptSequence;
    }
    finish({ outcome: "cancelled" });
  };

  if (method.endsWith("exit_plan_mode")) {
    const rawPlan = typeof params.planContent === "string" ? params.planContent : "";
    const plan = rawPlan.slice(0, AGENT_INTERACTION_LIMITS.maxTextLength);
    state.interactions.set(toolCallId, {
      id: toolCallId,
      kind: "plan-approval",
      plan,
      planTruncated: plan.length < rawPlan.length,
      requestedAt,
      respond: finish,
      // Grok keeps no timeout of its own on a plan approval; the turn's does.
      deadline: parkedDeadline(state, requestedAt, () => turnHoldLimit(state), expire),
    });
  } else {
    const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
    const questions = rawQuestions
      .slice(0, AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest)
      .flatMap((candidate, questionIndex) => {
        if (!isObject(candidate) || typeof candidate.question !== "string") return [];
        const id =
          typeof candidate.id === "string" && candidate.id.trim()
            ? candidate.id.slice(0, AGENT_INTERACTION_LIMITS.maxIdLength)
            : `q${questionIndex}`;
        const options = (Array.isArray(candidate.options) ? candidate.options : [])
          .slice(0, AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion)
          .flatMap((rawOption, optionIndex) => {
            if (!isObject(rawOption) || typeof rawOption.label !== "string") return [];
            return [
              {
                id:
                  typeof rawOption.id === "string" && rawOption.id.trim()
                    ? rawOption.id.slice(0, AGENT_INTERACTION_LIMITS.maxProviderValueLength)
                    : `o${optionIndex}`,
                label: rawOption.label.slice(0, AGENT_INTERACTION_LIMITS.maxTextLength),
                ...(typeof rawOption.description === "string"
                  ? {
                      description: rawOption.description.slice(
                        0,
                        AGENT_INTERACTION_LIMITS.maxTextLength,
                      ),
                    }
                  : {}),
              },
            ];
          });
        return [
          {
            id,
            question: candidate.question.slice(0, AGENT_INTERACTION_LIMITS.maxTextLength),
            multiple: candidate.multiSelect === true,
            options,
          },
        ];
      });
    const questionIds = questions.map((question) => question.id);
    if (questions.length === 0 || new Set(questionIds).size !== questionIds.length) {
      cancelled();
      return;
    }
    // Grok abandons the question on its own timeout, counted from when it
    // asked; the turn's deadline still applies on top of it.
    const questionTimeoutMs = grokQuestionTimeoutMs(undefined, child);
    const questionLimitAt =
      questionTimeoutMs === undefined ? undefined : requestedAt + questionTimeoutMs;
    state.interactions.set(toolCallId, {
      id: toolCallId,
      kind: "question",
      questions,
      requestedAt,
      respond: finish,
      deadline: parkedDeadline(
        state,
        requestedAt,
        () => earliest(turnHoldLimit(state), questionLimitAt),
        expire,
      ),
    });
  }
  state.revision += 1;
  schedulePersist();
}

const MAX_MCP_SERVER_NAME_LENGTH = 256;

/**
 * Grok's `_x.ai/mcp/elicit`: an MCP server asking the user for input while one
 * of its tools runs. Grok advertises `elicitation` to its MCP servers itself and
 * forwards each request here; the answer is tagged by `outcome` (`accept` with
 * form `content`, `decline`, `cancel`), and anything else reads as a cancel.
 *
 * A request the card cannot render faithfully is declined on the spot with a
 * notice, as on Claude: arrays, nested objects and combinators must not be
 * presented as a text input, and only a web link may be offered to open.
 */
export function parkGrokElicitation(
  state: SessionState,
  child: AcpProcess,
  requestId: number,
  params: JsonObject,
): void {
  const toolCallId = typeof params.toolCallId === "string" ? params.toolCallId.trim() : "";
  if (
    params.sessionId !== state.acpSessionId ||
    !toolCallId ||
    toolCallId.length > AGENT_INTERACTION_LIMITS.maxIdLength ||
    (state.interactions.size >= AGENT_INTERACTION_LIMITS.maxPendingRequests &&
      !state.interactions.has(toolCallId))
  ) {
    child.respond(requestId, { outcome: "cancel" });
    return;
  }
  const serverName =
    (typeof params.serverName === "string" ? params.serverName.trim() : "").slice(
      0,
      MAX_MCP_SERVER_NAME_LENGTH,
    ) || "An MCP server";
  const message = (typeof params.message === "string" ? params.message : "").slice(
    0,
    AGENT_INTERACTION_LIMITS.maxTextLength,
  );
  const url = params.mode === "url" ? elicitationWebLink(params.url) : undefined;
  const schema =
    params.mode === "form" && isObject(params.requestedSchema) ? params.requestedSchema : undefined;
  const collectable =
    url !== undefined ||
    (schema !== undefined &&
      Buffer.byteLength(JSON.stringify(schema)) <= AGENT_INTERACTION_LIMITS.maxTextLength &&
      isSupportedMcpForm(schema));
  if (!collectable) {
    state.health.recordNotice({
      method: "mcp/elicit",
      severity: "warning",
      message: `${serverName} asked for input this tab cannot collect, so it was declined.`,
    });
    state.revision += 1;
    child.respond(requestId, { outcome: "decline" });
    return;
  }

  state.interactions.get(toolCallId)?.respond({ outcome: "cancel" });
  const requestedAt = Date.now();
  const promptSequence = state.promptSequence;
  const finish = (result: JsonObject) => {
    const interaction = state.interactions.get(toolCallId);
    if (!interaction) return;
    interaction.deadline.settle();
    state.interactions.delete(toolCallId);
    syncPromptTurnClock(state);
    child.respond(requestId, result);
    state.revision += 1;
    schedulePersist();
  };
  const expire = () => {
    if (state.promptSequence === promptSequence) {
      state.expiredRequestPromptSequence = promptSequence;
    }
    finish({ outcome: "cancel" });
  };
  const deadline = parkedDeadline(state, requestedAt, () => turnHoldLimit(state), expire);
  state.interactions.set(
    toolCallId,
    url !== undefined
      ? {
          id: toolCallId,
          kind: "mcp-url",
          serverName,
          message,
          url,
          requestedAt,
          respond: finish,
          deadline,
        }
      : {
          id: toolCallId,
          kind: "mcp-form",
          serverName,
          message,
          schema: schema!,
          requestedAt,
          respond: finish,
          deadline,
        },
  );
  state.revision += 1;
  schedulePersist();
}

function elicitationWebLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > AGENT_INTERACTION_LIMITS.maxTextLength) {
    return undefined;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Grok's `interaction_resolved` for an elicitation still parked here: the MCP
 * server gave up, so Grok has already dropped the request and the card would
 * only offer an answer nothing is waiting for. Grok sends the same notice after
 * the bridge answers, by which point the entry is gone.
 */
function withdrawResolvedElicitation(state: SessionState, params: JsonObject): void {
  const update = isObject(params.update) ? params.update : undefined;
  if (update?.sessionUpdate !== "interaction_resolved") return;
  if (typeof update.tool_call_id !== "string") return;
  const parked = state.interactions.get(update.tool_call_id);
  if (parked?.kind !== "mcp-form" && parked?.kind !== "mcp-url") return;
  parked.deadline.settle();
  state.interactions.delete(parked.id);
  syncPromptTurnClock(state);
  state.revision += 1;
  schedulePersist();
}

/**
 * What a parked permission request asks to run: the card's kind and its detail.
 *
 * `ruleEligible` marks a request an Orkestrator permission rule (todo 0723) may
 * answer: a command the agent sent as one shell string (an argv array joined
 * with spaces loses its quoting), or every path of a file change, and nothing
 * truncated. The backend auto-answers nothing without it.
 */
export type AcpApprovalDetail =
  | { kind: "command"; command: string; commandTruncated?: true; ruleEligible?: true }
  | { kind: "file-change"; paths: string[]; pathsOmitted?: number; ruleEligible?: true }
  | { kind: "permission" };

const MAX_APPROVAL_COMMAND_BYTES = 4_096;
const MAX_APPROVAL_PATHS = 20;
const FILE_CHANGE_TOOL_KINDS = new Set(["edit", "delete", "move"]);

/** The tool call as the bridge already recorded it, for a request that names only its id. */
export interface RecordedApprovalTool {
  name?: string | null;
  kind?: string;
  input?: unknown;
  locationPath?: string;
}

/**
 * The approval kind of an ACP permission request, from its ACP `toolCall.kind`
 * (or the kind recorded for the same call, or one inferred from a known tool
 * name): `execute` is a command, `edit`, `delete` and `move` a file change,
 * anything else a generic permission. A command or file change without the
 * command or paths a person needs to judge it stays a permission, so the card
 * never claims detail it does not have. Grok's `use_tool` wrapper is read
 * through to the tool it runs.
 */
export function permissionDetail(
  params: JsonObject,
  recorded: RecordedApprovalTool = {},
): AcpApprovalDetail {
  const call = isObject(params.toolCall) ? params.toolCall : {};
  const rawInput = call.rawInput === undefined ? recorded.input : call.rawInput;
  const wrapped =
    isObject(rawInput) && wrappedToolName(rawInput) ? unwrappedToolInput(rawInput) : undefined;
  const input = wrapped ?? (isObject(rawInput) ? rawInput : undefined);
  const declaredKind = [call.kind, recorded.kind].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate !== "other" && candidate !== "unknown",
  );
  const kind =
    declaredKind ??
    permissionToolNames(params, recorded)
      .map((name) => PERMISSION_KIND_BY_TOOL[name.toLowerCase()])
      .find((value) => value !== undefined);
  if (kind === "execute") {
    const raw = input?.command ?? input?.cmd;
    const command = Array.isArray(raw)
      ? raw.filter((part): part is string => typeof part === "string").join(" ")
      : typeof raw === "string"
        ? raw
        : "";
    const truncated = Buffer.byteLength(command.trim(), "utf8") > MAX_APPROVAL_COMMAND_BYTES;
    return command.trim()
      ? {
          kind: "command",
          command: truncateUtf8(command.trim(), MAX_APPROVAL_COMMAND_BYTES),
          ...(truncated ? { commandTruncated: true as const } : {}),
          ...(typeof raw === "string" && !truncated ? { ruleEligible: true as const } : {}),
        }
      : { kind: "permission" };
  }
  if (kind && FILE_CHANGE_TOOL_KINDS.has(kind)) {
    const located = Array.isArray(call.locations)
      ? call.locations.flatMap((location) =>
          isObject(location) ? [boundedString(location.path, MAX_TOOL_PATH_BYTES)] : [],
        )
      : [recorded.locationPath];
    const paths = [...new Set([...located, toolArgumentPath(input)])].filter(
      (path): path is string => typeof path === "string" && path.trim().length > 0,
    );
    return paths.length > 0
      ? {
          kind: "file-change",
          paths: paths.slice(0, MAX_APPROVAL_PATHS),
          ...(paths.length > MAX_APPROVAL_PATHS
            ? { pathsOmitted: paths.length - MAX_APPROVAL_PATHS }
            : { ruleEligible: true as const }),
        }
      : { kind: "permission" };
  }
  return { kind: "permission" };
}

/** A `use_tool` wrapper's `tool_input`, an object or a JSON string. */
function unwrappedToolInput(input: JsonObject): JsonObject | undefined {
  let value: unknown = input.tool_input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return isObject(value) ? value : undefined;
}

export function parkPermission(
  state: SessionState,
  child: AcpProcess,
  requestId: number,
  params: JsonObject,
): void {
  if (
    state.child !== child ||
    params.sessionId !== state.acpSessionId ||
    state.approvals.size >= MAX_APPROVALS_PER_SESSION
  ) {
    child.respond(requestId, { outcome: { outcome: "cancelled" } });
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
  const promptSequence = state.promptSequence;
  const toolCallId = isObject(params.toolCall) ? params.toolCall.toolCallId : undefined;
  const finish = (optionId?: string) => {
    const approval = state.approvals.get(id);
    if (!approval) return;
    approval.deadline.settle();
    state.approvals.delete(id);
    syncPromptTurnClock(state);
    let selected = optionId
      ? approval.options.find((option) => option.optionId === optionId)
      : undefined;
    // An older backend may ignore truncation metadata. Never let a response
    // approve an operation whose command or complete file set was not shown.
    const incomplete =
      (approval.detail?.kind === "command" && approval.detail.commandTruncated) ||
      (approval.detail?.kind === "file-change" && (approval.detail.pathsOmitted ?? 0) > 0);
    if (incomplete && selected?.kind !== "reject_once") {
      selected = approval.options.find((option) => option.kind === "reject_once");
    }
    // An unanswered or cancelled request, and a `reject_*` choice, refuse the
    // call; any other selected option lets it run.
    recordAcpToolApproval(
      state,
      toolCallId,
      selected && !selected.kind?.startsWith("reject") ? "allowed" : "denied",
    );
    if (selected) {
      child.respond(requestId, { outcome: { outcome: "selected", optionId: selected.optionId } });
    } else {
      child.respond(requestId, { outcome: { outcome: "cancelled" } });
    }
    state.revision += 1;
    schedulePersist();
  };
  const expire = () => {
    // An older request may outlive its turn. It cannot fail a newer turn or
    // overwrite evidence of a request that expired in that newer turn.
    if (state.promptSequence === promptSequence) {
      state.expiredRequestPromptSequence = promptSequence;
    }
    finish();
  };
  const recorded =
    typeof toolCallId === "string"
      ? findToolPart(state, toolCallId, turnStartIndex(state))?.part
      : undefined;
  const source = recorded ? acpToolSourceStates.get(recorded) : undefined;
  state.approvals.set(id, {
    id,
    title: permissionTitle(params),
    detail: permissionDetail(params, {
      name: recorded?.toolName,
      kind: source?.kind,
      input: source?.toolArgs ?? recorded?.toolArgs,
      locationPath: source?.locationPath,
    }),
    options,
    requestedAt,
    respond: finish,
    deadline: parkedDeadline(state, requestedAt, () => turnHoldLimit(state), expire),
  });
  recordAcpToolApproval(state, toolCallId, "awaiting");
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

/**
 * Append the non-text blocks of an update that carried no text at all.
 *
 * Its own message rather than an append to the last one: without text there is
 * no chunk to continue, and folding an image into whatever preceded it would
 * attribute it to the wrong turn.
 */
function appendNonTextContent(
  state: SessionState,
  update: JsonObject,
  role: "user" | "assistant",
): void {
  const messageId = randomBytes(12).toString("hex");
  const parts = contentBlockParts(update.content, messageId, 0);
  if (parts.length === 0) return;
  const modelId =
    role === "assistant" ? boundedModelId(state.sessionConfig.composer.selectedModelId) : undefined;
  state.messages.push({
    id: messageId,
    role,
    content: parts.map((part) => part.content).join("\n"),
    parts,
    createdAt: new Date().toISOString(),
    ...(modelId ? { modelId } : {}),
  });
  state.revision += 1;
  state.uncheckedTranscriptBytes += parts.reduce(
    // The data URL, not just the caption: an image's bytes are what the
    // transcript budget is protecting against.
    (total, part) =>
      total +
      Buffer.byteLength(part.content) +
      ("fileUrl" in part && part.fileUrl ? Buffer.byteLength(part.fileUrl) : 0),
    0,
  );
  if (state.uncheckedTranscriptBytes >= TRANSCRIPT_CHECK_INTERVAL_BYTES) boundTranscript(state);
}

function recordAcpNotice(state: SessionState, update: JsonObject): void {
  const title = typeof update.title === "string" ? update.title.trim() : "";
  if (!title) return;
  // The schema leaves severity open-ended; an unrecognised level is reported
  // at the recorder's default rather than promoted to an error advisory.
  const severity =
    update.severity === "info" || update.severity === "warning" || update.severity === "error"
      ? update.severity
      : "warning";
  const description = typeof update.description === "string" ? update.description.trim() : "";
  state.health.recordNotice({
    method: "notice",
    severity,
    source: "provider",
    message: title,
    ...(description ? { detail: description } : {}),
  });
}

/**
 * Standard ACP `session_info_update`: the agent names, renames or (with
 * `title: null`) unnames the session. An absent or malformed `title` changes
 * nothing. `updatedAt` is not kept: it is the agent's own activity clock, and
 * nothing reads it from this bridge; the session list reads it from the agent.
 */
function applySessionInfoUpdate(state: SessionState, update: JsonObject): void {
  if (update.title !== null && typeof update.title !== "string") return;
  const title = sessionTitle(update.title);
  if (title === state.title) return;
  if (title) state.title = title;
  else delete state.title;
  state.revision += 1;
  schedulePersist();
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
  if (kind === "notice") {
    // ACP 1.5 (`ClientSessionCapabilities.notices`): a fire-and-forget
    // advisory, not transcript. It lands in the shared runtime-health notices,
    // which already bound, dedupe and surface errors as transcript advisories.
    // A reconnect replays notices already recorded, so they are dropped like
    // replayed usage rather than inflating the occurrence count.
    if (state.historyReplay !== "ignore") recordAcpNotice(state, update);
    return;
  }
  if (kind === "session_info_update") {
    // Session metadata, not transcript, so it is applied during a reconnect's
    // replay too: a replayed title is still one this agent gave the session,
    // and the last report wins.
    applySessionInfoUpdate(state, update);
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
    // A full replacement, not a merge: an empty list removes every command,
    // and rows restored from disk are dropped rather than merged back.
    if (Array.isArray(update.availableCommands)) {
      applyCommandInventory(state, update.availableCommands);
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
  // that would mutate it has to be dropped — tool calls included. A new
  // `tool_call` upserts by id within the current turn only, so a replayed
  // historical call finds no owner and appends a duplicate to whatever is at
  // the tail.
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
    const part = applyToolCallUpdate(state, update, kind === "tool_call");
    if (part) {
      // Evidence first: a window this update closes reports its observation
      // against the call record the evidence adapter has just opened.
      recordAcpToolEvidence(state, part, update);
      trackCommandChangeWindow(state, part, kind === "tool_call");
    }
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
  ) {
    // ACP is a wire the agent versions, not this bridge, so an added kind used
    // to return here indistinguishably from an update that never arrived.
    // Names only — an update's payload carries prompts, file contents and
    // terminal output, and this reaches the renderer and the logs.
    state.health.recordUnknown(kind || "(unnamed)");
    return;
  }
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
  const role = kind === "user_message" || kind === "user_message_chunk" ? "user" : "assistant";
  if (!text) {
    // Not necessarily empty: ACP content is a union, and an update carrying
    // only an image, a resource or an audio block has no text at all. Before
    // this, `contentText` returned "" for those and the whole update was
    // discarded, so an agent that answered with a screenshot produced a
    // transcript that said nothing had happened.
    appendNonTextContent(state, update, role);
    return;
  }
  if (role === "user" && state.historyReplay === "hydrate") {
    finalizeHistoryReplayTurnUsage(state);
  }
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
  // With no provider message id the only boundary between model responses is
  // a tool call: the response that issued it ends there, and prose or thinking
  // after it is the next response, in a row of its own (see `acp-rows.ts`).
  // Otherwise a chunk continues the message before it regardless of part type:
  // a thought chunk followed by a text chunk is one response, not two. A row
  // at its soft size bound takes no new part either, so it is never trimmed.
  const startsPart = last?.parts.at(-1)?.type !== partType;
  if (
    !message &&
    !providerMessageId &&
    isChunk &&
    last?.role === role &&
    !(role === "assistant" && (endsWithToolCall(last) || (startsPart && rowIsFull(last)))) &&
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
  // ACP permits text beside images, resources, links, and audio in one update.
  // Keep those blocks on the same message instead of losing them to the text
  // branch above.
  const nonTextParts = contentBlockParts(update.content, message.id, message.parts.length);
  if (nonTextParts.length > 0) {
    const available = Math.max(0, MAX_PARTS_PER_MESSAGE - message.parts.length);
    const retained = nonTextParts.slice(0, available);
    message.parts.push(...retained);
    state.uncheckedTranscriptBytes += retained.reduce(
      (total, part) =>
        total +
        Buffer.byteLength(part.content) +
        ("fileUrl" in part && part.fileUrl ? Buffer.byteLength(part.fileUrl) : 0),
      0,
    );
    if (retained.length < nonTextParts.length) {
      state.droppedParts += nonTextParts.length - retained.length;
      state.transcriptTruncated = true;
    }
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
  // A provider message id can address a row a newer one already follows.
  noteMessageMutation(state, message);
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
  const mode =
    typeof body.mode === "string" && body.mode.trim()
      ? (body.mode.trim() as AcpComposerPatch["mode"])
      : undefined;
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
        : isObject(body.parameterValues) && typeof body.parameterValues.reasoning === "string"
          ? body.parameterValues.reasoning.trim()
          : "";
  const patch: AcpComposerPatch = {
    ...(modelId ? { modelId } : {}),
    ...(reasoningId ? { reasoningId } : {}),
    ...(typeof body.fastMode === "boolean" ? { fastMode: body.fastMode } : {}),
    ...(mode ? { mode } : {}),
    ...(isObject(body.parameterValues)
      ? {
          parameterValues: Object.fromEntries(
            Object.entries(body.parameterValues)
              .filter(
                ([key, value]) =>
                  Buffer.byteLength(key) <= 256 &&
                  (typeof value === "boolean" ||
                    (typeof value === "string" && Buffer.byteLength(value) <= 1_024)),
              )
              .slice(0, 32),
          ) as Record<string, string | boolean>,
        }
      : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export async function applyComposerPatch(
  state: SessionState,
  patch: AcpComposerPatch,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !patch.modelId &&
    !patch.reasoningId &&
    patch.fastMode === undefined &&
    !patch.mode &&
    !patch.parameterValues
  )
    return;
  // A deferred session has no agent to configure until a login exists. Keep
  // the selection for its first spawn instead of starting one now.
  if (!state.acpSessionId && !state.child && !state.attaching) {
    state.sessionConfig = withRequestedSelection(state.sessionConfig, patch);
    state.revision += 1;
    await persistState();
    return;
  }
  const child = await ensureSessionProcess(state, signal);
  await applyComposerCalls(state, child, patch, signal);
}

async function applyComposerCalls(
  state: SessionState,
  child: AcpProcess,
  patch: AcpComposerPatch,
  signal?: AbortSignal,
): Promise<void> {
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
  if (method === "_x.ai/session_notification" || method === "x.ai/session_notification") {
    withdrawResolvedElicitation(state, params);
  }
  // ACP v1 cannot bind an interjection to a run safely. Keep the experimental
  // adapter inaccessible unless an operator explicitly accepts that risk.
  const interjection =
    provider === "grok" && process.env.GROK_UNSAFE_EXPERIMENTAL_INTERJECTION === "1"
      ? applyGrokInterjectionBroadcast(
          state.grokInterjectionJournal,
          state.acpSessionId,
          method,
          params,
        )
      : null;
  if (interjection) {
    // Grok wire is normalized at the bridge boundary. Downstream transcript
    // code sees an ordinary user message and never learns the extension shape.
    const messageId = `grok-interjection:${interjection.interjectionId}`;
    if (!state.messages.some((message) => message.id === messageId)) {
      state.messages.push({
        id: messageId,
        role: "user",
        content: interjection.text,
        parts: [
          {
            type: "text",
            content: interjection.text,
            sourcePartId: `${messageId}:0`,
            sourceMessageId: messageId,
          },
        ],
        createdAt: new Date().toISOString(),
      });
    }
    state.revision += 1;
    schedulePersist();
    return;
  }
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
  if (state.ignoreUncorrelatedVendorUsage === true) return;
  const pendingLate = state.pendingLateTurnUsage;
  if (pendingLate && pendingLate.promptSequence < state.promptSequence) {
    // Vendor completion notifications have no turn/request id. A carrier that
    // lands while the next prompt is active cannot safely be assigned to
    // either turn, so prefer losing optional late metadata to corrupting the
    // newer turn and its durable cumulative count. Once observed, the stream
    // remains uncorrelated for this child generation; prompt results and
    // standard ACP usage updates continue to provide safe accounting.
    state.ignoreUncorrelatedVendorUsage = true;
    state.pendingLateTurnUsage = undefined;
    state.health.recordNotice({
      method: "usage",
      severity: "warning",
      source: "provider",
      message:
        "Late provider usage could not be correlated with a turn; vendor-only usage updates are disabled until this agent process restarts.",
    });
    return;
  }
  if (state.turnStartedAt !== undefined) state.currentTurnSawVendorUsage = true;
  else state.pendingLateTurnUsage = undefined;
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
  if (state.historyReplay === "hydrate") {
    state.historyReplayTurnUsage = { ...state.historyReplayTurnUsage, ...turn };
    return;
  }
  const turnInFlight = state.turnStartedAt !== undefined;
  const previous = state.usage;
  // A late carrier after a continued turn belongs to its last attempt, so it
  // merges there; merging it into the summed turn would drop earlier attempts.
  const attemptOpen =
    turnInFlight ||
    (state.completedAttemptUsage !== undefined && state.currentAttemptUsage !== undefined);
  if (attemptOpen) {
    state.currentAttemptUsage = { ...state.currentAttemptUsage, ...turn };
  }
  const accumulatedTurn = attemptOpen
    ? accumulateAttemptUsage(state.completedAttemptUsage, state.currentAttemptUsage!)
    : { ...previous?.turn, ...turn };
  if (turnInFlight) state.currentTurnUsage = accumulatedTurn;
  const durationMs =
    state.turnStartedAt === undefined
      ? previous?.durationMs
      : Math.max(0, Date.now() - state.turnStartedAt);
  const modelId = state.sessionConfig.composer.selectedModelId;
  const reportedTurnTokens = acpTurnTokenCount(accumulatedTurn);
  const lateSessionTokens =
    !turnInFlight && reportedTurnTokens !== undefined
      ? previous?.sessionTokens === undefined
        ? reportedTurnTokens
        : Math.max(0, previous.sessionTokens - (previous.lastTurnTokens ?? 0)) + reportedTurnTokens
      : previous?.sessionTokens;
  state.usage = {
    turn: accumulatedTurn,
    ...(previous?.turns?.length ? { turns: previous.turns } : {}),
    ...(turnInFlight
      ? previous?.lastTurnTokens === undefined
        ? {}
        : { lastTurnTokens: previous.lastTurnTokens }
      : reportedTurnTokens === undefined
        ? {}
        : { lastTurnTokens: reportedTurnTokens }),
    ...(lateSessionTokens === undefined ? {} : { sessionTokens: lateSessionTokens }),
    ...(modelId ? { modelId } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    updatedAt: new Date().toISOString(),
  };
  state.revision += 1;
  schedulePersist();
}

/** Exact per-turn consumption when ACP or the vendor reports token counters. */
export function acpTurnTokenCount(usage: AcpTurnUsage): number | undefined {
  return acpUsageTokenCount(usage);
}

/** Commit the usage collected for one completed turn replayed by session/load. */
export function finalizeHistoryReplayTurnUsage(state: SessionState): void {
  const turn = state.historyReplayTurnUsage;
  state.historyReplayTurnUsage = undefined;
  if (!turn) return;
  const previous = state.usage;
  const lastTurnTokens = acpTurnTokenCount(turn);
  const modelId = state.sessionConfig.composer.selectedModelId;
  state.usage = {
    turn,
    ...(previous?.turns?.length ? { turns: previous.turns } : {}),
    ...(lastTurnTokens === undefined ? {} : { lastTurnTokens }),
    ...(lastTurnTokens === undefined
      ? previous?.sessionTokens === undefined
        ? {}
        : { sessionTokens: previous.sessionTokens }
      : { sessionTokens: (previous?.sessionTokens ?? 0) + lastTurnTokens }),
    ...(modelId ? { modelId } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/** Commit one completed turn exactly once after all synchronous carriers merge. */
export function finalizeTurnUsage(state: SessionState): void {
  const lastTurnTokens = state.currentTurnUsage
    ? acpTurnTokenCount(state.currentTurnUsage)
    : undefined;
  if (!state.usage || lastTurnTokens === undefined) return;
  state.usage.lastTurnTokens = lastTurnTokens;
  state.usage.sessionTokens = (state.usage.sessionTokens ?? 0) + lastTurnTokens;
  const turnId = state.currentTurnRequestId || `turn-${state.promptSequence}`;
  const turn = state.currentTurnUsage!;
  state.usage.turns = [
    ...(state.usage.turns ?? []).filter((entry) => entry.turnId !== turnId),
    {
      turnId,
      // `finalizeTurnUsage` commits one completed turn exactly once, so this
      // is the turn's own time.
      at: new Date().toISOString(),
      ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
      ...(turn.inputTokens === undefined ? {} : { inputTokens: turn.inputTokens }),
      ...(turn.outputTokens === undefined ? {} : { outputTokens: turn.outputTokens }),
      ...(turn.cacheReadTokens === undefined ? {} : { cacheReadTokens: turn.cacheReadTokens }),
      ...(turn.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: turn.cacheWriteTokens }),
      ...(turn.reasoningTokens === undefined ? {} : { reasoningTokens: turn.reasoningTokens }),
      totalTokens: lastTurnTokens,
      ...(turn.apiDurationMs === undefined ? {} : { apiDurationMs: turn.apiDurationMs }),
      ...(state.usage.durationMs === undefined ? {} : { durationMs: state.usage.durationMs }),
      ...(state.currentTurnRequestId ? { requestId: state.currentTurnRequestId } : {}),
      ...(state.usage.modelId ? { modelId: state.usage.modelId } : {}),
    },
  ].slice(-20);
}

/** Mark a completed turn as eligible for one bounded, uncorrelated late carrier. */
export function rememberPendingLateTurnUsage(state: SessionState, promptSequence: number): void {
  const hasReportedTokens = state.currentTurnUsage
    ? acpTurnTokenCount(state.currentTurnUsage) !== undefined
    : false;
  if (
    hasReportedTokens &&
    state.currentTurnSawVendorUsage !== true &&
    state.pendingLateTurnUsage === undefined
  ) {
    state.pendingLateTurnUsage = { promptSequence };
  }
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
