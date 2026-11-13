/**
 * The E10 baseline (efficiency report parts 0160, 0180 and 0190) on a real
 * `dev:test --fixture` profile, with no billed turn.
 *
 * Opt-in only (`ORKESTRATOR_AGENT_TEST_E10_BASELINE=1`). Start the profile
 * without host credentials, for Claude:
 *
 *   mise run dev:test --profile e10-baseline --fixture --headless-electron \
 *     --no-agent-credentials --agent-platforms claude,pi
 *
 * The spec points the profile's own Claude CLI (its isolated
 * `CLAUDE_CONFIG_DIR`) at a loopback model endpoint that streams a scripted
 * turn (`conditional-reads-fake-model.ts`), and puts a `bun` wrapper in the
 * profile's own toolchain directory that loads a request counter into every
 * bridge it starts (`conditional-reads-bridge-counter.ts`). Everything else is
 * the real stack: renderer, gateway, backend, Claude bridge and CLI. Both
 * files are removed again at the end.
 *
 * Measured while the turn streams, with one visible viewer and then two, and
 * once the turn is idle: the renderer's answers by outcome (0160), the
 * bridge's requests per state poll by route (0180), and the bridge's
 * transcript reads with what a delta would have carried (0190). Output is
 * counts, bytes and milliseconds in
 * `output/agent-testing/<run id>/conditional-reads.json`; no prompt, row
 * content, token or session id is written.
 *
 * `E10_SCENARIO` picks the scripted turn (default `baseline`):
 *
 * - `large-window`: 26 rounds of 30 KB each, measured once ten rounds have
 *   streamed, so the bridge's window sits near its 512 KiB bound (to-do 6680,
 *   retired, task 1).
 * - `trimmed-head`: one response that streams 20 KB a second for 150 s,
 *   measured once it is past 600,000 characters, so the head row alone is over
 *   the window and is part-trimmed. Recovery reads (`/messages`) are counted
 *   per window and over the whole turn, and the first viewer is captured to
 *   `output/visual-previews/` while it streams (to-do 6260, retired, task 3; follow-up 7845, retired).
 *
 * `E10_READY_CHARS` moves the trimmed head's measuring point.
 *
 * `E10_PLATFORM=codex` runs the same scenario on the profile's pinned Codex
 * instead (start the profile with `--agent-platforms claude,codex`). The spec
 * writes a made-up API key (`auth.json`) and an `openai_base_url` into the
 * profile's own Codex home (`<dataDir>/agent-credentials/codex`, never the
 * host's), pointing it at `conditional-reads-codex-model.ts`, a loopback
 * Responses WebSocket, and restores both files at the end.
 *
 * Those two write `conditional-reads-<scenario>.json` and add a `turn` block:
 * the bridge totals from the turn starting to it going idle.
 */
import { expect, test, fetchModulesOutsideChromium, type Page, type Request } from "./browser-test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  summarizeCounters,
  assertWindowEvidence,
  withCleanup,
} from "./conditional-reads-measurement";
import type { CounterFile } from "./conditional-reads-bridge-counter";
import {
  startFakeModel,
  type FakeModel,
  type FakeModelOptions,
} from "./conditional-reads-fake-model";
import { snapshotFixtureFiles } from "./codex-fixture-files";

