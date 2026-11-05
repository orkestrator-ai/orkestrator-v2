/**
 * What a visible running agent tab costs in requests, against a real
 * `dev:test --fixture` profile.
 *
 * Opt-in only (`ORKESTRATOR_AGENT_TEST_LIVE_TAB_REQUESTS=1`): both cases run
 * real Claude turns on the host's Claude credentials.
 *
 * The named workload is `running-quiet`: one visible Claude tab whose turn is
 * in a foreground wait, watched for `WINDOW_MS` with nothing else open. The
 * spec has no knowledge of which commands the renderer uses, so the same file
 * measures a commit before and after a change to the read round. Run it on
 * both and compare the JSON it writes to
 * `output/agent-testing/<run id>/agent-tab-requests.json`.
 *
 * The same case then takes the page offline and drops its event stream during
 * a second running turn, and checks the view recovers and shows that turn's
 * answer without a reload: a slower round must not cost a reconnect its
 * recovery. Further cases let a turn end while its environment is off screen,
 * and hide the combined read from the page, as an older backend would.
 *
 * Measurements are command names, counts and byte totals. Prompts, transcript
 * text, tokens and session ids never reach the output.
 */
import { expect, test, type Page, type Request } from "./browser-test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { watchEventStream } from "./event-stream-outage.js";

type Status = { status: string; profile?: string; browserUrl?: string; testProject?: string };
type Project = { id: string; localPath: string | null; name: string };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type CommandBucket = {
  count: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
};
type GatewayMetrics = { commands: Record<string, CommandBucket> };
type SessionRequest = { at: number; command: string; wireBytes: number };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_TAB_REQUESTS === "1";
const STATE_COMMAND = "get_native_agent_session_state_update";
const TAB_ID = "request-tab";
/** How long the running tab is watched. Long enough to span a 30 s discovery expiry. */
const WINDOW_MS = 40_000;
/** Lets the turn reach its wait and the first reads of the turn settle. */
const SETTLE_MS = 6_000;
const SLEEP_SECONDS = 75;
const TURN_DEADLINE_MS = 5 * 60_000;

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(`dev:status for "${profile}" returned no manifest`);
  const status = JSON.parse(command.stdout) as Status;
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  return status;
}

/** Signs the page in and returns an invoker bound to the profile's gateway. */
async function signIn(page: Page, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const answer = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command: name, args } },
    );
    expect(answer.ok(), `${name} failed with HTTP ${answer.status()}`).toBe(true);
    return ((await answer.json()) as { result: T }).result;
  };
}

async function readGatewayMetrics(page: Page, status: Status): Promise<GatewayMetrics> {
  const answer = await page.request.get(new URL("/__orkestrator/metrics", status.browserUrl!).href);
  expect(answer.ok(), "the gateway metrics route answered").toBe(true);
  return (await answer.json()) as GatewayMetrics;
}

/** Native session commands that moved between two metric snapshots. */
function commandDelta(before: GatewayMetrics, after: GatewayMetrics) {
  const delta: Record<string, CommandBucket> = {};
  for (const [command, bucket] of Object.entries(after.commands)) {
    if (!command.startsWith("get_native_agent_")) continue;
    const start = before.commands[command];
    const count = bucket.count - (start?.count ?? 0);
    if (count <= 0) continue;
    delta[command] = {
      count,
      requestBytes: bucket.requestBytes - (start?.requestBytes ?? 0),
      responseBytes: bucket.responseBytes - (start?.responseBytes ?? 0),
      durationMs: bucket.durationMs - (start?.durationMs ?? 0),
    };
  }
  return delta;
}

/** Every session request the page itself sends, with its size on the wire. */
function recordSessionRequests(page: Page, logicalSessionKey: string): SessionRequest[] {
  const requests: SessionRequest[] = [];
  page.on("requestfinished", (request: Request) => {
    void (async () => {
      if (!request.url().endsWith("/__orkestrator/invoke")) return;
      let body: { command?: string; args?: { logicalSessionKey?: string } };
      try {
        body = request.postDataJSON() as typeof body;
      } catch {
        return;
      }
      if (!body.command || body.args?.logicalSessionKey !== logicalSessionKey) return;
      const at = Date.now();
      const sizes = await request.sizes();
      requests.push({
        at,
        command: body.command,
        wireBytes:
          sizes.requestHeadersSize +
          sizes.requestBodySize +
          sizes.responseHeadersSize +
          sizes.responseBodySize,
      });
    })();
  });
  return requests;
}

