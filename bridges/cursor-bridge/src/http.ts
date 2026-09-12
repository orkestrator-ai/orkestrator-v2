/**
 * The bridge's HTTP surface.
 *
 * Every route here is one the backend's shared bridge provider already speaks
 * to Claude, Codex and the ACP agents. Answering them identically is what lets
 * this bridge be swapped in for the ACP one without a line changing in the
 * backend, the store or the renderer.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { gzip } from "node:zlib";
import { authenticate, MAX_BODY_BYTES, PROVIDER, workingDirectory } from "./config.js";
import {
  authStatus,
  beginLogin,
  CURSOR_AUTHENTICATION_REQUIRED_MESSAGE,
  logout,
} from "./credentials.js";
import { listModels, refreshModels } from "./models.js";
import { parseAgentMcpConnection, publicCursorMcpServers } from "./mcp.js";
import { persistBarrier, schedulePersist } from "./persistence.js";
import { refreshPlanAccountWindows } from "./plan-usage.js";
import {
  dispatchPrompt,
  errorText,
  journal,
  refreshAgentUsage,
  setPromptJournal,
} from "./prompt.js";
import {
  parsePromptAttachments,
  PromptAttachmentError,
  readPromptImages,
  type CursorPromptImage,
} from "./prompt-attachments.js";
import {
  messageWindow,
  parseFromIndex,
  publicActivity,
  publicContextUsage,
  publicDispatch,
  publicRuntime,
  publicSession,
  publicStatus,
  publicSessionReference,
} from "./public.js";
import { emptyRuntimeHealth } from "@orkestrator/protocol/runtime-health";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/progressive-transcript";
import { isNativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { boundTranscript, boundTranscriptForRead, chargeTranscript } from "./transcript.js";
import {
  applyComposerPatch,
  createSession,
  CredentialError,
  detachAgent,
  ensureAgent,
  listResumableSessions,
  parseComposerPatch,
  rewindSessionHistory,
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

/** The one in-flight interactive login, if any. See the login routes below. */
let activeLogin: ReturnType<typeof beginLogin> | null = null;

