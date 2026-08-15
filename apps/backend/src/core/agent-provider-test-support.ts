import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { TaskSnapshotImage } from "@orkestrator/protocol/build-pipeline";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import {
  createNativeAgentProvider,
  type BridgeConnection,
  type ProviderDependencies,
} from "./native-agent-provider.js";
import { mimeTypeForFilename } from "./prompt-attachments.js";

export const claudeConnection: BridgeConnection = {
  agent: "claude",
  baseUrl: "http://claude.test",
  authToken: "test-token",
  requestTimeoutMs: 25,
};

/** Mirrors `MAX_BODY_BYTES` in `bridges/acp-bridge/src/index.ts`. */
export const ACP_BRIDGE_MAX_BODY_BYTES = 2 * 1024 * 1024;

export type RequestRecord = {
  url: string;
  init: RequestInit;
};

export const codexConnection: BridgeConnection = {
  agent: "codex",
  baseUrl: "http://codex.test",
  authToken: "codex-token",
  model: "gpt-5-codex",
  effort: "high",
  requestTimeoutMs: 25,
};

export const cursorConnection: BridgeConnection = {
  agent: "cursor",
  baseUrl: "http://cursor.test",
  authToken: "cursor-token",
  requestTimeoutMs: 25,
};

export const grokConnection: BridgeConnection = {
  agent: "grok",
  baseUrl: "http://grok.test",
  authToken: "grok-token",
  requestTimeoutMs: 25,
};

export function httpProvider(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  connection: BridgeConnection = claudeConnection,
  options: { stageImages?: boolean } = {},
) {
  const requests: RequestRecord[] = [];
  const staged: TaskSnapshotImage[][] = [];
  const provider = createNativeAgentProvider(connection, {
    fetch: (async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
    stageImages: options.stageImages === false
      ? undefined
      : async (images) => {
          staged.push([...images]);
          return images.map((image) => ({
            type: "image" as const,
            path: `/workspace/.orkestrator/initial-prompt/${image.filename}`,
            filename: image.filename,
            dataUrl:
              `data:${mimeTypeForFilename(image.filename)};base64,${image.data}`,
          }));
        },
  });
  return { provider, requests, staged };
}

export function waitUntil(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (assertion()) {
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        reject(new Error("Timed out waiting for provider activity"));
      } else {
        setTimeout(check, 1);
      }
    };
    check();
  });
}

export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function expectedOpenCodeMessageId(requestId: string): string {
  const encoded = Array.from(
    { length: requestId.length },
    (_, index) => requestId.charCodeAt(index).toString(16).padStart(4, "0"),
  ).join("");
  return `msg_00000000000000000000000000_ork_${encoded}`;
}

export function declineResolution(request: AgentInteractionRequest): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: request.id,
    sessionId: request.sessionId,
    action: "decline",
    resolvedAt: Math.max(Date.now(), request.createdAt),
  };
}

export function answerResolution(request: AgentInteractionRequest): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: request.id,
    sessionId: request.sessionId,
    action: "answer",
    resolvedAt: Math.max(Date.now(), request.createdAt),
    answer: {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      interactionId: request.id,
      sessionId: request.sessionId,
      answers: request.presentation.questions.map((question) => ({
        questionId: question.id,
        ...(question.options[0]
          ? { optionIds: [question.options[0].id] }
          : { freeText: "safe answer" }),
      })),
    },
  };
}

export function freeTextResolution(
  request: AgentInteractionRequest,
  value: string,
): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: request.id,
    sessionId: request.sessionId,
    action: "answer",
    resolvedAt: Math.max(Date.now(), request.createdAt),
    answer: {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      interactionId: request.id,
      sessionId: request.sessionId,
      answers: [{
        questionId: request.presentation.questions[0]!.id,
        freeText: value,
      }],
    },
  };
}

export type EventHarness = {
  stream: AsyncIterable<unknown>;
  push(value: unknown): void;
  close(): void;
};

export function eventHarness(signal: AbortSignal): EventHarness {
  const queued: unknown[] = [];
  const waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  };
  // A signal that was already aborted before subscribe() ran never fires the
  // event, so listening alone would leave the stream open forever and hang the
  // dispose() that did the aborting. A real SSE client rejects outright here.
  if (signal.aborted) closed = true;
  signal.addEventListener("abort", close, { once: true });
  return {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (queued.length > 0) {
              return Promise.resolve({ done: false, value: queued.shift() });
            }
            if (closed) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
    push(value) {
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else queued.push(value);
    },
    close,
  };
}

