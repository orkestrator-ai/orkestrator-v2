import type { TaskSnapshotImage } from "@orkestrator/protocol/build-pipeline";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { createNativeAgentProvider, type BridgeConnection } from "./native-agent-provider.js";
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

export const piConnection: BridgeConnection = {
  agent: "pi",
  baseUrl: "http://pi.test",
  authToken: "pi-token",
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
    stageImages:
      options.stageImages === false
        ? undefined
        : async (images) => {
            staged.push([...images]);
            return images.map((image) => ({
              type: "image" as const,
              path: `/workspace/.orkestrator/initial-prompt/${image.filename}`,
              filename: image.filename,
              dataUrl: `data:${mimeTypeForFilename(image.filename)};base64,${image.data}`,
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
  const encoded = Array.from({ length: requestId.length }, (_, index) =>
    requestId.charCodeAt(index).toString(16).padStart(4, "0"),
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
      answers: [
        {
          questionId: request.presentation.questions[0]!.id,
          freeText: value,
        },
      ],
    },
  };
}
