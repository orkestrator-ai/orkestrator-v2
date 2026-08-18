import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  getLinearIssue,
  listLinearIssues,
  postLinearIssueComment,
  postLinearCompletionComment,
  sanitizeLinearError,
  verifyLinearConnection,
} from "./commands-dependencies.js";
import {
  asString,
  requireLinearApiKey,
  withLinearCompletionCommentLock,
} from "./commands-helpers.js";

export function registerLinearCommands(
  register: CommandRegistrar,
  _dependencies: RegistryDependencies,
): void {
  register("get_linear_connection", async (_args, context) => {
    const auth = await context.storage.getLinearAuth();
    if (!auth?.apiKey) return { connected: false, hasToken: false };
    try {
      const viewer = await verifyLinearConnection(auth.apiKey);
      await context.storage.saveLinearAuth(auth.apiKey, viewer);
      return { connected: true, hasToken: true, viewer };
    } catch (error) {
      return {
        connected: false,
        hasToken: true,
        viewer: auth.viewer,
        error: sanitizeLinearError(error, auth.apiKey),
      };
    }
  });
  register("connect_linear", async ({ apiKey }, context) => {
    const token = asString(apiKey, "apiKey").trim();
    if (!token) throw new Error("Linear API key is required");
    try {
      const viewer = await verifyLinearConnection(token);
      await context.storage.saveLinearAuth(token, viewer);
      return { connected: true, hasToken: true, viewer };
    } catch (error) {
      throw new Error(sanitizeLinearError(error, token));
    }
  });
  register("disconnect_linear", async (_args, { storage }) => {
    await storage.clearLinearAuth();
    return { connected: false, hasToken: false };
  });
  register("get_linear_issues", async (_args, context) => {
    const apiKey = await requireLinearApiKey(context);
    try {
      return await listLinearIssues(apiKey);
    } catch (error) {
      throw new Error(sanitizeLinearError(error, apiKey));
    }
  });
  register("get_linear_issue", async ({ issueId }, context) => {
    const apiKey = await requireLinearApiKey(context);
    try {
      return await getLinearIssue(apiKey, asString(issueId, "issueId"));
    } catch (error) {
      throw new Error(sanitizeLinearError(error, apiKey));
    }
  });
  register("post_linear_issue_comment", async ({ issueId, body }, context) => {
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
  });
  register("post_linear_completion_comment", async ({ pipelineId, issueId, body }, context) => {
    const runId = asString(pipelineId, "pipelineId");
    const targetIssueId = asString(issueId, "issueId");
    const commentBody = asString(body, "body");
    return withLinearCompletionCommentLock(runId, async () => {
      const existing = await context.storage.getLinearCompletionComment(runId);
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
        await context.storage.saveLinearCompletionComment({
          pipelineId: runId,
          issueId: targetIssueId,
          status: "posted",
          commentId: result.commentId,
          postedAt: result.postedAt ?? new Date().toISOString(),
        });
        return result;
      } catch (error) {
        const message = sanitizeLinearError(error, apiKey);
        await context.storage.saveLinearCompletionComment({
          pipelineId: runId,
          issueId: targetIssueId,
          status: "failed",
          error: message,
        });
        throw new Error(message);
      }
    });
  });
}