function summarize(requests: SessionRequest[], from: number, to: number) {
  const slice = requests.filter((request) => request.at >= from && request.at < to);
  const byCommand: Record<string, number> = {};
  for (const request of slice) byCommand[request.command] = (byCommand[request.command] ?? 0) + 1;
  // A round has exactly one read of the session's turn state, alone or combined.
  const rounds = Math.max(
    0,
    ...Object.entries(byCommand)
      .filter(([command]) => !command.includes("discovery"))
      .map(([, count]) => count),
  );
  return {
    seconds: Math.round((to - from) / 1_000),
    requests: slice.length,
    rounds,
    requestsPerRound: rounds > 0 ? Number((slice.length / rounds).toFixed(2)) : null,
    requestsPerSecond: Number((slice.length / ((to - from) / 1_000)).toFixed(2)),
    wireBytes: slice.reduce((total, request) => total + request.wireBytes, 0),
    byCommand,
  };
}

function record(label: string, value: Record<string, unknown>): void {
  test.info().annotations.push({ type: label, description: JSON.stringify(value) });
  const directory = path.join(repositoryRoot, "output", "agent-testing", runId);
  mkdirSync(directory, { recursive: true });
  appendFileSync(
    path.join(directory, "agent-tab-requests.json"),
    `${JSON.stringify({ label, ...value })}\n`,
  );
}

async function modelId(invoke: Invoke, environmentId: string): Promise<string | undefined> {
  const catalog = await invoke<Array<{ platform: string; id: string; label: string }>>(
    "get_native_agent_model_catalog",
    { environmentId },
  );
  return catalog.find(
    (entry) => entry.platform === "claude" && /haiku/i.test(`${entry.id} ${entry.label}`),
  )?.id;
}

async function prepareTab(page: Page) {
  const status = profileStatus();
  const invoke = await signIn(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
  const created = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `tab-requests-${Date.now()}`,
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  await invoke("start_environment", { environmentId: created.id });
  const model = await modelId(invoke, created.id);
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: created.id,
  });
  await invoke("save_pane_layout", {
    environmentId: created.id,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "request-pane",
      root: {
        kind: "leaf",
        id: "request-pane",
        activeTabId: TAB_ID,
        tabs: [
          {
            id: TAB_ID,
            type: "agent-native",
            displayTitle: "Request count",
            nativeAgentData: { environmentId: created.id, platform: "claude", isLocal: true },
            ...(model ? { initialAgentModel: model } : {}),
          },
        ],
      },
    },
  });
  await page.goto(status.browserUrl!);
  const expand = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
  const entry = page.getByText(created.name, { exact: true }).first();
  await expect(expand.or(entry)).toBeVisible({ timeout: 60_000 });
  for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.isVisible()) await button.click();
  }
  if (await expand.isVisible()) await expand.click();
  await page.mouse.move(1100, 20);
  await entry.click({ timeout: 15_000 });
  const identity = {
    environmentId: created.id,
    agent: "claude" as const,
    logicalSessionKey: `env-${created.id}:${TAB_ID}`,
  };
  return { status, invoke, environment: created, identity, fixture: fixture! };
}

async function send(page: Page, prompt: string) {
  const composeBar = page.getByTestId("shared-native-compose-bar");
  const composer = composeBar.getByRole("textbox", { name: /^Message Claude/ });
  const sendButton = composeBar.getByRole("button", { name: "Send", exact: true });
  await expect(composer).toBeVisible({ timeout: 90_000 });
  await composer.fill(prompt);
  await expect(sendButton).toBeEnabled({ timeout: 90_000 });
  await composer.press("Enter");
  await expect(composer).toHaveText("", { timeout: 30_000 });
}

/** A sum the model computes, so the marker never appears in the prompt. */
function sumMarker(prefix: string) {
  const a = 1_000 + (randomBytes(2).readUInt16BE() % 8_000);
  const b = 1_000 + (randomBytes(2).readUInt16BE() % 8_000);
  return {
    ask: `${prefix} followed by a hyphen and the sum of ${a} and ${b} in digits (no spaces)`,
    marker: `${prefix}-${a + b}`,
  };
}

