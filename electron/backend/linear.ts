type LinearGraphQLError = {
  message?: string;
};

type LinearGraphQLResponse<T> = {
  data?: T;
  errors?: LinearGraphQLError[];
};

export type LinearViewer = {
  id: string;
  name: string;
  email?: string;
};

export type LinearConnectionStatus = {
  connected: boolean;
  hasToken: boolean;
  viewer?: LinearViewer;
  error?: string;
};

export type LinearIssueListItem = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  statusType?: string;
  sortOrder?: number;
  updatedAt: string;
  createdAt?: string;
  url?: string;
  teamKey?: string;
  teamName?: string;
  assigneeName?: string;
  priorityLabel?: string;
};

export type LinearIssueComment = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
  authorName?: string;
};

export type LinearIssueDetail = LinearIssueListItem & {
  description: string;
  creatorName?: string;
  projectName?: string;
  cycleName?: string;
  labels: string[];
  comments: LinearIssueComment[];
};

export type LinearCompletionCommentResult = {
  status: "posted" | "already-posted";
  commentId: string;
  postedAt?: string;
};

type LinearIssuesResponse = {
  issues?: {
    nodes?: unknown[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  };
};

type LinearCommentsResponse = {
  issue?: {
    comments?: {
      nodes?: unknown[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  } | null;
};

type LinearCommentCreateResponse = {
  commentCreate?: {
    success?: boolean;
    comment?: unknown;
  };
};

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nextPageCursor(
  pageInfo: { hasNextPage?: boolean; endCursor?: string | null } | undefined,
  seenCursors: Set<string>,
  resourceName: string,
): string | null {
  if (!pageInfo?.hasNextPage) return null;
  const cursor = pageInfo.endCursor;
  if (!cursor) throw new Error(`Linear ${resourceName} pagination did not return a cursor`);
  if (seenCursors.has(cursor)) throw new Error(`Linear ${resourceName} pagination cursor repeated`);
  seenCursors.add(cursor);
  return cursor;
}

export function sanitizeLinearError(error: unknown, secret?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  let sanitized = raw
    .replace(/lin_api_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");

  const trimmedSecret = secret?.trim();
  if (trimmedSecret) {
    sanitized = sanitized.split(trimmedSecret).join("[redacted]");
  }

  return sanitized || "Linear request failed";
}

async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = apiKey.trim();
  if (!token) throw new Error("Linear API key is not configured");

  let response: Response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new Error(sanitizeLinearError(error, token));
  }

  let payload: LinearGraphQLResponse<T>;
  try {
    payload = await response.json() as LinearGraphQLResponse<T>;
  } catch {
    throw new Error(`Linear returned HTTP ${response.status}`);
  }

  if (!response.ok) {
    const message = payload.errors?.map((item) => item.message).filter(Boolean).join("; ");
    throw new Error(message || `Linear returned HTTP ${response.status}`);
  }

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message || "GraphQL error").join("; "));
  }

  if (!payload.data) throw new Error("Linear returned an empty response");
  return payload.data;
}

function readViewer(value: unknown): LinearViewer | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const name = asString(value.name);
  if (!id || !name) return undefined;
  return { id, name, email: optionalString(value.email) };
}

function issueFromNode(value: unknown): LinearIssueListItem | null {
  if (!isRecord(value)) return null;

  const state = isRecord(value.state) ? value.state : {};
  const team = isRecord(value.team) ? value.team : {};
  const assignee = isRecord(value.assignee) ? value.assignee : {};

  const id = asString(value.id);
  const identifier = asString(value.identifier);
  const title = asString(value.title);
  const updatedAt = asString(value.updatedAt);
  if (!id || !identifier || !title || !updatedAt) return null;

  return {
    id,
    identifier,
    title,
    status: asString(state.name, "No status"),
    statusType: optionalString(state.type),
    sortOrder: optionalNumber(value.sortOrder),
    updatedAt,
    createdAt: optionalString(value.createdAt),
    url: optionalString(value.url),
    teamKey: optionalString(team.key),
    teamName: optionalString(team.name),
    assigneeName: optionalString(assignee.name),
    priorityLabel: optionalString(value.priorityLabel),
  };
}

