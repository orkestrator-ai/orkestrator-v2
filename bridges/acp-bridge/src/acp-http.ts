import { randomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { gzip } from "node:zlib";
import {
  tryParseStructuredOutputText,
  } from "@orkestrator/protocol/structured-output";
import {
  parsePromptAttachments,
  PromptAttachmentError,
  readPromptImages,
  type AcpPromptImage,
  } from "./prompt-attachments.js";
import {
  applyComposerPatch,
  createSession,
  ensureSessionProcess,
  listResumableSessions,
  parseComposerPatch,
  recordTurnUsage,
  resumeSession,
  } from "./acp-session.js";
import {
  AcpProcess,
  ACP_TOKEN_HEADER,
  MAX_BODY_BYTES,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_STATE_FILE_BYTES,
  MAX_STRUCTURED_RESULT_BYTES,
  MAX_STRUCTURED_RESULTS,
  PROMPT_TIMEOUT_MS,
  HttpError,
  authToken,
  clientSessionKeys,
  provider,
  sessions,
  isObject,
  publicRuntime,
  workingDirectory,
  type BridgeFilePart,
  type JsonObject,
  type SessionState,
  } from "./acp-context.js";
import {
  boundTranscript,
  } from "./acp-transcript.js";
import {
  boundTranscriptForRead,
  messageWindow,
  parseFromIndex,
  publicApprovals,
  publicContextUsage,
  publicSession,
  setPromptJournal,
  setStructuredResult,
  } from "./acp-public.js";
import {
  listNormalizedModels,
} from "./acp-persistence.js";
import {
  persistState,
} from "./acp-persist-writer.js";
import {
  cancelCursorToolMetadataReconcile,
  scheduleCursorToolMetadataReconcile,
} from "./acp-tools.js";
import {
  reconcileStaleToolParts,
} from "./acp-reconciliation.js";
import { dispatchAcpPrompt } from "./acp-prompt.js";
import { hydrateCursorChildTranscripts } from "./acp-cursor-background.js";
import { schedulePersist } from "./acp-persist-writer.js";
import { structuredPromptInstruction } from "./acp-prompt.js";

export async function route(
  request: IncomingMessage,
  response: ServerResponse,
  clientSignal: AbortSignal,
): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/global/health" && request.method === "GET") {
    return json(response, 200, { ok: true, provider, version: "1.0.0" });
  }
  if (!authenticated(request)) return json(response, 401, { error: "Unauthorized" });
  if (url.pathname === "/global/auth-check" && request.method === "GET") {
    return json(response, 200, { ok: true });
  }
  if (url.pathname === "/global/models" && request.method === "GET") {
    const models = await listNormalizedModels(clientSignal);
    return json(response, 200, { models });
  }
  if (url.pathname === "/session/list" && request.method === "GET") {
    return json(response, 200, { sessions: await listResumableSessions() });
  }
  if (url.pathname === "/session/resume" && request.method === "POST") {
    const body = await readJson(request);
    const selectedSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!selectedSessionId) return json(response, 400, { error: "sessionId is required" });
    if (Buffer.byteLength(selectedSessionId) > 1_024) {
      return json(response, 400, { error: "sessionId is too long" });
    }
    const state = await resumeSession(
      selectedSessionId,
      clientSignal,
      parseComposerPatch(body),
    );
    return json(response, 201, publicSession(state));
  }
  if (url.pathname === "/session/create" && request.method === "POST") {
    const body = await readJson(request);
    const rawClientSessionKey = typeof body.clientSessionKey === "string" ? body.clientSessionKey.trim() : "";
    if (Buffer.byteLength(rawClientSessionKey) > 512) {
      return json(response, 400, { error: "clientSessionKey is too long" });
    }
    const clientSessionKey = rawClientSessionKey || undefined;
    const spawnOptions = parseComposerPatch(body) ?? {};
    const state = await createSession(clientSessionKey, clientSignal, {
      ...spawnOptions,
      model: spawnOptions.modelId,
      effort: spawnOptions.reasoningId,
    });
    return json(response, 201, publicSession(state));
  }
  const match = /^\/session\/([^/]+)(?:\/(messages|status|activity|prompt|attach|dispatch|cancel|abort|structured-output|interactions|config|approvals(?:\/[^/]+)?))?$/.exec(url.pathname);
  if (!match) return json(response, 404, { error: "Not found" });
  const state = sessions.get(match[1]!);
  if (!state) {
    if (match[2] === "activity") return json(response, 200, { activity: "missing" });
    return json(response, 404, { error: "Session not found" });
  }
  const action = match[2];
  if (!action && request.method === "GET") {
    hydrateCursorChildTranscripts(state);
    boundTranscriptForRead(state);
    return json(response, 200, publicSession(state));
  }
  if (action === "messages" && request.method === "GET") {
    hydrateCursorChildTranscripts(state);
    boundTranscriptForRead(state);
    return json(response, 200, messageWindow(state, parseFromIndex(url.searchParams.get("fromIndex"))));
  }
  if (action === "status" && request.method === "GET") {
    const contextUsage = publicContextUsage(state);
    return json(response, 200, {
      status: state.status,
      error: state.error,
      revision: state.revision,
      composer: state.sessionConfig.composer,
      ...(contextUsage ? { contextUsage } : {}),
      runtime: publicRuntime(state),
    });
  }
  if (action === "config" && request.method === "GET") {
    return json(response, 200, state.sessionConfig.composer);
  }
  if (action === "config" && request.method === "POST") {
    const body = await readJson(request);
    // Claim before the first await, exactly as the prompt route does.
    // `applyComposerPatch` yields on `ensureSessionProcess` and again on every
    // RPC, so a bare check would let a second config POST — or a prompt —
    // through and both would plan against the same stale `sessionConfig`.
    if (state.status === "running" || state.dispatching) {
      return json(response, 409, { error: "Session is already running" });
    }
    const patch = parseComposerPatch(body);
    if (!patch) return json(response, 200, state.sessionConfig.composer);
    state.dispatching = true;
    try {
      await applyComposerPatch(state, patch, clientSignal);
    } finally {
      state.dispatching = false;
    }
    return json(response, 200, state.sessionConfig.composer);
  }
  if (action === "activity" && request.method === "GET") {
    return json(response, 200, {
      activity: state.status === "running" || state.activeSubagentToolIds.size > 0
        ? "working"
        : "idle",
    });
  }
  /**
   * Did this bridge ever take this request id?
   *
   * Read-only, and never spawns: it exists so a caller whose prompt request
   * lost its acknowledgement can settle the question from the journal instead
   * of asking the user to. `dispatched` is only ever an explicit positive.
   */
  if (action === "dispatch" && request.method === "GET") {
    const requestId = url.searchParams.get("requestId") || "";
    const entry = requestId ? state.promptJournal.get(requestId) : undefined;
    return json(response, 200, {
      // `prepared` means the route owns the id but has not handed the prompt to
      // the agent yet. `ambiguous` means a previous process died without a
      // durable answer. Neither is an explicit positive.
      dispatch: entry && (
        entry.state === "accepted"
        || entry.state === "completed"
        || entry.state === "failed"
      ) ? "dispatched" : "unknown",
    });
  }
  /**
   * Attach the agent process without dispatching anything.
   *
   * The prompt route performs the full cold start — spawn, `initialize`,
   * `session/load` — when no child is attached, and every second of that runs
   * inside the window where a caller can no longer tell whether its prompt was
   * accepted. Doing it here first makes that window short and, when it fails,
   * unambiguously empty: nothing was journaled and no prompt was written.
   */
  if (action === "attach" && request.method === "POST") {
    await ensureSessionProcess(state, clientSignal);
    return json(response, 200, { attached: true });
  }
  if (action === "approvals" && request.method === "GET") return json(response, 200, { approvals: publicApprovals(state), revision: state.revision });
  if (action === "interactions" && request.method === "GET") return json(response, 200, { interactions: [], revision: state.revision });
  if (action?.startsWith("approvals/") && request.method === "POST") {
    const approval = state.approvals.get(decodeURIComponent(action.slice("approvals/".length)));
    if (!approval) return json(response, 404, { error: "Approval not found" });
    const body = await readJson(request);
    const explicitOption = typeof body.optionId === "string" ? body.optionId : undefined;
    const selectedByDecision = body.decision === "approve"
      ? approval.options.find((option) => option.kind === "allow_once")?.optionId
        ?? approval.options.find((option) => option.kind?.startsWith("allow"))?.optionId
      : body.decision === "deny"
        ? approval.options.find((option) => option.kind === "reject_once")?.optionId
          ?? approval.options.find((option) => option.kind?.startsWith("reject"))?.optionId
        : undefined;
    approval.respond(explicitOption ?? selectedByDecision);
    return json(response, 200, { resolved: true });
  }
  if (action === "structured-output" && request.method === "GET") {
    const requestId = url.searchParams.get("requestId") || "";
    return json(response, 200, { structuredOutput: state.structured.get(requestId) ?? null });
  }
  if (action === "prompt" && request.method === "POST") {
    const body = await readJson(request);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    const schema = isObject(body.outputSchema) ? body.outputSchema : undefined;
    // Shape validation happens before the turn is claimed: a malformed
    // attachment list is a caller error, not a turn that half-started.
    let attachments;
    try {
      attachments = parsePromptAttachments(body.attachments);
    } catch (error) {
      if (!(error instanceof PromptAttachmentError)) throw error;
      return json(response, 400, { error: error.message });
    }
    if (!prompt && attachments.length === 0) {
      return json(response, 400, { error: "prompt or image attachment is required" });
    }
    if (state.subagentLimitExceeded) {
      return json(response, 409, { error: "Session exceeded the active sub-agent limit" });
    }
    if (Buffer.byteLength(requestId) > 512) return json(response, 400, { error: "requestId is too long" });
    if (requestId && state.promptJournal.has(requestId)) {
      const journaled = state.promptJournal.get(requestId)!;
      // A persisted "ambiguous" entry means an earlier bridge process accepted
      // this requestId and died before its outcome was known. Never re-dispatch
      // at-most-once work: refuse plainly so the caller resubmits under a fresh
      // requestId instead of treating an accepted-looking 202 as a running turn
      // that this process will never execute.
      if (journaled.state === "ambiguous") {
        return json(response, 410, {
          error: `${provider} prompt outcome is unknown after a bridge restart; resubmit with a new requestId`,
        });
      }
      if (journaled.state === "prepared") {
        return json(response, 409, { error: "Prompt dispatch is still preparing" });
      }
      return json(response, 202, { accepted: true, duplicate: true });
    }
    if (state.status === "running" || state.dispatching) {
      return json(response, 409, { error: "Session is already running" });
    }
    // Claim the turn synchronously. `ensureSessionProcess` yields even on its
    // attached fast path, so a second request would otherwise pass both the
    // duplicate check and the busy check and dispatch the same prompt twice.
    // `dispatching` is separate from `status` because reattaching a detached
    // thread legitimately sets `status` back to "idle" while we hold the claim.
    state.dispatching = true;
    if (requestId) setPromptJournal(state, {
      requestId,
      state: "prepared",
      acceptedAt: Date.now(),
    });
    let child: AcpProcess;
    let images: AcpPromptImage[];
    try {
      // Read the attachments first: an unreadable image must fail before a
      // detached thread is reattached, and it is far cheaper than a spawn.
      images = await readPromptImages(attachments, workingDirectory);
      child = await ensureSessionProcess(state, clientSignal);
      const promptPatch = parseComposerPatch(body);
      if (promptPatch) await applyComposerPatch(state, promptPatch, clientSignal);
    } catch (error) {
      // The turn definitely did not run, so release the claim and let the
      // caller retry with the same requestId.
      state.dispatching = false;
      // A cancel that landed in this window reserved the sequence this turn was
      // about to take. The turn never took it, so drop the reservation rather
      // than let it suppress retries for whichever turn claims it next.
      if (state.retryCancelledPromptSequence === state.promptSequence + 1) {
        state.retryCancelledPromptSequence = undefined;
      }
      if (requestId) state.promptJournal.delete(requestId);
      if (error instanceof PromptAttachmentError) {
        return json(response, 400, { error: error.message });
      }
      throw error;
    }
    const userMessageId = randomBytes(12).toString("hex");
    state.messages.push({
      id: userMessageId, role: "user", content: prompt,
      parts: [
        ...(prompt ? [{
          type: "text" as const,
          content: prompt,
          sourcePartId: `${userMessageId}:0`,
          sourceMessageId: userMessageId,
        }] : []),
        ...images.map((image, index): BridgeFilePart => ({
          type: "file",
          content: image.filename || image.path,
          fileUrl: pathToFileURL(image.absolutePath).href,
          sourcePartId: `${userMessageId}:${index + 1}`,
          sourceMessageId: userMessageId,
        })),
      ], createdAt: new Date().toISOString(),
    });
    state.status = "running";
    state.error = undefined;
    state.outputTruncated = false;
    state.promptSequence += 1;
    const promptSequence = state.promptSequence;
    state.turnStartedAt = Date.now();
    state.currentTurnUsage = {};
    state.currentTurnOutput = schema ? "" : null;
    state.revision += 1;
    boundTranscript(state);
    await persistState();
    const acpPrompt = schema ? `${prompt}\n\n${structuredPromptInstruction(schema)}` : prompt;
    const promptCompletion = dispatchAcpPrompt(state, child, {
      sessionId: state.acpSessionId,
      prompt: [
        ...(acpPrompt ? [{ type: "text", text: acpPrompt }] : []),
        // Inline base64 is the only image form both agents read. Cursor
        // advertises it; Grok understates its own capability but accepts the
        // same block, and neither supports ACP embedded resources.
        ...images.map((image) => ({
          type: "image",
          mimeType: image.mimeType,
          data: image.data,
        })),
      ],
    }, promptSequence, schema);
    // Calling the async dispatcher above synchronously writes the first
    // `session/prompt` frame before it returns its promise. Only now can the
    // journal answer an acknowledgement-recovery probe positively.
    if (requestId) setPromptJournal(state, {
      requestId,
      state: "accepted",
      acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
    });
    // The turn is now dispatched and `status` is "running", so the busy check
    // is authoritative again and the claim can be released.
    state.dispatching = false;
    void promptCompletion.then((result) => {
      // PromptResponse.usage is the ACP carrier; Grok still nests the same
      // numbers under `_meta`. Parse the whole result so either spelling lands
      // before `turnStartedAt` is cleared and the elapsed time is lost.
      recordTurnUsage(state, result);
      state.turnStartedAt = undefined;
      state.currentTurnUsage = undefined;
      if (schema && requestId) {
        const output = state.currentTurnOutput?.trim() ?? "";
        if (Buffer.byteLength(output) > MAX_STRUCTURED_RESULT_BYTES) {
          setStructuredResult(state, requestId, {
            ok: false,
            provider,
            requestId,
            error: { code: "output_too_large", message: `${provider} returned too much structured output`, provider, retryable: true },
          });
        } else {
          // Cursor/Grok dump thinking into the text channel. A raw JSON.parse of
          // the concatenated turn would reject a valid report that follows that
          // prefix, a Markdown fence, or a short wrapper. Recover the last
          // well-formed document; schema validation still happens above this.
          const value = tryParseStructuredOutputText(output);
          if (value === undefined) {
            setStructuredResult(state, requestId, {
              ok: false,
              provider,
              requestId,
              error: { code: "malformed_output", message: `${provider} returned malformed JSON`, provider, retryable: true },
            });
          } else {
            setStructuredResult(state, requestId, { ok: true, value, provider, requestId });
          }
        }
      }
      if (requestId) setPromptJournal(state, {
        requestId,
        state: state.outputTruncated ? "failed" : "completed",
        acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
      });
      // The turn is over. A tool still in flight here was cancelled or abandoned
      // by the agent — ACP has no status for that, so settle it explicitly.
      reconcileStaleToolParts(state);
      state.currentTurnOutput = null;
      if (!state.outputTruncated && state.child === child && state.status !== "error") {
        state.status = "idle";
      }
      state.revision += 1;
      schedulePersist();
      // The final pass is the safety net for every title a live pass could not
      // reach: one Cursor had not yet indexed, one skipped because a sibling
      // was still in flight, and one dropped because the turn spent its live
      // budget. It remains outside the authoritative turn lifecycle: a slow or
      // incompatible replay cannot keep the session working, block the next
      // prompt, or make completion ambiguous. The per-session scheduler also
      // prevents this pass from racing an in-flight live enrichment.
      scheduleCursorToolMetadataReconcile(state, { final: true });
    }, (error: unknown) => {
      state.status = "error";
      state.error = error instanceof Error ? error.message : String(error);
      state.turnStartedAt = undefined;
      state.currentTurnUsage = undefined;
      // A turn that failed gets no final pass, so a live timer armed moments
      // before the failure has nothing left to complete. Drop it here for the
      // same reason `DELETE` and `shutdown` do: enrichment is display-only
      // background work, and nothing should outlive the turn that asked for it.
      cancelCursorToolMetadataReconcile(state);
      reconcileStaleToolParts(state, true);
      if (requestId) setPromptJournal(state, {
        requestId,
        state: "failed",
        acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
      });
      state.currentTurnOutput = null;
      state.revision += 1;
      schedulePersist();
    });
    return json(response, 202, { accepted: true });
  }
  if ((action === "cancel" || action === "abort") && request.method === "POST") {
    for (const approval of [...state.approvals.values()]) approval.respond();
    if (state.dispatching) {
      // The turn is claimed but has not taken its sequence yet, and dispatch can
      // sit in a process spawn for seconds. Record the sequence it is about to
      // take so a cancel in that window still stops the retry loop instead of
      // costing the user four dispatches of a turn they already stopped.
      state.retryCancelledPromptSequence = state.promptSequence + 1;
    } else if (state.status === "running") {
      state.retryCancelledPromptSequence = state.promptSequence;
    }
    state.child?.notify("session/cancel", { sessionId: state.acpSessionId });
    return json(response, 202, { accepted: true });
  }
  if (!action && request.method === "DELETE") {
    for (const approval of [...state.approvals.values()]) approval.respond();
    cancelCursorToolMetadataReconcile(state);
    await state.child?.close();
    sessions.delete(state.id);
    if (state.clientSessionKey) clientSessionKeys.delete(state.clientSessionKey);
    await persistState();
    return json(response, 200, { deleted: true });
  }
  return json(response, 405, { error: "Method not allowed" });
}
export function authenticated(request: IncomingMessage): boolean {
  const dedicated = request.headers[ACP_TOKEN_HEADER];
  const candidates = [
    Array.isArray(dedicated) ? dedicated[0] : dedicated,
    request.headers.authorization?.replace(/^Bearer\s+/i, ""),
  ];
  const right = Buffer.from(authToken);
  return candidates.some((candidate) => {
    const left = Buffer.from(candidate?.trim() || "");
    return left.length === right.length && timingSafeEqual(left, right);
  });
}

