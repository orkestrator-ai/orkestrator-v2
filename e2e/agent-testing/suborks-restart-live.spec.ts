/**
 * A `/subork` call across a killed backend (4340 (retired) task 4), following
 * `goals-restart-live.spec.ts`. Opt-in: skipped unless
 * `ORKESTRATOR_AGENT_TEST_SUBORKS=1`. It `SIGKILL`s the profile's backend and
 * starts the profile again, so it runs last, on a profile it may restart.
 *
 * A tab types `/subork` and ends its turn on the handle. While its targets'
 * turns are in flight the backend is killed, the profile is stopped and
 * started again with the selection it was started with, and the spec signs in
 * again. The call's durable row is all that carries it across: the next
 * backend resumes the row, its targets settle and the answers are mailed once.
 * The case checks:
 *
 * - every subork on the row `finished` and the delivery is `sent`;
 * - the caller was woken into a new turn that settles idle;
 * - the `/subork` turn ran once, and nothing after the restart re-sent it.
 *
 * Scripted (`ORKESTRATOR_AGENT_TEST_SUBORKS_FAKE=1`, how
 * `mise run test:agent:suborks` runs it): an OpenCode caller asks a Pi
 * target, both on `suborks-fake-model.ts`, which holds every target request
 * of this call open until the restarted profile is ready, so the kill always
 * lands mid-turn. The target's session is resumed by the runner's
 * continuation and the answer wakes the caller on the restarted OpenCode
 * server. `ORKESTRATOR_AGENT_TEST_SUBORK_RESTART_TARGETS=pi,opencode` adds an
 * OpenCode target, which fails until to-do 8045 is fixed. The fake also proves the caller was woken
 * exactly once and that each target submitted after the restart, on the
 * runner's fresh connection: a credential the dead backend held is gone.
 *
 * Live (`ORKESTRATOR_AGENT_TEST_SUBORKS_FAKE` unset, on the host's
 * credentials, `ORKESTRATOR_AGENT_TEST_SUBORK_RESTART_PLATFORM` for the
 * caller and target, default `claude`): the target is asked to run
 * `sleep 40` before it answers, and the kill lands once its row is running.
 * Real turns cost tokens; it is on the manual-test checklist (7568, 4340
 * (retired) task 4):
 *
 *   mise run dev:test --profile qa-subork-restart --fixture --headless \
 *     --credential-source claude --agent-platforms claude
 *   ORKESTRATOR_AGENT_TEST_PROFILE=qa-subork-restart ORKESTRATOR_AGENT_TEST_SUBORKS=1 \
 *     bunx playwright test --config e2e/agent-testing/playwright.suborks.config.ts \
 *     suborks-restart-live.spec.ts
 */
import { expect, test } from "./browser-test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, promises as fs, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { outlivingProcessEnv } from "../../tests/private-tmpdir";
import { devTestRestartArgs } from "./profile-restart-args";
import {
  authenticatedInvoke,
  profileStatus,
  repositoryRoot,
  type Environment,
  type Invoke,
  type Project,
} from "./slash-command-live-support";
import { suborkRequest } from "./suborks-fake-model-script";
import {
  ALL_PLATFORMS,
  FAKE_MODEL_REF,
  callFacts,
  describeProjection,
  keepProfileLogs,
  newTag,
  openTabs,
  rowText,
  sendSubork,
  startScriptedModel,
  until,
  type Platform,
  type Projection,
  type ScriptedModel,
} from "./suborks-live-support";

// Backend calls carry the disposable profile's token; keep it out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-subork-restart";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const ENABLED = process.env.ORKESTRATOR_AGENT_TEST_SUBORKS === "1";
const SCRIPTED = process.env.ORKESTRATOR_AGENT_TEST_SUBORKS_FAKE === "1";
const LIVE_PLATFORM = (process.env.ORKESTRATOR_AGENT_TEST_SUBORK_RESTART_PLATFORM ??
  "claude") as Platform;
const CALLER: Platform = SCRIPTED ? "opencode" : LIVE_PLATFORM;
/**
 * Scripted, the target is Pi. An OpenCode target is left out until to-do 8045:
 * its session stays busy in OpenCode's store after the server is killed
 * mid-turn, so the restarted backend reads the subork as running until the
 * 45-minute bound. `pi,opencode` here reproduces it.
 */
const requestedTargets = (process.env.ORKESTRATOR_AGENT_TEST_SUBORK_RESTART_TARGETS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name): name is Platform => (ALL_PLATFORMS as readonly string[]).includes(name));
const TARGETS: Platform[] =
  requestedTargets.length > 0 ? requestedTargets : SCRIPTED ? ["pi"] : [LIVE_PLATFORM];
