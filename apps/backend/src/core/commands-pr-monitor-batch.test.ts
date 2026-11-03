import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PR_BATCH_EXCLUDED_MS,
  PR_BATCH_FAILURE_BACKOFF_MS,
  PR_BATCH_MAX_PULL_REQUESTS,
  PR_BATCH_MEMBER_TTL_MS,
  PR_BATCH_READING_MAX_AGE_MS,
  PrMonitorBatchReader,
  parsePrBatchResponse,
  prBatchQueryArgs,
  type PrBatchGroup,
} from "./commands-pr-monitor-batch.js";
import { detectEnvironmentPullRequest } from "./commands-pr-monitor.js";
import { gitHubCli } from "./github-cli-binary.js";
import type { PrMonitorTarget } from "./pr-monitor.js";
import { CommandFailedError, runCommand } from "./shell.js";

/**
 * The batch reader behind to-do 1202 task 9 (BG-6): local open PRs of one
 * host and credential share one GraphQL query, and anything a batch cannot
 * answer falls back to the per-PR `gh pr view`. Driven by an injected runner
 * for the reader's rules and by a fake `gh` on PATH for the boundary; nothing
 * reaches GitHub.
 */

const GROUP: PrBatchGroup = { key: "local-gh:github.com:host-cli", host: "github.com" };
const HEAD = "a".repeat(40);
const url = (number: number) => `https://github.com/acme/repo/pull/${number}`;

