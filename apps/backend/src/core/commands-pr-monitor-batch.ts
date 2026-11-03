/**
 * One GraphQL query for the open pull requests that share a `gh` host and
 * credential (to-do 1202 task 9, BG-6).
 *
 * Each monitored PR used to cost a `gh pr view` every 20 s, plus a separate
 * rollup read every minute. Local environments all run the host's `gh` with
 * the credential selected in Settings, so their PRs on one host can be read
 * together: the first lookup that finds no recent reading asks GitHub about
 * every PR of its group in one aliased query, and the other members' polls in
 * the next few seconds are answered from that reading without a process.
 *
 * Containers are not batched. Each one sources its own runtime credential and
 * the backend cannot prove two of them equal, so no credential crosses an
 * environment boundary; they keep the per-PR path.
 *
 * The reader is an optimisation only. Anything it cannot answer (a member
 * GitHub left out, an unparseable or failed batch, a PR on another host)
 * returns null and the caller takes the per-PR path, so a batch never decides
 * a reading the old path would have read differently. Rate-limit and timeout
 * failures are rethrown so the monitor's cooldown and backoff still apply.
 *
 * Bounds: groups, members per group and PRs per query are capped; a member
 * that stops asking ages out. Readings are in memory only and never logged.
 */

import { parseGitHubPullRequestUrl } from "./commands-review.js";
import { classifyPrDetectionFailure } from "./pr-monitor-policy.js";

/** PRs per query: one page of aliases keeps a batch well inside one rate-limit point. */
export const PR_BATCH_MAX_PULL_REQUESTS = 25;
/** A background poll accepts a group reading this old; half the 20 s cadence. */
export const PR_BATCH_READING_MAX_AGE_MS = 10_000;
/** A member that has not asked for this long leaves its group's queries. */
export const PR_BATCH_MEMBER_TTL_MS = 15 * 60_000;
/** After a failed batch the group takes the per-PR path for this long. */
export const PR_BATCH_FAILURE_BACKOFF_MS = 5 * 60_000;
/** A PR GitHub left out of a batch is read on its own for this long. */
export const PR_BATCH_EXCLUDED_MS = 10 * 60_000;
/** Same budget as one per-PR lookup (`PR_DETECTION_TIMEOUT_MS`). */
export const PR_BATCH_TIMEOUT_MS = 30_000;
const MAX_GROUPS = 16;
const MAX_MEMBERS_PER_GROUP = 64;
/** One page of rollup contexts, as `pr-required-checks.ts` reads; more leaves the rollup to `gh pr view`. */
const CONTEXT_PAGE = 100;

/**
 * Which `gh` host and credential a batch runs with. `key` is opaque and must
 * name a credential boundary the backend can prove, never a token or its hash.
 */
export interface PrBatchGroup {
  key: string;
  host: string;
}

export interface PrBatchReading {
  /** The PR in `gh pr view --json` shape, for the existing parsers. */
  pullRequest: Record<string, unknown>;
  /** Rollup contexts of `headRefOid`; null when incomplete (more than a page, head moved). */
  rollup: unknown[] | null;
  /** Monotonic start of the query that produced it. */
  startedAt: number;
}

export type PrBatchRunner = (group: PrBatchGroup, args: string[]) => Promise<string>;

export interface PrMonitorBatchReaderOptions {
  run: PrBatchRunner;
  now?: () => number;
  /**
   * PRs whose reading changed in a batch some other PR asked for. The monitor
   * uses it to re-read a quiet entry at once instead of at its slow cadence.
   */
  onChanged?: (prUrls: string[]) => void;
}

interface PrBatchMember {
  url: string;
  owner: string;
  repo: string;
  number: string;
}

interface Flight {
  urls: Set<string>;
  promise: Promise<Map<string, PrBatchReading>>;
}

interface GroupState {
  /** url → monotonic time it last asked; insertion order is recency. */
  members: Map<string, number>;
  /** url → monotonic time until which it is read on its own. */
  excluded: Map<string, number>;
  suspendedUntil: number;
  flights: Set<Flight>;
}

