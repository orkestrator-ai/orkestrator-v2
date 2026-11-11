import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { resolveElectronHeadless } from "./lifecycle.js";
import { parseAgentTestArguments } from "./arguments.js";
import {
  DOCKER_FIXTURE_SHARDS,
  IMAGE_QUALIFICATION_TESTS,
  dockerFixtureShards,
  dockerProfileArguments,
  isolatedLauncherTimeoutMs,
  isolatedProfileArguments,
  runIsolatedBrowser,
} from "./isolated-browser.js";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(mode = "success") {
  const root = await mkdtemp(path.join(tmpdir(), "isolated-browser-test-"));
  roots.push(root);
  const source = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.ORK_ISOLATED_TEST_ROOT;
let mode = process.env.ORK_ISOLATED_TEST_MODE;
const args = process.argv.slice(2);
// The profile a task names; Playwright has none and runs in the main one.
const named = args.indexOf("--profile");
const profile = named >= 0 ? args[named + 1] : process.env.ORKESTRATOR_AGENT_TEST_PROFILE;
if (process.env.ORK_ISOLATED_TEST_FAIL_PROFILE && profile !== process.env.ORK_ISOLATED_TEST_FAIL_PROFILE) mode = "success";
const readyFile = (name) => path.join(root, "ready-" + name);
const browser = path.basename(process.argv[1]) === "bunx";
const task = browser ? "playwright" : args[1];
fs.appendFileSync(path.join(root, "events"), JSON.stringify({ task, profile, args, pid: process.pid, scheduler: process.env.ORKESTRATOR_TEST_SCHEDULER_DIR, workers: process.env.ORKESTRATOR_TEST_HOST_WORKERS, headless: process.env.ORKESTRATOR_AGENT_TEST_HEADLESS, multiReview: process.env.ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW, coordinator: process.env.ORKESTRATOR_AGENT_TEST_LIVE_COORDINATOR, design: process.env.ORKESTRATOR_AGENT_TEST_LIVE_DESIGN, revisionTokens: process.env.ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS, tabRequests: process.env.ORKESTRATOR_AGENT_TEST_LIVE_TAB_REQUESTS, containerApproval: process.env.ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL, claudeTerminal: process.env.ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE_TERMINAL, grokLogin: process.env.ORKESTRATOR_AGENT_TEST_LIVE_GROK_LOGIN, idleObservation: process.env.ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION }) + "\\n");
if (task === "dev:test") {
  if (mode === "startup-fail") process.exit(3);
  fs.writeFileSync(path.join(root, "launcher"), String(process.pid));
  if (mode !== "startup-hang") fs.writeFileSync(readyFile(profile), profile);
  process.on("SIGTERM", () => { fs.rmSync(readyFile(profile), { force: true }); process.exit(0); });
  setInterval(() => {
    if (mode === "launcher-dies" && fs.existsSync(path.join(root, "tests-started"))) process.exit(8);
  }, 20);
} else if (task === "dev:status") {
  const ready = fs.existsSync(readyFile(profile));
  console.log(JSON.stringify({ profile, status: ready ? "ready" : "starting", live: { launcher: ready, vite: ready, electron: ready, backend: ready } }));
} else if (browser) {
  if (!fs.existsSync(readyFile(profile))) process.exit(42);
  for (const companion of (process.env.ORK_ISOLATED_TEST_COMPANIONS ?? "").split(",").filter(Boolean))
    if (!fs.existsSync(readyFile(companion))) process.exit(44);
  fs.writeFileSync(path.join(root, "tests-started"), String(process.pid));
  if (mode === "test-hang" || mode === "launcher-dies" || process.env.ORK_ISOLATED_TEST_FAIL_PROFILE) setInterval(() => {}, 1000);
  else process.exit(mode === "test-fail" ? 7 : 0);
} else if (task === "dev:stop") {
  fs.writeFileSync(path.join(root, "stopped"), "yes");
} else if (task === "dev:reset") {
  if (!fs.existsSync(path.join(root, "stopped"))) process.exit(43);
  fs.writeFileSync(path.join(root, "reset"), "yes");
  if (mode === "cleanup-fail") process.exit(9);
}
`;
  for (const name of ["mise", "bunx"])
    await writeFile(path.join(root, name), source, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    ORK_ISOLATED_TEST_ROOT: root,
    ORK_ISOLATED_TEST_MODE: mode,
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
            args: string[];
            pid: number;
            scheduler: string;
            workers: string;
            headless: string;
            containerApproval?: string;
            claudeTerminal?: string;
            grokLogin?: string;
            coordinator?: string;
            multiReview?: string;
            design?: string;
            idleObservation?: string;
            revisionTokens?: string;
            tabRequests?: string;
          },
      );
  return { root, env, events };
}

/**
 * Records the image qualification's arguments and environment, then exits
 * with `code`. It first waits (bounded) for a profile launcher, so a runner
 * that starts profiles only after the qualification records `false`.
 */
async function writeFakeBun(root: string, code = 0) {
  await writeFile(
    path.join(root, "bun"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.ORK_ISOLATED_TEST_ROOT;
const deadline = Date.now() + 3000;
const record = () => {
  const launcherStarted = fs.existsSync(path.join(root, "launcher"));
  if (!launcherStarted && Date.now() < deadline) return setTimeout(record, 20);
  fs.writeFileSync(path.join(root, "bun-call"), JSON.stringify({
    args: process.argv.slice(2),
    live: process.env.RUN_LIVE_DOCKER_TESTS,
    required: process.env.ORKESTRATOR_QUALIFICATION_REQUIRED,
    image: process.env.ORKESTRATOR_QUALIFICATION_IMAGE,
    launcherStarted,
  }));
  process.exit(${code});
};
record();
`,
    { mode: 0o755 },
  );
}

