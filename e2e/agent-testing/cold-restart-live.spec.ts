/**
 * Live cold restarts against a real `dev:test --fixture` profile: display
 * tails and build-pipeline histories must reconcile with no lost, duplicated
 * or stale rows.
 *
 * Opt-in only (`ORKESTRATOR_AGENT_TEST_LIVE_COLD_RESTART=1`): every case runs
 * real provider turns on the host's credentials and stops and starts the
 * profile (backend, bridges and Electron) several times, so run this file on
 * its own against a profile you started by hand, never inside
 * `test:agent:browser:isolated`.
 *
 * Each turn follows a trail of files whose names chain to each other, so the
 * agent must read them one per step and the stop each tool call read places
 * every row without reading model prose. Every prompt carries a random tag, so
 * a prompt delivered twice is countable. A provider replay may re-key and
 * re-split rows (Codex mints new row ids on every rollout replay), so rows
 * that must survive a restart are compared by content: prompts, the stops
 * each tool call read, and each text or reasoning part. Whether ids survived
 * is recorded as `idsKept`.
 *
 * 1. A native tab (Codex by default, or Claude with
 *    `ORKESTRATOR_AGENT_TEST_COLD_RESTART_NATIVE_PLATFORM=claude`) finishes a
 *    short trail, then the profile is stopped and started (an idle restart:
 *    the backend drains its display-tail checkpoints on the way down). The
 *    first read after the restart must be the persisted tail (`cached`) with
 *    exactly the rows the conversation had, and a client that keeps reading
 *    from that cached view, never forcing, must end on exactly the provider's
 *    rows. The browser must show each prompt and the closing word in one row,
 *    before and after a reload.
 * 2. The same tab starts a long trail, and the backend is `SIGKILL`ed while
 *    the turn runs (a crash: no drain, so the tail is whatever the last
 *    checkpoint wrote). The cached tail may lag, but must already hold the
 *    prompt (the checkpoint age bound) and never a row the provider lacks.
 *    The turn must settle instead of showing running forever, the provider's
 *    rows must keep all content from before the crash, and a follow-up must
 *    finish the trail, every stop in order, without any prompt appearing
 *    twice.
 * 3. A build pipeline's backend is `SIGKILL`ed as soon as the build stage's
 *    prompt is journaled (`pendingPromptAttempt`), before or while the
 *    provider accepts it: the mid-dispatch window. After the restart the task
 *    prompt must reach the provider exactly once, on the same session, and the
 *    stage must finish the trail.
 * 4. A second pipeline is restarted mid-turn, after a persist boundary
 *    committed part of its transcript. The committed history must be readable
 *    straight after the restart with all content from before it; the stage
 *    then continues once (restart continuation) on the same session and
 *    finishes, and the committed history must hold that content once.
 *    Both pipelines are then cancelled and the profile restarted idle: every
 *    stage history must come back byte-identical.
 *
 * Models default to the cheapest each platform offers: GPT-6-Luna (Codex) or
 * the first Haiku (Claude); override with
 * `ORKESTRATOR_AGENT_TEST_COLD_RESTART_NATIVE_MODEL` and
 * `ORKESTRATOR_AGENT_TEST_COLD_RESTART_BUILD_MODEL` (Codex model ids). Trail
 * lengths are `ORKESTRATOR_AGENT_TEST_COLD_RESTART_SHORT_STOPS` (default 6) and
 * `ORKESTRATOR_AGENT_TEST_COLD_RESTART_LONG_STOPS` (default 30). Measurements
 * land as Playwright annotations in `results.json`; prompts and transcript text
 * never reach test output. Nothing at module scope or in a hook spawns `mise`
 * or reads profile state, so the file stays inert without the opt-in.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync, promises as fs } from "node:fs";
import path from "node:path";
import {
  applyNativeAgentTranscriptDelta,
  DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
  type NativeAgentTranscriptUpdate,
  type NativeAgentTranscriptView,
} from "@orkestrator/protocol/native-agent";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

import {
  rowText,
  repeatedPrompts,
  lostContent,
  duplicatedContent,
  sameDisplayedRows,
  trailOrder,
  trailStopsRead,
  type Row,
} from "./cold-restart-evidence";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { outlivingProcessEnv } from "../../tests/private-tmpdir";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
  pids?: { backend?: number };
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type ProjectionUpdate = {
  status: string;
  projection?: { turn: { phase: string; error?: string }; messages: Row[] };
};
type PipelineRead =
  | { unchanged: true; revision: number }
  | {
      unchanged: false;
      record: { revision: number; snapshot: BuildPipeline };
      messagePatches: Array<{
        sessionKey: string;
        startIndex: number;
        revision: number;
        messages: Row[];
        unavailable?: true;
        deferred?: true;
        complete?: false;
      }>;
    };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_COLD_RESTART === "1";
const NATIVE_PLATFORM: "claude" | "codex" =
  process.env.ORKESTRATOR_AGENT_TEST_COLD_RESTART_NATIVE_PLATFORM === "claude" ? "claude" : "codex";
const NATIVE_LABEL = NATIVE_PLATFORM === "codex" ? "Codex" : "Claude";
const NATIVE_MODEL = process.env.ORKESTRATOR_AGENT_TEST_COLD_RESTART_NATIVE_MODEL;
const BUILD_MODEL = process.env.ORKESTRATOR_AGENT_TEST_COLD_RESTART_BUILD_MODEL;
const SHORT_STOPS = Number(process.env.ORKESTRATOR_AGENT_TEST_COLD_RESTART_SHORT_STOPS ?? "6");
const LONG_STOPS = Number(process.env.ORKESTRATOR_AGENT_TEST_COLD_RESTART_LONG_STOPS ?? "30");
/** Stops a long turn must have read before it is interrupted. */
const STOPS_BEFORE_RESTART = 6;
/**
 * `NATIVE_DISPLAY_TAIL_MAX_CHECKPOINT_AGE_MS` (10 s) plus margin: a row older
 * than this when the backend dies must already be in the persisted tail.
 */
