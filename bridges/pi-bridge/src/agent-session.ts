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
import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
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
  catalogReadFailed,
  emptyComposer,
  hydrateComposer,
  reconcileComposerSelection,
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

/** Bridge sessions that have been permanently closed by their owner. */
const closingSessions = new WeakSet<SessionState>();

/** One in-flight adoption per canonical Pi session file. */
const sessionResumptions = new Map<string, Promise<SessionState>>();

/** One live-catalogue repair per restored bridge session. */
const composerHydrations = new WeakMap<SessionState, Promise<void>>();
/** Empty catalogues are retryable, but not on every 500ms status poll. */
const composerHydrationRetryAfter = new WeakMap<SessionState, number>();

/**
 * Narrow dependency seam for lifecycle tests and HTTP contract fakes.
 *
 * Production never sets this. Tests may replace the expensive SDK construction
 * while still exercising this module's attach ownership, subscription,
 * composer reconciliation and disposal paths.
 */
export interface AgentSessionTestHooks {
  createAgentSession?: (state: SessionState) => Promise<AgentSession>;
  hydrateComposer?: typeof hydrateComposer;
  resolveModel?: typeof resolveModel;
}

let agentSessionTestHooks: AgentSessionTestHooks = {};

export function setAgentSessionTestHooks(hooks: AgentSessionTestHooks | undefined): void {
  agentSessionTestHooks = hooks ?? {};
}

/**
 * Test seam: drop a session's hydration retry deadline.
 *
 * The deadline is `CATALOG_TIMEOUT_MS` in the future, which no test should
 * wait out and none should fake a clock for — `Date.now` is read on the
 * request path here, not through an injectable one.
 */
export function expireComposerHydrationRetryForTests(state: SessionState): void {
  composerHydrationRetryAfter.delete(state);
}

function hydrateComposerForSession(
  composer: SessionState["composer"],
  defaults?: ThinkingLevelDefaults,
): ReturnType<typeof hydrateComposer> {
  return (agentSessionTestHooks.hydrateComposer ?? hydrateComposer)(composer, defaults);
}

function resolveModelForSession(modelId: string | undefined): ReturnType<typeof resolveModel> {
  return (agentSessionTestHooks.resolveModel ?? resolveModel)(modelId);
}

/**
 * Merge a freshly read catalogue into whatever the composer is *now*.
 *
 * The read this result came from is unbounded, and nothing serializes it
 * against the other composer writers: attaching reconciles the selection
 * against the model the turn will really run, `applyComposerPatch` records the
 * user's pick, and Pi's own `thinking_level_changed` echoes the level it
 * clamped to. Assigning the object the read was *derived* from would silently
 * revert whichever of those landed while it was in flight — including the
 * reconciliation that exists precisely so the picker cannot name a model the
 * turn is not running. Only the rows this read is the authority for cross over.
 */
function adoptHydratedComposer(state: SessionState, hydrated: SessionState["composer"]): void {
  const current = state.composer;
  const selectedModelId = current.selectedModelId ?? hydrated.selectedModelId;
  state.composer = {
    ...current,
    models: hydrated.models,
    ...(selectedModelId ? { selectedModelId } : {}),
    selectedReasoningId: current.selectedReasoningId ?? hydrated.selectedReasoningId,
    fastModeAvailable: false,
  };
  state.revision += 1;
}

/**
 * Put the live model catalogue back into a restored session composer.
 *
 * Persistence deliberately retains only the user's selection: provider auth
 * can change while the bridge is down, so restoring yesterday's model rows
 * would offer models the account can no longer run. That makes the first
 * status/config read after a restart responsible for rehydrating the rows.
 * Sharing the work prevents the backend's parallel projection reads from
 * multiplying SDK availability probes, while the retry deadline prevents an
 * unauthenticated session from probing on every projection poll.
 */
