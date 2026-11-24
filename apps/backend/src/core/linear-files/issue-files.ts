/**
 * The files one Linear issue refers to, read live from Linear: links in its
 * description and comments, and attachments that Linear hosts itself.
 */
import { createHash } from "node:crypto";
import {
  linearFileLinks,
  linearFileReferences,
  linearFileUrl,
  type LinearFileReference,
} from "@orkestrator/protocol/linear-files";
import { issueIsOnBoard, type LinearIssueBoard } from "../linear-boards.js";
import {
  asString,
  isRecord,
  linearGraphql,
  nextPageCursor,
  optionalString,
  type LinearBoardFilter,
} from "../linear.js";

/**
 * With this header Linear adds a signature to every file link it returns, so
 * a browser can fetch the file without the key until it expires.
 */
const SIGNED_LINKS_HEADER = "public-file-urls-expire-in";

/** Bounds each issue connection read. An incomplete read cannot authorize files. */
const MAX_CONNECTION_PAGES = 10;

export interface LinearIssueFile extends LinearFileReference {
  /** The short-lived link, only when signed links were asked for. */
  signedUrl?: string;
}

export interface LinearIssueFiles {
  issueId: string;
  identifier?: string;
  board: LinearIssueBoard;
  files: LinearIssueFile[];
}

interface IssueConnection {
  nodes?: unknown[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

const COMMENTS = `comments(first: 100, after: $after) {
          nodes { body }
          pageInfo { hasNextPage endCursor }
        }`;
const ATTACHMENTS = `attachments(first: 50, after: $after) {
          nodes { title url }
          pageInfo { hasNextPage endCursor }
        }`;
const ISSUE_CONNECTIONS = { comments: COMMENTS, attachments: ATTACHMENTS } as const;

function connectionTexts(field: keyof typeof ISSUE_CONNECTIONS, connection: IssueConnection) {
  return (Array.isArray(connection.nodes) ? connection.nodes : []).flatMap((node) => {
    if (!isRecord(node)) return [];
    if (field === "comments") return typeof node.body === "string" ? [node.body] : [];
    const url = asString(node.url);
    const title = asString(node.title)
      .replace(/[[\]\\\r\n]/g, " ")
      .slice(0, 300);
    return linearFileUrl(url) ? [`[${title}](${url})`] : [];
  });
}

async function readConnectionTexts(
  issue: Record<string, unknown>,
  field: keyof typeof ISSUE_CONNECTIONS,
  apiKey: string,
  signal: AbortSignal | undefined,
  headers: Record<string, string>,
): Promise<string[]> {
  const texts: string[] = [];
  let value = issue[field];
  const seenCursors = new Set<string>();
  for (let page = 0; isRecord(value); page += 1) {
    const connection = value as IssueConnection;
    texts.push(...connectionTexts(field, connection));
    const after = nextPageCursor(connection.pageInfo, seenCursors, `issue ${field}`);
    if (!after) break;
    if (page + 1 >= MAX_CONNECTION_PAGES) {
      throw new Error(`The Linear issue has too many ${field} to check file membership.`);
    }
    const next = await linearGraphql<{ issue?: unknown }>(
      apiKey,
      `query OrkestratorLinearIssueFilePage($id: String!, $after: String) {
        issue(id: $id) { ${ISSUE_CONNECTIONS[field]} }
      }`,
      { id: asString(issue.id), after },
      signal,
      headers,
    );
    value = isRecord(next.issue) ? next.issue[field] : undefined;
    if (!isRecord(value)) throw new Error(`Linear did not return the next page of ${field}.`);
  }
  return texts;
}

/** Signed links by canonical link; text holds at most one per file. */
function signedLinks(text: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const { url, link } of linearFileLinks(text)) {
    if (link.includes("?") && !links.has(url)) links.set(url, link);
  }
  return links;
}

/** Reads an issue's files. `signedSeconds` also returns a link anyone can open until then. */
export async function readLinearIssueFiles(
  apiKey: string,
  issueId: string,
  options: { signedSeconds?: number; signal?: AbortSignal } = {},
): Promise<LinearIssueFiles> {
  const headers: Record<string, string> =
    options.signedSeconds === undefined
      ? {}
      : { [SIGNED_LINKS_HEADER]: String(options.signedSeconds) };
  const data = await linearGraphql<{ issue?: unknown }>(
    apiKey,
    `query OrkestratorLinearIssueFiles($id: String!, $after: String) {
      issue(id: $id) {
        id
        identifier
        description
        team { id }
        project { id }
        ${ATTACHMENTS}
        ${COMMENTS}
      }
    }`,
    { id: issueId, after: null },
    options.signal,
    headers,
  );
  const issue = data.issue;
  if (!isRecord(issue) || !asString(issue.id))
    throw new Error(`Linear issue not found: ${issueId}`);

  const [attachments, comments] = await Promise.all([
    readConnectionTexts(issue, "attachments", apiKey, options.signal, headers),
    readConnectionTexts(issue, "comments", apiKey, options.signal, headers),
  ]);
  const text = [...attachments, asString(issue.description), ...comments].join("\n\n");
  const signed = options.signedSeconds === undefined ? null : signedLinks(text);
  const files = linearFileReferences(text).map((file): LinearIssueFile => {
    const signedUrl = signed?.get(file.url);
    return { ...file, ...(signedUrl ? { signedUrl } : {}) };
  });

  const team = isRecord(issue.team) ? issue.team : {};
  const project = isRecord(issue.project) ? issue.project : {};
  const identifier = optionalString(issue.identifier);
  const teamId = optionalString(team.id);
  const projectId = optionalString(project.id);
  return {
    issueId: asString(issue.id),
    ...(identifier ? { identifier } : {}),
    board: {
      id: asString(issue.id),
      ...(identifier ? { identifier } : {}),
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
    },
    files,
  };
}

export function issueFilesAreOnBoard(issue: LinearIssueFiles, board: LinearBoardFilter): boolean {
  return issueIsOnBoard(issue.board, board);
}

/** A file or directory name safe on every platform, or "" when nothing is left of it. */
export function safeFileName(value: string, max = 120): string {
  const safe = value
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  if (Buffer.byteLength(safe) <= max) return safe;
  const dot = safe.lastIndexOf(".");
  const suffix = dot > 0 ? safe.slice(dot) : "";
  const extension = Buffer.byteLength(suffix) <= Math.min(12, max) ? suffix : "";
  let remaining = max - Buffer.byteLength(extension);
  let prefix = "";
  for (const character of safe) {
    remaining -= Buffer.byteLength(character);
    if (remaining < 0) break;
    prefix += character;
  }
  return prefix + extension;
}

/** Stable across label edits and file host response changes. */
export function linearFileName(url: string): string {
  const pathname = new URL(url).pathname;
  let segment = pathname.slice(pathname.lastIndexOf("/") + 1);
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // Use the encoded URL segment when it contains malformed escapes.
  }
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return `${hash}-${safeFileName(segment) || "file"}`;
}
