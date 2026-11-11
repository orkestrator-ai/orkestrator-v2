/**
 * The build pipeline's prompt dispatch window, crashed live at both of its
 * backend-side points (to-do 0050 task 3), on a real `dev:test --fixture`
 * profile whose Pi talks to a loopback fake model: no login, nothing billed.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_DISPATCH_HOLD=1`): it `SIGKILL`s the
 * profile's backend twice and restarts the profile, so run it on its own
 * against a Pi-only, credential-free profile you started by hand (see
 * `docs/development/agent-testing.md`, "Live dispatch hold"), never inside
 * `test:agent:browser:isolated`.
 *
 * The backend's test-only dispatch hold (`agent-test-dispatch-hold.ts`) makes
 * each point deterministic instead of a race:
 *
 * 1. **Journaled, not sent.** With `hold-before-send` armed the build stage's
 *    task prompt is journaled (`pendingPromptAttempt` with `dispatchingAt`)
 *    and parked before the request leaves the backend. The fake model has
 *    seen no turn for the prompt's tag. The backend is killed there.
 * 2. **Same-id resend.** `hold-after-response` is armed before the profile
 *    comes back. The restarted backend must ask the bridge, learn the id never
 *    arrived (`absent`), and resend under the *same* request id: the hold
 *    then parks the resend after the bridge accepted it, and its record names
 *    the original id. The fake model has seen exactly one turn for the tag.
 * 3. **Accepted, not recorded.** The backend is killed again while parked
 *    there. The restarted backend must learn the id did arrive (`dispatched`
 *    or `pending`), settle the attempt as sent without a resend, and the
 *    stage must carry on on the same session.
 *
 * The tag is a random `QATAG…` word in the ticket description; the fake
 * counts the turns whose opening prompt carries it, so neither prompts nor
 * transcripts reach test output. Measurements are Playwright annotations.
 */
import { expect, test, type Page } from "./browser-test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  promises as fs,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import { rowText, type Row } from "./cold-restart-evidence";
import {
  authenticatedInvoke,
  profileStatus,
  repositoryRoot,
  type Environment,
  type Invoke,
  type Project,
  type Status,
} from "./slash-command-live-support";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { outlivingProcessEnv } from "../../tests/private-tmpdir";
import { devTestRestartArgs } from "./profile-restart-args";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_DISPATCH_HOLD === "1";
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-dispatch-hold";

const PI_PROVIDER = "dispatch-hold-fake";
const PI_MODEL = "autopipe-1";
const MODEL_REF = `${PI_PROVIDER}/${PI_MODEL}`;
/** `DISPATCH_HOLD_FIXTURE_DIR` in `apps/backend/src/core/agent-test-dispatch-hold.ts`. */
const HOLD_DIR = path.join("agent-test-fixtures", "dispatch-hold");
const STEP_TIMEOUT_MS = 4 * 60_000;
const PIPELINE_TIMEOUT_MS = 8 * 60_000;

type HoldPoint = "before-send" | "after-response";
type HoldRecord = {
  point: HoldPoint;
  agent: string;
  sessionId: string;
  requestId?: string;
  pid: number;
  heldAt: string;
  releasedAt?: string;
};
type Calls = {
  completions: number;
  refused: number;
  tags?: Record<string, number>;
  tagPeaks?: Record<string, number>;
};
type PipelineRead =
  | { unchanged: true }
  | {
      unchanged: false;
      messagePatches: Array<{
        sessionKey: string;
        startIndex: number;
        messages: Row[];
        unavailable?: true;
        deferred?: true;
      }>;
    };
type RestartStatus = Status & { pids?: { backend?: number } };

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

function note(type: string, value: unknown): void {
  test.info().annotations.push({
    type,
    description: typeof value === "string" ? value : JSON.stringify(value),
  });
}

/** The fake model on loopback; its own handle stops it. */
async function startFakeModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn("bun", [path.join(import.meta.dirname, "auto-pipeline-fake-model.ts")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
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
 * Names the fake provider in the profile's isolated Pi `models.json` (never
 * `~/.pi`); returns the restore. The key is a literal placeholder.
 */
function pointPiAt(dataDir: string, baseUrl: string): () => void {
  const root = path.resolve(dataDir);
  const directory = path.join(root, "agent-credentials", "home", ".pi", "agent");
  const file = path.join(directory, "models.json");
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("models.json escapes the profile");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const restore = snapshotFixtureFiles([file]);
  const existing = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { providers?: Record<string, unknown> })
    : {};
  const config = {
    ...existing,
    providers: {
      ...existing.providers,
      [PI_PROVIDER]: {
        name: "Dispatch hold fake",
        baseUrl,
        api: "openai-completions",
        apiKey: "dispatch-hold-fake-not-a-key",
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
            name: "Dispatch hold 1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 4_096,
          },
        ],
      },
    },
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return restore;
}

