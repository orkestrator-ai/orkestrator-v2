/**
 * Claude transcript content-revision tokens with an inactive tab and
 * background tasks, against a real `dev:test --fixture` profile.
 *
 * Opt-in only (`ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS=1`): both cases run
 * real Claude turns on the host's Claude credentials.
 *
 * The Claude bridge answers a conditional transcript read from a content
 * revision (`bridges/claude-bridge/src/services/transcript-revision.ts`), and
 * the backend's view token hashes the bridge's source token, so a bridge
 * token that moved without a change would surface here as a needless
 * snapshot, and a change that skipped its marker as an `unchanged` answer
 * hiding new content. Each case therefore reads the session the way a client
 * does, with its last token, while the tab under test is not on screen:
 *
 * 1. Inactive tab. A prompt starts a background Bash command and a foreground
 *    one, then the test switches to a second tab in the same pane. The turn
 *    finishes, the background command finishes later and Claude answers its
 *    notification, all while the tab is inactive.
 * 2. Inactive environment. A prompt starts a background subagent, then the
 *    test selects another environment. The subagent finishes and Claude
 *    answers its report while the environment is not shown.
 *
 * In both, every change must reach the reader as a delta or snapshot
 * (no missed update), a settled session must answer `unchanged` to repeated
 * reads (no needless re-read), the inactive view must not poll, and on return
 * the view must show the final rows without a reload and then settle to
 * `unchanged` reads. A reload then repaints the same rows from a cold client.
 *
 * `ORKESTRATOR_AGENT_TEST_REVISION_MODEL` overrides the model (default: the
 * first Haiku in the catalogue). Measurements are content-free Playwright
 * annotations in `results.json`; prompts and transcript text never reach
 * test output.
 */
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  TokenReader,
  TaskCaseEvidence,
  rowText,
  type Row,
} from "./claude-revision-token-reader.js";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