export async function route(
  request: IncomingMessage,
  response: ServerResponse,
  clientSignal: AbortSignal,
): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  // Read once, here, so every `json` below answers in a representation this
  // client actually asked for. Stashed on the response rather than threaded
  // through every call site, which is how the ACP bridge carries it too.
  (response as GzipCapableResponse)[RESPONSE_ACCEPTS_GZIP] = acceptsGzip(
    request.headers["accept-encoding"],
  );

  // Health is unauthenticated on purpose: the launcher polls it to decide the
  // bridge is up, before it has a reason to trust it with a token.
  if (url.pathname === "/global/health" && request.method === "GET") {
    return json(response, 200, { ok: true, provider: PROVIDER, version: "1.0.0" });
  }
  if (
    !authenticate({
      authorization: request.headers.authorization,
      token: request.headers["x-orkestrator-cursor-token"],
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
    if (error instanceof CredentialError) {
      return json(response, 401, {
        error: error.message,
        kind: "authentication-required",
      });
    }
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
  if (url.pathname === "/global/usage" && request.method === "GET") {
    // Plan-quota read only needs the stored credential, not a session. A `null`
    // account means no credential, a failed token exchange or an unreachable
    // dashboard; the backend reports that as unavailable rather than as a plan
    // with no metered limits.
    const account = await refreshPlanAccountWindows();
    json(response, 200, { account: account ?? null });
    return true;
  }
  if (url.pathname === "/global/refresh-catalog" && request.method === "POST") {
    refreshModels();
    json(response, 200, { ok: true });
    return true;
  }
  // Cursor's slash commands are an editor feature with no SDK surface. Say so
  // with an empty list rather than a 404, which the backend would read as a
  // bridge that predates the route.
  if (url.pathname === "/global/slash-commands" && request.method === "GET") {
    json(response, 200, { commands: [] });
    return true;
  }
  if (url.pathname === "/global/auth" && request.method === "GET") {
    json(response, 200, await authStatus());
    return true;
  }
  if (url.pathname === "/global/auth/login" && request.method === "POST") {
    await startLogin(response);
    return true;
  }
  if (url.pathname === "/global/auth/logout" && request.method === "POST") {
    activeLogin?.cancel();
    activeLogin = null;
    await logout();
    json(response, 200, await authStatus());
    return true;
  }
  if (url.pathname === "/session/list" && request.method === "GET") {
    json(response, 200, { sessions: await listResumableSessions() });
    return true;
  }
  if (url.pathname === "/session/create" && request.method === "POST") {
    const body = await readJson(request);
    const clientSessionKey = readBoundedString(body.clientSessionKey, 512, "clientSessionKey");
    const readOnly = body.readOnly;
    if (readOnly !== undefined && typeof readOnly !== "boolean") {
      throw new HttpError(400, "readOnly must be a boolean");
    }
    if (!isNativeAgentExecutionPolicy(body.policy)) {
      throw new HttpError(400, "policy is required");
    }
    const state = await createSession(
      clientSessionKey,
      parseComposerPatch(body),
      body.policy,
      readOnly,
    );
    storeAgentMcp(state, body.agentMcp);
    // Creation is idempotent by client key, so this can be a session that
    // already exists under the other boundary. Move it rather than answering
    // 201 with the old one: an attach would otherwise warm an agent the caller
    // has just asked not to have. A busy session cannot be moved underneath
    // its own turn, and says so.
    if (typeof readOnly === "boolean" && (state.readOnly === true) !== readOnly) {
      if (state.status === "running" || state.dispatching) {
        throw new HttpError(409, "Session is already running");
      }
      await detachAgent(state);
      state.readOnly = readOnly;
      schedulePersist();
    }
    json(response, 201, publicSession(state));
    return true;
  }
  if (url.pathname === "/session/resume" && request.method === "POST") {
    const body = await readJson(request);
    const agentId = readBoundedString(body.sessionId, 1_024, "sessionId");
    if (!agentId) throw new HttpError(400, "sessionId is required");
    if (!isNativeAgentExecutionPolicy(body.policy)) {
      throw new HttpError(400, "policy is required");
    }
    const state = await resumeSession(agentId, parseComposerPatch(body), body.policy);
    storeAgentMcp(state, body.agentMcp);
    json(response, 201, publicSessionReference(state));
    return true;
  }
  return false;
}

/**
 * Begin an interactive login and answer with the URL to open.
 *
 * One at a time: a second concurrent login would mint a second key and race to
 * persist it, so an in-flight flow is returned rather than restarted. The
 * response carries the URL only — never the minted key.
 */
async function startLogin(response: ServerResponse): Promise<void> {
  if (!activeLogin) {
    const handle = beginLogin();
    activeLogin = handle;
    // The flow outlives this request by design. Clearing the slot when it
    // settles is what lets a failed or expired attempt be retried.
    void handle.completion
      .catch(() => undefined)
      .finally(() => {
        if (activeLogin === handle) activeLogin = null;
      });
  }
  const loginUrl = await activeLogin.loginUrl.catch((error: unknown) => {
    activeLogin = null;
    throw new HttpError(502, errorText(error));
  });
  json(response, 200, { url: loginUrl, loginUrl });
}

const TRANSCRIPT_GENERATION = randomBytes(16).toString("hex");
const SESSION_ROUTE =
  /^\/session\/([^/]+)(?:\/(messages|transcript|status|activity|prompt|attach|dispatch|cancel|abort|hard-abort|steer|structured-output|interactions|config|approvals|runtime-health|commands|mcp|rewind-messages))?(?:\/([^/]+))?$/;

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
    // Same reasoning: a 404 here would read as "this bridge predates the
    // route" and fail the environment. Health is optional metadata, so an
    // unknown session answers empty rather than failing.
    if (action === "runtime-health") return json(response, 200, emptyRuntimeHealth());
    return json(response, 404, { error: "Session not found" });
  }

  // Liveness only. `/activity` and `/dispatch` deliberately do not touch it:
  // the backend sweeps every persisted session every couple of seconds, so
  // refreshing on those would put idle detaching permanently out of reach.
  if (
    action !== "activity" &&
    action !== "dispatch" &&
    action !== "runtime-health" &&
    !(action === "steer" && subject === "dispatch")
  ) {
    state.lastAccessed = Date.now();
  }

  if (!action && request.method === "GET") {
    boundTranscriptForRead(state);
    return json(response, 200, publicSession(state));
  }
  if (action === "messages" && request.method === "GET") {
    boundTranscriptForRead(state);
    return json(
      response,
      200,
      messageWindow(state, parseFromIndex(url.searchParams.get("fromIndex"))),
    );
  }
  if (action === "transcript" && request.method === "GET") {
    boundTranscriptForRead(state);
    return json(
      response,
      200,
      bridgeTranscriptUpdate(state.messages, {
        sessionIdentity: state.id,
        generation: TRANSCRIPT_GENERATION,
        contentEpoch: state.droppedMessages,
        revision: state.revision,
        limit: Number(url.searchParams.get("limit")),
        targetBytes: Number(url.searchParams.get("targetBytes")),
        knownToken: url.searchParams.get("knownToken") ?? undefined,
        complete: !state.transcriptTruncated && state.droppedMessages === 0,
      }),
    );
  }
  if (action === "status" && request.method === "GET") {
    const readiness = state.agent
      ? { state: "ready" as const }
      : (await authStatus()).state === "signed-in"
        ? { state: "ready" as const }
        : {
            state: "authentication-required" as const,
            message: CURSOR_AUTHENTICATION_REQUIRED_MESSAGE,
          };
    return json(response, 200, publicStatus(state, readiness));
  }
  if (action === "usage" && request.method === "GET") {
    const agent = await ensureAgent(state);
    if (state.usage) {
      const floor = Math.max(state.usage.sessionTokenFloor ?? 0, state.usage.sessionTokens ?? 0);
      await refreshAgentUsage(state, agent, state.promptSequence, floor);
    }
    await refreshPlanAccountWindows();
    return json(response, 200, { contextUsage: publicContextUsage(state) });
  }
  if (action === "activity" && request.method === "GET") {
    return json(response, 200, publicActivity(state));
  }
  if (action === "runtime-health" && request.method === "GET") {
    // A read, like `/activity`: no liveness touch, no attach.
    return json(response, 200, { summary: publicRuntime(state), ...state.health.snapshot() });
  }
  if (action === "dispatch" && request.method === "GET") {
    return json(response, 200, publicDispatch(state, url.searchParams.get("requestId") || ""));
  }
  if (action === "steer" && subject === "dispatch" && request.method === "GET") {
    const entry = state.steerJournal.get(url.searchParams.get("requestId") || "");
    return json(response, 200, {
      dispatch:
        entry?.state === "delivered"
          ? "dispatched"
          : entry?.state === "absent"
            ? "absent"
            : "unknown",
    });
  }
  if (action === "commands" && request.method === "GET") {
    return json(response, 200, { commands: [] });
  }
  if (action === "mcp" && request.method === "GET" && !subject) {
    return json(response, 200, { servers: publicCursorMcpServers(state) });
  }
  if (action === "config" && request.method === "GET") {
    return json(response, 200, state.composer);
  }
  if (action === "config" && request.method === "POST") {
    return await handleConfig(request, response, state);
  }
  if (action === "attach" && request.method === "POST") {
    // Never dispatches. Attach exists to move the SDK's cold start *outside*
    // the at-most-once window, where a failure is unambiguous: nothing
    // journaled, no prompt written.
    //
    // The tab-scoped connection is accepted here too. The backend's warm-up
    // attach runs before it resolves the prompt's credential, and a restarted
    // bridge has no persisted one, so without this the warm-up would connect
    // the process-env identity and the prompt would have to rebuild the agent
    // to correct it.
    const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
    storeAgentMcp(state, isObject(body) ? body.agentMcp : undefined);
    await ensureAgent(state);
    // A failed resume can replace the underlying SDK agent and rebase its
    // agent-scoped usage counters. Persist that lifecycle change even when
    // attach was an explicit warm-up with no prompt following it.
    schedulePersist();
    return json(response, 200, { attached: true });
  }
  if ((action === "cancel" || action === "abort") && request.method === "POST") {
    return await handleCancel(response, state);
  }
  if (action === "hard-abort" && request.method === "POST") {
    return await handleCancel(response, state);
  }
  if (action === "steer" && !subject && request.method === "POST") {
    return await handleSteer(request, response, state);
  }
  if (action === "rewind-messages" && request.method === "POST") {
    const body = await readJson(request);
    const messageId = readBoundedString(body.messageId, 512, "messageId");
    if (!messageId) throw new HttpError(400, "messageId is required");
    await rewindSessionHistory(state, messageId);
    await persistBarrier();
    return json(response, 200, { rewound: true });
  }
  if (action === "structured-output" && request.method === "GET") {
    const requestId = url.searchParams.get("requestId") || "";
    return json(response, 200, {
      structuredOutput: state.structured.get(requestId) ?? null,
    });
  }
  // The SDK runs headless and approves its own tool calls, so there is never a
  // parked approval. Answering with an empty list keeps the backend's
  // reconciliation loop correct instead of making it treat a 404 as a fault.
  if (action === "approvals" && request.method === "GET") {
    return json(response, 200, { approvals: [], revision: state.revision });
  }
  if (action === "interactions" && request.method === "GET") {
    return json(response, 200, { interactions: [], revision: state.revision });
  }
  if (action === "prompt" && request.method === "POST") {
    return await handlePrompt(request, response, state, clientSignal);
  }
  if (!action && request.method === "DELETE") {
    return await handleDelete(response, state);
  }
  // The path named a session this bridge has; only the method was wrong. A 404
  // here would read as "session gone" and let a real gap — a route the backend
  // speaks and this bridge does not — be mistaken for an absent session.
  return json(response, 405, { error: "Method not allowed" });
}