/** The profile's hold directory, checked to stay inside its data directory. */
function holdDirectory(dataDir: string): string {
  const root = path.resolve(dataDir);
  const directory = path.join(root, HOLD_DIR);
  if (!directory.startsWith(`${root}${path.sep}`)) throw new Error("hold dir escapes the profile");
  return directory;
}

/**
 * Arms a point. Its earlier record goes first: a backend killed while held
 * never marks its record released, so a stale one would read as a new hold.
 */
function arm(dataDir: string, point: HoldPoint): void {
  const directory = holdDirectory(dataDir);
  mkdirSync(directory, { recursive: true });
  rmSync(path.join(directory, `held-${point}.json`), { force: true });
  writeFileSync(path.join(directory, `hold-${point}`), "");
}

async function disarm(dataDir: string, point: HoldPoint): Promise<void> {
  await fs.rm(path.join(holdDirectory(dataDir), `hold-${point}`), { force: true });
}

/** Removes everything this spec put in the hold directory. */
async function clearHolds(dataDir: string): Promise<void> {
  await fs.rm(holdDirectory(dataDir), { recursive: true, force: true });
}

async function heldRecord(dataDir: string, point: HoldPoint): Promise<HoldRecord | undefined> {
  const file = path.join(holdDirectory(dataDir), `held-${point}.json`);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as HoldRecord;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs a command without blocking the event loop, so earlier launchers are reaped. */
function runAsync(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
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
 * `SIGKILL`s this profile's backend (and only it, by the pid its own status
 * manifest names), runs `beforeStart` while nothing of the profile runs, then
 * starts the profile again with the selection in its `profile.json`. A
 * credential-free profile is restarted with `--no-agent-credentials`, which
 * the launcher would otherwise read as "all host credentials".
 */
async function crashAndRestart(
  beforeStart: () => Promise<void>,
): Promise<{ status: RestartStatus; ms: number; readyAt: number }> {
  const startedAt = Date.now();
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const stored = JSON.parse(
    await fs.readFile(path.join(runtime.profileRoot, "profile.json"), "utf8"),
  ) as { credentialSources?: string[]; agentPlatforms?: string[]; hostSeedDisabled?: boolean };
  const current = profileStatus(profile) as RestartStatus;
  expect(current.status).toBe("ready");
  expect(current.flavor).toBe("agent-test");
  const backend = current.pids?.backend;
  expect(backend, "dev:status names no backend pid to kill").toBeTruthy();
  process.kill(backend!, "SIGKILL");
  await expect.poll(() => processAlive(backend!), { timeout: 10_000 }).toBe(false);
  const stop = await runAsync("mise", ["run", "dev:stop", "--profile", profile], 90_000);
  expect(stop.code, `dev:stop failed: ${stop.stderr}`).toBe(0);
  await beforeStart();
  const args = devTestRestartArgs(profile, stored);
  const output = openSync(test.info().outputPath(`dev-test-restart-${Date.now()}.log`), "a");
  const launcher = spawn("bun", args, {
    cwd: repositoryRoot,
    detached: true,
    env: { ...outlivingProcessEnv(), ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
    stdio: ["ignore", output, output],
  });
  launcher.unref();
  let status: RestartStatus | undefined;
  await expect
    .poll(
      () => {
        status = profileStatus(profile) as RestartStatus;
        return status.status === "ready" && Boolean(status.browserUrl);
      },
      { timeout: 240_000, intervals: [2_000] },
    )
    .toBe(true);
  const readyAt = Date.now();
  return { status: status!, ms: readyAt - startedAt, readyAt };
}

/** One stage session's committed history, as a viewer reads it. */
async function committedHistory(
  invoke: Invoke,
  pipelineId: string,
  sessionKey: string,
): Promise<Row[]> {
  for (let pass = 0; pass < 10; pass += 1) {
    const result = await invoke<PipelineRead>("get_build_pipeline", {
      pipelineId,
      knownSessions: {},
    });
    if (result.unchanged) break;
    const patch = result.messagePatches.find((candidate) => candidate.sessionKey === sessionKey);
    expect(patch?.unavailable, "the build history is unavailable").toBeUndefined();
    if (patch && !patch.deferred) {
      expect(patch.startIndex).toBe(0);
      return patch.messages;
    }
  }
  throw new Error("the build history never loaded");
}

async function connect(page: Page): Promise<{ invoke: Invoke; status: Status }> {
  const status = profileStatus(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  expect(status.dataDir, "dev:status reported no data directory").toBeTruthy();
  return { invoke: await authenticatedInvoke(page, status, profile), status };
}

test.describe("Build pipeline dispatch window under a held send", () => {
  test.skip(!LIVE, "opt-in: set ORKESTRATOR_AGENT_TEST_DISPATCH_HOLD=1 (fake model, no billing)");
  test.setTimeout(20 * 60_000);

  test("a journaled send is resent once under its id; an accepted one is not resent", async ({
    page,
  }) => {
    page.setDefaultTimeout(30_000);
    let { invoke, status } = await connect(page);
    const dataDir = status.dataDir!;
    // A profile this spec restarted (without `--fixture`, which would recreate
    // the repository) no longer names its test project in `dev:status`; the
    // seeded project is still the one under the profile's `fixtures/`.
    const testProject =
      status.testProject ??
      path.join(
        resolveRuntimeProfile({ repositoryRoot, requestedId: profile, flavor: "agent-test" })
          .profileRoot,
        "fixtures",
        "test-project",
      );
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === testProject,
    );
    expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
    const tag = `QATAG${randomBytes(4).toString("hex").toUpperCase()}`;
    const model = await startFakeModel();
    const restores: Array<() => void> = [];
    let pipelineId: string | undefined;
    let environmentId: string | undefined;
    try {
      restores.push(pointPiAt(dataDir, `${model.origin}/v1`));
      note("model", `pi on a loopback fake (${MODEL_REF}); no login, nothing billed`);
      const created = await invoke<Environment>("create_environment", {
        projectId: fixture!.id,
        name: `dispatch-hold-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      environmentId = created.id;
      await invoke("start_environment", { environmentId });

      const read = async () =>
        (
          await invoke<{ snapshot: BuildPipeline }>("get_build_pipeline", {
            pipelineId: pipelineId!,
          })
        ).snapshot;
      const buildSession = (pipeline: BuildPipeline) =>
        pipeline.sessions.find((session) => session.phase === "build");
      const tagged = async () => (await calls(model.origin)).tags?.[tag] ?? 0;

      // --- 1. Journaled, not sent ------------------------------------------
      await clearHolds(dataDir);
      arm(dataDir, "before-send");
      const started = await invoke<BuildPipeline>("start_build_pipeline", {
        taskId: `qa-dispatch-hold-${environmentId}`,
        projectId: fixture!.id,
        existingEnvironmentId: environmentId,
        environmentType: "local",
        agentType: "pi",
        steps: { build: { agent: "pi", model: MODEL_REF } },
        deliveryPolicy: "commit-only",
        taskTitle: "Dispatch hold qualification",
        taskSnapshot: {
          title: "Dispatch hold qualification",
          description: `Reply with one word. ${tag}`,
          acceptanceCriteria: "The build replies.",
          comments: [],
          images: [],
        },
      });
      pipelineId = started.id;
      let firstHold: HoldRecord | undefined;
      await expect
        .poll(
          async () => {
            firstHold = await heldRecord(dataDir, "before-send");
            return Boolean(firstHold && !firstHold.releasedAt);
          },
          { timeout: STEP_TIMEOUT_MS, intervals: [250], message: "the build send was never held" },
        )
        .toBe(true);
      const journaled = await read();
      const attempt = journaled.pendingPromptAttempt;
      const atFirstCrash = buildSession(journaled);
      note("held-before-send", {
        phase: journaled.phase,
        pending: Boolean(attempt),
        windowOpen: attempt?.dispatchingAt !== undefined,
        sameRequestId: attempt?.requestId === firstHold!.requestId,
        sessionStatus: atFirstCrash?.status,
        taggedTurns: await tagged(),
      });
      expect(attempt, "no prompt attempt journaled while held").toBeTruthy();
      expect(attempt!.dispatchingAt, "the dispatch window is not open while held").toBeTruthy();
      expect(attempt!.requestId).toBe(firstHold!.requestId);
      expect(atFirstCrash?.sdkSessionId).toBe(firstHold!.sessionId);
      expect(await tagged(), "the held prompt reached the model").toBe(0);

      // --- 2. Crash; the restart must resend once under the same id ---------
      const first = await crashAndRestart(async () => {
        await disarm(dataDir, "before-send");
        arm(dataDir, "after-response");
      });
      ({ invoke, status } = await connect(page));
      let resend: HoldRecord | undefined;
      await expect
        .poll(
          async () => {
            const pipeline = await read();
            if (pipeline.phase === "failed") {
              throw new Error(`pipeline failed after the first restart: ${pipeline.error ?? ""}`);
            }
            resend = await heldRecord(dataDir, "after-response");
            return Boolean(resend && !resend.releasedAt);
          },
          { timeout: STEP_TIMEOUT_MS, intervals: [500], message: "the restart never resent" },
        )
        .toBe(true);
      const resent = await read();
      note("first-restart", {
        restartMs: first.ms,
        readyToResendMs: Date.parse(resend!.heldAt) - first.readyAt,
        resendRequestId: resend!.requestId === firstHold!.requestId ? "same" : "different",
        resendSession: resend!.sessionId === firstHold!.sessionId ? "same" : "different",
        pendingWhileHeld: resent.pendingPromptAttempt?.requestId === firstHold!.requestId,
        taggedTurns: await tagged(),
      });
      expect(resend!.requestId, "the restart resent under a new id").toBe(firstHold!.requestId);
      expect(resend!.sessionId).toBe(firstHold!.sessionId);
      await expect.poll(tagged, { timeout: 60_000 }).toBe(1);

      // --- 3. Crash after acceptance; no resend ------------------------------
      const second = await crashAndRestart(async () => {
        await disarm(dataDir, "after-response");
        arm(dataDir, "before-send");
      });
      ({ invoke, status } = await connect(page));
      let settled: BuildPipeline | undefined;
      await expect
        .poll(
          async () => {
            settled = await read();
            if (settled.phase === "failed") {
              throw new Error(`pipeline failed after the second restart: ${settled.error ?? ""}`);
            }
            const unexpected = await heldRecord(dataDir, "before-send");
            expect(unexpected?.requestId, "accepted request was resent after restart").not.toBe(
              firstHold!.requestId,
            );
            return settled.pendingPromptAttempt?.requestId !== firstHold!.requestId;
          },
          {
            timeout: STEP_TIMEOUT_MS,
            intervals: [500],
            message: "the accepted send never settled",
          },
        )
        .toBe(true);
      expect((await heldRecord(dataDir, "before-send"))?.requestId).not.toBe(firstHold!.requestId);
      await disarm(dataDir, "before-send");
      const readyToSettledMs = Date.now() - second.readyAt;
      // The stage goes on to the end of the run on the same session. A
      // commit-only run on the fake model finishes without a pull request.
      let after: BuildPipeline | undefined;
      await expect
        .poll(
          async () => {
            after = await read();
            if (after.phase === "failed") {
              throw new Error(`pipeline failed after the second restart: ${after.error ?? ""}`);
            }
            return after.phase;
          },
          {
            timeout: PIPELINE_TIMEOUT_MS,
            intervals: [1_000],
            message: "the pipeline never completed",
          },
        )
        .toBe("complete");
      const build = buildSession(after!)!;
      const history = await committedHistory(invoke, pipelineId!, build.sessionKey);
      const taggedRows = history.filter(
        (row) => row.role === "user" && rowText(row).includes(tag),
      ).length;
      const final = await calls(model.origin);
      note("second-restart", {
        restartMs: second.ms,
        readyToSettledMs,
        phase: after!.phase,
        sameSession: build.sdkSessionId === firstHold!.sessionId,
        restartContinuationSent: build.restartContinuationSent === true,
        buildHistoryRows: history.length,
        taggedBuildRows: taggedRows,
        // Each stage's own session quotes the ticket once; a second delivery
        // into one session would show as a peak of 2.
        taggedTurns: final.tags?.[tag] ?? 0,
        taggedPeakPerRequest: final.tagPeaks?.[tag] ?? 0,
        sessions: after!.sessions.map((session) => session.phase),
      });
      expect(build.sdkSessionId, "the stage moved to a new session").toBe(firstHold!.sessionId);
      expect(taggedRows, "the build history holds the task prompt other than once").toBe(1);
      expect(
        final.tagPeaks?.[tag],
        "the task prompt reached one provider session more than once",
      ).toBe(1);
    } finally {
      await clearHolds(dataDir).catch(() => undefined);
      if (pipelineId) {
        await invoke("cancel_build_pipeline", { pipelineId }).catch(() => undefined);
        await invoke("delete_build_pipeline", { pipelineId }).catch(() => undefined);
      }
      if (environmentId) {
        await invoke("delete_environment", { environmentId }).catch(() => undefined);
      }
      for (const restore of restores.reverse()) restore();
      await stopChild(model.child);
    }
  });
});
