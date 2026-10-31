import type {
  GitHubPullRequestFile,
  GitHubPullRequestReviewThread,
  GitHubPullRequestTimelineItem,
} from "@orkestrator/protocol/github-pull-requests";
import type { PublicActionName } from "@orkestrator/protocol/public-api";
import {
  PUBLIC_PR_BODY_MAX_CHARS,
  PUBLIC_PR_LIST_FILTERS,
  PUBLIC_PR_MERGE_METHODS,
  PUBLIC_PR_REVIEW_EVENTS,
  PUBLIC_PR_REVIEW_COMMENTS_MAX,
  PUBLIC_PR_SIDES,
} from "@orkestrator/protocol/public-api-inputs-pr";
import { CliError } from "../errors.js";
import { keyValues, table } from "../format.js";
import { readTextSource } from "../inputs.js";
import type { CommandContext, CommandOutcome, CommandSpec, OptionSpec } from "../spec.js";
import { oneOf, REQUEST_ID_OPTION, stringOption, submit } from "./common.js";

/**
 * `pr get|list|timeline|files|options` and the pull request's own changes:
 * `pr merge|close|reopen|ready|draft`, comments, reviews, threads, reviewers
 * and labels. Each acts on the pull request attached to the named environment
 * (`pr list` on a project), like the app's Merge buttons and pull request
 * viewer. `pr merge`, `pr close` and `pr review` need `--yes`, the CLI's form
 * of Control MCP's confirm token.
 */

type Input = Record<string, unknown>;
type Parsed = Parameters<CommandSpec["run"]>[1];

const ENVIRONMENT = { name: "environment", required: true, description: "Its pull request." };
const YES_OPTION: OptionSpec = {
  name: "yes",
  kind: "boolean",
  description: "Confirm this change on GitHub. Required.",
};
const BODY_OPTIONS: OptionSpec[] = [
  { name: "body", kind: "string", valueName: "TEXT", description: "Inline Markdown text." },
  {
    name: "body-file",
    kind: "string",
    valueName: "PATH",
    description: "Read the text from a local file.",
  },
];
const INLINE_OPTIONS: OptionSpec[] = [
  { name: "path", kind: "string", valueName: "PATH", description: "Changed file." },
  { name: "line", kind: "string", valueName: "N", description: "Line of the comment." },
  { name: "side", kind: "string", valueName: "SIDE", description: "RIGHT (new) or LEFT (old)." },
  { name: "start-line", kind: "string", valueName: "N", description: "First line of a range." },
];

function requireYes(parsed: Parsed, what: string): void {
  if (parsed.options.yes !== true) {
    throw new CliError("invalid-input", `${what}; pass --yes to confirm`);
  }
}

function requiredOption(parsed: Parsed, name: string): string {
  const value = stringOption(parsed.options, name);
  if (!value) throw new CliError("invalid-input", `--${name} is required`);
  return value;
}

function integerOption(parsed: Parsed, name: string): number | undefined {
  const value = stringOption(parsed.options, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new CliError("invalid-input", `--${name} must be a positive integer`);
  }
  return number;
}

function requiredInteger(parsed: Parsed, name: string): number {
  const number = integerOption(parsed, name);
  if (number === undefined) throw new CliError("invalid-input", `--${name} is required`);
  return number;
}

async function bodyText(
  context: CommandContext,
  parsed: Parsed,
  required: boolean,
): Promise<string | undefined> {
  const body = await readTextSource(context.io, {
    file: parsed.options["body-file"],
    inline: parsed.options.body,
    label: "Body",
    maxBytes: PUBLIC_PR_BODY_MAX_CHARS * 4,
    names: { file: "--body-file", stdin: "", inline: "--body" },
    required,
  });
  if (body !== undefined && body.length > PUBLIC_PR_BODY_MAX_CHARS) {
    throw new CliError(
      "input-too-large",
      `Body is longer than ${PUBLIC_PR_BODY_MAX_CHARS} characters`,
    );
  }
  return body;
}

