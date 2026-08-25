/**
 * The bridge's HTTP surface.
 *
 * Every route here is one the backend's shared bridge provider already speaks
 * to Claude, Codex and the ACP agents. Answering them identically is what lets
 * a Pi session be driven by the same backend, store and renderer code as every
 * other platform, with no branch anywhere downstream.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { gzip } from "node:zlib";
import {
  authenticate,
  COMPOSER_HYDRATION_WAIT_MS,
  MAX_BODY_BYTES,
  PROVIDER,
  workingDirectory,
} from "./config.js";
import { authStatus, CredentialError } from "./credentials.js";
import {
  denyAllApprovals,
  publicApprovals,
  publicInteractions,
  resolveApproval,
} from "./interactions.js";
import { listModels, refreshModels } from "./models.js";
import { persistBarrier, schedulePersist } from "./persistence.js";
import { dispatchPrompt, errorText, journal, setPromptJournal } from "./prompt.js";
import {
  parsePromptAttachments,
  PromptAttachmentError,
  promptFileReferences,
  readPromptImages,
  resolvePromptFiles,
  type PiPromptFile,
  type PiPromptImage,
} from "./prompt-attachments.js";
import {
  messageWindow,
  parseFromIndex,
  publicActivity,
  publicDispatch,
  publicQueue,
  publicSession,
  publicStatus,
} from "./public.js";
import { refreshRuntimeCatalog } from "./runtime.js";
import { withTimeout } from "./timeout.js";
import { boundTranscript, boundTranscriptForRead, chargeTranscript } from "./transcript.js";
import {
  applyComposerPatch,
  applyComposerToSession,
  closeSession,
  createSession,
  ensureSession,
  forkSession,
  hydrateSessionComposer,
  listResumableSessions,
  parseComposerPatch,
  resumeSession,
} from "./agent-session.js";
import {
  clientSessionKeys,
  isObject,
  nonBlank,
  sessions,
  type BridgeFilePart,
  type JsonObject,
  type SessionState,
} from "./state.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Whether the client that asked for this response can decode gzip.
 *
 * Recorded per response rather than threaded through every handler. Compressing
 * a reply the caller never said it could read is a broken response, and the
 * transcript replies are exactly the ones large enough to be compressed — so a
 * client debugging this bridge by hand would get binary for the one route it
 * most needs to read.
 */
const gzipCapableResponses = new WeakSet<ServerResponse>();

export async function route(
  request: IncomingMessage,
  response: ServerResponse,
  clientSignal: AbortSignal,
): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (acceptsGzip(request)) gzipCapableResponses.add(response);

  // Health is unauthenticated on purpose: the launcher polls it to decide the
  // bridge is up, before it has a reason to trust it with a token.
  if (url.pathname === "/global/health" && request.method === "GET") {
    return json(response, 200, { ok: true, provider: PROVIDER, version: "1.0.0" });
  }
  if (
    !authenticate({
      authorization: request.headers.authorization,
      token: request.headers["x-orkestrator-pi-token"],
    })
  ) {
    return json(response, 401, { error: "Unauthorized" });
  }

  try {
    const handled = await routeGlobal(request, response, url);
    if (handled) return;
    return await routeSession(request, response, url, clientSignal);
  } catch (error) {
    if (error instanceof HttpError) return json(response, error.status, { error: error.message });
    if (error instanceof CredentialError) return json(response, 401, { error: error.message });
    if (error instanceof PromptAttachmentError) {
      return json(response, 400, { error: error.message });
    }
    return json(response, 500, { error: errorText(error) });
  }
}

