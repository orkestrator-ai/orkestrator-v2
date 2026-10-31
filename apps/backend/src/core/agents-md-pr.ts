import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENTS_MD_FILE,
  MAX_AGENTS_MD_BYTES,
  describeAgentsMdChange,
  mergeOrkestratorSection,
  readOrkestratorSection,
  type AgentsMdChange,
  type AgentsMdChangeOutcome,
  type AgentsMdSection,
} from "@orkestrator/protocol/agents-md-orkestrator";
import { parseGitHubRepositoryRemote } from "@orkestrator/protocol/github-repository";
import { validateGitRefName } from "./commands-agent-support.js";
import { gitHubCliEnv, type GitHubCliConfigSource } from "./github-credentials.js";
import { gitHubCli } from "./github-cli-binary.js";
import { runRemoteGit } from "./git-noninteractive-env.js";
import { CommandFailedError, runCommandBuffer } from "./shell.js";

/**
 * Opens the pull request for an approved `## Orkestrator` AGENTS.md proposal
 * without a worker environment and without touching the user's checkout.
 *
 * The change is made in a temporary worktree created detached and without a
 * checkout from a freshly fetched `origin/<base>`, outside the checkout. Only
 * that worktree's own index and HEAD are written: the new AGENTS.md is
 * hashed byte for byte (no clean filters, line-ending conversion or LFS) and
 * staged with `update-index`, then committed with the repository's hooks
 * disabled, as Coordinator never loads repository hooks. The commit is pushed
 * to a branch named after the request, never forced, and the pull request is
 * opened with `gh`. Nothing merges.
 *
 * Idempotent per request key: the branch name derives from it, so a retry
 * (or a backend restart mid-run) finds the pull request or the pushed branch
 * an earlier attempt left and finishes from there instead of opening another.
 * The proposal is re-applied to whatever the base holds now; a replacement
 * whose original has gone is reported as a conflict rather than guessed.
 */

export type AgentsMdPrErrorCode =
  | "gh-missing"
  | "gh-auth"
  | "conflict"
  | "invalid"
  | "fetch-failed"
  | "git-failed"
  | "push-failed"
  | "pr-failed";

export class AgentsMdPrError extends Error {
  readonly code: AgentsMdPrErrorCode;
  constructor(code: AgentsMdPrErrorCode, message: string) {
    super(message);
    this.name = "AgentsMdPrError";
    this.code = code;
  }
}

export interface AgentsMdPrDependencies {
  /** Local Git; returns raw stdout. */
  git(
    args: string[],
    options: { cwd: string; timeoutMs?: number; input?: Buffer },
  ): Promise<Buffer>;
  /** Git that reaches the remote (fetch, push, ls-remote), never prompting. */
  remoteGit(
    command: "fetch" | "push" | "ls-remote",
    args: string[],
    options: { cwd: string; timeoutMs?: number },
  ): Promise<string>;
  /** The GitHub CLI with the credential selected in Settings. */
  gh(args: string[], options: { cwd: string; timeoutMs?: number }): Promise<string>;
  /** Parent for fresh mode-0700 run directories; outside every checkout. */
  worktreeRoot: string;
}

export function defaultAgentsMdPrDependencies(
  gitHubConfig: GitHubCliConfigSource | undefined,
): AgentsMdPrDependencies {
  return {
    git: async (args, { cwd, timeoutMs = 60_000, input }) =>
      (
        await runCommandBuffer("git", args, {
          cwd,
          timeoutMs,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          ...(input ? { stdin: input } : {}),
        })
      ).stdout,
    remoteGit: async (command, args, { cwd, timeoutMs = 120_000 }) =>
      (
        await runRemoteGit(command, args, {
          cwd,
          timeoutMs,
          gitOptions: ["-c", "core.hooksPath=/dev/null"],
        })
      ).stdout,
    gh: async (args, { cwd, timeoutMs = 60_000 }) => {
      const { stdout } = await runCommandBuffer(gitHubCli(), args, {
        cwd,
        timeoutMs,
        env: {
          ...(await gitHubCliEnv(gitHubConfig)),
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
        },
      });
      return stdout.toString("utf8");
    },
    worktreeRoot: os.tmpdir(),
  };
}

