/**
 * `open-pull-request` (plan P2.7, D12; report §6.6): the coordinator's PR job
 * and Ship's update-or-reopen rule as backend code. An agent wrote the
 * `pr-description@1`; this node acts on it:
 *
 * 1. pushes the `workspace@1` commit (`pushGraphCommit`: once per commit,
 *    force-with-lease only after a code rewind);
 * 2. finds the run's pull request for the branch, or adopts an open one the
 *    branch already has, or opens one (`gh pr create`) — once per run and
 *    branch (effect `pr:<branch>`; after a crash, GitHub is asked first);
 * 3. reopens it when it was closed; opens a new one when it was merged
 *    (a merged pull request cannot take new commits);
 * 4. sets the title and body when they differ (`gh pr edit`);
 * 5. records it on the environment as the pipeline's Ship does, and has the
 *    PR monitor watch it;
 * 6. reports `pr-result@1` and, for 108's conflict gate,
 *    `pull-request-state@1` (`{url, state, hasMergeConflicts}`), re-reading a
 *    few times while GitHub is still computing mergeability.
 *
 * Every `gh` call names the repository (`--repo`), so it works from a
 * container's or a worktree's checkout alike.
 */
import {
  buildPrDetectionCandidate,
  isValidPrUrl,
  parseKnownPrDetectionOutput,
  type GhPrListEntry,
  type PrDetectionResult,
} from "./commands-review.js";
import { resolveGitHubRepository } from "./github.js";
import {
  GraphSystemActionError,
  graphProviderError,
  type GraphSystemActionContext,
  type GraphSystemActionHandler,
} from "./graph-system-action.js";
import { pushGraphCommit, type GraphWorkspaceValue } from "./graph-system-push.js";
import type { Environment } from "./models.js";

/** The payload of `pr-description@1`. */
interface GraphPrDescription {
  title: string;
  body: string;
}

/** Re-reads while GitHub has not computed mergeability yet. */
export const GRAPH_PR_MERGEABILITY_READS = 6;
export const GRAPH_PR_MERGEABILITY_DELAY_MS = 5_000;

const VIEW_FIELDS = "url,state,mergeable,mergeStateStatus,isDraft,baseRefName";
const LIST_FIELDS = "url,state,mergeable,mergeStateStatus,isDraft,updatedAt,baseRefName";
const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

interface PullRequestTarget {
  environment: Environment;
  repo: string;
  branch: string;
  base: string;
}

async function gh(
  ctx: GraphSystemActionContext,
  target: PullRequestTarget,
  what: string,
  args: string[],
  redact: string[] = [],
): Promise<string> {
  try {
    return await ctx.deps.shell.gh(target.environment, args, { signal: ctx.signal, redact });
  } catch (error) {
    throw graphProviderError(what, error, redact);
  }
}

async function viewPullRequest(
  ctx: GraphSystemActionContext,
  target: PullRequestTarget,
  url: string,
): Promise<PrDetectionResult> {
  const output = await gh(ctx, target, "Could not read the pull request", [
    "pr",
    "view",
    url,
    "--repo",
    target.repo,
    "--json",
    VIEW_FIELDS,
  ]);
  try {
    return parseKnownPrDetectionOutput(output, url);
  } catch (error) {
    throw graphProviderError("GitHub returned unreadable pull request metadata", error);
  }
}

/** The branch's newest open pull request, if it has one. */
async function openPullRequestFor(
  ctx: GraphSystemActionContext,
  target: PullRequestTarget,
): Promise<string | undefined> {
  const output = await gh(ctx, target, "Could not list the branch's pull requests", [
    "pr",
    "list",
    "--repo",
    target.repo,
    "--head",
    target.branch,
    "--state",
    "open",
    "--limit",
    "30",
    "--json",
    LIST_FIELDS,
  ]);
  let entries: unknown;
  try {
    entries = JSON.parse(output.trim() || "[]");
  } catch {
    throw new GraphSystemActionError(
      "GitHub returned an unreadable pull request list",
      "provider-error",
    );
  }
  if (!Array.isArray(entries)) return undefined;
  const open = entries
    .map((entry) => buildPrDetectionCandidate(entry as GhPrListEntry))
    .filter((entry): entry is NonNullable<typeof entry> => entry?.result.state === "open")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return open[0]?.result.url;
}

async function createPullRequest(
  ctx: GraphSystemActionContext,
  target: PullRequestTarget,
  description: GraphPrDescription,
): Promise<string> {
  const output = await gh(
    ctx,
    target,
    "Could not open the pull request",
    [
      "pr",
      "create",
      "--repo",
      target.repo,
      "--head",
      target.branch,
      "--base",
      target.base,
      "--title",
      description.title,
      "--body",
      description.body,
      ...(ctx.params.draft === true ? ["--draft"] : []),
    ],
    [description.title, description.body],
  );
  const url = output.match(PR_URL)?.[0];
  if (!url || !isValidPrUrl(url)) {
    throw new GraphSystemActionError(
      "GitHub did not return the new pull request's URL",
      "provider-error",
    );
  }
  return url;
}