async function routeGlobal(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === "/global/auth-check" && request.method === "GET") {
    json(response, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/global/models" && request.method === "GET") {
    json(response, 200, { models: await listModels() });
    return true;
  }
  if (url.pathname === "/global/refresh-catalog" && request.method === "POST") {
    await refreshRuntimeCatalog();
    // Invalidate after the SDK refresh settles. A catalogue probe that began
    // before the refresh may still complete while it is running; the model
    // layer's generation guard stops that probe publishing, and this ordering
    // ensures even a result that landed just before settlement is discarded.
    refreshModels();
    // Restored sessions intentionally hold no persisted model rows. A manual
    // refresh must repair those session snapshots too, otherwise the global
    // catalogue changes while the open tab keeps saying no models are
    // available until its ordinary retry deadline passes.
    await Promise.all(
      Array.from(sessions.values()).map((state) => hydrateSessionComposer(state, { force: true })),
    );
    json(response, 200, { ok: true });
    return true;
  }
  // Pi's slash commands are prompt templates and skills, which are discovered
  // per session because a workspace can contribute its own. There is no global
  // list, so this answers empty rather than 404 — the backend reads a 404 as a
  // bridge that predates the route.
  if (url.pathname === "/plugins/commands" && request.method === "GET") {
    json(response, 200, { commands: globalSlashCommands() });
    return true;
  }
  if (url.pathname === "/global/auth" && request.method === "GET") {
    json(response, 200, await authStatus());
    return true;
  }
  if (url.pathname === "/session/list" && request.method === "GET") {
    const listed = await listResumableSessions();
    // The provider reads `id`, not `sessionId`: this is the resumable-session
    // wire shape, which predates the typed entry the provider maps it into.
    json(response, 200, {
      sessions: listed.map((entry) => ({
        id: entry.sessionId,
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.status ? { status: entry.status } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
      })),
    });
    return true;
  }
  if (url.pathname === "/session/create" && request.method === "POST") {
    const body = await readJson(request);
    const clientSessionKey = readBoundedString(body.clientSessionKey, 512, "clientSessionKey");
    const state = await createSession(clientSessionKey, parseComposerPatch(body));
    // The backend stores this session id as soon as create returns. A bridge
    // restart before the first prompt used to lose it, so every later status
    // read 404'd and the tab stuck on "session is recovering".
    await persistBarrier();
    json(response, 201, publicSession(state));
    return true;
  }
  if (url.pathname === "/session/resume" && request.method === "POST") {
    const body = await readJson(request);
    // `threadId` is accepted alongside `sessionId` because the shared provider
    // sends whichever key its per-agent branch was written for. Taking both
    // means a resume cannot fail on a naming mismatch.
    const sessionFile =
      readBoundedString(body.sessionId, 4096, "sessionId") ??
      readBoundedString(body.threadId, 4096, "sessionId");
    if (!sessionFile) throw new HttpError(400, "sessionId is required");
    // A handle outside the session directory, or one naming a file that does
    // not exist, is a caller error rather than a bridge failure.
    const state = await resumeSession(sessionFile, parseComposerPatch(body)).catch((error) => {
      throw new HttpError(400, errorText(error));
    });
    await persistBarrier();
    json(response, 201, publicSession(state));
    return true;
  }
  return false;
}

/**
 * Slash commands available before a session exists.
 *
 * Only the ones this bridge implements itself. Pi's own file-backed commands
 * are per-session and reported through the session config instead, because a
 * workspace can contribute prompt templates the global list has never seen.
 */
function globalSlashCommands(): Array<{ name: string; description: string }> {
  return [{ name: "/compact", description: "Summarize the conversation to free context" }];
}

const SESSION_ROUTE =
  /^\/session\/([^/]+)(?:\/(messages|status|activity|prompt|attach|dispatch|cancel|abort|structured-output|interactions|config|approvals|compact|fork|steer|queue))?(?:\/([^/]+))?$/;

