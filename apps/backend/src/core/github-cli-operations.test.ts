import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectEnvironmentPullRequest } from "./commands-pr-monitor.js";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { createEnvironmentCommandRunner, createLocalGhRunner } from "./commands-review.js";
import { setManagedGitHubCli } from "./github-cli-binary.js";
import type { GitHubCliConfigSource } from "./github-credentials.js";
import type { StorageService } from "./storage.js";
import type { AppConfig, Environment } from "./models.js";

let root: string;
let log: string;
let global: Partial<AppConfig["global"]>;
const gitHubConfig: GitHubCliConfigSource = {
  loadConfig: async () => ({ global: global as AppConfig["global"] }),
};
const originalTokens = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
const url = "https://github.com/acme/repo/pull/9";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-gh-operations-"));
  log = path.join(root, "calls.jsonl");
  const gh = path.join(root, "gh");
  // Write only the synthetic identity and a caller marker, never token values.
  await fs.writeFile(
    gh,
    `#!/bin/sh
set -eu
identity=host-login
if test -n "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}"; then
  test "\${GH_TOKEN:-}" = selected_pat && test -z "\${GITHUB_TOKEN:-}" || exit 20
  identity=pat-login
fi
printf '%s|%s|%s\\n' "$identity" "\${CALLER_MARKER:-}" "$*" >> '${log}'
case "$*" in
  *statusCheckRollup*) echo '{"statusCheckRollup":[]}' ;;
  'pr view'*) echo '{"url":"${url}","state":"OPEN","mergeable":"MERGEABLE"}' ;;
esac
`,
    { mode: 0o755 },
  );
  global = { useHostGitHubCredentials: false, githubToken: " selected_pat " };
  setManagedGitHubCli(gh);
  process.env.GH_TOKEN = "inherited_wrong_identity";
  process.env.GITHUB_TOKEN = "another_wrong_identity";
});

afterEach(async () => {
  setManagedGitHubCli(undefined);
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
    if (originalTokens[key] === undefined) delete process.env[key];
    else process.env[key] = originalTokens[key];
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function detect() {
  return detectEnvironmentPullRequest(
    {
      environmentId: "env",
      branch: "feature",
      kind: "local",
      worktreePath: root,
      ready: true,
      prUrl: url,
      prState: "open",
      hasMergeConflicts: false,
    },
    { includeCheckSummary: true, storage: gitHubConfig as StorageService },
  );
}

function environmentRunner() {
  return createEnvironmentCommandRunner(
    {
      id: "env",
      environmentType: "local",
      worktreePath: root,
    } as Environment,
    new EnvironmentMutationFence(),
    gitHubConfig,
  );
}

test("PR detection/check queries and local review/merge/delete runners all use the selected PAT", async () => {
  expect(await detect()).toMatchObject({ state: "open", checkSummaryStatus: "succeeded" });
  const gh = createLocalGhRunner(root, gitHubConfig);
  await gh(["pr", "diff", url]);
  await gh(["pr", "merge", url, "--squash"]);
  await gh(["api", "--method", "DELETE", "repos/acme/repo/git/refs/heads/feature"]);
  const base = {
    PATH: process.env.PATH,
    GH_TOKEN: "caller_wrong_identity",
    GITHUB_TOKEN: "caller_wrong_identity",
    CALLER_MARKER: "preserved",
  };
  await environmentRunner()("gh", ["pr", "view", url], 10_000, base);
  const calls = (await fs.readFile(log, "utf8")).trim().split("\n");
  expect(calls).toHaveLength(6);
  expect(calls.every((line) => line.startsWith("pat-login|"))).toBe(true);
  expect(calls[1]).toContain("statusCheckRollup");
  expect(calls.at(-1)).toContain("|preserved|");
  expect(base.GH_TOKEN).toBe("caller_wrong_identity");
});

test("host PR/review runners ignore inherited and caller token overrides", async () => {
  global = { useHostGitHubCredentials: true, githubToken: "unused_pat" };
  expect(await detect()).toMatchObject({ state: "open", checkSummaryStatus: "succeeded" });
  await createLocalGhRunner(root, gitHubConfig)(["pr", "merge", url, "--squash"]);
  await environmentRunner()("gh", ["pr", "diff", url], 10_000, {
    PATH: process.env.PATH,
    GH_TOKEN: "caller_token",
    GITHUB_TOKEN: "caller_token",
    CALLER_MARKER: "preserved",
  });
  const calls = (await fs.readFile(log, "utf8")).trim().split("\n");
  expect(calls).toHaveLength(4);
  expect(calls.every((line) => line.startsWith("host-login|"))).toBe(true);
  expect(calls.at(-1)).toContain("|preserved|");
});

test.each([undefined, "", "   "])(
  "missing PAT %j refuses PR/review/merge operations before gh runs",
  async (githubToken) => {
    global = { useHostGitHubCredentials: false, githubToken };
    await expect(detect()).rejects.toThrow("personal access token is missing");
    await expect(createLocalGhRunner(root, gitHubConfig)(["pr", "merge", url])).rejects.toThrow(
      "personal access token is missing",
    );
    await expect(environmentRunner()("gh", ["pr", "diff", url])).rejects.toThrow(
      "personal access token is missing",
    );
    expect(await fs.readFile(log, "utf8").catch(() => "")).toBe("");
  },
);