const TIMEOUT_MS = SCRIPTED ? 300_000 : 900_000;

const outputDirectory = path.join(repositoryRoot, "output", "agent-testing", runId, "suborks");

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

/**
 * `SIGKILL`s this profile's backend, after proving it is this profile's (its
 * command line and start time), then stops the profile and starts it again
 * with the selection it was started with.
 */
async function crashAndRestart(): Promise<void> {
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const stored = JSON.parse(
    await fs.readFile(path.join(runtime.profileRoot, "profile.json"), "utf8"),
  ) as { credentialSources?: string[]; agentPlatforms?: string[]; hostSeedDisabled?: boolean };
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
  const stop = await runAsync("mise", ["run", "dev:stop", "--profile", profile], 120_000);
  expect(stop.code, `dev:stop failed: ${stop.stderr}`).toBe(0);
  const output = openSync(test.info().outputPath(`dev-test-restart-${Date.now()}.log`), "a");
  // `--fixture` stays off: it recreates the repository every worktree points at.
  const launcher = spawn("bun", devTestRestartArgs(profile, stored), {
    cwd: repositoryRoot,
    detached: true,
    env: outlivingProcessEnv(),
    stdio: ["ignore", output, output],
  });
  launcher.unref();
  await until(
    "the profile to be ready again",
    async () => profileStatus(profile),
    (current) => current.status === "ready" && Boolean(current.browserUrl),
    300_000,
  );
}

