import {
  clearLinearBoardLinkCommand,
  copyLinearConnectionFromNodeCommand,
  createLinearIssueCommand,
  getLinearBoardLinkCommand,
  getLinearBoardOptionsCommand,
  getLinearNodeConnectionsCommand,
  getLinearTeamsCommand,
  setLinearBoardLinkCommand,
  updateLinearIssueCommand,
} from "@orkestrator/protocol/contract/domains/kanban";
import { exportLinearConnectionCommand } from "@orkestrator/protocol/contract/domains/ticket-sync";
import { isBackendId } from "@orkestrator/protocol/federation";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import { requireLinearApiKey } from "./commands-validation.js";
import { sanitizeLinearError, verifyLinearConnection, type LinearBoardFilter } from "./linear.js";
import {
  createLinearIssue,
  getLinearBoardOptions,
  getLinearIssueBoard,
  getLinearIssueWithIds,
  getLinearTeam,
  issueIsOnBoard,
  linearKeyFingerprint,
  listLinearTeams,
  updateLinearIssue,
} from "./linear-boards.js";
import { linearBoardLinkKey, type LinearBoardLink } from "./storage-linear.js";

/**
 * Linear boards (docs/architecture/tickets.md, "Linear"): which board a
 * project uses, the picker's teams, and writes to that board. A link is keyed
 * by the project's repository, so it reaches the same repository's project on
 * every machine through sync (`nodes/node-linear-sync.ts`).
 */

export type ProjectBoard = {
  project: { id: string; name: string; gitUrl?: string | null };
  key: string;
  link: LinearBoardLink | null;
};

export async function projectLinearBoard(
  context: CommandContext,
  projectId: string,
): Promise<ProjectBoard> {
  const project = await context.storage.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const key = linearBoardLinkKey(project);
  return { project, key, link: await context.storage.linear.getLinearBoardLink(key) };
}

/** The board a project is linked to, or an error saying how to link one. */
export async function requireProjectLinearBoard(
  context: CommandContext,
  projectId: string,
): Promise<ProjectBoard & { link: LinearBoardLink; board: LinearBoardFilter }> {
  const resolved = await projectLinearBoard(context, projectId);
  if (!resolved.link?.teamId) {
    throw new Error(
      `Project "${resolved.project.name}" has no Linear board linked. Link one from the project's Linear tab.`,
    );
  }
  return {
    ...resolved,
    link: resolved.link,
    board: {
      teamId: resolved.link.teamId,
      ...(resolved.link.linearProjectId ? { linearProjectId: resolved.link.linearProjectId } : {}),
    },
  };
}

export function linearBoardName(link: LinearBoardLink): string {
  const team = link.teamKey ?? link.teamName ?? "its team";
  return link.linearProjectName ? `${team} / ${link.linearProjectName}` : team;
}

/** Refuses an issue that is not on the project's linked board. */
export async function requireIssueOnProjectBoard(
  context: CommandContext,
  apiKey: string,
  projectId: string,
  issueId: string,
): Promise<void> {
  const { link, board } = await requireProjectLinearBoard(context, projectId);
  const issue = await getLinearIssueBoard(apiKey, issueId);
  if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
  if (!issueIsOnBoard(issue, board)) {
    throw new Error(
      `Linear issue ${issue.identifier ?? issueId} is not on this project's Linear board (${linearBoardName(link)}).`,
    );
  }
}

/** A board change here goes to every machine with the repository. */
export function noteLinearChange(context: CommandContext): void {
  context.nodeCoordination?.linearSync?.noteLocalChange();
}

async function withLinearKey<T>(
  context: CommandContext,
  run: (apiKey: string) => Promise<T>,
): Promise<T> {
  const apiKey = await requireLinearApiKey(context);
  try {
    return await run(apiKey);
  } catch (error) {
    throw new Error(sanitizeLinearError(error, apiKey));
  }
}

