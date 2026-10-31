/**
 * A goal across a killed backend, against a real provider. Opt-in, and run on a
 * profile started by hand, because it stops and restarts that profile:
 *
 *   mise run dev:test --profile qa-goal-restart --fixture --credential-source claude --agent-platforms claude
 *   ORKESTRATOR_AGENT_TEST_PROFILE=qa-goal-restart ORKESTRATOR_AGENT_TEST_LIVE_GOALS=1 \
 *     ORKESTRATOR_AGENT_TEST_GOAL_ONLY=restart \
 *     bunx playwright test --config e2e/agent-testing/playwright.goals.config.ts
 */
import { expect, test } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { openSync, promises as fs } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  authenticatedInvoke,
  hostWorkspace,
  profileStatus,
  repositoryRoot,
  type Environment,
  type Project,
} from "./slash-command-live-support";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { outlivingProcessEnv } from "../../tests/private-tmpdir";

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-goal-restart";
const platform = process.env.ORKESTRATOR_AGENT_TEST_GOAL_PLATFORM ?? "claude";
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_GOALS === "1";

type Goal = {
  status: string;
  statusReason?: string;
  iterations: number;
  lastCheck?: { passed: boolean };
};

function runAsync(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_096);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/** `SIGKILL`s this profile's backend, then brings the profile back as it was. */
async function crashAndRestart(): Promise<void> {
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const stored = JSON.parse(
    await fs.readFile(path.join(runtime.profileRoot, "profile.json"), "utf8"),
  ) as { credentialSources?: string[]; agentPlatforms?: string[] };
  const status = profileStatus(profile) as {
    pids?: { backend?: number };
    processStartTimes?: { backend?: number };
  };
  const backend = status.pids?.backend;
  const expectedStart = status.processStartTimes?.backend;
  expect(backend, "dev:status names no backend pid to kill").toBeTruthy();
  expect(typeof expectedStart, "dev:status names no backend process start time").toBe("number");
  const inspect = (field: string) =>
    spawnSync("ps", ["-ww", "-o", `${field}=`, "-p", String(backend)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
  const command = inspect("command");
  expect(
    command.status === 0 &&
      command.stdout.includes(path.join(repositoryRoot, "apps", "backend", "src", "main.ts")) &&
      command.stdout.includes(runtime.dataDir),
    "Refusing to signal a backend outside this fixture profile",
  ).toBe(true);
  const started = inspect("lstart");
  expect(
    started.status === 0 && Math.abs(Date.parse(started.stdout.trim()) - expectedStart!) < 1000,
    "Refusing to signal a reused backend PID",
  ).toBe(true);
  process.kill(backend!, "SIGKILL");
  const stop = await runAsync("mise", ["run", "dev:stop", "--profile", profile], 90_000);
  expect(stop.code, `dev:stop failed: ${stop.stderr}`).toBe(0);
  const output = openSync(test.info().outputPath(`dev-test-restart-${Date.now()}.log`), "a");
  // `--fixture` stays off: it recreates the repository every worktree points at.
  const launcher = spawn(
    "bun",
    [
      "apps/desktop/scripts/dev-test.ts",
      "--profile",
      profile,
      ...(stored.credentialSources ?? []).flatMap((source) => ["--credential-source", source]),
      ...(stored.agentPlatforms?.length
        ? ["--agent-platforms", stored.agentPlatforms.join(",")]
        : []),
    ],
    {
      cwd: repositoryRoot,
      detached: true,
      env: outlivingProcessEnv(),
      stdio: ["ignore", output, output],
    },
  );
  launcher.unref();
  await expect
    .poll(
      () => {
        const status = profileStatus(profile);
        return status.status === "ready" && Boolean(status.browserUrl);
      },
      { timeout: 240_000, intervals: [2_000] },
    )
    .toBe(true);
}

test.describe("a goal across a killed backend", () => {
  test.skip(!LIVE, "opt-in live goal turns with host credentials");
  test.setTimeout(1_200_000);

  test("during a check, and mid-turn", async ({ page, context }) => {
    page.setDefaultTimeout(15_000);
    let status = profileStatus(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    let invoke = await authenticatedInvoke(page, status, profile);
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === status.testProject,
    );
    const environment = await invoke<Environment>("create_environment", {
      projectId: fixture!.id,
      name: `goals-restart-${Date.now()}`,
      networkAccessMode: "restricted",
      environmentType: "local",
      agentSettings: { executionPolicy: { approvals: "auto-approve" } },
    });
    await invoke("start_environment", { environmentId: environment.id });
    const started = await invoke<Environment>("get_environment", { environmentId: environment.id });
    const workspace = hostWorkspace(started.worktreePath!);
    const openTab = async (tabId: string) => {
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-goals",
          root: {
            kind: "leaf",
            id: "pane-goals",
            activeTabId: tabId,
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                nativeAgentData: { environmentId: environment.id, platform, isLocal: true },
              },
            ],
          },
        },
      });
      return {
        environmentId: environment.id,
        agent: platform,
        logicalSessionKey: `env-${environment.id}:${tabId}`,
      };
    };
    const relogin = async () => {
      await context.clearCookies();
      status = profileStatus(profile);
      invoke = await authenticatedInvoke(page, status, profile);
    };
    const goalOf = async (identity: Awaited<ReturnType<typeof openTab>>) =>
      (await invoke<{ goal?: Goal }>("get_native_agent_goal", identity)).goal;
    const waitFor = async (
      identity: Awaited<ReturnType<typeof openTab>>,
      accept: (goal: Goal | undefined) => boolean,
      label: string,
    ) => {
      const deadline = Date.now() + 300_000;
      let goal: Goal | undefined;
      while (Date.now() < deadline) {
        goal = await goalOf(identity);
        if (accept(goal)) return goal!;
        await page.waitForTimeout(1_000);
      }
      const queues = await invoke("list_prompt_queues", { environmentId: environment.id }).catch(
        (error: unknown) => String(error),
      );
      const view: Record<string, unknown> = await invoke<Record<string, unknown>>(
        "get_native_agent_projection",
        identity,
      ).catch((error: unknown) => ({ error: String(error) }));
      throw new Error(
        `${label}: last ${JSON.stringify(goal)}\nqueues ${JSON.stringify(queues).slice(0, 1500)}\nturn ${JSON.stringify(
          {
            turn: view.turn,
            connection: view.connection,
            recoverableDispatch: view.recoverableDispatch,
            notices: view.notices,
          },
        ).slice(0, 1500)}`,
      );
    };
    const lines = (file: string) =>
      (workspace.read(file) ?? "").split("\n").filter((line) => line.length > 0);

    await test.step("killed during a check, recovery adopts its worker and the goal completes", async () => {
      const identity = await openTab("restart-check");
      await invoke("native_agent_goal_command", {
        ...identity,
        text: `Append one line to goal-restart-a.log with printf, create goal-restart-a.txt, then call the orkestrator report_goal tool with status "done". --max-iterations 4 --check printf '%s\\n' "$$" >> goal-check-runs.log; sleep 20; test -f goal-restart-a.txt`,
      });
      await waitFor(identity, (goal) => goal?.status === "checking", "reaching the check");
      const runtime = resolveRuntimeProfile({
        repositoryRoot,
        requestedId: profile,
        flavor: "agent-test",
      });
      // The carrier asks the model to try the check itself first. Identify the
      // backend worker's shell explicitly so that self-check cannot satisfy the
      // pre-crash assertion or be mistaken for a duplicate recovery launch.
      const workers = async () => {
        const directory = path.join(runtime.dataDir, "exec-runs");
        const entries = await fs.readdir(directory).catch(() => []);
        const states = await Promise.all(
          entries
            .filter((entry) => entry.startsWith("goal-check-"))
            .map(async (entry) => {
              try {
                return JSON.parse(
                  await fs.readFile(path.join(directory, entry, "state.json"), "utf8"),
                ) as {
                  environmentId: string;
                  status: string;
                  childPid?: number;
                };
              } catch {
                return undefined;
              }
            }),
        );
        return states.filter(
          (state) => state?.environmentId === environment.id && state.status === "running",
        );
      };
      await expect
        .poll(
          async () => {
            const running = await workers();
            return (
              running.length === 1 &&
              lines("goal-check-runs.log").includes(String(running[0]?.childPid))
            );
          },
          { timeout: 30_000, intervals: [100] },
        )
        .toBe(true);
      const runsBeforeCrash = lines("goal-check-runs.log");
      await crashAndRestart();
      await relogin();
      const goal = await waitFor(
        identity,
        (current) => current?.status === "complete",
        "completing after the restart",
      );
      expect(goal.lastCheck?.passed).toBe(true);
      // Its durable identity recovers the same worker and result, never a twin.
      expect(lines("goal-check-runs.log")).toEqual(runsBeforeCrash);
      // The turn before the check ran once: the restart re-sent nothing.
      expect(goal.iterations).toBe(1);
      expect(lines("goal-restart-a.log")).toHaveLength(1);
    });

    await test.step("killed mid-turn, no continuation is sent twice", async () => {
      const identity = await openTab("restart-turn");
      await invoke("native_agent_goal_command", {
        ...identity,
        text: `Each turn: first append one line to goal-restart-b.log with printf. In your first turn, then run the shell command "sleep 45" and end your turn without calling report_goal. In any later turn, create goal-restart-b.txt and call the orkestrator report_goal tool with status "done". --max-iterations 5 --check test -f goal-restart-b.txt`,
      });
      await expect
        .poll(() => lines("goal-restart-b.log").length, { timeout: 120_000, intervals: [1_000] })
        .toBeGreaterThanOrEqual(1);
      await crashAndRestart();
      await relogin();
      let goal = await waitFor(
        identity,
        (current) => current?.status === "complete" || current?.status === "paused",
        "settling after the restart",
      );
      // The provider's turn died with its bridge, so pausing is honest, and
      // resuming must still finish without a duplicate.
      if (goal.status === "paused") {
        expect(["runtime-stopped", "outcome-unknown", "turn-failed", "user-stopped"]).toContain(
          goal.statusReason,
        );
        await invoke("native_agent_goal_command", { ...identity, text: "resume" });
        goal = await waitFor(identity, (current) => current?.status === "complete", "after resume");
      }
      expect(goal.status).toBe("complete");
      expect(lines("goal-restart-b.log").length).toBeLessThanOrEqual(goal.iterations + 1);
    });
  });
});