async function handleSteer(
  request: IncomingMessage,
  response: ServerResponse,
  state: SessionState,
): Promise<void> {
  const body = await readJson(request);
  const text = readBoundedString(body.input, 64 * 1024, "input");
  const requestId = readBoundedString(body.requestId, 512, "requestId");
  const expectedRunId = readBoundedString(body.expectedRunId, 512, "expectedRunId");
  const run = state.activeRun;
  if (!text) throw new HttpError(400, "input is required");
  if (!run || state.status !== "running" || !run.supports("stream") || !run.steer) {
    return json(response, 200, { outcome: "idle" });
  }
  if (!requestId || !expectedRunId) {
    throw new HttpError(400, "requestId and expectedRunId are required");
  }
  const inputDigest = createHash("sha256").update(text).digest("hex");
  const previous = state.steerJournal.get(requestId);
  if (previous) {
    if (previous.inputDigest !== inputDigest || previous.expectedRunId !== expectedRunId) {
      return json(response, 409, { outcome: "unknown", requestId });
    }
    return json(response, previous.state === "delivered" ? 202 : 503, {
      outcome: previous.state === "delivered" ? "applied" : "unknown",
      requestId,
      duplicate: true,
    });
  }
  if (run.id !== expectedRunId) return json(response, 409, { outcome: "mismatch" });
  state.steerJournal.set(requestId, {
    requestId,
    inputDigest,
    expectedRunId,
    state: "prepared",
    createdAt: Date.now(),
  });
  await persistBarrier();
  if (state.activeRun !== run || state.status !== "running") {
    state.steerJournal.set(requestId, {
      requestId,
      inputDigest,
      expectedRunId,
      state: "absent",
      createdAt: Date.now(),
    });
    await persistBarrier();
    return json(response, 200, { outcome: "idle" });
  }
  try {
    const outcome = await run.steer(text);
    state.steerJournal.set(requestId, {
      requestId,
      inputDigest,
      expectedRunId,
      state: outcome === "complete_delivered" ? "delivered" : "absent",
      createdAt: Date.now(),
    });
    await persistBarrier();
    return json(
      response,
      outcome === "complete_delivered" ? 202 : 409,
      outcome === "complete_delivered"
        ? { outcome: "applied", requestId }
        : { outcome: "idle", requestId },
    );
  } catch {
    state.steerJournal.set(requestId, {
      requestId,
      inputDigest,
      expectedRunId,
      state: "ambiguous",
      createdAt: Date.now(),
    });
    await persistBarrier();
    return json(response, 503, { outcome: "unknown", requestId });
  }
}

