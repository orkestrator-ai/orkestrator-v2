/**
 * A coordinator restarting a build pipeline step that stopped on a usage
 * limit, on this node and on a connected node, between two real `dev:test`
 * profiles on one host with a scripted loopback model (to-do 4680 (retired) task 2).
 * Run it with `mise run test:agent:coordinator:restart-fake`, which starts two
 * disposable credential-free profiles that offer only Pi, runs this file and
 * resets both.
 *
 * Opt-in: skipped unless `ORKESTRATOR_AGENT_TEST_COORDINATOR_RESTART_FAKE=1`.
 * `ORKESTRATOR_AGENT_TEST_PROFILE` is the command node ("desk") and
 * `ORKESTRATOR_AGENT_TEST_RESTART_LEAF_PROFILE` the leaf. Nothing is billed
 * and nothing logs in: every model call either profile's Pi bridge makes goes
 * to `coordinator-restart-fake-model.ts` on loopback, which each profile's
 * isolated Pi `models.json` names (never `~/.pi`). The real backends, node
 * link, coordinator context and policy, Control MCP, Pi bridges and SDK, build
 * pipelines, usage-limit classification, status wakes, coordinator receipts
 * and agent mail all run; only the model is fake.
 *
 * Each build's worker turn gets HTTP 429 with a plan-limit message, so the
 * step stops the way the 2026-11-04 incident's did: a failed turn whose error
 * Orkestrator reads as a usage limit, with nothing to switch to. Then, for a
 * build on the desk and for one the desk's coordinator started on the leaf:
 *
 * - The coordinator is woken with the build `failed`, the usage limit in the
 *   notice and `restart_build_pipeline_step` offered (naming the leaf's
 *   `nodeId` for the leaf's build).
 * - It restarts the failed step (omitted `stepId`). The pipeline records one
 *   coordinator restart and supersedes the failed session.
 * - The restarted step stops on the limit again, and the reopened follow wakes
 *   the coordinator a second time: the next status wake arrives.
 * - It retries the restart under the same `requestId`, as a model retrying
 *   after a lost answer would. Nothing restarts twice: still one recorded
 *   restart, no new session, and no third wake.
 *
 * What it cannot prove: the limit is a fake provider's refusal, so the error
 * text is the script's rather than a real provider's, and the fake decides to
 * restart, so whether a real model restarts on the notice needs billed turns.
 * One host shares a kernel and loopback.
 *
 * Writes a content-free summary to
 * `output/agent-testing/<run>/coordinator-restart-fake/summary.json`.
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
import { snapshotFixtureFiles } from "./codex-fixture-files";
import {
  BUILD_MARKER,
  type RestartFacts,
  type WakeFacts,
} from "./coordinator-restart-fake-model-script";
import {
  authenticatedInvoke,
  profileStatus,
  repositoryRoot,
  type Invoke,
  type Status,
} from "./slash-command-live-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_RESTART_FAKE === "1";
const deskProfile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-restart-desk";
const leafProfile = process.env.ORKESTRATOR_AGENT_TEST_RESTART_LEAF_PROFILE ?? "qa-restart-leaf";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? deskProfile;

const PI_PROVIDER = "restart-fake";
const PI_MODEL = "restart-1";
const MODEL_REF = `${PI_PROVIDER}/${PI_MODEL}`;
/** The same repository on both profiles, which is how the desk finds the leaf's copy. */
const SHARED_GIT_URL = "https://github.com/orkestrator-qa/restart.git";

type NodeCalls = {
  completions: number;
  usageLimited: number;
  toolCalls: Record<string, number>;
  wakes: WakeFacts[];
  restarts: RestartFacts[];
};
type Calls = { refused: number; desk: NodeCalls; leaf: NodeCalls };
type Coordinator = {
  invoke: Invoke;
  projectId: string;
  conversationId: string;
  environmentId: string;
  tabId: string;
  logicalSessionKey: string;
};
type Profile = { name: string; status: Status & { authFile?: string }; invoke: Invoke };
type PipelineSession = { phase?: string; supersededBy?: string; status?: string };
type Pipeline = {
  phase?: string;
  error?: string;
  sessions?: PipelineSession[];
  coordinatorRestarts?: unknown[];
  rewinds?: unknown[];
};

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

async function startFakeModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "coordinator-restart-fake-model.ts")],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
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
 * Names the fake provider in a profile's isolated Pi `models.json` and makes it
 * Pi's saved default there (never `~/.pi`); returns the restore. The key is a
 * literal placeholder.
 */
