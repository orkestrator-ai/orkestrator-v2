import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectEnvironmentPullRequest } from "./commands-pr-monitor.js";
import type { PrMonitorTarget } from "./pr-monitor.js";
import {
  failingCheckNames,
  parsePrRequiredChecks,
  PR_REQUIRED_CHECKS_RETRY_MS,
  PR_REQUIRED_CHECKS_TTL_MS,
  PrRequiredChecksCache,
  prRequiredChecksArgs,
} from "./pr-required-checks.js";

/**
 * Which failing checks GitHub requires (to-do 1021 task 7): the GraphQL
 * answer's parsing and guards, the per-head cache, and the monitor's `gh`
 * boundary through a fake `gh` on PATH.
 */

const PR_URL = "https://github.com/acme/repo/pull/9";
const HEAD = "a".repeat(40);

const failingRollup = [
  {
    __typename: "CheckRun",
    name: "build",
    workflowName: "CI",
    status: "COMPLETED",
    conclusion: "SUCCESS",
  },
  {
    __typename: "CheckRun",
    name: "lint",
    workflowName: "CI",
    status: "COMPLETED",
    conclusion: "FAILURE",
  },
  { __typename: "StatusContext", context: "deploy/preview", state: "ERROR" },
];

function graphqlAnswer(
  nodes: unknown[],
  change: { head?: string; hasNextPage?: boolean } = {},
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          headRefOid: change.head ?? HEAD,
          commits: {
            nodes: [
              {
                commit: {
                  oid: change.head ?? HEAD,
                  statusCheckRollup: {
                    contexts: { pageInfo: { hasNextPage: change.hasNextPage ?? false }, nodes },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
}

const requiredAnswer = [
  { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true },
  { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE", isRequired: true },
  { __typename: "StatusContext", state: "ERROR", isRequired: false },
];

describe("required check answers", () => {
  test("count only failing checks GitHub marks required", () => {
    expect(parsePrRequiredChecks(graphqlAnswer(requiredAnswer), HEAD)).toBe(1);
    expect(
      parsePrRequiredChecks(
        graphqlAnswer(requiredAnswer.map((node) => ({ ...node, isRequired: false }))),
        HEAD,
      ),
    ).toBe(0);
    // A running check that kept an old failing conclusion is not failing.
    expect(
      parsePrRequiredChecks(
        graphqlAnswer([{ status: "IN_PROGRESS", conclusion: "FAILURE", isRequired: true }]),
        HEAD,
      ),
    ).toBe(0);
  });

  test("an answer that is not complete, or about another head, is no answer", () => {
    expect(() =>
      parsePrRequiredChecks(graphqlAnswer(requiredAnswer, { head: "b".repeat(40) }), HEAD),
    ).toThrow("head changed");
    expect(() =>
      parsePrRequiredChecks(graphqlAnswer(requiredAnswer, { hasNextPage: true }), HEAD),
    ).toThrow("one page");
    expect(() => parsePrRequiredChecks(graphqlAnswer([{ state: "FAILURE" }]), HEAD)).toThrow(
      "whether a check is required",
    );
    expect(() => parsePrRequiredChecks('{"data":{"repository":null}}', HEAD)).toThrow(
      "did not return the pull request",
    );
    expect(() => parsePrRequiredChecks("not json", HEAD)).toThrow("parse");
  });

  test("asks github.com through gh api graphql, and nothing else", () => {
    const args = prRequiredChecksArgs(PR_URL)!;
    expect(args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.com"]);
    expect(args).toContain("owner=acme");
    expect(args).toContain("repo=repo");
    expect(args).toContain("number=9");
    expect(args.find((arg) => arg.startsWith("query="))).toContain(
      "isRequired(pullRequestNumber: $number)",
    );
    expect(prRequiredChecksArgs("https://ghe.example.com/acme/repo/pull/9")).toBeNull();
    expect(prRequiredChecksArgs("https://github.com/acme/repo/issues/9")).toBeNull();
  });

  test("failing names identify the failing set, not its order", () => {
    expect(failingCheckNames(failingRollup)).toEqual([
      "CheckRun/CI/lint",
      "StatusContext//deploy/preview",
    ]);
    expect(failingCheckNames([...failingRollup].reverse())).toEqual(
      failingCheckNames(failingRollup),
    );
    expect(failingCheckNames(null)).toEqual([]);
  });
});

describe("required check cache", () => {
  test("asks once per head and failing set, again when either changes or it expires", async () => {
    let now = 0;
    const cache = new PrRequiredChecksCache(() => now);
    let asked = 0;
    const fetch = async () => {
      asked += 1;
      return 1;
    };
    const failing = ["CheckRun/CI/lint"];
    expect(await cache.resolve(PR_URL, HEAD, failing, fetch)).toBe(1);
    expect(await cache.resolve(PR_URL, HEAD, failing, fetch)).toBe(1);
    expect(asked).toBe(1);
    await cache.resolve(PR_URL, HEAD, [...failing, "CheckRun/CI/test"], fetch);
    await cache.resolve(PR_URL, "b".repeat(40), failing, fetch);
    expect(asked).toBe(3);
    now += PR_REQUIRED_CHECKS_TTL_MS;
    await cache.resolve(PR_URL, HEAD, failing, fetch);
    expect(asked).toBe(4);
  });

  test("a failed lookup is unknown until the retry delay; concurrent polls share one lookup", async () => {
    let now = 0;
    const cache = new PrRequiredChecksCache(() => now);
    let asked = 0;
    const failing = ["CheckRun/CI/lint"];
    const broken = async () => {
      asked += 1;
      throw new Error("HTTP 403");
    };
    const [first, second] = await Promise.all([
      cache.resolve(PR_URL, HEAD, failing, broken),
      cache.resolve(PR_URL, HEAD, failing, broken),
    ]);
    expect([first, second, asked]).toEqual([null, null, 1]);
    expect(await cache.resolve(PR_URL, HEAD, failing, async () => 1)).toBeNull();
    now += PR_REQUIRED_CHECKS_RETRY_MS;
    expect(await cache.resolve(PR_URL, HEAD, failing, async () => 7)).toBe(1);
  });
});

describe("the PR monitor's gh boundary", () => {
  let root: string;
  let ghLog: string;
  let ghRequired: string;
  const env = process.env as Record<string, string | undefined>;
  const saved = { PATH: env.PATH, log: env.FAKE_GH_LOG, required: env.FAKE_GH_REQUIRED };

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pr-required-"));
    const bin = path.join(root, "bin");
    ghLog = path.join(root, "gh.log");
    ghRequired = path.join(root, "required.json");
    await fs.mkdir(path.join(root, "worktree"), { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(
      path.join(root, "rollup.json"),
      JSON.stringify({ headRefOid: HEAD, statusCheckRollup: failingRollup }),
    );
    await fs.writeFile(
      path.join(bin, "gh"),
      `#!/bin/sh
printf '%s\\n' "$1 $2" >> "$FAKE_GH_LOG"
case "$*" in
  "api graphql"*)
    if [ -s "$FAKE_GH_REQUIRED" ]; then cat "$FAKE_GH_REQUIRED"; exit 0; fi
    echo "HTTP 403: Resource not accessible by integration" >&2
    exit 1 ;;
  *statusCheckRollup*)
    cat "${root}/rollup.json"; exit 0 ;;
esac
printf '%s\\n' '{"url":"${PR_URL}","state":"OPEN","mergeable":"MERGEABLE","headRefOid":"${HEAD}","mergeStateStatus":"BLOCKED","isCrossRepository":false}'
`,
      { mode: 0o755 },
    );
    env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
    env.FAKE_GH_LOG = ghLog;
    env.FAKE_GH_REQUIRED = ghRequired;
  });

  afterAll(async () => {
    for (const [key, value] of [
      ["PATH", saved.PATH],
      ["FAKE_GH_LOG", saved.log],
      ["FAKE_GH_REQUIRED", saved.required],
    ] as const) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  function knownPr(): PrMonitorTarget {
    return {
      environmentId: "env-1",
      branch: "feature/required",
      kind: "local",
      worktreePath: path.join(root, "worktree"),
      ready: true,
      prUrl: PR_URL,
      prState: "open",
      hasMergeConflicts: false,
    };
  }

  async function ghCalls(): Promise<string[]> {
    const text = await fs.readFile(ghLog, "utf8").catch(() => "");
    await fs.rm(ghLog, { force: true });
    return text.split("\n").filter(Boolean);
  }

  test("a failing rollup asks which checks are required once, then reuses the answer", async () => {
    await fs.writeFile(ghRequired, graphqlAnswer(requiredAnswer));
    const requiredChecks = new PrRequiredChecksCache();
    const first = await detectEnvironmentPullRequest(knownPr(), {
      includeCheckSummary: true,
      requiredChecks,
    });
    expect(first?.checkSummary).toEqual({ passed: 1, total: 3, pending: 0, requiredFailed: 1 });
    expect(await ghCalls()).toEqual(["pr view", "pr view", "api graphql"]);

    const second = await detectEnvironmentPullRequest(knownPr(), {
      includeCheckSummary: true,
      requiredChecks,
    });
    expect(second?.checkSummary).toMatchObject({ requiredFailed: 1 });
    expect(await ghCalls()).toEqual(["pr view", "pr view"]);
  });

  test("when GitHub does not say, the summary has no required count and every failure counts", async () => {
    await fs.rm(ghRequired, { force: true });
    const detection = await detectEnvironmentPullRequest(knownPr(), {
      includeCheckSummary: true,
      requiredChecks: new PrRequiredChecksCache(),
    });
    expect(detection).toMatchObject({ checkSummaryStatus: "succeeded" });
    expect(detection?.checkSummary).toEqual({ passed: 1, total: 3, pending: 0 });
    expect(await ghCalls()).toEqual(["pr view", "pr view", "api graphql"]);
  });

  test("without a cache, or without a failing check, nothing extra is asked", async () => {
    await fs.writeFile(ghRequired, graphqlAnswer(requiredAnswer));
    await detectEnvironmentPullRequest(knownPr(), { includeCheckSummary: true });
    expect(await ghCalls()).toEqual(["pr view", "pr view"]);

    await fs.writeFile(
      path.join(root, "rollup.json"),
      JSON.stringify({ headRefOid: HEAD, statusCheckRollup: failingRollup.slice(0, 1) }),
    );
    try {
      const passing = await detectEnvironmentPullRequest(knownPr(), {
        includeCheckSummary: true,
        requiredChecks: new PrRequiredChecksCache(),
      });
      expect(passing?.checkSummary).toEqual({ passed: 1, total: 1, pending: 0 });
      expect(await ghCalls()).toEqual(["pr view", "pr view"]);
    } finally {
      await fs.writeFile(
        path.join(root, "rollup.json"),
        JSON.stringify({ headRefOid: HEAD, statusCheckRollup: failingRollup }),
      );
    }
  });
});
