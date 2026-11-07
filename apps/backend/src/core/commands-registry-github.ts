import type { AnyCommandDef } from "@orkestrator/protocol/contract/command";
import {
  addGitHubIssueCommentCommand,
  closeGitHubIssueCommand,
  getGitHubIssueCommand,
  getGitHubIssuesCommand,
  postGitHubCompletionCommentCommand,
  updateGitHubIssueCommand,
  updateGitHubIssueCommentCommand,
  updateGitHubIssueStatusCommand,
} from "@orkestrator/protocol/contract/domains/pull-requests";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type {
  CommandRegistrar,
  DefinedCommandHandler,
  RegistryDependencies,
} from "./commands-registry-types.js";
import {
  closeGitHubIssue,
  getGitHubIssue,
  listGitHubIssueComments,
  listGitHubIssues,
  postGitHubIssueComment,
  sanitizeGitHubError,
  updateGitHubIssue,
  updateGitHubIssueComment,
  updateGitHubIssueStatus,
} from "./github.js";
import {
  asString,
  requireGitHubProject,
  asGitHubIssueStatus,
  asNumber,
} from "./commands-helpers.js";

/**
 * A project's GitHub issues, registered with their `pull-requests`
 * definitions (plan item 7006). The handlers are `async`, so a refused
 * argument is still a rejection.
 */