/** A GraphQL answer for the aliases a query carried, built from its variables. */
function answer(
  args: string[],
  override: (number: number) => Record<string, unknown> | null = () => ({}),
): string {
  const data: Record<string, unknown> = {};
  for (let index = 0; ; index += 1) {
    const owner = variable(args, `o${index}`);
    if (owner === null) break;
    const repo = variable(args, `r${index}`);
    const number = Number(variable(args, `n${index}`));
    const extra = override(number);
    data[`p${index}`] = {
      pullRequest:
        extra === null
          ? null
          : {
              url: `https://github.com/${owner}/${repo}/pull/${number}`,
              state: "OPEN",
              headRefOid: HEAD,
              baseRefName: "main",
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              isDraft: false,
              updatedAt: "2026-11-03T00:00:00Z",
              autoMergeRequest: null,
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: HEAD,
                      statusCheckRollup: {
                        contexts: {
                          pageInfo: { hasNextPage: false },
                          nodes: [
                            {
                              __typename: "CheckRun",
                              name: "ci",
                              status: "COMPLETED",
                              conclusion: "SUCCESS",
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
              ...extra,
            },
    };
  }
  return JSON.stringify({ data });
}

function variable(args: string[], name: string): string | null {
  const entry = args.find((arg) => arg.startsWith(`${name}=`));
  return entry === undefined ? null : entry.slice(name.length + 1);
}

function harness(run?: (args: string[]) => Promise<string>) {
  const clock = { value: 1_000 };
  const calls: string[][] = [];
  const changed: string[][] = [];
  const reader = new PrMonitorBatchReader({
    now: () => clock.value,
    run: async (_group, args) => {
      calls.push(args);
      return run ? run(args) : answer(args);
    },
    onChanged: (urls) => changed.push(urls),
  });
  return { reader, clock, calls, changed };
}

test("the query names repositories only through variables", () => {
  const args = prBatchQueryArgs("github.com", [
    { url: url(1), owner: "acme", repo: "repo", number: "1" },
    { url: url(2), owner: "acme", repo: "other", number: "2" },
  ]);
  const query = args.find((arg) => arg.startsWith("query="))!;
  expect(query).toContain("p1: repository(owner: $o1, name: $r1)");
  expect(query).not.toContain("acme");
  expect(args).toContain("-F");
  expect(args).toContain("n1=2");
  expect(args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.com"]);
});

test("PRs sharing a group are fetched in one query and later polls reuse it", async () => {
  const { reader, clock, calls } = harness();
  expect(await reader.read(GROUP, url(1))).not.toBeNull();
  expect(await reader.read(GROUP, url(2))).not.toBeNull();
  // The second PR joined the group after the first query, so it asked once.
  expect(calls).toHaveLength(2);
  clock.value += PR_BATCH_READING_MAX_AGE_MS + 1;
  const first = await reader.read(GROUP, url(1));
  expect(calls).toHaveLength(3);
  expect(variable(calls[2]!, "n0")).toBe("1");
  expect(variable(calls[2]!, "n1")).toBe("2");
  // The other member is answered from that reading without a process.
  const second = await reader.read(GROUP, url(2));
  expect(calls).toHaveLength(3);
  expect(second?.startedAt).toBe(first!.startedAt);
  expect(second?.pullRequest).toMatchObject({ url: url(2), state: "OPEN", headRefOid: HEAD });
  expect(second?.rollup).toHaveLength(1);
});

test("concurrent polls of one group share the query in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { reader, clock, calls } = harness(async (args) => {
    await gate;
    return answer(args);
  });
  // Register both members first.
  release();
  await reader.read(GROUP, url(1));
  await reader.read(GROUP, url(2));
  calls.length = 0;
  clock.value += PR_BATCH_READING_MAX_AGE_MS + 1;
  const [left, right] = await Promise.all([reader.read(GROUP, url(1)), reader.read(GROUP, url(2))]);
  expect(calls).toHaveLength(1);
  expect(left?.pullRequest.url).toBe(url(1));
  expect(right?.pullRequest.url).toBe(url(2));
});

test("a fresh read skips the shared reading", async () => {
  const { reader, calls } = harness();
  await reader.read(GROUP, url(1));
  await reader.read(GROUP, url(1), { fresh: true });
  expect(calls).toHaveLength(2);
});

test("groups never share readings or queries", async () => {
  const { reader, calls } = harness();
  await reader.read(GROUP, url(1));
  await reader.read({ key: "local-gh:github.com:pat", host: "github.com" }, url(1));
  expect(calls).toHaveLength(2);
  expect(variable(calls[1]!, "n1")).toBeNull();
});

test("a PR GitHub leaves out is read on its own and kept out of later queries", async () => {
  const { reader, clock, calls } = harness(async (args) =>
    answer(args, (number) => (number === 2 ? null : {})),
  );
  await reader.read(GROUP, url(1));
  expect(await reader.read(GROUP, url(2))).toBeNull();
  clock.value += PR_BATCH_READING_MAX_AGE_MS + 1;
  await reader.read(GROUP, url(1));
  expect(variable(calls.at(-1)!, "n1")).toBeNull();
  const before = calls.length;
  expect(await reader.read(GROUP, url(2))).toBeNull();
  expect(calls).toHaveLength(before);
  clock.value += PR_BATCH_EXCLUDED_MS + 1;
  await reader.read(GROUP, url(1));
  expect(variable(calls.at(-1)!, "n1")).toBe("2");
});

test("a renamed repository's answer is not trusted for the stored URL", async () => {
  const { reader } = harness(async (args) =>
    answer(args, () => ({ url: "https://github.com/acme/renamed/pull/1" })),
  );
  expect(await reader.read(GROUP, url(1))).toBeNull();
});

test("a failed batch falls back to the per-PR path and suspends the group", async () => {
  let fail = true;
  const { reader, clock, calls } = harness(async (args) => {
    if (fail) throw new CommandFailedError("gh: Something went wrong", { exitCode: 1 });
    return answer(args);
  });
  expect(await reader.read(GROUP, url(1))).toBeNull();
  fail = false;
  clock.value += 1;
  expect(await reader.read(GROUP, url(1))).toBeNull();
  expect(calls).toHaveLength(1);
  clock.value += PR_BATCH_FAILURE_BACKOFF_MS;
  expect(await reader.read(GROUP, url(1))).not.toBeNull();
});

test("a partly failed batch still answers the aliases GitHub returned", async () => {
  const { reader } = harness(async (args) => {
    throw new CommandFailedError("gh: Could not resolve to a PullRequest", {
      exitCode: 1,
      stdout: answer(args, (number) => (number === 2 ? null : {})),
    });
  });
  await reader.read(GROUP, url(2));
  expect(await reader.read(GROUP, url(1), { fresh: true })).not.toBeNull();
});

test("rate limits and timeouts reach the monitor instead of a per-PR retry", async () => {
  const limited = harness(async () => {
    throw new CommandFailedError("GraphQL: API rate limit exceeded for user ID 1.", {
      exitCode: 1,
    });
  });
  await expect(limited.reader.read(GROUP, url(1))).rejects.toThrow("rate limit");
  const slow = harness(async () => {
    throw new CommandFailedError("timed out", { timedOut: true });
  });
  await expect(slow.reader.read(GROUP, url(1))).rejects.toThrow("timed out");
  // The timed-out group takes the per-PR path for the backoff.
  expect(await slow.reader.read(GROUP, url(1))).toBeNull();
});

test("a change seen for another member is announced, the requester's own is not", async () => {
  let updatedAt = "2026-11-03T00:00:00Z";
  const { reader, clock, changed } = harness(async (args) => answer(args, () => ({ updatedAt })));
  await reader.read(GROUP, url(1));
  await reader.read(GROUP, url(2));
  updatedAt = "2026-11-03T01:00:00Z";
  clock.value += PR_BATCH_READING_MAX_AGE_MS + 1;
  await reader.read(GROUP, url(1));
  expect(changed).toEqual([[url(2)]]);
});

test("a per-PR read refuses an older batch answer that lands after it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let blocked = false;
  const { reader, clock } = harness(async (args) => {
    if (blocked) await gate;
    return answer(args);
  });
  await reader.read(GROUP, url(1));
  await reader.read(GROUP, url(2));
  blocked = true;
  clock.value += PR_BATCH_READING_MAX_AGE_MS + 1;
  const pending = reader.read(GROUP, url(1));
  clock.value += 1;
  reader.forget(GROUP, url(2));
  release();
  expect(await pending).not.toBeNull();
  blocked = false;
  // No reading for url(2) from the batch that started before the per-PR read.
  const before = clock.value;
  const fresh = await reader.read(GROUP, url(2));
  expect(fresh?.startedAt).toBe(before);
});

test("credential rotation drops the scope's readings", async () => {
  const { reader, calls } = harness();
  await reader.read(GROUP, url(1));
  reader.invalidate("local-gh");
  await reader.read(GROUP, url(1));
  expect(calls).toHaveLength(2);
});

test("members age out and each query is bounded", async () => {
  const { reader, clock, calls } = harness();
  for (let number = 1; number <= PR_BATCH_MAX_PULL_REQUESTS + 5; number += 1) {
    await reader.read(GROUP, url(number), { fresh: true });
  }
  const last = calls.at(-1)!;
  expect(variable(last, `n${PR_BATCH_MAX_PULL_REQUESTS - 1}`)).not.toBeNull();
  expect(variable(last, `n${PR_BATCH_MAX_PULL_REQUESTS}`)).toBeNull();
  clock.value += PR_BATCH_MEMBER_TTL_MS + 1;
  await reader.read(GROUP, url(1), { fresh: true });
  expect(reader.memberCount(GROUP.key)).toBe(1);
});

test("an incomplete rollup is left to the per-PR rollup read", () => {
  const readings = parsePrBatchResponse(
    answer(
      [
        "-f",
        "o0=acme",
        "-f",
        "r0=repo",
        "-F",
        "n0=1",
        "-f",
        "o1=acme",
        "-f",
        "r1=repo",
        "-F",
        "n1=2",
      ],
      (number) =>
        number === 1
          ? { commits: { nodes: [{ commit: { oid: "b".repeat(40), statusCheckRollup: null } }] } }
          : { commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }] } },
    ),
    [url(1), url(2)],
    0,
  );
  expect(readings.get(url(1))?.rollup).toBeNull();
  expect(readings.get(url(2))?.rollup).toEqual([]);
});