const CHECKPOINT_AGE_MARGIN_MS = 14_000;
/** `DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS` (5 s) plus margin. */
const PERSIST_BOUNDARY_MARGIN_MS = 9_000;
const TURN_TIMEOUT_MS = 12 * 60_000;
/** Leaves environments and pipelines in place after a failed case, for inspection. */
const KEEP_ON_FAILURE = process.env.ORKESTRATOR_AGENT_TEST_COLD_RESTART_KEEP === "1";
const RESTART_CONTINUATION = "Orkestrator restarted while you were working";

test.describe.configure({ mode: "serial" });
// A multi-minute live trace outgrows the artifact sanitizer's bound.
test.use({ trace: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) {
    throw new Error(`dev:status for profile "${profile}" returned no manifest`);
  }
  return JSON.parse(command.stdout) as Status;
}

function readyStatus(): Status {
  const status = profileStatus();
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  return status;
}

function note(type: string, value: unknown): void {
  test.info().annotations.push({
    type,
    description: typeof value === "string" ? value : JSON.stringify(value),
  });
}

/** Signs the page in and returns an invoker bound to the profile's current gateway. */
async function signIn(page: Page, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok() ?? false).toBe(true);
  return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command: name, args } },
    );
    expect(invokeResponse.ok(), `${name}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs a command without blocking the event loop; see `restartProfile`. */
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
 * Stops the profile and starts it again with the credential and platform
 * selection stored in its `profile.json`, as quitting and reopening the app
 * would. `crash` first `SIGKILL`s this profile's backend (and only it), so
 * nothing drains: display tails and pipeline checkpoints are whatever was
 * last written. `--fixture` is deliberately not passed on the way back up: it
 * recreates the fixture repository every environment's worktree points at.
 */
async function restartProfile(
  mode: "graceful" | "crash",
): Promise<{ status: Status; ms: number; killedAt?: number }> {
  const startedAt = Date.now();
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const stored = JSON.parse(
    await fs.readFile(path.join(runtime.profileRoot, "profile.json"), "utf8"),
  ) as { credentialSources?: string[]; agentPlatforms?: string[] };
  let killedAt: number | undefined;
  if (mode === "crash") {
    const backend = readyStatus().pids?.backend;
    expect(backend, "dev:status names no backend pid to kill").toBeTruthy();
    killedAt = Date.now();
    process.kill(backend!, "SIGKILL");
    await expect.poll(() => processAlive(backend!), { timeout: 10_000 }).toBe(false);
  }
  // Never `spawnSync` here: the launcher an earlier restart started is this
  // worker's child, and a blocked event loop cannot reap it, so `dev:stop`
  // would see its zombie as a surviving launcher.
  const stop = await runAsync("mise", ["run", "dev:stop", "--profile", profile], 90_000);
  expect(stop.code, `dev:stop failed: ${stop.stderr}`).toBe(0);
  const args = [
    "apps/desktop/scripts/dev-test.ts",
    "--profile",
    profile,
    ...(stored.credentialSources ?? []).flatMap((source) => ["--credential-source", source]),
    ...(stored.agentPlatforms?.length
      ? ["--agent-platforms", stored.agentPlatforms.join(",")]
      : []),
  ];
  const output = openSync(test.info().outputPath(`dev-test-restart-${Date.now()}.log`), "a");
  // The launcher is a foreground supervisor; it outlives this test and is
  // stopped with the profile, exactly like the one the caller started.
  const launcher = spawn("bun", args, {
    cwd: repositoryRoot,
    detached: true,
    env: outlivingProcessEnv(),
    stdio: ["ignore", output, output],
  });
  launcher.unref();
  let status: Status | undefined;
  await expect
    .poll(
      () => {
        status = profileStatus();
        return status.status === "ready" && Boolean(status.browserUrl);
      },
      { timeout: 240_000, intervals: [2_000] },
    )
    .toBe(true);
  return { status: status!, ms: Date.now() - startedAt, killedAt };
}

/** A chain of files, each naming the next under a random name. */
class Trail {
  readonly dir: string;
  readonly files: string[];
  readonly closingWord: string;
  /** A random word in the prompt, so a prompt delivered twice is countable. */
  readonly tag: string;
  private readonly positions: Map<string, number>;

  constructor(readonly stops: number) {
    const run = randomBytes(3).toString("hex");
    this.dir = `trail-${run}`;
    this.files = Array.from({ length: stops }, () => `${randomBytes(5).toString("hex")}.txt`);
    this.closingWord = `TRAILEND${randomBytes(3).toString("hex").toUpperCase()}`;
    this.tag = `RUNTAG${randomBytes(3).toString("hex").toUpperCase()}`;
    this.positions = new Map(this.files.map((file, index) => [file, index + 1]));
  }

  get start(): string {
    return `${this.dir}/${this.files[0]}`;
  }

  async write(root: string): Promise<void> {
    await fs.mkdir(path.join(root, this.dir), { recursive: true });
    await Promise.all(
      this.files.map((file, index) => {
        const next = this.files[index + 1];
        const body = next
          ? `Trail stop ${index + 1} of ${this.stops}. Next stop: ${this.dir}/${next}\n`
          : `Trail stop ${index + 1} of ${this.stops}. This is the end of the trail. The closing word is ${this.closingWord}.\n`;
        return fs.writeFile(path.join(root, this.dir, file), body);
      }),
    );
  }

  prompt(platform: "claude" | "codex"): string {
    return [
      `Run tag ${this.tag}.`,
      `This repository contains a trail of text files. It starts at ${this.start}.`,
      "Each file names the next file. Follow the trail to its end.",
      ...(platform === "codex"
        ? [
            "Rules: read exactly one file per step with a single `cat` of that one file, wait",
            "for its result, then write one short sentence saying which stop you reached before",
            "reading the next. Never read several files at once, and never list, search or glob",
            "the directory. Do not create, change or delete any file, and do not commit.",
          ]
        : [
            "Rules: read exactly one file per response with your file-reading tool, wait for its",
            "result before reading the next, never read several files at once, and never list,",
            "search or glob the directory or run shell commands. Do not summarise along the way.",
          ]),
      "When you reach the file that ends the trail, reply with only its closing word.",
    ].join(" ");
  }

  /** The stops a row's tool calls read, from their arguments only. */
  stopsRead(row: Row): number[] {
    return trailStopsRead(row, this.positions);
  }

  /** Highest stop read in order; fails when a stop appears before its predecessor. */
  verifyOrder(rows: Row[], label: string): { stopsRead: number; highest: number } {
    const result = trailOrder(rows, (row) => this.stopsRead(row));
    expect(result.outOfOrder, `${label}: a stop appears before its predecessor`).toBe(0);
    expect(result.duplicates, `${label}: a stop was read twice in the same prompt`).toBe(0);
    return { stopsRead: result.highest, highest: result.highest };
  }

  /** User rows carrying this trail's prompt. */
  promptRows(rows: Row[]): number {
    return rows.filter((row) => row.role === "user" && rowText(row).includes(this.tag)).length;
  }

  reachedEnd(rows: Row[]): boolean {
    return rows.some((row) => row.role === "assistant" && rowText(row).includes(this.closingWord));
  }
}

function rowIds(rows: Row[]): string[] {
  return rows.map((row) => String(row.id));
}

function expectUniqueIds(rows: Row[], label: string): void {
  const ids = rowIds(rows);
  expect(new Set(ids).size, `${label}: duplicate row ids`).toBe(ids.length);
}

/** Ids in `subset` that `superset` lacks. */
function missingIds(subset: Row[], superset: Row[]): string[] {
  const known = new Set(rowIds(superset));
  return rowIds(subset).filter((id) => !known.has(id));
}

async function connect(page: Page) {
  const status = readyStatus();
  const invoke = await signIn(page, status);
  // A profile restarted without `--fixture` no longer reports its test
  // project, but the seeded copy is still there.
  const testProject =
    status.testProject ??
    path.join(
      resolveRuntimeProfile({
        repositoryRoot,
        requestedId: profile,
        flavor: "agent-test",
      }).fixtureDir,
      "test-project",
    );
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === testProject,
  );
  expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
  return { status, invoke, fixture: fixture! };
}

async function createEnvironment(
  invoke: Invoke,
  fixture: Project,
  name: string,
): Promise<Environment> {
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `${name}-${Date.now()}`,
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  await invoke("start_environment", { environmentId: environment.id });
  const started = await invoke<Environment>("get_environment", {
    environmentId: environment.id,
  });
  expect(started.worktreePath).toBeTruthy();
  return started;
}

async function removeEnvironments(invoke: Invoke, environments: Environment[]): Promise<void> {
  for (const environment of environments) {
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
}

async function openApp(page: Page, status: Status, fixture: Project, environmentName: string) {
  await page.goto(status.browserUrl!);
  const expand = page.getByRole("button", {
    name: `Expand project ${fixture.name}`,
  });
  const entry = page.getByText(environmentName, { exact: true }).first();
  await expect(expand.or(entry)).toBeVisible({ timeout: 60_000 });
  for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.isVisible()) await button.click();
  }
  if (await expand.isVisible()) await expand.click();
  await page.mouse.move(1100, 20);
  await entry.click({ timeout: 15_000 });
}

async function cheapModel(invoke: Invoke, environmentId: string, platform: string) {
  const catalog = await invoke<Array<{ platform: string; id: string; label: string }>>(
    "get_native_agent_model_catalog",
    { environmentId },
  );
  return catalog.find(
    (entry) =>
      entry.platform === platform &&
      (platform === "codex" ? /luna/i : /haiku/i).test(`${entry.id} ${entry.label}`),
  )?.id;
}

test.describe("live cold restart", () => {
  test.skip(
    !LIVE_OPT_IN,
    "opt-in live turns and profile restarts; set ORKESTRATOR_AGENT_TEST_LIVE_COLD_RESTART=1",
  );

  test("a native conversation's display tail paints after idle and crash restarts and reconciles", async ({
    page,
  }) => {
    test.setTimeout(3 * TURN_TIMEOUT_MS);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    let { status, invoke, fixture } = await connect(page);
    const environments: Environment[] = [];
    let passed = false;
    try {
      const environment = await createEnvironment(invoke, fixture, "cold-native");
      environments.push(environment);
      const short = new Trail(SHORT_STOPS);
      const long = new Trail(LONG_STOPS);
      await short.write(environment.worktreePath!);
      await long.write(environment.worktreePath!);
      const model = NATIVE_MODEL ?? (await cheapModel(invoke, environment.id, NATIVE_PLATFORM));
      note("native-model", `${NATIVE_PLATFORM} ${model ?? "provider default"}`);
      const tabId = "cold-native-tab";
      const identity = {
        environmentId: environment.id,
        agent: NATIVE_PLATFORM,
        logicalSessionKey: `env-${environment.id}:${tabId}`,
      };
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "cold-pane",
          root: {
            kind: "leaf",
            id: "cold-pane",
            activeTabId: tabId,
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                displayTitle: "Cold restart qualification",
                nativeAgentData: {
                  environmentId: environment.id,
                  platform: NATIVE_PLATFORM,
                  isLocal: true,
                },
                ...(model ? { initialAgentModel: model } : {}),
              },
            ],
          },
        },
      });

      const transcript = (args: { knownToken?: string; forceSnapshot?: boolean } = {}) =>
        invoke<NativeAgentTranscriptUpdate<Row>>("get_native_agent_transcript_update", {
          ...identity,
          viewVersion: 1,
          liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
          ...args,
        });
      /** The provider's rows, read through the authoritative path. */
      const authoritative = async (): Promise<Row[]> => {
        const update = await transcript({ forceSnapshot: true });
        expect(update.status, "a forced read answers a snapshot").toBe("snapshot");
        if (update.status !== "snapshot") return [];
        return update.value.messages;
      };
      const projection = () =>
        invoke<ProjectionUpdate>("get_native_agent_projection_update", {
          ...identity,
          syncVersion: 1,
          liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
          forceSnapshot: true,
        });
      const phase = async () => (await projection()).projection?.turn.phase;
      const waitForIdle = async () => {
        await page.waitForTimeout(3_000);
        await expect
          .poll(
            async () => {
              const turn = (await projection()).projection?.turn;
              if (turn?.phase === "error") {
                throw new Error(`${NATIVE_LABEL} turn failed: ${turn.error ?? "no error"}`);
              }
              return turn?.phase;
            },
            { timeout: TURN_TIMEOUT_MS, intervals: [5_000] },
          )
          .toBe("idle");
      };
      /** The first read after a restart, with no token: the persisted tail when one exists. */
      const coldRead = async (label: string) => {
        const first = await transcript();
        expect(first.status, `${label}: the first read after a restart`).toBe("snapshot");
        if (first.status !== "snapshot") throw new Error("unreachable");
        return { view: first.value, token: first.token };
      };
      /**
       * Keeps reading the way a mounted tab does, with the token it holds and
       * never forcing, applying each delta, and returns the view it ends with.
       * The caller compares that view with a forced provider read: `unchanged`
       * is only right when the held view already is the provider's.
       */
      const followAsClient = async (
        label: string,
        start: { view: NativeAgentTranscriptView<Row>; token: string },
      ) => {
        let { view, token } = start;
        const answers: string[] = [];
        for (let read = 0; read < 20; read += 1) {
          const update = await transcript({ knownToken: token });
          answers.push(update.status);
          if (update.status === "snapshot") {
            view = update.value;
            token = update.token;
          } else if (update.status === "delta") {
            expect(update.baseToken, `${label}: a delta for a token we do not hold`).toBe(token);
            const next = applyNativeAgentTranscriptDelta(view, update.delta);
            expect(next, `${label}: the delta does not apply to the held view`).not.toBeNull();
            view = next!;
            token = update.token;
          }
          await page.waitForTimeout(1_500);
        }
        note(`${label}-client`, {
          answers: answers.join(","),
          freshness: view.freshness,
          rows: view.messages.length,
        });
        return view;
      };
      const composeBar = page.getByTestId("shared-native-compose-bar");
      const composer = composeBar.getByRole("textbox", {
        name: new RegExp(`^Message ${NATIVE_LABEL}`),
      });
      const send = async (prompt: string) => {
        await expect(composer).toBeVisible({ timeout: 90_000 });
        await composer.fill(prompt);
        await expect(composeBar.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
          timeout: 90_000,
        });
        const sentAt = Date.now();
        await composer.press("Enter");
        await expect(composer).toHaveText("", { timeout: 30_000 });
        return sentAt;
      };
      /** The browser shows each prompt and the short trail's closing word once. */
      /**
       * Walks the whole rendered transcript, top to bottom, and checks each
       * prompt tag and closing word sits in exactly one row. The list is
       * virtualized, so rows are collected by index while scrolling with the
       * wheel (a programmatic scroll is not user intent: the list snaps back).
       */
      const expectBrowserOnce = async (label: string, tags: string[], closingWords: string[]) => {
        const needles = [...tags, ...closingWords];
        const list = page.locator("[data-virtuoso-scroller]").filter({ visible: true }).first();
        await expect(list).toBeVisible({ timeout: 60_000 });
        const box = await list.boundingBox();
        if (!box) throw new Error("the transcript list is not laid out");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await expect
          .poll(
            async () => {
              for (let step = 0; step < 5; step += 1) await page.mouse.wheel(0, -4_000);
              await page.waitForTimeout(150);
              return list.evaluate((element) => Math.round(element.scrollTop));
            },
            { timeout: 60_000, intervals: [250] },
          )
          .toBe(0);
        const rowsWith = new Map<string, Set<string>>(needles.map((needle) => [needle, new Set()]));
        let previousTop = -1;
        for (let step = 0; step < 400; step += 1) {
          const seen = await list.evaluate((element, wanted) => {
            const found: Array<[string, string]> = [];
            for (const row of element.querySelectorAll<HTMLElement>("[data-chat-message-index]")) {
              const text = row.textContent ?? "";
              for (const needle of wanted) {
                if (text.includes(needle)) found.push([needle, row.dataset.chatMessageIndex ?? ""]);
              }
            }
            return {
              found,
              top: Math.round(element.scrollTop),
              bottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
            };
          }, needles);
          for (const [needle, index] of seen.found) rowsWith.get(needle)!.add(index);
          if (seen.bottom && seen.top === previousTop) break;
          previousTop = seen.top;
          await page.mouse.wheel(0, Math.max(200, Math.round(box.height / 2)));
          await page.waitForTimeout(120);
        }
        const counts = Object.fromEntries(
          needles.map((needle, index) => [
            index < tags.length ? `prompt${index + 1}` : `closing${index - tags.length + 1}`,
            rowsWith.get(needle)!.size,
          ]),
        );
        note(`${label}-browser-rows`, counts);
        for (const [name, count] of Object.entries(counts)) {
          expect(count, `${label}: ${name} is missing or shown in more than one row`).toBe(1);
        }
      };

      // --- Idle restart ---------------------------------------------------
      await openApp(page, status, fixture, environment.name);
      await send(short.prompt(NATIVE_PLATFORM));
      await waitForIdle();
      const beforeIdle = await authoritative();
      expect(short.reachedEnd(beforeIdle), `${NATIVE_LABEL} never finished the short trail`).toBe(
        true,
      );
      expectUniqueIds(beforeIdle, "before the idle restart");
      await expectBrowserOnce("before the idle restart", [short.tag], [short.closingWord]);
      // Let the debounced checkpoint land on its own as well; a graceful stop
      // also drains it, which is what this half qualifies.
      await page.waitForTimeout(3_000);
      const idleRestart = await restartProfile("graceful");
      ({ status, invoke, fixture } = await connect(page));
      const idleCold = await coldRead("idle");
      note("idle-cold-read", {
        restartMs: idleRestart.ms,
        freshness: idleCold.view.freshness,
        cachedRows: idleCold.view.messages.length,
        rowsBefore: beforeIdle.length,
      });
      expect(
        idleCold.view.freshness,
        "the first read after a restart paints the persisted tail",
      ).toBe("cached");
      expect(
        rowIds(idleCold.view.messages),
        "the persisted tail is exactly the idle transcript",
      ).toEqual(rowIds(beforeIdle));
      expect(sameDisplayedRows(idleCold.view.messages, beforeIdle), "cached idle content").toBe(
        true,
      );
      const idleClient = await followAsClient("idle", idleCold);
      const afterIdle = await authoritative();
      note("idle-reconciled", {
        rows: afterIdle.length,
        idsKept: missingIds(beforeIdle, afterIdle).length === 0,
        rowsWithNewIds: missingIds(beforeIdle, afterIdle).length,
      });
      expectUniqueIds(afterIdle, "after the idle restart");
      expect(duplicatedContent(beforeIdle, afterIdle), "duplicated idle replay content").toEqual({
        replies: 0,
        tools: 0,
      });
      expect(repeatedPrompts(afterIdle), "a prompt appears twice after the idle restart").toBe(0);
      expect(
        lostContent(beforeIdle, afterIdle, [short]),
        "content lost across the idle restart",
      ).toEqual({ prompts: 0, stops: 0, replies: 0 });
      expect(
        lostContent(afterIdle, beforeIdle, [short]),
        "content appeared across the idle restart",
      ).toEqual({ prompts: 0, stops: 0, replies: 0 });
      expect(
        rowIds(idleClient.messages),
        "the client kept a stale view instead of the provider's rows",
      ).toEqual(rowIds(afterIdle));
      expect(
        sameDisplayedRows(idleClient.messages, afterIdle),
        "the client retained stale displayed content or parts",
      ).toBe(true);
      await openApp(page, status, fixture, environment.name);
      await expectBrowserOnce("after the idle restart", [short.tag], [short.closingWord]);
      await page.reload();
      await openApp(page, status, fixture, environment.name);
      await expectBrowserOnce("after a reload", [short.tag], [short.closingWord]);

      // --- Crash mid-turn -------------------------------------------------
      const promptSentAt = await send(long.prompt(NATIVE_PLATFORM));
      let midTurn: Row[] = [];
      await expect
        .poll(
          async () => {
            midTurn = await authoritative();
            return long.verifyOrder(midTurn, "mid-turn").highest;
          },
          { timeout: TURN_TIMEOUT_MS, intervals: [3_000] },
        )
        .toBeGreaterThanOrEqual(STOPS_BEFORE_RESTART);
      expect(await phase(), "the long turn must still be running").toBe("running");
      // Keep streaming past the checkpoint age bound, so the prompt (and some
      // rows) must already be in the persisted tail when the backend dies.
      await page.waitForTimeout(CHECKPOINT_AGE_MARGIN_MS);
      midTurn = await authoritative();
      const highestBefore = long.verifyOrder(midTurn, "before the crash").highest;
      expect(await phase(), "the long turn must still be running at the crash").toBe("running");
      const crash = await restartProfile("crash");
      ({ status, invoke, fixture } = await connect(page));
      const crashCold = await coldRead("crash");
      const cachedRows = crashCold.view.messages;
      note("crash-cold-read", {
        restartMs: crash.ms,
        msFromPromptSendToKill: crash.killedAt! - promptSentAt,
        freshness: crashCold.view.freshness,
        cachedRows: cachedRows.length,
        rowsBeforeCrash: midTurn.length,
        rowsBeforeCrashNotCached: missingIds(midTurn, cachedRows).length,
        cachedRowsNotBeforeCrash: missingIds(cachedRows, midTurn).length,
        highestStopBeforeCrash: highestBefore,
        highestStopCached: long.verifyOrder(cachedRows, "cached tail").highest,
      });
      expect(crashCold.view.freshness).toBe("cached");
      expectUniqueIds(cachedRows, "cached tail after the crash");
      expect(long.promptRows(cachedRows), "the persisted tail holds the long prompt").toBe(1);
      // The turn must settle: a cached tail never implies a live turn.
      const phasesSeen: string[] = [];
      let settledPhase: string | undefined;
      await expect
        .poll(
          async () => {
            settledPhase = await phase();
            if (phasesSeen.at(-1) !== settledPhase) phasesSeen.push(settledPhase ?? "none");
            return settledPhase === "idle" || settledPhase === "error";
          },
          { timeout: TURN_TIMEOUT_MS, intervals: [3_000] },
        )
        .toBe(true);
      const crashClient = await followAsClient("crash", crashCold);
      const afterCrash = await authoritative();
      expect(
        lostContent(cachedRows, afterCrash, [short, long]),
        "cached content absent from provider",
      ).toEqual({ prompts: 0, stops: 0, replies: 0 });
      expect(duplicatedContent(midTurn, afterCrash), "duplicated crash replay content").toEqual({
        replies: 0,
        tools: 0,
      });
      const lost = lostContent(midTurn, afterCrash, [short, long]);
      note("crash-reconciled", {
        phases: phasesSeen.join(">"),
        rows: afterCrash.length,
        idsKept: missingIds(midTurn, afterCrash).length === 0,
        rowsBeforeCrashWithNewIds: missingIds(midTurn, afterCrash).length,
        clientRowsUnknownToProvider: missingIds(crashClient.messages, afterCrash).length,
        highestStop: long.verifyOrder(afterCrash, "after the crash").highest,
        lost,
      });
      expectUniqueIds(afterCrash, "after the crash");
      expect(long.promptRows(afterCrash), "the long prompt after the crash").toBe(1);
      expect(short.promptRows(afterCrash), "the short prompt after the crash").toBe(1);
      expect(repeatedPrompts(afterCrash), "a prompt appears twice after the crash").toBe(0);
      expect(lost, "content from before the crash was lost").toEqual({
        prompts: 0,
        stops: 0,
        replies: 0,
      });
      expect(
        rowIds(crashClient.messages),
        "the client kept a stale view instead of the provider's rows",
      ).toEqual(rowIds(afterCrash));
      expect(
        sameDisplayedRows(crashClient.messages, afterCrash),
        "the client retained stale displayed content or parts",
      ).toBe(true);
      await openApp(page, status, fixture, environment.name);
      await expectBrowserOnce("after the crash", [short.tag, long.tag], [short.closingWord]);
      // The tab must be usable again: finish the trail.
      await send(
        "Continue following the trail from the last file you read, one file per step, until it ends. Then reply with only the closing word.",
      );
      await waitForIdle();
      const finished = await authoritative();
      expectUniqueIds(finished, "after the follow-up");
      expect(
        duplicatedContent(afterCrash, finished),
        "duplicated replay before the follow-up",
      ).toEqual({ replies: 0, tools: 0 });
      expect(long.reachedEnd(finished), `${NATIVE_LABEL} never finished the long trail`).toBe(true);
      expect(long.verifyOrder(finished, "after the follow-up").highest).toBe(long.stops);
      expect(long.promptRows(finished)).toBe(1);
      expect(short.promptRows(finished)).toBe(1);
      await page.reload();
      await openApp(page, status, fixture, environment.name);
      await expectBrowserOnce(
        "after the follow-up",
        [short.tag, long.tag],
        [short.closingWord, long.closingWord],
      );
      passed = true;
    } finally {
      if (passed || !KEEP_ON_FAILURE) await removeEnvironments(invoke, environments);
    }
  });

  test("build-pipeline histories reconcile after mid-dispatch, mid-turn and idle restarts", async ({
    page,
  }) => {
    test.setTimeout(4 * TURN_TIMEOUT_MS);
    page.setDefaultTimeout(15_000);
    let { invoke, fixture } = await connect(page);
    const environments: Environment[] = [];
    const pipelineIds: string[] = [];
    let passed = false;
    try {
      const dispatchEnv = await createEnvironment(invoke, fixture, "cold-dispatch");
      const turnEnv = await createEnvironment(invoke, fixture, "cold-turn");
      environments.push(dispatchEnv, turnEnv);
      const model = BUILD_MODEL ?? (await cheapModel(invoke, dispatchEnv.id, "codex"));
      note("build-model", `codex ${model ?? "provider default"}`);

      const read = async (pipelineId: string) =>
        (
          await invoke<{ snapshot: BuildPipeline; revision: number }>("get_build_pipeline", {
            pipelineId,
          })
        ).snapshot;
      /** The committed history of every stage session, as viewers read it. */
      const committed = async (pipelineId: string): Promise<Map<string, Row[]>> => {
        const histories = new Map<string, Row[]>();
        for (let pass = 0; pass < 10; pass += 1) {
          const result = await invoke<PipelineRead>("get_build_pipeline", {
            pipelineId,
            knownSessions: {},
          });
          expect(result.unchanged).toBe(false);
          if (result.unchanged) break;
          let deferred = false;
          for (const patch of result.messagePatches) {
            expect(
              patch.unavailable,
              `${patch.sessionKey}: stored history unavailable`,
            ).toBeUndefined();
            if (patch.deferred) {
              deferred = true;
              continue;
            }
            expect(patch.startIndex).toBe(0);
            histories.set(patch.sessionKey, patch.messages);
          }
          if (!deferred) break;
        }
        return histories;
      };
      const start = async (environment: Environment, trail: Trail) => {
        const pipeline = await invoke<BuildPipeline>("start_build_pipeline", {
          taskId: `qa-cold-${environment.id}`,
          projectId: fixture.id,
          existingEnvironmentId: environment.id,
          environmentType: "local",
          agentType: "codex",
          steps: {
            build: {
              agent: "codex",
              ...(model ? { model } : {}),
              reasoningEffort: "low",
            },
          },
          taskTitle: "Cold restart qualification",
          taskSnapshot: {
            title: "Cold restart qualification",
            description: trail.prompt("codex"),
            acceptanceCriteria: "The closing word of the trail is reported.",
            comments: [],
            images: [],
          },
        });
        pipelineIds.push(pipeline.id);
        return pipeline.id;
      };
      const buildSession = (pipeline: BuildPipeline) =>
        pipeline.sessions.find((session) => session.phase === "build");
      /**
       * Waits until the build turn has finished the trail and gone idle. The
       * stage then asks the same session for review-preparation metadata,
       * which this qualification does not need, so the caller cancels.
       */
      const waitForBuild = async (pipelineId: string) => {
        let pipeline: BuildPipeline | undefined;
        let rows: Row[] = [];
        await expect
          .poll(
            async () => {
              pipeline = await read(pipelineId);
              if (pipeline.phase === "failed") {
                throw new Error(`build failed: ${pipeline.error ?? "no error"}`);
              }
              const session = buildSession(pipeline);
              if (!session) return false;
              rows = (await committed(pipelineId)).get(session.sessionKey) ?? [];
              return session.status === "idle" || pipeline.phase !== "building"
                ? rows.some(
                    (row) => row.role === "assistant" && /TRAILEND[0-9A-F]{6}/.test(rowText(row)),
                  )
                : false;
            },
            { timeout: TURN_TIMEOUT_MS, intervals: [5_000] },
          )
          .toBe(true);
        return { pipeline: pipeline!, rows };
      };
      const restartRows = (rows: Row[]) =>
        rows.filter((row) => row.role === "user" && rowText(row).startsWith(RESTART_CONTINUATION))
          .length;

      // --- Mid-dispatch crash --------------------------------------------
      // This live window may include provider acceptance while profile metadata
      // is read. The deterministic pre-acceptance SIGKILL boundary and same-id
      // retry live in build-pipeline-service-recovery.test.ts (held send).
      const dispatchTrail = new Trail(SHORT_STOPS);
      await dispatchTrail.write(dispatchEnv.worktreePath!);
      const dispatchId = await start(dispatchEnv, dispatchTrail);
      let journaled: BuildPipeline | undefined;
      await expect
        .poll(
          async () => {
            journaled = await read(dispatchId);
            if (journaled.phase === "failed") throw new Error("build failed before dispatch");
            return Boolean(journaled.pendingPromptAttempt && buildSession(journaled));
          },
          { timeout: 180_000, intervals: [100] },
        )
        .toBe(true);
      const atCrash = buildSession(journaled!)!;
      const dispatchRestart = await restartProfile("crash");
      ({ invoke, fixture } = await connect(page));
      const resumed = await read(dispatchId);
      note("dispatch-crash", {
        restartMs: dispatchRestart.ms,
        sessionStatusAtCrash: atCrash.status,
        phaseAfterRestart: resumed.phase,
        pendingAfterRestart: Boolean(resumed.pendingPromptAttempt),
      });
      const dispatchDone = await waitForBuild(dispatchId);
      await invoke("cancel_build_pipeline", { pipelineId: dispatchId });
      const dispatchSession = buildSession(dispatchDone.pipeline)!;
      expect(dispatchSession.sdkSessionId, "the build stage moved to a new session").toBe(
        atCrash.sdkSessionId,
      );
      const dispatchRows = (await committed(dispatchId)).get(dispatchSession.sessionKey) ?? [];
      note("dispatch-history", {
        rows: dispatchRows.length,
        taskPrompts: dispatchTrail.promptRows(dispatchRows),
        repeatedPrompts: repeatedPrompts(dispatchRows),
        restartContinuations: restartRows(dispatchRows),
        restartContinuationSent: dispatchSession.restartContinuationSent === true,
      });
      expectUniqueIds(dispatchRows, "mid-dispatch history");
      expect(
        dispatchTrail.promptRows(dispatchRows),
        "the task prompt reached the provider",
      ).toBeGreaterThan(0);
      expect(repeatedPrompts(dispatchRows), "a prompt reached the provider twice").toBe(0);
      expect(restartRows(dispatchRows)).toBe(dispatchSession.restartContinuationSent ? 1 : 0);
      expect(dispatchTrail.reachedEnd(dispatchRows), "the build never finished the trail").toBe(
        true,
      );
      expect(dispatchTrail.verifyOrder(dispatchRows, "mid-dispatch").highest).toBe(
        dispatchTrail.stops,
      );

      // --- Mid-turn restart ----------------------------------------------
      const turnTrail = new Trail(LONG_STOPS);
      await turnTrail.write(turnEnv.worktreePath!);
      const turnId = await start(turnEnv, turnTrail);
      let beforeTurnRestart: Row[] = [];
      let runningSession: BuildPipeline["sessions"][number] | undefined;
      await expect
        .poll(
          async () => {
            const pipeline = await read(turnId);
            if (pipeline.phase === "failed") throw new Error("build failed before the restart");
            runningSession = buildSession(pipeline);
            if (!runningSession || runningSession.status !== "running") return 0;
            beforeTurnRestart = (await committed(turnId)).get(runningSession.sessionKey) ?? [];
            return turnTrail.verifyOrder(beforeTurnRestart, "committed mid-turn").highest;
          },
          { timeout: TURN_TIMEOUT_MS, intervals: [3_000] },
        )
        .toBeGreaterThanOrEqual(STOPS_BEFORE_RESTART);
      // One more persist boundary, then take the committed copy the restart must keep.
      await page.waitForTimeout(PERSIST_BOUNDARY_MARGIN_MS);
      beforeTurnRestart = (await committed(turnId)).get(runningSession!.sessionKey) ?? [];
      const pipelineBefore = await read(turnId);
      expect(buildSession(pipelineBefore)?.status, "the build turn must still be running").toBe(
        "running",
      );
      const turnRestart = await restartProfile("graceful");
      ({ invoke, fixture } = await connect(page));
      // Viewers read the committed copy, which needs no provider.
      const straightAfter = (await committed(turnId)).get(runningSession!.sessionKey) ?? [];
      note("turn-restart", {
        restartMs: turnRestart.ms,
        committedRowsBefore: beforeTurnRestart.length,
        committedRowsStraightAfter: straightAfter.length,
        highestStopBefore: turnTrail.verifyOrder(beforeTurnRestart, "before").highest,
        // Codex re-keys replayed rows, and the supervisor may already have
        // committed the replay; content is what must survive.
        idsKept: missingIds(beforeTurnRestart, straightAfter).length === 0,
      });
      expect(
        lostContent(beforeTurnRestart, straightAfter, [turnTrail]),
        "committed content was lost across the restart",
      ).toEqual({ prompts: 0, stops: 0, replies: 0 });
      expectUniqueIds(straightAfter, "committed history straight after the restart");
      expect(
        duplicatedContent(beforeTurnRestart, straightAfter),
        "duplicated committed replay",
      ).toEqual({ replies: 0, tools: 0 });
      const turnDone = await waitForBuild(turnId);
      await invoke("cancel_build_pipeline", { pipelineId: turnId });
      const turnSession = buildSession(turnDone.pipeline)!;
      expect(turnSession.sdkSessionId, "the build stage moved to a new session").toBe(
        runningSession!.sdkSessionId,
      );
      const turnRows = (await committed(turnId)).get(turnSession.sessionKey) ?? [];
      expect(
        duplicatedContent(beforeTurnRestart, turnRows),
        "duplicated content after continuation",
      ).toEqual({ replies: 0, tools: 0 });
      note("turn-history", {
        rows: turnRows.length,
        taskPrompts: turnTrail.promptRows(turnRows),
        repeatedPrompts: repeatedPrompts(turnRows),
        restartContinuations: restartRows(turnRows),
        restartContinuationSent: turnSession.restartContinuationSent === true,
        lostBeforeRestart: lostContent(beforeTurnRestart, turnRows, [turnTrail]),
      });
      expectUniqueIds(turnRows, "mid-turn history");
      expect(
        turnTrail.promptRows(turnRows),
        "the task prompt reached the provider",
      ).toBeGreaterThan(0);
      expect(repeatedPrompts(turnRows), "a prompt reached the provider twice").toBe(0);
      expect(restartRows(turnRows), "the restart continuation was sent at most once").toBe(
        turnSession.restartContinuationSent ? 1 : 0,
      );
      expect(
        lostContent(beforeTurnRestart, turnRows, [turnTrail]),
        "content committed before the restart is gone from the final history",
      ).toEqual({ prompts: 0, stops: 0, replies: 0 });
      expect(turnTrail.reachedEnd(turnRows), "the build never finished the trail").toBe(true);
      expect(turnTrail.verifyOrder(turnRows, "mid-turn").highest).toBe(turnTrail.stops);

      // --- Idle restart: every stage history comes back identical ---------
      for (const id of pipelineIds) {
        await expect
          .poll(async () => (await read(id)).phase, { timeout: 120_000 })
          .toMatch(/^(failed|complete|paused)$/);
      }
      const settled = new Map<string, string>();
      for (const id of pipelineIds) {
        for (const [key, rows] of await committed(id)) {
          settled.set(`${id}:${key}`, JSON.stringify(rows));
        }
      }
      const idleRestart = await restartProfile("graceful");
      ({ invoke, fixture } = await connect(page));
      const reloaded = new Map<string, string>();
      for (const id of pipelineIds) {
        for (const [key, rows] of await committed(id)) {
          reloaded.set(`${id}:${key}`, JSON.stringify(rows));
        }
      }
      note("idle-pipeline-restart", {
        restartMs: idleRestart.ms,
        sessions: settled.size,
        identical: [...settled].filter(([key, body]) => reloaded.get(key) === body).length,
      });
      expect([...reloaded.keys()].sort()).toEqual([...settled.keys()].sort());
      for (const [key, body] of settled) {
        expect(reloaded.get(key), `${key}: history changed across an idle restart`).toBe(body);
      }
      passed = true;
    } finally {
      if (passed || !KEEP_ON_FAILURE) {
        for (const pipelineId of pipelineIds) {
          await invoke("cancel_build_pipeline", { pipelineId }).catch(() => undefined);
          await invoke("delete_build_pipeline", { pipelineId }).catch(() => undefined);
        }
        await removeEnvironments(invoke, environments);
      }
    }
  });
});