async function routeSession(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  clientSignal: AbortSignal,
): Promise<void> {
  const match = SESSION_ROUTE.exec(url.pathname);
  if (!match) return json(response, 404, { error: "Not found" });
  const state = sessions.get(match[1]!);
  const action = match[2];
  const subject = match[3];
  if (!state) {
    // Answered in band so the backend can tell "this session is gone" from
    // "this bridge predates the route" — a 404 here would have it delete a
    // live session mapping against an older bridge.
    if (action === "activity") return json(response, 200, { activity: "missing" });
    return json(response, 404, { error: "Session not found" });
  }

  // Liveness only. `/activity` and `/dispatch` deliberately do not touch it:
  // the backend sweeps every persisted session every couple of seconds, so
  // refreshing on those would put idle detaching permanently out of reach.
  if (action !== "activity" && action !== "dispatch") state.lastAccessed = Date.now();

  // `restoreComposer` drops the persisted model rows by design. Rehydrate on
  // the routes that publish or mutate composer state so a restarted bridge's
  // authoritative snapshot can stand on its own instead of depending on a
  // renderer-side event or an environment-wide cache happening to be fresh.
  //
  // Every route that publishes composer state has to stay below the backend's
  // request ceiling. Config POST is especially important: waiting the full
  // catalogue timeout before reading its body let the client time out first,
  // after which the abandoned server request could still apply the selection.
  // A bounded wait publishes a warm catalogue immediately and otherwise leaves
  // the shared hydration running for this or the next snapshot to collect.
  if (
    (request.method === "GET" && (!action || action === "status")) ||
    (action === "config" && (request.method === "GET" || request.method === "POST"))
  ) {
    // `.catch` before the race, not after: the loser of a `Promise.race` still
    // settles, and a hydration that rejects after the wait elapsed would
    // otherwise surface as an unhandled rejection.
    await withTimeout(
      hydrateSessionComposer(state).catch(() => undefined),
      COMPOSER_HYDRATION_WAIT_MS,
      "Pi composer hydration is still running",
    ).catch(() => undefined);
  }

  if (!action && request.method === "GET") {
    boundTranscriptForRead(state);
    return json(response, 200, publicSession(state));
  }
  if (!action && request.method === "DELETE") {
    return await handleDelete(response, state);
  }
  if (action === "messages" && request.method === "GET") {
    boundTranscriptForRead(state);
    return json(
      response,
      200,
      messageWindow(state, parseFromIndex(url.searchParams.get("fromIndex"))),
    );
  }
  if (action === "status" && request.method === "GET") {
    return json(response, 200, publicStatus(state));
  }
  if (action === "activity" && request.method === "GET") {
    return json(response, 200, publicActivity(state));
  }
  if (action === "dispatch" && request.method === "GET") {
    return json(response, 200, publicDispatch(state, url.searchParams.get("requestId") || ""));
  }
  if (action === "queue" && request.method === "GET") {
    return json(response, 200, publicQueue(state));
  }
  if (action === "config" && request.method === "GET") {
    return json(response, 200, { ...state.composer, commands: state.slashCommands });
  }
  if (action === "config" && request.method === "POST") {
    return await handleConfig(request, response, state);
  }
  if (action === "attach" && request.method === "POST") {
    // Never dispatches. Attach exists to move the SDK's cold start *outside*
    // the at-most-once window, where a failure is unambiguous: nothing
    // journaled, no prompt written.
    // Truthiness, not `!== undefined`: an unattached session carries `null`,
    // which is exactly the check `ensureSession` itself makes.
    const wasAttached = Boolean(state.session);
    await ensureSession(state);
    // `sessionFile` is what re-attaches to the same Pi conversation after a
    // restart. Create persists the bridge id; this persists the pointer — but
    // only on the call that actually minted one. The backend attaches before
    // every prompt and `ensureSession` returns the existing session untouched,
    // so barriering unconditionally rewrote the whole state file, up to
    // `MAX_STATE_FILE_BYTES` of transcript, once per turn for nothing.
    if (!wasAttached) await persistBarrier();
    return json(response, 200, { attached: true });
  }
  if ((action === "cancel" || action === "abort") && request.method === "POST") {
    return await handleCancel(response, state);
  }
  if (action === "compact" && request.method === "POST") {
    return await handleCompact(response, state);
  }
  if (action === "steer" && request.method === "POST") {
    return await handleSteer(request, response, state);
  }
  if (action === "fork" && request.method === "POST") {
    return await handleFork(request, response, state);
  }
  if (action === "structured-output" && request.method === "GET") {
    const requestId = url.searchParams.get("requestId") || "";
    return json(response, 200, {
      structuredOutput: state.structured.get(requestId) ?? null,
    });
  }
  if (action === "approvals" && request.method === "GET") {
    return json(response, 200, publicApprovals(state));
  }
  if (action === "approvals" && request.method === "POST" && subject) {
    return await handleApprovalDecision(request, response, state, subject);
  }
  if (action === "interactions" && request.method === "GET") {
    return json(response, 200, publicInteractions(state));
  }
  if (action === "prompt" && request.method === "POST") {
    return await handlePrompt(request, response, state, clientSignal);
  }
  return json(response, 404, { error: "Not found" });
}

/**
 * Close one bridge session, which is what a closed tab means.
 *
 * The backend issues this for a torn-down `pi-native` tab and reads a 404 as
 * "already gone", so a bridge without the route leaked every session it ever
 * served — a bounded-but-large transcript retained for the life of the
 * process and rewritten into `state.json` on every persist.
 *
 * Deliberately narrower than it looks: Pi's own JSONL session file is *not*
 * removed. The conversation lives there rather than here, so deleting it would
 * destroy user history that a resume is still entitled to reach. This releases
 * the SDK session, denies anything parked, and drops the bridge's rendered
 * copy.
 */
