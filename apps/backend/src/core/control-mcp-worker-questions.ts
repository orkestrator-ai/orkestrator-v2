import type { McpServer } from "@modelcontextprotocol/server";
import { WORKER_QUESTION_RELAY_LIMITS } from "@orkestrator/protocol/worker-question-relay";
import { z } from "zod";
import { toolResult, type JsonRecord } from "./control-mcp-tool-support.js";

/**
 * `answer_worker_question`: the main coordinator proposes an answer to a
 * question a worker is waiting on (see `worker-question-relay.ts`). It only
 * creates a request; the user confirms, edits or declines it in Orkestrator,
 * and only that approval answers the worker. Capability `environments`, so
 * never a side agent.
 */

export const WORKER_QUESTION_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ["answer_worker_question", "environments"],
];

const limits = WORKER_QUESTION_RELAY_LIMITS;

export function registerWorkerQuestionTools(
  server: McpServer,
  call: (command: string, args: JsonRecord) => Promise<JsonRecord>,
): void {
  server.registerTool(
    "answer_worker_question",
    {
      title: "Propose an answer to a worker's question for the user to confirm",
      description:
        "Propose an answer to a question a worker of this project is waiting on (an interaction of kind question in get_tab_state's state.interactions; pass its id as interactionId). You answer nothing: the user sees the question, its options and your answer in Orkestrator, may change it, and approves or declines; only an approval answers the worker. Answer in the question's own shape: for each question its questionId with the chosen optionIds (one for a single-choice question) and/or freeText where the question allows it. Approvals and permissions (commands, files, plans, tool use), forms, links and secret questions are refused: the user handles those in the worker's tab. If the question is answered in the tab or its turn ends first, nothing is sent. Pass nodeId for a worker on another connected node. You are woken by mail with the outcome.",
      inputSchema: z
        .object({
          requestId: z
            .string()
            .trim()
            .min(1)
            .max(256)
            .describe("Stable key for this proposal; reuse it only to retry the same call."),
          environmentId: z.string().trim().min(1).max(200),
          tabId: z.string().trim().min(1).max(200),
          interactionId: z.string().trim().min(1).max(limits.idChars),
          answers: z
            .array(
              z
                .object({
                  questionId: z.string().min(1).max(limits.idChars),
                  optionIds: z
                    .array(z.string().min(1).max(limits.idChars))
                    .max(limits.options)
                    .optional(),
                  freeText: z.string().max(limits.freeTextChars).optional(),
                })
                .strict(),
            )
            .min(1)
            .max(limits.questions),
          reason: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .describe("Why this answer, shown to the user beside it."),
          nodeId: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe("The worker's nodeId from list_nodes; omit for this node."),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      toolResult({
        ...(await call("request_coordinator_worker_answer", { input })),
        delivery: "async",
        wake: "You will be woken by mail when the user approves, edits and approves, or declines, or when the question was gone by then. Nothing has been answered yet.",
        nextStep: "Finish your turn now. Do not poll.",
      }),
  );
}
