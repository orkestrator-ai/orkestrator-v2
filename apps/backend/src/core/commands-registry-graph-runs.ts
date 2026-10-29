import {
  GRAPH_AGENT_ANSWER_KINDS,
  GRAPH_AGENT_QUESTION_BOUNDS,
} from "@orkestrator/protocol/graphs/run";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { GraphAgentQuestionError, type GraphAgentQuestions } from "./graph-agent-questions.js";
import { GraphRunServiceError } from "./graph-run-service.js";

/**
 * Graph run commands that act on one waiting activation (item 204; the human
 * nodes of item 208 share the answer surface). `graph_run_answer` answers an
 * agent's `ask_human` question:
 *
 * `{ runId, activationKey, questionId, kind: "answered" | "declined", text?, choice? }`
 *
 * It returns the activation's stored question. A stale (another or an
 * already answered question), malformed or oversized answer is refused with
 * a `GraphAgentQuestionError` (`invalid-answer`) and never reaches the agent.
 */

function questions(context: CommandContext): GraphAgentQuestions {
  if (!context.graphQuestions) {
    throw new GraphAgentQuestionError("not-found", "Graph runs are unavailable");
  }
  return context.graphQuestions;
}

function invalid(message: string): never {
  throw new GraphAgentQuestionError("invalid-answer", message);
}

function stringArg(
  value: unknown,
  name: string,
  max: number,
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) invalid(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    invalid(`${name} must be a string of 1 to ${max} characters`);
  }
  return value;
}

export function registerGraphRunCommands(register: CommandRegistrar): void {
  register("graph_run_answer", async (args, context) => {
    const allowed = ["runId", "activationKey", "questionId", "kind", "text", "choice"];
    const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) invalid(`Unknown arguments: ${unknown.slice(0, 5).join(", ")}`);
    const runId = stringArg(args.runId, "runId", 128, true)!;
    const activationKey = stringArg(args.activationKey, "activationKey", 256, true)!;
    const questionId = stringArg(args.questionId, "questionId", 64, true)!;
    const kind = args.kind;
    if (
      typeof kind !== "string" ||
      !(GRAPH_AGENT_ANSWER_KINDS as readonly string[]).includes(kind)
    ) {
      invalid(`kind must be one of ${GRAPH_AGENT_ANSWER_KINDS.join(", ")}`);
    }
    const text = stringArg(args.text, "text", GRAPH_AGENT_QUESTION_BOUNDS.maxAnswerChars, false);
    const choice = stringArg(
      args.choice,
      "choice",
      GRAPH_AGENT_QUESTION_BOUNDS.maxChoiceChars,
      false,
    );
    try {
      const activation = await questions(context).answer(
        { runId, activationKey },
        {
          questionId,
          kind: kind as (typeof GRAPH_AGENT_ANSWER_KINDS)[number],
          ...(text !== undefined ? { text } : {}),
          ...(choice !== undefined ? { choice } : {}),
        },
        "user",
      );
      return { activationKey: activation.key, question: activation.session?.question ?? null };
    } catch (error) {
      if (error instanceof GraphRunServiceError) {
        throw new GraphAgentQuestionError(
          error.code === "not-found" ? "not-found" : "invalid-answer",
          error.message,
        );
      }
      throw error;
    }
  });
}