async function handleDelete(response: ServerResponse, state: SessionState): Promise<void> {
  denyAllApprovals(state, "The session was closed before this request was answered.");
  // Cancelling first means a turn in flight stops writing into a transcript
  // nothing will read, rather than running to completion against a detached
  // session.
  try {
    state.cancelTurn?.();
  } catch {
    // Best-effort: a cancel handle that throws must not strand the session in
    // the map, which is the leak this route exists to close.
  }
  await closeSession(state);
  sessions.delete(state.id);
  if (state.clientSessionKey) clientSessionKeys.delete(state.clientSessionKey);
  schedulePersist();
  return json(response, 200, { deleted: true });
}

async function handleConfig(
  request: IncomingMessage,
  response: ServerResponse,
  state: SessionState,
): Promise<void> {
  const body = await readJson(request);
  // Claimed before the first await, exactly as the prompt route does: applying
  // a patch reaches the live session, and a prompt admitted in that window
  // would plan against a composer that is about to change under it.
  if (state.status === "running" || state.dispatching) {
    throw new HttpError(409, "Session is already running");
  }
  const patch = parseComposerPatch(body);
  if (!patch) return json(response, 200, { ...state.composer, commands: state.slashCommands });
  state.dispatching = true;
  try {
    if (applyComposerPatch(state, patch)) {
      // Pushed to the live session when there is one. A detached session picks
      // the selection up on its next attach, so nothing is lost by not forcing
      // a cold start here.
      await applyComposerToSession(state);
      schedulePersist();
    }
  } finally {
    state.dispatching = false;
  }
  return json(response, 200, { ...state.composer, commands: state.slashCommands });
}

async function handleCancel(response: ServerResponse, state: SessionState): Promise<void> {
  const cancel = state.cancelTurn;
  // A parked tool hook is part of the run being aborted. Answer it first so
  // the SDK never observes a disappearing run as implicit permission, and so
  // abort cannot leave the hook awaiting a promise nobody will settle.
  denyAllApprovals(state, "The turn was cancelled before this tool call was approved.");
  if (cancel) await cancel();
  // The run's own terminal path settles the transcript. Reporting idle here
  // would race it and let a caller start a second turn into a run that has not
  // actually stopped yet.
  return json(response, 200, { cancelled: Boolean(cancel) });
}

/**
 * Compact the conversation on demand.
 *
 * Refused while a turn is running: Pi's manual compaction aborts the current
 * operation first, so allowing it mid-turn would silently cancel the turn the
 * user is watching in order to shrink its context.
 */
async function handleCompact(response: ServerResponse, state: SessionState): Promise<void> {
  if (state.status === "running" || state.dispatching || state.compacting) {
    throw new HttpError(409, "Session is already running");
  }
  // Claimed synchronously, before the first await, exactly as the prompt route
  // does. `ensureSession` is a full cold attach for the idle-detached sessions
  // compaction usually targets, and a prompt arriving inside that window used
  // to pass its own busy check and claim the turn — which `session.compact()`
  // then aborted, silently cancelling a turn the user had just sent.
  state.dispatching = true;
  state.compacting = true;
  state.revision += 1;
  try {
    const session = await ensureSession(state);
    await session.compact();
  } finally {
    state.compacting = false;
    state.dispatching = false;
    state.revision += 1;
    schedulePersist();
  }
  return json(response, 200, { compacted: true });
}

/**
 * Queue a steering message into the running turn.
 *
 * Answers `idle` rather than failing when nothing is running: the caller's view
 * of the turn is a poll behind, and a steer that arrives after the turn ended
 * is a race rather than an error. Sending it as a fresh prompt instead would
 * start a turn the user did not ask for.
 */
async function handleSteer(
  request: IncomingMessage,
  response: ServerResponse,
  state: SessionState,
): Promise<void> {
  const body = await readJson(request);
  const text = typeof body.input === "string" ? body.input.trim() : "";
  if (!text) throw new HttpError(400, "input is required");
  const session = state.session;
  if (!session || state.status !== "running") return json(response, 200, { outcome: "idle" });
  await session.steer(text);
  return json(response, 200, { outcome: "applied" });
}