export async function hydrateSessionComposer(
  state: SessionState,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!options.force && state.composer.models.length > 0) return;
  if (!options.force && (composerHydrationRetryAfter.get(state) ?? 0) > Date.now()) {
    return;
  }
  const pending = composerHydrations.get(state);
  if (pending && !options.force) return pending;
  // A forced refresh must not *adopt* an in-flight read. That read started
  // before `/global/refresh-catalog` dropped the catalogue, so it answers with
  // exactly the rows the refresh was asked to replace — and once it lands the
  // session has models again, which is the condition that stops every later
  // unforced hydration from running. The tab would then stay stale until the
  // user refreshed a second time. Wait for it, then read the catalogue afresh.
  const settled = pending?.catch(() => undefined);

  const operation = (async () => {
    if (settled) await settled;
    const hydrated = await hydrateComposerForSession(state.composer);
    if (hydrated.models.length === 0) {
      composerHydrationRetryAfter.set(state, Date.now() + CATALOG_TIMEOUT_MS);
      // An empty list from a read that *failed* is not evidence that the
      // account has no models, and the refresh route has already dropped the
      // cache that would otherwise have absorbed the failure. Emptying a
      // working picker because a provider timed out is worse than leaving it
      // stale for one retry interval.
      if (options.force && !catalogReadFailed() && state.composer.models.length > 0) {
        adoptHydratedComposer(state, hydrated);
      }
      return;
    }
    composerHydrationRetryAfter.delete(state);
    adoptHydratedComposer(state, hydrated);
  })().finally(() => {
    if (composerHydrations.get(state) === operation) composerHydrations.delete(state);
  });
  composerHydrations.set(state, operation);
  return operation;
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
    approvals: new Map(),
    todos: [],
    composer: emptyComposer(),
    session: null,
    dispatching: false,
    promptSequence: 0,
    openTextParts: new Map(),
    toolInputs: new Map(),
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
    if (existing) {
      await hydrateSessionComposer(existing);
      return existing;
    }
    const inFlight = sessionCreations.get(clientSessionKey);
    if (inFlight) return inFlight;
  }

  const work = (async () => {
    const state = newSessionState(clientSessionKey);
    applyComposerPatch(state, patch);
    state.composer = await hydrateComposerForSession(state.composer);
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
  if (closingSessions.has(state)) throw new Error("This Pi session is closed");
  if (state.session) return state.session;
  state.attaching ??= attach(state).finally(() => {
    state.attaching = undefined;
  });
  return state.attaching;
}

async function attach(state: SessionState): Promise<AgentSession> {
  const session = agentSessionTestHooks.createAgentSession
    ? await agentSessionTestHooks.createAgentSession(state)
    : await createPiAgentSession(state);

  return publishAttachedSession(state, session);
}

async function createPiAgentSession(state: SessionState): Promise<AgentSession> {
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
    ...projectResourceDiscoveryOptions(),
    // The approval gate. Always loaded, discovery setting or not.
    extensionFactories: [{ name: "orkestrator", factory: approvalExtension(state) }],
  });
  await resourceLoader.reload();

  const model = await resolveModelForSession(state.composer.selectedModelId);
  // Rebuilt with this workspace's settings now that there are some. A session
  // created before any catalogue read still gets the user's `/thinking` choice.
  state.composer = await hydrateComposerForSession(
    state.composer,
    thinkingDefaults(settingsManager),
  );
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

  return created.session;
}

function publishAttachedSession(state: SessionState, session: AgentSession): AgentSession {
  // DELETE can land while createAgentSession is awaiting credentials, resource
  // loading or a session-file open. Never publish a session after its bridge
  // owner has gone away: it would sit outside `sessions`, so neither idle
  // detaching nor shutdown could ever release it.
  if (closingSessions.has(state)) {
    try {
      session.dispose();
    } catch {
      // The state is already closed. Disposal is best-effort, and the attach
      // still fails authoritatively below rather than resurrecting it.
    }
    throw new Error("This Pi session was closed while it was attaching");
  }
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
    state.composer = reconcileComposerSelection(
      state.composer,
      session.model,
      session.thinkingLevel,
    );
  }
  state.revision += 1;
  return session;
}

