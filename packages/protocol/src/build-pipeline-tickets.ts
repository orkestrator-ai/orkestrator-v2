/**
 * How a ticket from each source becomes the start of a build.
 *
 * A build quotes a frozen snapshot of its ticket in every stage prompt, links
 * the source so the pipeline can move it through its lifecycle, and names its
 * environment from a short prompt. The renderer's Build buttons (Kanban,
 * Linear, GitHub), the backend's feature-plan build and the public
 * `build.launch` action all derive those three things from a ticket, so the
 * mapping lives here once: a build started from the CLI quotes its ticket
 * exactly as one started from the Build button does.
 *
 * Images are not fetched here. Each side reads them where it can (the renderer
 * over the command bridge, the backend from storage) and passes the result in.
 */
import type { BuildPipelineSource, TaskSnapshot, TaskSnapshotImage } from "./build-pipeline.js";

/** What a build needs from its ticket, whatever the ticket's source. */
export interface BuildPipelineTicket {
  /** The pipeline's `taskId`: the ticket id, or a source-qualified id. */
  id: string;
  projectId: string;
  title: string;
  taskSnapshot: TaskSnapshot;
  source: BuildPipelineSource;
  namingPrompt: string;
}

/** The Kanban ticket fields a build snapshot quotes. */
export interface KanbanBuildTicketFields {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: ReadonlyArray<{ text: string }>;
}

/** The Linear issue fields a build snapshot quotes. */
export interface LinearBuildIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status?: string;
  url?: string;
  teamKey?: string;
  updatedAt?: string;
  comments: ReadonlyArray<{ body: string; authorName?: string }>;
}

export interface GitHubIssueBuildComment {
  id: string | number;
  body: string;
  authorLogin?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** The GitHub issue fields a build snapshot quotes. */
export interface GitHubIssueBuildInput {
  repositoryOwner: string;
  repositoryName: string;
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
  status: string;
  comments: GitHubIssueBuildComment[];
  authorLogin?: string;
  assigneeLogins?: string[];
  createdAt?: string;
  updatedAt?: string;
}

function joinPrompt(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter(Boolean).join("\n\n");
}

/**
 * A Kanban ticket, as the Build button snapshots it. `images` are the ticket's
 * images the caller could read; an unreadable one is simply left out.
 */
export function kanbanTaskBuildTicket(
  task: KanbanBuildTicketFields,
  images: readonly TaskSnapshotImage[] = [],
): BuildPipelineTicket {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    namingPrompt: joinPrompt([task.title, task.description, task.acceptanceCriteria]),
    // Linking the source moves the ticket through its lifecycle and attaches
    // the environment to it.
    source: { type: "kanban", taskId: task.id },
    taskSnapshot: {
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      comments: task.comments.map((comment) => ({ text: comment.text })),
      images: images.map((image) => ({ filename: image.filename, data: image.data })),
    },
  };
}

/**
 * A Linear issue. Its identifier, URL and status lead the comments so every
 * stage can cite the issue; `includeComments` false keeps only those.
 */
export function linearIssueBuildTicket(
  issue: LinearBuildIssue,
  projectId: string,
  includeComments = true,
): BuildPipelineTicket {
  const comments = [
    { text: `Linear issue: ${issue.identifier}` },
    ...(issue.url ? [{ text: `URL: ${issue.url}` }] : []),
    ...(issue.status ? [{ text: `Status: ${issue.status}` }] : []),
    ...(includeComments ? issue.comments : []).map((comment) => ({
      text: comment.authorName ? `${comment.authorName}: ${comment.body}` : comment.body,
    })),
  ];
  const title = `${issue.identifier}: ${issue.title}`;
  return {
    id: issue.id,
    projectId,
    title,
    namingPrompt: joinPrompt([issue.identifier, issue.title, issue.description, issue.status]),
    source: {
      type: "linear",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      ...(issue.url !== undefined ? { issueUrl: issue.url } : {}),
      ...(issue.status !== undefined ? { status: issue.status } : {}),
      ...(issue.teamKey !== undefined ? { teamKey: issue.teamKey } : {}),
      ...(issue.updatedAt !== undefined ? { updatedAt: issue.updatedAt } : {}),
    },
    taskSnapshot: {
      title,
      description: issue.description,
      acceptanceCriteria: "",
      comments,
      images: [],
    },
  };
}

/** The pipeline task id of a GitHub issue: `github:<owner>/<repo>#<number>`, lowercased. */
export function githubIssueBuildTaskId(issue: {
  repositoryOwner: string;
  repositoryName: string;
  number: number;
}): string {
  return `github:${`${issue.repositoryOwner}/${issue.repositoryName}`.toLowerCase()}#${issue.number}`;
}

/** A GitHub issue. Comments are attributed with the author's `@login`. */
export function githubIssueBuildTicket(
  issue: GitHubIssueBuildInput,
  projectId: string,
): BuildPipelineTicket {
  const repository = `${issue.repositoryOwner}/${issue.repositoryName}`;
  const title = `#${issue.number}: ${issue.title}`;
  return {
    id: githubIssueBuildTaskId(issue),
    projectId,
    title,
    namingPrompt: joinPrompt([
      `GitHub issue ${repository}#${issue.number}`,
      issue.title,
      issue.body,
      issue.status,
    ]),
    source: {
      type: "github",
      repositoryOwner: issue.repositoryOwner,
      repositoryName: issue.repositoryName,
      issueNumber: issue.number,
      issueUrl: issue.url,
      status: issue.status,
      ...(issue.updatedAt !== undefined ? { updatedAt: issue.updatedAt } : {}),
    },
    taskSnapshot: {
      title,
      description: issue.body,
      acceptanceCriteria: "",
      comments: issue.comments.map((comment) => ({
        text: `${comment.authorLogin ? `@${comment.authorLogin}: ` : ""}${comment.body}`,
      })),
      images: [],
    },
  };
}