/** Each profile's own `dev:stop` then `dev:reset`, in the order they ran. */
function cleanupByProfile(events: Array<{ task: string; profile: string }>) {
  const byProfile = new Map<string, string[]>();
  for (const event of events)
    if (event.task === "dev:stop" || event.task === "dev:reset")
      byProfile.set(event.profile, [...(byProfile.get(event.profile) ?? []), event.task]);
  return Object.fromEntries(byProfile);
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

test("runs the targeted spec while the foreground launcher stays alive, then stops and resets", async () => {
  const f = await fixture();
  expect(await runIsolatedBrowser({ ...f, design: true })).toBe(0);
  const events = await f.events();
  const tests = events.find((event) => event.task === "playwright")!;
  expect(tests.args).toContain("e2e/agent-testing/design-canvas.spec.ts");
  expect(tests.scheduler).toContain(tests.profile);
  expect(tests.scheduler).not.toBe(f.env.ORKESTRATOR_TEST_SCHEDULER_DIR);
  expect(tests.workers).toBe("2");
  expect(events.slice(-2).map((event) => event.task)).toEqual(["dev:stop", "dev:reset"]);
  expect(new Set(events.map((event) => event.profile)).size).toBe(1);
  expect(alive(events.find((event) => event.task === "dev:test")!.pid)).toBe(false);
});

test("profile flags replace the credential-free Codex defaults they name", async () => {
  expect(isolatedProfileArguments()).toEqual([
    "--fixture",
    "--headless",
    "--no-agent-credentials",
    "--agent-platforms",
    "codex",
  ]);
  expect(
    isolatedProfileArguments([
      "--credential-source",
      "claude",
      "--agent-platforms",
      "codex,claude",
    ]),
  ).toEqual([
    "--fixture",
    "--headless",
    "--credential-source",
    "claude",
    "--agent-platforms",
    "codex,claude",
  ]);
  expect(() => isolatedProfileArguments(["--profile", "other"])).toThrow("Unsupported");
  // A port a host firewall admits (to-do 7080); the reserved ports are still refused.
  expect(isolatedProfileArguments(["--agent-tools-port", "31505"]).slice(-2)).toEqual([
    "--agent-tools-port",
    "31505",
  ]);
  expect(() => isolatedProfileArguments(["--agent-tools-port", "34121"])).toThrow("reserved");
  expect(() => isolatedProfileArguments(["--agent-platforms", "nope"])).toThrow("accepts");

  const f = await fixture();
  expect(await runIsolatedBrowser({ ...f, profileArgs: ["--agent-platforms", "opencode"] })).toBe(
    0,
  );
  const launcher = (await f.events()).find((event) => event.task === "dev:test")!;
  expect(launcher.args.slice(2)).toEqual([
    "--profile",
    launcher.profile,
    "--fixture",
    "--headless",
    "--no-agent-credentials",
    "--agent-platforms",
    "opencode",
  ]);
});

test("a one-shot run cannot opt out of headless", async () => {
  expect(() => isolatedProfileArguments(["--no-headless"])).toThrow("Unsupported");
  // Passing the flag the runner already adds is harmless.
  expect(parseAgentTestArguments(isolatedProfileArguments(["--headless"])).headless).toBe(true);

  // The flag beats an opt-out in the caller's environment; every suite goes through here.
  const f = await fixture();
  f.env.ORKESTRATOR_AGENT_TEST_HEADLESS = "0";
  expect(
    await runIsolatedBrowser({
      ...f,
      profileArgs: ["--credential-source", "claude", "--agent-platforms", "claude"],
      suite: { label: "live", config: "e2e/agent-testing/playwright.goals.config.ts" },
    }),
  ).toBe(0);
  const launcher = (await f.events()).find((event) => event.task === "dev:test")!;
  expect(launcher.args).toContain("--headless");
  const events = await f.events();
  expect(events.every((event) => event.headless === "1")).toBe(true);
  const tests = events.find((event) => event.task === "playwright")!;
  // A restarted launcher without flags resolves from the test process environment.
  expect(
    resolveElectronHeadless({
      flavor: "agent-test",
      platform: "linux",
      interactive: true,
      env: { ORKESTRATOR_AGENT_TEST_HEADLESS: tests.headless },
    }).headless,
  ).toBe(true);
  expect(f.env.ORKESTRATOR_AGENT_TEST_HEADLESS).toBe("0");
});

test("another suite runs its own config and opt-in in a profile the caller names", async () => {
  const f = await fixture();
  expect(
    await runIsolatedBrowser({
      ...f,
      design: true,
      profile: "qa-coordinator-claude-test",
      profileArgs: ["--credential-source", "claude", "--agent-platforms", "claude"],
      suite: {
        label: "live coordinator (claude)",
        config: "e2e/agent-testing/playwright.coordinator.config.ts",
        env: { ORKESTRATOR_AGENT_TEST_LIVE_COORDINATOR: "1" },
      },
    }),
  ).toBe(0);
  const events = await f.events();
  expect(new Set(events.map((event) => event.profile))).toEqual(
    new Set(["qa-coordinator-claude-test"]),
  );
  const tests = events.find((event) => event.task === "playwright")!;
  expect(tests.args).toEqual([
    "playwright",
    "test",
    "--config",
    "e2e/agent-testing/playwright.coordinator.config.ts",
    "--workers=1",
  ]);
  expect(tests.coordinator).toBe("1");
  expect(events.find((event) => event.task === "dev:test")!.args.slice(4)).toEqual([
    "--fixture",
    "--headless",
    "--credential-source",
    "claude",
    "--agent-platforms",
    "claude",
  ]);
  expect(events.slice(-2).map((event) => event.task)).toEqual(["dev:stop", "dev:reset"]);
});

test("companion profiles start after the main one, stay up for the suite, and are reset with it", async () => {
  const f = await fixture();
  f.env.ORK_ISOLATED_TEST_COMPANIONS = "qa-node-leaf-test";
  expect(
    await runIsolatedBrowser({
      ...f,
      profile: "qa-node-desk-test",
      companionProfiles: ["qa-node-leaf-test"],
      profileArgs: ["--no-agent-credentials", "--agent-platforms", "pi"],
      suite: {
        label: "two-profile suite",
        config: "e2e/agent-testing/playwright.coordinator-node-mail-fake.config.ts",
        env: { ORKESTRATOR_AGENT_TEST_NODE_MAIL_LEAF_PROFILE: "qa-node-leaf-test" },
      },
    }),
  ).toBe(0);
  const events = await f.events();
  const starts = events.filter((event) => event.task === "dev:test");
  expect(starts.map((event) => event.profile)).toEqual(["qa-node-desk-test", "qa-node-leaf-test"]);
  // Both get the same flags.
  expect(new Set(starts.map((event) => JSON.stringify(event.args.slice(4))))).toEqual(
    new Set([
      JSON.stringify([
        "--fixture",
        "--headless",
        "--no-agent-credentials",
        "--agent-platforms",
        "pi",
      ]),
    ]),
  );
  expect(events.find((event) => event.task === "playwright")!.profile).toBe("qa-node-desk-test");
  // Profiles are cleaned side by side, each stopped before it is reset.
  expect(cleanupByProfile(events)).toEqual({
    "qa-node-desk-test": ["dev:stop", "dev:reset"],
    "qa-node-leaf-test": ["dev:stop", "dev:reset"],
  });
  for (const start of starts) expect(alive(start.pid)).toBe(false);
});

test("a profile that fails to start stops the run before its companions and is still reset", async () => {
  const f = await fixture("startup-hang");
  await expect(
    runIsolatedBrowser({
      ...f,
      profile: "qa-node-desk-test",
      companionProfiles: ["qa-node-leaf-test"],
      startupTimeoutMs: 400,
    }),
  ).rejects.toThrow("startup timed out");
  const events = await f.events();
  expect(events.some((event) => event.task === "playwright")).toBe(false);
  // The main profile never got ready, so the companion was never started
  // and is not touched; the main one is cleaned as before.
  expect(
    events
      .filter((event) => ["dev:test", "dev:stop", "dev:reset"].includes(event.task))
      .map((event) => `${event.task} ${event.profile}`),
  ).toEqual([
    "dev:test qa-node-desk-test",
    "dev:stop qa-node-desk-test",
    "dev:reset qa-node-desk-test",
  ]);
});

test("a companion profile must not repeat the main one", async () => {
  const f = await fixture();
  await expect(
    runIsolatedBrowser({ ...f, profile: "qa-same", companionProfiles: ["qa-same"] }),
  ).rejects.toThrow("Companion profiles must be distinct");
});

test("full task runs the whole configured suite and preserves Playwright failure", async () => {
  const f = await fixture("test-fail");
  expect(await runIsolatedBrowser(f)).toBe(7);
  const events = await f.events();
  expect(events.find((event) => event.task === "playwright")!.args).not.toContain(
    "e2e/agent-testing/design-canvas.spec.ts",
  );
  expect(events.slice(-2).map((event) => event.task)).toEqual(["dev:stop", "dev:reset"]);
});

test.each(["startup-fail", "startup-hang"])(
  "cleans up %s without starting Playwright",
  async (mode) => {
    const f = await fixture(mode);
    await expect(runIsolatedBrowser({ ...f, startupTimeoutMs: 400 })).rejects.toThrow();
    const events = await f.events();
    expect(events.some((event) => event.task === "playwright")).toBe(false);
    expect(events.slice(-2).map((event) => event.task)).toEqual(["dev:stop", "dev:reset"]);
  },
);

test("a profile exit during Playwright terminates the test process and cleans up", async () => {
  const f = await fixture("launcher-dies");
  await expect(runIsolatedBrowser(f)).rejects.toThrow("exited during browser tests");
  const events = await f.events();
  expect(alive(events.find((event) => event.task === "playwright")!.pid)).toBe(false);
  expect(events.slice(-2).map((event) => event.task)).toEqual(["dev:stop", "dev:reset"]);
});

test("cleanup failure cannot report a passing run", async () => {
  const f = await fixture("cleanup-fail");
  await expect(runIsolatedBrowser(f)).rejects.toThrow("cleanup failed");
});

test("browser timeout is bounded and still resets the profile", async () => {
  const f = await fixture("test-hang");
  await expect(runIsolatedBrowser({ ...f, testTimeoutMs: 400 })).rejects.toThrow("timed out");
  expect((await f.events()).slice(-2).map((event) => event.task)).toEqual([
    "dev:stop",
    "dev:reset",
  ]);
});

test.each(["SIGTERM", "SIGKILL"] as const)(
  "owner %s still reaps the browser and resets its exact profile",
  async (signal) => {
    const f = await fixture("test-hang");
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../test-agent-browser-isolated.ts"),
        "--design",
      ],
      { env: f.env, stdout: "ignore", stderr: "ignore" },
    );
    try {
      await waitForFile(path.join(f.root, "tests-started"));
      child.kill(signal);
      await child.exited;
      await waitForFile(path.join(f.root, "reset"));
      const events = await f.events();
      for (const task of ["playwright", "dev:test"])
        expect(alive(events.find((event) => event.task === task)!.pid)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  },
  15000,
);

test("isolated browser overrides an inherited live Multi Review opt-in", async () => {
  const f = await fixture();
  f.env.ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW = "1";
  expect(await runIsolatedBrowser(f)).toBe(0);
  expect((await f.events()).find((event) => event.task === "playwright")?.multiReview).toBe("0");
});

test("isolated browser overrides an inherited live design opt-in", async () => {
  const f = await fixture();
  f.env.ORKESTRATOR_AGENT_TEST_LIVE_DESIGN = "1";
  expect(await runIsolatedBrowser(f)).toBe(0);
  expect((await f.events()).find((event) => event.task === "playwright")?.design).toBe("0");
});

test("isolated browser overrides an inherited live idle-observation opt-in", async () => {
  const f = await fixture();
  f.env.ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION = "1";
  expect(await runIsolatedBrowser(f)).toBe(0);
  expect((await f.events()).find((event) => event.task === "playwright")?.idleObservation).toBe(
    "0",
  );
});

test("isolated browser overrides an inherited live revision-token opt-in", async () => {
  const f = await fixture();
  f.env.ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS = "1";
  expect(await runIsolatedBrowser(f)).toBe(0);
  expect((await f.events()).find((event) => event.task === "playwright")?.revisionTokens).toBe("0");
});

test("isolated browser overrides an inherited live tab-requests opt-in", async () => {
  const f = await fixture();
  f.env.ORKESTRATOR_AGENT_TEST_LIVE_TAB_REQUESTS = "1";
  expect(await runIsolatedBrowser(f)).toBe(0);
  expect((await f.events()).find((event) => event.task === "playwright")?.tabRequests).toBe("0");
});

test.each(["success", "test-fail", "cleanup-fail"])(
  "Docker qualification preserves shared images on %s",
  async (mode) => {
    const f = await fixture(mode);
    // The fake commands exercise lifecycle ordering; Docker itself is covered by
    // the opt-in real fixture run.
    await writeFile(
      path.join(f.root, "docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$ORK_ISOLATED_TEST_ROOT/docker-calls"
# An in-use shared image must never be removed by this profile.
if [ "$1 $2" = "image rm" ]; then exit 9; fi
exit 0
`,
      { mode: 0o755 },
    );
    f.env.ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL = "1";
    f.env.ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE_TERMINAL = "1";
    f.env.ORKESTRATOR_AGENT_TEST_LIVE_GROK_LOGIN = "1";
    await writeFile(path.join(f.root, "bash"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFakeBun(f.root);
    if (mode === "cleanup-fail")
      await expect(runIsolatedBrowser({ ...f, docker: true })).rejects.toThrow("cleanup failed");
    else
      expect(await runIsolatedBrowser({ ...f, docker: true })).toBe(mode === "test-fail" ? 7 : 0);
    const events = await f.events();
    expect(events[0]?.task).toBe("docker:build:dev");
    // One profile per shard, each with the container fixture.
    const starts = events.filter((event) => event.task === "dev:test");
    expect(starts).toHaveLength(DOCKER_FIXTURE_SHARDS.length);
    // They start in turn: each startup compiles into the shared checkout, so
    // the next starts only once the previous one reported ready.
    const main = starts[0]!.profile;
    for (const [index, start] of starts.entries())
      if (index > 0)
        expect(
          events.findIndex((event) => event.task === "dev:status" && event.profile === main),
        ).toBeLessThan(events.indexOf(start));
    const shardProfiles = DOCKER_FIXTURE_SHARDS.map((_, index) =>
      index === 0 ? main : `${main}-${index + 1}`,
    );
    expect(new Set(starts.map((start) => start.profile))).toEqual(new Set(shardProfiles));
    for (const start of starts) {
      expect(start.args).toContain("--fixture-environments");
      expect(start.args).toContain("local,container");
      // Each shard profile takes its own port from the firewall range (to-do 7500).
      expect(start.args[start.args.indexOf("--agent-tools-port") + 1]).toBe("auto");
      expect(alive(start.pid)).toBe(false);
    }
    // Each profile runs exactly its own shard's files, in its own scheduler.
    const runs = events.filter((event) => event.task === "playwright");
    expect(runs).toHaveLength(DOCKER_FIXTURE_SHARDS.length);
    for (const tests of runs) {
      const shard = DOCKER_FIXTURE_SHARDS[shardProfiles.indexOf(tests.profile)]!;
      expect(tests.args.filter((arg) => arg.endsWith(".spec.ts"))).toEqual([...shard]);
      expect(tests.args).toContain("Docker fixture");
      expect(tests.args).toContain("--workers=1");
      expect(tests.scheduler).toContain(tests.profile);
      expect(tests.containerApproval).toBe("0");
      expect(tests.claudeTerminal).toBe("0");
      expect(tests.grokLogin).toBe("0");
    }
    expect(await Bun.file(path.join(f.root, "docker-calls")).exists()).toBe(false);
    expect(cleanupByProfile(events)).toEqual(
      Object.fromEntries(starts.map((start) => [start.profile, ["dev:stop", "dev:reset"]])),
    );
    // The image's live qualifications ran against the built image before the fixture.
    const qualification = JSON.parse(await readFile(path.join(f.root, "bun-call"), "utf8"));
    expect(qualification.args).toEqual([
      "test",
      "--cwd",
      "apps/backend",
      "--preload",
      "../../tests/setup-node.ts",
      ...IMAGE_QUALIFICATION_TESTS,
      "--parallel=1",
    ]);
    expect(qualification.args).toContain("./tests/claude-config-filter-docker.test.ts");
    expect(qualification.live).toBe("1");
    expect(qualification.required).toBe("1");
    expect(qualification.image).toMatch(/^orkestrator-v2:dev-/);
    // The qualification ran while the profiles started, after the image build.
    expect(qualification.launcherStarted).toBe(true);
  },
);

test("a failed image qualification stops the starting profiles before any test and cleans them up", async () => {
  const f = await fixture("startup-hang");
  await writeFile(path.join(f.root, "bash"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFakeBun(f.root, 5);
  await expect(runIsolatedBrowser({ ...f, docker: true })).rejects.toThrow(
    "Docker qualification image tests failed",
  );
  const events = await f.events();
  expect(events.map((event) => event.task)).not.toContain("playwright");
  // The first profile never got ready, so the next was never started.
  const starts = events.filter((event) => event.task === "dev:test");
  expect(starts).toHaveLength(1);
  expect(alive(starts[0]!.pid)).toBe(false);
  expect(cleanupByProfile(events)).toEqual({ [starts[0]!.profile]: ["dev:stop", "dev:reset"] });
});

test("a failed image smoke stops the qualification and the starting profiles", async () => {
  const f = await fixture("startup-hang");
  await writeFile(path.join(f.root, "bash"), "#!/bin/sh\nexit 4\n", { mode: 0o755 });
  // A qualification that would outlast the run unless it is stopped.
  await writeFile(path.join(f.root, "bun"), `#!/bin/sh\nexec sleep 30\n`, { mode: 0o755 });
  const started = performance.now();
  await expect(runIsolatedBrowser({ ...f, docker: true })).rejects.toThrow(
    "Docker qualification image smoke failed",
  );
  expect(performance.now() - started).toBeLessThan(15_000);
  const events = await f.events();
  expect(events.map((event) => event.task)).not.toContain("playwright");
  for (const start of events.filter((event) => event.task === "dev:test"))
    expect(alive(start.pid)).toBe(false);
});

test("one shard's profile exiting fails the run and still stops and resets every profile", async () => {
  const f = await fixture("launcher-dies");
  await writeFile(path.join(f.root, "bash"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFakeBun(f.root);
  // Only the second shard's launcher dies; the first shard's run hangs.
  f.env.ORK_ISOLATED_TEST_FAIL_PROFILE = "qa-docker-shards-2";
  await expect(
    runIsolatedBrowser({ ...f, docker: true, profile: "qa-docker-shards" }),
  ).rejects.toThrow("exited during browser tests");
  const events = await f.events();
  for (const event of events.filter((e) => e.task === "playwright" || e.task === "dev:test"))
    expect(alive(event.pid)).toBe(false);
  expect(cleanupByProfile(events)).toEqual({
    "qa-docker-shards": ["dev:stop", "dev:reset"],
    "qa-docker-shards-2": ["dev:stop", "dev:reset"],
  });
});

test("a Docker run takes an automatic agent-tools port unless the caller chose one", () => {
  expect(dockerProfileArguments(["--fixture"])).toEqual([
    "--fixture",
    "--fixture-environments",
    "local,container",
    "--agent-tools-port",
    "auto",
  ]);
  expect(dockerProfileArguments(["--agent-tools-port", "31505"])).toEqual([
    "--agent-tools-port",
    "31505",
    "--fixture-environments",
    "local,container",
  ]);
  // `auto` passes the launcher's own validation, and keeps one profile per shard.
  expect(parseAgentTestArguments(dockerProfileArguments([])).agentToolsPort).toBe("auto");
  expect(isolatedProfileArguments(["--agent-tools-port", "auto"]).slice(-2)).toEqual([
    "--agent-tools-port",
    "auto",
  ]);
  expect(dockerFixtureShards(["--agent-tools-port", "auto"])).toBe(DOCKER_FIXTURE_SHARDS);
});

test("a fixed agent-tools port keeps every Docker spec in one profile", async () => {
  expect(dockerFixtureShards([])).toBe(DOCKER_FIXTURE_SHARDS);
  expect(dockerFixtureShards(["--agent-tools-port", "31505"])).toEqual([
    DOCKER_FIXTURE_SHARDS.flat(),
  ]);
  const f = await fixture();
  await writeFile(path.join(f.root, "bash"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFakeBun(f.root);
  expect(
    await runIsolatedBrowser({
      ...f,
      docker: true,
      profileArgs: ["--agent-tools-port", "31505"],
    }),
  ).toBe(0);
  const events = await f.events();
  expect(events.filter((event) => event.task === "dev:test")).toHaveLength(1);
  expect(events.filter((event) => event.task === "playwright")).toHaveLength(1);
});

test("a launcher's budget covers every startup that runs before its tests", () => {
  const smokeAndQualification = 180_000 + 420_000;
  // Profiles start in turn, so the first launcher waits for all of them.
  expect(
    isolatedLauncherTimeoutMs({
      startupTimeoutMs: 900_000,
      sequentialStartups: 2,
      docker: true,
      testTimeoutMs: 1_500_000,
    }),
  ).toBe(2 * 900_000 + 1_500_000);
  expect(
    isolatedLauncherTimeoutMs({
      startupTimeoutMs: 300_000,
      sequentialStartups: 4,
      docker: true,
      testTimeoutMs: 1_500_000,
    }),
  ).toBe(4 * 300_000 + 1_500_000);
  // The smoke and qualification overlap the startups: a floor, not an addition.
  expect(
    isolatedLauncherTimeoutMs({
      startupTimeoutMs: 1_000,
      sequentialStartups: 3,
      docker: true,
      testTimeoutMs: 5_000,
    }),
  ).toBe(smokeAndQualification + 5_000);
  // Without Docker only the main profile and its companions start.
  expect(
    isolatedLauncherTimeoutMs({
      startupTimeoutMs: 120_000,
      sequentialStartups: 3,
      docker: false,
      testTimeoutMs: 1_500_000,
    }),
  ).toBe(3 * 120_000 + 1_500_000);
});

test("cancelling during the Docker image checks stops the checks and the starting profiles", async () => {
  const f = await fixture("startup-hang");
  // A smoke and a qualification that would both outlast the run unless stopped.
  await writeFile(path.join(f.root, "bash"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  await writeFile(path.join(f.root, "bun"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const controller = new AbortController();
  const started = performance.now();
  const run = runIsolatedBrowser({
    ...f,
    docker: true,
    profile: "qa-docker-cancel",
    signal: controller.signal,
  });
  // Cancel once the first profile is starting alongside the image checks.
  await waitForFile(path.join(f.root, "launcher"));
  controller.abort(new Error("owner cancelled"));
  await expect(run).rejects.toThrow("owner cancelled");
  expect(performance.now() - started).toBeLessThan(15_000);
  const events = await f.events();
  expect(events.map((event) => event.task)).not.toContain("playwright");
  const starts = events.filter((event) => event.task === "dev:test");
  expect(starts).toHaveLength(1);
  for (const start of starts) expect(alive(start.pid)).toBe(false);
  expect(cleanupByProfile(events)).toEqual({ "qa-docker-cancel": ["dev:stop", "dev:reset"] });
});

test("a change to this runner selects the Docker fixture validation", async () => {
  const config = JSON.parse(
    await readFile(path.join(repositoryRoot, ".orkestrator-test-scheduler.json"), "utf8"),
  ) as { commandProfiles: Record<string, { onDemand?: { when?: string[] } }> };
  const when = config.commandProfiles["mise run test:agent:docker:isolated"]?.onDemand?.when ?? [];
  expect(
    when.some((pattern) =>
      new Bun.Glob(pattern).match("apps/desktop/scripts/dev/isolated-browser.ts"),
    ),
  ).toBe(true);
});

test("Docker qualification refuses companion profiles", async () => {
  const f = await fixture();
  await expect(
    runIsolatedBrowser({ ...f, docker: true, companionProfiles: ["qa-other"] }),
  ).rejects.toThrow("not companion profiles");
});

test("every spec with a Docker fixture test is in exactly one shard of the browser config", async () => {
  const config = await readFile(
    path.join(repositoryRoot, "e2e/agent-testing/playwright.browser.config.ts"),
    "utf8",
  );
  const listed = new Set(
    [...config.matchAll(/"([\w.-]+\.spec\.ts)"/g)].map((match) => `e2e/agent-testing/${match[1]}`),
  );
  // The same selection `--grep "Docker fixture"` makes: a test or describe
  // title that contains it.
  const title = /\btest(?:\.describe)?\(\s*["'`][^"'`]*Docker fixture/;
  const docker: string[] = [];
  for (const file of listed) {
    const source = await readFile(path.join(repositoryRoot, file), "utf8").catch(() => "");
    if (title.test(source)) docker.push(file);
  }
  const assigned = DOCKER_FIXTURE_SHARDS.flat();
  expect(new Set(assigned).size).toBe(assigned.length);
  expect([...assigned].sort()).toEqual(docker.sort());
});

for (const mode of ["startup-hang", "launcher-dies"]) {
  test(`companion ${mode} stops the suite and resets both started profiles`, async () => {
    const f = await fixture(mode);
    f.env.ORK_ISOLATED_TEST_FAIL_PROFILE = "qa-companion-failure";
    await expect(
      runIsolatedBrowser({
        ...f,
        profile: "qa-main-ok",
        companionProfiles: ["qa-companion-failure"],
        startupTimeoutMs: 1500,
      }),
    ).rejects.toThrow(
      mode === "startup-hang" ? "startup timed out" : "exited during browser tests",
    );
    const events = await f.events();
    const browser = events.find((event) => event.task === "playwright");
    if (mode === "startup-hang") expect(browser).toBeUndefined();
    else expect(alive(browser!.pid)).toBe(false);
    for (const profile of ["qa-main-ok", "qa-companion-failure"]) {
      expect(
        events
          .filter(
            (event) => event.profile === profile && ["dev:stop", "dev:reset"].includes(event.task),
          )
          .map((event) => event.task),
      ).toEqual(["dev:stop", "dev:reset"]);
      expect(
        alive(events.find((event) => event.task === "dev:test" && event.profile === profile)!.pid),
      ).toBe(false);
    }
  });
}