export const AGENTS_MD_PR_TITLE = "docs(agents): update Orkestrator decisions in AGENTS.md";
export const AGENTS_MD_GENERATED_BY =
  "🤖 Generated with [Orkestrator](https://www.orkestrator.dev)";

/** A stable hex key per approval request: names the branch and the temporary worktree. */
export function agentsMdRequestKey(requestId: string): string {
  return createHash("sha256").update(`agents-md\0${requestId}`).digest("hex").slice(0, 24);
}

export function agentsMdBranchName(key: string): string {
  return `orkestrator/agents-md-${key}`;
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 400);
}

/** The project's AGENTS.md on the base branch, read from Git objects only. */
export interface AgentsMdBase {
  baseBranch: string;
  baseCommit: string;
  /** Null: the base branch has no AGENTS.md. */
  content: string | null;
}

async function readBase(
  baseBranch: string,
  git: (args: string[], cwd?: string) => Promise<Buffer>,
  ref = `refs/remotes/origin/${baseBranch}`,
): Promise<AgentsMdBase> {
  const baseCommit = (
    await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => {
      throw new AgentsMdPrError("fetch-failed", `origin/${baseBranch} does not exist.`);
    })
  )
    .toString("utf8")
    .trim();
  const listing = (await git(["ls-tree", "-z", baseCommit, "--", AGENTS_MD_FILE]))
    .toString("utf8")
    .split("\0")
    .find(Boolean);
  if (!listing) return { baseBranch, baseCommit, content: null };
  const [mode, type, object] = listing.split("\t")[0]!.split(" ");
  if (type !== "blob" || (mode !== "100644" && mode !== "100755"))
    throw new AgentsMdPrError(
      "invalid",
      `${AGENTS_MD_FILE} on ${baseBranch} is not a regular file (it may be a symlink); edit it by hand.`,
    );
  const size = Number((await git(["cat-file", "-s", object!])).toString("utf8").trim());
  if (!Number.isFinite(size) || size > MAX_AGENTS_MD_BYTES)
    throw new AgentsMdPrError(
      "invalid",
      `${AGENTS_MD_FILE} on ${baseBranch} is larger than 1 MiB.`,
    );
  const bytes = await git(["cat-file", "blob", object!]);
  let content: string;
  try {
    // Fatal and BOM-preserving, so re-encoding returns exactly these bytes.
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AgentsMdPrError("invalid", `${AGENTS_MD_FILE} on ${baseBranch} is not valid UTF-8.`);
  }
  if (content.includes("\0"))
    throw new AgentsMdPrError("invalid", `${AGENTS_MD_FILE} on ${baseBranch} is not a text file.`);
  return { baseBranch, baseCommit, content };
}