function pointPiAt(status: Status, baseUrl: string): () => void {
  const root = path.resolve(status.dataDir!);
  const directory = path.join(root, "agent-credentials", "home", ".pi", "agent");
  const models = path.join(directory, "models.json");
  const settings = path.join(directory, "settings.json");
  for (const file of [models, settings]) {
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Pi settings escape the profile");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const restore = snapshotFixtureFiles([models, settings]);
  const read = (file: string) =>
    existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  const existing = read(models) as { providers?: Record<string, unknown> };
  writeFileSync(
    models,
    `${JSON.stringify(
      {
        ...existing,
        providers: {
          ...existing.providers,
          [PI_PROVIDER]: {
            name: "Coordinator restart fake",
            baseUrl,
            api: "openai-completions",
            apiKey: "restart-fake-not-a-key",
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
                name: "Restart 1",
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
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    settings,
    `${JSON.stringify({ ...read(settings), defaultProvider: PI_PROVIDER, defaultModel: PI_MODEL }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return restore;
}

/** Pi as the coordinator's agent on the fake model; returns the restore. */
async function configure(invoke: Invoke): Promise<() => Promise<void>> {
  const config = await invoke<{ global: Record<string, unknown> }>("get_config");
  const previous = {
    coordinatorProviderTiers: config.global.coordinatorProviderTiers,
    agentSettings: config.global.agentSettings,
  };
  const agentSettings = (config.global.agentSettings ?? {}) as Record<string, unknown>;
  const platforms = (agentSettings.platforms ?? {}) as Record<string, unknown>;
  await invoke("update_global_config", {
    global: {
      ...config.global,
      coordinatorProviderTiers: "provider-configured",
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
  const checkout = path.join(fixtureDir, "restart-qa");
  if (!existsSync(path.join(checkout, ".git"))) {
    mkdirSync(checkout, { recursive: true });
    git(checkout, "init", "-q", "-b", "main");
    writeFileSync(path.join(checkout, "README.md"), "# Restart QA\n");
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
  const created = await profile.invoke<{ id: string }>("add_project", {
    gitUrl: SHARED_GIT_URL,
    localPath: checkout,
  });
  return created.id;
}

/** A fresh Pi main coordinator conversation with its session started. */
async function piCoordinator(invoke: Invoke, projectId: string): Promise<Coordinator> {
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
  const environmentId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
  await invoke("ensure_native_agent_session", {
    environmentId,
    agent: "pi",
    logicalSessionKey: conversation.logicalSessionKey,
    model: MODEL_REF,
  });
  return {
    invoke,
    projectId,
    conversationId: conversation.id,
    environmentId,
    tabId: conversation.tabId,
    logicalSessionKey: conversation.logicalSessionKey,
  };
}

async function prompt(coordinator: Coordinator, text: string, label: string) {
  await coordinator.invoke("dispatch_native_agent_intent", {
    environmentId: coordinator.environmentId,
    agent: "pi",
    logicalSessionKey: coordinator.logicalSessionKey,
    prompt: text,
    requestId: `restart-qa-${label}-${Date.now()}`,
    mode: "build",
  });
}

async function until<T>(
  label: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 300_000,
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

/** Waits until neither profile's Pi has called the model for 30 s; returns the counts. */
async function settle(origin: string): Promise<Calls> {
  let settled = await calls(origin);
  for (let quiet = 0; quiet < 6;) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const next = await calls(origin);
    quiet =
      next.desk.completions === settled.desk.completions &&
      next.leaf.completions === settled.leaf.completions
        ? quiet + 1
        : 0;
    settled = next;
  }
  return settled;
}

/** The build pipeline this conversation started, once its association is settled. */
async function startedPipeline(coordinator: Coordinator): Promise<{ id: string; nodeId?: string }> {
  const found = await until(
    "the coordinator's build pipeline association",
    async () =>
      (
        await coordinator.invoke<CoordinatorSnapshot>("get_project_coordinator", {
          projectId: coordinator.projectId,
        })
      ).workflows.find(
        (workflow) =>
          workflow.kind === "build-pipeline" &&
          workflow.conversationId === coordinator.conversationId &&
          workflow.pending !== true &&
          !workflow.resourceId.startsWith("pending:"),
      ),
    (workflow) => workflow !== undefined,
  );
  return { id: found!.resourceId, ...(found!.nodeId ? { nodeId: found!.nodeId } : {}) };
}

async function readPipeline(invoke: Invoke, pipelineId: string): Promise<Pipeline | undefined> {
  const value = (await invoke<unknown>("get_build_pipeline", { pipelineId })) as {
    record?: { snapshot?: unknown };
    snapshot?: unknown;
  } | null;
  const snapshot = value?.record?.snapshot ?? value?.snapshot;
  return snapshot && typeof snapshot === "object" ? (snapshot as Pipeline) : undefined;
}

/** The content-free shape of a pipeline the spec judges. */
function pipelineFacts(pipeline: Pipeline | undefined) {
  const sessions = pipeline?.sessions ?? [];
  return {
    phase: pipeline?.phase,
    errorIsUsageLimit: /usage limit/i.test(pipeline?.error ?? ""),
    coordinatorRestarts: pipeline?.coordinatorRestarts?.length ?? 0,
    rewinds: pipeline?.rewinds?.length ?? 0,
    buildSessions: sessions.filter((session) => session.phase === "build").length,
    supersededSessions: sessions.filter((session) => session.supersededBy !== undefined).length,
  };
}

const failedWakesFor = (counts: NodeCalls, pipelineId: string) =>
  counts.wakes.filter((wake) => wake.failedPipelines.includes(pipelineId));
const restartsFor = (counts: NodeCalls, pipelineId: string) =>
  counts.restarts.filter((restart) => restart.pipelineId === pipelineId);

/**
 * One build through fail, restart, fail again and a same-key retry; returns
 * the facts it judged. `pipelineInvoke` reads the node that runs the build.
 */
async function restartCase(input: {
  label: string;
  coordinator: Coordinator;
  origin: string;
  nodeId?: string;
  pipelineInvoke: Invoke;
}) {
  const before = await calls(input.origin);
  await prompt(
    input.coordinator,
    `Please add ${BUILD_MARKER}(index, length) to src with tests and build it.${
      input.nodeId ? ` Run the build on the connected node, nodeId: ${input.nodeId}` : ""
    }`,
    input.label,
  );
  const pipeline = await startedPipeline(input.coordinator);
  expect(pipeline.nodeId).toBe(input.nodeId);
  // Restarted, failed again, retried under the same key.
  await until(
    `the ${input.label} restart and its same-key retry`,
    () => calls(input.origin),
    (counts) => restartsFor(counts.desk, pipeline.id).length >= 2,
    600_000,
  );
  const settled = await settle(input.origin);
  const after = await readPipeline(input.pipelineInvoke, pipeline.id);
  const workerNode = input.nodeId ? "leaf" : "desk";
  const otherNode = input.nodeId ? "desk" : "leaf";
  return {
    pipelineOnNode: pipeline.nodeId !== undefined,
    wakes: failedWakesFor(settled.desk, pipeline.id),
    restarts: restartsFor(settled.desk, pipeline.id),
    pipeline: pipelineFacts(after),
    workerUsageLimits: settled[workerNode].usageLimited - before[workerNode].usageLimited,
    otherNodeUsageLimits: settled[otherNode].usageLimited - before[otherNode].usageLimited,
    otherWakes: settled.desk.wakes.length - before.desk.wakes.length,
  };
}

function expectRestartedOnce(facts: Awaited<ReturnType<typeof restartCase>>, onNode: boolean) {
  // Woken twice: the first failure, then the reopened follow after the restart.
  expect(facts.wakes).toEqual([
    {
      failedPipelines: [expect.any(String)],
      usageLimit: true,
      offersRestart: true,
      restartNamesNode: onNode,
      restartedBefore: false,
    },
    expect.objectContaining({ restartedBefore: true, usageLimit: true, offersRestart: true }),
  ]);
  // The restart, then its same-key retry; both answered.
  expect(facts.restarts).toEqual([
    expect.objectContaining({ replay: false, restarted: true, error: false }),
    expect.objectContaining({ replay: true, replayed: true, error: false }),
  ]);
  // One restart recorded, one failed session superseded, failed again on the limit.
  expect(facts.pipeline).toMatchObject({
    phase: "failed",
    errorIsUsageLimit: true,
    coordinatorRestarts: 1,
    supersededSessions: 1,
    buildSessions: 2,
  });
  expect(facts.workerUsageLimits).toBeGreaterThanOrEqual(2);
  expect(facts.otherNodeUsageLimits).toBe(0);
}

function writeSummary(summary: Record<string, unknown>): void {
  const directory = path.join(
    repositoryRoot,
    "output",
    "agent-testing",
    runId,
    "coordinator-restart-fake",
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

async function signIn(page: Page, name: string): Promise<Profile> {
  const status = profileStatus(name) as Profile["status"];
  expect(status.status, `profile "${name}" is not running`).toBe("ready");
  expect(status.dataDir, "dev:status reported no data directory").toBeTruthy();
  expect(status.testProject, "the profile has no fixture").toBeTruthy();
  return { name, status, invoke: await authenticatedInvoke(page, status, name) };
}

test.describe("coordinator pipeline step restart on a fake model", () => {
  test.skip(
    !LIVE,
    "opt-in: set ORKESTRATOR_AGENT_TEST_COORDINATOR_RESTART_FAKE=1 (fake model, no billing)",
  );
  test.setTimeout(40 * 60_000);

  test("a coordinator restarts a step a usage limit stopped, here and on a leaf, and is woken again", async ({
    page,
    browser,
  }) => {
    page.setDefaultTimeout(30_000);
    const summary: Record<string, unknown> = {
      version: 1,
      verdict: "failed",
      startedAt: new Date().toISOString(),
    };
    const started = Date.now();
    const desk = await signIn(page, deskProfile);
    // A second browser context: both gateways are on 127.0.0.1, whose
    // cookies do not tell ports apart.
    const leafContext = await browser.newContext();
    const leaf = await signIn(await leafContext.newPage(), leafProfile);
    const model = await startFakeModel();
    const cleanup: Array<() => Promise<unknown>> = [];
    let fake: Calls | undefined;
    try {
      // Named before any Pi bridge starts, so the first one reads it.
      const restoreDesk = pointPiAt(desk.status, `${model.origin}/desk/v1`);
      const restoreLeaf = pointPiAt(leaf.status, `${model.origin}/leaf/v1`);
      cleanup.push(
        async () => restoreDesk(),
        async () => restoreLeaf(),
      );
      cleanup.push(await configure(desk.invoke), await configure(leaf.invoke));

      // 1. Here: a build on the desk's own fixture project.
      const fixture = (
        await desk.invoke<Array<{ id: string; localPath: string | null }>>("get_projects")
      ).find((project) => project.localPath === desk.status.testProject);
      expect(fixture, "the desk has no seeded fixture project").toBeTruthy();
      const here = await piCoordinator(desk.invoke, fixture!.id);
      cleanup.push(() =>
        desk.invoke("close_coordinator_conversation", {
          projectId: here.projectId,
          conversationId: here.conversationId,
        }),
      );
      const hereFacts = await restartCase({
        label: "here",
        coordinator: here,
        origin: model.origin,
        pipelineInvoke: desk.invoke,
      });
      summary.here = hereFacts;
      expectRestartedOnce(hereFacts, false);

      // 2. On a connected node: the desk attaches the leaf over the leaf's
      // real gateway. The token is read in memory and handed to the product,
      // never printed.
      const deskProjectId = await sharedProject(desk);
      await sharedProject(leaf);
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
        90_000,
      );
      summary.attached = true;
      const remote = await piCoordinator(desk.invoke, deskProjectId);
      cleanup.push(() =>
        desk.invoke("close_coordinator_conversation", {
          projectId: remote.projectId,
          conversationId: remote.conversationId,
        }),
      );
      const nodeFacts = await restartCase({
        label: "node",
        coordinator: remote,
        origin: model.origin,
        nodeId,
        pipelineInvoke: leaf.invoke,
      });
      summary.node = nodeFacts;
      expectRestartedOnce(nodeFacts, true);

      fake = await calls(model.origin);
      expect(fake.refused).toBe(0);
      summary.verdict = "passed";
    } catch (error) {
      summary.reason = error instanceof Error ? error.message.slice(0, 2_000) : String(error);
      throw error;
    } finally {
      const failures: string[] = [];
      for (const step of cleanup.reverse()) {
        await step().catch((error: unknown) =>
          failures.push(error instanceof Error ? error.message.slice(0, 300) : String(error)),
        );
      }
      if (failures.length > 0) summary.cleanupFailures = failures;
      fake ??= await calls(model.origin).catch(() => undefined);
      summary.fakeModel = fake ?? null;
      summary.durationMs = Date.now() - started;
      writeSummary(summary);
      await stopChild(model.child);
      await leafContext.close();
    }
  });
});