async function handleFork(
  request: IncomingMessage,
  response: ServerResponse,
  state: SessionState,
): Promise<void> {
  const body = await readJson(request);
  const messageId =
    readBoundedString(body.upToMessageId, 512, "upToMessageId") ??
    readBoundedString(body.lastMessageId, 512, "lastMessageId");
  const forked = await forkSession(state, messageId);
  await persistBarrier();
  return json(response, 200, {
    sessionId: forked.id,
    ...(forked.title ? { title: forked.title } : {}),
  });
}

async function handleApprovalDecision(
  request: IncomingMessage,
  response: ServerResponse,
  state: SessionState,
  approvalId: string,
): Promise<void> {
  const body = await readJson(request);
  // Anything that is not an explicit approval denies. A malformed decision is
  // not consent, and treating it as one would run a command the user never saw.
  const decision = body.decision === "approve" ? "allow" : "deny";
  const settled = resolveApproval(
    state,
    decodeURIComponent(approvalId),
    decision,
    decision === "deny" ? "The user denied this tool call." : undefined,
  );
  // 404 rather than an error: the request was already settled by a timeout, a
  // closing session or a competing answer, and the backend reconciles from the
  // snapshot rather than retrying.
  if (!settled) return json(response, 404, { error: "Approval is no longer pending" });
  schedulePersist();
  return json(response, 200, { resolved: true });
}

async function handlePrompt(
  request: IncomingMessage,
  response: ServerResponse,
  state: SessionState,
  clientSignal: AbortSignal,
): Promise<void> {
  const body = await readJson(request);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const requestId = readBoundedString(body.requestId, 512, "requestId");
  const schema = isObject(body.outputSchema) ? body.outputSchema : undefined;

  // Shape validation happens before the turn is claimed: a malformed
  // attachment list is a caller error, not a turn that half-started.
  const attachments = parsePromptAttachments(body.attachments);
  if (!prompt && attachments.length === 0) {
    throw new HttpError(400, "prompt or attachment is required");
  }

  if (requestId && state.promptJournal.has(requestId)) {
    const journaled = state.promptJournal.get(requestId)!;
    if (journaled.state === "ambiguous") {
      // An earlier process accepted this id and died before recording its
      // outcome. Never re-dispatch at-most-once work: refuse plainly so the
      // caller resubmits under a fresh id rather than reading a 202 as a turn
      // this process will never run.
      throw new HttpError(
        410,
        "Pi prompt outcome is unknown after a bridge restart; resubmit with a new requestId",
      );
    }
    if (journaled.state === "prepared")
      throw new HttpError(409, "Prompt dispatch is still preparing");
    return json(response, 202, { accepted: true, duplicate: true });
  }
  // `compacting` counts as busy: Pi's compaction aborts whatever is running,
  // so a prompt admitted alongside one is a turn that gets cancelled out from
  // under the user.
  if (state.status === "running" || state.dispatching || state.compacting) {
    throw new HttpError(409, "Session is already running");
  }

  // Claim the turn synchronously. `ensureSession` yields even on its attached
  // fast path, so a second request would otherwise pass both the duplicate and
  // the busy check and dispatch the same prompt twice.
  state.dispatching = true;
  if (requestId) {
    setPromptJournal(state, { requestId, state: "prepared", acceptedAt: Date.now() });
  }

  let images: PiPromptImage[];
  let files: PiPromptFile[];
  let session: Awaited<ReturnType<typeof ensureSession>>;
  try {
    // Read attachments first: an unreadable image must fail before a session is
    // attached, and it is far cheaper than a cold start.
    images = await readPromptImages(attachments, workingDirectory);
    files = await resolvePromptFiles(attachments, workingDirectory);
    applyComposerPatch(state, parseComposerPatch(body));
    session = await ensureSession(state);
    await applyComposerToSession(state);
    // The prepared record must be on disk before Pi can possibly accept the
    // prompt. After this point a crash is ambiguous, so restart must refuse to
    // dispatch the same request id rather than infer that it never ran.
    if (requestId) await persistBarrier();
  } catch (error) {
    // The turn provably did not run, so release the claim and let the caller
    // retry under the same request id.
    state.dispatching = false;
    if (requestId) state.promptJournal.delete(requestId);
    schedulePersist();
    throw error;
  }

  const text = prompt + promptFileReferences(files);
  const messageStart = state.messages.length;
  const uncheckedBeforePrompt = state.uncheckedTranscriptBytes;
  appendUserMessage(state, prompt, images, files);
  state.status = "running";
  state.error = undefined;
  state.promptSequence += 1;
  state.turnStartedAt = Date.now();
  state.currentTurnUsage = {};
  state.currentTurnOutput = schema ? "" : null;
  state.currentAssistantMessageId = undefined;
  state.revision += 1;

  let handle: Awaited<ReturnType<typeof dispatchPrompt>>;
  try {
    handle = await dispatchPrompt(state, session, {
      prompt: text,
      images: images.map((image) => ({ mimeType: image.mimeType, data: image.data })),
      ...(schema ? { schema } : {}),
      ...(requestId ? { requestId } : {}),
    });
  } catch (error) {
    // Pi refused the prompt before the run started, so nothing ran. Roll the
    // turn back rather than leaving the session wedged as running or showing
    // a user message for work the agent never accepted.
    state.messages.splice(messageStart);
    state.uncheckedTranscriptBytes = uncheckedBeforePrompt;
    state.status = "error";
    state.error = errorText(error);
    state.dispatching = false;
    state.cancelTurn = undefined;
    state.currentAssistantMessageId = undefined;
    state.openTextParts.clear();
    state.toolInputs.clear();
    state.currentTurnUsage = undefined;
    state.turnStartedAt = undefined;
    state.currentTurnOutput = null;
    if (requestId) state.promptJournal.delete(requestId);
    state.revision += 1;
    schedulePersist();
    throw error;
  }

  // The run has started, so the journal can now answer an acknowledgement
  // probe positively and the busy check is authoritative again.
  journal(state, requestId, "accepted");
  state.dispatching = false;
  boundTranscript(state);
  schedulePersist();
  // The turn outlives this request. `clientSignal` deliberately does not
  // cancel it: a renderer that navigated away has not asked the agent to stop.
  void handle.completion;
  void clientSignal;
  return json(response, 202, { accepted: true });
}