/**
 * Close a session and release everything it holds.
 *
 * The backend's tab teardown is the only caller, and it treats a 404 as "the
 * transcript is already gone" — so a bridge that simply did not answer DELETE
 * would leak a session, its transcript and its attached SDK agent on every
 * closed tab, silently. `sessions` and the persisted state file are both
 * unbounded in the number of sessions they hold, and once that file outgrows
 * `MAX_STATE_FILE_BYTES` every later write is skipped, taking live sessions
 * down with the dead ones.
 *
 * Deleting is deliberately local. The SDK agent is disposed, not deleted: the
 * user's Cursor-side conversation is theirs, and closing a tab is not a request
 * to destroy it.
 */
async function handleDelete(response: ServerResponse, state: SessionState): Promise<void> {
  await detachAgent(state);
  sessions.delete(state.id);
  if (state.clientSessionKey && clientSessionKeys.get(state.clientSessionKey) === state.id) {
    clientSessionKeys.delete(state.clientSessionKey);
  }
  schedulePersist();
  return json(response, 200, { deleted: true });
}

async function handleConfig(
  request: IncomingMessage,
  response: ServerResponse,
  state: SessionState,
): Promise<void> {
  const body = await readJson(request);
  // Claimed before the first await, exactly as the prompt route does: a prompt
  // admitted in this window would plan against a composer that is about to
  // change under it.
  if (state.status === "running" || state.dispatching) {
    throw new HttpError(409, "Session is already running");
  }
  const patch = parseComposerPatch(body);
  if (!patch) return json(response, 200, state.composer);
  state.dispatching = true;
  try {
    // Recorded on the composer only. Every turn sends its model and mode
    // explicitly, so the selection takes effect on the next prompt without
    // throwing away a warm agent — or the conversation it holds.
    if (applyComposerPatch(state, patch)) schedulePersist();
  } finally {
    state.dispatching = false;
  }
  return json(response, 200, state.composer);
}