const PULL_REQUEST_FIELDS = [
  "url",
  "state",
  "headRefOid",
  "headRefName",
  "baseRefName",
  "isCrossRepository",
  "isDraft",
  "mergeable",
  "mergeStateStatus",
  "updatedAt",
] as const;

const PULL_REQUEST_FRAGMENT = `fragment pr on PullRequest {
  ${PULL_REQUEST_FIELDS.join(" ")}
  autoMergeRequest { enabledAt }
  commits(last: 1) { nodes { commit { oid statusCheckRollup {
    contexts(first: ${CONTEXT_PAGE}) {
      pageInfo { hasNextPage }
      nodes {
        __typename
        ... on CheckRun { name checkSuite { workflowRun { workflow { name } } } status conclusion }
        ... on StatusContext { context state }
      }
    }
  } } } }
}`;

/** The repository and number of a github.com PR URL, or null for one a batch cannot name. */
export function prBatchMember(url: string): PrBatchMember | null {
  try {
    const { owner, repo, number } = parseGitHubPullRequestUrl(url);
    return { url, owner, repo, number };
  } catch {
    return null;
  }
}

/** `gh api graphql` arguments for one aliased query; names travel as variables, never in the text. */
export function prBatchQueryArgs(host: string, members: readonly PrBatchMember[]): string[] {
  const variables = members
    .map((_, index) => `$o${index}: String!, $r${index}: String!, $n${index}: Int!`)
    .join(", ");
  const aliases = members
    .map(
      (_, index) =>
        `p${index}: repository(owner: $o${index}, name: $r${index}) { pullRequest(number: $n${index}) { ...pr } }`,
    )
    .join(" ");
  const query = `query(${variables}) { ${aliases} } ${PULL_REQUEST_FRAGMENT}`.replace(/\s+/g, " ");
  const args = ["api", "graphql", "--hostname", host, "-f", `query=${query}`];
  members.forEach((member, index) => {
    args.push(
      "-f",
      `o${index}=${member.owner}`,
      "-f",
      `r${index}=${member.repo}`,
      "-F",
      `n${index}=${member.number}`,
    );
  });
  return args;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Readings by URL for the aliases GitHub answered. An alias whose PR is
 * missing, or whose URL differs from the one asked for (a renamed
 * repository), is left out so its caller reads it on its own. Throws when
 * the output is not a GraphQL response with data (an authentication or
 * server failure), which suspends the whole group.
 */
export function parsePrBatchResponse(
  stdout: string,
  urls: readonly string[],
  startedAt: number,
): Map<string, PrBatchReading> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Failed to parse batched PR output");
  }
  const response = record(parsed);
  if (!response) throw new Error("Failed to parse batched PR output");
  const data = record(response.data);
  if (!data) throw new Error("GitHub returned no batched PR data");
  const readings = new Map<string, PrBatchReading>();
  urls.forEach((url, index) => {
    const pullRequest = record(record(data[`p${index}`])?.pullRequest);
    if (!pullRequest || pullRequest.url !== url) return;
    const shaped: Record<string, unknown> = {};
    for (const field of PULL_REQUEST_FIELDS) {
      if (field in pullRequest) shaped[field] = pullRequest[field];
    }
    if ("autoMergeRequest" in pullRequest) shaped.autoMergeRequest = pullRequest.autoMergeRequest;
    readings.set(url, { pullRequest: shaped, rollup: batchRollup(pullRequest), startedAt });
  });
  return readings;
}

/** The head commit's rollup contexts, `[]` for a head with none, null when not one whole page. */
function batchRollup(pullRequest: Record<string, unknown>): unknown[] | null {
  const nodes = record(pullRequest.commits)?.nodes;
  const commit = Array.isArray(nodes) ? record(record(nodes[0])?.commit) : null;
  if (!commit || typeof commit.oid !== "string" || commit.oid !== pullRequest.headRefOid) {
    return null;
  }
  if (commit.statusCheckRollup === null) return [];
  const contexts = record(record(commit.statusCheckRollup)?.contexts);
  if (!contexts || !Array.isArray(contexts.nodes)) return null;
  if (record(contexts.pageInfo)?.hasNextPage !== false) return null;
  return contexts.nodes;
}

