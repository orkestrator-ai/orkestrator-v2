import { isValidMcpFormContent } from "@orkestrator/protocol/mcp-elicitation-form";
import { forkAcpSession } from "./acp-fork.js";
import { humanPromptObservation } from "@orkestrator/protocol/human-prompts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { gzip } from "node:zlib";
import { tryParseStructuredOutputText } from "@orkestrator/protocol/structured-output";
import {
  DISPATCH_OUTCOME_LOST_KIND,
  isNativeAgentExecutionPolicy,
  type BridgePromptDispatchStatus,
} from "@orkestrator/protocol/native-agent";
import { parseWorkflowResultTurn } from "@orkestrator/protocol/workflow-results";
import {
  commandUnavailableResponse,
  readBridgePromptCommandFields,
} from "@orkestrator/protocol/agent-command-catalogue";
import {
  commandCatalogue,
  refreshCommandCatalogue,
  compactCommandSelection,
  resolveSelectedCommand,
} from "./acp-commands.js";
import { effectiveExecutionPolicy } from "./acp-policy.js";
import {
  parsePromptAttachments,
  PromptAttachmentError,
  readPromptContents,
  type AcpPromptContent,
} from "./prompt-attachments.js";
import {
  applyComposerPatch,
  createSession,
  ensureSessionProcess,
  finalizeTurnUsage,
  listResumableSessions,
  parseComposerPatch,
  rememberPendingLateTurnUsage,
  resumeSession,
  setSessionReadOnly,
} from "./acp-session.js";
import {
  AcpProcess,
  ACP_TOKEN_HEADER,
  MAX_BODY_BYTES,
  MAX_STRUCTURED_RESULT_BYTES,
  SESSION_CLOSING_ERROR,
  HttpError,
  authToken,
  agentRuntime,
  clientSessionKeys,
  configuredAcpMcpServers,
  parseAgentMcpConnection,
  externalSessionToken,
  provider,
  providerConfig,
  sessions,
  isObject,
  publicMcpConfigStatus,
  publicRuntime,
  workingDirectory,
  type BridgeFilePart,
  type JsonObject,
  type SessionState,
} from "./acp-context.js";
import { MCP_CONFIG_REPORTING_VERSION } from "@orkestrator/protocol/mcp-management";
import { emptyRuntimeHealth } from "@orkestrator/protocol/runtime-health";
import {
  bridgeTranscriptRouteBody,
  bridgeTranscriptSubReadBody,
  isBridgeTranscriptSubRead,
} from "@orkestrator/protocol/node/bridge-transcript-routes";
import { acpTranscriptSource } from "./acp-transcript-source.js";
import { boundTranscript } from "./acp-transcript.js";
import {
  boundTranscriptForRead,
  messageWindow,
  parseFromIndex,
  parseTailLimit,
  policyField,
  publicApprovals,
  publicInteractions,
  publicCommandRevision,
  publicContextUsage,
  publicSession,
  publicSessionReference,
  setPromptJournal,
  setStructuredResult,
} from "./acp-public.js";
import { listNormalizedModels } from "./acp-persistence.js";
import { persistState } from "./acp-persist-writer.js";
import { closeSessionRetaining, denyPendingRequests } from "./acp-session-close.js";
import {
  cancelCursorToolMetadataReconcile,
  scheduleCursorToolMetadataReconcile,
} from "./acp-tools.js";
import { reconcileStaleToolParts } from "./acp-reconciliation.js";
import { dispatchAcpPrompt, promptStopReason, turnTerminalError } from "./acp-prompt.js";
import { sessionActivityObservation } from "./acp-activity.js";
import { acpReadiness, acpSignInMissing, acpSignInRoute } from "./acp-credentials.js";
import {
  answerSessionActivityBatch,
  SESSION_ACTIVITY_BATCH_PATH,
} from "@orkestrator/protocol/session-activity-batch";
import { schedulePersist } from "./acp-persist-writer.js";
import { structuredPromptInstruction } from "./acp-prompt.js";
import { primeCommandChanges, settleCommandChangeWindows } from "./acp-command-changes.js";
import {
  CHANGE_EVIDENCE_ACK_ROUTE,
  CHANGE_EVIDENCE_BODY_ROUTE,
  CHANGE_EVIDENCE_ROUTE,
  changeEvidenceAckRouteBody,
  changeEvidenceBodyRouteBody,
  changeEvidenceReadBody,
} from "@orkestrator/protocol/node/change-tracking/evidence-routes";
import {
  beginAcpTurnEvidence,
  changeEvidenceSpool,
  endAcpTurnEvidence,
} from "./change-evidence.js";
import { holdParkedRequest, type AcpHoldFamily } from "./acp-interaction-hold.js";

const TRANSCRIPT_GENERATION = randomBytes(16).toString("hex");