export type OpenCodeFake = {
  abortCalls: Array<Record<string, unknown> | undefined>;
  createCalls: Array<Record<string, unknown> | undefined>;
  messageCalls: Array<Record<string, unknown> | undefined>;
  promptCalls: Array<Record<string, unknown>>;
  commandDispatchCalls: Array<Record<string, unknown>>;
  commandListCalls: Array<Record<string, unknown> | undefined>;
  setCommandListResponse(response: { data?: unknown[] }): void;
  setPromptError(error: unknown): void;
  setPromptGate(gate: Promise<void> | null): void;
  client: OpencodeClient;
  readonly permissionListCallCount: number;
  permissionListCalls: Array<Record<string, unknown> | undefined>;
  permissionReplies: Array<Record<string, unknown>>;
  readonly questionListCallCount: number;
  questionListCalls: Array<Record<string, unknown> | undefined>;
  questionRejections: Array<Record<string, unknown>>;
  questionReplies: Array<Record<string, unknown>>;
  readonly statusCallCount: number;
  statusCalls: Array<Record<string, unknown> | undefined>;
  statusOptions: Array<{ signal?: AbortSignal } | undefined>;
  readonly sessionGetCallCount: number;
  sessionGetCalls: Array<Record<string, unknown>>;
  sessionGetOptions: Array<{ signal?: AbortSignal } | undefined>;
  readonly sessionListCallCount: number;
  sessionListCalls: Array<Record<string, unknown> | undefined>;
  sessionListOptions: Array<{ signal?: AbortSignal } | undefined>;
  readonly subscribeCallCount: number;
  subscriptions: EventHarness[];
  setPending(
    permissions: Array<Record<string, unknown>>,
    questions: Array<Record<string, unknown>>,
  ): void;
  setPendingReadGate(gate: Promise<void> | null): void;
  setPendingReadResponses(
    permissions: Record<string, unknown> | null,
    questions: Record<string, unknown> | null,
  ): void;
  setPendingReadErrors(
    permissions: unknown | null,
    questions: unknown | null,
  ): void;
  setPermissionReplyResponse(response: Record<string, unknown>): void;
  setQuestionRejectResponse(response: Record<string, unknown>): void;
  setQuestionReplyResponse(response: Record<string, unknown>): void;
  setQuestionReplyGate(gate: Promise<void>): void;
  setQuestionReplyFailure(error: unknown, applied: boolean): void;
  setSubscribeFailures(failures: Array<"throw" | "missing-stream">): void;
  setMessagesResponse(response: Record<string, unknown>): void;
  setMessagesHandler(
    handler: ((parameters?: Record<string, unknown>) => Promise<Record<string, unknown>>) | null,
  ): void;
  setAbortResponse(response: Record<string, unknown>): void;
  setCreateResponse(response: Record<string, unknown>): void;
  setPromptResponse(response: Record<string, unknown>): void;
  setStatusError(error: unknown): void;
  setStatusResponse(response: Record<string, unknown>): void;
  setSessionListError(error: unknown): void;
  setSessionListResponse(response: Record<string, unknown>): void;
  setSessionGetError(error: unknown): void;
  setSessionGetResponse(
    sessionId: string,
    response: Record<string, unknown>,
  ): void;
};

