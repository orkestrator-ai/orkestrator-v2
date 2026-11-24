/**
 * The files one Linear issue refers to, read live from Linear: links in its
 * description and comments, and attachments that Linear hosts itself.
 */
import { createHash } from "node:crypto";
import {
  linearFileReferences,
  linearFileUrl,
  MAX_LINEAR_ISSUE_FILES,
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

/** Comment pages of 100: more than any issue a person reads has. */
const MAX_COMMENT_PAGES = 10;

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

interface CommentConnection {
  nodes?: unknown[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

const COMMENTS = `comments(first: 100, after: $after) {
          nodes { body }
          pageInfo { hasNextPage endCursor }
        }`;

function commentBodies(connection: CommentConnection | undefined): string[] {
  return (connection?.nodes ?? []).flatMap((node) =>
    isRecord(node) && typeof node.body === "string" ? [node.body] : [],
  );
}

function connectionOf(value: unknown): CommentConnection | undefined {
  return isRecord(value) ? (value as CommentConnection) : undefined;
}

/** Signed links by canonical link; text holds at most one per file. */
function signedLinks(text: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const match of text.matchAll(/https:\/\/uploads\.linear\.app\/[^\s<>()[\]"'`\\]+/gi)) {
    const url = linearFileUrl(match[0]);
    if (url && match[0].includes("?") && !links.has(url)) links.set(url, match[0]);
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
        attachments(first: 50) { nodes { title url } }
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

  const texts = [asString(issue.description)];
  let connection = connectionOf(issue.comments);
  texts.push(...commentBodies(connection));
  const seenCursors = new Set<string>();
  for (let page = 1; page < MAX_COMMENT_PAGES; page += 1) {
    const after = nextPageCursor(connection?.pageInfo, seenCursors, "issue comments");
    if (!after) break;
    const next = await linearGraphql<{ issue?: unknown }>(
      apiKey,
      `query OrkestratorLinearIssueFileComments($id: String!, $after: String) {
        issue(id: $id) { ${COMMENTS} }
      }`,
      { id: issueId, after },
      options.signal,
      headers,
    );
    connection = isRecord(next.issue) ? connectionOf(next.issue.comments) : undefined;
    texts.push(...commentBodies(connection));
  }

  const attachments = isRecord(issue.attachments) ? issue.attachments.nodes : undefined;
  for (const node of Array.isArray(attachments) ? attachments : []) {
    if (!isRecord(node) || !linearFileUrl(asString(node.url))) continue;
    const title = asString(node.title).replace(/[[\]\\\r\n]/g, " ");
    texts.push(`[${title}](${asString(node.url)})`);
  }

  const text = texts.join("\n\n");
  const signed = options.signedSeconds === undefined ? null : signedLinks(text);
  const files = linearFileReferences(text)
    .slice(0, MAX_LINEAR_ISSUE_FILES)
    .map((file): LinearIssueFile => {
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
  if (safe.length <= max) return safe;
  const dot = safe.lastIndexOf(".");
  const extension = dot > 0 && safe.length - dot <= 12 ? safe.slice(dot) : "";
  return `${safe.slice(0, max - extension.length)}${extension}`;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

function hasExtension(name: string): boolean {
  return /\.[A-Za-z0-9]{1,10}$/.test(name);
}

/**
 * The name a downloaded file gets: the link's own text when it names a file,
 * else what Linear answered, behind a short hash of the link. The hash keeps
 * two `image.png` of one issue apart and gives a file the same name each time.
 */
export function linearFileName(
  file: LinearFileReference,
  answered: { filename?: string; contentType?: string },
): string {
  const label = safeFileName(file.name ?? "");
  const sent = safeFileName(answered.filename ?? "");
  const base = hasExtension(label) ? label : hasExtension(sent) ? sent : label || sent || "file";
  const type = answered.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const name = hasExtension(base) ? base : `${base}${EXTENSIONS[type] ?? ""}`;
  const hash = createHash("sha256").update(file.url).digest("hex").slice(0, 8);
  return `${hash}-${name}`;
}