type Status = {
  status: string;
  profile?: string;
  browserUrl?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type BrowserRead = {
  at: number;
  command: string;
  status: string;
  conditional: boolean;
  forced: boolean;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS === "1";
const MODEL = process.env.ORKESTRATOR_AGENT_TEST_REVISION_MODEL;
const TRANSCRIPT_COMMAND = "get_native_agent_transcript_update";
const STATE_COMMAND = "get_native_agent_session_state_update";
/** How often the test's own reader polls; slower than a view, so changes coalesce. */
const READER_INTERVAL_MS = 2_000;
/** Consecutive settled reads that must all answer `unchanged`. */
const QUIET_READS = 10;
/** Grace after deactivation for a read the view had already issued. */
const DEACTIVATION_GRACE_MS = 2_000;
/** Watching an active, settled view: long enough for several 1.5 s idle reads. */
const ACTIVE_IDLE_WATCH_MS = 12_000;
/** A remount, and a dev profile's StrictMode double mount, settles well within this. */
const REMOUNT_SETTLE_MS = 2_000;
const SETTLE_TIMEOUT_MS = 8 * 60_000;
const SIDE_TAB_TITLE = "Side tab";

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) {
    throw new Error(`dev:status for profile "${profile}" returned no manifest`);
  }
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

function note(type: string, value: unknown): void {
  test.info().annotations.push({
    type,
    description: typeof value === "string" ? value : JSON.stringify(value),
  });
}

function counts(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

/**
 * Every command the page itself sends for one session, with its answer. The
 * arguments are parsed in memory only: the record keeps the command, the
 * answer's status and whether it was conditional or forced.
 */
function recordBrowserReads(page: Page, logicalSessionKey: string): BrowserRead[] {
  const reads: BrowserRead[] = [];
  page.on("requestfinished", (request: Request) => {
    void (async () => {
      if (!request.url().endsWith("/__orkestrator/invoke")) return;
      let body: {
        command?: string;
        args?: {
          logicalSessionKey?: string;
          knownToken?: string;
          forceSnapshot?: boolean;
        };
      };
      try {
        body = request.postDataJSON() as typeof body;
      } catch {
        return;
      }
      if (!body.command || body.args?.logicalSessionKey !== logicalSessionKey) return;
      const at = Date.now();
      const response = await request.response();
      const result = (await response?.json().catch(() => null)) as {
        result?: { status?: string };
      } | null;
      reads.push({
        at,
        command: body.command,
        status: result?.result?.status ?? `http-${response?.status() ?? "none"}`,
        conditional: typeof body.args?.knownToken === "string",
        forced: body.args?.forceSnapshot === true,
      });
    })();
  });
  return reads;
}

function summarizeReads(reads: BrowserRead[], from: number, to = Number.POSITIVE_INFINITY) {
  const slice = reads.filter((read) => read.at >= from && read.at < to);
  const polled = slice.filter(
    (r) => r.command === TRANSCRIPT_COMMAND || r.command === STATE_COMMAND,
  );
  return {
    transcript: counts(slice.filter((r) => r.command === TRANSCRIPT_COMMAND).map((r) => r.status)),
    state: counts(slice.filter((r) => r.command === STATE_COMMAND).map((r) => r.status)),
    other: counts(
      slice
        .filter((r) => r.command !== TRANSCRIPT_COMMAND && r.command !== STATE_COMMAND)
        .map((r) => `${r.command}:${r.status}`),
    ),
    unconditional: polled.filter((r) => !r.conditional && !r.forced).length,
    forced: polled.filter((r) => r.forced).length,
  };
}

/** Each read in a window, as `+ms command status [token|no-token|forced]`. */
function readTimeline(reads: BrowserRead[], from: number, to = Number.POSITIVE_INFINITY) {
  return reads
    .filter((read) => read.at >= from && read.at < to)
    .map(
      (read) =>
        `+${read.at - from} ${read.command.replace("get_native_agent_", "")} ${read.status} ${
          read.forced ? "forced" : read.conditional ? "token" : "no-token"
        }`,
    );
}

async function openApp(page: Page, status: Status, fixture: Project, environmentName: string) {
  await page.goto(status.browserUrl!);
  await selectEnvironment(page, fixture, environmentName);
}

async function selectEnvironment(page: Page, fixture: Project, environmentName: string) {
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

async function connect(page: Page) {
  const status = profileStatus();
  const invoke = await signIn(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
  return { status, invoke, fixture: fixture! };
}

async function createEnvironment(invoke: Invoke, fixture: Project, name: string) {
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

async function modelId(invoke: Invoke, environmentId: string): Promise<string | undefined> {
  if (MODEL) return MODEL;
  const catalog = await invoke<Array<{ platform: string; id: string; label: string }>>(
    "get_native_agent_model_catalog",
    { environmentId },
  );
  return catalog.find(
    (entry) => entry.platform === "claude" && /haiku/i.test(`${entry.id} ${entry.label}`),
  )?.id;
}

/** One pane holding the tab under test (active) and an idle side tab. */
async function layOutTabs(invoke: Invoke, environmentId: string, model: string | undefined) {
  const tab = (id: string, displayTitle: string) => ({
    id,
    type: "agent-native",
    displayTitle,
    nativeAgentData: { environmentId, platform: "claude", isLocal: true },
    ...(model ? { initialAgentModel: model } : {}),
  });
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId,
  });
  await invoke("save_pane_layout", {
    environmentId,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "revision-pane",
      root: {
        kind: "leaf",
        id: "revision-pane",
        activeTabId: "revision-tab",
        tabs: [tab("revision-tab", "Revision qualification"), tab("side-tab", SIDE_TAB_TITLE)],
      },
    },
  });
  return {
    environmentId,
    agent: "claude" as const,
    logicalSessionKey: `env-${environmentId}:revision-tab`,
  };
}

async function activeTabId(invoke: Invoke, environmentId: string): Promise<string | undefined> {
  const layout = await invoke<{ root?: { activeTabId?: string } } | null>("get_pane_layout", {
    environmentId,
  });
  return layout?.root?.activeTabId;
}

/** The pane's tab strip entries, in order: the tab under test, then the side tab. */
function paneTabs(page: Page): { underTest: Locator; side: Locator } {
  const tabs = page.locator("div.cursor-grab");
  return {
    underTest: tabs.filter({ hasNotText: SIDE_TAB_TITLE }).first(),
    side: tabs.filter({ hasText: SIDE_TAB_TITLE }).first(),
  };
}

async function send(page: Page, prompt: string) {
  const composeBar = page.getByTestId("shared-native-compose-bar");
  const composer = composeBar.getByRole("textbox", { name: /^Message Claude/ });
  const sendButton = composeBar.getByRole("button", {
    name: "Send",
    exact: true,
  });
  await expect(composer).toBeVisible({ timeout: 90_000 });
  await composer.fill(prompt);
  await expect(sendButton).toBeEnabled({ timeout: 90_000 });
  await composer.press("Enter");
  await expect(composer).toHaveText("", { timeout: 30_000 });
}

/**
 * Read with the reader's tokens until the session is idle, every background
 * task has settled, the final marker is in the transcript, and `QUIET_READS`
 * reads in a row answered `unchanged` for both transcript and state.
 */
async function readUntilSettled(reader: TokenReader, finalMarker: string, label: string) {
  const started = Date.now();
  let quiet = 0;
  const evidence = new TaskCaseEvidence(reader.tasks);
  let markerAt: number | undefined;
  while (Date.now() - started < SETTLE_TIMEOUT_MS) {
    const entry = await reader.read();
    evidence.observe(reader, entry.transcript !== "unchanged");
    const changed = entry.transcript !== "unchanged" || entry.state !== "unchanged";
    if (
      markerAt === undefined &&
      reader.rows.some((row) => row.role === "assistant" && rowText(row).includes(finalMarker))
    )
      markerAt = entry.at;
    const settled =
      entry.phase === "idle" &&
      markerAt !== undefined &&
      evidence.settledTask !== undefined &&
      reader.tasks.every((task) => ["completed", "failed", "killed"].includes(task.status));
    quiet = settled && !changed ? quiet + 1 : 0;
    if (quiet >= QUIET_READS) break;
    await new Promise((resolve) => setTimeout(resolve, READER_INTERVAL_MS));
  }
  const reads = reader.log.filter((entry) => entry.at >= started);
  note(`${label}-reader`, {
    reads: reads.length,
    seconds: Math.round((Date.now() - started) / 1_000),
    transcript: counts(reads.map((entry) => entry.transcript)),
    state: counts(reads.map((entry) => entry.state)),
    sawNewTaskComplete: evidence.settledTask !== undefined,
    finalTasks: reader.tasks.map((task) => task.status),
    markerSeconds: markerAt === undefined ? null : Math.round((markerAt - started) / 1_000),
    changesAfterFirstIdle: evidence.changesAfterIdle,
    trailingQuietReads: quiet,
  });
  expect(markerAt, `${label}: the final marker never reached the reader`).toBeDefined();
  evidence.expectComplete();
  expect(quiet, `${label}: a settled session kept answering changes`).toBeGreaterThanOrEqual(
    QUIET_READS,
  );
  return evidence.settledTask!;
}

/** The page sent nothing for the session from `from` on. */
function expectNoReads(reads: BrowserRead[], from: number, what: string) {
  const late = readTimeline(reads, from);
  expect(late, `${what} kept reading its session`).toEqual([]);
}

/**
 * Activate the view and check it catches up without a reload, then settles
 * to conditional `unchanged` reads while active.
 *
 * Only the newest row is checked on screen: the list is virtualized, so an
 * older row may be scrolled out of the DOM; `expectMarkersInOrder` checks
 * the conditional reader rows for every marker. A remount drops the
 * session-state token on purpose (`useNativeAgentSession` re-reads state a mount never saw), and
 * a dev profile renders under `React.StrictMode`, which mounts a view twice,
 * so the idle window starts once that settles. A transcript read keeps its
 * token across a tab switch and an environment switch; only a reload starts
 * cold.
 */
async function expectViewCatchesUp(
  page: Page,
  reads: BrowserRead[],
  newestMarker: string,
  label: string,
  activatedAt: number,
  options: { coldStart?: boolean } = {},
) {
  await expect(
    page.getByText(newestMarker).first(),
    `${label}: the newest row is not shown`,
  ).toBeVisible({ timeout: 60_000 });
  const caughtUpAt = Date.now();
  await page.waitForTimeout(REMOUNT_SETTLE_MS);
  const idleFrom = Date.now();
  await page.waitForTimeout(ACTIVE_IDLE_WATCH_MS);
  const catchUp = summarizeReads(reads, activatedAt, idleFrom);
  const idle = summarizeReads(reads, idleFrom);
  note(`${label}-active`, { catchUpMs: caughtUpAt - activatedAt, catchUp, idle });
  note(`${label}-timeline`, readTimeline(reads, activatedAt));
  const coldReads = reads.filter(
    (read) =>
      read.at >= activatedAt &&
      read.command === TRANSCRIPT_COMMAND &&
      !read.conditional &&
      !read.forced,
  );
  if (options.coldStart) {
    // One per mount, and a dev profile mounts twice.
    expect(coldReads.length, `${label}: repeated cold reads`).toBeLessThanOrEqual(2);
  } else {
    expect(coldReads, `${label}: a transcript read dropped its token`).toEqual([]);
  }
  const total = (byStatus: Record<string, number>) =>
    Object.values(byStatus).reduce((a, b) => a + b, 0);
  expect(total(idle.transcript), `${label}: an active idle view stopped reading`).toBeGreaterThan(
    2,
  );
  expect(idle.transcript.unchanged ?? 0, `${label}: active idle reads re-sent content`).toBe(
    total(idle.transcript),
  );
  expect(total(idle.state), `${label}: an active idle view stopped reading state`).toBeGreaterThan(
    0,
  );
  expect(idle.state.unchanged ?? 0, `${label}: active idle state reads re-sent state`).toBe(
    total(idle.state),
  );
  expect(idle.unconditional, `${label}: active idle reads dropped their token`).toBe(0);
}

/** Every marker appears in an assistant row, in this order. */
function expectMarkersInOrder(rows: Row[], markers: string[], label: string) {
  const positions = markers.map((marker) =>
    rows.findIndex((row) => row.role === "assistant" && rowText(row).includes(marker)),
  );
  note(`${label}-marker-rows`, positions);
  for (const [index, position] of positions.entries()) {
    expect(position, `${label}: marker ${index + 1} is missing`).toBeGreaterThanOrEqual(0);
  }
  expect(
    [...positions].sort((a, b) => a - b),
    `${label}: markers out of order`,
  ).toEqual(positions);
}

test.describe("Claude content-revision tokens, inactive views and background tasks", () => {
  test.skip(
    !LIVE_OPT_IN,
    "Set ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS=1 for real Claude turns",
  );

  test("inactive tab and inactive environment stay correct through background tasks", async ({
    page,
  }) => {
    test.setTimeout(3 * SETTLE_TIMEOUT_MS + 10 * 60_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { status, invoke, fixture } = await connect(page);
    const environments: Environment[] = [];
    try {
      const environment = await createEnvironment(invoke, fixture, "revision-tokens");
      environments.push(environment);
      const other = await createEnvironment(invoke, fixture, "revision-elsewhere");
      environments.push(other);
      const model = await modelId(invoke, environment.id);
      note("model", model ?? "provider default");
      const identity = await layOutTabs(invoke, environment.id, model);
      const reads = recordBrowserReads(page, identity.logicalSessionKey);
      const reader = new TokenReader(invoke, identity);
      const nonce = randomBytes(4).toString("hex");
      // Each marker is a sum the model computes, so it never appears in a
      // prompt and only an assistant row can show it.
      const sums = Array.from({ length: 4 }, () => [
        1_000 + (randomBytes(2).readUInt16BE() % 8_000),
        1_000 + (randomBytes(2).readUInt16BE() % 8_000),
      ]);
      const ask = (prefix: string, [a, b]: number[]) =>
        `${prefix} followed by a hyphen and the sum of ${a} and ${b} in digits (no spaces)`;
      const marker = (prefix: string, [a, b]: number[]) => `${prefix}-${a! + b!}`;
      const markers = {
        turn1: marker("TURNA", sums[0]!),
        background: marker("BGDONE", sums[1]!),
        turn2: marker("TURNB", sums[2]!),
        subagent: marker("SUBDONE", sums[3]!),
      };

      await openApp(page, status, fixture, environment.name);
      const tabs = paneTabs(page);
      await expect(tabs.side).toBeVisible({ timeout: 60_000 });

      // Case 1: inactive tab through a turn and a background command.
      await send(
        page,
        [
          "Do these steps in order and nothing else.",
          `1. Use the Bash tool with run_in_background set to true to run: sleep 45; echo bg-${nonce}`,
          "Do not wait for it, poll it or read its output file.",
          `2. Use the Bash tool to run: echo fg-${nonce}`,
          `3. Reply with exactly the word ${ask("TURNA", sums[0]!)}.`,
          "Later, when you are told the background command finished, reply with only the word",
          `${ask("BGDONE", sums[1]!)}.`,
        ].join("\n"),
      );
      await tabs.side.click();
      await expect.poll(() => activeTabId(invoke, environment.id)).toBe("side-tab");
      const tabInactiveAt = Date.now();
      const bashTask = await readUntilSettled(reader, markers.background, "inactive-tab");
      await reader.expectTaskOutput(bashTask, "Bash", `bg-${nonce}`);
      await reader.expectForcedComparison();
      note("inactive-tab-inactive-timeline", readTimeline(reads, tabInactiveAt));
      expectNoReads(reads, tabInactiveAt + DEACTIVATION_GRACE_MS, "an inactive tab");
      expectMarkersInOrder(reader.rows, [markers.turn1, markers.background], "inactive-tab");

      const tabActivatedAt = Date.now();
      await tabs.underTest.click();
      await expect.poll(() => activeTabId(invoke, environment.id)).toBe("revision-tab");
      await expectViewCatchesUp(page, reads, markers.background, "inactive-tab", tabActivatedAt);

      // Case 2: inactive environment through a background subagent.
      await send(
        page,
        [
          "Do these steps in order and nothing else.",
          "1. Use the Agent tool with run_in_background set to true and subagent_type",
          "general-purpose. Give it this task: use the Bash tool to run",
          `sleep 40; echo sub-${nonce} and report the command's output.`,
          "Do not wait for the agent or check on it.",
          `2. Reply with exactly the word ${ask("TURNB", sums[2]!)}.`,
          "Later, when you are told the agent finished, reply with only the word",
          `${ask("SUBDONE", sums[3]!)}.`,
        ].join("\n"),
      );
      await selectEnvironment(page, fixture, other.name);
      await expect(tabs.side).toBeHidden({ timeout: 30_000 });
      const environmentInactiveAt = Date.now();
      const agentTask = await readUntilSettled(reader, markers.subagent, "inactive-environment");
      await reader.expectTaskOutput(agentTask, "Agent", `sub-${nonce}`);
      await reader.expectForcedComparison();
      note("inactive-environment-inactive-timeline", readTimeline(reads, environmentInactiveAt));
      expectNoReads(
        reads,
        environmentInactiveAt + DEACTIVATION_GRACE_MS,
        "a view in an inactive environment",
      );
      const allMarkers = [markers.turn1, markers.background, markers.turn2, markers.subagent];
      expectMarkersInOrder(reader.rows, allMarkers, "inactive-environment");

      const environmentActivatedAt = Date.now();
      await selectEnvironment(page, fixture, environment.name);
      await expectViewCatchesUp(
        page,
        reads,
        markers.subagent,
        "inactive-environment",
        environmentActivatedAt,
      );

      // A cold client: the same newest row from a reload, then quiet reads.
      const reloadedAt = Date.now();
      await page.reload();
      await selectEnvironment(page, fixture, environment.name);
      await expectViewCatchesUp(page, reads, markers.subagent, "reload", reloadedAt, {
        coldStart: true,
      });
      await reader.expectForcedComparison();
      const finalRows = reader.rows;
      note("final-rows", { rows: finalRows.length });
      expectMarkersInOrder(finalRows, allMarkers, "final");
      const again = await reader.read();
      expect(again.transcript, "the settled session's token moved without a change").toBe(
        "unchanged",
      );
    } finally {
      await removeEnvironments(invoke, environments);
    }
  });
});