export function registerLinearBoardCommands(register: CommandRegistrar): void {
  register(
    getLinearTeamsCommand,
    (_args, context) => withLinearKey(context, (apiKey) => listLinearTeams(apiKey)),
    ASYNC_HANDLER,
  );

  register(
    getLinearBoardLinkCommand,
    async ({ projectId }, context) => {
      const { link } = await projectLinearBoard(context, projectId);
      return link ? { link } : {};
    },
    ASYNC_HANDLER,
  );

  register(
    setLinearBoardLinkCommand,
    async ({ projectId, teamId, linearProjectId }, context) => {
      const { project, key } = await projectLinearBoard(context, projectId);
      const team = await withLinearKey(context, (apiKey) => getLinearTeam(apiKey, teamId));
      if (!team) throw new Error("That Linear team is not visible to the connected key.");
      const linearProject = linearProjectId
        ? team.projects.find((candidate) => candidate.id === linearProjectId)
        : undefined;
      if (linearProjectId && !linearProject) {
        throw new Error(`That Linear project is not in the ${team.name} team.`);
      }
      const projects = await context.storage.loadProjects();
      const names = new Map(projects.map((entry) => [linearBoardLinkKey(entry), entry.name]));
      const hint = key.startsWith("repo:") ? key.slice("repo:".length) : undefined;
      const link = context.storage.linear.saveLinearBoardLink(
        {
          key,
          ...(hint ? { repositoryHint: hint } : {}),
          projectId: project.id,
          teamId: team.id,
          ...(team.key ? { teamKey: team.key } : {}),
          teamName: team.name,
          ...(linearProject
            ? { linearProjectId: linearProject.id, linearProjectName: linearProject.name }
            : {}),
        },
        new Set(names.keys()),
        (other) => `project "${names.get(other) ?? other}"`,
      );
      noteLinearChange(context);
      return link;
    },
    ASYNC_HANDLER,
  );

  register(
    clearLinearBoardLinkCommand,
    async ({ projectId }, context) => {
      const { key } = await projectLinearBoard(context, projectId);
      const cleared = context.storage.linear.clearLinearBoardLink(key);
      if (cleared) noteLinearChange(context);
      return { cleared };
    },
    ASYNC_HANDLER,
  );

  register(
    getLinearBoardOptionsCommand,
    async ({ projectId }, context) => {
      const { board } = await requireProjectLinearBoard(context, projectId);
      return withLinearKey(context, (apiKey) => getLinearBoardOptions(apiKey, board.teamId));
    },
    ASYNC_HANDLER,
  );

  register(
    createLinearIssueCommand,
    async ({ projectId, requestKey, ...input }, context) => {
      const key = requestKey.trim();
      if (!key || key.length > 256) throw new Error("Expected requestKey.");
      const { key: linkKey, board } = await requireProjectLinearBoard(context, projectId);
      return withLinearKey(context, async (apiKey) => {
        const earlier = await context.storage.linear.findLinearIssueCreate(key);
        if (earlier) {
          if (earlier.linkKey !== linkKey) {
            throw new Error("That requestKey was already used for another project's issue.");
          }
          return getLinearIssueWithIds(apiKey, earlier.issueId);
        }
        const issue = await createLinearIssue(apiKey, board, input);
        context.storage.linear.recordLinearIssueCreate({
          requestKey: key,
          linkKey,
          issueId: issue.id,
        });
        return issue;
      });
    },
    ASYNC_HANDLER,
  );

  register(
    updateLinearIssueCommand,
    async ({ projectId, issueId, ...input }, context) =>
      withLinearKey(context, async (apiKey) => {
        await requireIssueOnProjectBoard(context, apiKey, projectId, issueId);
        return updateLinearIssue(apiKey, issueId, input);
      }),
    ASYNC_HANDLER,
  );

  register(
    getLinearNodeConnectionsCommand,
    async (_args, context) => context.nodeCoordination?.linearSync?.nodeConnections() ?? [],
    ASYNC_HANDLER,
  );

  register(
    copyLinearConnectionFromNodeCommand,
    async ({ nodeId }, context) => {
      const nodes = context.nodes;
      if (!nodes || nodes.mode() !== "command") {
        throw new Error("Only a command node can copy another machine's Linear connection.");
      }
      if (!isBackendId(nodeId)) throw new Error("Expected nodeId to be a node identity.");
      const link = nodes.link(nodeId);
      if (!link) throw new Error("That machine is not connected.");
      const exported = await link.invokeCommand(exportLinearConnectionCommand, {
        controllerId: await nodes.selfIdentity(),
      });
      const apiKey = typeof exported?.apiKey === "string" ? exported.apiKey.trim() : "";
      if (!apiKey) throw new Error("That machine is not connected to Linear.");
      try {
        const viewer = await verifyLinearConnection(apiKey);
        const auth = await context.storage.kanban.saveLinearAuth(apiKey, viewer);
        noteLinearChange(context);
        return {
          connected: true,
          hasToken: true,
          viewer,
          keyFingerprint: linearKeyFingerprint(apiKey),
          connectedAt: auth.connectedAt,
        };
      } catch (error) {
        throw new Error(sanitizeLinearError(error, apiKey));
      }
    },
    ASYNC_HANDLER,
  );
}