/** A selected command stopped matching the live inventory before dispatch. */
class CommandUnavailableError extends Error {}

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
  // Change evidence (docs/architecture/change-tracking.md). Reads never touch
  // a session; only the backend's durable ack releases entries and bodies.
  if (url.pathname === CHANGE_EVIDENCE_ROUTE && request.method === "GET") {
    return json(
      response,
      200,
      changeEvidenceReadBody(changeEvidenceSpool(), (name) => url.searchParams.get(name)),
    );
  }
  if (url.pathname === CHANGE_EVIDENCE_BODY_ROUTE && request.method === "GET") {
    return json(
      response,
      200,
      changeEvidenceBodyRouteBody(changeEvidenceSpool(), (name) => url.searchParams.get(name)),
    );
  }
  if (url.pathname === CHANGE_EVIDENCE_ACK_ROUTE && request.method === "POST") {
    const answer = changeEvidenceAckRouteBody(changeEvidenceSpool(), await readJson(request));
    return json(response, answer.ok ? 200 : 400, answer);
  }
  if (url.pathname === "/global/auth" && request.method === "GET") {
    const signedIn =
      !(await acpSignInMissing(provider, providerConfig.authMethodEnv, {
        ...process.env,
        ...providerConfig.env,
      })) && agentRuntime.authenticated !== false;
    return json(response, 200, {
      state: signedIn ? "signed-in" : "needs-auth",
      signIn: acpSignInRoute(provider),
      signOut: false,
    });
  }
  if (
    (url.pathname === "/global/auth/login" || url.pathname === "/global/auth/logout") &&
    request.method === "POST"
  ) {
    return json(response, 405, { error: "Authentication is managed by the agent CLI" });
  }
  // Nothing here is refreshable on demand: the model catalogue is merged from
  // live sessions and each agent pushes its own commands per session. Answer
  // 200 so the backend's cache-only refresh proceeds, but do not claim a
  // refresh that did not happen. `POST /session/:id/commands/refresh` is the
  // per-session command answer.
  if (url.pathname === "/global/refresh-catalog" && request.method === "POST") {
    return json(response, 200, {
      refreshed: false,
      commands: { outcome: "unsupported", message: `${provider} pushes commands per session` },
    });
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
      effectiveExecutionPolicy(isNativeAgentExecutionPolicy(body.policy) ? body.policy : undefined),
      parseAgentMcpConnection(body.agentMcp),
    );
    return json(response, 201, publicSessionReference(state));
  }
  if (url.pathname === "/session/create" && request.method === "POST") {
    const body = await readJson(request);
    const rawClientSessionKey =
      typeof body.clientSessionKey === "string" ? body.clientSessionKey.trim() : "";
    if (Buffer.byteLength(rawClientSessionKey) > 512) {
      return json(response, 400, { error: "clientSessionKey is too long" });
    }
    const clientSessionKey = rawClientSessionKey || undefined;
    const createReadOnly = body.readOnly;
    if (createReadOnly !== undefined && typeof createReadOnly !== "boolean") {
      return json(response, 400, { error: "readOnly must be a boolean" });
    }
    const spawnOptions = parseComposerPatch(body) ?? {};
    // The child is spawned inside `createSession`, so the review boundary has
    // to be known here. Learning it from the first prompt instead would start
    // an agent under the permissive policy and immediately replace it.
    const state = await createSession(clientSessionKey, clientSignal, {
      ...spawnOptions,
      model: spawnOptions.modelId,
      effort: spawnOptions.reasoningId,
      ...(typeof createReadOnly === "boolean" ? { readOnly: createReadOnly } : {}),
      ...(() => {
        // Process authority wins: a coordinator bridge serves one conversation.
        const policy = effectiveExecutionPolicy(
          isNativeAgentExecutionPolicy(body.policy) ? body.policy : undefined,
        );
        return policy ? { policy } : {};
      })(),
      ...(parseAgentMcpConnection(body.agentMcp)
        ? { agentMcp: parseAgentMcpConnection(body.agentMcp) }
        : {}),
    });
    return json(response, 201, publicSession(state));
  }
  // The batched form of `/session/:id/activity`, from the same no-touch read.
  // Outside `/session/...`, so the id route below can never claim it.
  if (url.pathname === SESSION_ACTIVITY_BATCH_PATH && request.method === "POST") {
    const answer = await answerSessionActivityBatch(request, sessionActivityObservation, {
      contentLength: request.headers["content-length"],
    });
    return json(response, answer.status, answer.body);
  }
  const match =
    /^\/session\/([^/]+)(?:\/(close|messages|transcript(?:\/(?:detail|page))?|status|activity|human-prompts|prompt|compact|fork|attach|dispatch|cancel|abort|structured-output|interactions(?:\/[^/]+(?:\/hold)?)?|config|commands(?:\/refresh)?|mcp|approvals(?:\/[^/]+(?:\/hold)?)?|runtime-health))?$/.exec(
      url.pathname,
    );
  if (!match) return json(response, 404, { error: "Not found" });
  // `detail` or `page` for `/transcript/detail` and `/transcript/page`.
  const transcriptSubRead = match[2]?.startsWith("transcript/")
    ? match[2].slice("transcript/".length)
    : undefined;
  const state = sessions.get(match[1]!);
  if (match[2] === "human-prompts" && request.method === "GET") {
    return json(response, 200, humanPromptObservation(state?.messages));
  }
  if (!state) {
    if (match[2] === "activity") return json(response, 200, sessionActivityObservation(match[1]!));
    // Same reasoning: a 404 here would read as "this bridge predates the
    // route" and fail the environment. Health is optional metadata, so an
    // unknown session answers empty rather than failing.
    if (match[2] === "runtime-health") {
      return json(response, 200, {
        ...emptyRuntimeHealth(),
        mcpConfigReporting: MCP_CONFIG_REPORTING_VERSION,
      });
    }
    // The enhanced catalogue contract: an unknown session is answered in band.
    if (match[2] === "commands" && request.method === "GET") {
      return json(response, 200, commandCatalogue(undefined));
    }
    if (match[2] === "commands/refresh" && request.method === "POST") {
      return json(response, 200, refreshCommandCatalogue(undefined));
    }
    // Close is idempotent and answered in band: 404/405 from this route must
    // only ever mean "this bridge predates it".
    if (match[2] === "close" && request.method === "POST") {
      return json(response, 200, { closed: true, missing: true });
    }
    // Transcript detail and page reads, likewise: `missing` / `expired` in
    // band. The summary route itself keeps its 404.
    if (isBridgeTranscriptSubRead(transcriptSubRead) && request.method === "GET") {
      return json(
        response,
        200,
        bridgeTranscriptSubReadBody(undefined, transcriptSubRead, (name) =>
          url.searchParams.get(name),
        ),
      );
    }
    return json(response, 404, { error: "Session not found" });
  }
  const action = match[2];
  // A closing session stays registered (and readable) until its close lands,
  // but admits no new work: nothing may start, attach or be answered on a
  // session whose child is being stopped. Close itself joins the one close in
  // flight; cancel/abort and reads stay harmless.
  if (
    state.closing &&
    request.method === "POST" &&
    (action === "prompt" ||
      action === "compact" ||
      action === "fork" ||
      action === "attach" ||
      action === "config" ||
      action?.startsWith("approvals/") ||
      action?.startsWith("interactions/"))
  ) {
    return json(response, 409, { error: SESSION_CLOSING_ERROR });
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
      messageWindow(
        state,
        parseFromIndex(url.searchParams.get("fromIndex")),
        parseTailLimit(url.searchParams.get("limit")),
      ),
    );
  }
  if ((action === "transcript" || transcriptSubRead) && request.method === "GET") {
    boundTranscriptForRead(state);
    // Summary, detail and page read one source (see `acp-transcript-source.ts`).
    const source = acpTranscriptSource(state, `${provider}:${TRANSCRIPT_GENERATION}`);
    const query = (name: string) => url.searchParams.get(name);
    return json(
      response,
      200,
      isBridgeTranscriptSubRead(transcriptSubRead)
        ? bridgeTranscriptSubReadBody(source, transcriptSubRead, query)
        : bridgeTranscriptRouteBody(source, query),
    );
  }
  if (action === "status" && request.method === "GET") {
    const contextUsage = publicContextUsage(state);
    const readiness = await acpReadiness(provider, providerConfig.authMethodEnv, {
      ...process.env,
      ...providerConfig.env,
    });
    return json(response, 200, {
      status: state.status,
      error: state.error,
      revision: state.revision,
      // The backend's interactive snapshot reads the title from this route.
      ...(state.title ? { title: state.title } : {}),
      composer: state.sessionConfig.composer,
      ...(state.acpSessionId
        ? { resumableSessionId: externalSessionToken(state.acpSessionId) }
        : {}),
      ...policyField(state),
      ...(contextUsage ? { contextUsage } : {}),
      ...publicCommandRevision(state),
      runtime: publicRuntime(state),
      ...(readiness ? { readiness } : {}),
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
  // Metadata, like `/activity`: never attaches, spawns or reloads anything.
  // Old clients read `commands` only and still get the same rows.
  if (action === "commands" && request.method === "GET") {
    return json(response, 200, commandCatalogue(state));
  }
  // Honest by construction: re-reads the pushed list or says it cannot. It
  // never restarts an agent to make it announce again.
  if (action === "commands/refresh" && request.method === "POST") {
    return json(response, 200, refreshCommandCatalogue(state));
  }
  if (action === "mcp" && request.method === "GET") {
    configuredAcpMcpServers();
    // `mcpConfig.inventoryScope` is `process`: this listing is shared by every
    // session on the bridge, not exact truth for this one.
    return json(response, 200, {
      servers: agentRuntime.mcp ?? [],
      mcpConfig: await publicMcpConfigStatus(),
    });
  }
  /** Liveness only: no touch, transcript hydration, or re-attach. */
  if (action === "runtime-health" && request.method === "GET") {
    // A read, like `/activity`: no liveness touch, no transcript hydration, no
    // re-attach.
    return json(response, 200, {
      summary: publicRuntime(state),
      ...state.health.snapshot(),
      mcpConfigReporting: MCP_CONFIG_REPORTING_VERSION,
      mcpConfig: await publicMcpConfigStatus(),
    });
  }
  if (action === "activity" && request.method === "GET") {
    return json(response, 200, sessionActivityObservation(match[1]!));
  }
  /**
   * Did this bridge ever take this request id?
   *
   * Read-only, and never spawns: it exists so a caller whose prompt request
   * lost its acknowledgement can settle the question from the journal instead
   * of asking the user to. `dispatched` is only ever an explicit positive;
   * `lost` is exactly the prompt route's 410 `DISPATCH_OUTCOME_LOST_KIND`.
   *
   * `absent` asserts the id never reached the agent, in this process or an
   * earlier one, so the caller may send it again under the same id. It needs
   * no entry for the id in a journal that is complete for the session
   * (`promptJournalComplete`: created by this bridge, every entry still in
   * memory and on disk, the prompt route's awaited write before every
   * handover), a session that is not closing, and an id the prompt route would
   * journal as given. The duplicate check and the `prepared` entry run in one
   * synchronous step, so a send already in flight and the re-send it licenses
   * still dispatch only once. The write is not fsync'd, so the proof covers a
   * bridge restart, not an OS crash. Everything else without an entry is
   * `unknown`.
   */
  if (action === "dispatch" && request.method === "GET") {
    const requestId = url.searchParams.get("requestId") || "";
    const entry = requestId ? state.promptJournal.get(requestId) : undefined;
    // `prepared` means the route owns the id but has not handed the prompt to
    // the agent yet: `unknown`. `ambiguous` means a previous process died
    // without a durable answer and the prompt route refuses the id for good:
    // `lost`, which is neither "dispatched" nor "never sent".
    const dispatch: BridgePromptDispatchStatus =
      entry &&
      (entry.state === "accepted" || entry.state === "completed" || entry.state === "failed")
        ? "dispatched"
        : entry?.state === "ambiguous"
          ? "lost"
          : !entry && promptJournalProvesAbsent(state, requestId)
            ? "absent"
            : "unknown";
    return json(response, 200, {
      dispatch,
      // How the turn ended, once it has: the backend's `turnTerminalError`.
      ...(entry && (entry.state === "completed" || entry.state === "failed")
        ? {
            turn: {
              state: entry.state,
              ...(entry.terminalError ? { error: entry.terminalError } : {}),
            },
          }
        : {}),
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
    // Rebuilding for a rotated token closes the child. Doing that mid-turn
    // leaves status running with no process: onClose returns early once
    // `state.child` is nulled. Leave the live child and credential alone.
    if (state.status === "running" || state.dispatching) {
      return json(response, 409, { error: "Session is already running" });
    }
    const body = await readJson(request).catch(() => ({}) as JsonObject);
    storeAgentMcp(state, body.agentMcp);
    await ensureSessionProcess(state, clientSignal);
    // A close that started during the attach terminates the child it produced.
    if (state.closing) return json(response, 409, { error: SESSION_CLOSING_ERROR });
    return json(response, 200, { attached: true });
  }
  if (action === "approvals" && request.method === "GET")
    return json(response, 200, { approvals: publicApprovals(state), revision: state.revision });
  if (action === "interactions" && request.method === "GET")
    return json(response, 200, {
      interactions: publicInteractions(state),
      revision: state.revision,
    });
  // Pause or resume a parked request's countdown. Matched before the answer
  // routes below, which would otherwise read `<id>/hold` as an id. A hold
  // never answers the request; a closing session was refused above.
  const holdTarget = action ? /^(approvals|interactions)\/([^/]+)\/hold$/.exec(action) : null;
  if (holdTarget && request.method === "POST") {
    const body = await readJson(request);
    if (typeof body.held !== "boolean") {
      return json(response, 400, { error: "held must be a boolean" });
    }
    const answer = holdParkedRequest(
      state,
      holdTarget[1] as AcpHoldFamily,
      decodePathSegment(holdTarget[2]!),
      body.held,
    );
    return json(response, answer.status, answer.body);
  }
  if (action?.startsWith("approvals/") && request.method === "POST") {
    const approval = state.approvals.get(decodeURIComponent(action.slice("approvals/".length)));
    if (!approval) return json(response, 404, { error: "Approval not found" });
    const body = await readJson(request);
    const explicitOption = typeof body.optionId === "string" ? body.optionId : undefined;
    const selectedByDecision =
      body.decision === "approve"
        ? (approval.options.find((option) => option.kind === "allow_once")?.optionId ??
          approval.options.find((option) => option.kind?.startsWith("allow"))?.optionId)
        : body.decision === "deny"
          ? (approval.options.find((option) => option.kind === "reject_once")?.optionId ??
            approval.options.find((option) => option.kind?.startsWith("reject"))?.optionId)
          : undefined;
    approval.respond(explicitOption ?? selectedByDecision);
    return json(response, 200, { resolved: true });
  }
  if (action?.startsWith("interactions/") && request.method === "POST") {
    const interaction = state.interactions.get(
      decodeURIComponent(action.slice("interactions/".length)),
    );
    if (!interaction) return json(response, 404, { error: "Interaction not found" });
    const body = await readJson(request);
    if (interaction.kind === "mcp-form" || interaction.kind === "mcp-url") {
      if (body.action === "accept") {
        // Refused without answering, so the card stays up for a corrected form.
        if (
          interaction.kind === "mcp-form" &&
          !isValidMcpFormContent(interaction.schema, body.content)
        ) {
          return json(response, 400, { error: "The answer does not match the MCP server's form" });
        }
        interaction.respond(
          interaction.kind === "mcp-form"
            ? { outcome: "accept", content: body.content as JsonObject }
            : { outcome: "accept" },
        );
      } else {
        interaction.respond({ outcome: body.action === "decline" ? "decline" : "cancel" });
      }
    } else if (interaction.kind === "plan-approval") {
      const outcome =
        body.action === "approve"
          ? "approved"
          : body.action === "abandon"
            ? "abandoned"
            : "cancelled";
      interaction.respond({
        outcome,
        ...(outcome === "cancelled" && typeof body.feedback === "string"
          ? { feedback: body.feedback.slice(0, 16_384) }
          : {}),
      });
    } else if (body.action === "accept" && isObject(body.answers)) {
      const submittedAnswers = body.answers;
      const answers = Object.fromEntries(
        interaction.questions.map((question) => {
          const submitted = submittedAnswers[question.id];
          return [
            question.id,
            Array.isArray(submitted)
              ? submitted.filter((value): value is string => typeof value === "string").slice(0, 64)
              : [],
          ];
        }),
      );
      interaction.respond({ outcome: "accepted", answers });
    } else {
      interaction.respond({ outcome: "cancelled" });
    }
    return json(response, 200, { resolved: true });
  }
  if (action === "structured-output" && request.method === "GET") {
    const requestId = url.searchParams.get("requestId") || "";
    return json(response, 200, { structuredOutput: state.structured.get(requestId) ?? null });
  }
  if (action === "fork" && request.method === "POST") {
    const body = await readJson(request);
    const upToMessageId =
      typeof body.upToMessageId === "string" ? body.upToMessageId.trim() : undefined;
    if (upToMessageId && Buffer.byteLength(upToMessageId) > 1_024) {
      return json(response, 400, { error: "upToMessageId is too long" });
    }
    const forked = await forkAcpSession(state, upToMessageId || undefined, clientSignal);
    return json(response, 200, {
      ...publicSessionReference(forked),
      ...(forked.title ? { title: forked.title } : {}),
    });
  }
  if ((action === "prompt" || action === "compact") && request.method === "POST") {
    let body = await readJson(request);
    if (action === "compact") {
      // The shared `compact` session action. ACP has no compaction request, so
      // it runs the agent's own `/compact` as a selected command: everything
      // below — the journal, the busy check, revalidation after an attach —
      // applies to it unchanged. Only an optional `requestId` is read.
      body = {
        prompt: "/compact",
        ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
      };
    }
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    const schema = isObject(body.outputSchema) ? body.outputSchema : undefined;
    const readOnly = body.readOnly;
    if (readOnly !== undefined && typeof readOnly !== "boolean") {
      return json(response, 400, { error: "readOnly must be a boolean" });
    }
    // `allowProviderCommands: false` (literal intent) changes nothing here:
    // ACP has no way to tell an agent not to interpret a leading `/name`, and
    // this bridge has no resolver of its own to skip. The backend refuses a
    // literal prompt whose leading token names a known command before it gets
    // here (`literalCommandSuppression`), so the text is passed unchanged.
    const commandFields = readBridgePromptCommandFields(body);
    if (!commandFields.ok) return json(response, 400, { error: commandFields.error });
    let selectedCommand = commandFields.command;
    const workflowResult = parseWorkflowResultTurn(
      body.workflowResultTool,
      body.workflowResultKey,
      body.workflowResultSlots,
      body.workflowResultExtraTools,
    );
    if (!workflowResult.ok) return json(response, 400, { error: workflowResult.error });
    if (selectedCommand && schema) {
      return json(response, 400, {
        error: "A structured-output prompt cannot carry a command selection",
      });
    }
    // A selected command is sent as its canonical text with the arguments
    // exactly as typed; the typed `prompt` is display text only.
    const displayPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    let prompt = selectedCommand ? "" : displayPrompt;
    // Shape validation happens before the turn is claimed: a malformed
    // attachment list is a caller error, not a turn that half-started.
    let attachments;
    try {
      attachments = parsePromptAttachments(body.attachments);
    } catch (error) {
      if (!(error instanceof PromptAttachmentError)) throw error;
      return json(response, 400, { error: error.message });
    }
    if (!selectedCommand && !prompt && attachments.length === 0) {
      return json(response, 400, { error: "prompt or image attachment is required" });
    }
    if (state.subagentLimitExceeded) {
      return json(response, 409, { error: "Session exceeded the active sub-agent limit" });
    }
    if (Buffer.byteLength(requestId) > MAX_PROMPT_REQUEST_ID_BYTES)
      return json(response, 400, { error: "requestId is too long" });
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
          kind: DISPATCH_OUTCOME_LOST_KIND,
        });
      }
      if (journaled.state === "prepared") {
        return json(response, 409, { error: "Prompt dispatch is still preparing" });
      }
      return json(response, 202, { accepted: true, duplicate: true });
    }
    if (action === "compact") {
      // Existing request ids keep their journaled outcome even when the live
      // inventory no longer offers /compact. Only new work needs a selection.
      const compact = compactCommandSelection(state);
      if (!compact.ok) return json(response, 422, commandUnavailableResponse(compact.message));
      selectedCommand = compact.command;
    }
    if (state.status === "running" || state.dispatching) {
      return json(response, 409, { error: "Session is already running" });
    }
    // After the duplicate check — a retry of an accepted command must still
    // read as a duplicate even if the inventory changed since — and before
    // anything is journaled. A command the live agent no longer offers, or a
    // list only restored from disk, is refused outright: sending the text as
    // an ordinary prompt is exactly what a selection must never become.
    if (selectedCommand && state.commandsLive) {
      const resolved = resolveSelectedCommand(state, selectedCommand);
      if (!resolved.ok) return json(response, 422, commandUnavailableResponse(resolved.message));
      prompt = resolved.text;
    }
    // Claim the turn synchronously. `ensureSessionProcess` yields even on its
    // attached fast path, so a second request would otherwise pass both the
    // duplicate check and the busy check and dispatch the same prompt twice.
    // `dispatching` is separate from `status` because reattaching a detached
    // thread legitimately sets `status` back to "idle" while we hold the claim.
    state.dispatching = true;
    if (requestId)
      setPromptJournal(state, {
        requestId,
        state: "prepared",
        acceptedAt: Date.now(),
      });
    let child: AcpProcess;
    let promptContents: AcpPromptContent[];
    try {
      // Read the attachments first: an unreadable image must fail before a
      // detached thread is reattached, and it is far cheaper than a spawn.
      promptContents = await readPromptContents(attachments, workingDirectory);
      storeAgentMcp(state, body.agentMcp);
      state.workflowResultTurn = workflowResult.turn;
      if (typeof readOnly === "boolean") await setSessionReadOnly(state, readOnly);
      child = await ensureSessionProcess(state, clientSignal);
      if (
        promptContents.some((attachment) => attachment.type === "file") &&
        agentRuntime.promptCapabilities?.embeddedContext !== true
      ) {
        throw new PromptAttachmentError(
          "attachment_invalid",
          `${provider} does not advertise ACP embedded-context support`,
        );
      }
      if (
        promptContents.some((attachment) => attachment.type === "image") &&
        agentRuntime.promptCapabilities?.image !== true
      ) {
        throw new PromptAttachmentError(
          "attachment_invalid",
          `${provider} does not advertise ACP image support`,
        );
      }
      const promptPatch = parseComposerPatch(body);
      if (promptPatch) await applyComposerPatch(state, promptPatch, clientSignal);
      // Attaching can reload the session, and the agent re-announces its
      // inventory when it does. Check the selection against that list too.
      if (selectedCommand) {
        const resolved = resolveSelectedCommand(state, selectedCommand);
        if (!resolved.ok) throw new CommandUnavailableError(resolved.message);
        prompt = resolved.text;
      }
      // A close that began while this turn was still preparing owns the
      // session now; the turn must not reach the agent.
      if (state.closing) throw new HttpError(409, SESSION_CLOSING_ERROR);
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
      // Whatever failed (the fence itself, or an RPC against the child the
      // close is stopping), the turn was refused because the session is closing.
      if (state.closing) return json(response, 409, { error: SESSION_CLOSING_ERROR });
      if (error instanceof PromptAttachmentError) {
        return json(response, 400, { error: error.message });
      }
      if (error instanceof CommandUnavailableError) {
        return json(response, 422, commandUnavailableResponse(error.message));
      }
      throw error;
    }
    const userMessageId = randomBytes(12).toString("hex");
    const userVisiblePrompt = selectedCommand ? displayPrompt || prompt : prompt;
    state.messages.push({
      id: userMessageId,
      role: "user",
      content: userVisiblePrompt,
      parts: [
        ...(userVisiblePrompt
          ? [
              {
                type: "text" as const,
                content: userVisiblePrompt,
                sourcePartId: `${userMessageId}:0`,
                sourceMessageId: userMessageId,
              },
            ]
          : []),
        ...promptContents.map((attachment, index): BridgeFilePart => ({
          type: "file",
          content: attachment.filename || attachment.path,
          fileUrl: pathToFileURL(attachment.absolutePath).href,
          sourcePartId: `${userMessageId}:${index + 1}`,
          sourceMessageId: userMessageId,
        })),
      ],
      createdAt: new Date().toISOString(),
    });
    state.status = "running";
    state.error = undefined;
    state.outputTruncated = false;
    // The re-send floor spans one turn, so incremental reads stay incremental
    // across a long session. A reader that skipped every poll between a late
    // update and this prompt keeps its copy of that row until a full read.
    state.mutatedMessageFloor = undefined;
    state.promptSequence += 1;
    const promptSequence = state.promptSequence;
    state.turnStartedAt = Date.now();
    state.currentTurnUsage = {};
    state.currentAttemptUsage = {};
    state.completedAttemptUsage = undefined;
    state.currentTurnRequestId = requestId || undefined;
    state.currentTurnSawVendorUsage = false;
    state.currentTurnOutput = schema ? "" : null;
    state.revision += 1;
    boundTranscript(state);
    await persistState();
    if (state.closing) {
      // The close started during that write. The turn has not been handed to
      // the agent, so withdraw it exactly as a failed preparation would.
      if (state.messages.at(-1)?.id === userMessageId) state.messages.pop();
      state.status = "idle";
      state.dispatching = false;
      state.turnStartedAt = undefined;
      state.currentTurnUsage = undefined;
      state.currentAttemptUsage = undefined;
      state.completedAttemptUsage = undefined;
      state.currentTurnRequestId = undefined;
      state.currentTurnSawVendorUsage = undefined;
      state.currentTurnOutput = null;
      if (requestId) state.promptJournal.delete(requestId);
      state.revision += 1;
      schedulePersist();
      return json(response, 409, { error: SESSION_CLOSING_ERROR });
    }
    // Grok reports a command only once it is running, so each shell call is
    // measured from the latest snapshot; this is the turn's first one.
    await primeCommandChanges();
    beginAcpTurnEvidence(state, requestId || undefined);
    const acpPrompt = schema ? `${prompt}\n\n${structuredPromptInstruction(schema)}` : prompt;
    const promptCompletion = dispatchAcpPrompt(
      state,
      child,
      {
        sessionId: state.acpSessionId,
        prompt: [
          ...(acpPrompt ? [{ type: "text", text: acpPrompt }] : []),
          ...promptContents.map((attachment) =>
            attachment.type === "image"
              ? {
                  type: "image" as const,
                  mimeType: attachment.mimeType,
                  data: attachment.data,
                }
              : {
                  type: "resource" as const,
                  resource: {
                    uri: pathToFileURL(attachment.absolutePath).href,
                    mimeType: "text/plain",
                    text: attachment.text,
                  },
                },
          ),
        ],
      },
      promptSequence,
      schema,
    );
    // Calling the async dispatcher above synchronously writes the first
    // `session/prompt` frame before it returns its promise. Only now can the
    // journal answer an acknowledgement-recovery probe positively.
    if (requestId)
      setPromptJournal(state, {
        requestId,
        state: "accepted",
        acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
      });
    // The turn is now dispatched and `status` is "running", so the busy check
    // is authoritative again and the claim can be released.
    state.dispatching = false;
    const turnCompletion = promptCompletion.then(
      (result) => {
        const stopReason = promptStopReason(result);
        if (stopReason !== "end_turn" && stopReason !== "cancelled") {
          state.health.recordNotice({
            method: "session/prompt",
            source: "provider",
            severity: "warning",
            message: `${provider} stopped the turn with ${stopReason}`,
          });
        }
        // The dispatcher merged every attempt's response with its live usage
        // carriers. Commit that logical turn once, before clearing its clock.
        finalizeTurnUsage(state);
        rememberPendingLateTurnUsage(state, promptSequence);
        state.turnStartedAt = undefined;
        state.currentTurnUsage = undefined;
        // The attempt split stays until the next turn so a late carrier after a
        // continuation lands on the last attempt (`recordTurnUsage`).
        state.currentTurnRequestId = undefined;
        state.currentTurnSawVendorUsage = undefined;
        if (schema && requestId) {
          const output = state.currentTurnOutput?.trim() ?? "";
          if (Buffer.byteLength(output) > MAX_STRUCTURED_RESULT_BYTES) {
            setStructuredResult(state, requestId, {
              ok: false,
              provider,
              requestId,
              error: {
                code: "output_too_large",
                message: `${provider} returned too much structured output`,
                provider,
                retryable: true,
              },
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
                error: {
                  code: "malformed_output",
                  message: `${provider} returned malformed JSON`,
                  provider,
                  retryable: true,
                },
              });
            } else {
              setStructuredResult(state, requestId, { ok: true, value, provider, requestId });
            }
          }
        }
        const terminalError = turnTerminalError(state, stopReason, promptSequence);
        if (requestId)
          setPromptJournal(state, {
            requestId,
            state: state.outputTruncated ? "failed" : "completed",
            acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
            ...(terminalError ? { terminalError } : {}),
          });
        // The turn is over. A tool still in flight here was cancelled or abandoned
        // by the agent — ACP has no status for that, so settle it explicitly.
        reconcileStaleToolParts(state);
        settleCommandChangeWindows(state);
        endAcpTurnEvidence(
          state,
          stopReason === "cancelled"
            ? "cancelled"
            : terminalError || state.outputTruncated
              ? "failed"
              : "succeeded",
        );
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
      },
      (error: unknown) => {
        state.status = "error";
        state.error = error instanceof Error ? error.message : String(error);
        finalizeTurnUsage(state);
        state.turnStartedAt = undefined;
        state.currentTurnUsage = undefined;
        state.currentAttemptUsage = undefined;
        state.completedAttemptUsage = undefined;
        state.currentTurnRequestId = undefined;
        state.currentTurnSawVendorUsage = undefined;
        // A turn that failed gets no final pass, so a live timer armed moments
        // before the failure has nothing left to complete. Drop it here for the
        // same reason `DELETE` and `shutdown` do: enrichment is display-only
        // background work, and nothing should outlive the turn that asked for it.
        cancelCursorToolMetadataReconcile(state);
        reconcileStaleToolParts(state, true);
        settleCommandChangeWindows(state);
        endAcpTurnEvidence(state, "failed");
        if (requestId)
          setPromptJournal(state, {
            requestId,
            state: "failed",
            acceptedAt: state.promptJournal.get(requestId)?.acceptedAt ?? Date.now(),
          });
        state.currentTurnOutput = null;
        state.revision += 1;
        schedulePersist();
      },
    );
    // What close awaits after `session/cancel`: the turn's own bookkeeping has
    // run, whichever way the prompt ended. Owning the rejection here also keeps
    // a throwing completion handler from becoming an unhandled rejection.
    state.turnSettlement = turnCompletion.then(
      () => undefined,
      () => undefined,
    );
    return json(response, 202, { accepted: true });
  }
  if ((action === "cancel" || action === "abort") && request.method === "POST") {
    // Fail closed, exactly as close does: every request parked on a person —
    // permission, Grok question and plan approval — is answered with its
    // cancel outcome. Denying only permissions left a question or plan card
    // actionable against a turn the user had already stopped.
    denyPendingRequests(state);
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
  if (action === "close" && request.method === "POST") {
    // Ordinary tab close: release this session, keep the vendor conversation.
    return (await closeSessionRetaining(state)) === "closed"
      ? json(response, 200, { closed: true, retained: true })
      : json(response, 503, {
          closed: false,
          pending: true,
          error: "Session close did not complete",
        });
  }
  if (!action && request.method === "DELETE") {
    // DELETE is the legacy release (vendor history is kept either way). Racing
    // a close, it joins that close rather than tearing down underneath it.
    if (state.closing) {
      return (await closeSessionRetaining(state)) === "closed"
        ? json(response, 200, { deleted: true })
        : json(response, 503, { error: "Session close did not complete" });
    }
    denyPendingRequests(state);
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
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function requestPathname(request: IncomingMessage): string {
  try {
    return new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname;
  } catch {
    return "";
  }
}

export function applyOriginPolicy(request: IncomingMessage, response: ServerResponse): boolean {
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
  response.writeHead(
    204,
    unauthenticatedRoute
      ? {}
      : {
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": `Content-Type, Authorization, ${ACP_TOKEN_HEADER}`,
          "Access-Control-Allow-Private-Network": "true",
        },
  );
  response.end();
  return false;
}

/** A percent-decoded path segment, or undefined when its escapes are malformed. */
function decodePathSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** The longest `requestId` the prompt route journals; a longer one is refused. */
const MAX_PROMPT_REQUEST_ID_BYTES = 512;

/**
 * Whether `/dispatch` may answer `absent` for an id the journal has no entry
 * for. The id must be one the prompt route would journal unchanged (it trims
 * and caps ids), or "no entry" would be about a different id.
 */
function promptJournalProvesAbsent(state: SessionState, requestId: string): boolean {
  return (
    state.promptJournalComplete === true &&
    !state.closing &&
    requestId.length > 0 &&
    requestId === requestId.trim() &&
    Buffer.byteLength(requestId) <= MAX_PROMPT_REQUEST_ID_BYTES
  );
}

function storeAgentMcp(state: SessionState, value: unknown): void {
  const parsed = parseAgentMcpConnection(value);
  if (parsed) state.agentMcp = parsed;
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
  const vary =
    typeof existingVary === "string" && existingVary.trim()
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
  // A 413 is answered before the request body has been read. Reusing the
  // connection would leave those unread bytes in the keep-alive stream, and
  // Bun 1.4.3 keeps server.close() waiting on such a connection.
  if (status === 413) response.setHeader("connection", "close");
  const body = Buffer.from(JSON.stringify(value));
  const shouldCompress =
    body.byteLength >= 1024 &&
    (response as ServerResponse & { [RESPONSE_ACCEPTS_GZIP]?: boolean })[RESPONSE_ACCEPTS_GZIP] ===
      true;
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