function readingFingerprint(reading: PrBatchReading): string {
  return JSON.stringify([reading.pullRequest, reading.rollup]);
}

/** Shares one GitHub query among the open PRs of a host and credential. */
export class PrMonitorBatchReader {
  private readonly run: PrBatchRunner;
  private readonly now: () => number;
  private readonly onChanged: ((prUrls: string[]) => void) | undefined;
  private readonly groups = new Map<string, GroupState>();
  /** `group\0url` → latest reading. */
  private readonly readings = new Map<string, PrBatchReading>();
  /** `group\0url` → fingerprint of the latest reading, to notice a change. */
  private readonly fingerprints = new Map<string, string>();
  /** `group\0url` → a batch started before this may not store a reading. */
  private readonly notBefore = new Map<string, number>();
  /** Bumped by invalidation; a batch started under an older epoch stores nothing. */
  private epoch = 0;

  constructor(options: PrMonitorBatchReaderOptions) {
    this.run = options.run;
    this.now = options.now ?? (() => performance.now());
    this.onChanged = options.onChanged;
  }

  /**
   * The PR's reading from its group, or null when the caller should read it
   * on its own. `fresh` skips cached and in-flight readings: a user or a
   * pending intent is waiting on GitHub's current answer.
   */
  async read(
    group: PrBatchGroup,
    url: string,
    options: { fresh?: boolean } = {},
  ): Promise<PrBatchReading | null> {
    const member = prBatchMember(url);
    if (!member) return null;
    const now = this.now();
    const state = this.groupState(group.key);
    if ((state.excluded.get(url) ?? 0) > now) return null;
    state.excluded.delete(url);
    state.members.delete(url);
    state.members.set(url, now);
    this.boundMembers(group.key, state, now);
    const key = readingKey(group.key, url);
    if (!options.fresh) {
      const cached = this.readings.get(key);
      if (cached && now - cached.startedAt <= PR_BATCH_READING_MAX_AGE_MS) return cached;
      for (const flight of state.flights) {
        if (flight.urls.has(url)) return (await flight.promise).get(url) ?? null;
      }
    }
    if (state.suspendedUntil > now) return null;
    const members = [member];
    for (const candidate of Array.from(state.members.keys()).reverse()) {
      if (members.length >= PR_BATCH_MAX_PULL_REQUESTS) break;
      if (candidate === url || (state.excluded.get(candidate) ?? 0) > now) continue;
      const other = prBatchMember(candidate);
      if (other) members.push(other);
    }
    return (await this.start(group, state, members, url)).get(url) ?? null;
  }

  /**
   * The caller read this PR on its own: drop the group's reading and refuse
   * one from any batch that started earlier, so an older answer is never
   * served after a newer one.
   */
  forget(group: PrBatchGroup, url: string): void {
    if (!this.groups.get(group.key)?.members.has(url)) return;
    const key = readingKey(group.key, url);
    this.readings.delete(key);
    this.notBefore.set(key, this.now());
  }

  /** Credential rotation: drops every group named `scope` or `scope:…`, including running batches' results. */
  invalidate(scope: string): void {
    this.epoch += 1;
    for (const groupKey of Array.from(this.groups.keys())) {
      if (groupKey === scope || groupKey.startsWith(`${scope}:`)) this.dropGroup(groupKey);
    }
  }

  clear(): void {
    this.epoch += 1;
    this.groups.clear();
    this.readings.clear();
    this.fingerprints.clear();
    this.notBefore.clear();
  }

  /** Members a group's next query would carry (tests and diagnostics). */
  memberCount(groupKey: string): number {
    return this.groups.get(groupKey)?.members.size ?? 0;
  }

