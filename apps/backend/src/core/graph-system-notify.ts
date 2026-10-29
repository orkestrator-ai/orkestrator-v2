/**
 * `notify` (plan P2.7): agent mail from the run to the project's
 * coordinator or a tab of the run's environment, sent as a workflow notice
 * (`{kind: "system", source: "workflow", resourceId: <run id>}`), as the
 * backend's other workflow notices are.
 *
 * One message per run, node, iteration and branch: the mail's request id is
 * derived from them, so agent mail's own idempotency turns a repeated send
 * (a retry, a restart, a crash after sending) into a replay of the first
 * message, and the effect journal (`notify:<slot>`) records its id. A
 * `text@1` or `markdown@1` input is appended to the message; the body is held
 * to agent mail's 32 KiB.
 */
import { createHash } from "node:crypto";
import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import { COORDINATOR_MAIL_ADDRESS } from "@orkestrator/protocol/coordinator";
import { GraphSystemActionError, type GraphSystemActionHandler } from "./graph-system-action.js";

/** Agent mail's body cap. */
const MAX_BODY_BYTES = 32 * 1024;
const TRUNCATED = "\n\n(truncated)";

function boundBody(body: string): string {
  if (Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES) return body;
  const room = MAX_BODY_BYTES - Buffer.byteLength(TRUNCATED, "utf8");
  return `${Buffer.from(body, "utf8").subarray(0, room).toString("utf8").replace(/�+$/, "")}${TRUNCATED}`;
}

/** The mail request id of an activation slot (agent mail allows 256 characters). */
export function graphNotifyRequestId(runId: string, slot: string): string {
  const hash = createHash("sha256").update(`${runId}\0${slot}`).digest("hex").slice(0, 32);
  return `graph-notify:${hash}`;
}

export const notifyAction: GraphSystemActionHandler = {
  action: "notify",
  async run(ctx) {
    const message = typeof ctx.params.message === "string" ? ctx.params.message : "";
    const subject = typeof ctx.params.subject === "string" ? ctx.params.subject : undefined;
    const toTab = ctx.params.to === "tab";
    const tabId = typeof ctx.params.tabId === "string" ? ctx.params.tabId : "";
    const text = await ctx.input<{ text: string }>("text@1");
    const markdown = await ctx.input<{ markdown: string }>("markdown@1");
    const body = boundBody(
      [message, text?.text, markdown?.markdown].filter((part) => part && part.trim()).join("\n\n"),
    );
    await ctx.effect(ctx.slotKey(), async () => {
      try {
        const sent = await ctx.deps.storage.sendAgentMail(
          {
            kind: "system",
            projectId: ctx.run.projectId,
            source: "workflow",
            resourceId: ctx.run.id,
          },
          {
            requestId: graphNotifyRequestId(ctx.run.id, ctx.slot),
            toEnvironmentId: toTab ? ctx.environmentId : COORDINATOR_MAIL_ADDRESS,
            toTabId: toTab ? tabId : "",
            ...(subject ? { subject } : {}),
            body,
          },
        );
        return { messageId: sent.id };
      } catch (error) {
        if (error instanceof AgentMailError) {
          throw new GraphSystemActionError(`Agent mail refused the message (${error.code})`);
        }
        throw error;
      }
    });
  },
};