async function handleCancel(response: ServerResponse, state: SessionState): Promise<void> {
  const cancel = state.cancelTurn;
  if (cancel) {
    await cancel();
    // The run's own terminal path settles the transcript. Reporting idle here
    // would race it and let a caller start a second turn into a run that has
    // not actually stopped yet.
    return json(response, 200, { cancelled: true });
  }

  // A turn is claimed but its run handle does not exist yet — the request is
  // still inside `ensureAgent`'s cold start or `agent.send`. Park the cancel
  // against the sequence of the turn it meant to stop rather than answering
  // 200: the caller must not read "no handle" as "already stopped".
  if (state.status === "running" || state.dispatching) {
    state.pendingCancelPromptSequence =
      state.status === "running" ? state.promptSequence : state.promptSequence + 1;
    return json(response, 202, { cancelled: false, pending: true });
  }
  return json(response, 200, { cancelled: false });
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
  const readOnly = body.readOnly;
  if (readOnly !== undefined && typeof readOnly !== "boolean") {
    throw new HttpError(400, "readOnly must be a boolean");
  }

  // Shape validation happens before the turn is claimed: a malformed
  // attachment list is a caller error, not a turn that half-started.
  const attachments = parsePromptAttachments(body.attachments);
  if (!prompt && attachments.length === 0) {
    throw new HttpError(400, "prompt or image attachment is required");
  }
  if (state.subagentLimitExceeded) {
    throw new HttpError(409, "Session exceeded the active sub-agent limit");
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
        "Cursor prompt outcome is unknown after a bridge restart; resubmit with a new requestId",
      );
    }
    if (journaled.state === "prepared")
      throw new HttpError(409, "Prompt dispatch is still preparing");
    return json(response, 202, { accepted: true, duplicate: true });
  }
  if (state.status === "running" || state.dispatching) {
    throw new HttpError(409, "Session is already running");
  }

  // Claim the turn synchronously. `ensureAgent` yields even on its attached
  // fast path, so a second request would otherwise pass both the duplicate and
  // the busy check and dispatch the same prompt twice.
  state.dispatching = true;
  // Cleared here, at the claim, because a cancel can only be parked once this
  // flag is set — so nothing that arrives for *this* turn is lost, and nothing
  // left over from a previous one can cancel it.
  state.pendingCancelPromptSequence = undefined;
  if (requestId) {
    setPromptJournal(state, { requestId, state: "prepared", acceptedAt: Date.now() });
  }

  let images: CursorPromptImage[];
  let agent: Awaited<ReturnType<typeof ensureAgent>>;
  try {
    // Read attachments first: an unreadable image must fail before an agent is
    // attached, and it is far cheaper than a cold start.
    images = await readPromptImages(attachments, workingDirectory);
    storeAgentMcp(state, body.agentMcp);
    applyComposerPatch(state, parseComposerPatch(body));
    if (typeof readOnly === "boolean" && (state.readOnly === true) !== readOnly) {
      await detachAgent(state);
      state.readOnly = readOnly;
    }
    agent = await ensureAgent(state);
  } catch (error) {
    // The turn provably did not run, so release the claim and let the caller
    // retry under the same request id.
    state.dispatching = false;
    if (requestId) state.promptJournal.delete(requestId);
    throw error;
  }

  const userMessageId = appendUserMessage(state, prompt, images);
  state.status = "running";
  state.error = undefined;
  state.promptSequence += 1;
  state.turnStartedAt = Date.now();
  state.currentRunUsage = undefined;
  state.currentTurnOutputTokenEstimate = undefined;
  state.currentRunDeltaUsage = undefined;
  state.currentRunStreamUsage = undefined;
  state.currentRunUsageUpdatedAt = undefined;
  state.currentRunModelId = state.composer.selectedModelId;
  state.currentTurnUsage = {};
  state.currentTurnOutput = schema ? "" : null;
  state.currentAssistantMessageId = undefined;
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();

  let handle: Awaited<ReturnType<typeof dispatchPrompt>>;
  try {
    handle = await dispatchPrompt(state, agent, {
      prompt,
      images: images.map((image) => ({ mimeType: image.mimeType, data: image.data })),
      ...(schema ? { schema } : {}),
      ...(requestId ? { requestId } : {}),
      userMessageId,
    });
  } catch (error) {
    // `send` rejected before the run started, so nothing ran. Roll the turn
    // back rather than leaving the session wedged as running.
    state.status = "error";
    state.error = errorText(error);
    state.dispatching = false;
    state.currentRunUsage = undefined;
    state.currentTurnOutputTokenEstimate = undefined;
    state.currentRunDeltaUsage = undefined;
    state.currentRunStreamUsage = undefined;
    state.currentRunUsageUpdatedAt = undefined;
    state.currentRunModelId = undefined;
    state.currentTurnUsage = undefined;
    if (requestId) state.promptJournal.delete(requestId);
    state.revision += 1;
    schedulePersist();
    throw error;
  }

  // The run has started, so the journal can now answer an acknowledgement
  // probe positively and the busy check is authoritative again.
  journal(state, requestId, "accepted");
  state.dispatching = false;
  // The turn outlives this request. `clientSignal` deliberately does not
  // cancel it: a renderer that navigated away has not asked the agent to stop.
  void handle.completion;
  void clientSignal;
  return json(response, 202, { accepted: true });
}