export function isTrustedBridgeOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  // Electron's packaged renderer has an opaque origin. The bridge token is
  // still mandatory on every data route, so accepting that origin does not
  // make the loopback API ambiently accessible.
  if (origin === "null" || origin === "file://") return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:")
      && (parsed.hostname === "127.0.0.1"
        || parsed.hostname === "localhost"
        || parsed.hostname === "::1"
        || parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function requestPathname(request: IncomingMessage): string {
  try {
    return new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    ).pathname;
  } catch {
    return "";
  }
}

export function applyOriginPolicy(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const origin = request.headers.origin;
  if (!isTrustedBridgeOrigin(origin)) {
    json(response, 403, { error: "Origin is not allowed" });
    return false;
  }
  // `/global/health` answers before the token check so the backend can probe a
  // bridge whose credential it does not hold, and its only client is that
  // non-browser prober. Granting it CORS — and with it a Private Network
  // Access opt-in — would let any page that can produce an accepted origin
  // read it. `null` is an accepted origin, and every public site can mint one
  // through a sandboxed iframe, so the loopback probing PNA exists to prevent
  // would be reachable from the open web. Withhold both headers there; the
  // route stays reachable, its body just stays unreadable to a browser.
  const unauthenticatedRoute = requestPathname(request) === "/global/health";
  if (origin) response.setHeader("Vary", "Origin");
  if (origin && !unauthenticatedRoute) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
  if (request.method !== "OPTIONS") return true;
  response.writeHead(204, unauthenticatedRoute ? {} : {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, Authorization, ${ACP_TOKEN_HEADER}`,
    "Access-Control-Allow-Private-Network": "true",
  });
  response.end();
  return false;
}

export async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!isObject(parsed)) throw new HttpError(400, "Expected a JSON object");
  return parsed;
}

export const RESPONSE_ACCEPTS_GZIP = Symbol("responseAcceptsGzip");

export function acceptsGzip(value: string | string[] | undefined): boolean {
  const header = Array.isArray(value) ? value.join(",") : value ?? "";
  let wildcardQuality: number | undefined;
  for (const entry of header.split(",")) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    if (name !== "gzip" && name !== "*") continue;
    const qualityParameter = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    const rawQuality = qualityParameter?.slice(2);
    const quality = rawQuality === undefined
      ? 1
      : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(rawQuality)
        ? Number(rawQuality)
        : 0;
    // An explicit coding always overrides a wildcard, including q=0.
    if (name === "gzip") return quality > 0;
    wildcardQuality = quality;
  }
  return (wildcardQuality ?? 0) > 0;
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: Buffer,
  compressed: boolean,
): void {
  if (response.headersSent || response.destroyed) return;
  const existingVary = response.getHeader("Vary");
  const vary = typeof existingVary === "string" && existingVary.trim()
    ? `${existingVary}, Accept-Encoding`
    : "Accept-Encoding";
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
    vary,
    ...(compressed ? { "content-encoding": "gzip" } : {}),
  });
  response.end(body);
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  const shouldCompress = body.byteLength >= 1024
    && (response as ServerResponse & { [RESPONSE_ACCEPTS_GZIP]?: boolean })[
      RESPONSE_ACCEPTS_GZIP
    ] === true;
  if (!shouldCompress) {
    sendJson(response, status, body, false);
    return;
  }
  /*
   * Compression happens on libuv's threadpool, never inline. This process also
   * runs the agent's JSON-RPC stdio loop and every session's SSE writer, and a
   * transcript read is allowed up to `MAX_TRANSCRIPT_BYTES` — synchronous gzip
   * of that much would stall all of them for the duration.
   *
   * The write is therefore deferred past the caller's return. Nothing else
   * writes this response afterwards: the request handler's `.catch` only fires
   * when routing rejects, and `sendJson` refuses a response that is already
   * headed or destroyed.
   */
  gzip(body, { level: 6 }, (error, encoded) => {
    if (error) {
      // Losing the bandwidth win beats losing the response.
      sendJson(response, status, body, false);
      return;
    }
    sendJson(response, status, encoded, true);
  });
}