export function registerGitHubCommands(
  registerCommand: CommandRegistrar,
  _dependencies: RegistryDependencies,
): void {
  const register = <C extends AnyCommandDef>(def: C, handler: DefinedCommandHandler<C>) =>
    registerCommand(def, handler, ASYNC_HANDLER);
  register(
    postGitHubCompletionCommentCommand,
    async (
      { pipelineId, projectId, repositoryOwner, repositoryName, issueNumber, body },
      context,
    ) => {
      const runId = asString(pipelineId, "pipelineId");
      const targetProjectId = asString(projectId, "projectId");
      const owner = asString(repositoryOwner, "repositoryOwner").trim();
      const name = asString(repositoryName, "repositoryName").trim();
      const targetIssueNumber = asNumber(issueNumber, "issueNumber");
      const commentBody = asString(body, "body").trim();
      if (!commentBody) throw new Error("Completion comment cannot be empty");

      return context.runtime.integrationLocks.withGitHubCompletionComment(runId, () =>
        context.storage.kanban.withGitHubCompletionCommentLock(runId, async () => {
          const target = await requireGitHubProject(context, targetProjectId);
          if (
            target.repository.owner.toLowerCase() !== owner.toLowerCase() ||
            target.repository.name.toLowerCase() !== name.toLowerCase()
          ) {
            throw new Error(
              `GitHub pipeline repository does not match the selected project (${target.repository.owner}/${target.repository.name}).`,
            );
          }
          const existing = await context.storage.kanban.getGitHubCompletionComment(runId);
          if (existing?.status === "posted" && existing.commentId) {
            return {
              status: "already-posted",
              commentId: existing.commentId,
              postedAt: existing.postedAt,
            };
          }

          const { token, repository } = target;
          const marker = `<!-- orkestrator-github-run:${runId} -->`;
          try {
            // Always scan before posting. This recovers the case where GitHub
            // accepted a previous request but the response or local persistence
            // failed, and makes explicit retries safe.
            const comments = await listGitHubIssueComments(token, repository, targetIssueNumber);
            const matchingComment = comments.find((comment) => comment.body.includes(marker));
            if (matchingComment) {
              const commentId = String(matchingComment.id);
              await context.storage.kanban.saveGitHubCompletionComment({
                pipelineId: runId,
                repositoryOwner: repository.owner,
                repositoryName: repository.name,
                issueNumber: targetIssueNumber,
                status: "posted",
                commentId,
                postedAt: matchingComment.createdAt,
              });
              return {
                status: "already-posted",
                commentId,
                postedAt: matchingComment.createdAt,
              };
            }

            const comment = await postGitHubIssueComment(
              token,
              repository,
              targetIssueNumber,
              `${commentBody}\n\n${marker}`,
            );
            const commentId = String(comment.id);
            await context.storage.kanban.saveGitHubCompletionComment({
              pipelineId: runId,
              repositoryOwner: repository.owner,
              repositoryName: repository.name,
              issueNumber: targetIssueNumber,
              status: "posted",
              commentId,
              postedAt: comment.createdAt,
            });
            return {
              status: "posted",
              commentId,
              postedAt: comment.createdAt,
            };
          } catch (error) {
            const message = sanitizeGitHubError(error, token);
            await context.storage.kanban.saveGitHubCompletionComment({
              pipelineId: runId,
              repositoryOwner: repository.owner,
              repositoryName: repository.name,
              issueNumber: targetIssueNumber,
              status: "failed",
              error: message,
            });
            throw new Error(message);
          }
        }),
      );
    },
  );
  register(getGitHubIssuesCommand, async ({ projectId }, context) => {
    const target = await requireGitHubProject(context, asString(projectId, "projectId"));
    try {
      return await listGitHubIssues(
        context.runtime.integrationLocks,
        target.token,
        target.repository,
      );
    } catch (error) {
      throw new Error(sanitizeGitHubError(error, target.token));
    }
  });
  register(getGitHubIssueCommand, async ({ projectId, issueNumber }, context) => {
    const target = await requireGitHubProject(context, asString(projectId, "projectId"));
    try {
      return await getGitHubIssue(
        target.token,
        target.repository,
        asNumber(issueNumber, "issueNumber"),
      );
    } catch (error) {
      throw new Error(sanitizeGitHubError(error, target.token));
    }
  });
  register(updateGitHubIssueCommand, async ({ projectId, issueNumber, title, body }, context) => {
    const target = await requireGitHubProject(context, asString(projectId, "projectId"));
    try {
      return await updateGitHubIssue(
        target.token,
        target.repository,
        asNumber(issueNumber, "issueNumber"),
        { title: asString(title, "title"), body: asString(body, "body") },
      );
    } catch (error) {
      throw new Error(sanitizeGitHubError(error, target.token));
    }
  });
  register(updateGitHubIssueStatusCommand, async ({ projectId, issueNumber, status }, context) => {
    const target = await requireGitHubProject(context, asString(projectId, "projectId"));
    try {
      return await updateGitHubIssueStatus(
        context.runtime.integrationLocks,
        target.token,
        target.repository,
        asNumber(issueNumber, "issueNumber"),
        asGitHubIssueStatus(status),
      );
    } catch (error) {
      throw new Error(sanitizeGitHubError(error, target.token));
    }
  });
  register(closeGitHubIssueCommand, async ({ projectId, issueNumber }, context) => {
    const target = await requireGitHubProject(context, asString(projectId, "projectId"));
    try {
      return await closeGitHubIssue(
        target.token,
        target.repository,
        asNumber(issueNumber, "issueNumber"),
      );
    } catch (error) {
      throw new Error(sanitizeGitHubError(error, target.token));
    }
  });
  register(addGitHubIssueCommentCommand, async ({ projectId, issueNumber, body }, context) => {
    const target = await requireGitHubProject(context, asString(projectId, "projectId"));
    try {
      return await postGitHubIssueComment(
        target.token,
        target.repository,
        asNumber(issueNumber, "issueNumber"),
        asString(body, "body"),
      );
    } catch (error) {
      throw new Error(sanitizeGitHubError(error, target.token));
    }
  });
  register(
    updateGitHubIssueCommentCommand,
    async ({ projectId, issueNumber, commentId, body }, context) => {
      const target = await requireGitHubProject(context, asString(projectId, "projectId"));
      try {
        return await updateGitHubIssueComment(
          target.token,
          target.repository,
          asNumber(issueNumber, "issueNumber"),
          asNumber(commentId, "commentId"),
          asString(body, "body"),
        );
      } catch (error) {
        throw new Error(sanitizeGitHubError(error, target.token));
      }
    },
  );
}
