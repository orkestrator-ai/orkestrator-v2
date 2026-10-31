import {
  coordinatorLiveBudgets,
  coordinatorLiveRunnerTimeout,
} from "./coordinator-live-budgets.js";
import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COORDINATOR_LIVE_PLATFORMS, COORDINATOR_LIVE_SCENARIOS } from "./coordinator-live.js";
import { COORDINATOR_LIVE_ROOT_ENV, runCoordinatorLive } from "./coordinator-live-runner.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const platforms = COORDINATOR_LIVE_PLATFORMS.filter(
  (entry) => entry.platform === "claude" || entry.platform === "codex",
);

/**
 * Stand-ins for `mise` and `bunx`: the profile lifecycle as in the isolated
 * browser tests, and a Playwright that writes the spec's summary where the
 * spec would, from the run id and platform the runner hands it.
 */
async function fixture(mode = "pass") {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-live-runner-test-"));
  roots.push(root);
  const source = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.ORK_RUNNER_TEST_ROOT;
const mode = process.env.ORK_RUNNER_TEST_MODE;
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE;
const args = process.argv.slice(2);
const browser = path.basename(process.argv[1]) === "bunx";
const task = browser ? "playwright" : args[1];
fs.appendFileSync(path.join(root, "events"), JSON.stringify({ task, profile, pid: process.pid, runId: process.env.ORKESTRATOR_AGENT_TEST_RUN_ID, platforms: process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_PLATFORMS, scenarios: process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_SCENARIOS, live: process.env.ORKESTRATOR_AGENT_TEST_LIVE_COORDINATOR }) + "\\n");
if (task === "dev:test") {
  fs.writeFileSync(path.join(root, "ready-" + profile), "yes");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {
    if (mode === "launcher-dies" && fs.existsSync(path.join(root, "tests-started"))) process.exit(8);
  }, 20);
} else if (task === "dev:status") {
  const ready = fs.existsSync(path.join(root, "ready-" + profile));
  console.log(JSON.stringify({ profile, status: ready ? "ready" : "starting", live: { launcher: ready, vite: ready, electron: ready, backend: ready } }));
} else if (browser) {
  const platform = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_PLATFORMS;
  const verdict = mode === "skip" ? "skipped" : mode === "pass" ? "passed" : "failed";
  for (const scenario of process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_SCENARIOS.split(",")) {
    const file = path.join(root, "output", "agent-testing", process.env.ORKESTRATOR_AGENT_TEST_RUN_ID, "coordinator", platform + "-" + scenario + ".json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, platform, scenario, verdict, startedAt: "t", ...(verdict === "passed" ? {} : { reason: "spec says " + mode }) }));
  }
  fs.writeFileSync(path.join(root, "tests-started"), String(process.pid));
  if (mode === "test-hang" || mode === "launcher-dies") setInterval(() => {}, 1000);
  else process.exit(verdict === "failed" ? 1 : 0);
} else if (task === "dev:stop") {
  fs.writeFileSync(path.join(root, "stopped-" + profile), "yes");
} else if (task === "dev:reset") {
  fs.writeFileSync(path.join(root, "reset"), "yes");
}
`;
  for (const name of ["mise", "bunx"])
    await writeFile(path.join(root, name), source, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    ORK_RUNNER_TEST_ROOT: root,
    ORK_RUNNER_TEST_MODE: mode,
  };
  const events = async () =>
    (await readFile(path.join(root, "events"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            task: string;
            profile: string;
            pid: number;
            runId?: string;
            platforms?: string;
            scenarios?: string;
            live?: string;
          },
      );
  return { root, env, events };
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (
      await access(file).then(
        () => true,
        () => false,
      )
    )
      return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${path.basename(file)}`);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const quiet = {
  log: () => undefined,
  startupTimeoutMs: 5_000,
  scenarios: ["read-only"] as const,
};

