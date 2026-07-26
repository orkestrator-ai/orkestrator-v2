import type { EngineGeneration } from "../engine/types.js";

export type InteractionMethod =
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request";

export type InteractionResolution =
  | "answered"
  | "declined"
  | "cancelled"
  | "timed-out"
  | "engine-restarted"
  | "session-closed";

export interface InteractionOption {
  label: string;
  description?: string;
}

export interface InteractionQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: InteractionOption[];
}

export interface InteractionRequest {
  interactionId: string;
  kind: "question" | "mcp-form" | "mcp-url";
  method: InteractionMethod;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  generation: EngineGeneration;
  requestedAt: number;
  expiresAt: number;
  autoResolutionMs?: number;
  questions?: InteractionQuestion[];
  serverName?: string;
  message?: string;
  schema?: unknown;
  url?: string;
  elicitationId?: string;
}

export type InteractionAnswer =
  | {
      action: "accept";
      answers?: Record<string, string[]>;
      content?: unknown;
      meta?: unknown;
    }
  | { action: "decline" | "cancel"; meta?: unknown };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function describeInteraction(options: {
  interactionId: string;
  method: InteractionMethod;
  params: unknown;
  generation: EngineGeneration;
  requestedAt: number;
  defaultExpiresAt: number;
}): InteractionRequest | null {
  const params = record(options.params);
  const threadId = text(params.threadId);
  if (!threadId) return null;
  const turnId = text(params.turnId) ?? null;

  if (options.method === "item/tool/requestUserInput") {
    const autoResolutionMs =
      typeof params.autoResolutionMs === "number" && params.autoResolutionMs > 0
        ? params.autoResolutionMs
        : undefined;
    const questions = Array.isArray(params.questions)
      ? params.questions.flatMap((raw) => {
          const question = record(raw);
          const id = text(question.id);
          const prompt = text(question.question);
          if (!id || !prompt) return [];
          const rawOptions = Array.isArray(question.options) ? question.options : [];
          const parsedOptions = rawOptions.flatMap((rawOption) => {
            const option = record(rawOption);
            const label = text(option.label);
            return label
              ? [{ label, ...(text(option.description) ? { description: text(option.description) } : {}) }]
              : [];
          });
          return [{
            id,
            header: text(question.header) ?? "Question",
            question: prompt,
            isOther: question.isOther === true,
            isSecret: question.isSecret === true,
            ...(parsedOptions.length > 0 ? { options: parsedOptions } : {}),
          }];
        })
      : [];
    if (questions.length === 0) return null;
    return {
      interactionId: options.interactionId,
      kind: "question",
      method: options.method,
      threadId,
      turnId,
      itemId: text(params.itemId) ?? null,
      generation: options.generation,
      requestedAt: options.requestedAt,
      expiresAt: autoResolutionMs
        ? Math.min(options.defaultExpiresAt, options.requestedAt + autoResolutionMs)
        : options.defaultExpiresAt,
      ...(autoResolutionMs ? { autoResolutionMs } : {}),
      questions,
    };
  }

  const mode = params.mode;
  if (mode !== "form" && mode !== "openai/form" && mode !== "url") return null;
  return {
    interactionId: options.interactionId,
    kind: mode === "url" ? "mcp-url" : "mcp-form",
    method: options.method,
    threadId,
    turnId,
    itemId: null,
    generation: options.generation,
    requestedAt: options.requestedAt,
    expiresAt: options.defaultExpiresAt,
    serverName: text(params.serverName),
    message: text(params.message),
    ...(mode === "url"
      ? {
          url: text(params.url),
          elicitationId: text(params.elicitationId),
        }
      : { schema: params.requestedSchema }),
  };
}

export function buildInteractionResponse(
  request: InteractionRequest,
  answer: InteractionAnswer,
): unknown {
  if (request.kind === "question") {
    if (answer.action !== "accept") return { answers: {} };
    return {
      answers: Object.fromEntries(
        Object.entries(answer.answers ?? {}).map(([id, answers]) => [
          id,
          { answers },
        ]),
      ),
    };
  }
  return {
    action: answer.action,
    content: answer.action === "accept" ? answer.content ?? {} : null,
    _meta: answer.meta ?? null,
  };
}
