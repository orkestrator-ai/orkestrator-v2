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
import {
  noteLinearChange,
  registerLinearBoardCommands,
  requireIssueOnProjectBoard,
  requireProjectLinearBoard,
} from "./commands-registry-linear-boards.js";
import { linearKeyFingerprint } from "./linear-boards.js";
import { nowIso } from "./storage-shared-core.js";

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
      const keyFingerprint = linearKeyFingerprint(auth.apiKey);
      try {
        const viewer = await verifyLinearConnection(auth.apiKey);
        // Keeps `connectedAt`: a refreshed viewer is not a new connection, so a
        // disconnect made elsewhere since still applies here.
        await context.storage.kanban.saveLinearAuth(auth.apiKey, viewer, auth.connectedAt);
        return {
          connected: true,
          hasToken: true,
          viewer,
          keyFingerprint,
          connectedAt: auth.connectedAt,
        };
      } catch (error) {
        return {
          connected: false,
          hasToken: true,
          viewer: auth.viewer,
          error: sanitizeLinearError(error, auth.apiKey),
          keyFingerprint,
          connectedAt: auth.connectedAt,
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
        const auth = await context.storage.kanban.saveLinearAuth(token, viewer);
        noteLinearChange(context);
        return {
          connected: true,
          hasToken: true,
          viewer,
          keyFingerprint: linearKeyFingerprint(token),
          connectedAt: auth.connectedAt,
        };
      } catch (error) {
        throw new Error(sanitizeLinearError(error, token));
      }
    },
    ASYNC_HANDLER,
  );
  register(
    disconnectLinearCommand,
    async (_args, context) => {
      const { storage } = context;
      const auth = await storage.kanban.getLinearAuth();
      // Every machine holding the same key disconnects too, including ones
      // offline now: the disconnect syncs by the key's fingerprint.
      if (auth?.apiKey) {
        storage.linear.mergeLinearRevocations([
          { keyFingerprint: linearKeyFingerprint(auth.apiKey), revokedAt: nowIso() },
        ]);
      }
      await storage.kanban.clearLinearAuth();
      noteLinearChange(context);
      return { connected: false, hasToken: false };
    },
    ASYNC_HANDLER,
  );
  register(
    getLinearIssuesCommand,
    async ({ projectId }, context) => {
      const board = projectId
        ? (await requireProjectLinearBoard(context, projectId)).board
        : undefined;
      const apiKey = await requireLinearApiKey(context);
      try {
        return await listLinearIssues(apiKey, board);
      } catch (error) {
        throw new Error(sanitizeLinearError(error, apiKey));
      }
    },
    ASYNC_HANDLER,
  );
  register(
    getLinearIssueCommand,
    async ({ issueId, projectId }, context) => {
      const apiKey = await requireLinearApiKey(context);
      try {
        if (projectId) await requireIssueOnProjectBoard(context, apiKey, projectId, issueId);
        return await getLinearIssue(apiKey, asString(issueId, "issueId"));
      } catch (error) {
        throw new Error(sanitizeLinearError(error, apiKey));
      }
    },
    ASYNC_HANDLER,
  );
  register(
    postLinearIssueCommentCommand,
    async ({ issueId, body, projectId }, context) => {
      const targetIssueId = asString(issueId, "issueId");
      const commentBody = asString(body, "body");
      const apiKey = await requireLinearApiKey(context);
      try {
        if (projectId) {
          await requireIssueOnProjectBoard(context, apiKey, projectId, targetIssueId);
        }
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
  registerLinearBoardCommands(register);
}