function repeatedList(value: unknown): string[] {
  return typeof value === "string"
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function changeHuman(result: Input): string[] {
  return keyValues(
    Object.entries(result).filter(
      ([key, value]) => key !== "environmentId" && typeof value !== "object",
    ),
  );
}

/** A change to the environment's pull request. */
function change(
  name: string,
  action: PublicActionName,
  summary: string,
  options: OptionSpec[],
  input: (context: CommandContext, parsed: Parsed) => Input | Promise<Input>,
  extras: Partial<CommandSpec> = {},
): CommandSpec {
  return {
    path: ["pr", name],
    action,
    summary,
    positionals: [ENVIRONMENT],
    options: [...options, REQUEST_ID_OPTION],
    idOutput: "pull request URL",
    async run(context, parsed): Promise<CommandOutcome> {
      const environmentId = parsed.positionals.environment as string;
      const { session, result, receipt, warnings } = await submit<Input>(
        context,
        action,
        { environmentId, ...(await input(context, parsed)) },
        parsed.options,
      );
      return {
        action,
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: typeof result.url === "string" ? [result.url] : [],
        human: changeHuman(result),
      };
    },
    ...extras,
  };
}

/** A read of the environment's pull request. */
function read(
  name: string,
  action: PublicActionName,
  summary: string,
  options: OptionSpec[],
  input: (parsed: Parsed) => Input,
  human: (result: Input) => string[],
): CommandSpec {
  return {
    path: ["pr", name],
    action,
    summary,
    positionals: [ENVIRONMENT],
    options,
    async run(context, parsed) {
      const session = await context.session();
      const result = await session.read<Input>(action, {
        environmentId: parsed.positionals.environment,
        ...input(parsed),
      });
      return { action, result, connection: session.identity, human: human(result) };
    },
  };
}

interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  mergeability: string;
  checksState: string;
  htmlUrl: string;
}

function pullRequestLines(result: Input): string[] {
  const pullRequest = result.pullRequest as PullRequestSummary | null;
  if (!pullRequest) {
    return keyValues([
      ["attachment", result.attachment],
      ["url", result.url],
      ["error", result.error],
    ]);
  }
  return keyValues([
    ["attachment", result.attachment],
    ["number", pullRequest.number],
    ["title", pullRequest.title],
    ["url", pullRequest.htmlUrl],
    ["state", pullRequest.isDraft ? `${pullRequest.state} (draft)` : pullRequest.state],
    ["branch", `${pullRequest.headRef} into ${pullRequest.baseRef}`],
    ["head", pullRequest.headSha],
    ["mergeability", pullRequest.mergeability],
    ["checks", pullRequest.checksState],
  ]);
}

function timelineLines(result: Input): string[] {
  const items = result.items as GitHubPullRequestTimelineItem[];
  const lines = items.flatMap((item) => {
    if (item.kind === "comment") {
      return [
        `comment · ${item.comment.author?.login ?? "unknown"} · ${item.comment.createdAt}`,
        item.comment.body,
      ];
    }
    if (item.kind === "event") {
      return [
        `event · ${item.actor?.login ?? "unknown"} · ${item.createdAt}`,
        `${item.event}${item.detail ? `: ${item.detail}` : ""}`,
      ];
    }
    return [
      `${item.kind} · ${item.author?.login ?? (item.kind === "commit" ? item.authorName : undefined) ?? "unknown"} · ${item.createdAt}`,
      item.kind === "commit"
        ? `${item.sha} ${item.message}`
        : `${item.state}${item.body ? `: ${item.body}` : ""}`,
    ];
  });
  if (!items.length) lines.push("No timeline entries.");
  if (result.truncated) lines.push("Timeline truncated; more entries are available on GitHub.");
  return lines;
}

