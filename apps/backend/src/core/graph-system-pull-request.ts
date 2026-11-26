/**
 * `open-pull-request` (plan P2.7, D12; report §6.6): the coordinator's PR job
 * and Ship's update-or-reopen rule as backend code. An agent wrote the
 * `pr-description@1`; this node acts on it:
 *
 * 1. checks the workspace against the pull request’s fresh base, then pushes
 *    the commit (once per commit, force-with-lease only after a code rewind);
 * 2. finds the run's pull request for the branch, or adopts an open one the
 *    branch already has, or opens one (`gh pr create`) — once per run and
 *    branch (effect `pr:<branch>`; after a crash, GitHub is asked first);
 * 3. rechecks the published head and fresh base before each GitHub write;
 *    reopens a closed pull request, or opens a new one when it was merged
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
  parseGitHubPullRequestUrl,
  parseKnownPrDetectionOutput,
} from "./commands/review.js";
import type { GhPrListEntry, PrDetectionResult } from "./commands/index.js";
import { prMergeCheckArgs } from "./pull-request-merge-preflight.js";
import { resolveGitHubRepository } from "./git/index.js";
import {
  GraphSystemActionError,
  graphProviderError,
  type GraphSystemActionContext,
  type GraphSystemActionHandler,
} from "./graph-system-action.js";
import {
  checkGraphWorkspace,
  pushGraphCommit,
  type GraphWorkspaceValue,
} from "./graph-system-push.js";
import type { Environment } from "./models.js";

/** The payload of `pr-description@1`. */
interface GraphPrDescription {
  title: string;
  body: string;
}

/** Re-reads while GitHub has not computed mergeability yet. */
export const GRAPH_PR_MERGEABILITY_READS = 6;
export const GRAPH_PR_MERGEABILITY_DELAY_MS = 5_000;

const VIEW_FIELDS =
  "url,state,mergeable,mergeStateStatus,isDraft,baseRefName,headRefName,isCrossRepository";
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
    const identity = JSON.parse(output) as { headRefName?: unknown; isCrossRepository?: unknown };
    const view = parseKnownPrDetectionOutput(output, url);
    const { owner, repo } = parseGitHubPullRequestUrl(url);
    if (
      `${owner}/${repo}`.toLowerCase() !== target.repo.toLowerCase() ||
      identity.headRefName !== target.branch ||
      identity.isCrossRepository !== false ||
      !view.baseBranch
    ) {
      throw new Error("The pull request does not identify this repository and branch");
    }
    return view;
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
  if (!Array.isArray(entries)) {
    throw new GraphSystemActionError(
      "GitHub returned an unreadable pull request list",
      "provider-error",
    );
  }
  const open = entries.map((entry) => entry && buildPrDetectionCandidate(entry as GhPrListEntry));
  if (open.some((entry) => entry?.result?.state !== "open") || open.length > 1) {
    throw new GraphSystemActionError(
      "GitHub did not identify a unique open pull request",
      "provider-error",
    );
  }
  return open[0]?.result.url;
}

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

class PublicationConflict extends Error {
  constructor(readonly base: string) {
    super(`Merge origin/${base} and resolve its conflicts before publishing the pull request.`);
  }
}

async function readRemoteCommit(
  ctx: GraphSystemActionContext,
  target: PullRequestTarget,
  branch: string,
) {
  const ref = `refs/heads/${branch}`;
  const output = await ctx.deps.shell.remoteGit(
    target.environment,
    "ls-remote",
    ["--exit-code", "origin", ref],
    { signal: ctx.signal },
  );
  const [sha, name, extra] = output.trim().split(/\s+/);
  if (!sha || !FULL_COMMIT.test(sha) || name !== ref || extra) {
    throw new Error("The remote did not return an exact branch commit");
  }
  return sha;
}

