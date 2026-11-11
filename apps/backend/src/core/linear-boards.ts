/**
 * The Linear calls a linked board needs beyond `linear.ts`: the teams and
 * projects for the board picker, a board's workflow states, labels and
 * members, which board an issue is on, and creating and updating issues.
 * Every call goes through `linearGraphql`, so errors are sanitized the same
 * way and the key never leaves this process.
 */
import { createHash } from "node:crypto";
import {
  asString,
  detailFromNode,
  isRecord,
  linearGraphql,
  nextPageCursor,
  optionalNumber,
  optionalString,
  type LinearBoardFilter,
  type LinearIssueDetail,
} from "./linear.js";

export type LinearTeamProject = { id: string; name: string; state?: string };
export type LinearTeam = { id: string; key?: string; name: string; projects: LinearTeamProject[] };

export type LinearBoardOptions = {
  teamId: string;
  states: Array<{ id: string; name?: string; type?: string; position?: number }>;
  labels: Array<{ id: string; name?: string; color?: string }>;
  members: Array<{ id: string; name?: string; displayName?: string; email?: string }>;
};

/** Where an issue lives: its team and Linear project. */
export type LinearIssueBoard = {
  id: string;
  identifier?: string;
  teamId?: string;
  projectId?: string;
};

/** How many teams, and projects per team, the picker lists. */
const MAX_TEAMS = 250;
const MAX_TEAM_PROJECTS = 250;
const MAX_OPTIONS = 250;

/**
 * A short fingerprint of a Linear key, so machines can tell whether they hold
 * the same key. 16 hex characters of SHA-256: enough to tell keys apart, far
 * too little to rebuild one.
 */
export function linearKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey.trim()).digest("hex").slice(0, 16);
}

const ISSUE_DETAIL_FIELDS = `
        id
        identifier
        title
        description
        sortOrder
        priority
        prioritySortOrder
        updatedAt
        createdAt
        url
        priorityLabel
        estimate
        state { id name type position }
        team { id key name }
        assignee { id name }
        creator { name }
        project { id name }
        cycle { name }
        labels(first: 25) {
          nodes { id name }
        }`;

function connectionNodes(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.nodes) ? value.nodes : [];
}

function detailWithIds(value: unknown): LinearIssueDetail | null {
  const detail = detailFromNode(value);
  if (!detail || !isRecord(value)) return null;
  const team = isRecord(value.team) ? value.team : {};
  const project = isRecord(value.project) ? value.project : {};
  const state = isRecord(value.state) ? value.state : {};
  const assignee = isRecord(value.assignee) ? value.assignee : {};
  const labelIds = connectionNodes(value.labels)
    .map((node) => (isRecord(node) ? optionalString(node.id) : undefined))
    .filter((id): id is string => Boolean(id));
  return Object.assign(detail, {
    ...(optionalString(team.id) ? { teamId: optionalString(team.id) } : {}),
    ...(optionalString(project.id) ? { projectId: optionalString(project.id) } : {}),
    ...(optionalString(state.id) ? { stateId: optionalString(state.id) } : {}),
    ...(optionalString(assignee.id) ? { assigneeId: optionalString(assignee.id) } : {}),
    ...(optionalNumber(value.estimate) !== undefined
      ? { estimate: optionalNumber(value.estimate) }
      : {}),
    labelIds,
  });
}

