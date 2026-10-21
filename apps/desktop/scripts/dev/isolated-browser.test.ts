import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { isolatedProfileArguments, runIsolatedBrowser } from "./isolated-browser.js";

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
const mode = process.env.ORK_ISOLATED_TEST_MODE;
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE;
const args = process.argv.slice(2);
const browser = path.basename(process.argv[1]) === "bunx";
const task = browser ? "playwright" : args[1];
fs.appendFileSync(path.join(root, "events"), JSON.stringify({ task, profile, args, pid: process.pid, scheduler: process.env.ORKESTRATOR_TEST_SCHEDULER_DIR, workers: process.env.ORKESTRATOR_TEST_HOST_WORKERS, multiReview: process.env.ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW, coordinator: process.env.ORKESTRATOR_AGENT_TEST_LIVE_COORDINATOR, revisionTokens: process.env.ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS, design: process.env.ORKESTRATOR_AGENT_TEST_LIVE_DESIGN }) + "\\n");
if (task === "dev:test") {
  if (mode === "startup-fail") process.exit(3);
  fs.writeFileSync(path.join(root, "launcher"), String(process.pid));
  if (mode !== "startup-hang") fs.writeFileSync(path.join(root, "ready"), profile);
  process.on("SIGTERM", () => { fs.rmSync(path.join(root, "ready"), { force: true }); process.exit(0); });
  setInterval(() => {
    if (mode === "launcher-dies" && fs.existsSync(path.join(root, "tests-started"))) process.exit(8);
  }, 20);
} else if (task === "dev:status") {
  const ready = fs.existsSync(path.join(root, "ready"));
  console.log(JSON.stringify({ profile, status: ready ? "ready" : "starting", live: { launcher: ready, vite: ready, electron: ready, backend: ready } }));
} else if (browser) {
  if (!fs.existsSync(path.join(root, "ready"))) process.exit(42);
  fs.writeFileSync(path.join(root, "tests-started"), String(process.pid));
  if (mode === "test-hang" || mode === "launcher-dies") setInterval(() => {}, 1000);
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
            coordinator?: string;
            multiReview?: string;
            design?: string;
            revisionTokens?: string;
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
  ).toEqual(["--fixture", "--credential-source", "claude", "--agent-platforms", "codex,claude"]);
  expect(() => isolatedProfileArguments(["--profile", "other"])).toThrow("Unsupported");
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
    "--no-agent-credentials",
    "--agent-platforms",
    "opencode",
  ]);
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
    "--credential-source",
    "claude",
    "--agent-platforms",
    "claude",
  ]);
  expect(events.slice(-2).map((event) => event.task)).toEqual(["dev:stop", "dev:reset"]);
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

test("isolated browser overrides an inherited live revision-token opt-in", async () => {
  const f = await fixture();
  f.env.ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS = "1";
  expect(await runIsolatedBrowser(f)).toBe(0);
  expect((await f.events()).find((event) => event.task === "playwright")?.revisionTokens).toBe("0");
});