async function checkPublication(
  ctx: GraphSystemActionContext,
  target: PullRequestTarget,
  head: string,
  pushed: boolean,
): Promise<void> {
  const { shell } = ctx.deps;
  const { environment, base, branch } = target;
  const options = { signal: ctx.signal };
  let result: string;
  try {
    if (base === branch || !/^[A-Za-z0-9._/-]{1,200}$/.test(base)) {
      throw new Error("The pull request needs a valid base distinct from the workspace branch");
    }
    await shell.git(environment, ["check-ref-format", `refs/heads/${base}`], options);
    if (pushed && (await readRemoteCommit(ctx, target, branch)) !== head) {
      throw new Error("The published head no longer matches the workspace commit");
    }
    const sha = await readRemoteCommit(ctx, target, base);
    // An explicit, exact fetch paired with the advertised SHA avoids a stale
    // tracking ref and detects a move during the fetch. Refuse if the server
    // will no longer serve that commit.
    await shell.remoteGit(
      environment,
      "fetch",
      ["--no-tags", "--no-write-fetch-head", "--refmap=", "origin", sha],
      options,
    );
    result = (await shell.git(environment, prMergeCheckArgs(sha, head), options)).trim();
    if (result !== "clean" && result !== "conflict") {
      throw new Error("Unexpected merge check result");
    }
    if ((await readRemoteCommit(ctx, target, base)) !== sha) {
      throw new Error("The base branch moved during the pull request check");
    }
    if (pushed && (await readRemoteCommit(ctx, target, branch)) !== head) {
      throw new Error("The published head moved during the pull request check");
    }
  } catch (error) {
    throw graphProviderError("Could not check pull request mergeability", error);
  }
  if (result === "conflict") throw new PublicationConflict(base);
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
  head: string,
): Promise<{ url: string; createdNow: boolean }> {
  let createdNow = false;
  const opened = await ctx.effect<{ url: string; created?: boolean; adopted?: boolean }>(
    key,
    async () => {
      const existing = await openPullRequestFor(ctx, target);
      if (existing) return { url: existing, adopted: true };
      await checkPublication(ctx, target, head, true);
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
  head: string,
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
  const view = await viewPullRequest(ctx, target, url);
  await checkPublication(ctx, { ...target, base: view.baseBranch! }, head, true);
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
    const environment = await checkGraphWorkspace(ctx, workspace);
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
    const target: PullRequestTarget = {
      environment,
      repo: `${repository.owner}/${repository.name}`,
      branch: workspace.branch,
      base: await ctx.prTargetBranch(),
    };

    try {
      for (const args of [
        ["remote", "get-url", "--all", "origin"],
        ["remote", "get-url", "--all", "--push", "origin"],
      ]) {
        const url = await ctx.deps.shell.git(environment, args, { signal: ctx.signal });
        const address = url.trim();
        if (address.includes("\n")) throw new Error("Origin has more than one URL");
        const remote = resolveGitHubRepository(address);
        if (`${remote.owner}/${remote.name}`.toLowerCase() !== target.repo.toLowerCase()) {
          throw new Error("Origin does not match the pull request repository");
        }
      }
    } catch {
      throw new GraphSystemActionError(
        "Could not confirm that origin fetches and pushes to the pull request repository",
        "provider-error",
      );
    }

    const key = `pr:${target.branch}`;
    const head = workspace.headRef;
    const workspaceMetadata = { headRef: head, baseRef: workspace.baseRef ?? undefined };
    let opened: { url: string; createdNow: boolean };
    let view: PrDetectionResult;
    let reopened = false;
    let edited = false;
    const routeConflicts = ctx.params.prePublicationResolution === true;
    try {
      const recorded = (await ctx.effectRecord(key))?.data?.url;
      const discovery =
        typeof recorded === "string" ? recorded : await openPullRequestFor(ctx, target);
      const existing = discovery ? await viewPullRequest(ctx, target, discovery) : undefined;
      const replacementKey = existing?.state === "merged" ? `${key}:after:${existing.url}` : key;
      const replacement =
        replacementKey === key ? undefined : (await ctx.effectRecord(replacementKey))?.data?.url;
      const candidate =
        typeof replacement === "string"
          ? await viewPullRequest(ctx, target, replacement)
          : existing?.state === "merged"
            ? undefined
            : existing;
      await checkPublication(
        ctx,
        { ...target, base: candidate?.baseBranch ?? target.base },
        head,
        false,
      );
      await pushGraphCommit(ctx, workspace);

      opened = await openOnce(ctx, target, description, replacementKey, head);
      view = await viewPullRequest(ctx, target, opened.url);
      if (view.state === "closed") {
        await checkPublication(ctx, { ...target, base: view.baseBranch! }, head, true);
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
      edited =
        !opened.createdNow && (await syncDescription(ctx, target, opened.url, description, head));
    } catch (error) {
      if (!(error instanceof PublicationConflict)) throw error;
      if (!routeConflicts) throw new GraphSystemActionError(error.message);
      const loop = ctx.run.plan.loops.find(({ members }) => members.includes(ctx.node.id));
      if (loop && ctx.activation.iteration >= loop.maxIterations) {
        throw new GraphSystemActionError(
          "The base still conflicts after the allowed publication attempts.",
        );
      }
      await ctx.output("workspace@1", workspace, { workspace: workspaceMetadata });
      await ctx.output("text@1", { text: error.base });
      await ctx.output("pull-request-state@1", {
        url: "",
        state: "unpublished",
        hasMergeConflicts: true,
      });
      return;
    }

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
    if (routeConflicts) {
      await ctx.output("workspace@1", workspace, { workspace: workspaceMetadata });
      await ctx.output("text@1", { text: view.baseBranch });
    }
    await ctx.output("pull-request-state@1", {
      url: opened.url,
      state: view.state,
      hasMergeConflicts: view.hasMergeConflicts,
    });
  },
};