function appendUserMessage(
  state: SessionState,
  prompt: string,
  images: readonly CursorPromptImage[],
): string {
  const messageId = randomBytes(12).toString("hex");
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
      ...images.map((image, index): BridgeFilePart => ({
        type: "file",
        content: image.filename || image.path,
        fileUrl: pathToFileURL(image.absolutePath).href,
        sourcePartId: `${messageId}:${index + 1}`,
        sourceMessageId: messageId,
      })),
    ],
    createdAt: new Date().toISOString(),
  });
  chargeTranscript(state, Buffer.byteLength(prompt) + 256 * (images.length + 1));
  return messageId;
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

/**
 * Whether this client will actually accept a gzipped body.
 *
 * Compressing regardless is not safe: this repository already has a hop that
 * asks for `identity` on purpose (`gateway-proxy` keeps the loopback leg
 * decoded so preview rewriting can bound it), and a body labelled `gzip` that
 * the caller never asked for is one it will hand to `JSON.parse` as binary.
 * Parsed the same way the ACP bridge parses it, `q=0` and wildcards included.
 */
export function acceptsGzip(value: string | string[] | undefined): boolean {
  const header = Array.isArray(value) ? value.join(",") : (value ?? "");
  let wildcardQuality: number | undefined;
  for (const entry of header.split(",")) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    if (name !== "gzip" && name !== "*") continue;
    const qualityParameter = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    const rawQuality = qualityParameter?.slice(2);
    const quality =
      rawQuality === undefined
        ? 1
        : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(rawQuality)
          ? Number(rawQuality)
          : 0;
    // An explicit coding always overrides a wildcard, including `q=0`.
    if (name === "gzip") return quality > 0;
    wildcardQuality = quality;
  }
  return (wildcardQuality ?? 0) > 0;
}

