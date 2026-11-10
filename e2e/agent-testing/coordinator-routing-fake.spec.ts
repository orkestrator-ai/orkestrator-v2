/**
 * The routing scenario's `build` case on a real `dev:test --fixture` profile
 * with a scripted loopback model (to-do 7545 task 4). Run it with
 * `mise run test:agent:coordinator:routing-fake`, which starts a disposable
 * credential-free profile that offers only Pi, runs this file and resets the
 * profile.
 *
 * Opt-in: skipped unless `ORKESTRATOR_AGENT_TEST_COORDINATOR_ROUTING_FAKE=1`.
 * Nothing is billed and nothing logs in: every model call the profile's own Pi
 * bridge makes goes to `coordinator-routing-fake-model.ts` on loopback, which
 * the profile's isolated Pi `models.json` names (never `~/.pi`). The real
 * backend, coordinator policy and context, Control MCP, Pi bridge and SDK,
 * build pipeline, status wakes and agent mail all run.
 *
 * The case is the live suite's own (`runRoutingScenario` with `cases:
 * ["build"]`, judged by the same evaluators): the coordinator turns the
 * request into a ticket and a build, the harness cancels the build as the
 * user's Cancel does, and the coordinator's status wake must carry a
 * `cancelled` notice and make no restart, resume or new build
 * (`build-cancel-notice`, `build-cancel-respected`). The fake also counts what
 * that wake said, so the spec proves the notice reached the model's prompt
 * saying the cancel is the user's decision and offering no restart.
 *
 * What it cannot prove: the fake answers a wake with one line whatever it
 * says, so whether a real model obeys the notice needs the billed routing run
 * (`mise run test:agent:coordinator --credential-source <platform> --scenario
 * routing`).
 *
 * Writes a content-free summary to
 * `output/agent-testing/<run>/coordinator-routing-fake/pi-routing-build.json`.
 */
import { expect, test } from "./browser-test";
import { spawn, type ChildProcess } from "node:child_process";
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
import { runRoutingScenario } from "../../apps/desktop/scripts/dev/coordinator-live-routing-orchestration";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import type { WakeFacts } from "./coordinator-routing-fake-model-script";
import {
  authenticatedInvoke,
  profileStatus,
  repositoryRoot,
  type Project,
  type Status,
} from "./slash-command-live-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_ROUTING_FAKE === "1";
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-coordinator-routing-fake";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;

const PI_PROVIDER = "routing-fake";
const PI_MODEL = "routing-1";
const MODEL_REF = `${PI_PROVIDER}/${PI_MODEL}`;

type Calls = {
  completions: number;
  refused: number;
  parked: number;
  released: number;
  toolCalls: Record<string, number>;
  wakes: WakeFacts[];
};

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

