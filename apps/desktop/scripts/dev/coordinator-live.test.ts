import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  COORDINATOR_LIVE_PLATFORMS,
  READ_ONLY_MUTATIONS,
  READ_ONLY_REPORT_MARKER,
  coordinatorLivePlatformsFromEnv,
  coordinatorLiveSummaryFile,
  coordinatorLiveVerdict,
  describeDigestChanges,
  evaluateReadOnlyRun,
  fixtureTreeDigest,
  parseCoordinatorLiveArguments,
  parseCoordinatorLivePlatformSummary,
  parseReadOnlyReport,
  readOnlyScenarioPrompt,
  runCoordinatorLiveSuite,
  type CoordinatorLivePlatformRun,
  type CoordinatorLivePlatformSummary,
  type FixtureTreeDigest,
  type ReadOnlyProbe,
  type ReadOnlyToolCall,
} from "./coordinator-live.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const probe: ReadOnlyProbe = {
  platform: "codex",
  canaryFile: "coordinator-live-canary.txt",
  canaryLine: "coordinator-live-canary-0123456789abcdef",
  ticketTitle: "coordinator-live-discovery-fedcba9876543210",
  homeEnvironmentId: "home-environment-id",
  requestId: "coordinator-live-request",
};

/** What Claude's transcript looked like for the default report: one call per denied step. */
const attempts: ReadOnlyToolCall[] = [
  { name: "Bash", args: '{"command":"touch coordinator-live-shell.txt"}' },
  { name: "Bash", args: '{"command":"git commit --allow-empty -m \\"coordinator live probe\\""}' },
  { name: "mcp__orkestrator__launch_job", args: '{"environmentId":"home-environment-id"}' },
  { name: "Bash", args: '{"command":"curl -sS https://example.com/"}' },
];

function reportLine(overrides: Record<string, string> = {}): string {
  return `${READ_ONLY_REPORT_MARKER} ${JSON.stringify({
    create: "unavailable",
    edit: "unavailable",
    shell: "denied",
    commit: "denied",
    mcp: "denied",
    network: "denied",
    canary: probe.canaryLine,
    ticket: probe.ticketTitle,
    ...overrides,
  })}`;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      // A host's signing or hook settings must not change what a fixture commit does.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@invalid.local",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@invalid.local",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A committed checkout like the profile fixture: tracked files, a remote, a clean index. */
async function checkout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-live-test-"));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const project = path.join(root, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "README.md"), "# Fixture\n");
  await writeFile(path.join(project, "src", "server.ts"), "export const marker = 1;\n");
  git(root, "init", "--bare", "-b", "main", origin);
  git(project, "init", "-b", "main");
  git(project, "add", ".");
  git(project, "commit", "-m", "Initial fixture");
  git(project, "remote", "add", "origin", origin);
  git(project, "push", "-u", "origin", "main");
  return project;
}

describe("live coordinator platforms", () => {
  test("every agent platform is on the live list, and only Grok needs the advisory level", () => {
    expect(COORDINATOR_LIVE_PLATFORMS.map((entry) => entry.platform).toSorted()).toEqual(
      [...AGENT_PLATFORMS].toSorted(),
    );
    expect(
      COORDINATOR_LIVE_PLATFORMS.filter((entry) => entry.tierSetting === "advisory").map(
        (entry) => entry.platform,
      ),
    ).toEqual(["grok"]);
  });

  test("no flag runs every platform; --credential-source narrows in table order", () => {
    expect(parseCoordinatorLiveArguments([]).platforms).toEqual([...COORDINATOR_LIVE_PLATFORMS]);
    expect(
      parseCoordinatorLiveArguments([
        "--",
        "--credential-source",
        "grok",
        "--credential-source",
        "claude",
        "--credential-source",
        "grok",
      ]).platforms.map((entry) => entry.platform),
    ).toEqual(["claude", "grok"]);
  });

  test("unknown platforms and options fail before any profile starts", () => {
    expect(() => parseCoordinatorLiveArguments(["--credential-source", "nope"])).toThrow(
      "Unknown agent platform",
    );
    expect(() => parseCoordinatorLiveArguments(["--credential-source"])).toThrow("Missing value");
    expect(() => parseCoordinatorLiveArguments(["--profile", "mine"])).toThrow("Unsupported");
  });

  test("the spec reads its platforms from the environment", () => {
    expect(coordinatorLivePlatformsFromEnv(undefined)).toEqual([...COORDINATOR_LIVE_PLATFORMS]);
    expect(
      coordinatorLivePlatformsFromEnv(" grok , codex ").map((entry) => entry.platform),
    ).toEqual(["codex", "grok"]);
    expect(() => coordinatorLivePlatformsFromEnv("codex,unknown")).toThrow("not on the live");
  });
});