function fileLines(result: Input): string[] {
  const lines = keyValues([
    ["number", result.number],
    ["head", result.headSha],
  ]);
  if (Array.isArray(result.files)) {
    lines.push(
      ...table(
        ["FILE", "STATUS", "+", "-"],
        (result.files as GitHubPullRequestFile[]).map((file) => [
          file.path,
          file.status,
          String(file.additions),
          String(file.deletions),
        ]),
      ),
    );
  } else {
    const file = result.file as GitHubPullRequestFile;
    lines.push(`${file.path} (${file.status}, +${file.additions} -${file.deletions})`);
    if (!file.patchAvailable) lines.push("Patch unavailable; view this file on GitHub.");
    else
      for (const hunk of file.hunks) {
        lines.push(
          hunk.header,
          ...hunk.lines.map(
            (line) =>
              `${line.type === "add" ? "+" : line.type === "remove" ? "-" : line.type === "no-newline" ? "\\" : " "}${line.text}`,
          ),
        );
      }
  }
  for (const thread of (result.threads ?? []) as GitHubPullRequestReviewThread[]) {
    lines.push(
      `Thread ${thread.id} · ${thread.path}:${thread.line ?? "outdated"} · ${thread.isResolved ? "resolved" : "unresolved"}${thread.isOutdated ? " · outdated" : ""}`,
    );
    for (const comment of thread.comments)
      lines.push(`${comment.author?.login ?? "unknown"} · ${comment.createdAt}: ${comment.body}`);
    if (thread.commentsTruncated) lines.push("Thread comments truncated; see GitHub for more.");
  }
  if (result.truncated) lines.push("File list truncated; more files are available on GitHub.");
  return lines;
}

async function reviewComments(
  context: CommandContext,
  parsed: Parsed,
): Promise<unknown[] | undefined> {
  const file = parsed.options["comments-file"];
  if (file === undefined) return undefined;
  const text = await readTextSource(context.io, {
    file,
    label: "Review comments",
    maxBytes: PUBLIC_PR_BODY_MAX_CHARS * 4,
    names: { file: "--comments-file", stdin: "" },
    required: true,
  });
  let comments: unknown;
  try {
    comments = JSON.parse(text!);
  } catch {
    throw new CliError(
      "invalid-input",
      "--comments-file must contain a JSON array of inline comments",
    );
  }
  if (!Array.isArray(comments) || comments.length > PUBLIC_PR_REVIEW_COMMENTS_MAX)
    throw new CliError(
      "invalid-input",
      `--comments-file must contain at most ${PUBLIC_PR_REVIEW_COMMENTS_MAX} inline comments in a JSON array`,
    );
  return comments;
}