/**
 * Opens (or adopts) the branch's pull request once under `key`. `createdNow`
 * is true only when this call opened it (a replay reports the recorded URL).
 */
async function openOnce(
  ctx: GraphSystemActionContext,
  target: PullRequestTarget,
  description: GraphPrDescription,
  key: string,
): Promise<{ url: string; createdNow: boolean }> {
  let createdNow = false;
  const opened = await ctx.effect<{ url: string; created?: boolean; adopted?: boolean }>(
    key,
    async () => {
      const existing = await openPullRequestFor(ctx, target);
      if (existing) return { url: existing, adopted: true };
      const url = await createPullRequest(ctx, target, description);
      createdNow = true;
      return { url, created: true };
    },
    {
      probe: async () => {
        const existing = await openPullRequestFor(ctx, target);
        return existing ? { url: existing, adopted: true } : undefined;
      },
    },
  );
  if (typeof opened.url !== "string" || !isValidPrUrl(opened.url)) {
    throw new GraphSystemActionError("The recorded pull request URL is invalid");
  }
  return { url: opened.url, createdNow };
}

async function syncDescription(
  ctx: GraphSystemActionContext,
  target: PullRequestTarget,
  url: string,
  description: GraphPrDescription,
): Promise<boolean> {
  const redact = [description.title, description.body];
  const output = await gh(
    ctx,
    target,
    "Could not read the pull request description",
    ["pr", "view", url, "--repo", target.repo, "--json", "title,body"],
    redact,
  );
  let current: { title?: unknown; body?: unknown } = {};
  try {
    current = JSON.parse(output) as typeof current;
  } catch {
    throw new GraphSystemActionError(
      "GitHub returned an unreadable pull request",
      "provider-error",
    );
  }
  if (current.title === description.title && current.body === description.body) return false;
  await gh(
    ctx,
    target,
    "Could not update the pull request description",
    [
      "pr",
      "edit",
      url,
      "--repo",
      target.repo,
      "--title",
      description.title,
      "--body",
      description.body,
    ],
    redact,
  );
  return true;
}

export const openPullRequestAction: GraphSystemActionHandler = {
  action: "open-pull-request",
  async run(ctx) {
    const workspace = await ctx.requireInput<GraphWorkspaceValue>("workspace@1");
    const description = await ctx.requireInput<GraphPrDescription>("pr-description@1");
    await pushGraphCommit(ctx, workspace);
    const environment = await ctx.environment();
    const project = await ctx.deps.storage.getProject(ctx.run.projectId);
    if (!project) throw new GraphSystemActionError("The run's project no longer exists");
    let repository;
    try {
      repository = resolveGitHubRepository(project.gitUrl);
    } catch (error) {
      throw new GraphSystemActionError(
        error instanceof Error ? error.message : "The project has no GitHub repository",
      );
    }
    const configured = (await ctx.deps.storage.getRepositoryConfig(ctx.run.projectId)).prBaseBranch;
    const target: PullRequestTarget = {
      environment,
      repo: `${repository.owner}/${repository.name}`,
      branch: workspace.branch,
      base:
        (typeof ctx.params.targetBranch === "string" ? ctx.params.targetBranch : undefined) ??
        (configured?.trim() || "main"),
    };

    let opened = await openOnce(ctx, target, description, `pr:${target.branch}`);
    let view = await viewPullRequest(ctx, target, opened.url);
    let reopened = false;
    if (view.state === "merged") {
      opened = await openOnce(ctx, target, description, `pr:${target.branch}:after:${opened.url}`);
      view = await viewPullRequest(ctx, target, opened.url);
    }
    if (view.state === "closed") {
      await gh(ctx, target, "Could not reopen the pull request", [
        "pr",
        "reopen",
        opened.url,
        "--repo",
        target.repo,
      ]);
      reopened = true;
      view = await viewPullRequest(ctx, target, opened.url);
    }
    const edited = opened.createdNow
      ? false
      : await syncDescription(ctx, target, opened.url, description);

    for (
      let read = 0;
      read < GRAPH_PR_MERGEABILITY_READS &&
      view.state === "open" &&
      view.hasMergeConflicts === null;
      read++
    ) {
      await ctx.sleep(GRAPH_PR_MERGEABILITY_DELAY_MS);
      ctx.throwIfAborted();
      view = await viewPullRequest(ctx, target, opened.url);
    }
    await ctx.deps.storage.updateEnvironment(environment.id, {
      prUrl: opened.url,
      prState: view.state,
      prBaseBranch: view.baseBranch ?? target.base,
      hasMergeConflicts: view.hasMergeConflicts,
    });
    await ctx.deps.prMonitor.watch(environment.id).catch(() => undefined);

    const summary = opened.createdNow
      ? `Opened the pull request against ${target.base}.`
      : [
          "Updated the branch's pull request",
          reopened ? "reopened it" : "",
          edited ? "set its title and description" : "",
        ]
          .filter(Boolean)
          .join(", ")
          .concat(".");
    await ctx.output("pr-result@1", { status: "created", url: opened.url, summary });
    await ctx.output("pull-request-state@1", {
      url: opened.url,
      state: view.state,
      hasMergeConflicts: view.hasMergeConflicts,
    });
  },
};