/** Claude Code refuses a bare long `sleep`, so the wait is its own program. */
function sleepPrompt(seconds: number, ask: string): string {
  return [
    "Do these steps in order and nothing else.",
    "1. Use the Bash tool in the foreground, not in the background, to run:",
    `python3 -c "import time; time.sleep(${seconds})"`,
    `2. Reply with exactly the word ${ask}.`,
  ].join("\n");
}

async function turnPhase(invoke: Invoke, identity: Record<string, unknown>): Promise<string> {
  const update = await invoke<{ status: string; value?: { turn?: { phase?: string } } }>(
    STATE_COMMAND,
    { ...identity, viewVersion: 1, forceSnapshot: true },
  );
  return update.value?.turn?.phase ?? update.status;
}

test.describe("Requests of a visible running agent tab", () => {
  test.skip(!LIVE_OPT_IN, "Set ORKESTRATOR_AGENT_TEST_LIVE_TAB_REQUESTS=1 for real Claude turns");

  /*
   * The path that must not depend on a mounted view: the turn runs and ends in
   * an environment that is not on screen, the view sends nothing meanwhile, and
   * it catches up on return and again from a cold reload.
   */
  test("inactive: a turn that ends off screen is shown on return", async ({ page }) => {
    test.setTimeout(TURN_DEADLINE_MS + 5 * 60_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { invoke, environment, identity, fixture } = await prepareTab(page);
    const other = await invoke<Environment>("create_environment", {
      projectId: fixture.id,
      name: `tab-requests-other-${Date.now()}`,
      environmentType: "local",
      networkAccessMode: "restricted",
    });
    try {
      await invoke("start_environment", { environmentId: other.id });
      const requests = recordSessionRequests(page, identity.logicalSessionKey);
      const turn = sumMarker("INACTIVEDONE");
      await send(page, sleepPrompt(25, turn.ask));
      await expect
        .poll(() => turnPhase(invoke, identity), { timeout: 90_000, intervals: [500] })
        .toBe("running");
      await page.getByText(other.name, { exact: true }).first().click();
      await expect(page.getByTestId("shared-native-compose-bar")).toBeHidden({ timeout: 30_000 });
      await page.waitForTimeout(2_000);
      const inactiveFrom = Date.now();
      await expect
        .poll(() => turnPhase(invoke, identity), {
          timeout: TURN_DEADLINE_MS,
          intervals: [1_000],
        })
        .toBe("idle");
      await page.waitForTimeout(3_000);
      const returnedAt = Date.now();
      const whileInactive = summarize(requests, inactiveFrom, returnedAt);
      expect(whileInactive.requests, "an inactive view kept reading its session").toBe(0);

      await page.getByText(environment.name, { exact: true }).first().click();
      await expect(page.getByText(turn.marker).first()).toBeVisible({ timeout: 60_000 });
      const caughtUpMs = Date.now() - returnedAt;
      await expect
        .poll(() => requests.filter((request) => request.at >= returnedAt).length)
        .toBeGreaterThan(0);
      // A reload lands on the workspace with nothing selected.
      await page.reload();
      await page.getByText(environment.name, { exact: true }).first().click({ timeout: 60_000 });
      await expect(page.getByText(turn.marker).first()).toBeVisible({ timeout: 90_000 });
      record("inactive", { secondsInactive: whileInactive.seconds, requests: 0, caughtUpMs });
    } finally {
      await invoke("stop_environment", { environmentId: other.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: other.id }).catch(() => undefined);
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  });

  /*
   * A renderer against a backend from before the combined read. The capability
   * answer is rewritten on its way to the page, so the backend under it is the
   * real one and its older commands are the real commands.
   */
  test("older-backend: no combined read offered, none sent", async ({ page }) => {
    test.setTimeout(TURN_DEADLINE_MS + 5 * 60_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failedCommands: string[] = [];
    await page.route("**/__orkestrator/invoke", async (route) => {
      const body = route.request().postDataJSON() as { command?: string };
      if (body.command !== "get_native_agent_sync_capabilities") return route.continue();
      const response = await route.fetch();
      const payload = (await response.json()) as { result: Record<string, unknown> };
      delete payload.result.liveUpdateVersions;
      return route.fulfill({ response, json: payload });
    });
    page.on("response", (response) => {
      if (!response.url().endsWith("/__orkestrator/invoke") || response.ok()) return;
      const body = response.request().postDataJSON() as { command?: string };
      if (body.command?.startsWith("get_native_agent_")) failedCommands.push(body.command);
    });
    const { invoke, environment, identity } = await prepareTab(page);
    try {
      const requests = recordSessionRequests(page, identity.logicalSessionKey);
      const turn = sumMarker("OLDERDONE");
      await send(page, sleepPrompt(30, turn.ask));
      await expect
        .poll(() => turnPhase(invoke, identity), { timeout: 90_000, intervals: [500] })
        .toBe("running");
      await page.waitForTimeout(SETTLE_MS);
      const from = Date.now();
      await page.waitForTimeout(15_000);
      const to = Date.now();
      const summary = summarize(requests, from, to);
      record("older-backend", { ...summary, failedCommands });
      expect(summary.byCommand["get_native_agent_live_update"] ?? 0).toBe(0);
      expect(summary.byCommand["get_native_agent_transcript_update"] ?? 0).toBeGreaterThan(10);
      expect(summary.byCommand[STATE_COMMAND] ?? 0).toBeGreaterThan(10);
      expect(failedCommands).toEqual([]);
      await expect(page.getByText(turn.marker).first()).toBeVisible({
        timeout: TURN_DEADLINE_MS,
      });
    } finally {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  });

  test("running-quiet: one visible tab in a foreground wait", async ({ page, context }) => {
    test.setTimeout(TURN_DEADLINE_MS + 5 * 60_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { status, invoke, environment, identity } = await prepareTab(page);
    try {
      const requests = recordSessionRequests(page, identity.logicalSessionKey);
      const first = sumMarker("QUIETDONE");
      await send(page, sleepPrompt(SLEEP_SECONDS, first.ask));
      await expect
        .poll(() => turnPhase(invoke, identity), { timeout: 90_000, intervals: [500] })
        .toBe("running");
      await page.waitForTimeout(SETTLE_MS);

      // Nothing from this test touches the gateway's invoke route in the window.
      const before = await readGatewayMetrics(page, status);
      const from = Date.now();
      await page.waitForTimeout(WINDOW_MS);
      const to = Date.now();
      const after = await readGatewayMetrics(page, status);
      const phaseAtEnd = await turnPhase(invoke, identity);
      expect(phaseAtEnd, "the turn ended inside the measurement window").toBe("running");
      record("running-quiet", {
        ...summarize(requests, from, to),
        gateway: commandDelta(before, after),
      });

      await expect(page.getByText(first.marker).first()).toBeVisible({
        timeout: TURN_DEADLINE_MS,
      });
      expect(await turnPhase(invoke, identity)).not.toBe("missing");

      // The same view through a dropped connection in a second running turn.
      const stream = watchEventStream(page);
      const second = sumMarker("OUTAGEDONE");
      await send(page, sleepPrompt(30, second.ask));
      await expect
        .poll(() => turnPhase(invoke, identity), { timeout: 90_000, intervals: [500] })
        .toBe("running");
      await page.waitForTimeout(SETTLE_MS);
      await stream.cut(context);
      await page.waitForTimeout(6_000);
      await context.setOffline(false);
      const backOnlineAt = Date.now();
      await stream.expectReconnected();
      await expect
        .poll(
          () =>
            requests.filter((request) => request.at >= backOnlineAt && request.wireBytes > 0)
              .length,
          { timeout: 30_000, message: "the view never read its session after the outage" },
        )
        .toBeGreaterThan(0);
      await expect(page.getByText(second.marker).first()).toBeVisible({
        timeout: TURN_DEADLINE_MS,
      });
      record("reconnect", {
        firstReadAfterOnlineMs: Math.max(
          0,
          (requests.find((request) => request.at >= backOnlineAt)?.at ?? backOnlineAt) -
            backOnlineAt,
        ),
        recovered: true,
      });
    } finally {
      await context.setOffline(false);
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  });
});