/** Project-local resource switches passed to Pi's default loader. */
export function projectResourceDiscoveryOptions(enabled: boolean = projectResourcesEnabled): {
  noExtensions: boolean;
  noSkills: boolean;
  noPromptTemplates: boolean;
} {
  return {
    noExtensions: !enabled,
    noSkills: !enabled,
    noPromptTemplates: !enabled,
  };
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
export function sessionManagerFor(state: SessionState): SessionManager {
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

/**
 * Permanently close a bridge session, including an attach still in flight.
 *
 * Idle detaching deliberately does not use this path: an idle session is meant
 * to attach again. DELETE does, because a session removed from the registry has
 * no future owner. Marking it before the first await closes the cold-attach
 * race; awaiting the shared attach gives the late session a chance to observe
 * the mark and dispose itself before this function returns.
 */
export async function closeSession(state: SessionState): Promise<void> {
  closingSessions.add(state);
  await state.attaching?.catch(() => undefined);
  await detachSession(state);
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
  // `reasoningEffort` is the spelling the backend actually sends on
  // `/session/create` and on every prompt; `effort` is the shorter one the
  // config route uses. Reading only the first two dropped the composer's
  // thinking level on every dispatched turn, and — because a patch carrying a
  // model resets the reasoning selection to whatever was parsed here — reset it
  // to undefined as well. The ACP bridge accepts all three spellings for the
  // same reason.
  if (nonBlank(body.reasoningEffort)) patch.reasoningId ??= body.reasoningEffort.trim();
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
  const model = await resolveModelForSession(state.composer.selectedModelId);
  if (model && (session.model?.id !== model.id || session.model?.provider !== model.provider)) {
    await session.setModel(model as never).catch(() => undefined);
  }
  // `off` is a level like any other here — Pi's own `ThinkingLevel` includes it,
  // and skipping it made "Off" the one selection in the picker that could never
  // be applied.
  // `resolveModel` falls back when a persisted or requested id is stale. A
  // failed `setModel` also leaves the session on its previous model. In both
  // cases the live session is authoritative: using `model` here would clamp
  // thinking against a model the turn is not actually going to run.
  const actualModel = session.model ?? model;
  const level = thinkingLevel(state.composer.selectedReasoningId, actualModel);
  if (session.thinkingLevel !== level) session.setThinkingLevel(level as never);

  // Echo what Pi will really run. Without this, an unknown selection silently
  // executes the first available model while the picker, transcript and usage
  // continue naming the unavailable one.
  const reconciled = reconcileComposerSelection(state.composer, actualModel, session.thinkingLevel);
  if (
    reconciled.selectedModelId !== state.composer.selectedModelId ||
    reconciled.selectedReasoningId !== state.composer.selectedReasoningId
  ) {
    state.composer = reconciled;
    state.revision += 1;
  }
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
 * The directory a resume handle is allowed to name.
 *
 * `SessionManager.list` only ever hands out paths from here, so this is where
 * every legitimate handle comes from.
 */
function resumableSessionRoot(): string {
  return sessionDirectory() ?? join(agentDirectory() ?? getAgentDir(), "sessions");
}

/**
 * Confine a resume handle to Pi's own session directory.
 *
 * The handle is a filesystem path rather than an opaque id, and it arrives
 * over HTTP. Passed through unchecked, `SessionManager.open` will read any
 * JSONL-parseable file into a rendered transcript, and — because it "preserves
 * the explicit path" for a file that does not exist yet — will happily create
 * and write a session anywhere this process can write. Neither is something a
 * resume needs, so both are refused here rather than trusted to the caller.
 *
 * Resolved through `realpath` so a symlink inside the session directory cannot
 * point out of it, and required to already exist: a resume names a
 * conversation that happened, and `POST /session/create` is the route for one
 * that has not.
 */
export async function assertResumableSessionFile(sessionFile: string): Promise<string> {
  const root = resumableSessionRoot();
  const requested = resolve(root, sessionFile);
  let real: string;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
    real = await realpath(requested);
  } catch {
    throw new Error("That Pi session file does not exist");
  }
  if (real !== rootReal && !real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)) {
    throw new Error("That Pi session file is outside this environment's session directory");
  }
  const info = await stat(real).catch(() => undefined);
  if (!info?.isFile()) throw new Error("That Pi session file does not exist");
  return real;
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
  const resolved = await assertResumableSessionFile(sessionFile);
  // One JSONL file, one bridge session. Two live `AgentSession`s appending to
  // the same file interleave their entries, which corrupts the branch
  // structure Pi resumes and forks from — so a repeat resume adopts the
  // session that already owns the file.
  for (const existing of sessions.values()) {
    if (existing.sessionFile === resolved) {
      applyComposerPatch(existing, patch);
      existing.lastAccessed = Date.now();
      return existing;
    }
  }

  // The scan above and the eventual insertion are separated by a catalogue
  // await. Share that whole adoption window, otherwise two concurrent resume
  // requests both see no owner and create distinct sessions that later append
  // to the same JSONL file.
  const inFlight = sessionResumptions.get(resolved);
  if (inFlight) {
    const existing = await inFlight;
    applyComposerPatch(existing, patch);
    existing.lastAccessed = Date.now();
    return existing;
  }

  const work = (async () => {
    const state = newSessionState();
    state.sessionFile = resolved;
    applyComposerPatch(state, patch);
    state.composer = await hydrateComposerForSession(state.composer);
    hydrateHistory(state);
    sessions.set(state.id, state);
    return state;
  })();
  sessionResumptions.set(resolved, work);
  try {
    return await work;
  } finally {
    if (sessionResumptions.get(resolved) === work) sessionResumptions.delete(resolved);
  }
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