export const RESPONSE_ACCEPTS_GZIP = Symbol("responseAcceptsGzip");
type GzipCapableResponse = ServerResponse & { [RESPONSE_ACCEPTS_GZIP]?: boolean };

/**
 * Write the response, or do nothing if it is already gone.
 *
 * The guard is load-bearing because compression defers the write past the
 * caller's return: a renderer that navigated away in that window leaves a
 * destroyed socket, and writing headers to it throws from a zlib callback that
 * no `catch` in this process covers.
 */
function sendJson(
  response: ServerResponse,
  status: number,
  body: Buffer,
  compressed: boolean,
): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.byteLength),
    // The body varies by encoding, so anything caching it has to key on that.
    vary: "Accept-Encoding",
    ...(compressed ? { "content-encoding": "gzip" } : {}),
  });
  response.end(body);
}

function storeAgentMcp(state: SessionState, value: unknown): void {
  const parsed = parseAgentMcpConnection(value);
  if (parsed) state.agentMcp = parsed;
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body) ?? "null");
  // A whole transcript is the largest thing this bridge returns and it is
  // highly compressible. Below the threshold the round trip through zlib costs
  // more than the bytes it saves.
  const shouldCompress =
    payload.length >= 4096 && (response as GzipCapableResponse)[RESPONSE_ACCEPTS_GZIP] === true;
  if (!shouldCompress) {
    sendJson(response, status, payload, false);
    return;
  }
  gzip(payload, (error, compressed) => {
    // Losing the bandwidth win beats losing the response.
    if (error) sendJson(response, status, payload, false);
    else sendJson(response, status, compressed, true);
  });
}
