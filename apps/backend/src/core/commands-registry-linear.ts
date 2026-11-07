import {
  connectLinearCommand,
  disconnectLinearCommand,
  getLinearConnectionCommand,
  getLinearIssueCommand,
  getLinearIssuesCommand,
  postLinearCompletionCommentCommand,
  postLinearIssueCommentCommand,
} from "@orkestrator/protocol/contract/domains/kanban";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  getLinearIssue,
  listLinearIssues,
  postLinearIssueComment,
  postLinearCompletionComment,
  sanitizeLinearError,
  verifyLinearConnection,
} from "./linear.js";
import { asString, requireLinearApiKey } from "./commands-helpers.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";

/**
 * The machine's Linear connection and issue reads, in the `kanban` domain
 * (plan item 7008). The handlers are `async`, so an argument the definition
 * refuses is still a rejection (`ASYNC_HANDLER`). Nothing returns the key.
 */
export function registerLinearCommands(
  register: CommandRegistrar,
  _dependencies: RegistryDependencies,
): void {
  register(
    getLinearConnectionCommand,
    async (_args, context) => {
      const auth = await context.storage.kanban.getLinearAuth();
      if (!auth?.apiKey) return { connected: false, hasToken: false };
      try {
        const viewer = await verifyLinearConnection(auth.apiKey);
        await context.storage.kanban.saveLinearAuth(auth.apiKey, viewer);
        return { connected: true, hasToken: true, viewer };
      } catch (error) {
        return {
          connected: false,
          hasToken: true,
          viewer: auth.viewer,
          error: sanitizeLinearError(error, auth.apiKey),
        };
      }
    },
    ASYNC_HANDLER,
  );
  register(
    connectLinearCommand,
    async ({ apiKey }, context) => {
      const token = asString(apiKey, "apiKey").trim();
      if (!token) throw new Error("Linear API key is required");
      try {
        const viewer = await verifyLinearConnection(token);
        await context.storage.kanban.saveLinearAuth(token, viewer);
        return { connected: true, hasToken: true, viewer };
      } catch (error) {
        throw new Error(sanitizeLinearError(error, token));
      }
    },
    ASYNC_HANDLER,
  );
  register(
    disconnectLinearCommand,
    async (_args, { storage }) => {
      await storage.kanban.clearLinearAuth();
      return { connected: false, hasToken: false };
    },
    ASYNC_HANDLER,
  );
  register(
    getLinearIssuesCommand,
    async (_args, context) => {
      const apiKey = await requireLinearApiKey(context);
      try {
        return await listLinearIssues(apiKey);
      } catch (error) {
        throw new Error(sanitizeLinearError(error, apiKey));
      }
    },
    ASYNC_HANDLER,
  );
  register(
    getLinearIssueCommand,
    async ({ issueId }, context) => {
      const apiKey = await requireLinearApiKey(context);
      try {
        return await getLinearIssue(apiKey, asString(issueId, "issueId"));
      } catch (error) {
        throw new Error(sanitizeLinearError(error, apiKey));
      }
    },
    ASYNC_HANDLER,
  );
  register(
    postLinearIssueCommentCommand,
    async ({ issueId, body }, context) => {
      const targetIssueId = asString(issueId, "issueId");
      const commentBody = asString(body, "body");
      const apiKey = await requireLinearApiKey(context);
      try {
        return await postLinearIssueComment(apiKey, {
          issueId: targetIssueId,
          body: commentBody,
        });
      } catch (error) {
        throw new Error(sanitizeLinearError(error, apiKey));
      }
    },
    ASYNC_HANDLER,
  );
  register(
    postLinearCompletionCommentCommand,
    async ({ pipelineId, issueId, body }, context) => {
      const runId = asString(pipelineId, "pipelineId");
      const targetIssueId = asString(issueId, "issueId");
      const commentBody = asString(body, "body");
      return context.runtime.integrationLocks.withLinearCompletionComment(runId, async () => {
        const existing = await context.storage.kanban.getLinearCompletionComment(runId);
        if (existing?.status === "posted" && existing.commentId) {
          return {
            status: "already-posted",
            commentId: existing.commentId,
            postedAt: existing.postedAt,
          };
        }

        const apiKey = await requireLinearApiKey(context);
        try {
          const result = await postLinearCompletionComment(apiKey, {
            pipelineId: runId,
            issueId: targetIssueId,
            body: commentBody,
          });
          await context.storage.kanban.saveLinearCompletionComment({
            pipelineId: runId,
            issueId: targetIssueId,
            status: "posted",
            commentId: result.commentId,
            postedAt: result.postedAt ?? new Date().toISOString(),
          });
          return result;
        } catch (error) {
          const message = sanitizeLinearError(error, apiKey);
          await context.storage.kanban.saveLinearCompletionComment({
            pipelineId: runId,
            issueId: targetIssueId,
            status: "failed",
            error: message,
          });
          throw new Error(message);
        }
      });
    },
    ASYNC_HANDLER,
  );
}