test("each platform's summary is found under its profile's run id and aggregated", async () => {
  const f = await fixture();
  const run = await runCoordinatorLive({
    ...f,
    ...quiet,
    platforms,
    runId: "run-pass",
    signal: new AbortController().signal,
  });
  expect(run.exitCode).toBe(0);
  expect(run.results.map(({ platform, verdict }) => ({ platform, verdict }))).toEqual([
    { platform: "claude", verdict: "passed" },
    { platform: "codex", verdict: "passed" },
  ]);
  const tests = (await f.events()).filter((event) => event.task === "playwright");
  expect(tests.map((event) => event.platforms)).toEqual(["claude", "codex"]);
  for (const event of tests) {
    expect(event.runId).toBe(event.profile);
    expect(event.profile).toStartWith(`qa-coordinator-${event.platforms}-`);
    expect(event.live).toBe("1");
  }
  expect(run.results.map((result) => result.profile)).toEqual(tests.map((event) => event.profile));
  expect(run.summaryFile).toBe(
    path.join(f.root, "output", "agent-testing", "run-pass", "summary.json"),
  );
  expect(JSON.parse(await readFile(run.summaryFile, "utf8"))).toEqual({
    version: 1,
    runId: "run-pass",
    results: run.results,
  });
});

test("every scenario runs by default, each in its own summary, combined per platform", async () => {
  const f = await fixture();
  const run = await runCoordinatorLive({
    ...f,
    log: quiet.log,
    startupTimeoutMs: quiet.startupTimeoutMs,
    platforms: platforms.slice(0, 1),
    signal: new AbortController().signal,
  });
  expect(run.exitCode).toBe(0);
  const tests = (await f.events()).filter((event) => event.task === "playwright");
  expect(tests.map((event) => event.scenarios)).toEqual([
    "read-only,async,family,status,deliver-now,goal,peer",
  ]);
  expect(run.results[0]).toMatchObject({
    platform: "claude",
    verdict: "passed",
    scenarios: [
      { scenario: "read-only", verdict: "passed" },
      { scenario: "async", verdict: "passed" },
      { scenario: "family", verdict: "passed" },
      { scenario: "status", verdict: "passed" },
      { scenario: "deliver-now", verdict: "passed" },
      { scenario: "goal", verdict: "passed" },
      { scenario: "peer", verdict: "passed" },
    ],
  });
});

test("a spec skip is a skip, and a spec failure fails the suite", async () => {
  const skipped = await fixture("skip");
  const skip = await runCoordinatorLive({
    ...skipped,
    ...quiet,
    platforms: platforms.slice(0, 1),
    signal: new AbortController().signal,
  });
  expect(skip.exitCode).toBe(0);
  expect(skip.results[0]).toMatchObject({ verdict: "skipped", reason: "spec says skip" });

  const failed = await fixture("fail");
  const fail = await runCoordinatorLive({
    ...failed,
    ...quiet,
    platforms: platforms.slice(0, 1),
    signal: new AbortController().signal,
  });
  expect(fail.exitCode).toBe(1);
  expect(fail.results[0]).toMatchObject({ verdict: "failed", reason: "spec says fail" });
});

test("the spec's summary is still read when the profile fails underneath it", async () => {
  const f = await fixture("launcher-dies");
  const run = await runCoordinatorLive({
    ...f,
    ...quiet,
    platforms: platforms.slice(0, 1),
    signal: new AbortController().signal,
  });
  expect(run.exitCode).toBe(1);
  expect(run.results[0]!.verdict).toBe("failed");
  expect(run.results[0]!.reason).toBe(
    "spec says launcher-dies; Isolated profile exited during browser tests",
  );
  expect((await f.events()).slice(-2).map((event) => event.task)).toEqual([
    "dev:stop",
    "dev:reset",
  ]);
});