export const pullRequestCommands: readonly CommandSpec[] = [
  read(
    "get",
    "pr.get",
    "Read the pull request attached to an environment's branch.",
    [],
    () => ({}),
    pullRequestLines,
  ),
  {
    path: ["pr", "list"],
    action: "pr.list",
    summary: "List a project's pull requests from GitHub.",
    positionals: [{ name: "project", required: true }],
    options: [
      {
        name: "filter",
        kind: "string",
        valueName: "FILTER",
        description: "open (default), mine, review-requested or closed.",
      },
      { name: "query", kind: "string", valueName: "TEXT", description: "Search text." },
    ],
    idOutput: "pull request URLs",
    async run(context, parsed) {
      const session = await context.session();
      const filter = stringOption(parsed.options, "filter");
      const query = stringOption(parsed.options, "query");
      const result = await session.read<{
        pullRequests: Array<{ number: number; state: string; title: string; htmlUrl: string }>;
      }>("pr.list", {
        projectId: parsed.positionals.project,
        ...(filter !== undefined
          ? { filter: oneOf(filter, PUBLIC_PR_LIST_FILTERS, "--filter") }
          : {}),
        ...(query !== undefined ? { query } : {}),
      });
      return {
        action: "pr.list",
        result,
        connection: session.identity,
        ids: result.pullRequests.map((pullRequest) => pullRequest.htmlUrl),
        human: table(
          ["NUMBER", "STATE", "TITLE"],
          result.pullRequests.map((pullRequest) => [
            String(pullRequest.number),
            pullRequest.state,
            pullRequest.title,
          ]),
        ),
      };
    },
  },
  read(
    "timeline",
    "pr.timeline",
    "Read a pull request's commits, comments, reviews and events.",
    [],
    () => ({}),
    timelineLines,
  ),
  read(
    "files",
    "pr.files",
    "Read a pull request's changed files and review threads; with --path, one file's diff.",
    [
      {
        name: "path",
        kind: "string",
        valueName: "PATH",
        description: "Only this file, with hunks.",
      },
    ],
    (parsed) => {
      const path = stringOption(parsed.options, "path");
      return path !== undefined ? { path } : {};
    },
    fileLines,
  ),
  read(
    "options",
    "pr.options",
    "Read the repository's labels and assignable users.",
    [],
    () => ({}),
    (result) =>
      keyValues([
        [
          "labels",
          (result.labels as Array<{ name: string }>).map((label) => label.name).join(", "),
        ],
        [
          "assignable users",
          (result.assignableUsers as Array<{ login: string }>).map((user) => user.login).join(", "),
        ],
      ]),
  ),
  change(
    "merge",
    "pr.merge",
    "Merge the environment's pull request into its target branch (squash by default).",
    [
      {
        name: "method",
        kind: "string",
        valueName: "METHOD",
        description: "squash (default), merge or rebase.",
      },
      { name: "keep-branch", kind: "boolean", description: "Keep the head branch." },
      {
        name: "cleanup",
        kind: "boolean",
        description: "Merge and Cleanup: also delete the environment once merged.",
      },
      {
        name: "expected-head-sha",
        kind: "string",
        valueName: "SHA",
        description: "Refuse if the branch has moved from this commit.",
      },
      YES_OPTION,
    ],
    (_context, parsed) => {
      requireYes(parsed, "Merging cannot be undone");
      const method = stringOption(parsed.options, "method");
      const expectedHeadSha = stringOption(parsed.options, "expected-head-sha");
      return {
        ...(method !== undefined
          ? { method: oneOf(method, PUBLIC_PR_MERGE_METHODS, "--method") }
          : {}),
        ...(parsed.options["keep-branch"] === true ? { deleteBranch: false } : {}),
        ...(parsed.options.cleanup === true ? { cleanup: true } : {}),
        ...(expectedHeadSha !== undefined ? { expectedHeadSha } : {}),
      };
    },
    { inputFields: { "keep-branch": "deleteBranch", yes: null } },
  ),
  change(
    "close",
    "pr.close",
    "Close the environment's pull request without merging.",
    [YES_OPTION],
    (_context, parsed) => {
      requireYes(parsed, "This closes the pull request");
      return {};
    },
    { inputFields: { yes: null } },
  ),
  change("reopen", "pr.reopen", "Reopen the environment's closed pull request.", [], () => ({})),
  change("ready", "pr.ready", "Mark the environment's draft pull request ready.", [], () => ({})),
  change("draft", "pr.draft", "Convert the environment's pull request to a draft.", [], () => ({})),
  change(
    "comment",
    "pr.comment",
    "Add a conversation comment to the environment's pull request.",
    BODY_OPTIONS,
    async (context, parsed) => ({ body: await bodyText(context, parsed, true) }),
    { inputFields: { "body-file": "body" } },
  ),
  change(
    "comment-edit",
    "pr.comment.edit",
    "Edit a conversation comment on the environment's pull request.",
    [
      { name: "comment-id", kind: "string", valueName: "ID", description: "From pr get." },
      ...BODY_OPTIONS,
    ],
    async (context, parsed) => ({
      commentId: requiredInteger(parsed, "comment-id"),
      body: await bodyText(context, parsed, true),
    }),
    { inputFields: { "body-file": "body" } },
  ),
  change(
    "review",
    "pr.review",
    "Submit a review: approve, request changes or comment.",
    [
      {
        name: "event",
        kind: "string",
        valueName: "EVENT",
        description: "APPROVE, REQUEST_CHANGES or COMMENT.",
      },
      ...BODY_OPTIONS,
      { name: "commit-id", kind: "string", valueName: "SHA", description: "The commit reviewed." },
      {
        name: "comments-file",
        kind: "string",
        valueName: "PATH",
        description:
          "JSON array of inline comments (path, line, side, body and optional startLine).",
      },
      YES_OPTION,
    ],
    async (context, parsed) => {
      requireYes(parsed, "This submits a review as your GitHub user");
      const body = await bodyText(context, parsed, false);
      const commitId = stringOption(parsed.options, "commit-id");
      const comments = await reviewComments(context, parsed);
      return {
        ...(comments !== undefined ? { comments } : {}),
        event: oneOf(parsed.options.event, PUBLIC_PR_REVIEW_EVENTS, "--event"),
        ...(body !== undefined ? { body } : {}),
        ...(commitId !== undefined ? { commitId } : {}),
      };
    },
    { inputFields: { "body-file": "body", "comments-file": "comments", yes: null } },
  ),
  change(
    "review-comment",
    "pr.review.comment",
    "Add one inline review comment to the environment's pull request.",
    [
      ...INLINE_OPTIONS,
      ...BODY_OPTIONS,
      {
        name: "commit-id",
        kind: "string",
        valueName: "SHA",
        description: "Omitted: the current head.",
      },
    ],
    async (context, parsed) => {
      const startLine = integerOption(parsed, "start-line");
      const commitId = stringOption(parsed.options, "commit-id");
      return {
        path: requiredOption(parsed, "path"),
        line: requiredInteger(parsed, "line"),
        side: oneOf(parsed.options.side, PUBLIC_PR_SIDES, "--side"),
        ...(startLine !== undefined ? { startLine } : {}),
        body: await bodyText(context, parsed, true),
        ...(commitId !== undefined ? { commitId } : {}),
      };
    },
    { inputFields: { "body-file": "body" } },
  ),
  change(
    "thread-reply",
    "pr.thread.reply",
    "Reply to a review thread on the environment's pull request.",
    [
      { name: "thread-id", kind: "string", valueName: "ID", description: "From pr files." },
      ...BODY_OPTIONS,
    ],
    async (context, parsed) => ({
      threadId: requiredOption(parsed, "thread-id"),
      body: await bodyText(context, parsed, true),
    }),
    { inputFields: { "body-file": "body" } },
  ),
  change(
    "thread-resolve",
    "pr.thread.resolve",
    "Resolve a review thread on the environment's pull request.",
    [
      { name: "thread-id", kind: "string", valueName: "ID", description: "From pr files." },
      { name: "unresolve", kind: "boolean", description: "Unresolve it instead." },
    ],
    (_context, parsed) => ({
      threadId: requiredOption(parsed, "thread-id"),
      ...(parsed.options.unresolve === true ? { resolved: false } : {}),
    }),
    { inputFields: { unresolve: "resolved" } },
  ),
  change(
    "file-viewed",
    "pr.file.viewed",
    "Mark a changed file as viewed on the environment's pull request.",
    [
      { name: "path", kind: "string", valueName: "PATH", description: "Changed file." },
      { name: "unviewed", kind: "boolean", description: "Clear it instead." },
    ],
    (_context, parsed) => ({
      path: requiredOption(parsed, "path"),
      ...(parsed.options.unviewed === true ? { viewed: false } : {}),
    }),
    { inputFields: { unviewed: "viewed" } },
  ),
  change(
    "reviewers",
    "pr.reviewers",
    "Request or remove reviewers on the environment's pull request.",
    [
      {
        name: "add",
        kind: "string",
        valueName: "LIST",
        description: "Comma-separated logins or org/team-slugs.",
      },
      {
        name: "remove",
        kind: "string",
        valueName: "LIST",
        description: "Comma-separated logins or org/team-slugs.",
      },
    ],
    (_context, parsed) => ({
      add: repeatedList(parsed.options.add),
      remove: repeatedList(parsed.options.remove),
    }),
  ),
  change(
    "label",
    "pr.label",
    "Add or remove one label on the environment's pull request.",
    [
      { name: "name", kind: "string", valueName: "LABEL", description: "Label name." },
      { name: "remove", kind: "boolean", description: "Remove it instead." },
    ],
    (_context, parsed) => ({
      name: requiredOption(parsed, "name"),
      ...(parsed.options.remove === true ? { present: false } : {}),
    }),
    { inputFields: { remove: "present" } },
  ),
];
