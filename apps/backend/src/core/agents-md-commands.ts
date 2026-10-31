import { createHash } from "node:crypto";
import {
  MAX_AGENTS_MD_REASON_CHARS,
  parseAgentsMdChanges,
} from "@orkestrator/protocol/agents-md-orkestrator";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  agentsMdBranchName,
  agentsMdRequestKey,
  openAgentsMdPullRequest,
  readAgentsMdSectionFromBase,
} from "./agents-md-pr.js";
import { asNonBlankString } from "./commands-helpers.js";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { coordinatorCaller, withCoordinatorReceipt } from "./coordinator-action-scope.js";
import { resolveProjectGitRoot } from "./project-git-root.js";

/**
 * Backend commands behind `propose_agents_md_update`: a main coordinator
 * proposes entries for the `## Orkestrator` section of the project's root
 * AGENTS.md, the user reviews them, and only the user's approval opens a
 * pull request (`agents-md-pr.ts`), on the node that owns the project copy.
 *
 * - `request_coordinator_agents_md_update` (coordinator scope): validates the
 *   proposal and creates an `update-agents-md` node action request. It writes
 *   nothing else. A retry with the same `requestId` replays the request and
 *   reports its current state and pull request.
 * - `read_project_agents_md_section` (any node): the section on the freshly
 *   fetched base branch, for the review dialog.
 * - `open_project_agents_md_pr` (any node): runs only from an approved request;
 *   the coordinator's command invoker refuses it by name.
 */

type JsonRecord = Record<string, unknown>;

/** The branch a project's pull requests target: the PR base, else the default branch. */
export async function agentsMdBaseBranch(
  context: CommandContext,
  projectId: string,
): Promise<string> {
  const config = await context.storage.getRepositoryConfig(projectId).catch(() => null);
  return config?.prBaseBranch?.trim() || config?.defaultBranch?.trim() || "main";
}

function proposalReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_AGENTS_MD_REASON_CHARS)
    throw new Error(`reason must be 1-${MAX_AGENTS_MD_REASON_CHARS} characters`);
  return value.replace(/\s+/g, " ").trim();
}

export function registerAgentsMdCommands(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "commands">,
): void {
  const run = async <T>(context: CommandContext, command: string, args: JsonRecord): Promise<T> => {
    const handler = dependencies.commands.get(command);
    if (!handler) throw new Error(`Backend command is unavailable: ${command}`);
    return (await handler(args, context)) as T;
  };

  register("request_coordinator_agents_md_update", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = args.input;
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Expected the proposal");
    const fields = input as JsonRecord;
    const requestId = asNonBlankString(fields.requestId, "requestId");
    const changes = parseAgentsMdChanges(fields.changes);
    const reason = proposalReason(fields.reason);
    const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(
      caller.coordinatorId,
    );
    const conversation = workspace?.conversations.find((item) => item.id === caller.conversationId);
    if (!conversation) throw new Error("This coordinator conversation has no mailbox");
    // The capability check already keeps side agents out; this is the backstop.
    if (conversation.role === "side")
      throw new Error("Only the main coordinator can propose AGENTS.md changes");
    // A copy on another node, resolved by the Control MCP tool from the
    // credential's project; otherwise this node's own checkout.
    const remote =
      args.target && typeof args.target === "object" ? (args.target as JsonRecord) : null;
    const project = remote ? null : await context.storage.getProject(caller.projectId);
    const result = await withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "propose-agents-md-update",
        payload: { changes, reason, nodeId: remote?.nodeId ?? null },
      },
      async () => {
        const self = await run<JsonRecord>(context, "get_node_status", {});
        const target = remote
          ? {
              nodeId: asNonBlankString(remote.nodeId, "target.nodeId"),
              nodeName: asNonBlankString(remote.nodeName, "target.nodeName"),
              projectId: asNonBlankString(remote.projectId, "target.projectId"),
              ...(typeof remote.projectName === "string"
                ? { projectName: remote.projectName }
                : {}),
            }
          : {
              nodeId: self.nodeId,
              nodeName: "this machine",
              projectId: caller.projectId,
              ...(project?.name ? { projectName: project.name } : {}),
            };
        const created = await run<JsonRecord>(context, "create_node_action_request", {
          requestId: `agents-md-coordinator-${createHash("sha256")
            .update(`${caller.coordinatorId}\0${requestId}`)
            .digest("hex")
            .slice(0, 24)}`,
          kind: "update-agents-md",
          targets: [target],
          requestedBy: {
            coordinatorEnvironmentId: coordinatorRuntimeId(
              caller.coordinatorId,
              caller.conversationId,
            ),
            coordinatorTabId: conversation.tabId,
            projectId: caller.projectId,
          },
          reason,
          agentsMd: { changes },
        });
        return {
          approvalRequestId: created.requestId,
          nodeId: target.nodeId,
          branch: agentsMdBranchName(agentsMdRequestKey(String(created.requestId))),
        };
      },
    );
    // A retry reports where the request is now, including its pull request.
    const current =
      typeof result.approvalRequestId === "string"
        ? await context.nodeCoordination?.actions.get(result.approvalRequestId).catch(() => null)
        : null;
    return {
      ...result,
      state: current?.state ?? "pending",
      ...(current?.result ? { outcome: current.result.message } : {}),
      ...(current?.result?.url ? { prUrl: current.result.url } : {}),
    };
  });

  /** The section on the freshly fetched base branch, for the user's review. Read-only. */
  register("read_project_agents_md_section", async (args, context) => {
    const projectId = asNonBlankString(args.projectId, "projectId");
    const root = await resolveProjectGitRoot(context.storage, projectId);
    return readAgentsMdSectionFromBase({
      root,
      baseBranch: await agentsMdBaseBranch(context, projectId),
      gitHubConfig: context.storage,
    });
  });

  /**
   * Runs only from an approved `update-agents-md` request (the coordinator's
   * command invoker refuses it by name). Idempotent per request key.
   */
  register("open_project_agents_md_pr", async (args, context) => {
    const projectId = asNonBlankString(args.projectId, "projectId");
    const key = asNonBlankString(args.requestKey, "requestKey");
    const changes = parseAgentsMdChanges(args.changes);
    const reason = proposalReason(args.reason);
    const root = await resolveProjectGitRoot(context.storage, projectId);
    return openAgentsMdPullRequest({
      root,
      baseBranch: await agentsMdBaseBranch(context, projectId),
      key,
      changes,
      reason,
      gitHubConfig: context.storage,
      ...(typeof args.nodeName === "string" ? { nodeName: args.nodeName.slice(0, 64) } : {}),
    });
  });
}