test("cancelling stops and resets the running profile and fails the rest unrun", async () => {
  const f = await fixture("test-hang");
  const controller = new AbortController();
  const running = runCoordinatorLive({
    ...f,
    ...quiet,
    platforms,
    runId: "run-cancel",
    signal: controller.signal,
  });
  await waitForFile(path.join(f.root, "tests-started"));
  controller.abort();
  const run = await running;
  expect(run.exitCode).toBe(1);
  // Whichever aborted child exits first names the error; the spec's own
  // reason is kept either way.
  expect(run.results.map(({ verdict }) => verdict)).toEqual(["failed", "failed"]);
  expect(run.results[0]!.reason).toStartWith("spec says test-hang; ");
  expect(run.results[1]!.reason).toBe("cancelled before it ran");
  const events = await f.events();
  expect(events.slice(-2).map((event) => event.task)).toEqual(["dev:stop", "dev:reset"]);
  expect(alive(events.find((event) => event.task === "playwright")!.pid)).toBe(false);
  expect(JSON.parse(await readFile(run.summaryFile, "utf8")).results).toEqual(run.results);
});

test.each(["SIGTERM", "SIGKILL"] as const)(
  "owner %s still reaps the live run and resets its exact profile",
  async (signal) => {
    const f = await fixture("test-hang");
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../test-agent-coordinator-live.ts"),
        "--credential-source",
        "claude",
      ],
      {
        env: { ...f.env, [COORDINATOR_LIVE_ROOT_ENV]: f.root },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      await waitForFile(path.join(f.root, "tests-started"));
      child.kill(signal);
      await child.exited;
      await waitForFile(path.join(f.root, "reset"));
      const events = await f.events();
      for (const task of ["playwright", "dev:test"])
        expect(alive(events.find((event) => event.task === task)!.pid)).toBe(false);
      const profiles = new Set(events.map((event) => event.profile));
      expect(profiles.size).toBe(1);
      await waitForFile(path.join(f.root, `stopped-${[...profiles][0]}`));
    } finally {
      child.kill();
      await child.exited;
    }
  },
  15000,
);

test("runner budgets cover selected Playwright timeouts, underlying waits and cleanup margin", () => {
  for (const env of [
    {},
    {
      ORKESTRATOR_AGENT_TEST_COORDINATOR_TURN_TIMEOUT_MS: "1800000",
      ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS: "100000",
    },
    {
      ORKESTRATOR_AGENT_TEST_COORDINATOR_TURN_TIMEOUT_MS: "900000",
      ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS: "1200000",
      ORKESTRATOR_AGENT_TEST_COORDINATOR_FAMILY_TIMEOUT_MS: "3000000",
      ORKESTRATOR_AGENT_TEST_COORDINATOR_PEER_TIMEOUT_MS: "2400000",
    },
  ]) {
    const budgets = coordinatorLiveBudgets(env);
    expect(budgets.waits.async).toBe(7 * budgets.step);
    expect(budgets.waits.family).toBe(2 * budgets.step + budgets.family);
    expect(budgets.waits.peer).toBe(2 * budgets.step + budgets.peer);
    // Independently enumerate the live sequence: startup, review launch,
    // review completion, delegation, approval arrival, waiting wake, report.
    const statusWaits = [
      budgets.turn,
      budgets.step,
      budgets.review,
      budgets.step,
      budgets.step,
      budgets.step,
      budgets.step,
    ];
    const statusTotal = statusWaits.reduce((sum, wait) => sum + wait, 0);
    expect(budgets.tests.status).toBeGreaterThanOrEqual(statusTotal + budgets.overhead);
    expect(coordinatorLiveRunnerTimeout(["status"], env)).toBeGreaterThanOrEqual(
      statusTotal + budgets.overhead + budgets.processMargin,
    );
    const all = COORDINATOR_LIVE_SCENARIOS;
    for (const scenario of all) {
      expect(budgets.tests[scenario]).toBeGreaterThanOrEqual(
        budgets.waits[scenario] + budgets.overhead,
      );
      expect(coordinatorLiveRunnerTimeout([scenario], env)).toBeGreaterThanOrEqual(
        budgets.tests[scenario] + budgets.processMargin,
      );
    }
    expect(coordinatorLiveRunnerTimeout(all, env)).toBe(
      all.reduce((sum, scenario) => sum + budgets.tests[scenario] + budgets.processMargin, 0),
    );
  }
});