export function openCodeFake(): OpenCodeFake {
  const abortCalls: Array<Record<string, unknown> | undefined> = [];
  const createCalls: Array<Record<string, unknown> | undefined> = [];
  const messageCalls: Array<Record<string, unknown> | undefined> = [];
  const permissionReplies: Array<Record<string, unknown>> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  const commandDispatchCalls: Array<Record<string, unknown>> = [];
  const commandListCalls: Array<Record<string, unknown> | undefined> = [];
  let commandListResponse: { data?: unknown[] } = { data: [] };
  let promptError: unknown = null;
  let promptGate: Promise<void> | null = null;
  const questionRejections: Array<Record<string, unknown>> = [];
  const questionReplies: Array<Record<string, unknown>> = [];
  const subscriptions: EventHarness[] = [];
  let subscribeCallCount = 0;
  let subscribeFailures: Array<"throw" | "missing-stream"> = [];
  let permissionListCallCount = 0;
  let questionListCallCount = 0;
  const permissionListCalls: Array<Record<string, unknown> | undefined> = [];
  const questionListCalls: Array<Record<string, unknown> | undefined> = [];
  let pendingPermissions: Array<Record<string, unknown>> = [];
  let pendingQuestions: Array<Record<string, unknown>> = [];
  let pendingReadGate: Promise<void> | null = null;
  let permissionListResponse: Record<string, unknown> | null = null;
  let questionListResponse: Record<string, unknown> | null = null;
  let permissionListError: unknown = null;
  let questionListError: unknown = null;
  let permissionReplyResponse: Record<string, unknown> = { data: true };
  let questionRejectResponse: Record<string, unknown> = { data: true };
  let questionReplyResponse: Record<string, unknown> = { data: true };
  let questionReplyGate: Promise<void> = Promise.resolve();
  let questionReplyFailure: { error: unknown; applied: boolean } | null = null;
  let messagesResponse: Record<string, unknown> = { data: [] };
  let messagesHandler:
    ((parameters?: Record<string, unknown>) => Promise<Record<string, unknown>>)
    | null = null;
  let abortResponse: Record<string, unknown> = { data: true };
  let createResponse: Record<string, unknown> = { data: { id: "owned-session" } };
  let promptResponse: Record<string, unknown> = { data: true };
  let statusError: unknown = null;
  const statusCalls: Array<Record<string, unknown> | undefined> = [];
  const statusOptions: Array<{ signal?: AbortSignal } | undefined> = [];
  let statusResponse: Record<string, unknown> = {
    data: { "owned-session": { type: "idle" } },
  };
  let sessionListError: unknown = null;
  const sessionListCalls: Array<Record<string, unknown> | undefined> = [];
  const sessionListOptions: Array<{ signal?: AbortSignal } | undefined> = [];
  let sessionListResponse: Record<string, unknown> = {
    data: [{ id: "owned-session" }],
  };
  let sessionGetError: unknown = null;
  const sessionGetCalls: Array<Record<string, unknown>> = [];
  const sessionGetOptions: Array<{ signal?: AbortSignal } | undefined> = [];
  const sessionGetResponses = new Map<string, Record<string, unknown>>();

  const client = {
    event: {
      async subscribe(
        _parameters: unknown,
        options: { signal: AbortSignal },
      ) {
        subscribeCallCount += 1;
        const failure = subscribeFailures.shift();
        if (failure === "throw") throw new Error("subscribe failed");
        if (failure === "missing-stream") return { data: true };
        const harness = eventHarness(options.signal);
        subscriptions.push(harness);
        return { stream: harness.stream };
      },
    },
    permission: {
      async list(parameters?: Record<string, unknown>) {
        permissionListCallCount += 1;
        permissionListCalls.push(parameters);
        await pendingReadGate;
        if (permissionListError) throw permissionListError;
        return permissionListResponse ?? { data: pendingPermissions };
      },
      async reply(parameters: Record<string, unknown>) {
        permissionReplies.push(parameters);
        if (!permissionReplyResponse.error) {
          pendingPermissions = pendingPermissions.filter(
            ({ id }) => id !== parameters.requestID,
          );
        }
        return permissionReplyResponse;
      },
    },
    question: {
      async list(parameters?: Record<string, unknown>) {
        questionListCallCount += 1;
        questionListCalls.push(parameters);
        await pendingReadGate;
        if (questionListError) throw questionListError;
        return questionListResponse ?? { data: pendingQuestions };
      },
      async reject(parameters: Record<string, unknown>) {
        questionRejections.push(parameters);
        if (!questionRejectResponse.error) {
          pendingQuestions = pendingQuestions.filter(
            ({ id }) => id !== parameters.requestID,
          );
        }
        return questionRejectResponse;
      },
      async reply(parameters: Record<string, unknown>) {
        questionReplies.push(parameters);
        await questionReplyGate;
        if (questionReplyFailure) {
          if (questionReplyFailure.applied) {
            pendingQuestions = pendingQuestions.filter(
              ({ id }) => id !== parameters.requestID,
            );
          }
          throw questionReplyFailure.error;
        }
        if (!questionReplyResponse.error) {
          pendingQuestions = pendingQuestions.filter(
            ({ id }) => id !== parameters.requestID,
          );
        }
        return questionReplyResponse;
      },
    },
    session: {
      async create(parameters?: Record<string, unknown>) {
        createCalls.push(parameters);
        return createResponse;
      },
      async promptAsync(parameters: Record<string, unknown>) {
        promptCalls.push(parameters);
        await promptGate;
        if (promptError) throw promptError;
        return promptResponse;
      },
      async status(
        parameters?: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) {
        statusCalls.push(parameters);
        statusOptions.push(options);
        if (statusError) throw statusError;
        return statusResponse;
      },
      async list(
        parameters?: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) {
        sessionListCalls.push(parameters);
        sessionListOptions.push(options);
        if (sessionListError) throw sessionListError;
        return sessionListResponse;
      },
      async get(
        parameters: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) {
        sessionGetCalls.push(parameters);
        sessionGetOptions.push(options);
        if (sessionGetError) throw sessionGetError;
        const sessionId = String(parameters.sessionID ?? "");
        return sessionGetResponses.get(sessionId)
          ?? (sessionId === "owned-session"
            ? { data: { id: sessionId, directory: "/workspace" } }
            : { error: { name: "NotFound" }, response: { status: 404 } });
      },
      async messages(parameters?: Record<string, unknown>) {
        messageCalls.push(parameters);
        if (messagesHandler) return messagesHandler(parameters);
        return messagesResponse;
      },
      async abort(parameters?: Record<string, unknown>) {
        abortCalls.push(parameters);
        return abortResponse;
      },
      async command(parameters: Record<string, unknown>) {
        commandDispatchCalls.push(parameters);
        return promptResponse;
      },
    },
    command: {
      async list(parameters?: Record<string, unknown>) {
        commandListCalls.push(parameters);
        return commandListResponse;
      },
    },
  } as unknown as OpencodeClient;

  return {
    abortCalls,
    client,
    commandDispatchCalls,
    commandListCalls,
    setCommandListResponse(response: { data?: unknown[] }) {
      commandListResponse = response;
    },
    createCalls,
    messageCalls,
    get permissionListCallCount() {
      return permissionListCallCount;
    },
    permissionListCalls,
    permissionReplies,
    promptCalls,
    get questionListCallCount() {
      return questionListCallCount;
    },
    questionListCalls,
    questionRejections,
    questionReplies,
    get statusCallCount() {
      return statusCalls.length;
    },
    statusCalls,
    statusOptions,
    get sessionGetCallCount() {
      return sessionGetCalls.length;
    },
    sessionGetCalls,
    sessionGetOptions,
    get sessionListCallCount() {
      return sessionListCalls.length;
    },
    sessionListCalls,
    sessionListOptions,
    get subscribeCallCount() {
      return subscribeCallCount;
    },
    subscriptions,
    setPromptError(error: unknown) {
      promptError = error;
    },
    setPromptGate(gate) {
      promptGate = gate;
    },
    setPending(permissions, questions) {
      pendingPermissions = permissions;
      pendingQuestions = questions;
    },
    setPendingReadGate(gate) {
      pendingReadGate = gate;
    },
    setPendingReadResponses(permissions, questions) {
      permissionListResponse = permissions;
      questionListResponse = questions;
    },
    setPendingReadErrors(permissions, questions) {
      permissionListError = permissions;
      questionListError = questions;
    },
    setPermissionReplyResponse(response) {
      permissionReplyResponse = response;
    },
    setQuestionRejectResponse(response) {
      questionRejectResponse = response;
    },
    setQuestionReplyResponse(response) {
      questionReplyResponse = response;
    },
    setQuestionReplyGate(gate) {
      questionReplyGate = gate;
    },
    setQuestionReplyFailure(error, applied) {
      questionReplyFailure = { error, applied };
    },
    setSubscribeFailures(failures) {
      subscribeFailures = [...failures];
    },
    setMessagesResponse(response) {
      messagesResponse = response;
    },
    setMessagesHandler(handler) {
      messagesHandler = handler;
    },
    setAbortResponse(response) {
      abortResponse = response;
    },
    setCreateResponse(response) {
      createResponse = response;
    },
    setPromptResponse(response) {
      promptResponse = response;
    },
    setStatusError(error) {
      statusError = error;
    },
    setStatusResponse(response) {
      statusResponse = response;
    },
    setSessionListError(error) {
      sessionListError = error;
    },
    setSessionListResponse(response) {
      sessionListResponse = response;
    },
    setSessionGetError(error) {
      sessionGetError = error;
    },
    setSessionGetResponse(sessionId, response) {
      sessionGetResponses.set(sessionId, response);
    },
  };
}

export function openCodeProvider(
  fake: OpenCodeFake,
  monitorRetryMs = 1,
  messageIds = new OpenCodeMessageIdCoordinator(),
) {
  return createNativeAgentProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    {
      openCodeClient: fake.client,
      openCodeMessageIdCoordinator: messageIds,
      monitorRetryMs,
      // Exercises the isolated compatibility responder. Production providers
      // default this off and unattended callers use the common journaled resolver.
      autoAnswerRequests: true,
    },
  );
}

export function openCodeActivityProvider(
  fake: OpenCodeFake,
  dependencies: Pick<
    ProviderDependencies,
    "now" | "openCodeExistenceCacheTtlMs" | "resolveOpenCodeModelProviders"
  > = {},
) {
  return createNativeAgentProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    {
      openCodeClient: fake.client,
      openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      autoAnswerRequests: false,
      ...dependencies,
    },
  );
}
