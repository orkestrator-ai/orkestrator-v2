import { afterAll, beforeAll, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PR_DETECTION_TIMEOUT_MS,
  detectEnvironmentPullRequest,
  prMonitorCooldownScope,
} from "./commands-pr-monitor.js";
import type { PrMonitorTarget } from "./pr-monitor.js";
import { classifyPrDetectionFailure } from "./pr-monitor-policy.js";

/**
 * The `gh` boundary of backend PR monitoring, driven through a fake `gh` on
 * PATH: check-rollup permission failures never hide the PR state, terminal
 * PRs never pay for a rollup, and a rate-limit failure is classified so the
 * monitor can cool down.
 */

const PR_URL = "https://github.com/acme/repo/pull/9";
let root: string;
let worktree: string;
let ghLog: string;
let ghMode: string;
const originalPath = process.env.PATH;
const env = process.env as Record<string, string | undefined>;
const originalLog = env.FAKE_GH_LOG;
const originalMode = env.FAKE_GH_MODE;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pr-boundary-"));
  worktree = path.join(root, "worktree");
  const bin = path.join(root, "bin");
  ghLog = path.join(root, "gh.log");
  ghMode = path.join(root, "mode");
  await fs.mkdir(worktree, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
mode=$(cat "$FAKE_GH_MODE")
case "$*" in
  *statusCheckRollup*)
    echo "HTTP 403: Resource not accessible by integration" >&2
    exit 1 ;;
esac
if [ "$mode" = "rate-limited" ]; then
  echo "GraphQL: API rate limit exceeded for user ID 1." >&2
  exit 1
fi
printf '%s\\n' "{\\"url\\":\\"${PR_URL}\\",\\"state\\":\\"$mode\\",\\"mergeable\\":\\"MERGEABLE\\"}"
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  env.FAKE_GH_LOG = ghLog;
  env.FAKE_GH_MODE = ghMode;
});

afterAll(async () => {
  process.env.PATH = originalPath;
  if (originalLog === undefined) delete env.FAKE_GH_LOG;
  else env.FAKE_GH_LOG = originalLog;
  if (originalMode === undefined) delete env.FAKE_GH_MODE;
  else env.FAKE_GH_MODE = originalMode;
  await fs.rm(root, { recursive: true, force: true });
});

function knownPr(prState: "open" | "merged" = "open"): PrMonitorTarget {
  return {
    environmentId: "env-1",
    branch: "feature/boundary",
    kind: "local",
    worktreePath: worktree,
    ready: true,
    prUrl: PR_URL,
    prState,
    hasMergeConflicts: false,
  };
}

async function ghCalls(): Promise<string[]> {
  const text = await fs.readFile(ghLog, "utf8").catch(() => "");
  await fs.rm(ghLog, { force: true });
  return text.split("\n").filter(Boolean);
}

test("a check-rollup permission failure keeps the PR state and reports the rollup as failed", async () => {
  await fs.writeFile(ghMode, "OPEN");
  const detection = await detectEnvironmentPullRequest(knownPr(), { includeCheckSummary: true });
  expect(detection).toMatchObject({
    url: PR_URL,
    state: "open",
    hasMergeConflicts: false,
    checkSummary: null,
    checkSummaryStatus: "failed",
  });
  const calls = await ghCalls();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain("statusCheckRollup");
});

test("a merged PR is detected without paying for a check rollup", async () => {
  await fs.writeFile(ghMode, "MERGED");
  const detection = await detectEnvironmentPullRequest(knownPr(), { includeCheckSummary: true });
  expect(detection).toMatchObject({ state: "merged", checkSummaryStatus: "skipped" });
  expect(await ghCalls()).toHaveLength(1);
});

test("a gh rate-limit failure is classified for cooldown", async () => {
  await fs.writeFile(ghMode, "rate-limited");
  const failure = await detectEnvironmentPullRequest(knownPr(), {
    includeCheckSummary: false,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).not.toBeNull();
  expect(classifyPrDetectionFailure(failure)).toEqual({
    kind: "rate-limited",
    retryAfterMs: null,
  });
  await ghCalls();
});

test("cooldown scope is shared only by local environments on a proven host", () => {
  expect(prMonitorCooldownScope(knownPr())).toBe("local-gh:github.com");
  expect(
    prMonitorCooldownScope({ ...knownPr(), prUrl: "https://GHE.example.com/a/b/pull/1" }),
  ).toBe("local-gh:ghe.example.com");
  expect(prMonitorCooldownScope({ ...knownPr(), prUrl: null, prState: null })).toBeNull();
  expect(prMonitorCooldownScope({ ...knownPr(), prUrl: "not a url" })).toBeNull();
  expect(
    prMonitorCooldownScope({
      ...knownPr(),
      kind: "container",
      containerId: "c1",
      worktreePath: undefined,
    }),
  ).toBeNull();
  expect(PR_DETECTION_TIMEOUT_MS).toBe(30_000);
});
