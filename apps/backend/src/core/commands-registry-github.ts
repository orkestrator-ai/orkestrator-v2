import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
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
} from "./commands-dependencies.js";
import {
  asString,
  requireGitHubProject,
  asGitHubIssueStatus,
  withGitHubCompletionCommentLock,
  asNumber,
} from "./commands-helpers.js";

export function registerGitHubCommands(
  register: CommandRegistrar,
  _dependencies: RegistryDependencies,
): void {
  register(
    "post_github_completion_comment",
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

      return withGitHubCompletionCommentLock(runId, () =>
        context.storage.withGitHubCompletionCommentLock(runId, async () => {
          const target = await requireGitHubProject(context, targetProjectId);
          if (
            target.repository.owner.toLowerCase() !== owner.toLowerCase() ||
            target.repository.name.toLowerCase() !== name.toLowerCase()
          ) {
            throw new Error(
              `GitHub pipeline repository does not match the selected project (${target.repository.owner}/${target.repository.name}).`,
            );
          }
          const existing = await context.storage.getGitHubCompletionComment(runId);
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
              await context.storage.saveGitHubCompletionComment({
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
            await context.storage.saveGitHubCompletionComment({
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
            await context.storage.saveGitHubCompletionComment({
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
  register("get_github_issues", async ({ projectId }, context) => {
    const target = await requireGitHubProject(context, asString(projectId, "projectId"));
    try {
      return await listGitHubIssues(target.token, target.repository);
    } catch (error) {
      throw new Error(sanitizeGitHubError(error, target.token));
    }
  });
  register("get_github_issue", async ({ projectId, issueNumber }, context) => {
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
  register("update_github_issue", async ({ projectId, issueNumber, title, body }, context) => {
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
  register("update_github_issue_status", async ({ projectId, issueNumber, status }, context) => {
    const target = await requireGitHubProject(context, asString(projectId, "projectId"));
    try {
      return await updateGitHubIssueStatus(
        target.token,
        target.repository,
        asNumber(issueNumber, "issueNumber"),
        asGitHubIssueStatus(status),
      );
    } catch (error) {
      throw new Error(sanitizeGitHubError(error, target.token));
    }
  });
  register("close_github_issue", async ({ projectId, issueNumber }, context) => {
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
  register("add_github_issue_comment", async ({ projectId, issueNumber, body }, context) => {
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
    "update_github_issue_comment",
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
