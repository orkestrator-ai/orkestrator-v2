/**
 * The live coordinator suite's `gap-tools` scenario
 * (`coordinator-live-gap-tools.ts`) on real `dev:test --fixture` profiles
 * with a scripted loopback model (to-do 1021 (retired) tasks 1 and 4). Run it with
 * `mise run test:agent:coordinator:gap-tools-fake`, which starts two
 * disposable credential-free profiles that offer only Pi (a command node and
 * its leaf), runs this file and resets both.
 *
 * Opt-in: skipped unless `ORKESTRATOR_AGENT_TEST_COORDINATOR_GAP_TOOLS_FAKE=1`.
 * Nothing is billed and nothing logs in: every model call either profile's Pi
 * bridge makes goes to `coordinator-gap-tools-fake-model.ts` on loopback,
 * which each profile's isolated Pi `models.json` names (never `~/.pi`). The
 * real backends, coordinator policy and context, Control MCP, Pi bridges and
 * SDK, change tracking, environment fork, turn stop, slash-command dispatch,
 * scheduled jobs, worker question relay, status wakes, agent mail and (in the
 * second case) the node link and its controller commands all run; only the
 * model is fake.
 *
 * - **This node** (task 1): a Pi coordinator on the command node calls every
 *   gap tool once against a worker it launched there.
 * - **A connected node** (task 4): the command node attaches the leaf over
 *   the leaf's real gateway (as `add_node` does for another machine), and its
 *   coordinator runs the same scenario with `nodeId` on every worker tool, so
 *   each goes through its node-link-only controller command on the leaf.
 *
 * What it cannot prove: the fake replays the harness's numbered steps, so
 * whether a real model reads the tool descriptions right needs the billed
 * run (`mise run test:agent:coordinator --credential-source <platform>
 * --scenario gap-tools`, on the manual-test checklist). Conflicts, PR wakes
 * and real worker questions need GitHub and a question-capable provider, so
 * here `resolve_conflicts` and `answer_worker_question` are checked to
 * refuse a worker that has neither. One host shares loopback, so a slow or
 * dropped node link is not exercised.
 *
 * Writes content-free summaries to
 * `output/agent-testing/<run>/coordinator-gap-tools-fake/{local,remote}.json`.
 */
import { expect, test, type Page } from "./browser-test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
} from "@orkestrator/protocol/coordinator";
import type { CoordinatorLivePlatformSummary } from "../../apps/desktop/scripts/dev/coordinator-live";
import {
  runCoordinatorCleanup,
  type DelegationCoordinator,
} from "../../apps/desktop/scripts/dev/coordinator-live-observer";
import { runGapToolsScenario } from "../../apps/desktop/scripts/dev/coordinator-live-gap-tools-orchestration";
import { GAP_TOOLS } from "../../apps/desktop/scripts/dev/coordinator-live-gap-tools";
import { editProfilePiFiles, withKeepRecentTokensForShortSessions } from "./pi-profile-settings";
import type { WakeFacts } from "./coordinator-gap-tools-fake-model-script";
import {
  authenticatedInvoke,
  profileStatus,
  repositoryRoot,
  type Invoke,
  type Status,
} from "./slash-command-live-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_GAP_TOOLS_FAKE === "1";
const deskProfile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-gap-tools-desk";
const leafProfile =
  process.env.ORKESTRATOR_AGENT_TEST_GAP_TOOLS_LEAF_PROFILE ?? "qa-gap-tools-leaf";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? deskProfile;

const PI_PROVIDER = "gap-tools-fake";
const PI_MODEL = "gap-tools-1";
const MODEL_REF = `${PI_PROVIDER}/${PI_MODEL}`;
/** The same repository on both profiles, which is how the command node finds the leaf's copy. */
const SHARED_GIT_URL = "https://github.com/orkestrator-qa/gap-tools.git";

type Calls = {
  completions: number;
  coordinator: number;
  worker: number;
  other: number;
  refused: number;
  parked: number;
  released: number;
  toolCalls: Record<string, number>;
  wakes: WakeFacts[];
};
type Profile = { name: string; status: Status & { authFile?: string }; invoke: Invoke };

test.use({ trace: "off" });

async function startFakeModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "coordinator-gap-tools-fake-model.ts")],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const origin = await new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once("line", resolve);
    child.once("exit", () => reject(new Error("the fake model exited before it listened")));
  });
  return { origin, child };
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function calls(origin: string): Promise<Calls> {
  return (await (await fetch(`${origin}/__calls`)).json()) as Calls;
}

