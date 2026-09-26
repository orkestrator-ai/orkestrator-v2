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
import {
  authenticate,
  MAX_BODY_BYTES,
  MAX_STEER_ID_BYTES,
  PROVIDER,
  workingDirectory,
} from "./config.js";
import {
  authStatus,
  beginLogin,
  CURSOR_AUTHENTICATION_REQUIRED_MESSAGE,
  logout,
} from "./credentials.js";
import { listModels, refreshModels } from "./models.js";
import { parseAgentMcpConnection, publicCursorMcpServers } from "./mcp.js";
import {
  identityPublished,
  PersistenceError,
  persistBarrier,
  schedulePersist,
} from "./persistence.js";
import {
  closeRestoredTombstone,
  closeSessionPermanently,
  hasRestoredTombstone,
} from "./session-close.js";
import {
  admitSteer,
  noteSteerRefusal,
  removeSteer,
  setSteerEntry,
  steerHistoryFenced,
  steerJournalSummary,
  type SteerRejectionReason,
} from "./steer-journal.js";
import { refreshPlanAccountWindows } from "./plan-usage.js";
import {
  dispatchPrompt,
  errorText,
  journal,
  promptJournalHasRoom,
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
import { idleSteerPromptReply } from "@orkestrator/protocol/agent-slash-commands";
import {
  NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
  commandUnavailableResponse,
  readBridgePromptCommandFields,
  type BridgeCommandCatalogueResponse,
} from "@orkestrator/protocol/agent-command-catalogue";
import { boundTranscript, boundTranscriptForRead, chargeTranscript } from "./transcript.js";
import {
  applyComposerPatch,
  createSession,
  CredentialError,
  SessionConflictError,
  detachAgent,
  ensureAgent,
  listResumableSessions,
  parseComposerPatch,
  publicCursorMcpConfig,
  rewindSessionHistory,
  resumeSession,
} from "./agent-session.js";
import {
  assertSessionOpen,
  isObject,
  nonBlank,
  SessionClosedError,
  sessions,
  type BridgeFilePart,
  type JsonObject,
  type SessionState,
  type SteerJournalEntry,
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
    if (error instanceof SessionConflictError) {
      return json(response, 409, { error: error.message });
    }
    // Nothing was started: the session's permanent close had already begun.
    if (error instanceof SessionClosedError) {
      return json(response, 409, { error: error.message, kind: "session-closing" });
    }
    // A mandatory publication failed before the operation that depended on it
    // reached the provider. A route whose side effect happens before its
    // publication (rewind) answers that case itself rather than landing here.
    // Retryable; the message is fixed text and never a filesystem path.
    if (error instanceof PersistenceError) {
      return json(response, 503, {
        error: error.message,
        kind: "persistence-unavailable",
        code: error.code,
      });
    }
    if (error instanceof PromptAttachmentError) {
      return json(response, 400, { error: error.message });
    }
    console.error("[cursor-bridge] Unexpected HTTP route failure");
    return json(response, 500, { error: "Internal bridge error" });
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
    json(response, 200, unsupportedCommandCatalogue());
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
      if (state.status === "running" || state.dispatching || state.rewinding) {
        throw new HttpError(409, "Session is already running");
      }
      await detachAgent(state);
      assertSessionOpen(state);
      state.readOnly = readOnly;
    }
    // The backend stores the returned id the moment it sees 201, so the
    // session, its client key and its selections must already be something a
    // restarted bridge can reload. Every acknowledgement — a retry that found
    // the session included — waits for that: a retry is exactly the case
    // where an earlier publication may have failed. On failure the session
    // stays registered under its key, so the next attempt republishes the
    // same identity rather than creating a second one.
    await persistBarrier();
    // A close that won the race while the write was in flight: the late
    // acknowledgement must not hand back an id that is already closing.
    assertSessionOpen(state);
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
    const agentMcp = parseAgentMcpConnection(body.agentMcp);
    const state = await resumeSession(agentId, parseComposerPatch(body), body.policy, agentMcp);
    // As for create: the adopted identity is published before it is
    // acknowledged. A recovered run stays owned and observed if this fails —
    // the retry finds the same session rather than adopting the agent twice.
    await persistBarrier();
    // As for create: a close that won the race while the write was in flight
    // must not be answered with an adoption of the session it is closing.
    assertSessionOpen(state);
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
  /^\/session\/([^/]+)(?:\/(messages|transcript|status|usage|activity|prompt|attach|dispatch|cancel|abort|hard-abort|steer|structured-output|interactions|config|approvals|runtime-health|commands|mcp|rewind-messages|close))?(?:\/([^/]+))?$/;

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
  if (!action && subject) return json(response, 404, { error: "Not found" });
  if (!state) {
    // Answered in band so the backend can tell "this session is gone" from
    // "this bridge predates the route" — a 404 here would have it delete a
    // live session mapping against an older bridge.
    if (action === "activity") return json(response, 200, { activity: "missing" });
    // Same reasoning: a 404 here would read as "this bridge predates the
    // route" and fail the environment. Health is optional metadata, so an
    // unknown session answers empty rather than failing.
    if (action === "runtime-health") return json(response, 200, emptyRuntimeHealth());
    // An enhanced catalogue answers an unknown session in band, like
    // `/activity`: 404 means "this bridge predates the route".
    if (action === "commands" && !subject && request.method === "GET") {
      return json(response, 200, missingCommandCatalogue());
    }
    // There is nothing to refresh for any session, held or not.
    if (action === "commands" && subject === "refresh" && request.method === "POST") {
      return json(response, 200, unsupportedCommandRefresh());
    }
    // A close recorded by a previous process and not yet published. Answered
    // as closing until a close request finishes it, never as a live session.
    const tombstoned = hasRestoredTombstone(match[1]!);
    if (
      tombstoned &&
      ((!action && request.method === "DELETE") || isCloseRequest(action, request))
    ) {
      return await answerCloseOperation(
        response,
        closeRestoredTombstone(match[1]!),
        action === "close" ? "close" : "delete",
      );
    }
    // Answered in band: this route exists on this bridge, so a 404 from it
    // can only mean an older bridge — which is how the backend tells the two
    // apart without ever falling back to a destructive delete.
    if (isCloseRequest(action, request) && !subject) {
      return json(response, 200, { closed: true, missing: true });
    }
    return json(response, 404, { error: "Session not found" });
  }

  // Liveness only. `/activity` and `/dispatch` deliberately do not touch it:
  // the backend sweeps every persisted session every couple of seconds, so
  // refreshing on those would put idle detaching permanently out of reach.
  // Command catalogue reads and refreshes are metadata: the backend polls them
  // for every session, so they must not keep an idle agent attached either.
  if (
    action !== "activity" &&
    action !== "dispatch" &&
    action !== "runtime-health" &&
    action !== "commands" &&
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
    // A read, like `/activity`: no liveness touch, no attach. `mcpConfig`
    // names the saved MCP files the attached agent was created from (digests
    // only), so the backend reports a change as applied on evidence.
    const mcpConfig = publicCursorMcpConfig(state);
    return json(response, 200, {
      // Steer-journal occupancy is counts and limits only.
      summary: { ...publicRuntime(state), steer: steerJournalSummary(state) },
      ...state.health.snapshot(),
      ...(mcpConfig ? { mcpConfig } : {}),
    });
  }
  if (action === "dispatch" && request.method === "GET") {
    return json(response, 200, publicDispatch(state, url.searchParams.get("requestId") || ""));
  }
  if (action === "dispatch" && subject === "discard" && request.method === "POST") {
    const body = await readJson(request);
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const entry = state.promptJournal.get(requestId);
    if (!entry || entry.state !== "ambiguous") {
      return json(response, 409, { error: "Only an ambiguous prompt can be discarded" });
    }
    setPromptJournal(state, { ...entry, state: "discarded" });
    try {
      await persistBarrier();
    } catch (error) {
      if (state.promptJournal.get(requestId)?.state === "discarded") setPromptJournal(state, entry);
      throw error;
    }
    return json(response, 200, { discarded: true });
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
  if (action === "commands" && !subject && request.method === "GET") {
    return json(response, 200, unsupportedCommandCatalogue());
  }
  if (action === "commands" && subject === "refresh" && request.method === "POST") {
    return json(response, 200, unsupportedCommandRefresh());
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
    //
    // A rotated token detaches the live agent. Refuse that while a turn is
    // in flight so a warm-up cannot destroy the work that is already running.
    if (state.status === "running" || state.dispatching || state.rewinding) {
      throw new HttpError(409, "Session is already running");
    }
    const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
    storeAgentMcp(state, isObject(body) ? body.agentMcp : undefined);
    await ensureAgent(state);
    // A failed resume can replace the underlying SDK agent. That new identity
    // is published before attach is acknowledged; an unchanged warm attach
    // whose identity is already on disk writes nothing at all, but one whose
    // earlier publication failed does not skip it.
    if (!identityPublished(state)) await persistBarrier();
    // A close that won while the attach or its write was in flight owns the
    // agent now and is disposing it: answering `attached` would describe a
    // session that is going away.
    assertSessionOpen(state);
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
    assertSessionOpen(state);
    await rewindSessionHistory(state, messageId);
    // The rewind has already changed the SDK's own store, so a publication
    // failure here cannot be answered as a refusal: the conversation is
    // rewound whatever this file says. Report that truthfully, and say what a
    // restart before the next successful save would show.
    try {
      await persistBarrier();
    } catch (error) {
      if (!(error instanceof PersistenceError)) throw error;
      state.health.recordNotice({
        message:
          "The rewind was applied, but the bridge could not save it yet. If the bridge restarts before its next successful save, the removed messages may reappear here although Cursor no longer has them.",
        method: "persistence",
        severity: "warning",
        detail: `rewind-unpublished; ${error.code}`,
      });
      state.revision += 1;
      return json(response, 200, { rewound: true, persisted: false });
    }
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
    return await answerCloseOperation(response, closeSessionPermanently(state), "delete");
  }
  if (isCloseRequest(action, request) && !subject) {
    return await answerCloseOperation(response, closeSessionPermanently(state), "close");
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
  const requestId = readBoundedString(body.requestId, MAX_STEER_ID_BYTES, "requestId");
  const expectedRunId = readBoundedString(body.expectedRunId, MAX_STEER_ID_BYTES, "expectedRunId");
  if (!text) throw new HttpError(400, "input is required");
  const inputDigest = createHash("sha256").update(text).digest("hex");
  // A retry is answered from the journal before the run's current state is
  // consulted at all: an idle, mismatch or rejected answer to a request that
  // was in fact delivered would let the caller send the same instruction
  // again. So an exact retry gets its recorded answer — at saturation, after
  // the run moved on, whatever the journal's state — and a request with no
  // record against a run whose history was evicted is `unknown`, because a
  // forgotten retry and a new instruction are indistinguishable there.
  if (requestId && expectedRunId) {
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
    if (steerHistoryFenced(state, expectedRunId)) {
      noteSteerRefusal(state, "fenced", expectedRunId);
      return json(response, 503, { outcome: "unknown", requestId });
    }
  }
  const run = state.activeRun;
  if (!run || state.status !== "running" || !run.supports("stream") || !run.steer) {
    return json(response, 200, { outcome: "idle" });
  }
  if (!requestId || !expectedRunId) {
    throw new HttpError(400, "requestId and expectedRunId are required");
  }
  if (run.id !== expectedRunId) return json(response, 409, { outcome: "mismatch" });
  assertSessionOpen(state);
  const createdAt = Date.now();
  const record = (entryState: SteerJournalEntry["state"]): SteerJournalEntry => ({
    requestId,
    inputDigest,
    expectedRunId,
    state: entryState,
    createdAt,
  });
  // Reserved synchronously, before the barrier yields, so two requests
  // cannot both take the last slot.
  const admission = admitSteer(state, record("prepared"));
  if (!admission.admitted) {
    // Definitively not sent: nothing was journaled and the SDK was not
    // called. The running turn is untouched.
    noteSteerRefusal(
      state,
      admission.reason === "steer-capacity-exceeded" ? "saturated" : "fenced",
      expectedRunId,
    );
    return rejectSteer(response, requestId, admission.reason);
  }
  try {
    await persistBarrier();
  } catch {
    // The prepared record could not be published, so nothing may be
    // delivered — and it provably was not, which is what makes forgetting it
    // safe and the refusal definitive. The failure itself is already a
    // persistence notice on the session.
    removeSteer(state, requestId);
    return rejectSteer(response, requestId, "steer-not-recorded");
  }
  if (state.activeRun !== run || state.status !== "running" || state.closed) {
    setSteerEntry(state, record("absent"));
    // The negative is exact in memory; if this write fails the file still
    // reads the request as ambiguous, which is the conservative answer.
    await persistBarrier().catch(() => undefined);
    return json(response, 200, { outcome: "idle" });
  }
  let outcome: Awaited<ReturnType<NonNullable<typeof run.steer>>>;
  try {
    outcome = await run.steer(text);
  } catch {
    setSteerEntry(state, record("ambiguous"));
    await persistBarrier().catch(() => undefined);
    return json(response, 503, { outcome: "unknown", requestId });
  }
  setSteerEntry(state, record(outcome === "complete_delivered" ? "delivered" : "absent"));
  // Delivery already happened (or provably did not); a failed write of that
  // outcome must not turn it into an error the caller would resend on. The
  // file keeps the request as ambiguous, and this process answers retries
  // from memory.
  await persistBarrier().catch(() => undefined);
  return json(
    response,
    outcome === "complete_delivered" ? 202 : 409,
    outcome === "complete_delivered"
      ? { outcome: "applied", requestId }
      : { outcome: "idle", requestId },
  );
}

const STEER_REJECTION_MESSAGES: Record<SteerRejectionReason, string> = {
  "steer-capacity-exceeded":
    "This turn has reached its steering limit. Wait for it to finish, then send the instruction as a new prompt.",
  "steer-history-unavailable":
    "This turn cannot be steered safely after the bridge restarted. Wait for it to finish, then send the instruction as a new prompt.",
  "steer-not-recorded":
    "The bridge could not save this steering instruction, so it was not sent. Try again, or send it as a new prompt once the turn finishes.",
};

/** The definitive refusal: this exact request was provably not sent. */
function rejectSteer(
  response: ServerResponse,
  requestId: string,
  reason: SteerRejectionReason,
): void {
  return json(response, 429, {
    outcome: "rejected",
    reason,
    requestId,
    message: STEER_REJECTION_MESSAGES[reason],
  });
}

function isCloseRequest(action: string | undefined, request: IncomingMessage): boolean {
  return action === "close" && request.method === "POST";
}

/**
 * Answer a permanent close.
 *
 * `DELETE /session/:id` and `POST /session/:id/close` are the same operation
 * here — Cursor's close never deletes the user's Cursor-side conversation, so
 * there is no destructive variant to keep apart. Both exist because the
 * backend's tab teardown speaks the explicit close route to every bridge,
 * and treats its 404 as "this bridge predates the route" rather than falling
 * back to a DELETE that other bridges use for permanent deletion.
 *
 * A close whose work has not stopped yet answers 503 `pending`, never success:
 * the backend keeps its durable teardown intent and retries, and the retry
 * joins the same operation.
 */
/**
 * Answer a close operation, including one whose removal failed to publish.
 *
 * A failed publication leaves the session registered and fenced, and the next
 * request republishes it — which is exactly `pending`. The close route shares
 * its contract with every managed bridge (`{ closed: false, pending: true }`,
 * see `tests/conformance/bridge-contract`), so it says so in that shape while
 * keeping the persistence kind and code the DELETE route has always carried.
 */
async function answerCloseOperation(
  response: ServerResponse,
  operation: Promise<"closed" | "pending">,
  route: "delete" | "close",
): Promise<void> {
  let outcome: "closed" | "pending";
  try {
    outcome = await operation;
  } catch (error) {
    if (route !== "close" || !(error instanceof PersistenceError)) throw error;
    return json(response, 503, {
      closed: false,
      pending: true,
      error: error.message,
      kind: "persistence-unavailable",
      code: error.code,
    });
  }
  return answerClose(response, outcome, route);
}

function answerClose(
  response: ServerResponse,
  outcome: "closed" | "pending",
  route: "delete" | "close",
): void {
  if (outcome === "pending") {
    return json(response, 503, {
      closed: false,
      pending: true,
      error: "Cursor session close is still in progress",
    });
  }
  return json(
    response,
    200,
    route === "delete" ? { deleted: true } : { closed: true, retained: true },
  );
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
  if (state.status === "running" || state.dispatching || state.rewinding) {
    throw new HttpError(409, "Session is already running");
  }
  assertSessionOpen(state);
  const patch = parseComposerPatch(body);
  if (!patch) return json(response, 200, state.composer);
  state.dispatching = true;
  try {
    // Recorded on the composer only. Every turn sends its model and mode
    // explicitly, so the selection takes effect on the next prompt without
    // throwing away a warm agent — or the conversation it holds.
    const previous = state.composer;
    if (applyComposerPatch(state, patch)) {
      // A selection made before the first prompt must survive a bridge
      // restart, so it is published before it is acknowledged. A failed
      // publication puts the previous selection back rather than answering
      // with a change a restart would silently undo.
      try {
        await persistBarrier();
      } catch (error) {
        state.composer = previous;
        state.revision += 1;
        throw error;
      }
    }
  } finally {
    state.dispatching = false;
  }
  // A close that won while the selection was being published: the session is
  // going away, so the change is not acknowledged as if it will apply.
  assertSessionOpen(state);
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

/**
 * Cursor's SDK (`@cursor/sdk` 1.0.31) has no command discovery or invocation
 * API: `SDKAgent` offers `send`, `reload`, artifacts and usage only. Editor
 * commands under `.cursor/commands` are not read, so the enhanced catalogue
 * says `unsupported` — never an empty `ready`, which would claim the provider
 * has been asked and has none. `commands: []` keeps older backends working.
 */
function unsupportedCommandCatalogue(): BridgeCommandCatalogueResponse {
  return {
    catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
    status: "unsupported",
    commands: [],
  };
}

function missingCommandCatalogue(): BridgeCommandCatalogueResponse {
  return {
    catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
    status: "missing",
    commands: [],
  };
}

function unsupportedCommandRefresh(): { outcome: "unsupported"; message: string } {
  return { outcome: "unsupported", message: "Cursor exposes no provider command catalogue" };
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
  const commandFields = readBridgePromptCommandFields(body);
  if (!commandFields.ok) throw new HttpError(400, commandFields.error);
  // This bridge lists no provider commands, so no selection can have come from
  // its catalogue. Refuse it before anything is journaled rather than hand
  // the command's name to `agent.send` as if the SDK would execute it.
  if (commandFields.command) {
    return json(response, 422, commandUnavailableResponse("Cursor exposes no provider commands"));
  }

  // Shape validation happens before the turn is claimed: a malformed
  // attachment list is a caller error, not a turn that half-started.
  const attachments = parsePromptAttachments(body.attachments);
  if (!prompt && attachments.length === 0) {
    throw new HttpError(400, "prompt or image attachment is required");
  }
  const journaled = requestId ? state.promptJournal.get(requestId) : undefined;
  // This process's own `send` rejected for this id, so whether the SDK started
  // the run is unknown. The backend parks it and offers a retry under the same
  // id; that retry may dispatch again because the SDK receives the same
  // idempotency key. A restarted bridge never sees this flag.
  const retryAfterFailedSend = journaled?.state === "ambiguous" && journaled.sendFailed === true;
  if (requestId && journaled && !retryAfterFailedSend) {
    if (journaled.state === "discarded") {
      throw new HttpError(410, "This Cursor prompt was discarded; send a new requestId");
    }
    if (journaled.local) {
      return json(response, 200, { accepted: true, local: true, duplicate: true });
    }
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
  // Refused before anything is journaled: making room would mean forgetting
  // a record that stops some earlier request from running twice.
  if (requestId && !promptJournalHasRoom(state, requestId)) {
    return json(response, 409, {
      error:
        "This Cursor session has too many prompts with an unresolved outcome; discard an ambiguous prompt before sending another",
      kind: "prompt-journal-saturated",
    });
  }
  // `/steer` answered locally is this bridge's own resolver, which literal
  // intent (`allowProviderCommands: false`) skips: the text goes to the agent
  // unchanged. The SDK has no command grammar of its own to suppress.
  const idleSteer = commandFields.allowProviderCommands
    ? idleSteerPromptReply(prompt, "Cursor")
    : null;
  if (idleSteer) {
    // A local reply is still a write to the transcript and the journal: a
    // closing session takes none.
    assertSessionOpen(state);
    if (state.status === "running" || state.dispatching) {
      throw new HttpError(409, "Use POST /session/:id/steer to steer the active turn");
    }
    if (schema) throw new HttpError(400, "/steer cannot be used with structured output");
    appendLocalExchange(state, prompt, idleSteer, requestId);
    if (requestId) {
      setPromptJournal(state, {
        requestId,
        state: "completed",
        acceptedAt: Date.now(),
        local: true,
      });
    }
    state.revision += 1;
    schedulePersist();
    return json(response, 200, { accepted: true, local: true });
  }
  // A rewind rewrites the provider's store and transcript; a turn started in
  // the middle of it would resume a half-rewritten conversation.
  if (state.status === "running" || state.dispatching || state.rewinding) {
    throw new HttpError(409, "Session is already running");
  }
  assertSessionOpen(state);

  // Claim the turn synchronously. `ensureAgent` yields even on its attached
  // fast path, so a second request would otherwise pass both the duplicate and
  // the busy check and dispatch the same prompt twice.
  state.dispatching = true;
  // Cleared here, at the claim, because a cancel can only be parked once this
  // flag is set — so nothing that arrives for *this* turn is lost, and nothing
  // left over from a previous one can cancel it.
  state.pendingCancelPromptSequence = undefined;
  // What a permanent close waits on: it settles once this claim has either
  // handed a run to `turnCompletion` or been released.
  let releaseClaim!: () => void;
  const claim = new Promise<void>((resolve) => (releaseClaim = resolve));
  state.dispatchClaim = claim;
  try {
    return await dispatchClaimedPrompt(response, state, {
      prompt,
      requestId,
      schema,
      readOnly,
      attachments,
      body,
      clientSignal,
    });
  } finally {
    if (state.dispatchClaim === claim) state.dispatchClaim = undefined;
    releaseClaim();
  }
}

async function dispatchClaimedPrompt(
  response: ServerResponse,
  state: SessionState,
  input: {
    prompt: string;
    requestId: string | undefined;
    schema: JsonObject | undefined;
    readOnly: unknown;
    attachments: ReturnType<typeof parsePromptAttachments>;
    body: JsonObject;
    clientSignal: AbortSignal;
  },
): Promise<void> {
  const { prompt, requestId, schema, readOnly, attachments, body, clientSignal } = input;
  // What this id's record was before this attempt: absent, or the ambiguous
  // record of a send that failed in this process. A pre-dispatch failure puts
  // exactly that back — never deletes evidence an earlier attempt left.
  const priorEntry = requestId ? state.promptJournal.get(requestId) : undefined;
  let prepared = false;

  let images: CursorPromptImage[];
  let agent: Awaited<ReturnType<typeof ensureAgent>>;
  try {
    // Read attachments first: an unreadable image must fail before an agent is
    // attached, and it is far cheaper than a cold start. It also fails before
    // the prepared record exists, so it can never leave one behind.
    images = await readPromptImages(attachments, workingDirectory);
    assertSessionOpen(state);
    if (requestId) {
      setPromptJournal(state, {
        requestId,
        state: "prepared",
        acceptedAt: priorEntry?.acceptedAt ?? Date.now(),
      });
      prepared = true;
    }
    storeAgentMcp(state, body.agentMcp);
    applyComposerPatch(state, parseComposerPatch(body));
    if (typeof readOnly === "boolean" && (state.readOnly === true) !== readOnly) {
      await detachAgent(state);
      assertSessionOpen(state);
      state.readOnly = readOnly;
    }
    agent = await ensureAgent(state, { atTurnStart: true });
    assertSessionOpen(state);
    // The crash boundary. The prepared record and the identity of the agent
    // it is about to go to — which the attach above may just have created or
    // replaced — are on disk before the SDK can act on either. A restart
    // after this point reads the request as ambiguous and never re-sends it.
    await persistBarrier();
    // A close that arrived while the write was in flight wins: nothing has
    // been sent, and nothing will be.
    assertSessionOpen(state);
  } catch (error) {
    // This attempt provably did not reach the SDK, so release the claim and
    // let the caller retry under the same request id. If the prepared record
    // did reach disk, a restart reads it as ambiguous — the conservative
    // answer.
    state.dispatching = false;
    if (requestId && prepared) {
      if (priorEntry) setPromptJournal(state, priorEntry);
      else state.promptJournal.delete(requestId);
      schedulePersist();
    }
    throw error;
  }

  // A cancel parked while the barrier (or the attach before it) was in
  // flight. Nothing has been sent, so there is nothing for the SDK to stop:
  // settle the turn here instead of starting one the user already abandoned.
  // The user's message is kept, the id is journaled as a settled local turn
  // (a duplicate answers it as handled and the dispatch probe as
  // `dispatched`, so it is never re-run), and the session is idle.
  if (state.pendingCancelPromptSequence === state.promptSequence + 1) {
    state.pendingCancelPromptSequence = undefined;
    appendUserMessage(state, prompt, images);
    state.promptSequence += 1;
    state.status = "idle";
    state.error = undefined;
    state.dispatching = false;
    if (requestId) {
      setPromptJournal(state, {
        requestId,
        state: "completed",
        acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
        local: true,
      });
    }
    state.revision += 1;
    boundTranscript(state);
    schedulePersist();
    return json(response, 202, { accepted: true, cancelled: true });
  }

  const messagesBeforeTurn = state.messages.slice();
  const uncheckedTranscriptBytesBeforeTurn = state.uncheckedTranscriptBytes;
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
    // `send` was called and rejected. That does not prove the run never
    // started: the SDK may have accepted it before its transport failed. So
    // the record stays as ambiguous evidence — the dispatch probe answers
    // `unknown` — and the answer is a distinct 502 the backend parks with its
    // retry-under-the-same-id and discard controls, rather than a generic
    // failure it would read as safe to resubmit under a new id.
    //
    // The session itself is rolled back rather than left wedged as running.
    // The SDK agent has to go too: a failed send can leave that object unable
    // to start another run, and `ensureAgent` would otherwise hand the same
    // instance back on retry.
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
    state.messages = messagesBeforeTurn;
    state.uncheckedTranscriptBytes = uncheckedTranscriptBytesBeforeTurn;
    if (requestId) {
      setPromptJournal(state, {
        requestId,
        state: "ambiguous",
        acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
        sendFailed: true,
      });
    }
    state.revision += 1;
    schedulePersist();
    // `detachAgent` nulls `state.agent` synchronously. Do not await the rest:
    // dispose, warm-workspace release and hosted-MCP close have no timeout, and
    // a hung teardown would hold this answer until the backend times out.
    // The idle sweeper fire-and-forgets the same way.
    void detachAgent(state).catch(() => undefined);
    // Fixed text: the SDK's own error can carry prompt or path content.
    return json(response, 502, {
      error:
        "Cursor could not confirm whether the prompt started; retry it with the same request id or discard it",
      kind: "dispatch-outcome-unknown",
    });
  }

  // The run has started, so the journal can now answer an acknowledgement
  // probe positively and the busy check is authoritative again.
  journal(state, requestId, "accepted");
  state.dispatching = false;
  // The turn outlives this request. `clientSignal` deliberately does not
  // cancel it: a renderer that navigated away has not asked the agent to stop.
  // A permanent close follows it through `turnCompletion`, which never rejects.
  const completion: Promise<void> = handle.completion.finally(() => {
    if (state.turnCompletion === completion) state.turnCompletion = undefined;
  });
  state.turnCompletion = completion;
  void clientSignal;
  return json(response, 202, { accepted: true });
}

function appendLocalExchange(
  state: SessionState,
  prompt: string,
  reply: string,
  requestId?: string,
): void {
  const userId = requestId ? `idle-steer:${requestId}` : undefined;
  if (userId && state.messages.some((message) => message.id === userId)) return;
  const userMessageId = appendUserMessage(state, prompt, [], userId);
  const messageId = requestId ? `idle-steer-reply:${requestId}` : randomBytes(12).toString("hex");
  state.messages.push({
    id: messageId,
    role: "assistant",
    content: reply,
    parts: [
      {
        type: "text",
        content: reply,
        sourcePartId: `${messageId}:0`,
        sourceMessageId: messageId,
      },
    ],
    createdAt: new Date().toISOString(),
  });
  chargeTranscript(state, Buffer.byteLength(reply));
  void userMessageId;
}

function appendUserMessage(
  state: SessionState,
  prompt: string,
  images: readonly CursorPromptImage[],
  messageId = randomBytes(12).toString("hex"),
): string {
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