/** Every team the key can see, each with its (unarchived) projects. */
export async function listLinearTeams(apiKey: string): Promise<LinearTeam[]> {
  const teams: LinearTeam[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  while (teams.length < MAX_TEAMS) {
    const data: {
      teams?: {
        nodes?: unknown[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    } = await linearGraphql(
      apiKey,
      `query OrkestratorLinearTeams($after: String) {
          teams(first: 50, after: $after) {
            nodes {
              id
              key
              name
              projects(first: ${MAX_TEAM_PROJECTS}) {
                nodes { id name state }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { after: cursor },
    );
    for (const node of data.teams?.nodes ?? []) {
      if (!isRecord(node)) continue;
      const id = asString(node.id);
      const name = asString(node.name);
      if (!id || !name) continue;
      const projects = connectionNodes(node.projects)
        .map((project): LinearTeamProject | null => {
          if (!isRecord(project)) return null;
          const projectId = asString(project.id);
          const projectName = asString(project.name);
          if (!projectId || !projectName) return null;
          const state = optionalString(project.state);
          return { id: projectId, name: projectName, ...(state ? { state } : {}) };
        })
        .filter((project): project is LinearTeamProject => project !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
      const key = optionalString(node.key);
      teams.push({ id, ...(key ? { key } : {}), name, projects });
    }
    const next = nextPageCursor(data.teams?.pageInfo, seen, "teams");
    if (!next) break;
    cursor = next;
  }
  return teams.sort((a, b) => a.name.localeCompare(b.name));
}

/** One team with its projects, for a link's display names; `null` when the key cannot see it. */
export async function getLinearTeam(apiKey: string, teamId: string): Promise<LinearTeam | null> {
  const data = await linearGraphql<{ team?: unknown }>(
    apiKey,
    `query OrkestratorLinearTeam($id: String!) {
      team(id: $id) {
        id
        key
        name
        projects(first: ${MAX_TEAM_PROJECTS}) {
          nodes { id name state }
        }
      }
    }`,
    { id: teamId },
  );
  const team = data.team;
  if (!isRecord(team)) return null;
  const id = asString(team.id);
  const name = asString(team.name);
  if (!id || !name) return null;
  const key = optionalString(team.key);
  return {
    id,
    ...(key ? { key } : {}),
    name,
    projects: connectionNodes(team.projects)
      .map((project) =>
        isRecord(project) && asString(project.id) && asString(project.name)
          ? { id: asString(project.id), name: asString(project.name) }
          : null,
      )
      .filter((project): project is LinearTeamProject => project !== null),
  };
}

/** The workflow states, labels and members a write to `teamId` can use. */
export async function getLinearBoardOptions(
  apiKey: string,
  teamId: string,
): Promise<LinearBoardOptions> {
  const data = await linearGraphql<{ team?: unknown }>(
    apiKey,
    `query OrkestratorLinearBoardOptions($id: String!) {
      team(id: $id) {
        id
        states(first: ${MAX_OPTIONS}) { nodes { id name type position } }
        labels(first: ${MAX_OPTIONS}) { nodes { id name color } }
        members(first: ${MAX_OPTIONS}) { nodes { id name displayName email } }
      }
    }`,
    { id: teamId },
  );
  const team = data.team;
  if (!isRecord(team)) throw new Error("That Linear team is not visible to this key.");
  const states = connectionNodes(team.states)
    .filter(isRecord)
    .filter((state) => asString(state.id))
    .map((state) => ({
      id: asString(state.id),
      ...(optionalString(state.name) ? { name: optionalString(state.name) } : {}),
      ...(optionalString(state.type) ? { type: optionalString(state.type) } : {}),
      ...(optionalNumber(state.position) !== undefined
        ? { position: optionalNumber(state.position) }
        : {}),
    }))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const labels = connectionNodes(team.labels)
    .filter(isRecord)
    .filter((label) => asString(label.id))
    .map((label) => ({
      id: asString(label.id),
      ...(optionalString(label.name) ? { name: optionalString(label.name) } : {}),
      ...(optionalString(label.color) ? { color: optionalString(label.color) } : {}),
    }));
  const members = connectionNodes(team.members)
    .filter(isRecord)
    .filter((member) => asString(member.id))
    .map((member) => ({
      id: asString(member.id),
      ...(optionalString(member.name) ? { name: optionalString(member.name) } : {}),
      ...(optionalString(member.displayName)
        ? { displayName: optionalString(member.displayName) }
        : {}),
      ...(optionalString(member.email) ? { email: optionalString(member.email) } : {}),
    }));
  return { teamId: asString(team.id) || teamId, states, labels, members };
}

/** Which team and project an issue (by id or identifier such as `ENG-123`) is on. */
export async function getLinearIssueBoard(
  apiKey: string,
  issueId: string,
): Promise<LinearIssueBoard | null> {
  const data = await linearGraphql<{ issue?: unknown }>(
    apiKey,
    `query OrkestratorLinearIssueBoard($id: String!) {
      issue(id: $id) {
        id
        identifier
        team { id }
        project { id }
      }
    }`,
    { id: issueId },
  );
  const issue = data.issue;
  if (!isRecord(issue) || !asString(issue.id)) return null;
  const team = isRecord(issue.team) ? issue.team : {};
  const project = isRecord(issue.project) ? issue.project : {};
  return {
    id: asString(issue.id),
    ...(optionalString(issue.identifier) ? { identifier: optionalString(issue.identifier) } : {}),
    ...(optionalString(team.id) ? { teamId: optionalString(team.id) } : {}),
    ...(optionalString(project.id) ? { projectId: optionalString(project.id) } : {}),
  };
}

/** Whether an issue is on a board: its team, and the board's project when it names one. */
export function issueIsOnBoard(issue: LinearIssueBoard, board: LinearBoardFilter): boolean {
  if (issue.teamId !== board.teamId) return false;
  return !board.linearProjectId || issue.projectId === board.linearProjectId;
}

/** One issue with the ids a write needs (state, assignee, labels, team, project). */
export async function getLinearIssueWithIds(
  apiKey: string,
  issueId: string,
): Promise<LinearIssueDetail> {
  const data = await linearGraphql<{ issue?: unknown }>(
    apiKey,
    `query OrkestratorLinearIssueWithIds($id: String!) {
      issue(id: $id) {${ISSUE_DETAIL_FIELDS}
      }
    }`,
    { id: issueId },
  );
  const issue = detailWithIds(data.issue);
  if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
  return issue;
}

export type LinearIssueCreateInput = {
  title: string;
  description?: string;
  priority?: number;
  stateId?: string;
  assigneeId?: string;
  labelIds?: readonly string[];
  estimate?: number;
};

/** Creates an issue on a board (its team, and its project when it names one). */
export async function createLinearIssue(
  apiKey: string,
  board: LinearBoardFilter,
  input: LinearIssueCreateInput,
): Promise<LinearIssueDetail> {
  const title = input.title.trim();
  if (!title) throw new Error("A Linear issue needs a title.");
  const data = await linearGraphql<{ issueCreate?: { success?: boolean; issue?: unknown } }>(
    apiKey,
    `mutation OrkestratorLinearIssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {${ISSUE_DETAIL_FIELDS}
        }
      }
    }`,
    {
      input: {
        teamId: board.teamId,
        title,
        ...(board.linearProjectId ? { projectId: board.linearProjectId } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.stateId ? { stateId: input.stateId } : {}),
        ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
        ...(input.labelIds?.length ? { labelIds: [...input.labelIds] } : {}),
        ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
      },
    },
  );
  const issue = detailWithIds(data.issueCreate?.issue);
  if (!data.issueCreate?.success || !issue) {
    throw new Error("Linear did not confirm the issue was created.");
  }
  return issue;
}

export type LinearIssueUpdateInput = {
  title?: string;
  description?: string;
  priority?: number;
  stateId?: string;
  assigneeId?: string | null;
  addedLabelIds?: readonly string[];
  removedLabelIds?: readonly string[];
  estimate?: number | null;
};

/** The `IssueUpdateInput` for the fields given; empty when nothing would change. */
export function linearIssueUpdateFields(input: LinearIssueUpdateInput): Record<string, unknown> {
  return {
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.stateId ? { stateId: input.stateId } : {}),
    ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    ...(input.addedLabelIds?.length ? { addedLabelIds: [...input.addedLabelIds] } : {}),
    ...(input.removedLabelIds?.length ? { removedLabelIds: [...input.removedLabelIds] } : {}),
    ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
  };
}

/** Changes the named fields of an issue. */
export async function updateLinearIssue(
  apiKey: string,
  issueId: string,
  input: LinearIssueUpdateInput,
): Promise<LinearIssueDetail> {
  const fields = linearIssueUpdateFields(input);
  if (Object.keys(fields).length === 0) throw new Error("Nothing to change on the Linear issue.");
  if (fields.title === "") throw new Error("A Linear issue needs a title.");
  const data = await linearGraphql<{ issueUpdate?: { success?: boolean; issue?: unknown } }>(
    apiKey,
    `mutation OrkestratorLinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {${ISSUE_DETAIL_FIELDS}
        }
      }
    }`,
    { id: issueId, input: fields },
  );
  const issue = detailWithIds(data.issueUpdate?.issue);
  if (!data.issueUpdate?.success || !issue) {
    throw new Error("Linear did not confirm the issue was updated.");
  }
  return issue;
}