type Status = {
  status: string;
  profile?: string;
  browserUrl?: string;
  testProject?: string;
  dataDir?: string;
  pids?: { backend?: number };
};
type Project = { id: string; localPath: string | null; name: string };
type Environment = { id: string; name: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Answer = {
  at: number;
  viewer: string;
  command: string;
  transcript?: string;
  state?: string;
  bytes: number;
  ms: number;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "e10-baseline";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_E10_BASELINE === "1";
const WINDOW_MS = Number(process.env.E10_WINDOW_MS ?? 20_000);
const IDLE_WINDOW_MS = Number(process.env.E10_IDLE_WINDOW_MS ?? 30_000);
const TAB_ID = "e10-tab";
const MARKER = "E10-BASELINE-TURN";

type Scenario = "baseline" | "large-window" | "trimmed-head";
const SCENARIO = (process.env.E10_SCENARIO ?? "baseline") as Scenario;
/** The scripted turn, and when its measured state is reached. */
const SCENARIOS: Record<
  Scenario,
  {
    rounds: number;
    responseMs: number;
    deltaChars: number;
    readyCalls?: number;
    readyChars?: number;
  }
> = {
  baseline: { rounds: 18, responseMs: 5_000, deltaChars: 120 },
  "large-window": { rounds: 26, responseMs: 5_000, deltaChars: 600, readyCalls: 10 },
  "trimmed-head": { rounds: 1, responseMs: 150_000, deltaChars: 2_000, readyChars: 600_000 },
};
const PLATFORM = process.env.E10_PLATFORM === "codex" ? "codex" : "claude";
const scripted = {
  ...SCENARIOS[SCENARIO],
  // Start measuring later in the trimmed head, to separate row size from viewers.
  ...(process.env.E10_READY_CHARS ? { readyChars: Number(process.env.E10_READY_CHARS) } : {}),
};
const resultFile = `conditional-reads${PLATFORM === "codex" ? "-codex" : ""}${
  SCENARIO === "baseline" ? "" : `-${SCENARIO}`
}.json`;

/**
 * `conditional-reads-codex-model.ts` under Bun (specs run under Node, which
 * has no WebSocket server), with the same progress counters as the Claude
 * model.
 */
async function startCodexModel(options: FakeModelOptions): Promise<FakeModel> {
  const child = spawn(
    "bun",
    [
      path.join(import.meta.dirname, "conditional-reads-codex-model.ts"),
      String(options.rounds),
      String(options.responseMs),
      String(options.deltaMs),
      String(options.deltaChars),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let rounds = 0;
  let streamed = 0;
  const lines = createInterface({ input: child.stdout! });
  const origin = await new Promise<string>((resolve, reject) => {
    child.once("exit", () => reject(new Error("the Codex loopback model exited")));
    lines.on("line", (line) => {
      if (line.startsWith("http://")) resolve(line);
      else if (line.startsWith("round ")) rounds = Number(line.slice(6));
      else if (line.startsWith("streamed ")) streamed = Number(line.slice(9));
    });
  });
  return {
    origin,
    conversationCalls: () => rounds,
    streamedChars: () => streamed,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    },
  };
}
const outputDirectory = path.join(repositoryRoot, "output", "agent-testing", runId);
const counterDirectory = path.join(outputDirectory, "bridge-counters");

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const status = JSON.parse(command.stdout) as Status;
  expect(status.profile).toBe(profile);
  expect(status.status).toBe("ready");
  return status;
}

async function signIn(page: Page, status: Status): Promise<Invoke> {
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error("dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const answer = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command: name, args } },
    );
    expect(answer.ok(), `${name} failed with HTTP ${answer.status()}`).toBe(true);
    return ((await answer.json()) as { result: T }).result;
  };
}

/** The profile backend's own toolchain directory, from its command line. */
function toolchainBinDir(status: Status): string {
  const argv = readFileSync(`/proc/${status.pids!.backend}/cmdline`, "utf8").split("\0");
  const directory = argv[argv.indexOf("--toolchain-bin-dir") + 1];
  if (!directory?.startsWith(status.dataDir!)) throw new Error("toolchain is not the profile's");
  return directory;
}

/** Counter files of bridges an earlier run started; they keep writing while they live. */
const earlierBridges = new Set<string>();

/** Exact head-row recovery reads: the legacy whole-transcript route. */
function recoveryReads(bridge: ReturnType<typeof readCounters>): number {
  return Object.entries(bridge.routes)
    .filter(([label]) => label.startsWith("GET /session/:id/messages"))
    .reduce((total, [, value]) => total + value.count, 0);
}

function readCounters(from: number, to: number) {
  const files = existsSync(counterDirectory)
    ? readdirSync(counterDirectory)
        .filter((name) => name.endsWith(".json") && !earlierBridges.has(name))
        .map(
          (name) =>
            JSON.parse(readFileSync(path.join(counterDirectory, name), "utf8")) as CounterFile,
        )
    : [];
  return summarizeCounters(files, from, to);
}

/** Every native-session answer a page receives: command, outcome and size only. */
function recordAnswers(page: Page, viewer: string, answers: Answer[]): void {
  page.on("requestfinished", (request: Request) => {
    const at = Date.now();
    void (async () => {
      if (!request.url().endsWith("/__orkestrator/invoke")) return;
      let command: string | undefined;
      try {
        command = (request.postDataJSON() as { command?: string }).command;
      } catch {
        return;
      }
      if (!command?.startsWith("get_native_agent_")) return;
      const response = await request.response();
      if (!response) return;
      const text = await response.text().catch(() => "");
      let transcript: string | undefined;
      let state: string | undefined;
      try {
        const result = (JSON.parse(text) as { result?: Record<string, unknown> }).result ?? {};
        const read = (value: unknown) =>
          value && typeof value === "object"
            ? String((value as { status?: unknown }).status)
            : undefined;
        if (command === "get_native_agent_live_update") {
          transcript = read(result.transcript);
          state = read(result.state);
        } else if (command === "get_native_agent_transcript_update") transcript = read(result);
        else if (command === "get_native_agent_session_state_update") state = read(result);
      } catch {
        // Size alone still counts.
      }
      const timing = request.timing();
      answers.push({
        at,
        viewer,
        command,
        transcript,
        state,
        bytes: Buffer.byteLength(text),
        ms: Math.round(timing.responseEnd),
      });
    })();
  });
}

function answersBetween(answers: Answer[], from: number, to: number) {
  const byViewer: Record<string, Record<string, number>> = {};
  const durations: Record<string, number[]> = {};
  for (const answer of answers) {
    if (answer.at < from || answer.at >= to) continue;
    (durations[answer.viewer] ??= []).push(answer.ms);
    const bucket = (byViewer[answer.viewer] ??= {});
    const key = (name: string) => (bucket[name] = (bucket[name] ?? 0) + 1);
    key(`command:${answer.command}`);
    if (answer.transcript) key(`transcript:${answer.transcript}`);
    if (answer.state) key(`state:${answer.state}`);
    bucket.bytes = (bucket.bytes ?? 0) + answer.bytes;
  }
  for (const [viewer, values] of Object.entries(durations)) {
    values.sort((a, b) => a - b);
    byViewer[viewer]!.p50Ms = values[Math.floor(values.length / 2)] ?? 0;
    byViewer[viewer]!.p90Ms = values[Math.floor(values.length * 0.9)] ?? 0;
  }
  return byViewer;
}

async function openViewer(page: Page, status: Status, fixture: Project, environment: Environment) {
  await page.goto(status.browserUrl!);
  const expand = page.getByRole("button", { name: `Expand project ${fixture.name}` });
  const entry = page.getByText(environment.name, { exact: true }).first();
  await expect(expand.or(entry)).toBeVisible({ timeout: 60_000 });
  // Startup notices arrive late: the profile has no Claude login (the CLI's
  // key is in its own settings) and no Docker for this run.
  const dismiss = page.getByRole("button", {
    name: /^Continue Without (Docker|GitHub CLI|Claude|Codex)$/,
  });
  const dockerNotice = page.getByRole("dialog").filter({
    has: page.getByRole("heading", {
      name: "Docker containers can't reach Orkestrator",
      exact: true,
    }),
  });
  await expect(async () => {
    if (await dockerNotice.isVisible()) {
      await dockerNotice.getByRole("button", { name: "Close", exact: true }).first().click();
    }
    if (await dismiss.first().isVisible()) await dismiss.first().click();
    if (await expand.isVisible()) await expand.click({ timeout: 1_000 });
    await page.mouse.move(1100, 20);
    await entry.click({ timeout: 1_000 });
  }).toPass({ timeout: 30_000, intervals: [500] });
  await expect(page.getByTestId("shared-native-compose-bar")).toBeVisible({ timeout: 90_000 });
}

async function turnPhase(invoke: Invoke, identity: Record<string, unknown>): Promise<string> {
  const update = await invoke<{ status: string; value?: { turn?: { phase?: string } } }>(
    "get_native_agent_session_state_update",
    { ...identity, viewVersion: 1, forceSnapshot: true },
  );
  return update.value?.turn?.phase ?? update.status;
}

test.describe("E10 baseline: conditional reads and deltas", () => {
  test.skip(!OPT_IN, "Set ORKESTRATOR_AGENT_TEST_E10_BASELINE=1 on a credential-free profile");

  test.skip(!(SCENARIO in SCENARIOS), "E10_SCENARIO is baseline, large-window or trimmed-head");

  test("a streaming turn against a loopback model", async ({ page, browser }) => {
    test.setTimeout(10 * 60_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const status = profileStatus();
    const claudeConfigDir = path.join(status.dataDir!, "agent-credentials", "claude");
    const settingsFile = path.join(claudeConfigDir, "settings.json");
    const codexHome = path.join(status.dataDir!, "agent-credentials", "codex");
    const codexFiles = [path.join(codexHome, "auth.json"), path.join(codexHome, "config.toml")];
    const wrapper = path.join(toolchainBinDir(status), "bun");
    if (PLATFORM === "claude") {
      expect(existsSync(settingsFile), "the profile already has Claude settings").toBe(false);
    } else {
      // A credential-free profile has no Codex login to overwrite.
      expect(existsSync(codexFiles[0]!), "the profile already has a Codex login").toBe(false);
    }
    expect(existsSync(wrapper), "the profile toolchain already has a bun").toBe(false);

    const realBun = execFileSync("mise", ["which", "bun"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    const results: Record<string, unknown> = {
      profile,
      platform: PLATFORM,
      scenario: SCENARIO,
      windowMs: WINDOW_MS,
      scripted,
    };
    let ownsSettings = false;
    let ownsWrapper = false;
    let restoreCodex: (() => void) | undefined;
    const model = await (PLATFORM === "codex" ? startCodexModel : startFakeModel)({
      marker: MARKER,
      rounds: Number(process.env.E10_ROUNDS ?? scripted.rounds),
      responseMs: scripted.responseMs,
      deltaMs: 100,
      deltaChars: scripted.deltaChars,
    });
    await withCleanup(
      async () => {
        rmSync(counterDirectory, { recursive: true, force: true });
        mkdirSync(counterDirectory, { recursive: true });
        // A bridge from an earlier run rewrites its file within a second.
        await page.waitForTimeout(1_500);
        for (const name of readdirSync(counterDirectory)) earlierBridges.add(name);
        if (PLATFORM === "codex") {
          mkdirSync(codexHome, { recursive: true });
          restoreCodex = snapshotFixtureFiles(codexFiles);
          writeFileSync(codexFiles[0]!, JSON.stringify({ OPENAI_API_KEY: "sk-e10-fixture-only" }), {
            mode: 0o600,
          });
          const earlier = existsSync(codexFiles[1]!)
            ? readFileSync(codexFiles[1]!, "utf8").replace(/^openai_base_url = .*\n/m, "")
            : "";
          // A top-level key goes before any table.
          writeFileSync(
            codexFiles[1]!,
            `openai_base_url = ${JSON.stringify(model.origin)}\n${earlier}`,
            { mode: 0o600 },
          );
        }
        if (PLATFORM === "claude") mkdirSync(claudeConfigDir, { recursive: true });
        ownsSettings = PLATFORM === "claude";
        if (ownsSettings)
          writeFileSync(
            settingsFile,
            JSON.stringify({
              env: {
                ANTHROPIC_BASE_URL: model.origin,
                ANTHROPIC_API_KEY: "sk-ant-e10-fixture-only",
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                DISABLE_AUTOUPDATER: "1",
              },
            }),
          );
        ownsWrapper = true;
        writeFileSync(
          wrapper,
          [
            "#!/bin/sh",
            `export E10_BRIDGE_COUNTER_DIR=${JSON.stringify(counterDirectory)}`,
            `exec ${JSON.stringify(realBun)} --preload ${JSON.stringify(path.join(import.meta.dirname, "conditional-reads-bridge-counter.ts"))} "$@"`,
            "",
          ].join("\n"),
          { mode: 0o755 },
        );

        const invoke = await signIn(page, status);
        const fixture = (await invoke<Project[]>("get_projects")).find(
          (project) => project.localPath === status.testProject,
        );
        expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
        const environment = await invoke<Environment>("create_environment", {
          projectId: fixture!.id,
          name: `e10-${Date.now()}`,
          environmentType: "local",
          networkAccessMode: "restricted",
        });
        await invoke("start_environment", { environmentId: environment.id });
        const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
          environmentId: environment.id,
        });
        await invoke("save_pane_layout", {
          environmentId: environment.id,
          expectedRevision: layout?.revision ?? 0,
          layout: {
            version: PANE_LAYOUT_VERSION,
            containerId: null,
            activePaneId: "e10-pane",
            root: {
              kind: "leaf",
              id: "e10-pane",
              activeTabId: TAB_ID,
              tabs: [
                {
                  id: TAB_ID,
                  type: "agent-native",
                  displayTitle: "E10 baseline",
                  nativeAgentData: {
                    environmentId: environment.id,
                    platform: PLATFORM,
                    isLocal: true,
                  },
                },
              ],
            },
          },
        });
        const identity = {
          environmentId: environment.id,
          agent: PLATFORM,
          logicalSessionKey: `env-${environment.id}:${TAB_ID}`,
        };
        const answers: Answer[] = [];
        recordAnswers(page, "first", answers);
        await openViewer(page, status, fixture!, environment);

        const composeBar = page.getByTestId("shared-native-compose-bar");
        const composer = composeBar.getByRole("textbox", {
          name: PLATFORM === "codex" ? /^Message Codex/ : /^Message Claude/,
        });
        await composer.fill(`${MARKER}: stream the scripted baseline turn.`);
        await composer.press("Enter");
        await expect.poll(() => model.conversationCalls(), { timeout: 120_000 }).toBeGreaterThan(0);
        await expect
          .poll(() => turnPhase(invoke, identity), { timeout: 60_000, intervals: [500] })
          .toBe("running");
        const turnFrom = Date.now();
        await page.waitForTimeout(5_000);
        if (scripted.readyCalls) {
          await expect
            .poll(() => model.conversationCalls(), { timeout: 5 * 60_000, intervals: [1_000] })
            .toBeGreaterThanOrEqual(scripted.readyCalls);
        }
        if (scripted.readyChars) {
          await expect
            .poll(() => model.streamedChars(), { timeout: 5 * 60_000, intervals: [1_000] })
            .toBeGreaterThanOrEqual(scripted.readyChars);
        }

        console.info("E10: measuring one viewer");
        const oneFrom = Date.now();
        await page.waitForTimeout(WINDOW_MS);
        const oneTo = Date.now();
        if (SCENARIO === "trimmed-head") {
          // What the first viewer shows while the part-trimmed head streams.
          const previews = path.join(repositoryRoot, "output", "visual-previews");
          mkdirSync(previews, { recursive: true });
          await page.screenshot({ path: path.join(previews, `e10-trimmed-head-${runId}.png`) });
        }
        // The counter files are flushed once a second.
        await page.waitForTimeout(1_200);
        const oneAfter = readCounters(oneFrom, oneTo);
        results.oneViewer = {
          seconds: (oneTo - oneFrom) / 1_000,
          renderer: answersBetween(answers, oneFrom, oneTo),
          bridge: oneAfter,
          recoveryReads: recoveryReads(oneAfter),
          streamedChars: model.streamedChars(),
          phaseAtEnd: await turnPhase(invoke, identity),
          modelCalls: model.conversationCalls(),
        };

        const secondContext = await browser.newContext({
          storageState: await page.context().storageState(),
        });
        await fetchModulesOutsideChromium(secondContext);
        const second = await secondContext.newPage();
        await second.setViewportSize({ width: 1440, height: 1000 });
        recordAnswers(second, "second", answers);
        await openViewer(second, status, fixture!, environment);
        await page.waitForTimeout(3_000);
        console.info("E10: measuring two viewers");
        const twoFrom = Date.now();
        await page.waitForTimeout(WINDOW_MS);
        const twoTo = Date.now();
        await page.waitForTimeout(1_200);
        const twoAfter = readCounters(twoFrom, twoTo);
        results.twoViewers = {
          seconds: (twoTo - twoFrom) / 1_000,
          renderer: answersBetween(answers, twoFrom, twoTo),
          bridge: twoAfter,
          recoveryReads: recoveryReads(twoAfter),
          streamedChars: model.streamedChars(),
          phaseAtEnd: await turnPhase(invoke, identity),
          modelCalls: model.conversationCalls(),
        };
        await secondContext.close();
        console.info("E10: waiting for the scripted turn to finish");

        await expect
          .poll(() => turnPhase(invoke, identity), { timeout: 5 * 60_000, intervals: [1_000] })
          .toBe("idle");
        const turnTo = Date.now();
        await page.waitForTimeout(5_000);
        if (SCENARIO !== "baseline") {
          const turn = readCounters(turnFrom, turnTo);
          results.turn = {
            seconds: (turnTo - turnFrom) / 1_000,
            bridge: turn,
            recoveryReads: recoveryReads(turn),
            streamedChars: model.streamedChars(),
          };
        }
        console.info("E10: measuring idle");
        const idleFrom = Date.now();
        await page.waitForTimeout(IDLE_WINDOW_MS);
        const idleTo = Date.now();
        await page.waitForTimeout(1_200);
        const idleAfter = readCounters(idleFrom, idleTo);
        results.idle = {
          seconds: (idleTo - idleFrom) / 1_000,
          renderer: answersBetween(answers, idleFrom, idleTo),
          bridge: idleAfter,
        };
        for (const [name, viewers] of [
          ["oneViewer", ["first"]],
          ["twoViewers", ["first", "second"]],
          ["idle", ["first"]],
        ] as const) {
          assertWindowEvidence(
            results[name] as Parameters<typeof assertWindowEvidence>[0],
            viewers,
            name !== "idle",
          );
        }
        if (SCENARIO === "trimmed-head") {
          for (const name of ["oneViewer", "twoViewers"]) {
            const window = results[name] as { bridge: ReturnType<typeof readCounters> };
            expect(
              window.bridge.delta.trimmedHeads,
              `${name} measured no part-trimmed head`,
            ).toBeGreaterThan(0);
          }
        }
        results.modelCalls = model.conversationCalls();
      },
      async () => {
        try {
          mkdirSync(outputDirectory, { recursive: true });
          writeFileSync(
            path.join(outputDirectory, resultFile),
            `${JSON.stringify(results, null, 2)}\n`,
          );
        } finally {
          try {
            if (ownsWrapper) rmSync(wrapper, { force: true });
          } finally {
            try {
              if (ownsSettings) rmSync(settingsFile, { force: true });
              restoreCodex?.();
            } finally {
              await model.stop();
            }
          }
        }
      },
    );
  });
});