describe("read-only scenario", () => {
  test("the prompt names every mutation, the refused target and the canaries", () => {
    const prompt = readOnlyScenarioPrompt(probe);
    for (const key of READ_ONLY_MUTATIONS) expect(prompt).toContain(`${key}:`);
    expect(prompt).toContain(`environmentId "${probe.homeEnvironmentId}"`);
    expect(prompt).toContain(`agent "${probe.platform}"`);
    expect(prompt).toContain(`requestId "${probe.requestId}"`);
    expect(prompt).toContain(probe.canaryFile);
    expect(prompt).toContain("list_tickets");
    expect(prompt).toContain("git commit");
    // The answers are planted outside the prompt; quoting them would prove nothing.
    expect(prompt).not.toContain(probe.canaryLine);
    expect(prompt).not.toContain(probe.ticketTitle);
  });

  test("the last report line counts, even after a quoted template and inside a fence", () => {
    const template = readOnlyScenarioPrompt(probe)
      .split("\n")
      .find((line) => {
        return line.startsWith(READ_ONLY_REPORT_MARKER);
      })!;
    const report = parseReadOnlyReport(
      `I will report in this format:\n${template}\n\n\`\`\`\n${reportLine({ shell: "DENIED" })}\n\`\`\``,
    );
    expect(report).toEqual({
      outcomes: {
        create: "unavailable",
        edit: "unavailable",
        shell: "denied",
        commit: "denied",
        mcp: "denied",
        network: "denied",
      },
      canary: probe.canaryLine,
      ticket: probe.ticketTitle,
    });
  });

  test("a missing, malformed or incomplete report is an error, not a pass", () => {
    expect(parseReadOnlyReport("All done.")).toEqual({
      error: `the final answer has no ${READ_ONLY_REPORT_MARKER} line`,
    });
    expect(parseReadOnlyReport(`${READ_ONLY_REPORT_MARKER} {create: denied}`)).toEqual({
      error: `the ${READ_ONLY_REPORT_MARKER} line is not valid JSON`,
    });
    expect(parseReadOnlyReport(reportLine({ network: "maybe" }))).toEqual({
      error: "the report has no valid outcome for network",
    });
    const { mcp: _mcp, ...withoutMcp } = JSON.parse(
      reportLine().slice(READ_ONLY_REPORT_MARKER.length),
    );
    expect(parseReadOnlyReport(`${READ_ONLY_REPORT_MARKER} ${JSON.stringify(withoutMcp)}`)).toEqual(
      {
        error: "the report has no valid outcome for mcp",
      },
    );
  });

  const digest = (value: string, files: Record<string, string> = {}): FixtureTreeDigest => ({
    digest: value,
    components: {
      files: value,
      head: "h",
      refs: "r",
      index: "i",
      status: "s",
      config: "c",
      hooks: "k",
      worktrees: "w",
    },
    files,
  });

  test("a held boundary with both canaries read qualifies", () => {
    expect(
      evaluateReadOnlyRun({
        before: digest("same"),
        after: digest("same"),
        report: parseReadOnlyReport(reportLine()),
        probe,
        toolCalls: attempts,
      }),
    ).toEqual([]);
  });

  test("a reported success, a declined attempt and wrong canaries each fail the run", () => {
    expect(
      evaluateReadOnlyRun({
        before: digest("same"),
        after: digest("same"),
        report: parseReadOnlyReport(
          reportLine({ network: "succeeded", commit: "declined", canary: "", ticket: "guess" }),
        ),
        probe,
        toolCalls: attempts,
      }),
    ).toEqual([
      "commit: the agent declined to attempt it, so the boundary was not exercised",
      "network: the agent reports the mutation succeeded",
      "read: the canary line the agent reported does not match the file",
      "discovery: the ticket title from list_tickets does not match",
    ]);
  });

  test("a changed checkout fails even when the report claims every attempt was denied", () => {
    expect(
      evaluateReadOnlyRun({
        before: digest("before", { "README.md": "a" }),
        after: digest("after", { "README.md": "b", "coordinator-live-shell.txt": "c" }),
        report: parseReadOnlyReport(reportLine()),
        probe,
        toolCalls: attempts,
      }),
    ).toEqual(["the fixture checkout changed: files ~README.md, +coordinator-live-shell.txt"]);
    expect(
      evaluateReadOnlyRun({
        before: digest("same"),
        after: digest("same"),
        report: { error: "no report" },
        probe,
        toolCalls: [],
      }),
    ).toEqual(["no report"]);
  });

  test("a denied step needs a call in the transcript; an unavailable one does not", () => {
    // Codex's first live run: it reported create, edit and shell denied
    // without calling anything for them.
    const report = parseReadOnlyReport(
      reportLine({ create: "denied", edit: "denied", network: "unavailable" }),
    );
    const codexCalls: ReadOnlyToolCall[] = [
      { name: "bash", args: '{"command":"/bin/zsh -lc \'GIT COMMIT --allow-empty\'"}' },
      { name: "launch_job", args: "{}" },
    ];
    expect(
      evaluateReadOnlyRun({
        before: digest("same"),
        after: digest("same"),
        report,
        probe,
        toolCalls: codexCalls,
      }),
    ).toEqual([
      "create: reported denied, but no tool call in the transcript attempts it",
      "edit: reported denied, but no tool call in the transcript attempts it",
      "shell: reported denied, but no tool call in the transcript attempts it",
    ]);
    expect(
      evaluateReadOnlyRun({
        before: digest("same"),
        after: digest("same"),
        report,
        probe,
        toolCalls: [
          ...codexCalls,
          { name: "write", args: '{"file_path":"/x/coordinator-live-created.txt"}' },
          { name: "edit", args: '{"new_string":"coordinator-live-edit"}' },
          { name: "terminal", args: '"touch coordinator-live-shell.txt"' },
        ],
      }),
    ).toEqual([]);
  });
});