function detailFromNode(value: unknown): LinearIssueDetail | null {
  const listItem = issueFromNode(value);
  if (!listItem || !isRecord(value)) return null;

  const creator = isRecord(value.creator) ? value.creator : {};
  const project = isRecord(value.project) ? value.project : {};
  const cycle = isRecord(value.cycle) ? value.cycle : {};
  const labelsConnection = isRecord(value.labels) ? value.labels : {};
  const labelNodes = Array.isArray(labelsConnection.nodes) ? labelsConnection.nodes : [];
  const labels = labelNodes
    .map((node) => isRecord(node) ? optionalString(node.name) : undefined)
    .filter((label): label is string => !!label);

  return {
    ...listItem,
    description: asString(value.description),
    creatorName: optionalString(creator.name),
    projectName: optionalString(project.name),
    cycleName: optionalString(cycle.name),
    labels,
    comments: [],
  };
}

function commentFromNode(value: unknown): LinearIssueComment | null {
  if (!isRecord(value)) return null;

  const user = isRecord(value.user) ? value.user : {};
  const id = asString(value.id);
  const body = asString(value.body);
  const createdAt = asString(value.createdAt);
  if (!id || !createdAt) return null;

  return {
    id,
    body,
    createdAt,
    updatedAt: optionalString(value.updatedAt),
    authorName: optionalString(user.name),
  };
}

function compareLinearCommentPosition(a: LinearIssueComment, b: LinearIssueComment): number {
  const createdAtDelta = a.createdAt.localeCompare(b.createdAt);
  if (createdAtDelta !== 0) return createdAtDelta;
  return a.id.localeCompare(b.id);
}

function compareLinearIssuePosition(a: LinearIssueListItem, b: LinearIssueListItem): number {
  if (a.sortOrder !== undefined && b.sortOrder !== undefined && a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }
  if (a.sortOrder !== undefined && b.sortOrder === undefined) return -1;
  if (a.sortOrder === undefined && b.sortOrder !== undefined) return 1;
  const updatedAtDelta = b.updatedAt.localeCompare(a.updatedAt);
  if (updatedAtDelta !== 0) return updatedAtDelta;
  return a.identifier.localeCompare(b.identifier);
}

export async function verifyLinearConnection(apiKey: string): Promise<LinearViewer> {
  const data = await linearGraphql<{ viewer: unknown }>(
    apiKey,
    `query OrkestratorLinearViewer {
      viewer {
        id
        name
        email
      }
    }`,
  );
  const viewer = readViewer(data.viewer);
  if (!viewer) throw new Error("Linear viewer response was incomplete");
  return viewer;
}