/**
 * Names the fake provider in a profile's isolated Pi `models.json` and makes
 * it Pi's saved default there (never `~/.pi`); returns the restore. The key
 * is a literal placeholder. Written through `editProfilePiFiles`, which
 * refuses a Pi directory or file that leads out of the profile.
 */
function pointPiAt(status: Status, baseUrl: string): () => void {
  return editProfilePiFiles(status.dataDir!, {
    "models.json": (existing) => ({
      ...existing,
      providers: {
        ...(existing.providers as Record<string, unknown> | undefined),
        [PI_PROVIDER]: {
          name: "Coordinator gap tools fake",
          baseUrl,
          api: "openai-completions",
          apiKey: "gap-tools-fake-not-a-key",
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: true,
            maxTokensField: "max_tokens",
          },
          models: [
            {
              id: PI_MODEL,
              name: "Gap tools 1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              // Large, so the coordinator context never triggers auto-compaction.
              contextWindow: 1_000_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    }),
    // The fake worker's session is a few hundred tokens: keep almost nothing,
    // so run_worker_command's /compact really compacts (the summary request
    // reaches the fake with no tools). Auto-compaction still never fires in a
    // 1M-token window.
    "settings.json": (current) =>
      withKeepRecentTokensForShortSessions({
        ...current,
        defaultProvider: PI_PROVIDER,
        defaultModel: PI_MODEL,
      }),
  });
}

/**
 * Pi as the native agent on the fake model, and scheduling on (it is
 * experimental and off by default, and the schedule tools are offered only
 * while it is on); returns the restore.
 */
async function configure(invoke: Invoke): Promise<() => Promise<void>> {
  const config = await invoke<{ global: Record<string, unknown> }>("get_config");
  const previous = {
    coordinatorProviderTiers: config.global.coordinatorProviderTiers,
    experimentalScheduling: config.global.experimentalScheduling,
    agentSettings: config.global.agentSettings,
  };
  const agentSettings = (config.global.agentSettings ?? {}) as Record<string, unknown>;
  const platforms = (agentSettings.platforms ?? {}) as Record<string, unknown>;
  await invoke("update_global_config", {
    global: {
      ...config.global,
      coordinatorProviderTiers: "provider-configured",
      experimentalScheduling: true,
      agentSettings: {
        ...agentSettings,
        platforms: { ...platforms, pi: { mode: "native", model: MODEL_REF } },
      },
    },
  });
  return async () => {
    const current = await invoke<{ global: Record<string, unknown> }>("get_config");
    await invoke("update_global_config", { global: { ...current.global, ...previous } });
  };
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed in the QA checkout`);
}

/** A checkout of the shared repository, added as a project of this profile. */
async function sharedProject(profile: Profile): Promise<string> {
  const fixtureDir = path.dirname(profile.status.testProject!);
  const checkout = path.join(fixtureDir, "gap-tools-qa");
  if (!existsSync(path.join(checkout, ".git"))) {
    mkdirSync(checkout, { recursive: true });
    git(checkout, "init", "-q", "-b", "main");
    writeFileSync(path.join(checkout, "README.md"), "# Gap tools QA\n");
    git(checkout, "add", "README.md");
    git(
      checkout,
      "-c",
      "user.email=qa@example.com",
      "-c",
      "user.name=QA",
      "commit",
      "-q",
      "-m",
      "init",
    );
  }
  const projects =
    await profile.invoke<Array<{ id: string; localPath: string | null }>>("get_projects");
  const existing = projects.find((project) => project.localPath === checkout);
  if (existing) return existing.id;
  return (
    await profile.invoke<{ id: string }>("add_project", {
      gitUrl: SHARED_GIT_URL,
      localPath: checkout,
    })
  ).id;
}

/** A fresh Pi main coordinator conversation with its session started. */
async function piCoordinator(
  invoke: Invoke,
  projectId: string,
  cleanup: Array<() => Promise<unknown>>,
): Promise<{ coordinator: DelegationCoordinator; tier?: string }> {
  let snapshot = await invoke<CoordinatorSnapshot>("ensure_project_coordinator", { projectId });
  const earlier = coordinatorMainConversation(snapshot.workspace);
  if (earlier?.agent) {
    snapshot = await invoke<CoordinatorSnapshot>("close_coordinator_conversation", {
      projectId,
      conversationId: earlier.id,
    });
  }
  if (!coordinatorMainConversation(snapshot.workspace)) {
    snapshot = await invoke<CoordinatorSnapshot>("create_coordinator_conversation", { projectId });
  }
  const conversation = coordinatorMainConversation(snapshot.workspace)!;
  expect(snapshot.providerAvailability.pi?.available, "Pi is not offered to Coordinator").toBe(
    true,
  );
  expect(snapshot.controlMcp.running, "Control MCP is not running").toBe(true);
  snapshot = await invoke<CoordinatorSnapshot>("assign_coordinator_conversation_agent", {
    projectId,
    conversationId: conversation.id,
    agent: "pi",
  });
  cleanup.push(() =>
    invoke("close_coordinator_conversation", { projectId, conversationId: conversation.id }),
  );
  const identity = {
    environmentId: coordinatorRuntimeId(snapshot.workspace.id, conversation.id),
    agent: "pi" as const,
    logicalSessionKey: conversation.logicalSessionKey,
  };
  await invoke("ensure_native_agent_session", { ...identity, model: MODEL_REF });
  return {
    coordinator: {
      invoke,
      identity,
      conversation: { id: conversation.id, tabId: conversation.tabId },
      projectId,
    },
    tier: snapshot.providerAvailability.pi?.tier,
  };
}

async function until<T>(
  label: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (ok(value)) return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 300) : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? ` (last error: ${lastError})` : ""}`,
  );
}

async function signIn(page: Page, name: string): Promise<Profile> {
  const status = profileStatus(name) as Profile["status"];
  expect(status.status, `profile "${name}" is not running`).toBe("ready");
  expect(status.dataDir, "dev:status reported no data directory").toBeTruthy();
  expect(status.testProject, "the profile has no fixture").toBeTruthy();
  return { name, status, invoke: await authenticatedInvoke(page, status, name) };
}

function writeSummary(name: string, summary: CoordinatorLivePlatformSummary, fake?: Calls): void {
  const directory = path.join(
    repositoryRoot,
    "output",
    "agent-testing",
    runId,
    "coordinator-gap-tools-fake",
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `${name}.json`),
    `${JSON.stringify({ ...summary, fakeModel: fake ?? null }, null, 2)}\n`,
  );
}

const fakeToolCount = (fake: Calls, tool: string) =>
  Object.entries(fake.toolCalls)
    .filter(([name]) => name === tool || name.endsWith(`_${tool}`))
    .reduce((sum, [, count]) => sum + count, 0);

/** What the fake saw, beside what the backend recorded. */
function expectFakeAgrees(fake: Calls): void {
  expect(fake.refused).toBe(0);
  // Each gap tool reached the model's tool loop once.
  expect(Object.fromEntries(GAP_TOOLS.map((tool) => [tool, fakeToolCount(fake, tool)]))).toEqual(
    Object.fromEntries(GAP_TOOLS.map((tool) => [tool, 1])),
  );
  // The worker's long turn was parked and released by the stop.
  expect({ parked: fake.parked, released: fake.released }).toEqual({ parked: 1, released: 1 });
  // run_worker_command's /compact asked the model for a summary, offered no tools.
  expect(fake.other, "no compaction summary reached the model").toBeGreaterThanOrEqual(1);
  // One wake said the coordinator stopped the turn itself.
  expect(fake.wakes.filter((wake) => wake.stoppedByCoordinator)).toHaveLength(1);
}

function newSummary(): CoordinatorLivePlatformSummary {
  return {
    version: 1,
    platform: "pi",
    scenario: "gap-tools",
    verdict: "failed",
    tierSetting: "provider-configured",
    startedAt: new Date().toISOString(),
  };
}

function record(
  summary: CoordinatorLivePlatformSummary,
  result: Awaited<ReturnType<typeof runGapToolsScenario>>,
): string[] {
  summary.checks = result.checks;
  summary.toolCalls = result.calls.map(({ name, state }) => ({ name, state }));
  summary.observed = {
    workers: result.watch.workers.length,
    observations: result.watch.observations.length,
  };
  const failures = result.checks.filter((item) => !item.passed).map((item) => item.name);
  summary.verdict = failures.length === 0 ? "passed" : "failed";
  return failures;
}

test.describe("coordinator gap tools on a fake model", () => {
  test.skip(
    !LIVE,
    "opt-in: set ORKESTRATOR_AGENT_TEST_COORDINATOR_GAP_TOOLS_FAKE=1 (fake model, no billing)",
  );
  test.setTimeout(25 * 60_000);

  test("on this node: each gap tool once against a worker the coordinator launched", async ({
    page,
  }) => {
    page.setDefaultTimeout(30_000);
    const desk = await signIn(page, deskProfile);
    const fixture = (
      await desk.invoke<Array<{ id: string; localPath: string | null }>>("get_projects")
    ).find((project) => project.localPath === desk.status.testProject);
    expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
    const summary = newSummary();
    const started = Date.now();
    const model = await startFakeModel();
    const cleanup: Array<() => Promise<unknown>> = [];
    let fake: Calls | undefined;
    try {
      // Named before any Pi bridge starts, so the first one reads it.
      const restore = pointPiAt(desk.status, `${model.origin}/desk/v1`);
      cleanup.push(async () => restore());
      cleanup.push(await configure(desk.invoke));
      const { coordinator, tier } = await piCoordinator(desk.invoke, fixture!.id, cleanup);
      summary.tier = tier;
      const result = await runGapToolsScenario({ coordinator, summary, cleanup });
      fake = await calls(model.origin);
      const failures = record(summary, result);
      expect(failures, "gap-tools on this node, fake model").toEqual([]);
      expectFakeAgrees(fake);
    } catch (error) {
      summary.verdict = "failed";
      summary.reason ??= error instanceof Error ? error.message.slice(0, 2_000) : String(error);
      throw error;
    } finally {
      await runCoordinatorCleanup(cleanup, summary);
      fake ??= await calls(model.origin).catch(() => undefined);
      summary.durationMs = Date.now() - started;
      writeSummary("local", summary, fake);
      await stopChild(model.child);
    }
  });

  test("on a connected node: each gap tool once with nodeId, through the leaf's controller commands", async ({
    page,
    browser,
  }) => {
    page.setDefaultTimeout(30_000);
    const desk = await signIn(page, deskProfile);
    // A second browser context: both gateways are on 127.0.0.1, whose
    // cookies do not tell ports apart.
    const leafContext = await browser.newContext();
    const leaf = await signIn(await leafContext.newPage(), leafProfile);
    const summary = newSummary();
    const started = Date.now();
    const model = await startFakeModel();
    const cleanup: Array<() => Promise<unknown>> = [];
    let fake: Calls | undefined;
    try {
      const restoreDesk = pointPiAt(desk.status, `${model.origin}/desk/v1`);
      const restoreLeaf = pointPiAt(leaf.status, `${model.origin}/leaf/v1`);
      cleanup.push(
        async () => restoreDesk(),
        async () => restoreLeaf(),
      );
      cleanup.push(await configure(desk.invoke), await configure(leaf.invoke));
      const deskProjectId = await sharedProject(desk);
      const leafProjectId = await sharedProject(leaf);

      // The desk attaches the leaf over the leaf's real gateway. The token is
      // read in memory and handed to the product, never printed.
      const leafToken = (
        JSON.parse(readFileSync(leaf.status.authFile!, "utf8")) as { token?: unknown }
      ).token;
      expect(typeof leafToken, "the leaf's auth file has no token").toBe("string");
      const attached = await desk.invoke<{ nodeId: string }>("add_node", {
        routes: [
          {
            id: "loopback",
            kind: "https",
            enabled: true,
            origin: new URL(leaf.status.browserUrl!).origin,
          },
        ],
        token: leafToken,
        displayName: "Leaf profile",
      });
      const nodeId = attached.nodeId;
      cleanup.push(() => desk.invoke("forget_node", { nodeId }));
      await until(
        "the leaf to be connected and in leaf mode",
        async () => ({
          nodes: await desk.invoke<{
            nodes: Array<{ nodeId: string; connection: { state: string } }>;
          }>("list_nodes"),
          leafStatus: await leaf.invoke<{ mode: string }>("get_node_status"),
        }),
        ({ nodes, leafStatus }) =>
          leafStatus.mode === "leaf" &&
          nodes.nodes.some(
            (node) => node.nodeId === nodeId && node.connection.state === "connected",
          ),
      );

      const { coordinator, tier } = await piCoordinator(desk.invoke, deskProjectId, cleanup);
      summary.tier = tier;
      const result = await runGapToolsScenario({
        coordinator,
        summary,
        cleanup,
        nodeId,
        workerInvoke: leaf.invoke,
        workerProjectId: leafProjectId,
      });
      fake = await calls(model.origin);
      const failures = record(summary, result);
      expect(failures, "gap-tools on a connected node, fake model").toEqual([]);
      expectFakeAgrees(fake);
    } catch (error) {
      summary.verdict = "failed";
      summary.reason ??= error instanceof Error ? error.message.slice(0, 2_000) : String(error);
      throw error;
    } finally {
      await runCoordinatorCleanup(cleanup, summary);
      fake ??= await calls(model.origin).catch(() => undefined);
      summary.durationMs = Date.now() - started;
      writeSummary("remote", summary, fake);
      await stopChild(model.child);
      await leafContext.close();
    }
  });
});