async function fetchBase(root: string, baseBranch: string, deps: AgentsMdPrDependencies) {
  await deps.remoteGit(
    "fetch",
    ["--no-tags", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
    { cwd: root },
  );
}

function localGit(deps: AgentsMdPrDependencies, root: string) {
  // Repository hooks never run: Coordinator does not load them, and a hook in
  // a worktree without the project's dependencies would fail anyway.
  return (args: string[], cwd = root, input?: Buffer) =>
    deps.git(["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      ...(input ? { input } : {}),
    });
}

/** The section as it is on the latest base, for the user's review. */
export async function readAgentsMdSectionFromBase(input: {
  root: string;
  baseBranch: string;
  deps?: AgentsMdPrDependencies;
  /** The backend's storage, for `gh`'s selected credential when `deps` is left out. */
  gitHubConfig?: GitHubCliConfigSource;
}): Promise<{
  baseBranch: string;
  baseCommit: string;
  fetched: boolean;
  fetchError?: string;
  fileExists: boolean;
  section: AgentsMdSection;
}> {
  const deps = input.deps ?? defaultAgentsMdPrDependencies(input.gitHubConfig);
  const baseBranch = validateGitRefName(input.baseBranch, "base branch");
  let fetchError: string | undefined;
  await fetchBase(input.root, baseBranch, deps).catch((error: unknown) => {
    fetchError = errorText(error);
  });
  const git = localGit(deps, input.root);
  const base = await readBase(baseBranch, git);
  return {
    baseBranch,
    baseCommit: base.baseCommit,
    fetched: fetchError === undefined,
    ...(fetchError ? { fetchError } : {}),
    fileExists: base.content !== null,
    section: readOrkestratorSection(base.content),
  };
}

export interface AgentsMdPrResult {
  /** `opened` now, `existing` from an earlier attempt, `unchanged`: nothing to do. */
  status: "opened" | "existing" | "unchanged";
  url?: string;
  branch: string;
  baseBranch: string;
  baseCommit?: string;
  outcomes: AgentsMdChangeOutcome[];
}

export function agentsMdPrBody(changes: readonly AgentsMdChange[], reason: string): string {
  return [
    "Updates the `## Orkestrator` section of the repository's root `AGENTS.md` with operating decisions the user approved in an Orkestrator coordinator conversation.",
    "",
    `**Reason:** ${reason}`,
    "",
    "**Changes:**",
    "",
    ...changes.map((change) => `- ${describeAgentsMdChange(change)}`),
    "",
    "Only that section changed; everything else in `AGENTS.md` is byte-for-byte unchanged. The coordinator proposed it and the user approved it before this pull request was opened. Nothing is merged automatically.",
    "",
    AGENTS_MD_GENERATED_BY,
    "",
  ].join("\n");
}

const running = new Map<string, Promise<AgentsMdPrResult>>();

/** One run per request key in this process; a concurrent call shares it. */
export function openAgentsMdPullRequest(input: {
  root: string;
  baseBranch: string;
  /** Hex key derived from the request; names the branch and the worktree. */
  key: string;
  changes: AgentsMdChange[];
  reason: string;
  nodeName?: string;
  deps?: AgentsMdPrDependencies;
  /** The backend's storage, for `gh`'s selected credential when `deps` is left out. */
  gitHubConfig?: GitHubCliConfigSource;
}): Promise<AgentsMdPrResult> {
  const existing = running.get(input.key);
  if (existing) return existing;
  const run = withPrivateDirectory(input).finally(() => running.delete(input.key));
  running.set(input.key, run);
  return run;
}

async function withPrivateDirectory(
  input: Parameters<typeof openOnce>[0],
): Promise<AgentsMdPrResult> {
  const deps = input.deps ?? defaultAgentsMdPrDependencies(input.gitHubConfig);
  await fs.mkdir(deps.worktreeRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(deps.worktreeRoot, "agents-md-"));
  try {
    return await openOnce({ ...input, deps: { ...deps, worktreeRoot: directory } });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function openOnce(input: {
  root: string;
  baseBranch: string;
  key: string;
  changes: AgentsMdChange[];
  reason: string;
  nodeName?: string;
  deps?: AgentsMdPrDependencies;
  /** The backend's storage, for `gh`'s selected credential when `deps` is left out. */
  gitHubConfig?: GitHubCliConfigSource;
}): Promise<AgentsMdPrResult> {
  const deps = input.deps ?? defaultAgentsMdPrDependencies(input.gitHubConfig);
  if (!/^[a-f0-9]{8,64}$/.test(input.key))
    throw new AgentsMdPrError("invalid", "Invalid request key.");
  const baseBranch = validateGitRefName(input.baseBranch, "base branch");
  const branch = agentsMdBranchName(input.key);
  const where = input.nodeName ?? "this machine";
  const { root } = input;
  const git = localGit(deps, root);
  await removeAgentsMdWorktree(git, deps.worktreeRoot, input.key);

  const origin = (
    await git(["remote", "get-url", "origin"]).catch(() => {
      throw new AgentsMdPrError("invalid", "The project checkout has no origin remote.");
    })
  )
    .toString("utf8")
    .trim();
  const parsed = parseGitHubRepositoryRemote(origin);
  const repo = parsed.ok ? ["--repo", `${parsed.repository.owner}/${parsed.repository.name}`] : [];

  // Fail before any change when the GitHub CLI cannot open the pull request.
  try {
    // Scoped to github.com when that is the remote: a bare `gh auth status`
    // also fails for a problem with any other host the user signed in to.
    await deps.gh(["auth", "status", ...(parsed.ok ? ["--hostname", "github.com"] : [])], {
      cwd: root,
      timeoutMs: 30_000,
    });
  } catch (error) {
    if (error instanceof CommandFailedError && error.executableMissing)
      throw new AgentsMdPrError(
        "gh-missing",
        `The GitHub CLI (gh) is not installed on ${where}. Install it and run \`gh auth login\` there, then ask the coordinator to propose the change again.`,
      );
    throw new AgentsMdPrError(
      "gh-auth",
      `The GitHub CLI is not signed in on ${where}. Run \`gh auth login\` there (or add a GitHub token under Settings), then ask the coordinator to propose the change again.`,
    );
  }

  const findPr = async (): Promise<string | null> => {
    const listed = await deps.gh(
      [
        "pr",
        "list",
        ...repo,
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "url,state",
        "--limit",
        "1",
      ],
      { cwd: root, timeoutMs: 30_000 },
    );
    try {
      const rows = JSON.parse(listed) as Array<{ url?: unknown; state?: unknown }>;
      const url = Array.isArray(rows) ? rows[0]?.url : undefined;
      if (typeof url !== "string" || !url) return null;
      if (rows[0]?.state !== "OPEN")
        throw new AgentsMdPrError(
          "pr-failed",
          `The request's pull request is ${String(rows[0]?.state ?? "in an unknown state")}: ${url}. Propose a new request if another change is needed.`,
        );
      return url;
    } catch (error) {
      if (error instanceof AgentsMdPrError) throw error;
      return null;
    }
  };
  const remoteBranch = async (): Promise<string | null> => {
    const out = await deps.remoteGit("ls-remote", ["--heads", "origin", `refs/heads/${branch}`], {
      cwd: root,
    });
    return out.trim().split(/\s+/)[0] || null;
  };

  const earlier = await findPr().catch((error: unknown) => {
    throw new AgentsMdPrError(
      "pr-failed",
      `Could not check for an existing pull request: ${errorText(error)}`,
    );
  });
  if (earlier) return { status: "existing", url: earlier, branch, baseBranch, outcomes: [] };

  try {
    await fetchBase(root, baseBranch, deps);
  } catch (error) {
    throw new AgentsMdPrError(
      "fetch-failed",
      `Could not fetch origin/${baseBranch} on ${where}: ${errorText(error)}`,
    );
  }

  const base = await readBase(baseBranch, git);
  const baseCommit = base.baseCommit;
  const merged = mergeOrkestratorSection(base.content, input.changes);
  const outcomes = merged.outcomes;
  if (merged.conflicts.length > 0)
    throw new AgentsMdPrError(
      "conflict",
      `The ## Orkestrator section changed on ${baseBranch}: ${merged.conflicts.map((outcome) => outcome.detail).join(" ")} Nothing was changed; propose against the current section.`,
    );
  const pushed = await remoteBranch();
  if (pushed) {
    await deps.remoteGit("fetch", ["--no-tags", "origin", `refs/heads/${branch}`], { cwd: root });
    const recovered = await readBase(baseBranch, git, "FETCH_HEAD");
    const changed = (await git(["diff", "--name-only", baseCommit, recovered.baseCommit]))
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
    if (
      changed.length !== 1 ||
      changed[0] !== AGENTS_MD_FILE ||
      recovered.content !== merged.content
    )
      throw new AgentsMdPrError(
        "conflict",
        `Branch ${branch} does not match the approved changes against current origin/${baseBranch}. Nothing was changed; propose again with a new request.`,
      );
  } else {
    if (!merged.changed) return { status: "unchanged", branch, baseBranch, baseCommit, outcomes };
    await commitAndPush({
      git,
      deps,
      key: input.key,
      branch,
      baseCommit,
      content: merged.content,
      message: `${AGENTS_MD_PR_TITLE}\n\n${input.changes.map(describeAgentsMdChange).join("\n")}\n\nReason: ${input.reason}\n`,
      isPushed: remoteBranch,
    });
  }

  const bodyFile = path.join(deps.worktreeRoot, `${input.key}.body.md`);
  await fs.writeFile(bodyFile, agentsMdPrBody(input.changes, input.reason), "utf8");
  try {
    const created = await deps
      .gh(
        [
          "pr",
          "create",
          ...repo,
          "--base",
          baseBranch,
          "--head",
          branch,
          "--title",
          AGENTS_MD_PR_TITLE,
          "--body-file",
          bodyFile,
        ],
        { cwd: root, timeoutMs: 120_000 },
      )
      .catch(async (error: unknown) => {
        // A pull request an earlier attempt opened just before it was lost.
        const found = await findPr().catch(() => null);
        if (found) return found;
        throw new AgentsMdPrError(
          "pr-failed",
          `gh pr create failed on ${where}: ${errorText(error)}`,
        );
      });
    const url = created
      .split(/\s+/)
      .filter((part) => /^https?:\/\/\S+\/pull\/\d+$/.test(part))
      .at(-1);
    if (!url) {
      const found = await findPr().catch(() => null);
      if (!found) throw new AgentsMdPrError("pr-failed", "gh did not report the pull request URL.");
      return {
        status: "opened",
        url: found,
        branch,
        baseBranch,
        ...(baseCommit ? { baseCommit } : {}),
        outcomes,
      };
    }
    return {
      status: "opened",
      url,
      branch,
      baseBranch,
      ...(baseCommit ? { baseCommit } : {}),
      outcomes,
    };
  } finally {
    await fs.rm(bodyFile, { force: true }).catch(() => undefined);
  }
}

/** Remove a request's temporary worktree, including one a crashed attempt left. */
async function removeAgentsMdWorktree(
  git: (args: string[]) => Promise<Buffer>,
  worktreeRoot: string,
  key: string,
): Promise<void> {
  const worktree = path.join(worktreeRoot, key);
  await git(["worktree", "remove", "--force", worktree]).catch(() => undefined);
  await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  await git(["worktree", "prune"]).catch(() => undefined);
}

async function commitAndPush(input: {
  git: (args: string[], cwd?: string, stdin?: Buffer) => Promise<Buffer>;
  deps: AgentsMdPrDependencies;
  key: string;
  branch: string;
  baseCommit: string;
  content: string;
  message: string;
  isPushed: () => Promise<string | null>;
}): Promise<void> {
  const { git, deps } = input;
  const worktree = path.join(input.deps.worktreeRoot, input.key);
  const removeWorktree = () => removeAgentsMdWorktree(git, deps.worktreeRoot, input.key);
  try {
    await git(["worktree", "add", "--detach", "--no-checkout", worktree, input.baseCommit]).catch(
      (error: unknown) => {
        throw new AgentsMdPrError(
          "git-failed",
          `Could not create a temporary worktree: ${errorText(error)}`,
        );
      },
    );
    // The worktree's own index, from the base commit; no files are checked out.
    await git(["read-tree", input.baseCommit], worktree);
    const blob = (
      await git(
        ["hash-object", "-w", "--no-filters", "--stdin"],
        worktree,
        Buffer.from(input.content, "utf8"),
      )
    )
      .toString("utf8")
      .trim();
    const listing = (await git(["ls-tree", input.baseCommit, "--", AGENTS_MD_FILE], worktree))
      .toString("utf8")
      .trim();
    const mode = listing.split(" ")[0] === "100755" ? "100755" : "100644";
    await git(
      ["update-index", "--add", "--cacheinfo", `${mode},${blob},${AGENTS_MD_FILE}`],
      worktree,
    );
    await git(["commit", "--quiet", "--no-verify", "-m", input.message], worktree).catch(
      (error: unknown) => {
        throw new AgentsMdPrError(
          "git-failed",
          `Could not commit (is git user.name and user.email set?): ${errorText(error)}`,
        );
      },
    );
    const changed = (await git(["diff", "--name-only", input.baseCommit, "HEAD"], worktree))
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
    if (changed.length !== 1 || changed[0] !== AGENTS_MD_FILE)
      throw new AgentsMdPrError("git-failed", "The commit would change more than AGENTS.md.");
    try {
      await deps.remoteGit("push", ["--no-verify", "origin", `HEAD:refs/heads/${input.branch}`], {
        cwd: worktree,
      });
    } catch (error) {
      // A lost push reply is safe only when origin has this exact commit.
      const expected = (await git(["rev-parse", "HEAD"], worktree)).toString("utf8").trim();
      if ((await input.isPushed().catch(() => null)) === expected) return;
      throw new AgentsMdPrError(
        "push-failed",
        `Could not push ${input.branch}: ${errorText(error)}`,
      );
    }
  } finally {
    await removeWorktree();
  }
}