export async function listLinearIssues(apiKey: string): Promise<LinearIssueListItem[]> {
  const issues: LinearIssueListItem[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  while (true) {
    const data: LinearIssuesResponse = await linearGraphql<LinearIssuesResponse>(
      apiKey,
      `query OrkestratorLinearIssues($after: String) {
        issues(first: 100, after: $after, sort: [{ manual: { order: Ascending } }]) {
          nodes {
            id
            identifier
            title
            sortOrder
            updatedAt
            createdAt
            url
            priorityLabel
            state { name type }
            team { key name }
            assignee { name }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { after: cursor },
    );

    const nodes = Array.isArray(data.issues?.nodes) ? data.issues.nodes : [];
    for (const node of nodes) {
      const issue = issueFromNode(node);
      if (issue) issues.push(issue);
    }

    const nextCursor = nextPageCursor(data.issues?.pageInfo, seenCursors, "issues");
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return issues.sort(compareLinearIssuePosition);
}

export async function getLinearIssue(apiKey: string, issueId: string): Promise<LinearIssueDetail> {
  const data = await linearGraphql<{ issue: unknown }>(
    apiKey,
    `query OrkestratorLinearIssue($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        sortOrder
        updatedAt
        createdAt
        url
        priorityLabel
        state { name type }
        team { key name }
        assignee { name }
        creator { name }
        project { name }
        cycle { name }
        labels(first: 25) {
          nodes { name }
        }
      }
    }`,
    { id: issueId },
  );

  const issue = detailFromNode(data.issue);
  if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
  return {
    ...issue,
    comments: await listLinearIssueComments(apiKey, issueId),
  };
}

export async function listLinearIssueComments(apiKey: string, issueId: string): Promise<LinearIssueComment[]> {
  const comments: LinearIssueComment[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  while (true) {
    const data: LinearCommentsResponse = await linearGraphql<LinearCommentsResponse>(
      apiKey,
      `query OrkestratorLinearIssueComments($id: String!, $after: String) {
        issue(id: $id) {
          comments(first: 100, after: $after) {
            nodes {
              id
              body
              createdAt
              updatedAt
              user { name }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }`,
      { id: issueId, after: cursor },
    );

    const nodes = Array.isArray(data.issue?.comments?.nodes) ? data.issue.comments.nodes : [];
    for (const node of nodes) {
      const comment = commentFromNode(node);
      if (comment) comments.push(comment);
    }

    const nextCursor = nextPageCursor(data.issue?.comments?.pageInfo, seenCursors, "comments");
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return comments.sort(compareLinearCommentPosition);
}

async function findExistingCompletionComment(
  apiKey: string,
  issueId: string,
  marker: string,
): Promise<{ id: string; createdAt?: string } | null> {
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  while (true) {
    const data: LinearCommentsResponse = await linearGraphql<LinearCommentsResponse>(
      apiKey,
      `query OrkestratorLinearCompletionComments($id: String!, $after: String) {
        issue(id: $id) {
          comments(first: 100, after: $after) {
            nodes {
              id
              body
              createdAt
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }`,
      { id: issueId, after: cursor },
    );

    const nodes = Array.isArray(data.issue?.comments?.nodes) ? data.issue.comments.nodes : [];
    for (const node of nodes) {
      if (!isRecord(node)) continue;
      if (asString(node.body).includes(marker)) {
        const id = asString(node.id);
        if (id) return { id, createdAt: optionalString(node.createdAt) };
      }
    }

    const nextCursor = nextPageCursor(data.issue?.comments?.pageInfo, seenCursors, "comments");
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return null;
}

export async function postLinearIssueComment(
  apiKey: string,
  params: {
    issueId: string;
    body: string;
  },
): Promise<LinearIssueComment> {
  const body = params.body.trim();
  if (!body) throw new Error("Linear comment body is required");

  const data = await linearGraphql<LinearCommentCreateResponse>(
    apiKey,
    `mutation OrkestratorLinearIssueComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment {
          id
          body
          createdAt
          updatedAt
          user { name }
        }
      }
    }`,
    { issueId: params.issueId, body },
  );

  const comment = commentFromNode(data.commentCreate?.comment);
  if (!data.commentCreate?.success || !comment) {
    throw new Error("Linear did not confirm comment creation");
  }

  return comment;
}

export async function postLinearCompletionComment(
  apiKey: string,
  params: {
    pipelineId: string;
    issueId: string;
    body: string;
  },
): Promise<LinearCompletionCommentResult> {
  const marker = `<!-- orkestrator-linear-run:${params.pipelineId} -->`;
  const existing = await findExistingCompletionComment(apiKey, params.issueId, marker);
  if (existing) {
    return { status: "already-posted", commentId: existing.id, postedAt: existing.createdAt };
  }

  const body = `${params.body.trim()}\n\n${marker}`;
  const data = await linearGraphql<{
    commentCreate?: {
      success?: boolean;
      comment?: { id?: string; createdAt?: string };
    };
  }>(
    apiKey,
    `mutation OrkestratorLinearCompletionComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment {
          id
          createdAt
        }
      }
    }`,
    { issueId: params.issueId, body },
  );

  const commentId = data.commentCreate?.comment?.id;
  if (!data.commentCreate?.success || !commentId) {
    throw new Error("Linear did not confirm comment creation");
  }

  return {
    status: "posted",
    commentId,
    postedAt: data.commentCreate.comment?.createdAt,
  };
}
