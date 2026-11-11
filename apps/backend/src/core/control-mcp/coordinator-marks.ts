import type { McpServer } from "@modelcontextprotocol/server";
import { coordinatorActionMark } from "@orkestrator/protocol/coordinator";
import { str, strictObject, toolInput } from "../tool-schema.js";
import { toolResult } from "./tool-support.js";

/** The provider persists the successful tool call with its input and result in
 * the conversation rollout. Replaying the transcript reconstructs the marks
 * without a second renderer-owned store or a second write to reconcile. */
export function registerCoordinatorMarkTools(server: McpServer): void {
  for (const kind of ["topic", "question"] as const) {
    server.registerTool(
      `mark_${kind}`,
      {
        title: kind === "topic" ? "Mark a new conversation topic" : "Mark a question for the user",
        description:
          kind === "topic"
            ? "Mark the current user's new subject with a short title. Once per user message; not for follow-ups."
            : "Mark a plain-text question you asked that needs the user's answer. The next user message handles it.",
        inputSchema: toolInput(strictObject({ title: str({ trim: true, min: 1, max: 120 }) })),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ title }) => toolResult({ coordinatorAction: coordinatorActionMark(kind, title) }),
    );
  }
}