  private start(
    group: PrBatchGroup,
    state: GroupState,
    members: PrBatchMember[],
    requester: string,
  ): Promise<Map<string, PrBatchReading>> {
    const startedAt = this.now();
    const epoch = this.epoch;
    const urls = members.map((member) => member.url);
    const promise = (async () => {
      let stdout: string;
      try {
        stdout = await this.run(group, prBatchQueryArgs(group.host, members));
      } catch (error) {
        const failure = classifyPrDetectionFailure(error);
        if (failure.kind === "timeout")
          state.suspendedUntil = this.now() + PR_BATCH_FAILURE_BACKOFF_MS;
        // Retrying a refused or timed-out query per PR would spend more of the
        // budget it just ran out of; the monitor's cooldown handles it.
        if (failure.kind !== "failed") throw error;
        // `gh api` exits non-zero when any alias errs, but still prints the
        // aliases GitHub answered.
        const partial = record(error)?.stdout;
        stdout = typeof partial === "string" ? partial : "";
      }
      let readings: Map<string, PrBatchReading>;
      try {
        readings = parsePrBatchResponse(stdout, urls, startedAt);
      } catch {
        state.suspendedUntil = this.now() + PR_BATCH_FAILURE_BACKOFF_MS;
        return new Map<string, PrBatchReading>();
      }
      if (epoch !== this.epoch || this.groups.get(group.key) !== state) return readings;
      const changed: string[] = [];
      const now = this.now();
      for (const url of urls) {
        const reading = readings.get(url);
        if (!reading) {
          state.excluded.set(url, now + PR_BATCH_EXCLUDED_MS);
          continue;
        }
        const key = readingKey(group.key, url);
        if ((this.notBefore.get(key) ?? -Infinity) > startedAt) {
          readings.delete(url);
          continue;
        }
        this.notBefore.delete(key);
        this.readings.set(key, reading);
        const fingerprint = readingFingerprint(reading);
        const previous = this.fingerprints.get(key);
        this.fingerprints.set(key, fingerprint);
        if (url !== requester && previous !== undefined && previous !== fingerprint) {
          changed.push(url);
        }
        // A merged or closed PR is no longer polled by URL; stop carrying it.
        if (reading.pullRequest.state !== "OPEN" && url !== requester) {
          this.dropMember(group.key, state, url);
        }
      }
      if (changed.length > 0 && this.onChanged) {
        try {
          this.onChanged(changed);
        } catch {
          // A listener must never fail the reading it was told about.
        }
      }
      return readings;
    })();
    const flight: Flight = { urls: new Set(urls), promise };
    state.flights.add(flight);
    const settle = () => state.flights.delete(flight);
    promise.then(settle, settle);
    return promise;
  }

  private groupState(groupKey: string): GroupState {
    let state = this.groups.get(groupKey);
    if (state) {
      this.groups.delete(groupKey);
      this.groups.set(groupKey, state);
      return state;
    }
    while (this.groups.size >= MAX_GROUPS) {
      const oldest = this.groups.keys().next().value;
      if (oldest === undefined) break;
      this.dropGroup(oldest);
    }
    state = { members: new Map(), excluded: new Map(), suspendedUntil: 0, flights: new Set() };
    this.groups.set(groupKey, state);
    return state;
  }

  private boundMembers(groupKey: string, state: GroupState, now: number): void {
    for (const [url, askedAt] of Array.from(state.members)) {
      if (now - askedAt > PR_BATCH_MEMBER_TTL_MS || state.members.size > MAX_MEMBERS_PER_GROUP) {
        this.dropMember(groupKey, state, url);
      }
    }
    for (const [url, until] of Array.from(state.excluded)) {
      if (until <= now) state.excluded.delete(url);
    }
  }

  private dropMember(groupKey: string, state: GroupState, url: string): void {
    state.members.delete(url);
    const key = readingKey(groupKey, url);
    this.readings.delete(key);
    this.fingerprints.delete(key);
    this.notBefore.delete(key);
  }

  private dropGroup(groupKey: string): void {
    const state = this.groups.get(groupKey);
    if (!state) return;
    for (const url of Array.from(state.members.keys())) this.dropMember(groupKey, state, url);
    this.groups.delete(groupKey);
  }
}

function readingKey(groupKey: string, url: string): string {
  return `${groupKey}\0${url}`;
}