function appendUserMessage(
  state: SessionState,
  prompt: string,
  images: readonly PiPromptImage[],
  files: readonly PiPromptFile[],
): void {
  const messageId = randomBytes(12).toString("hex");
  const attachments = [...images, ...files];
  state.messages.push({
    id: messageId,
    role: "user",
    content: prompt,
    parts: [
      ...(prompt
        ? [
            {
              type: "text" as const,
              content: prompt,
              sourcePartId: `${messageId}:0`,
              sourceMessageId: messageId,
            },
          ]
        : []),
      ...attachments.map((attachment, index): BridgeFilePart => ({
        type: "file",
        content: attachment.filename || attachment.path,
        fileUrl: pathToFileURL(attachment.absolutePath).href,
        sourcePartId: `${messageId}:${index + 1}`,
        sourceMessageId: messageId,
      })),
    ],
    createdAt: new Date().toISOString(),
  });
  chargeTranscript(state, Buffer.byteLength(prompt) + 256 * (attachments.length + 1));
}

function readBoundedString(value: unknown, limit: number, field: string): string | undefined {
  if (!nonBlank(value)) return undefined;
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed) > limit) throw new HttpError(400, `${field} is too long`);
  return trimmed;
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    // Checked as it arrives rather than after: buffering an unbounded body to
    // measure it is the problem the bound exists to prevent.
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
}

function acceptsGzip(request: IncomingMessage): boolean {
  const header = request.headers["accept-encoding"];
  const value = Array.isArray(header) ? header.join(",") : header;
  if (typeof value !== "string") return false;

  let wildcard: number | undefined;
  for (const item of value.split(",")) {
    const [rawCoding, ...rawParameters] = item.split(";");
    const coding = rawCoding?.trim().toLowerCase();
    if (coding !== "gzip" && coding !== "*") continue;

    let quality = 1;
    for (const rawParameter of rawParameters) {
      const [rawName, rawValue] = rawParameter.split("=", 2);
      if (rawName?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(rawValue?.trim());
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    // A named coding takes precedence over a wildcard, including an explicit
    // refusal (`gzip;q=0, *;q=1`).
    if (coding === "gzip") return quality > 0;
    wildcard = quality;
  }
  return (wildcard ?? 0) > 0;
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body) ?? "null");
  // A whole transcript is the largest thing this bridge returns and it is
  // highly compressible. Below the threshold the round trip through zlib costs
  // more than the bytes it saves.
  if (payload.length < 4096 || !gzipCapableResponses.has(response)) {
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(payload.length),
    });
    response.end(payload);
    return;
  }
  gzip(payload, (error, compressed) => {
    if (error) {
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(status, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(compressed.length),
    });
    response.end(compressed);
  });
}