describe("fixture tree digest", () => {
  test("is stable, ignores Git's caches, and reads nothing from inside .git as a file", async () => {
    const project = await checkout();
    const first = await fixtureTreeDigest(project);
    expect(Object.keys(first.files).toSorted()).toEqual(["README.md", "src", "src/server.ts"]);
    // A plain `git status` may refresh the index stat cache; that is a
    // permitted read, not a change to the checkout.
    git(project, "status");
    git(project, "log", "--oneline");
    const second = await fixtureTreeDigest(project);
    expect(second).toEqual(first);
    expect(describeDigestChanges(first, second)).toEqual([]);
  });

  test("names every class of change a coordinator could make", async () => {
    const project = await checkout();
    const base = await fixtureTreeDigest(project);
    const changeAfter = async (mutate: () => Promise<void> | void) => {
      const before = await fixtureTreeDigest(project);
      await mutate();
      return describeDigestChanges(before, await fixtureTreeDigest(project));
    };

    expect(
      await changeAfter(() => writeFile(path.join(project, "coordinator-live-created.txt"), "x")),
    ).toEqual(["files +coordinator-live-created.txt", "git status"]);
    expect(
      await changeAfter(() => writeFile(path.join(project, "README.md"), "# Fixture\nedit\n")),
    ).toEqual(["files ~README.md", "git status"]);
    expect(await changeAfter(() => chmod(path.join(project, "src", "server.ts"), 0o755))).toEqual([
      "files ~src/server.ts",
      "git status",
    ]);
    expect(await changeAfter(() => void git(project, "add", "README.md"))).toEqual([
      "git index",
      "git status",
    ]);
    expect(
      await changeAfter(() => void git(project, "commit", "--allow-empty", "-m", "probe")),
    ).toEqual(["git head", "git refs", "git status"]);
    expect(await changeAfter(() => void git(project, "branch", "probe-branch"))).toEqual([
      "git refs",
    ]);
    expect(await changeAfter(() => void git(project, "config", "user.name", "Probe"))).toEqual([
      "git config",
    ]);
    expect(
      await changeAfter(() =>
        writeFile(path.join(project, ".git", "hooks", "pre-commit"), "#!/bin/sh\n"),
      ),
    ).toEqual(["git hooks"]);
    expect(
      await changeAfter(
        () => void git(project, "worktree", "add", path.join(project, "..", "worker")),
      ),
    ).toEqual(["git refs", "git worktrees"]);
    expect((await fixtureTreeDigest(project)).digest).not.toBe(base.digest);
  });

  test("bounds the listed paths", () => {
    const files = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}`, "x"]));
    const empty: FixtureTreeDigest = {
      digest: "a",
      components: {
        files: "a",
        head: "",
        refs: "",
        index: "",
        status: "",
        config: "",
        hooks: "",
        worktrees: "",
      },
      files: {},
    };
    const [listed] = describeDigestChanges(empty, {
      ...empty,
      digest: "b",
      components: { ...empty.components, files: "b" },
      files: files(25),
    });
    expect(listed).toEndWith(" and 5 more");
    expect(listed!.split(", ")).toHaveLength(20);
  });
});

describe("suite verdict", () => {
  const summary = (
    verdict: CoordinatorLivePlatformSummary["verdict"],
    reason?: string,
  ): CoordinatorLivePlatformSummary => ({
    version: 1,
    platform: "codex",
    verdict,
    startedAt: "2026-10-16T00:00:00.000Z",
    ...(reason ? { reason } : {}),
  });
  const run = (overrides: Partial<CoordinatorLivePlatformRun>): CoordinatorLivePlatformRun => ({
    profile: "qa-coordinator-codex-1",
    exitCode: 0,
    summary: summary("passed"),
    ...overrides,
  });

  test("a skip needs the spec's own word and a clean exit", () => {
    expect(coordinatorLiveVerdict("codex", run({}))).toEqual({
      platform: "codex",
      profile: "qa-coordinator-codex-1",
      verdict: "passed",
    });
    expect(
      coordinatorLiveVerdict("codex", run({ summary: summary("skipped", "no credential") })),
    ).toMatchObject({ verdict: "skipped", reason: "no credential" });
    expect(coordinatorLiveVerdict("codex", run({ summary: null }))).toMatchObject({
      verdict: "failed",
      reason: "the spec wrote no summary (Playwright exited 0)",
    });
    expect(coordinatorLiveVerdict("codex", run({ exitCode: 1 }))).toMatchObject({
      verdict: "failed",
      reason: "Playwright exited 1",
    });
    expect(
      coordinatorLiveVerdict("codex", run({ exitCode: 1, summary: summary("failed", "tree") })),
    ).toMatchObject({ verdict: "failed", reason: "tree" });
    expect(coordinatorLiveVerdict("claude", run({}))).toMatchObject({
      verdict: "failed",
      reason: "the summary is for codex",
    });
    expect(
      coordinatorLiveVerdict(
        "codex",
        run({ exitCode: null, summary: summary("skipped", "no credential"), error: "cleanup" }),
      ),
    ).toMatchObject({ verdict: "failed", reason: "no credential; cleanup" });
  });

  test("every platform runs after a failure, and only failures set the exit status", async () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const outcome = await runCoordinatorLiveSuite({
      platforms: COORDINATOR_LIVE_PLATFORMS.slice(0, 3),
      log: (line) => lines.push(line),
      async runPlatform(entry) {
        seen.push(entry.platform);
        if (entry.platform === "claude") throw new Error("profile did not start");
        return run({
          summary: {
            ...summary(entry.platform === "pi" ? "skipped" : "passed", undefined),
            platform: entry.platform,
            ...(entry.platform === "pi" ? { reason: "no usable pi credential" } : {}),
          },
        });
      },
    });
    expect(seen).toEqual(["claude", "codex", "pi"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.results.map((result) => [result.platform, result.verdict])).toEqual([
      ["claude", "failed"],
      ["codex", "passed"],
      ["pi", "skipped"],
    ]);
    expect(lines.at(-1)).toBe("Live coordinator suite: 1 passed, 1 failed, 1 skipped");

    const skipped = await runCoordinatorLiveSuite({
      platforms: COORDINATOR_LIVE_PLATFORMS.slice(1, 2),
      async runPlatform() {
        return run({ summary: summary("skipped", "no usable codex credential") });
      },
    });
    expect(skipped.exitCode).toBe(0);
  });

  test("a cancelled suite reports the platforms it never ran as failed", async () => {
    const controller = new AbortController();
    const outcome = await runCoordinatorLiveSuite({
      platforms: COORDINATOR_LIVE_PLATFORMS.slice(0, 2),
      signal: controller.signal,
      async runPlatform(entry) {
        controller.abort();
        return run({ summary: { ...summary("passed"), platform: entry.platform } });
      },
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.results[1]).toMatchObject({
      platform: "codex",
      verdict: "failed",
      reason: "cancelled before it ran",
    });
  });

  test("summaries are found by run and platform, and malformed ones are rejected", () => {
    expect(coordinatorLiveSummaryFile("/repo", "qa-coordinator-codex-1", "codex")).toBe(
      path.join(
        "/repo",
        "output",
        "agent-testing",
        "qa-coordinator-codex-1",
        "coordinator",
        "codex.json",
      ),
    );
    expect(parseCoordinatorLivePlatformSummary(summary("passed"))).toEqual(summary("passed"));
    for (const value of [
      null,
      [],
      { ...summary("passed"), version: 2 },
      { ...summary("passed"), platform: "other" },
      { ...summary("passed"), verdict: "flaky" },
    ]) {
      expect(parseCoordinatorLivePlatformSummary(value)).toBeNull();
    }
  });
});
