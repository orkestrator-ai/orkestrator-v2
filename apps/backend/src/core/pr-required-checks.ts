/**
 * How many of a pull request's failing checks GitHub requires, so a
 * coordinator is woken for `pr-checks-failed` only when a required check
 * fails (to-do 1021 task 7).
 *
 * The monitor's rollup (`gh pr view --json statusCheckRollup`) has no
 * required flag. GraphQL's `isRequired(pullRequestNumber:)` does, so the
 * monitor asks it only when the rollup shows a failing check, and caches the
 * answer per PR head and set of failing checks: a PR whose optional check
 * keeps failing is asked once per push, not on every 20 s poll.
 *
 * Fallback: whenever GitHub does not answer (a token that cannot read it,
 * more than one page of checks, the head moved between the two reads, a host
 * other than github.com), the count stays unknown and every failing check
 * counts, with a notice saying the check may not be required.
 */

import { parseGitHubPullRequestUrl, prCheckOutcome } from "./commands-review.js";
import { prViewerRepository } from "./pr-viewer-permission.js";

/** A known answer holds this long; a branch-protection change waits at most this. */
export const PR_REQUIRED_CHECKS_TTL_MS = 30 * 60_000;
/** An unanswered lookup is unknown; ask again after this long. */
export const PR_REQUIRED_CHECKS_RETRY_MS = 5 * 60_000;
export const PR_REQUIRED_CHECKS_TIMEOUT_MS = 10_000;
/** One page of rollup contexts; more than this leaves the count unknown. */
const CONTEXT_PAGE = 100;
const MAX_ENTRIES = 500;

const REQUIRED_CHECKS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) { nodes { commit { oid statusCheckRollup {
        contexts(first: ${CONTEXT_PAGE}) {
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on CheckRun { name checkSuite { workflowRun { workflow { name } } } status conclusion isRequired(pullRequestNumber: $number) }
            ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
          }
        }
      } } } }
    }
  }
}`.replace(/\s+/g, " ");

/**
 * The failing rollup entries, as stable names: the cache key's part that
 * changes when a different check starts or stops failing on the same head.
 */
export function failingCheckNames(rollup: unknown): string[] {
  if (!Array.isArray(rollup)) return [];
  return rollup
    .filter((entry) => prCheckOutcome(entry) === "failed")
    .map((entry) => {
      const check =
        typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      const text = (value: unknown) => (typeof value === "string" ? value : "");
      return [
        text(check.__typename),
        text(
          check.workflowName ??
            record(record(record(check.checkSuite)?.workflowRun)?.workflow)?.name,
        ),
        text(check.name ?? check.context),
      ].join("/");
    })
    .sort();
}

/** `gh api graphql` arguments for one PR's required checks, or null for a URL it cannot ask about. */
export function prRequiredChecksArgs(prUrl: string): string[] | null {
  const repository = prViewerRepository(prUrl);
  if (!repository) return null;
  let number: string;
  try {
    ({ number } = parseGitHubPullRequestUrl(prUrl));
  } catch {
    return null;
  }
  return [
    "api",
    "graphql",
    "--hostname",
    repository.host,
    "-f",
    `query=${REQUIRED_CHECKS_QUERY}`,
    "-f",
    `owner=${repository.owner}`,
    "-f",
    `repo=${repository.repo}`,
    "-F",
    `number=${number}`,
  ];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The number of failing checks GitHub marks required. Throws when the answer
 * is not about `headSha`, is incomplete, or does not say: the caller then
 * counts every failing check.
 */
export function parsePrRequiredChecks(
  stdout: string,
  headSha: string,
  failing?: readonly string[],
): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Failed to parse required checks");
  }
  const pullRequest = record(record(record(record(parsed)?.data)?.repository)?.pullRequest);
  if (!pullRequest) throw new Error("GitHub did not return the pull request");
  if (pullRequest.headRefOid !== headSha) throw new Error("PR head changed while reading checks");
  const nodes = record(pullRequest.commits)?.nodes;
  const commit = Array.isArray(nodes) ? record(record(nodes[0])?.commit) : null;
  if (!commit || commit.oid !== headSha) throw new Error("PR head changed while reading checks");
  const contexts = record(record(commit.statusCheckRollup)?.contexts);
  if (!contexts || !Array.isArray(contexts.nodes)) {
    throw new Error("GitHub did not return the check rollup");
  }
  if (record(contexts.pageInfo)?.hasNextPage !== false) {
    throw new Error("More checks than one page");
  }
  if (
    failing &&
    JSON.stringify(failingCheckNames(contexts.nodes)) !== JSON.stringify([...failing].sort())
  ) {
    throw new Error("Failing checks changed while reading required status");
  }
  let required = 0;
  for (const node of contexts.nodes) {
    const check = record(node);
    if (!check || typeof check.isRequired !== "boolean") {
      throw new Error("GitHub did not say whether a check is required");
    }
    if (check.isRequired && prCheckOutcome(check) === "failed") required += 1;
  }
  return required;
}

interface CachedCount {
  requiredFailed: number | null;
  expiresAt: number;
}

/** Answers per PR, head and failing set, bounded and shared by concurrent polls. */
export class PrRequiredChecksCache {
  private readonly entries = new Map<string, CachedCount>();
  private readonly inFlight = new Map<string, Promise<number | null>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The cached count, or one lookup through `fetch`. A failed lookup resolves
   * to the last known answer, or null (unknown), and is retried after {@link PR_REQUIRED_CHECKS_RETRY_MS}.
   */
  async resolve(
    prUrl: string,
    headSha: string,
    failing: readonly string[],
    fetch: () => Promise<number>,
  ): Promise<number | null> {
    const key = JSON.stringify([prUrl, headSha, failing]);
    const now = this.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) return cached.requiredFailed;
    const running = this.inFlight.get(key);
    if (running) return running;
    this.prune(now);
    const lookup = Promise.resolve()
      .then(fetch)
      .then(
        (requiredFailed) => {
          this.store(key, Math.min(requiredFailed, failing.length), PR_REQUIRED_CHECKS_TTL_MS);
          return Math.min(requiredFailed, failing.length);
        },
        () => {
          const fallback = cached?.requiredFailed ?? null;
          this.store(key, fallback, PR_REQUIRED_CHECKS_RETRY_MS);
          return fallback;
        },
      );
    this.inFlight.set(key, lookup);
    try {
      return await lookup;
    } finally {
      this.inFlight.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  private store(key: string, requiredFailed: number | null, ttl: number): void {
    this.entries.delete(key);
    this.entries.set(key, { requiredFailed, expiresAt: this.now() + ttl });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now && entry.requiredFailed === null) this.entries.delete(key);
    }
  }
}
