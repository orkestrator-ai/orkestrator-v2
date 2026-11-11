/**
 * A coordinator's Linear tools (docs/architecture/tickets.md, "Linear"):
 * list, read, create and update issues on a project's linked Linear board,
 * comment on them, and read the board's states, labels and members.
 *
 * Kanban stays a project's default board; these are for a project whose
 * board is in Linear (one or the other, never both for one ticket). Every
 * call names the project and the backend refuses an issue that is not on its
 * linked board, so a coordinator cannot change another team the key can see.
 * Each machine holds its own key, so a call runs here unless `nodeId` names
 * another machine.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { describe, int, list, num, str, toolInput, withDefault } from "./tool-schema.js";
import {
  asArray,
  isRecord,
  nodeIdField,
  readAnnotations,
  toolResult,
  type JsonRecord,
} from "./control-mcp-tool-support.js";
import type { ControlMcpToolContext } from "./control-mcp-tools-shared.js";

export const LINEAR_TOOL_NAMES = [
  "list_linear_issues",
  "get_linear_issue",
  "create_linear_issue",
  "update_linear_issue",
  "add_linear_comment",
  "list_linear_board_options",
] as const;

const KANBAN_FIRST =
  "For a project whose board is in Linear; Kanban (list_tickets) stays the default board.";

const projectIdField = str({ trim: true, min: 1, max: 200 });
const issueIdField = describe(str({ trim: true, min: 1, max: 200 }), "Id or identifier (ENG-123).");
const idList = (what: string) =>
  Schema.optionalKey(describe(list(str({ trim: true, min: 1, max: 200 }), { max: 50 }), what));
const priorityField = Schema.optionalKey(
  describe(int({ min: 0, max: 4 }), "0 none, 1 urgent, 2 high, 3 medium, 4 low."),
);

const MAX_COMMENTS = 50;
const MAX_DESCRIPTION = 20_000;

function issueSummary(issue: JsonRecord): JsonRecord {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    statusType: issue.statusType,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    assigneeName: issue.assigneeName,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}

function issueDetail(issue: JsonRecord): JsonRecord {
  const description = typeof issue.description === "string" ? issue.description : "";
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  return {
    ...issueSummary(issue),
    description:
      description.length > MAX_DESCRIPTION
        ? `${description.slice(0, MAX_DESCRIPTION)}… (truncated)`
        : description,
    labels: Array.isArray(issue.labels) ? issue.labels : [],
    ...(Array.isArray(issue.labelIds) ? { labelIds: issue.labelIds } : {}),
    ...(issue.stateId ? { stateId: issue.stateId } : {}),
    ...(issue.assigneeId ? { assigneeId: issue.assigneeId } : {}),
    ...(issue.estimate !== undefined ? { estimate: issue.estimate } : {}),
    projectName: issue.projectName,
    cycleName: issue.cycleName,
    creatorName: issue.creatorName,
    createdAt: issue.createdAt,
    comments: comments.slice(-MAX_COMMENTS),
    ...(comments.length > MAX_COMMENTS ? { olderComments: comments.length - MAX_COMMENTS } : {}),
  };
}

function boardOf(result: unknown): JsonRecord | null {
  const link = isRecord(result) && isRecord(result.link) ? result.link : null;
  if (!link) return null;
  return {
    teamId: link.teamId,
    teamKey: link.teamKey,
    teamName: link.teamName,
    ...(link.linearProjectId
      ? { linearProjectId: link.linearProjectId, linearProjectName: link.linearProjectName }
      : {}),
  };
}

function matchesText(issue: JsonRecord, needle: string | undefined): boolean {
  if (!needle) return true;
  const text = `${String(issue.identifier ?? "")} ${String(issue.title ?? "")}`.toLowerCase();
  return text.includes(needle.toLowerCase());
}

export function registerLinearTools(server: McpServer, context: ControlMcpToolContext): void {
  const { invoke, onNode, onNodeResult, coordinatorScope } = context;

  /**
   * Where a call runs: this machine with the given project, or with `nodeId`
   * the coordinator's own project on that machine (the same repository).
   */
  const target = async (
    projectId: string,
    nodeId: string | undefined,
  ): Promise<{
    call<T>(command: string, args: JsonRecord, requestKey?: string): Promise<T>;
    projectId: string;
    where: JsonRecord;
  }> => {
    const node = await onNode(nodeId);
    if (!node) {
      return { call: (command, args) => invoke(command, args), projectId, where: {} };
    }
    if (coordinatorScope && projectId !== coordinatorScope.projectId) {
      throw new Error("A coordinator's Linear tools with nodeId act on its own project.");
    }
    return {
      call: (command, args, requestKey) => node.call(command, args, requestKey),
      projectId: node.projectId,
      where: onNodeResult(node),
    };
  };

  server.registerTool(
    "list_linear_issues",
    {
      title: "List Linear issues",
      description: `List the issues on one project's linked Linear board, optionally filtered. ${KANBAN_FIRST}`,
      inputSchema: toolInput(
        Schema.Struct({
          projectId: projectIdField,
          status: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 100 }),
              "A state name or type (unstarted, started, completed).",
            ),
          ),
          assignee: Schema.optionalKey(
            describe(str({ trim: true, min: 1, max: 200 }), "Part of the assignee name."),
          ),
          text: Schema.optionalKey(
            describe(str({ trim: true, min: 1, max: 200 }), "Part of the identifier or title."),
          ),
          limit: withDefault(int({ min: 1, max: 250 }), 100),
          nodeId: nodeIdField,
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ projectId, status, assignee, text, limit, nodeId }) => {
      const on = await target(projectId, nodeId);
      const [issues, link] = await Promise.all([
        on.call<unknown>("get_linear_issues", { projectId: on.projectId }),
        on.call<unknown>("get_linear_board_link", { projectId: on.projectId }),
      ]);
      const wanted = status?.toLowerCase();
      const who = assignee?.toLowerCase();
      const matching = asArray(issues).filter(
        (issue) =>
          (!wanted ||
            String(issue.status ?? "").toLowerCase() === wanted ||
            String(issue.statusType ?? "").toLowerCase() === wanted) &&
          (!who ||
            String(issue.assigneeName ?? "")
              .toLowerCase()
              .includes(who)) &&
          matchesText(issue, text),
      );
      return toolResult({
        board: boardOf(link),
        issues: matching.slice(0, limit).map(issueSummary),
        total: matching.length,
        ...(matching.length > limit ? { truncated: true } : {}),
        ...on.where,
      });
    },
  );

  server.registerTool(
    "get_linear_issue",
    {
      title: "Read a Linear issue",
      description:
        "Read one issue on a project's linked Linear board, with its labels and latest comments.",
      inputSchema: toolInput(
        Schema.Struct({ projectId: projectIdField, issueId: issueIdField, nodeId: nodeIdField }),
      ),
      annotations: readAnnotations(),
    },
    async ({ projectId, issueId, nodeId }) => {
      const on = await target(projectId, nodeId);
      const issue = await on.call<unknown>("get_linear_issue", {
        projectId: on.projectId,
        issueId,
      });
      if (!isRecord(issue)) throw new Error(`Linear issue not found: ${issueId}`);
      return toolResult({ issue: issueDetail(issue), ...on.where });
    },
  );

  server.registerTool(
    "create_linear_issue",
    {
      title: "Create a Linear issue",
      description:
        "Create an issue on a project's linked Linear board. Ids come from list_linear_board_options. A retry with the same requestId returns the first issue.",
      inputSchema: toolInput(
        Schema.Struct({
          requestId: str({ trim: true, min: 1, max: 256 }),
          projectId: projectIdField,
          title: str({ trim: true, min: 1, max: 500 }),
          description: Schema.optionalKey(str({ max: 100_000 })),
          priority: priorityField,
          stateId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          assigneeId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          labelIds: idList("Label ids for the new issue."),
          estimate: Schema.optionalKey(num({ min: 0, max: 1_000 })),
          nodeId: nodeIdField,
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ requestId, projectId, nodeId, labelIds, ...fields }) => {
      const on = await target(projectId, nodeId);
      const issue = await on.call<unknown>(
        "create_linear_issue",
        {
          projectId: on.projectId,
          requestKey: requestId,
          ...fields,
          ...(labelIds ? { labelIds: [...labelIds] } : {}),
        },
        requestId,
      );
      if (!isRecord(issue)) throw new Error("Linear issue creation returned no issue");
      return toolResult({ issue: issueDetail(issue), ...on.where });
    },
  );

  server.registerTool(
    "update_linear_issue",
    {
      title: "Update a Linear issue",
      description:
        "Change named fields of an issue on a project's linked Linear board; null assigneeId unassigns, null estimate clears. Ids: list_linear_board_options.",
      inputSchema: toolInput(
        Schema.Struct({
          requestId: str({ trim: true, min: 1, max: 256 }),
          projectId: projectIdField,
          issueId: issueIdField,
          title: Schema.optionalKey(str({ trim: true, min: 1, max: 500 })),
          description: Schema.optionalKey(str({ max: 100_000 })),
          priority: priorityField,
          stateId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          assigneeId: Schema.optionalKey(Schema.NullOr(str({ trim: true, min: 1, max: 200 }))),
          addedLabelIds: idList("Label ids to add."),
          removedLabelIds: idList("Label ids to remove."),
          estimate: Schema.optionalKey(Schema.NullOr(num({ min: 0, max: 1_000 }))),
          nodeId: nodeIdField,
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      requestId,
      projectId,
      issueId,
      nodeId,
      addedLabelIds,
      removedLabelIds,
      ...fields
    }) => {
      const on = await target(projectId, nodeId);
      const issue = await on.call<unknown>(
        "update_linear_issue",
        {
          projectId: on.projectId,
          issueId,
          ...fields,
          ...(addedLabelIds ? { addedLabelIds: [...addedLabelIds] } : {}),
          ...(removedLabelIds ? { removedLabelIds: [...removedLabelIds] } : {}),
        },
        requestId,
      );
      if (!isRecord(issue)) throw new Error("Linear issue update returned no issue");
      return toolResult({ issue: issueDetail(issue), ...on.where });
    },
  );

  server.registerTool(
    "add_linear_comment",
    {
      title: "Comment on a Linear issue",
      description: "Comment on an issue on a project's linked Linear board. A retry posts again.",
      inputSchema: toolInput(
        Schema.Struct({
          requestId: str({ trim: true, min: 1, max: 256 }),
          projectId: projectIdField,
          issueId: issueIdField,
          text: str({ trim: true, min: 1, max: 20_000 }),
          nodeId: nodeIdField,
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ requestId, projectId, issueId, text, nodeId }) => {
      const on = await target(projectId, nodeId);
      const comment = await on.call<unknown>(
        "post_linear_issue_comment",
        { projectId: on.projectId, issueId, body: text },
        requestId,
      );
      if (!isRecord(comment)) throw new Error("Linear comment creation returned no comment");
      return toolResult({ comment, ...on.where });
    },
  );

  server.registerTool(
    "list_linear_board_options",
    {
      title: "List a Linear board's states, labels and members",
      description:
        "A project's linked Linear board: its states, labels and members, the ids issue writes take.",
      inputSchema: toolInput(Schema.Struct({ projectId: projectIdField, nodeId: nodeIdField })),
      annotations: readAnnotations(),
    },
    async ({ projectId, nodeId }) => {
      const on = await target(projectId, nodeId);
      const [options, link] = await Promise.all([
        on.call<unknown>("get_linear_board_options", { projectId: on.projectId }),
        on.call<unknown>("get_linear_board_link", { projectId: on.projectId }),
      ]);
      if (!isRecord(options)) throw new Error("Linear returned no board options");
      return toolResult({
        board: boardOf(link),
        states: asArray(options.states),
        labels: asArray(options.labels),
        members: asArray(options.members),
        ...on.where,
      });
    },
  );
}
