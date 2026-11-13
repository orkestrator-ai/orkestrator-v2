/**
 * The live coordinator suite's `graph-profiles` scenario (to-do 0031 task 10)
 * run credential-free: the real Claude CLI and bridge behind a `dev:test`
 * profile, answered by the loopback Anthropic model (`fake-anthropic-model.ts`),
 * which plays each probe's tool calls (`graphProfilesClaudeScript`). Nothing is
 * billed and nothing leaves the profile: the fixture's `origin` is the
 * profile's own bare repository.
 *
 * The scripted model always attempts every step, so this run proves the
 * harness and the product's half (tiers shown, tiers applied, Claude's
 * refusals and the guards) on Claude. It is not evidence about any model;
 * the same scenario runs on real providers from `coordinator-live.spec.ts`
 * (`--scenario graph-profiles`), whose runs are in the manual-test checklist.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_GRAPH_PROFILES_FAKE=1`), against a
 * credential-free profile started with the host reachability check off:
 *
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile graphs0031 \
 *     --fixture --no-agent-credentials --no-host-seed --agent-platforms claude --headless
 *   ORKESTRATOR_AGENT_TEST_PROFILE=graphs0031 ORKESTRATOR_AGENT_TEST_GRAPH_PROFILES_FAKE=1 \
 *     mise run test:logged -- --name graph-profiles -- \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
 *     graph-profiles-fake.spec.ts --workers=1
 *
 * The fake endpoint is written into the profile's isolated Claude
 * `settings.json` before the first environment is created and the previous
 * file is put back afterwards. Checks, tiers and counts go to
 * `output/agent-testing/<run>/coordinator/claude-graph-profiles.json`, the
 * live suite's summary shape; no prompt or tool output reaches output.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";
import { expect, fetchModulesOutsideChromium, test, type Page } from "./browser-test";
import {
  fakeModelClaudeSettings,
  startFakeAnthropicModel,
  type FakeAnthropicModel,
  type FakeToolStep,
} from "./fake-anthropic-model";
import { enableExperimentalGraphs } from "./experimental-graphs";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import {
  coordinatorLiveSummaryFile,
  type CoordinatorLivePlatformSummary,
} from "../../apps/desktop/scripts/dev/coordinator-live";
import {
  graphProfileProbesFor,
  graphProfilesClaudeScript,
  graphProfilesScriptId,
} from "../../apps/desktop/scripts/dev/coordinator-live-graph-profiles";
import {
  gitGraphProfilesWorkspace,
  runGraphProfilesProbe,
} from "../../apps/desktop/scripts/dev/coordinator-live-graph-profiles-orchestration";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null; status?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "graphs0031";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const ENABLED = process.env.ORKESTRATOR_AGENT_TEST_GRAPH_PROFILES_FAKE === "1";
const PROBE_TIMEOUT_MS = 5 * 60_000;

test.skip(!ENABLED, "Opt-in: ORKESTRATOR_AGENT_TEST_GRAPH_PROFILES_FAKE=1");

function runtime() {
  return resolveRuntimeProfile({ repositoryRoot, requestedId: profile, flavor: "agent-test" });
}

function readyStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const status = JSON.parse(command.stdout || "{}") as Status;
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  return status;
}

async function signIn(page: Page, gatewayUrl: string): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const url = new URL(login.loginUrl);
  const signedIn = await page.goto(new URL(`${url.pathname}${url.search}`, gatewayUrl).href, {
    waitUntil: "domcontentloaded",
  });
  expect(signedIn?.ok() ?? false, "sign-in").toBe(true);
  return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(new URL("/__orkestrator/invoke", gatewayUrl).href, {
      data: { command: name, args },
      timeout: 0,
    });
    const text = await response.text();
    if (!response.ok()) throw new Error(`${name}: HTTP ${response.status()} ${text.slice(0, 500)}`);
    return (JSON.parse(text) as { result: T }).result;
  };
}

let model: FakeAnthropicModel | undefined;
let settingsPath: string | undefined;
let priorSettings: string | null = null;
let invoke: Invoke | undefined;
let browserContext: BrowserContext | undefined;
const environments: Environment[] = [];

test.afterAll(async () => {
  for (const environment of environments) {
    await invoke?.("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke?.("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
  await browserContext?.close().catch(() => undefined);
  if (settingsPath) {
    if (priorSettings === null) await fs.rm(settingsPath, { force: true });
    else await fs.writeFile(settingsPath, priorSettings);
  }
  await model?.stop();
});

test("graph-profiles on Claude with a scripted model: the tier shown is the tier applied, and nothing a probe may not do lands unnoticed", async ({
  browser,
}) => {
  test.setTimeout(30 * 60_000);
  const status = readyStatus();
  const scripts: Record<string, FakeToolStep[]> = {};
  model = await startFakeAnthropicModel(0, { toolScripts: scripts });
  const claudeDir = path.join(runtime().dataDir, "agent-credentials", "claude");
  // The profile's own isolated Claude home, never a real one.
  expect(claudeDir.startsWith(runtime().profileRoot)).toBe(true);
  await fs.mkdir(claudeDir, { recursive: true });
  settingsPath = path.join(claudeDir, "settings.json");
  priorSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  await fs.writeFile(settingsPath, JSON.stringify(fakeModelClaudeSettings(model.origin)));

  // A context of its own routes its modules itself, like the fixture's default one.
  const context = await browser.newContext();
  browserContext = context;
  await fetchModulesOutsideChromium(context);
  const page = await context.newPage();
  invoke = await signIn(page, status.browserUrl!);
  await enableExperimentalGraphs(invoke);
  const testProject = status.testProject ?? path.join(runtime().fixtureDir, "test-project");
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === testProject,
  );
  expect(fixture, "the profile has no seeded fixture project").toBeTruthy();

  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform: "claude",
    scenario: "graph-profiles",
    verdict: "failed",
    startedAt: new Date().toISOString(),
    checks: [],
    observed: {},
  };
  const started = Date.now();
  try {
    for (const probe of graphProfileProbesFor("claude")) {
      const nonce = randomBytes(4).toString("hex");
      const created = await invoke<Environment>("create_environment", {
        projectId: fixture!.id,
        name: `graph-profiles-${probe}-${nonce}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      environments.push(created);
      await invoke("start_environment", { environmentId: created.id });
      await expect
        .poll(
          async () =>
            (await invoke!<Environment>("get_environment", { environmentId: created.id })).status,
          { timeout: 120_000 },
        )
        .toBe("running");
      const environment = await invoke<Environment>("get_environment", {
        environmentId: created.id,
      });
      const worktree = environment.worktreePath!;
      expect(worktree, "the environment has no worktree").toBeTruthy();
      const readme = path.join(worktree, "README.md");
      const readmeFirstLine = existsSync(readme)
        ? (readFileSync(readme, "utf8").split("\n")[0] ?? "")
        : "";
      scripts[graphProfilesScriptId(probe, nonce)] = graphProfilesClaudeScript(probe, {
        worktree,
        nonce,
        readmeFirstLine,
      });
      const scriptId = graphProfilesScriptId(probe, nonce);
      const result = await runGraphProfilesProbe({
        invoke,
        projectId: fixture!.id,
        environmentId: created.id,
        workspace: gitGraphProfilesWorkspace(worktree),
        platform: "claude",
        probe,
        nonce,
        scripted: true,
        offeredTools: () =>
          model!.calls().find((call) => call.script?.id === scriptId)?.tools ?? undefined,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      summary.tier = result.evidence.shown?.tier;
      summary.checks!.push(
        ...result.checks.map((check) => ({ ...check, name: `${probe}: ${check.name}` })),
      );
      summary.observed![`${probe}ToolCalls`] = result.evidence.attempts?.toolCalls ?? -1;
      summary.observed![`${probe}ModelCalls`] = model
        .calls()
        .filter((call) => call.script?.id === scriptId).length;
      test.info().annotations.push({
        type: `graph-profiles ${probe}`,
        description: JSON.stringify({
          shown: result.evidence.shown?.tier,
          applied: result.evidence.activation?.enforcement,
          error: result.evidence.activation?.error,
          run: result.evidence.runStatus,
          activation: result.evidence.activation?.state,
          guards: result.evidence.activation?.guards?.map((g) => `${g.guard}:${g.outcome}`),
          failed: result.checks.filter((check) => !check.passed).map((check) => check.name),
        }),
      });
    }
    const failed = summary.checks!.filter((check) => !check.passed);
    summary.verdict = failed.length === 0 ? "passed" : "failed";
    if (failed.length > 0) {
      summary.reason = failed.map((check) => `${check.name} (${check.detail ?? ""})`).join("; ");
    }
    expect(failed, "graph-profiles checks").toEqual([]);
  } catch (error) {
    summary.verdict = "failed";
    summary.reason ??= error instanceof Error ? error.message.slice(0, 2_000) : String(error);
    throw error;
  } finally {
    summary.durationMs = Date.now() - started;
    const file = coordinatorLiveSummaryFile(repositoryRoot, runId, "claude", "graph-profiles");
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  }
});