// The boundary, through a fake `gh` on PATH.

let root: string;
let worktree: string;
let ghLog: string;
const originalPath = process.env.PATH;
const env = process.env as Record<string, string | undefined>;
const originalLog = env.FAKE_GH_LOG;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pr-batch-"));
  worktree = path.join(root, "worktree");
  const bin = path.join(root, "bin");
  ghLog = path.join(root, "gh.log");
  await fs.mkdir(worktree, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  // The fake answers `gh api graphql` from its own variables and `gh pr view`
  // with one open PR; every call is logged.
  const script = path.join(root, "fake-gh.ts");
  await fs.writeFile(
    script,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG!, JSON.stringify(args) + "\\n");
const value = (name: string) => args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
if (args[0] === "api" && args[1] === "graphql") {
  const data: Record<string, unknown> = {};
  for (let index = 0; value("o" + index) !== undefined; index += 1) {
    data["p" + index] = { pullRequest: {
      url: "https://github.com/" + value("o" + index) + "/" + value("r" + index) + "/pull/" + value("n" + index),
      state: "OPEN", headRefOid: "${HEAD}", baseRefName: "main", mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN", isDraft: false, updatedAt: "2026-11-03T00:00:00Z", autoMergeRequest: null,
      commits: { nodes: [{ commit: { oid: "${HEAD}", statusCheckRollup: { contexts: {
        pageInfo: { hasNextPage: false },
        nodes: [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null }],
      } } } }] },
    } };
  }
  console.log(JSON.stringify({ data }));
} else if (args[0] === "pr" && args[1] === "view") {
  if (args.includes("statusCheckRollup,headRefOid")) {
    console.log(JSON.stringify({ headRefOid: "${HEAD}", statusCheckRollup: [] }));
  } else {
    console.log(JSON.stringify({ url: args[2], state: "OPEN", headRefOid: "${HEAD}", mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN", isDraft: false, baseRefName: "main", updatedAt: "2026-11-03T00:00:00Z", autoMergeRequest: null }));
  }
} else {
  console.error("unexpected gh call");
  process.exit(1);
}
`,
  );
  await fs.writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  env.FAKE_GH_LOG = ghLog;
});

beforeEach(async () => {
  await fs.rm(ghLog, { force: true });
});

afterAll(async () => {
  process.env.PATH = originalPath;
  if (originalLog === undefined) delete env.FAKE_GH_LOG;
  else env.FAKE_GH_LOG = originalLog;
  await fs.rm(root, { recursive: true, force: true });
});

async function ghCalls(): Promise<string[][]> {
  const text = await fs.readFile(ghLog, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function localTarget(number: number): PrMonitorTarget {
  return {
    environmentId: `env-${number}`,
    branch: `feature/${number}`,
    kind: "local",
    worktreePath: worktree,
    ready: true,
    prUrl: url(number),
    prState: "open",
    hasMergeConflicts: false,
  };
}

function hostReader(): PrMonitorBatchReader {
  return new PrMonitorBatchReader({
    run: async (_group, args) =>
      (await runCommand(gitHubCli(), args, { timeoutMs: 10_000 })).stdout,
  });
}

test("local monitor lookups of one host share one gh process, rollup included", async () => {
  const batch = hostReader();
  // Both PRs become members, as their first polls do.
  await detectEnvironmentPullRequest(localTarget(1), { batch });
  await detectEnvironmentPullRequest(localTarget(2), { batch });
  await fs.rm(ghLog, { force: true });
  const [first, second] = await Promise.all([
    detectEnvironmentPullRequest(localTarget(1), { batch, includeCheckSummary: true, fresh: true }),
    detectEnvironmentPullRequest(localTarget(2), { batch, includeCheckSummary: true }),
  ]);
  for (const [detection, number] of [
    [first, 1],
    [second, 2],
  ] as const) {
    expect(detection).toMatchObject({
      url: url(number),
      state: "open",
      hasMergeConflicts: false,
      headSha: HEAD,
      updatedAt: "2026-11-03T00:00:00Z",
      autoMergeRequested: false,
      checkSummary: { passed: 0, total: 1, pending: 1 },
      checkSummaryStatus: "succeeded",
    });
  }
  const calls = await ghCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.slice(0, 2)).toEqual(["api", "graphql"]);
});

test("without a batch reader a local lookup keeps the per-PR gh pr view", async () => {
  const detection = await detectEnvironmentPullRequest(localTarget(3), {
    includeCheckSummary: true,
  });
  expect(detection).toMatchObject({
    state: "open",
    updatedAt: "2026-11-03T00:00:00Z",
    autoMergeRequested: false,
    checkSummaryStatus: "succeeded",
  });
  const calls = await ghCalls();
  expect(calls.map((call) => call.slice(0, 2))).toEqual([
    ["pr", "view"],
    ["pr", "view"],
  ]);
  expect(calls[0]!.at(-1)).toContain("updatedAt,autoMergeRequest");
});

test("branch discovery never batches", async () => {
  const batch = hostReader();
  await detectEnvironmentPullRequest(
    { ...localTarget(4), prUrl: null, prState: null },
    { batch },
  ).catch(() => null);
  expect((await ghCalls()).every((call) => call[0] === "pr")).toBe(true);
  expect(batch.memberCount("local-gh:github.com:host-cli")).toBe(0);
});

for (const freshFirst of [false, true]) {
  test(`overlapping batches preserve newer state and checks (fresh finishes first: ${freshFirst})`, async () => {
    const pending: Array<{ args: string[]; resolve: (value: string) => void }> = [];
    const { reader, changed } = harness(
      (args) => new Promise((resolve) => pending.push({ args, resolve })),
    );
    const older = reader.read(GROUP, url(1));
    // Same clock tick: ordering must not depend on timestamp resolution.
    const newer = reader.read(GROUP, url(1), { fresh: true });
    const joining = reader.read(GROUP, url(1));
    const finishOld = () => pending[0]!.resolve(answer(pending[0]!.args));
    const finishNew = () =>
      pending[1]!.resolve(
        answer(pending[1]!.args, () => ({ state: "MERGED" })).replaceAll("SUCCESS", "FAILURE"),
      );
    if (freshFirst) {
      finishNew();
      await newer;
      finishOld();
    } else {
      finishOld();
      expect(await older).toBeNull();
      finishNew();
    }
    expect(await older).toBeNull();
    const latest = await newer;
    expect(latest?.pullRequest.state).toBe("MERGED");
    expect(latest?.rollup).toEqual([expect.objectContaining({ conclusion: "FAILURE" })]);
    expect(await joining).toEqual(latest);
    expect(await reader.read(GROUP, url(1))).toEqual(latest);
    expect(changed).toEqual([]);
  });
}

test("credential invalidation discards pending readings for requester and joiners", async () => {
  let release!: (value: string) => void;
  let args!: string[];
  const { reader } = harness((query) => {
    args = query;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const requester = reader.read(GROUP, url(1));
  const joining = reader.read(GROUP, url(1));
  reader.invalidate("local-gh");
  release(answer(args));
  expect(await requester).toBeNull();
  expect(await joining).toBeNull();
});

test("detection falls back after its pending batch credential is invalidated", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const batch = new PrMonitorBatchReader({
    run: async (_group, args) => {
      started();
      await gate;
      return answer(args, () => ({ state: "MERGED" }));
    },
  });
  const pending = detectEnvironmentPullRequest(localTarget(1), { batch });
  await running;
  batch.invalidate("local-gh");
  release();
  expect(await pending).toMatchObject({ state: "open", url: url(1) });
  expect((await ghCalls()).map((call) => call.slice(0, 2))).toEqual([["pr", "view"]]);
});
