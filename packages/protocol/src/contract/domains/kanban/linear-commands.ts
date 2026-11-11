/**
 * `kanban` commands for Linear boards (docs/architecture/tickets.md, "Linear"):
 * which Linear board a project uses, the picker's teams, the ids a write can
 * use, and creating and updating issues on that board.
 *
 * Every write names a `projectId` and is refused unless the issue is on that
 * project's linked board, so neither the Linear tab nor a coordinator can
 * change a team the key can merely see. New commands of domain version 2: an
 * older node answers `unknown-command`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { mutableArray } from "../../model-schema.js";
import { kanbanDomain } from "./domain.js";
import {
  LinearBoardLinkResultSchema,
  LinearBoardLinkSchema,
  LinearBoardOptionsSchema,
  LinearConnectionStatusSchema,
  LinearIssueDetailSchema,
  LinearNodeConnectionSchema,
  LinearTeamSchema,
} from "./schemas.js";

const optionalString = Schema.optionalKey(Schema.String);
const optionalIds = Schema.optionalKey(mutableArray(Schema.String));
/** Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
const optionalPriority = Schema.optionalKey(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
);

/** Every team the key can see, with its projects: the board picker's choices. */
export const getLinearTeamsCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_linear_teams",
  since: 2,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: mutableArray(LinearTeamSchema),
  critical: [],
});

/** The board a project is linked to on this machine. */
export const getLinearBoardLinkCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_linear_board_link",
  since: 2,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: LinearBoardLinkResultSchema,
  critical: [],
});

/**
 * Links a project to a team (optionally one Linear project in it). The link
 * is keyed by the project's repository, so it reaches the same repository's
 * project on every machine. Refused when another project here has that board.
 */
export const setLinearBoardLinkCommand = defineCommand({
  domain: kanbanDomain,
  name: "set_linear_board_link",
  since: 2,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    teamId: Schema.String,
    linearProjectId: optionalString,
  }),
  result: LinearBoardLinkSchema,
  critical: [],
});

/** Removes a project's link here and, through sync, on every machine with the repository. */
export const clearLinearBoardLinkCommand = defineCommand({
  domain: kanbanDomain,
  name: "clear_linear_board_link",
  since: 2,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: Schema.String }),
  result: Schema.Struct({ cleared: Schema.Boolean }),
  critical: [],
});

/** The project board's workflow states, labels and members. */
export const getLinearBoardOptionsCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_linear_board_options",
  since: 2,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: LinearBoardOptionsSchema,
  critical: [],
});

/**
 * Creates an issue on the project's board. `requestKey` makes a retry answer
 * with the issue the first call created instead of making a second one.
 */
export const createLinearIssueCommand = defineCommand({
  domain: kanbanDomain,
  name: "create_linear_issue",
  since: 2,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    requestKey: Schema.String,
    title: Schema.String,
    description: optionalString,
    priority: optionalPriority,
    stateId: optionalString,
    assigneeId: optionalString,
    labelIds: optionalIds,
    estimate: Schema.optionalKey(Schema.Finite),
  }),
  result: LinearIssueDetailSchema,
  critical: ["requestKey"],
});

/**
 * Changes the named fields of an issue on the project's board. `assigneeId`
 * null unassigns; labels are added and removed by id.
 */
export const updateLinearIssueCommand = defineCommand({
  domain: kanbanDomain,
  name: "update_linear_issue",
  since: 2,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    issueId: Schema.String,
    title: optionalString,
    description: optionalString,
    priority: optionalPriority,
    stateId: optionalString,
    assigneeId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    addedLabelIds: optionalIds,
    removedLabelIds: optionalIds,
    estimate: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  }),
  result: LinearIssueDetailSchema,
  critical: [],
});

/**
 * On a command node: each other machine's Linear connection as it was last
 * read (signed in as whom, and the key's fingerprint). Never a key.
 */
export const getLinearNodeConnectionsCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_linear_node_connections",
  since: 2,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: mutableArray(LinearNodeConnectionSchema),
  critical: [],
});

/**
 * On a command node, at the user's request: copies the Linear key of a
 * connected machine this window cannot reach to this machine, once, over the
 * node link, and verifies it here (docs/architecture/command-nodes.md,
 * "Settings"). The key is never returned.
 */
export const copyLinearConnectionFromNodeCommand = defineCommand({
  domain: kanbanDomain,
  name: "copy_linear_connection_from_node",
  since: 2,
  access: "admin",
  read: false,
  args: Schema.Struct({ nodeId: Schema.String }),
  result: LinearConnectionStatusSchema,
  critical: [],
});

export const LINEAR_BOARD_COMMANDS = [
  getLinearTeamsCommand,
  getLinearBoardLinkCommand,
  setLinearBoardLinkCommand,
  clearLinearBoardLinkCommand,
  getLinearBoardOptionsCommand,
  createLinearIssueCommand,
  updateLinearIssueCommand,
  getLinearNodeConnectionsCommand,
  copyLinearConnectionFromNodeCommand,
] as const;