/** The fake model, started on loopback; its own handle stops it. */
async function startFakeModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "coordinator-routing-fake-model.ts")],
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
 * Names the fake provider in the profile's isolated Pi `models.json` and makes
 * it Pi's saved default there (never `~/.pi`); returns the restore. The key is
 * a literal placeholder.
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
  const config = {
    ...existing,
    providers: {
      ...existing.providers,
      [PI_PROVIDER]: {
        name: "Coordinator routing fake",
        baseUrl,
        api: "openai-completions",
        apiKey: "routing-fake-not-a-key",
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
            name: "Routing 1",
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
  };
  writeFileSync(models, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    settings,
    `${JSON.stringify({ ...read(settings), defaultProvider: PI_PROVIDER, defaultModel: PI_MODEL }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return restore;
}

function writeSummary(summary: CoordinatorLivePlatformSummary, fake: Calls | undefined): void {
  const directory = path.join(
    repositoryRoot,
    "output",
    "agent-testing",
    runId,
    "coordinator-routing-fake",
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "pi-routing-build.json"),
    `${JSON.stringify({ ...summary, fakeModel: fake ?? null }, null, 2)}\n`,
  );
}

test.describe("coordinator routing on a fake model", () => {
  test.skip(
    !LIVE,
    "opt-in: set ORKESTRATOR_AGENT_TEST_COORDINATOR_ROUTING_FAKE=1 (fake model, no billing)",
  );
  test.setTimeout(20 * 60_000);

  test("a build the user cancelled wakes the coordinator as a cancel, and nothing restarts it", async ({
    page,
  }) => {
    page.setDefaultTimeout(30_000);
    const status = profileStatus(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    expect(status.dataDir, "dev:status reported no data directory").toBeTruthy();
    const invoke = await authenticatedInvoke(page, status, profile);
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === status.testProject,
    );
    expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
    const projectId = fixture!.id;

    const summary: CoordinatorLivePlatformSummary = {
      version: 1,
      platform: "pi",
      scenario: "routing",
      verdict: "failed",
      tierSetting: "provider-configured",
      startedAt: new Date().toISOString(),
    };
    const started = Date.now();
    const model = await startFakeModel();
    const cleanup: Array<() => Promise<unknown>> = [];
    let fake: Calls | undefined;
    try {
      // The fake is named before any Pi bridge starts, so the first one reads it.
      const restore = pointPiAt(status, `${model.origin}/v1`);
      cleanup.push(async () => restore());

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
      cleanup.push(async () => {
        const current = await invoke<{ global: Record<string, unknown> }>("get_config");
        await invoke("update_global_config", { global: { ...current.global, ...previous } });
      });

      // A fresh main conversation on Pi, as the live suite's cases start one.
      let snapshot = await invoke<CoordinatorSnapshot>("ensure_project_coordinator", {
        projectId,
      });
      const earlier = coordinatorMainConversation(snapshot.workspace);
      if (earlier?.agent) {
        snapshot = await invoke<CoordinatorSnapshot>("close_coordinator_conversation", {
          projectId,
          conversationId: earlier.id,
        });
      }
      if (!coordinatorMainConversation(snapshot.workspace)) {
        snapshot = await invoke<CoordinatorSnapshot>("create_coordinator_conversation", {
          projectId,
        });
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
      summary.tier = snapshot.providerAvailability.pi?.tier;
      cleanup.push(() =>
        invoke("close_coordinator_conversation", { projectId, conversationId: conversation.id }),
      );
      const identity = {
        environmentId: coordinatorRuntimeId(snapshot.workspace.id, conversation.id),
        agent: "pi" as const,
        logicalSessionKey: conversation.logicalSessionKey,
      };
      await invoke("ensure_native_agent_session", { ...identity, model: MODEL_REF });
      const coordinator: DelegationCoordinator = {
        invoke,
        identity,
        conversation: { id: conversation.id, tabId: conversation.tabId },
        projectId,
      };

      const { checks, observed } = await runRoutingScenario({
        coordinator,
        summary,
        cleanup,
        cases: ["build"],
      });
      fake = await calls(model.origin);
      summary.checks = checks;
      summary.observed = observed;
      const failures = checks.filter((item) => !item.passed).map((item) => item.name);
      summary.verdict = failures.length === 0 ? "passed" : "failed";
      expect(failures, "routing build case on a fake model").toEqual([]);
      expect(checks.map((item) => item.name)).toEqual(
        expect.arrayContaining(["build-cancel-notice", "build-cancel-respected"]),
      );

      // The wake reached the model saying it was the user's cancel, and
      // offered nothing that would restart it.
      expect(fake.wakes).toEqual([
        { cancelled: true, userDecision: true, noRebuild: true, offersRestart: false },
      ]);
      expect(
        Object.entries(fake.toolCalls)
          .filter(([name]) => name.endsWith("start_build_pipeline"))
          .map(([, count]) => count),
      ).toEqual([1]);
      expect(fake.refused).toBe(0);
    } catch (error) {
      summary.reason ??= error instanceof Error ? error.message.slice(0, 2_000) : String(error);
      throw error;
    } finally {
      await runCoordinatorCleanup(cleanup, summary);
      fake ??= await calls(model.origin).catch(() => undefined);
      summary.durationMs = Date.now() - started;
      writeSummary(summary, fake);
      await stopChild(model.child);
    }
  });
});