test.describe("a /subork call across a killed backend", () => {
  test.skip(!ENABLED, "opt-in: ORKESTRATOR_AGENT_TEST_SUBORKS=1");
  test.setTimeout(1_800_000);

  test("its targets settle and the answers wake the caller once", async ({ page, context }) => {
    page.setDefaultTimeout(15_000);
    let status = profileStatus(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    let invoke: Invoke = await authenticatedInvoke(page, status, profile);
    const config = await invoke<{ global?: { enabledAgentPlatforms?: string[] } }>("get_config");
    const enabled = config?.global?.enabledAgentPlatforms;
    for (const platform of new Set([CALLER, ...TARGETS])) {
      expect(
        !Array.isArray(enabled) || enabled.includes(platform),
        `${platform} is not enabled in "${profile}"`,
      ).toBe(true);
    }
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === status.testProject,
    );
    expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();
    const summary: Record<string, unknown> = {
      mode: SCRIPTED ? "scripted" : "live",
      caller: CALLER,
      targets: TARGETS,
    };
    let model: ScriptedModel | undefined;
    let tagOfRun: string | undefined;
    let identityOfRun: Record<string, string> | undefined;
    let environmentId: string | undefined;
    try {
      // Late-bound: the restart signs in again, possibly on another port.
      if (SCRIPTED)
        model = await startScriptedModel(status, (command, args) => invoke(command, args));
      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture!.id,
        name: `subork-restart-${Date.now()}`,
        networkAccessMode: "restricted",
        environmentType: "local",
      });
      environmentId = environment.id;
      await invoke("start_environment", { environmentId });
      const identity = (await openTabs(invoke, environmentId, [CALLER])).get(CALLER)!;
      const projection = () =>
        invoke<Projection>("get_native_agent_projection", { ...identity, messageLimit: 200 });
      const tag = newTag();
      tagOfRun = tag;
      identityOfRun = identity;
      if (model) await model.hold(tag);
      const request = SCRIPTED
        ? suborkRequest(TARGETS, tag)
        : `${suborkRequest(TARGETS, tag)}. Tell it to run the shell command "sleep 40" first.`;

      await test.step("the call is running when the backend is killed", async () => {
        await sendSubork(invoke, identity, request, SCRIPTED ? FAKE_MODEL_REF : undefined);
        await until(
          "the subork call to be running",
          projection,
          (view) => view?.suborks?.some((batch) => batch.status === "running") ?? false,
          TIMEOUT_MS,
          describeProjection,
        );
        if (model) {
          // Every target's turn is in flight, held at the model.
          await until(
            "every target's turn to reach the model",
            () => model!.calls(),
            (calls) => TARGETS.every((target) => calls.held.includes(`${target} ${tag}`)),
            TIMEOUT_MS,
          );
        } else {
          await page.waitForTimeout(10_000);
        }
        const before = await projection();
        if (model) summary.fakeBeforeCrash = callFacts(await model.calls(), tag);
        summary.beforeCrash = before?.suborks?.map((batch) => ({
          status: batch.status,
          suborks: batch.suborks.map((subork) => subork.status),
        }));
        await crashAndRestart();
        await context.clearCookies();
        status = profileStatus(profile);
        invoke = await authenticatedInvoke(page, status, profile);
        // The dead backend's connections are gone; let the held requests answer.
        await model?.release();
      });

      await test.step("the restarted backend settles the call and wakes the caller", async () => {
        const settled = await until(
          "the subork call to settle after the restart",
          projection,
          (view) => view?.suborks?.some((batch) => batch.status !== "running") ?? false,
          TIMEOUT_MS,
          (view) => describeProjection(view, { lines: SCRIPTED }),
        );
        const batch = settled!.suborks!.find((candidate) => candidate.status !== "running")!;
        const rowsAtSettle = settled?.messages?.length ?? 0;
        expect(settled!.suborks, "the restart made a second call").toHaveLength(1);
        expect(batch.status).toBe("settled");
        for (const subork of batch.suborks) {
          expect(subork.status, `${subork.agent} did not finish: ${subork.line ?? ""}`).toBe(
            "finished",
          );
        }
        expect(batch.suborks.map((subork) => subork.agent).sort()).toEqual([...TARGETS].sort());
        expect(batch.delivery, batch.deliveryDetail ?? "").toBe("sent");
        await until(
          "the caller to be woken by the answers",
          projection,
          (view) => {
            if (view?.turn.phase !== "idle") return false;
            const rows = view.messages ?? [];
            return SCRIPTED
              ? rows.some(
                  (row) =>
                    row.role === "assistant" &&
                    rowText(row).includes(`ANSWERS-RECEIVED ${tag} ${TARGETS.length}`),
                )
              : rows.length > rowsAtSettle && rows.at(-1)?.role === "assistant";
          },
          TIMEOUT_MS,
          describeProjection,
        );
        summary.suborks = batch.suborks.map((subork) => ({
          agent: subork.agent,
          status: subork.status,
        }));
        summary.delivery = batch.delivery;
        if (model) {
          const calls = await model.calls();
          const turns = calls.turns.filter((turn) => turn.tag === tag);
          const callerStarts = turns.filter((turn) => turn.role === "caller" && turn.turnStart);
          const wakes = turns.filter((turn) => turn.role === "wake" && turn.turnStart);
          expect(callerStarts, "the /subork turn was sent again").toHaveLength(1);
          expect(wakes, "the caller was woken more or less than once").toHaveLength(1);
          expect(wakes[0]?.answers?.sort()).toEqual([...TARGETS].sort());
          const targetStarts = turns.filter((turn) => turn.role === "target" && turn.turnStart);
          summary.fake = {
            held: calls.held.filter((entry) => entry.endsWith(tag)).length,
            targetTurnStarts: Object.fromEntries(
              TARGETS.map((target) => [
                target,
                targetStarts.filter((turn) => turn.platform === target).length,
              ]),
            ),
            submits: calls.toolCalls,
            wakeTurns: wakes.length,
          };
        }
      });
      summary.result = "passed";
    } catch (error) {
      summary.result = "failed";
      if (model && tagOfRun) {
        summary.fakeAtFailure = await model
          .calls()
          .then((calls) => callFacts(calls, tagOfRun!))
          .catch((cause: unknown) => String(cause));
      }
      summary.atFailure = await invoke<Projection>("get_native_agent_projection", {
        ...identityOfRun,
        messageLimit: 200,
      })
        .then((view) => JSON.parse(describeProjection(view, { lines: SCRIPTED })) as unknown)
        .catch((cause: unknown) => String(cause).slice(0, 300));
      keepProfileLogs(profile, test.info().outputPath("profile-logs"));
      throw error;
    } finally {
      mkdirSync(outputDirectory, { recursive: true });
      writeFileSync(
        path.join(outputDirectory, "restart-summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      await model?.release().catch(() => undefined);
      // ORKESTRATOR_AGENT_TEST_SUBORKS_KEEP=1 keeps a failed run's environment
      // (and its stored call) for inspection; reset the profile afterwards.
      const keep =
        summary.result === "failed" && process.env.ORKESTRATOR_AGENT_TEST_SUBORKS_KEEP === "1";
      if (environmentId && !keep) {
        await invoke("stop_environment", { environmentId }).catch(() => undefined);
        await invoke("delete_environment", { environmentId }).catch(() => undefined);
      }
      await model?.stop();
    }
  });
});
