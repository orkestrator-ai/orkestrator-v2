/**
 * Idle observation, live per provider: a native tab must settle to the right
 * state, never a stuck "working" and never a missed completion.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1`) against a running
 * agent-test profile with provider credentials. For each platform in
 * `ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS` (default all six) one fresh local
 * fixture environment holds one native tab, and these cases run in order
 * (`ORKESTRATOR_AGENT_TEST_IDLE_CASES` narrows them):
 *
 * - `missed-final`: the view sits idle long enough for quiet backoff, then a
 *   turn is dispatched from outside the view (as another client would) while
 *   the browser drops every event frame that names the environment. The view
 *   has to find the turn and its completion through its own reads.
 * - `bridge-restart`: Claude and Codex in a local environment. Once the
 *   backend skips the idle group's sweeps behind the bridge's observation
 *   stream, the bridge process is stopped and started again, then a turn is
 *   dispatched from outside the view. The group must be read again and the
 *   turn seen within the completion budget (todo 0049 task 1).
 * - `async-question`: Codex only. Once the view and its backend group have
 *   backed off, a turn dispatched from outside the view asks a question with
 *   `request_user_input_async`, which returns at once, and ends. The card must
 *   show within the completion budget, and its answer, sent from the card, must
 *   come back as a settled turn (todo 0049 task 3).
 * - `approval`: in the provider's "ask" approval mode a shell command parks
 *   an approval. The card must appear within the 2 s budget, survive a hidden
 *   period, and approving it must let the turn finish and settle.
 * - `subagents`: the model is asked to delegate to a sub-agent. The parent
 *   must settle with no running background task left behind.
 * - `background`: the model starts a background shell command and ends its
 *   turn. The view must follow the task to its end and settle.
 * - `reconnect`: the event stream is cut and the browser goes offline while a
 *   turn runs and completes; back online, the view must settle.
 * - `hidden`: the document is hidden for the whole turn; on becoming visible
 *   the view must settle within the completion budget.
 * - `no-renderer`: the only page is closed while a turn runs. A second client
 *   signs in afterwards and must see the completed, idle conversation.
 * - `steer`: OpenCode only.
 *   While a turn runs a shell command, a prompt queued from the composer is
 *   steered into it from its queue strip. The turn must end on the steer's
 *   reply, never the first prompt's, with the steer shown once, before and
 *   after a reload. Every other platform records it `skipped`.
 * - `rebuild`: OpenCode in a container only (todo 0008 task 7). A preserving
 *   rebuild moves the environment to a new runtime; the conversation's
 *   `opencode2.db` must come with it, so a follow-up turn settles on the same
 *   session with the earlier rows kept (`idle-observation-container-rebuild.ts`).
 *   Every other run records it `skipped`.
 * - `detach`: the session sits idle past the provider's idle detach (10 min
 *   for Claude, Cursor and Pi), recording the view's idle read cadence, then a
 *   prompt must reattach and settle.
 *
 * Fault seams live in the page, not the product: an init script wraps
 * `EventSource` (drop frames, break the stream) and `document.visibilityState`.
 * Every case records timings to
 * `output/agent-testing/<run>/idle-observation-live/<platform>.json`. A case
 * whose provider never did the thing asked (no sub-agent, no background task,
 * no "ask" mode) is recorded `not-exercised` or `skipped`, never `passed`.
 * Real turns cost tokens; this spec runs only when asked for.
 *
 * `ORKESTRATOR_AGENT_TEST_IDLE_FAKE_MODELS=1` runs Claude and Codex against
 * scripted loopback models instead (`idle-observation-fake-claude.ts`,
 * `idle-observation-fake-codex.ts`): no login, nothing billed. The spec
 * points the profile's own isolated Claude settings and Codex config at them
 * for the run and restores both. Start the profile with no host Claude login
 * and a made-up Codex API key:
 *
 *   CODEX_HOME=<throwaway dir whose auth.json is {"auth_mode":"apikey","OPENAI_API_KEY":"<made up>"}> \
 *     mise run dev:test --profile idleqa --fixture --credential-source codex \
 *     --agent-platforms claude,codex --headless
 *
 * The models answer the spec's own prompts only, the way a compliant model
 * would: each case, sub-agents and approvals included, gets the tool call it
 * asks for. Pi runs the same way against `idle-observation-fake-pi.ts`, added
 * to the profile's own Pi `models.json` (todo 0049 task 7); Pi needs no
 * credential source. OpenCode reaches the same endpoint through a custom
 * provider merged into the profile's own global `opencode.json`
 * (`opencode-fake-provider.ts`, todo 0049 task 6), limited to that provider
 * so no turn or title request can reach a hosted model; it needs no
 * credential source either. OpenCode's `shell` can background a command, so
 * `background` exercises OpenCode too (todo 0049 task 8). OpenCode's server
 * mirrors the same profile configuration (todo 0008 task 7).
 *
 * `ORKESTRATOR_AGENT_TEST_IDLE_ENVIRONMENT=container` runs Claude or OpenCode
 * in a new container environment (todo 0049 task 9, todo 0008 task 7) instead
 * of a local one, from the profile's development image. With fake models the
 * scripted model is copied into the container and serves on its loopback,
 * because a host firewall may refuse the container's route to the host. For
 * OpenCode the profile's `opencode.json` names that loopback address before
 * the environment is created, because the container's server reads the
 * profile's configuration through the input staged with each runtime.
 * `bridge-restart` is local only.
 */
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  fetchModulesOutsideChromium,
} from "./browser-test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { CODEWORD_REPLY_PREFIX } from "./idle-observation-fake-claude";
import {
  idleObservationModel,
  asyncQuestionPrompt,
  detachWaitClosesRenderer,
  detachWaitMs,
  idleDetachWindowMs,
} from "./idle-observation-live-support";
import { runContainerRebuildCase } from "./idle-observation-container-rebuild";
import {
  installContainerFakeClaude,
  installContainerFakeOpenCode,
  pointProfileOpenCodeAtContainerFake,
  readContainerFile,
  withFakeModelCleanup,
  startLocalFakeModel,
  type FakeModelHandle,
} from "./idle-observation-fake-models";
import { PI_FAKE_PROVIDER } from "./idle-observation-fake-pi";
import { allowOpenCodeFakeProvider } from "./opencode-fake-provider";
import {
  requireRecoveredBackoff,
  backgroundOutputEvidence,
  completedTaskOutputFiles,
  failedCases,
  freshToolResults,
  freshToolStates,
  gapHistogram,
  lateOutputRowIds,
  discoveryRenewalDelta,
  invalidationCauseDelta,
  readCadence,
  selectedCases,
  shellOutputContainsMarker,
  type CaseRecord,
  type IdleObservationCase,
  type DiscoveryRenewalCounts,
  type InvalidationCounts,
} from "./idle-observation-live-support";
import { sidebarActivity } from "./sidebar-activity";
import { dismissSidebarTooltip } from "./sidebar-tooltip";

type Status = {
  status: string;
  profile?: string;
  browserUrl?: string;
  testProject?: string;
  dataDir?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = {
  id: string;
  name: string;
  worktreePath?: string | null;
  containerId?: string | null;
};
type Message = { id: string; role: string; content?: unknown; parts?: unknown };
type Interaction = {
  id: string;
  kind: string;
  state: string;
  sessionId?: string;
  presentation: { confirmLabel?: string; title?: string };
};
type ApprovalMode = { id: string; label: string; kind: string };
type Projection = {
  sessionId?: string;
  turn: { phase: string; error?: string };
  messages: Message[];
  interactions: Interaction[];
  composer?: {
    approvalModes?: ApprovalMode[];
    selectedApprovalModeId?: string;
    modes?: Array<{ id: string }>;
    selectedModeId?: string;
    selectedModelId?: string;
  };
  backgroundTasks?: Array<{
    id: string;
    status: string;
    description?: string;
    outputFile?: string;
  }>;
  completionBlockedByBackgroundTasks?: boolean;
  runtime?: { state?: string };
};
type Platform = "claude" | "codex" | "opencode" | "cursor" | "grok" | "pi";
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION === "1";
const LABELS: Record<Platform, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
};
const PLATFORMS = (process.env.ORKESTRATOR_AGENT_TEST_IDLE_PLATFORMS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const SELECTED = (PLATFORMS.length > 0 ? PLATFORMS : Object.keys(LABELS)) as Platform[];
const CASES = selectedCases(process.env.ORKESTRATOR_AGENT_TEST_IDLE_CASES);
/** `<platform>=<model>` pairs, comma-separated. */
const MODELS = new Map(
  (process.env.ORKESTRATOR_AGENT_TEST_IDLE_MODELS ?? "")
    .split(",")
    .map((entry) => entry.trim().split("="))
    .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[1])),
);
const TURN_TIMEOUT_MS = Number(process.env.ORKESTRATOR_AGENT_TEST_IDLE_TURN_TIMEOUT_MS ?? "240000");
/**
 * The detach case's idle wait. Unset, each provider waits its own idle window
 * plus 30 s: 630 s for the 10 min bridges, 35.5 min for Codex (todo 7380).
 */
const DETACH_WAIT_OVERRIDE = process.env.ORKESTRATOR_AGENT_TEST_IDLE_DETACH_WAIT_MS;
const FAKE_MODELS = process.env.ORKESTRATOR_AGENT_TEST_IDLE_FAKE_MODELS === "1";
const IN_CONTAINER = process.env.ORKESTRATOR_AGENT_TEST_IDLE_ENVIRONMENT === "container";

// Budgets (p95) from docs/architecture/recurring-work.md#latency-budgets.
const COMPLETION_BUDGET_MS = 3_000;
const APPROVAL_BUDGET_MS = 2_000;
const BACKGROUND_BUDGET_MS = 4_000;
/** The quiet-backoff ceiling plus one idle read: the bound with every announcement lost. */
const LOST_ANNOUNCEMENT_BOUND_MS = 15_000 + 1_500 + 1_000;
/** One 2 s activity sweep plus the completion budget. */
const SIDEBAR_BOUND_MS = 2_000 + COMPLETION_BUDGET_MS;

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) {
    throw new Error(`dev:status for "${profile}" returned no manifest: ${command.stderr.trim()}`);
  }
  return JSON.parse(command.stdout) as Status;
}

/**
 * Fault seams installed before any app script runs. Frames are dropped at the
 * consumer, after the transport delivered them, so neither the gateway cursor
 * nor a replay can bring them back: a stronger loss than any real one.
 */
function installFaultSeams() {
  type Qa = {
    dropEnvironment: string | null;
    dropped: string[];
    /** Frames delivered per event name, for the evidence record. */
    seen: Record<string, number>;
    /** Frames naming this environment, as `event:resource`, for the evidence record. */
    watch: string | null;
    watched: Record<string, number>;
    hidden: boolean;
    sources: Set<EventSource>;
    setHidden(hidden: boolean): void;
    breakStreams(): number;
  };
  const qa = {
    dropEnvironment: null,
    dropped: [],
    seen: {},
    watch: null,
    watched: {},
    hidden: false,
    sources: new Set<EventSource>(),
  } as unknown as Qa;
  (window as unknown as { __idleQa: Qa }).__idleQa = qa;
  const NativeEventSource = window.EventSource;
  const prototypeOnMessage = Object.getOwnPropertyDescriptor(
    NativeEventSource.prototype,
    "onmessage",
  )!;
  class QaEventSource extends NativeEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      qa.sources.add(this);
    }
    override close() {
      qa.sources.delete(this);
      super.close();
    }
  }
  Object.defineProperty(QaEventSource.prototype, "onmessage", {
    configurable: true,
    get() {
      return prototypeOnMessage.get!.call(this);
    },
    set(handler: ((event: MessageEvent) => unknown) | null) {
      const wrapped =
        typeof handler === "function"
          ? function (this: EventSource, message: MessageEvent) {
              if (typeof message.data === "string") {
                let name = "";
                try {
                  name = String((JSON.parse(message.data) as { event?: unknown }).event ?? "");
                } catch {
                  name = "";
                }
                if (name) qa.seen[name] = (qa.seen[name] ?? 0) + 1;
                if (name && qa.watch && message.data.includes(qa.watch)) {
                  let resource = "";
                  try {
                    const payload = (JSON.parse(message.data) as { payload?: unknown }).payload;
                    const record = (payload ?? {}) as Record<string, unknown>;
                    resource = String(record.resource ?? record.state ?? "");
                  } catch {
                    resource = "";
                  }
                  const key = `${name}:${resource}`;
                  qa.watched[key] = (qa.watched[key] ?? 0) + 1;
                }
                // Mirrors droppableGatewayEvent in idle-observation-live-support.ts.
                const control = name.startsWith("gateway.") || name.endsWith("-stream-connected");
                const drop = qa.dropEnvironment;
                if (drop && name && !control && message.data.includes(drop)) {
                  qa.dropped.push(name);
                  return undefined;
                }
              }
              return handler.call(this, message);
            }
          : handler;
      prototypeOnMessage.set!.call(this, wrapped);
    },
  });
  window.EventSource = QaEventSource as typeof EventSource;

  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")!;
  const hidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden")!;
  Object.defineProperty(Document.prototype, "visibilityState", {
    configurable: true,
    get() {
      return qa.hidden ? "hidden" : visibility.get!.call(this);
    },
  });
  Object.defineProperty(Document.prototype, "hidden", {
    configurable: true,
    get() {
      return qa.hidden ? true : hidden.get!.call(this);
    },
  });
  qa.setHidden = (next: boolean) => {
    qa.hidden = next;
    document.dispatchEvent(new Event("visibilitychange"));
    if (!next) window.dispatchEvent(new Event("focus"));
  };
  qa.breakStreams = () => {
    const sources = Array.from(qa.sources);
    for (const source of sources) {
      source.close();
      source.onerror?.(new Event("error"));
    }
    return sources.length;
  };
}

function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return "";
}

function toolNames(messages: readonly Message[]): string[] {
  const names = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.toolName === "string") names.add(record.toolName);
    Object.values(record).forEach(visit);
  };
  messages.forEach((message) => visit(message.parts));
  return [...names];
}

/** True when an auth status or provider error means "not signed in", not a failure. */
function signedOut(value: unknown): boolean {
  return /sign(ed)? ?(in|out)|not authenticated|unauthenticated|needs? auth|login|expired|credential|401/i.test(
    typeof value === "string" ? value : JSON.stringify(value ?? ""),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Client {
  context: BrowserContext;
  page: Page;
  invoke: Invoke;
  /**
   * Slide the browser session's idle window, as an open renderer does. An
   * agent-test session lapses after 30 idle minutes, which a no-renderer
   * wait (Codex's detach, 7380) outlasts. It reads no agent session.
   */
  keepSignedIn: () => Promise<void>;
  readTimes: number[];
  /** Reads per backend command, for the evidence record. */
  readCommands: Record<string, number>;
}

async function openClient(browser: Browser, status: Status, logicalSessionKey: string) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  await fetchModulesOutsideChromium(context);
  await context.addInitScript(installFaultSeams);
  const page = await context.newPage();
  // These cases use local worktrees. A host's Docker firewall notice must
  // remain visible for container QA, but may be closed for this local suite.
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Docker containers can't reach Orkestrator", exact: true }),
    async (dialog) => {
      test.info().annotations.push({
        type: "host",
        description: "Closed Docker reachability notice for local-worktree qualification",
      });
      await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    },
  );
  const readTimes: number[] = [];
  const readCommands: Record<string, number> = {};
  page.on("request", (request) => {
    if (!request.url().includes("/__orkestrator/invoke")) return;
    const body = request.postData() ?? "";
    if (body.includes('"get_native_agent_') && body.includes(logicalSessionKey)) {
      readTimes.push(Date.now());
      const command = /"command":"([a-z_]+)"/.exec(body)?.[1] ?? "unknown";
      readCommands[command] = (readCommands[command] ?? 0) + 1;
    }
  });
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
  // Through the context, so backend reads keep working after the page closes.
  const invoke: Invoke = async <T>(command: string, args: Record<string, unknown> = {}) => {
    const reply = await context.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    if (!reply.ok()) throw new Error(`${command}: ${await reply.text()}`);
    return ((await reply.json()) as { result: T }).result;
  };
  const keepSignedIn = async () => {
    const reply = await context.request.post(
      new URL("/__orkestrator/session", status.browserUrl!).href,
    );
    if (!reply.ok()) throw new Error(`session refresh: HTTP ${reply.status()}`);
  };
  return { context, page, invoke, keepSignedIn, readTimes, readCommands } satisfies Client;
}

async function openEnvironment(page: Page, projectName: string, environmentName: string) {
  const expand = page.getByRole("button", {
    name: `Expand project ${projectName}`,
  });
  const entry = page.getByText(environmentName, { exact: true }).first();
  await expect(expand.or(entry)).toBeVisible({ timeout: 60_000 });
  // Startup notices can stack (a fake model's key is not a provider login,
  // so the startup check reports none for each) and one can cover another or
  // the sidebar. Clicks are bounded, and the loop ends once none has shown
  // for 2 s; an unbounded click on a covered button would wait forever.
  const labels = [
    "Continue Without Docker",
    "Continue Without GitHub CLI",
    "Continue Without Claude",
    "Continue Without Codex",
  ];
  let quietSince = Date.now();
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    let shown = false;
    for (const label of labels) {
      const button = page.getByRole("button", { name: label, exact: true });
      if (!(await button.isVisible())) continue;
      shown = true;
      await button.click({ timeout: 5_000 }).catch(() => undefined);
    }
    if (shown) quietSince = Date.now();
    else if (Date.now() - quietSince > 2_000) break;
    await page.waitForTimeout(250);
  }
  if (await expand.isVisible()) await expand.click({ timeout: 15_000 });
  await dismissSidebarTooltip(page, projectName);
  await entry.click({ timeout: 15_000 });
}

// A run of several minutes records a trace far over the artifact sanitizer's
// bound, which then refuses it (2026-10-21, 2026-10-23, 2026-11-06), so it is
// opt-in for a short diagnostic run.
test.use({
  trace: process.env.ORKESTRATOR_AGENT_TEST_IDLE_TRACE === "1" ? "retain-on-failure" : "off",
});

test.describe("live idle observation", () => {
  test.skip(
    !LIVE_OPT_IN,
    "opt-in live turns against the isolated fixture; set ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1",
  );

  for (const platform of SELECTED) {
    const label = LABELS[platform];
    test(`${label}: idle observation settles every live case`, async ({ browser }, testInfo) => {
      const detachSelected = CASES.includes("detach");
      const DETACH_WAIT_MS = detachWaitMs(platform, DETACH_WAIT_OVERRIDE);
      test.setTimeout(TURN_TIMEOUT_MS * 9 + (detachSelected ? DETACH_WAIT_MS : 0) + 300_000);
      testInfo.annotations.push({ type: "profile", description: profile });
      /** A content-free progress line; it also keeps the logged runner's watchdog fed. */
      const progress = (step: string) => console.log(`[idle-live] ${platform} ${step}`);
      const status = profileStatus();
      progress("profile status read");
      expect(status.profile, "dev:status answered for a different profile").toBe(profile);
      expect(status.status, `profile "${profile}" is not running`).toBe("ready");

      test.skip(
        FAKE_MODELS &&
          platform !== "claude" &&
          platform !== "codex" &&
          platform !== "pi" &&
          platform !== "opencode",
        "the loopback models stand in for Claude, Codex, Pi and OpenCode only",
      );
      test.skip(
        IN_CONTAINER && platform !== "claude" && platform !== "opencode",
        "the container variant runs Claude and OpenCode (their loopback models run inside the container)",
      );

      const records: Record<string, CaseRecord> = {};
      const summary: Record<string, unknown> = {
        platform,
        profile,
        environmentKind: IN_CONTAINER ? "container" : "local",
        fakeModel: FAKE_MODELS,
        startedAt: new Date().toISOString(),
        cases: records,
      };
      const writeSummary = () => {
        const directory = path.join(
          repositoryRoot,
          "output",
          "agent-testing",
          runId,
          "idle-observation-live",
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, `${platform}.json`),
          `${JSON.stringify(summary, null, 2)}\n`,
        );
      };

      const tabId = `idle-live-${platform}`;
      let environmentId = "";
      let environmentName = "";
      let containerId: string | null = null;
      const fakeModels: FakeModelHandle[] = [];
      /** The fake serving inside the current container, so a rebuild can replace it. */
      let containerFake: FakeModelHandle | null = null;
      /** Puts the profile's OpenCode allowlist back; set only when the run changed it. */
      let restoreOpenCodeAllowlist: (() => Promise<void>) | null = null;
      /** Puts the profile's OpenCode protocol setting back; set only when the run changed it. */
      const logicalSessionKey = () => `env-${environmentId}:${tabId}`;
      let client = await openClient(browser, status, "__pending__");
      progress("signed in");
      try {
        const bootstrapInvoke = client.invoke;
        const config = await bootstrapInvoke<{
          global?: { enabledAgentPlatforms?: string[] };
        }>("get_config").catch(() => null);
        const enabled = config?.global?.enabledAgentPlatforms;
        test.skip(
          Array.isArray(enabled) && !enabled.includes(platform),
          `${label} is not enabled in profile "${profile}" (dev:test --agent-platforms)`,
        );
        const fixture = (await bootstrapInvoke<Project[]>("get_projects")).find(
          (project) => project.localPath === status.testProject,
        );
        expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();
        if (FAKE_MODELS && IN_CONTAINER && platform === "opencode") {
          expect(status.dataDir, "dev:status names no data directory").toBeTruthy();
          // Staged into each runtime the environment gets, so it must be in
          // place before the environment is created and kept until it is gone.
          fakeModels.push(pointProfileOpenCodeAtContainerFake(status.dataDir!));
          restoreOpenCodeAllowlist = await allowOpenCodeFakeProvider(
            (command, args) => client.invoke(command, args),
            PI_FAKE_PROVIDER,
          );
        }
        if (FAKE_MODELS && !IN_CONTAINER) {
          expect(status.dataDir, "dev:status names no data directory").toBeTruthy();
          const fake = await startLocalFakeModel(
            platform as "claude" | "codex" | "pi" | "opencode",
            status.dataDir!,
          );
          fakeModels.push(fake);
          summary.fakeModelOrigin = fake.origin;
          progress("loopback model started");
          if (platform === "opencode") {
            // A connected provider outside the allowlist does not count as signed in.
            restoreOpenCodeAllowlist = await allowOpenCodeFakeProvider(
              (command, args) => client.invoke(command, args),
              PI_FAKE_PROVIDER,
            );
          }
        }
        const environment = await bootstrapInvoke<Environment>("create_environment", {
          projectId: fixture!.id,
          name: `idle-live-${platform}-${Date.now()}`,
          networkAccessMode: "restricted",
          environmentType: IN_CONTAINER ? "containerized" : "local",
        });
        environmentId = environment.id;
        environmentName = environment.name;
        progress("environment created");
        summary.environment = environment.name;
        // Reopen with the read counter keyed to this session.
        await client.context.close();
        client = await openClient(browser, status, logicalSessionKey());
        const identity = () => ({
          environmentId,
          agent: platform,
          logicalSessionKey: logicalSessionKey(),
        });
        const projection = () =>
          client.invoke<Projection | null>("get_native_agent_projection", {
            ...identity(),
            messageLimit: 200,
          });

        // A Pi session names its model; the fake is a provider of its own.
        const model = idleObservationModel(platform, FAKE_MODELS, MODELS.get(platform));
        if (model) summary.model = model;
        const installContainerFake = async (id: string) => {
          const fake =
            platform === "opencode"
              ? await installContainerFakeOpenCode(id)
              : await installContainerFakeClaude(id);
          fakeModels.push(fake);
          containerFake = fake;
          summary.fakeModelOrigin = fake.origin;
        };
        /** Start the current environment with one native tab and its session. */
        const prepareEnvironment = async () => {
          await client.invoke("start_environment", { environmentId });
          if (IN_CONTAINER) {
            const started = await client.invoke<Environment | null>("get_environment", {
              environmentId,
            });
            containerId = started?.containerId ?? null;
            expect(
              containerId,
              "the container environment started without a container",
            ).toBeTruthy();
            if (FAKE_MODELS) await installContainerFake(containerId!);
          }
          const layout = await client.invoke<{ revision?: number } | null>("get_pane_layout", {
            environmentId,
          });
          await client.invoke("save_pane_layout", {
            environmentId,
            expectedRevision: layout?.revision ?? 0,
            layout: {
              version: PANE_LAYOUT_VERSION,
              containerId,
              activePaneId: "pane-idle-live",
              root: {
                kind: "leaf",
                id: "pane-idle-live",
                activeTabId: tabId,
                tabs: [
                  {
                    id: tabId,
                    type: "agent-native",
                    displayTitle: `${label} idle observation`,
                    nativeAgentData: { environmentId, platform, isLocal: !IN_CONTAINER },
                    ...(model ? { initialAgentModel: model } : {}),
                  },
                ],
              },
            },
          });
          try {
            // The tab's `initialAgentModel` belongs to the launcher; pin the model here.
            await client.invoke("ensure_native_agent_session", {
              ...identity(),
              ...(model ? { model } : {}),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (signedOut(message)) {
              summary.skipped = `${label} is not signed in: ${message.slice(0, 300)}`;
              testInfo.skip(true, summary.skipped as string);
            }
            throw error;
          }
        };

        await prepareEnvironment();
        progress("session ready");
        const auth = await client
          .invoke<{ state?: string } | null>("get_native_agent_auth_status", identity())
          .catch(() => null);
        summary.auth = auth?.state ?? null;
        progress(`auth ${summary.auth ?? "unknown"}`);
        if (auth?.state && /signed-out|unauthenticated|authentication-required/.test(auth.state)) {
          summary.skipped = `${label} is not signed in (${auth.state})`;
          testInfo.skip(true, summary.skipped as string);
        }

        const initial = await projection();
        progress("first projection read");
        const approvalModes = initial?.composer?.approvalModes ?? [];
        summary.approvalModes = approvalModes.map((mode) => `${mode.id}:${mode.kind}`);
        summary.initialApprovalMode = initial?.composer?.selectedApprovalModeId ?? null;
        const askMode = approvalModes.find((mode) => mode.kind === "ask");
        const autoMode =
          approvalModes.find((mode) => mode.kind === "auto-approve") ??
          approvalModes.find((mode) => mode.kind === "auto-review");
        const hasModes = (initial?.composer?.modes ?? []).some((mode) => mode.id === "build");
        // A dispatch without a mode runs Claude, Codex and OpenCode in plan
        // mode (`commands-validation.ts`); Cursor, Grok and Pi keep their own.
        const dispatchMode =
          platform === "claude" || platform === "codex" || platform === "opencode"
            ? { mode: "build" }
            : {};
        summary.selectedModel = initial?.composer?.selectedModelId ?? null;
        const setControls = async (update: Record<string, unknown>) => {
          if (Object.keys(update).length === 0) return;
          await client.invoke("update_native_agent_controls", {
            ...identity(),
            update,
          });
        };
        // Tool cases run unattended: the most permissive mode the policy allows.
        await setControls({
          ...(hasModes ? { mode: "build" } : {}),
          ...(autoMode ? { approvalMode: autoMode.id } : {}),
        });

        const page = () => client.page;
        const composeBar = () => page().getByTestId("shared-native-compose-bar");
        const composer = () =>
          composeBar().getByRole("textbox", {
            name: new RegExp(`^Message ${label}`),
          });
        const stopButton = () => composeBar().getByTitle("Stop current query");
        const qa = <T>(script: string) => page().evaluate<T>(script);

        const goToEnvironment = async () => {
          progress("opening the page");
          // The app's `load` event can wait on a long-lived request; the
          // sidebar and composer checks below are what say it is ready.
          await page().goto(status.browserUrl!, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          await openEnvironment(page(), fixture!.name, environmentName);
          progress("environment selected");
          await expect(composer()).toBeVisible({ timeout: 90_000 });
          await page().evaluate((id) => {
            (window as unknown as { __idleQa: { watch: string | null } }).__idleQa.watch = id;
          }, environmentId);
        };
        await goToEnvironment();
        progress("environment open");

        /** Every pending approval is approved for the session, so unattended cases finish. */
        const autoAnswered = new Set<string>();
        const answerPending = async (current: Projection | null) => {
          for (const request of current?.interactions ?? []) {
            if (request.state !== "pending" || autoAnswered.has(request.id)) continue;
            autoAnswered.add(request.id);
            const approval = /approval|permission/.test(request.kind);
            await client
              .invoke("resolve_native_agent_interaction", {
                ...identity(),
                interactionId: request.id,
                resolution: {
                  version: 1,
                  interactionId: request.id,
                  sessionId: request.sessionId,
                  action: approval ? "approve-for-session" : "cancel",
                  resolvedAt: Date.now(),
                },
              })
              .catch(() => undefined);
          }
        };

        const messageIds = async () =>
          new Set(((await projection())?.messages ?? []).map((message) => message.id));

        const freshToolOutputContains = async (previous: ReadonlySet<string>, marker: string) => {
          const results = freshToolResults((await projection())?.messages ?? [], previous);
          for (const result of results) {
            if (shellOutputContainsMarker(result.toolOutput, marker)) return true;
            if (!result.detailRef) continue;
            const detail = await client.invoke<{ toolOutput?: string }>(
              "get_native_agent_tool_details",
              {
                ...identity(),
                detailRef: result.detailRef,
              },
            );
            if (shellOutputContainsMarker(detail.toolOutput, marker)) return true;
          }
          return false;
        };

        // Runtime discovery uses the bridge's no-touch runtime-health read. A
        // full projection/status read here could reattach before we observe it.
        const runtimeState = async () => {
          const update = await client.invoke<{
            status: string;
            value?: {
              sections: {
                runtime?: { availability: string; value?: { summary?: { state?: string } } };
              };
            };
          }>("get_native_agent_discovery_update", {
            ...identity(),
            viewVersion: 1,
            sections: ["runtime"],
          });
          const runtime = update.value?.sections.runtime;
          return runtime?.availability === "ready"
            ? (runtime.value?.summary?.state ?? null)
            : undefined;
        };

        /*
         * Backend side of the idle cost (0049 code item 1): a provider group
         * the activity sweep skips counts as a `native-activity-sweep` cache
         * hit, a group it reads as a miss. Profile-wide counters, so only an
         * otherwise idle profile isolates one provider.
         *
         * And what told the view to read (0049 task 4): every session
         * invalidation the backend emits carries a content-free cause, and
         * the diagnostics count them per platform.
         */
        const sweepCounters = async () => {
          const diagnostics = (await client
            .invoke("get_recurring_work_diagnostics", {})
            .catch(() => null)) as {
            metrics?: {
              kinds?: Record<string, { cacheHits?: number; cacheMisses?: number }>;
            };
            sessionInvalidations?: {
              byScope?: InvalidationCounts;
              discoveryRenewals?: DiscoveryRenewalCounts;
            };
          } | null;
          const sweep = diagnostics?.metrics?.kinds?.["native-activity-sweep"];
          return {
            skipped: sweep?.cacheHits ?? 0,
            read: sweep?.cacheMisses ?? 0,
            invalidations: diagnostics?.sessionInvalidations?.byScope,
            discoveryRenewals: diagnostics?.sessionInvalidations?.discoveryRenewals,
          };
        };

        /**
         * Wait until the backend skips the idle group's sweeps: it has backed
         * off behind a live observation stream. Returns how long that took,
         * or null when it never did within `timeoutMs`.
         */
        const waitForGroupBackoff = async (timeoutMs: number) => {
          const startedAt = Date.now();
          let previous = await sweepCounters();
          while (Date.now() - startedAt < timeoutMs) {
            await sleep(4_000);
            const next = await sweepCounters();
            if (next.skipped - previous.skipped >= 1) return Date.now() - startedAt;
            previous = next;
          }
          return null;
        };

        /** Send through the composer, as a user would. */
        const sendFromComposer = async (prompt: string) => {
          await expect(composer()).toBeVisible({ timeout: 90_000 });
          await composer().fill(prompt);
          const sendButton = composeBar().getByRole("button", {
            name: "Send",
            exact: true,
          });
          const signInFirst = composeBar().getByRole("button", {
            name: /^Sign in to .* before sending/,
          });
          await expect(sendButton.or(signInFirst).first()).toBeVisible({
            timeout: 90_000,
          });
          if (await signInFirst.isVisible()) {
            summary.skipped = `${label} is not signed in in profile "${profile}"`;
            testInfo.skip(true, summary.skipped as string);
          }
          await expect(sendButton).toBeEnabled({ timeout: 90_000 });
          await composer().press("Enter");
          await expect(composer()).toHaveText("", { timeout: 30_000 });
        };

        /** Dispatch from outside the view: another client, a coordinator or mail. */
        const sendFromBackend = async (prompt: string) => {
          const outcome = await client.invoke<{
            outcome: string;
            error?: string;
          }>("dispatch_native_agent_intent", {
            ...identity(),
            prompt,
            requestId: randomUUID(),
            ...dispatchMode,
          });
          if (outcome.outcome !== "accepted") {
            throw new Error(`dispatch ${outcome.outcome}: ${(outcome.error ?? "").slice(0, 200)}`);
          }
        };

        /**
         * Watch backend truth and the page side by side until both settle.
         * Returns when the backend first read idle with the reply, and when
         * the page first showed the reply without a Stop button.
         */
        const watchSettle = async (
          previous: ReadonlySet<string>,
          reply: string,
          options: {
            uiBoundMs: number;
            pageObserves?: boolean;
            timeoutMs?: number;
            onRead?: (current: Projection | null) => Promise<void> | void;
          },
        ) => {
          const deadline = Date.now() + (options.timeoutMs ?? TURN_TIMEOUT_MS);
          let nextProgressAt = Date.now() + 30_000;
          let backendIdleAt: number | null = null;
          let uiSettledAt: number | null = null;
          let sidebarIdleAt: number | null = null;
          let sawWorking = false;
          const sidebarStates: string[] = [];
          const observePage = options.pageObserves !== false;
          for (;;) {
            const current = await projection();
            await options.onRead?.(current);
            await answerPending(current);
            if (current?.turn.phase === "error") {
              if (signedOut(current.turn.error)) {
                summary.skipped = `${label} is not signed in: ${current.turn.error}`;
                testInfo.skip(true, summary.skipped as string);
              }
              throw new Error(`${label} turn failed: ${current.turn.error ?? "no error"}`);
            }
            if (current?.turn.phase && current.turn.phase !== "idle") sawWorking = true;
            if (Date.now() > nextProgressAt) {
              nextProgressAt = Date.now() + 30_000;
              progress(
                `waiting: phase ${current?.turn.phase ?? "none"}, ${current?.messages.length ?? 0} rows`,
              );
            }
            const replied = (current?.messages ?? []).some(
              (message) =>
                message.role === "assistant" &&
                !previous.has(message.id) &&
                textOf(message).includes(reply),
            );
            const running = (current?.backgroundTasks ?? []).some(
              (task) => task.status === "running" || task.status === "pending",
            );
            if (backendIdleAt === null && replied && current?.turn.phase === "idle" && !running) {
              backendIdleAt = Date.now();
            }
            if (observePage && uiSettledAt === null) {
              const shown = (await page().getByText(reply, { exact: true }).count()) > 0;
              const stopped = (await stopButton().count()) === 0;
              if (shown && stopped && backendIdleAt !== null) uiSettledAt = Date.now();
            }
            if (observePage) {
              const sidebar = await sidebarActivity(page(), environmentName);
              if (sidebar !== sidebarStates.at(-1)) sidebarStates.push(sidebar);
              if (sidebarIdleAt === null && backendIdleAt !== null && sidebar === "idle") {
                sidebarIdleAt = Date.now();
              }
            }
            if (backendIdleAt !== null) {
              const uiDone = !observePage || uiSettledAt !== null;
              const sidebarDone = !observePage || sidebarIdleAt !== null;
              const waited = Date.now() - backendIdleAt;
              if (uiDone && sidebarDone) break;
              if (waited > Math.max(options.uiBoundMs, SIDEBAR_BOUND_MS) + 30_000) break;
            }
            if (Date.now() > deadline) {
              const fresh = (current?.messages ?? []).filter(
                (message) => !previous.has(message.id),
              );
              const last = fresh.at(-1);
              throw new Error(
                `${label} never settled: phase ${current?.turn.phase ?? "none"}, reply ${replied}, ` +
                  `${fresh.length} new rows, last ${last ? `${last.role}: ${textOf(last).slice(0, 120)}` : "none"}, ` +
                  `tools ${toolNames(fresh).join(",") || "none"}`,
              );
            }
            await sleep(250);
          }
          const uiLagMs = uiSettledAt === null ? null : uiSettledAt - backendIdleAt!;
          const sidebarLagMs = sidebarIdleAt === null ? null : sidebarIdleAt - backendIdleAt!;
          return {
            backendIdleAt: backendIdleAt!,
            uiLagMs,
            sidebarLagMs,
            sawWorking,
            sidebarStates,
          };
        };

        /**
         * Follow the session until it has been idle with no running task for
         * 8 s. Returns the last busy read and how long the sidebar took to read
         * idle after it, with a compact timeline of the transitions seen.
         */
        const followUntilQuiet = async () => {
          const timeline: string[] = [];
          const startedAt = Date.now();
          let lastBusyAt = startedAt;
          let firstIdleAfterBusy = startedAt;
          let sidebarIdleAt: number | null = null;
          let lastState = "";
          let lastSidebar = "";
          for (;;) {
            const current = await projection();
            await answerPending(current);
            const running = (current?.backgroundTasks ?? []).some(
              (task) => task.status === "running" || task.status === "pending",
            );
            const state = `${current?.turn.phase ?? "none"}${running ? "+task" : ""}`;
            const now = Date.now();
            if (state !== lastState) {
              timeline.push(`${now - startedAt}ms:${state}`);
              lastState = state;
            }
            if (state !== "idle") {
              lastBusyAt = now;
              sidebarIdleAt = null;
            } else if (lastBusyAt >= firstIdleAfterBusy) {
              firstIdleAfterBusy = now;
            }
            const sidebar = await sidebarActivity(page(), environmentName);
            if (sidebar !== lastSidebar) {
              timeline.push(`${now - startedAt}ms:sidebar=${sidebar}`);
              lastSidebar = sidebar;
            }
            if (state === "idle" && sidebar === "idle" && sidebarIdleAt === null) {
              sidebarIdleAt = now;
            }
            if (state === "idle" && sidebarIdleAt !== null && now - lastBusyAt > 8_000) break;
            if (now - startedAt > TURN_TIMEOUT_MS) {
              throw new Error(`never quiet: ${timeline.slice(-8).join(" ")}`);
            }
            await sleep(250);
          }
          return {
            timeline: timeline.slice(0, 24),
            lastBusyAt,
            sidebarLagMs: Math.max(0, sidebarIdleAt! - firstIdleAfterBusy),
          };
        };

        /** Run one case, record it, and never let one case stop the others. */
        const runCase = async (
          name: IdleObservationCase,
          body: (record: CaseRecord) => Promise<void>,
        ) => {
          if (!CASES.includes(name)) return;
          const record: CaseRecord = {
            status: "passed",
            notes: [],
            timings: {},
          };
          records[name] = record;
          const startedAt = Date.now();
          await page()
            .evaluate(() => {
              const seams = (window as unknown as { __idleQa?: { seen: object; watched: object } })
                .__idleQa!;
              seams.seen = {};
              seams.watched = {};
            })
            .catch(() => undefined);
          try {
            await body(record);
          } catch (error) {
            if (error instanceof Error && /Test is skipped/.test(error.message)) throw error;
            record.status = "failed";
            record.error = (error instanceof Error ? error.message : String(error)).slice(0, 600);
            await page()
              .screenshot({
                path: testInfo.outputPath(`${platform}-${name}.png`),
              })
              .catch(() => undefined);
            // Leave the session usable for the next case.
            await page()
              .evaluate(() => {
                const seams = (
                  window as unknown as {
                    __idleQa?: { dropEnvironment: unknown; setHidden: (hidden: boolean) => void };
                  }
                ).__idleQa;
                if (seams) {
                  seams.dropEnvironment = null;
                  seams.setHidden(false);
                }
              })
              .catch(() => undefined);
            await client.context.setOffline(false).catch(() => undefined);
            await client.invoke("stop_native_agent_session", identity()).catch(() => undefined);
            await sleep(5_000);
          } finally {
            record.timings.durationMs = Date.now() - startedAt;
            const seen = await page()
              .evaluate(() => (window as unknown as { __idleQa?: { seen: object } }).__idleQa?.seen)
              .catch(() => undefined);
            if (seen) record.notes.push(`frames seen: ${JSON.stringify(seen)}`);
            const watched = await page()
              .evaluate(
                () => (window as unknown as { __idleQa?: { watched: object } }).__idleQa?.watched,
              )
              .catch(() => undefined);
            if (watched)
              record.notes.push(`frames naming the environment: ${JSON.stringify(watched)}`);
            writeSummary();
          }
          console.log(`[idle-live] ${platform} ${name}: ${record.status}`);
        };

        const expectWithin = (
          record: CaseRecord,
          key: string,
          value: number | null,
          bound: number,
        ) => {
          record.timings[key] = value;
          if (value === null) throw new Error(`${key}: never observed`);
          if (value > bound) throw new Error(`${key}: ${value} ms is over the ${bound} ms bound`);
        };
        const noteBudget = (
          record: CaseRecord,
          key: string,
          value: number | null,
          budget: number,
        ) => {
          if (value !== null && value > budget) {
            record.notes.push(`${key} ${value} ms is over the ${budget} ms p95 budget`);
          }
        };
        const nonce = () => Math.floor(100_000 + Math.random() * 900_000).toString();
        const replyPrompt = (word: string) =>
          `Reply with exactly the uppercase form of this text and nothing else: ${word.toLowerCase()}. Do not use any tools.`;

        // Keep the warm-up busy across the 2 s activity sweep, so even a fast
        // provider response exercises the sidebar's working -> idle transition.
        {
          const word = `IDLEQA-WARM-${nonce()}`;
          const before = await messageIds();
          await sendFromComposer(
            `Run a shell command that sleeps for 5 seconds, then prints ${word}. ` +
              `Wait for it to finish, then reply with exactly ${word} and nothing else.`,
          );
          progress("warm-up sent");
          const warm = await watchSettle(before, word, {
            uiBoundMs: COMPLETION_BUDGET_MS,
          });
          summary.warmup = {
            uiLagMs: warm.uiLagMs,
            sidebarLagMs: warm.sidebarLagMs,
            sidebarStates: warm.sidebarStates,
          };
          // Qualify the browser probe against a real provider turn before any
          // fault injection. Backend activity alone cannot prove the row read.
          expect(warm.sidebarStates).toContain("working");
          expect(warm.sidebarStates.at(-1)).toBe("idle");
          expect(warm.sidebarStates).not.toContain("unknown");
        }

        await runCase("missed-final", async (record) => {
          // Long enough for a qualified provider's view to reach its 15 s step.
          const idleStart = Date.now();
          const sweepsBefore = await sweepCounters();
          await sleep(35_000);
          // Whether the backend backed the idle group off behind its bridge's
          // observation stream (skips), or kept every sweep (an older bridge).
          const sweepsAfter = await sweepCounters();
          record.timings.backendGroupReads = sweepsAfter.read - sweepsBefore.read;
          record.timings.backendGroupSkips = sweepsAfter.skipped - sweepsBefore.skipped;
          record.timings.idleReadsBefore = readCadence(
            client.readTimes,
            idleStart,
            Date.now(),
          ).reads;
          record.timings.idleMaxGapMs = readCadence(
            client.readTimes,
            idleStart,
            Date.now(),
          ).maxGapMs;
          await page().evaluate((id) => {
            const seams = (
              window as unknown as {
                __idleQa: { dropEnvironment: string | null };
              }
            ).__idleQa;
            seams.dropEnvironment = id;
          }, environmentId);
          const word = `IDLEQA-MISSED-${nonce()}`;
          const before = await messageIds();
          const dispatchedAt = Date.now();
          await sendFromBackend(replyPrompt(word));
          const settled = await watchSettle(before, word, {
            uiBoundMs: LOST_ANNOUNCEMENT_BOUND_MS,
          });
          record.timings.turnMs = settled.backendIdleAt - dispatchedAt;
          // The sweep announces the idle edge up to one 2 s sweep after the
          // projection reads idle: keep dropping until it has surely gone by.
          await sleep(6_000);
          const regressed = (await stopButton().count()) > 0;
          const dropped = await qa<string[]>("window.__idleQa.dropped.splice(0)");
          await page().evaluate(() => {
            (
              window as unknown as {
                __idleQa: { dropEnvironment: string | null };
              }
            ).__idleQa.dropEnvironment = null;
          });
          record.notes.push(`dropped frames: ${[...new Set(dropped)].join(", ") || "none"}`);
          record.timings.droppedFrames = dropped.length;
          expectWithin(record, "uiLagMs", settled.uiLagMs, LOST_ANNOUNCEMENT_BOUND_MS);
          noteBudget(record, "uiLagMs", settled.uiLagMs, COMPLETION_BUDGET_MS);
          record.timings.sidebarLagMs = settled.sidebarLagMs;
          if (settled.sidebarLagMs === null) {
            record.notes.push("sidebar never left working/unknown while its frames were dropped");
          }
          // Once frames flow again, the next announced turn settles inside the budget.
          const after = `IDLEQA-AFTER-${nonce()}`;
          const beforeAfter = await messageIds();
          await sendFromComposer(replyPrompt(after));
          const recovered = await watchSettle(beforeAfter, after, {
            uiBoundMs: COMPLETION_BUDGET_MS,
          });
          expectWithin(record, "afterUiLagMs", recovered.uiLagMs, COMPLETION_BUDGET_MS + 1_000);
          expectWithin(record, "afterSidebarLagMs", recovered.sidebarLagMs, SIDEBAR_BOUND_MS);
          expect(regressed, "the settled view stays settled with its frames dropped").toBe(false);
          if (!dropped.includes("native-agent-session-activity")) {
            record.status = "not-exercised";
            record.notes.push("no activity announcement was emitted, so none was missed");
          }
        });

        await runCase("bridge-restart", async (record) => {
          if (IN_CONTAINER || (platform !== "claude" && platform !== "codex")) {
            record.status = "skipped";
            record.notes.push("restarts a local Claude or Codex bridge only");
            return;
          }
          // Precondition: the idle group is backed off behind the stream.
          const backoffMs = await waitForGroupBackoff(60_000);
          record.timings.backoffReachedMs = backoffMs;
          if (backoffMs === null)
            throw new Error("the idle group never backed off before the restart");
          const before = await client.invoke<{ pid: number | null }>(
            `get_local_${platform}_server_status`,
            { environmentId },
          );
          const sweepsBefore = await sweepCounters();
          const restartStartedAt = Date.now();
          await client.invoke(`stop_local_${platform}_server_cmd`, { environmentId });
          const restarted = await client.invoke<{ pid: number | null }>(
            `start_local_${platform}_server_cmd`,
            { environmentId },
          );
          record.timings.restartMs = Date.now() - restartStartedAt;
          expect(restarted.pid, "the bridge came back as a new process").toBeGreaterThan(0);
          expect(restarted.pid).not.toBe(before.pid);
          // Long enough for the group to back off again if the stream came
          // back, and for a group left un-backed to show it.
          await sleep(30_000);
          const sweepsAfter = await sweepCounters();
          record.timings.groupReadsAfterRestart = sweepsAfter.read - sweepsBefore.read;
          record.timings.groupSkipsAfterRestart = sweepsAfter.skipped - sweepsBefore.skipped;
          expect(
            record.timings.groupReadsAfterRestart,
            "the group is read again after the bridge restarted",
          ).toBeGreaterThan(0);
          if ((record.timings.groupSkipsAfterRestart ?? 0) === 0) {
            record.notes.push(
              "the group kept every sweep after the restart (stream not live again)",
            );
          }
          // A turn started from outside the view, while the group is idle again.
          const word = `IDLEQA-RESTART-${nonce()}`;
          const ids = await messageIds();
          const dispatchedAt = Date.now();
          await sendFromBackend(replyPrompt(word));
          const settled = await watchSettle(ids, word, { uiBoundMs: COMPLETION_BUDGET_MS });
          record.timings.turnMs = settled.backendIdleAt - dispatchedAt;
          record.timings.sidebarLagMs = settled.sidebarLagMs;
          expectWithin(record, "uiLagMs", settled.uiLagMs, COMPLETION_BUDGET_MS + 1_000);
          noteBudget(record, "uiLagMs", settled.uiLagMs, COMPLETION_BUDGET_MS);
          expectWithin(record, "sidebarLagMs", settled.sidebarLagMs, SIDEBAR_BOUND_MS);
          // And the stream backs the group off again afterwards.
          record.timings.backoffAfterTurnMs = requireRecoveredBackoff(
            await waitForGroupBackoff(60_000),
          );
        });

        await runCase("async-question", async (record) => {
          if (platform !== "codex") {
            record.status = "skipped";
            record.notes.push("only Codex has an async question (request_user_input_async)");
            return;
          }
          // Back off first, as missed-final does, so the question meets a quiet view.
          const idleStart = Date.now();
          const sweepsBefore = await sweepCounters();
          await sleep(35_000);
          const sweepsIdle = await sweepCounters();
          record.timings.backendGroupSkips = sweepsIdle.skipped - sweepsBefore.skipped;
          record.timings.idleMaxGapMs = readCadence(
            client.readTimes,
            idleStart,
            Date.now(),
          ).maxGapMs;
          const title = "Which codeword should I use?";
          const choice = "IDLEQA_BETA";
          const word = `IDLEQA-ASKED-${nonce()}`;
          const before = await messageIds();
          const asked = (current: Projection | null) =>
            (current?.messages ?? []).some(
              (message) =>
                !before.has(message.id) &&
                Array.isArray(message.parts) &&
                (message.parts as Array<{ type?: unknown }>).some(
                  (part) => part.type === "async-question",
                ),
            );
          const card = () => page().getByRole("group", { name: title, exact: true });
          let askedAt: number | null = null;
          let askedWhileIdle = false;
          let cardShownAt: number | null = null;
          const dispatchedAt = Date.now();
          await sendFromBackend(asyncQuestionPrompt(title, word));
          const settled = await watchSettle(before, word, {
            uiBoundMs: COMPLETION_BUDGET_MS,
            onRead: async (current) => {
              if (askedAt === null && asked(current)) {
                askedAt = Date.now();
                askedWhileIdle = current?.turn.phase === "idle";
              }
              if (cardShownAt === null && (await card().count()) > 0) cardShownAt = Date.now();
            },
          });
          record.timings.turnMs = settled.backendIdleAt - dispatchedAt;
          if (askedAt === null) {
            record.status = "not-exercised";
            record.notes.push("the turn ended without an async question");
            return;
          }
          record.notes.push(`question first read while ${askedWhileIdle ? "idle" : "running"}`);
          await expect(card()).toBeVisible({ timeout: LOST_ANNOUNCEMENT_BOUND_MS });
          cardShownAt ??= Date.now();
          expectWithin(
            record,
            "cardLagMs",
            Math.max(0, cardShownAt - askedAt),
            COMPLETION_BUDGET_MS + 1_000,
          );
          noteBudget(record, "cardLagMs", record.timings.cardLagMs ?? null, COMPLETION_BUDGET_MS);
          expectWithin(record, "uiLagMs", settled.uiLagMs, COMPLETION_BUDGET_MS + 1_000);
          expectWithin(record, "sidebarLagMs", settled.sidebarLagMs, SIDEBAR_BOUND_MS);
          const sweepsAsked = await sweepCounters();
          record.notes.push(
            `invalidations by cause while asked: ${JSON.stringify(
              invalidationCauseDelta(sweepsIdle.invalidations, sweepsAsked.invalidations, platform),
            )}`,
          );
          // Answer from the card, as a user would; the answer is a new prompt.
          const answerBefore = await messageIds();
          await card().getByRole("button", { name: choice, exact: true }).click();
          await page().getByRole("button", { name: "Send answer", exact: true }).click();
          const answered = await watchSettle(answerBefore, `${CODEWORD_REPLY_PREFIX}${choice}`, {
            uiBoundMs: COMPLETION_BUDGET_MS,
          });
          expectWithin(record, "answerUiLagMs", answered.uiLagMs, COMPLETION_BUDGET_MS + 1_000);
          expectWithin(record, "answerSidebarLagMs", answered.sidebarLagMs, SIDEBAR_BOUND_MS);
          await expect(page().getByText("Your answer was sent to Codex.")).toBeVisible({
            timeout: COMPLETION_BUDGET_MS + 1_000,
          });
        });

        await runCase("approval", async (record) => {
          // A provider without an "ask" composer mode asks only under the
          // execution policy, which a session takes when it is created: run
          // this case in a second environment created with `approvals: "ask"`.
          const home = { environmentId, environmentName, containerId, containerFake };
          let policyEnvironment: Environment | null = null;
          try {
            if (askMode) {
              await setControls({ approvalMode: askMode.id });
            } else {
              policyEnvironment = await client.invoke<Environment>("create_environment", {
                projectId: fixture!.id,
                name: `idle-ask-${platform}-${Date.now()}`,
                networkAccessMode: "restricted",
                // The same kind as the run's own, so a container run asks in a container.
                environmentType: IN_CONTAINER ? "containerized" : "local",
                agentSettings: { executionPolicy: { approvals: "ask" } },
              });
              environmentId = policyEnvironment.id;
              environmentName = policyEnvironment.name;
              record.notes.push(
                'no "ask" composer mode: ran under an environment policy of approvals "ask"',
              );
              await prepareEnvironment();
              await goToEnvironment();
            }
            const file = `idleqa-approval-${nonce()}.txt`;
            const word = `IDLEQA-APPROVED-${nonce()}`;
            const before = await messageIds();
            await sendFromComposer(
              `Run this exact shell command once: printf idleqa > ${file}\nThen reply with exactly ${word} and nothing else.`,
            );
            let parked: Interaction | null = null;
            let parkedAt = 0;
            const deadline = Date.now() + TURN_TIMEOUT_MS;
            while (!parked) {
              const current = await projection();
              parked =
                current?.interactions.find(
                  (request) =>
                    request.state === "pending" && /approval|permission/.test(request.kind),
                ) ?? null;
              if (parked) parkedAt = Date.now();
              else if (
                current?.turn.phase === "idle" &&
                Date.now() > deadline - TURN_TIMEOUT_MS + 30_000
              ) {
                const replied = current.messages.some(
                  (message) => !before.has(message.id) && textOf(message).includes(word),
                );
                if (replied) {
                  record.status = "not-exercised";
                  record.notes.push("the provider ran the command without asking in its ask mode");
                  return;
                }
              }
              if (Date.now() > deadline) throw new Error("no approval parked");
              if (!parked) await sleep(250);
            }
            record.notes.push(`interaction kind ${parked.kind}`);
            const confirm = page().getByRole("button", {
              name: parked.presentation.confirmLabel ?? "Continue",
              exact: true,
            });
            await expect(confirm.first()).toBeVisible({ timeout: 30_000 });
            expectWithin(record, "cardLagMs", Date.now() - parkedAt, APPROVAL_BUDGET_MS + 1_000);
            noteBudget(record, "cardLagMs", record.timings.cardLagMs ?? null, APPROVAL_BUDGET_MS);
            await expect
              .poll(() => sidebarActivity(page(), environmentName), {
                timeout: SIDEBAR_BOUND_MS,
              })
              .toBe("waiting");
            // Parked requests must survive the tab being hidden and come back visible.
            await qa("window.__idleQa.setHidden(true)");
            await sleep(10_000);
            await qa("window.__idleQa.setHidden(false)");
            const pendingAfterHidden = (await projection())?.interactions.find(
              (request) => request.id === parked!.id,
            );
            expect(pendingAfterHidden?.state, "the parked request is still pending").toBe(
              "pending",
            );
            await expect(confirm.first()).toBeVisible({
              timeout: APPROVAL_BUDGET_MS + 1_000,
            });
            await confirm.first().click();
            autoAnswered.add(parked.id);
            const settled = await watchSettle(before, word, {
              uiBoundMs: COMPLETION_BUDGET_MS,
            });
            expectWithin(record, "uiLagMs", settled.uiLagMs, COMPLETION_BUDGET_MS + 1_000);
            expectWithin(record, "sidebarLagMs", settled.sidebarLagMs, SIDEBAR_BOUND_MS);
            const resolved = (await projection())?.interactions.find(
              (request) => request.id === parked!.id,
            );
            record.notes.push(`request after approval: ${resolved?.state ?? "gone"}`);
          } finally {
            if (policyEnvironment) {
              await client
                .invoke("stop_environment", {
                  environmentId: policyEnvironment.id,
                })
                .catch(() => undefined);
              await client
                .invoke("delete_environment", {
                  environmentId: policyEnvironment.id,
                })
                .catch(() => undefined);
              environmentId = home.environmentId;
              environmentName = home.environmentName;
              // The policy environment's container and fake went with it.
              containerId = home.containerId;
              containerFake = home.containerFake;
              await goToEnvironment();
            } else {
              await setControls(autoMode ? { approvalMode: autoMode.id } : {});
            }
          }
        });

        await runCase("subagents", async (record) => {
          const word = `IDLEQA-SUB-${nonce()}`;
          const child = `child-${nonce()}`;
          const before = await messageIds();
          await sendFromComposer(
            [
              "Use your sub-agent or task delegation tool to start exactly one sub-agent.",
              `Give it this task: reply with the text ${child}. Run it in the background if your tool supports that.`,
              `Wait for the sub-agent to finish, then reply with exactly ${word} and nothing else.`,
              "If you have no sub-agent tool, reply with exactly NO-SUBAGENT-TOOL.",
            ].join(" "),
          );
          let maxTasks = 0;
          const settled = await watchSettle(before, word, {
            uiBoundMs: COMPLETION_BUDGET_MS,
            onRead: (current) => {
              maxTasks = Math.max(maxTasks, current?.backgroundTasks?.length ?? 0);
            },
          }).catch(async (error: unknown) => {
            const current = await projection();
            const refused = (current?.messages ?? []).some(
              (message) => !before.has(message.id) && textOf(message).includes("NO-SUBAGENT-TOOL"),
            );
            if (refused && current?.turn.phase === "idle") return null;
            throw error;
          });
          const current = await projection();
          const fresh = (current?.messages ?? []).filter((message) => !before.has(message.id));
          const tools = toolNames(fresh);
          const cards = freshToolStates(fresh, before).filter((state) =>
            state.startsWith("subagent:"),
          );
          record.notes.push(
            `tools: ${tools.join(", ") || "none"}; background tasks seen: ${maxTasks}; ` +
              `sub-agent cards: ${cards.join(", ") || "none"}`,
          );
          if (!settled) {
            record.status = "not-exercised";
            record.notes.push("the provider reported no sub-agent tool");
            await expect(stopButton()).toHaveCount(0, {
              timeout: COMPLETION_BUDGET_MS + 1_000,
            });
            return;
          }
          expectWithin(record, "uiLagMs", settled.uiLagMs, COMPLETION_BUDGET_MS + 1_000);
          expectWithin(record, "sidebarLagMs", settled.sidebarLagMs, SIDEBAR_BOUND_MS);
          const leftRunning = (current?.backgroundTasks ?? []).filter(
            (task) => task.status === "running" || task.status === "pending",
          );
          expect(leftRunning, "no sub-agent left running after the parent settled").toEqual([]);
          expect(current?.completionBlockedByBackgroundTasks ?? false).toBe(false);
          expect(cards, "no sub-agent card still reads as running").not.toContain(
            "subagent:pending",
          );
          if (
            !tools.some((name) => /task|agent|spawn|delegate|sub/i.test(name)) &&
            maxTasks === 0 &&
            cards.length === 0
          ) {
            record.status = "not-exercised";
            record.notes.push("no sub-agent tool call or task was observed");
          }
        });

        await runCase("background", async (record) => {
          const marker = `IDLEQA-BGOUT-${nonce()}`;
          const word = `IDLEQA-BG-${nonce()}`;
          const before = await messageIds();
          const tasksBefore = new Set(
            ((await projection())?.backgroundTasks ?? []).map((task) => task.id),
          );
          const sentAt = Date.now();
          await sendFromComposer(
            [
              `Start this shell command as a background task and do not wait for it: sleep 20; echo ${marker}`,
              `Right after starting it, reply with exactly ${word} and nothing else. Do not run any other command.`,
            ].join(" "),
          );
          let sawRunningTask = false;
          let taskShownAt: number | null = null;
          let taskStartedAt: number | null = null;
          const settled = await watchSettle(before, word, {
            uiBoundMs: BACKGROUND_BUDGET_MS,
            timeoutMs: TURN_TIMEOUT_MS + 60_000,
            onRead: async (current) => {
              const running = (current?.backgroundTasks ?? []).some(
                (task) => task.status === "running",
              );
              if (running && taskStartedAt === null) taskStartedAt = Date.now();
              if (running) sawRunningTask = true;
              if (running && taskShownAt === null) {
                for (const task of current?.backgroundTasks ?? []) {
                  if (task.status !== "running") continue;
                  const indicator = page().locator(
                    `[data-background-task-id=${JSON.stringify(task.id)}][data-background-task-status="running"]`,
                  );
                  if (await indicator.isVisible()) {
                    taskShownAt = Date.now();
                    break;
                  }
                }
              }
            },
          });
          // Rows present once our turn settled: a late output row must arrive after them.
          const presentAtSettle = new Set(
            ((await projection())?.messages ?? []).map((message) => message.id),
          );
          record.timings.backgroundIndicatorLagMs =
            taskShownAt !== null && taskStartedAt !== null ? taskShownAt - taskStartedAt : null;
          if (!sawRunningTask) {
            record.status = "not-exercised";
            record.notes.push("no running background task appeared in the projection");
            record.notes.push(
              `tool calls when the turn settled: ${freshToolStates((await projection())?.messages ?? [], before).join(", ") || "none"}`,
            );
          } else {
            expectWithin(
              record,
              "backgroundIndicatorLagMs",
              record.timings.backgroundIndicatorLagMs ?? null,
              BACKGROUND_BUDGET_MS,
            );
          }
          // watchSettle waits for the tasks too, so this is the lag after the last one ended.
          expectWithin(record, "uiLagMs", settled.uiLagMs, COMPLETION_BUDGET_MS + 1_000);
          // A provider may report the finished task in a turn of its own (Claude
          // does), so the sidebar is judged against the last busy read, not the
          // first idle one. The timeline says which happened.
          const quiet = await followUntilQuiet();
          record.notes.push(`timeline after the reply: ${quiet.timeline.join(" ") || "quiet"}`);
          record.timings.followUpBusyMs = quiet.lastBusyAt - settled.backendIdleAt;
          record.timings.firstSidebarLagMs = settled.sidebarLagMs;
          expectWithin(record, "sidebarLagMs", quiet.sidebarLagMs, SIDEBAR_BOUND_MS);
          await expect(stopButton()).toHaveCount(0, {
            timeout: COMPLETION_BUDGET_MS + 1_000,
          });
          /*
           * Claude never puts a backgrounded command's stdout in a tool result
           * (0049 task 2): the call's result says the command moved to the
           * background, and the finished task carries its output as a file.
           * Either proves the output reached the view; the text is never kept.
           */
          const outputFiles = completedTaskOutputFiles(
            (await projection())?.backgroundTasks,
            tasksBefore,
          );
          const readOutputFile = (file: string) => {
            if (containerId) return readContainerFile(containerId, file);
            try {
              return readFileSync(file, "utf8");
            } catch {
              return undefined;
            }
          };
          const evidence = backgroundOutputEvidence(
            await freshToolOutputContains(before, marker),
            outputFiles,
            readOutputFile,
            marker,
          );
          record.notes.push(
            `task output evidence: ${evidence} (${outputFiles.length} completed task output files)`,
          );
          if (sawRunningTask) {
            expect(
              evidence,
              "the exercised background task's output reached a tool result or its task output file",
            ).not.toBe("none");
          } else {
            // No task surface (Codex, OpenCode): read what the transcript
            // shows once the 20 s command has surely ended, with no turn from us.
            // OpenCode promises to resume the session with the output, so
            // allow it 25 s for that.
            const endedBy = sentAt + 45_000 - Date.now();
            if (endedBy > 0) await sleep(endedBy);
            const ended = await projection();
            const afterEnd = freshToolStates(ended?.messages ?? [], before);
            record.notes.push(
              `tool calls after the command ended: ${afterEnd.join(", ") || "none"}`,
            );
            // Content-free: which rows arrived after our turn settled, and which
            // of them show the marker as emitted output. The prompt we sent holds
            // the marker too, so user rows and the echoed command never count.
            const lateRows = (ended?.messages ?? []).filter(
              (message) => !presentAtSettle.has(message.id),
            );
            const lateOutputIds = lateOutputRowIds(ended?.messages ?? [], presentAtSettle, marker);
            record.notes.push(
              `rows after the turn settled: ${
                lateRows
                  .map(
                    (message) =>
                      `${message.role}(marker ${textOf(message).includes(marker)}, emitted ${lateOutputIds.includes(message.id)}, parts ${Array.isArray(message.parts) ? message.parts.map((part) => (part as { type?: string }).type ?? "?").join("+") : "none"})`,
                  )
                  .join(",") || "none"
              }; late output rows: ${lateOutputIds.length}; phase ${ended?.turn.phase ?? "none"}`,
            );
            // OpenCode promises to resume the session with the output, so a
            // backgrounded command whose output never arrives is a failure,
            // not an unexercised case.
            if (platform === "opencode" && evidence === "none") {
              expect(
                lateOutputIds.length,
                "OpenCode resumed the idle session with the background command's output",
              ).toBeGreaterThan(0);
            }
            // A foreground run (Pi) returns the output in the
            // call's own result, which proves nothing about a late arrival.
            if (lateOutputIds.length > 0 && evidence === "none") {
              // The provider resumed the idle session with the output
              // (OpenCode): an idle, backed-off page must catch up with no turn of
              // ours, on that row itself rather than on our prompt's bubble.
              const lateRowOnPage = page()
                .locator(
                  lateOutputIds
                    .map((id) => `[data-chat-message-key=${JSON.stringify(id)}]`)
                    .join(", "),
                )
                .getByText(marker)
                .first();
              const lookedAt = Date.now();
              await expect(lateRowOnPage).toBeVisible({
                timeout: LOST_ANNOUNCEMENT_BOUND_MS,
              });
              record.timings.lateOutputShownMs = Date.now() - lookedAt;
              // A backgrounded command whose output reached the idle page is
              // exercised, task surface or not.
              record.status = "passed";
              record.notes.push(
                "exercised: the output arrived in a resumed turn of the idle session",
              );
            }
            // Nothing reports the end of a command the turn left running, so its
            // card must not keep claiming to run on an idle thread (#2064).
            expect(
              afterEnd.filter((state) => state.endsWith(":pending")),
              "a tool call still reads running on the idle thread",
            ).toEqual([]);
            record.notes.push(
              `late output in a tool result: ${await freshToolOutputContains(before, marker)}`,
            );
            await expect(stopButton()).toHaveCount(0);
          }
        });

        await runCase("reconnect", async (record) => {
          const word = `IDLEQA-RECONNECT-${nonce()}`;
          const before = await messageIds();
          await sendFromComposer(
            `Run this shell command and wait for it: sleep 8\nThen reply with exactly ${word} and nothing else.`,
          );
          await expect(stopButton()).toBeVisible({ timeout: 30_000 });
          await client.context.setOffline(true);
          const broken = await qa<number>("window.__idleQa.breakStreams()");
          record.notes.push(`event streams cut: ${broken}`);
          // Stay offline until the turn has finished on the backend.
          await expect
            .poll(
              async () => {
                const current = await projection();
                await answerPending(current);
                return (
                  current?.turn.phase === "idle" &&
                  current.messages.some(
                    (message) => !before.has(message.id) && textOf(message).includes(word),
                  )
                );
              },
              { timeout: TURN_TIMEOUT_MS },
            )
            .toBe(true);
          await sleep(3_000);
          const stuckWhileOffline = (await stopButton().count()) > 0;
          record.notes.push(`Stop still shown while offline: ${stuckWhileOffline}`);
          const onlineAt = Date.now();
          await client.context.setOffline(false);
          await expect(page().getByText(word, { exact: true }).first()).toBeVisible({
            timeout: 30_000,
          });
          await expect(stopButton()).toHaveCount(0, { timeout: 30_000 });
          const settledLag = Date.now() - onlineAt;
          await expect
            .poll(() => sidebarActivity(page(), environmentName), {
              timeout: 30_000,
            })
            .toBe("idle");
          const sidebarLag = Date.now() - onlineAt;
          // The reconnect backoff can add its own first delay before the reconcile.
          expectWithin(record, "uiLagAfterOnlineMs", settledLag, COMPLETION_BUDGET_MS + 5_000);
          noteBudget(record, "uiLagAfterOnlineMs", settledLag, COMPLETION_BUDGET_MS);
          expectWithin(record, "sidebarLagAfterOnlineMs", sidebarLag, SIDEBAR_BOUND_MS + 5_000);
        });

        await runCase("hidden", async (record) => {
          const word = `IDLEQA-HIDDEN-${nonce()}`;
          const before = await messageIds();
          await sendFromComposer(
            `Run this shell command and wait for it: sleep 5\nThen reply with exactly ${word} and nothing else.`,
          );
          await qa("window.__idleQa.setHidden(true)");
          const hiddenAt = Date.now();
          await expect
            .poll(
              async () => {
                const current = await projection();
                await answerPending(current);
                return (
                  current?.turn.phase === "idle" &&
                  current.messages.some(
                    (message) => !before.has(message.id) && textOf(message).includes(word),
                  )
                );
              },
              { timeout: TURN_TIMEOUT_MS },
            )
            .toBe(true);
          await sleep(8_000);
          const hiddenWindow = readCadence(client.readTimes, hiddenAt + 2_000, Date.now());
          record.timings.readsWhileHidden = hiddenWindow.reads;
          expect(
            hiddenWindow.reads,
            "a hidden document issues no native session reads after draining",
          ).toBe(0);
          const visibleAt = Date.now();
          await qa("window.__idleQa.setHidden(false)");
          await expect(page().getByText(word, { exact: true }).first()).toBeVisible({
            timeout: 30_000,
          });
          await expect(stopButton()).toHaveCount(0, { timeout: 30_000 });
          expectWithin(
            record,
            "uiLagAfterVisibleMs",
            Date.now() - visibleAt,
            COMPLETION_BUDGET_MS + 1_000,
          );
          await expect
            .poll(() => sidebarActivity(page(), environmentName), {
              timeout: SIDEBAR_BOUND_MS,
            })
            .toBe("idle");
        });

        await runCase("no-renderer", async (record) => {
          const word = `IDLEQA-HEADLESS-${nonce()}`;
          const before = await messageIds();
          const prompt = `Run this shell command and wait for it: sleep 5\nThen reply with exactly ${word} and nothing else.`;
          await sendFromComposer(prompt);
          await expect(stopButton()).toBeVisible({ timeout: 30_000 });
          // Close every renderer; backend reads go through the surviving context.
          await client.page.close();
          let loadAt = 0;
          try {
            await expect
              .poll(
                async () => {
                  const current = await projection();
                  await answerPending(current);
                  return (
                    current?.turn.phase === "idle" &&
                    current.messages.some(
                      (message) => !before.has(message.id) && textOf(message).includes(word),
                    )
                  );
                },
                { timeout: TURN_TIMEOUT_MS },
              )
              .toBe(true);
            // With no renderer, the backend aggregate alone must leave working.
            const backendIdleAt = Date.now();
            await expect
              .poll(
                async () =>
                  (
                    await client.invoke<{ agentActivityState?: string } | null>("get_environment", {
                      environmentId,
                    })
                  )?.agentActivityState,
                { timeout: SIDEBAR_BOUND_MS + 5_000, intervals: [250] },
              )
              .toBe("idle");
            record.timings.backendAggregateLagMs = Date.now() - backendIdleAt;
          } finally {
            // Restore a renderer even if a backend poll failed, so later cases
            // cannot inherit a closed page and misattribute the failure.
            await client.context.close();
            client = await openClient(browser, status, logicalSessionKey());
            loadAt = Date.now();
            await goToEnvironment();
          }
          await expect(page().getByText(word, { exact: true }).first()).toBeVisible({
            timeout: 30_000,
          });
          await expect(stopButton()).toHaveCount(0);
          record.timings.rehydrateMs = Date.now() - loadAt;
          await expect
            .poll(() => sidebarActivity(page(), environmentName), {
              timeout: SIDEBAR_BOUND_MS,
            })
            .toBe("idle");
          const prompts = ((await projection())?.messages ?? []).filter(
            (message) => message.role === "user" && textOf(message) === prompt,
          );
          expect(prompts.length, "the exact submitted prompt appears once after rehydration").toBe(
            1,
          );
        });

        await runCase("steer", async (record) => {
          // OpenCode is the platform whose composer steer had not been driven
          // through the UI (todo 0008 task 7); the other fakes do not script it.
          if (platform !== "opencode") {
            record.status = "skipped";
            record.notes.push("composer steer is checked on OpenCode only");
            return;
          }
          const baseWord = `IDLEQA-STEER-BASE-${nonce()}`;
          const steeredWord = `IDLEQA-STEERED-${nonce()}`;
          const steerText = `Reply with exactly ${steeredWord} and nothing else.`;
          const before = await messageIds();
          await sendFromComposer(
            `Run this shell command and wait for it: sleep 8\nThen reply with exactly ${baseWord} and nothing else.`,
          );
          await expect(stopButton()).toBeVisible({ timeout: 30_000 });
          // Enter while a turn runs queues the prompt; its strip offers Steer.
          await composer().fill(steerText);
          await composer().press("Enter");
          const strip = page().getByTestId("compose-queue-strip");
          const steer = strip.getByRole("button", { name: /^Steer queued prompt 1 of \d+:/ });
          await expect(steer).toBeVisible({ timeout: 15_000 });
          const steeredAt = Date.now();
          await steer.click();
          await expect(steer).toHaveCount(0, { timeout: 15_000 });
          record.timings.steerAcceptedMs = Date.now() - steeredAt;
          await expect
            .poll(
              async () => {
                const current = await projection();
                return (
                  current?.turn.phase === "idle" &&
                  current.messages.some(
                    (message) => !before.has(message.id) && textOf(message).includes(steeredWord),
                  )
                );
              },
              { timeout: TURN_TIMEOUT_MS },
            )
            .toBe(true);
          record.timings.steeredReplyMs = Date.now() - steeredAt;
          const check = async (when: string) => {
            const fresh = ((await projection())?.messages ?? []).filter(
              (message) => !before.has(message.id),
            );
            // Steered into the running turn: it ended on the steer's reply and
            // never gave the reply the first prompt asked for.
            expect(
              fresh.some(
                (message) => message.role === "assistant" && textOf(message).includes(baseWord),
              ),
              `${when}: the first prompt's own reply`,
            ).toBe(false);
            expect(
              fresh.filter((message) => message.role === "user" && textOf(message) === steerText)
                .length,
              `${when}: the steer appears once`,
            ).toBe(1);
          };
          await check("live");
          // Rehydrate from a fresh mount, then check the same picture.
          await goToEnvironment();
          await expect(page().getByText(steeredWord, { exact: true }).first()).toBeVisible({
            timeout: 30_000,
          });
          await expect(stopButton()).toHaveCount(0);
          await check("after reload");
          await expect
            .poll(() => sidebarActivity(page(), environmentName), {
              timeout: SIDEBAR_BOUND_MS,
            })
            .toBe("idle");
        });

        await runCase("rebuild", async (record) => {
          if (!IN_CONTAINER || platform !== "opencode" || !containerId) {
            record.status = "skipped";
            record.notes.push("the preserving rebuild is checked on OpenCode in a container only");
            return;
          }
          containerId = await runContainerRebuildCase(
            {
              environmentId,
              containerId,
              invoke: () => client.invoke,
              projection,
              sendFromBackend,
              waitForReply: async (previous, word) => {
                await watchSettle(previous, word, {
                  uiBoundMs: COMPLETION_BUDGET_MS,
                  pageObserves: false,
                });
              },
              stopFake: async () => {
                const fake = containerFake;
                if (!fake) return;
                containerFake = null;
                const index = fakeModels.indexOf(fake);
                if (index >= 0) fakeModels.splice(index, 1);
                await fake.stop();
              },
              installFake: installContainerFake,
              reopenAndShow: async (words) => {
                await goToEnvironment();
                for (const word of words) {
                  await expect(page().getByText(word, { exact: true }).first()).toBeVisible({
                    timeout: 30_000,
                  });
                }
                await expect(stopButton()).toHaveCount(0);
              },
              replyPrompt,
              nonce,
              progress,
              sleep,
            },
            record,
          );
        });

        await runCase("detach", async (record) => {
          const before = await projection();
          // The no-touch read, not the projection's cached runtime: a provider
          // that reports attachment must start the wait attached, or the
          // detached reading afterwards proves no transition.
          await expect
            .poll(runtimeState, { timeout: 40_000, intervals: [500] })
            .not.toBeUndefined();
          let stateAtStart = await runtimeState();
          if (stateAtStart === "detached") {
            await expect
              .poll(runtimeState, { timeout: 40_000, intervals: [1_000] })
              .toBe("attached")
              .catch(() => undefined);
            stateAtStart = await runtimeState();
          }
          record.notes.push(`no-touch runtime before the wait: ${stateAtStart ?? "unknown"}`);
          // Codex's tab reads refresh its thread's idle clock by design, so an
          // open tab keeps the thread attached: wait with no renderer (7380).
          const closesRenderer = detachWaitClosesRenderer(platform);
          if (closesRenderer) {
            await client.page.close();
            record.notes.push(
              "renderer closed for the wait: the provider's tab reads keep it attached",
            );
          }
          const sweepsBefore = await sweepCounters();
          const idleStart = Date.now();
          const commandsBefore = { ...client.readCommands };
          let sawStop = false;
          let sawWorkingSidebar = false;
          const sidebarReadings = new Set<string>();
          while (Date.now() - idleStart < DETACH_WAIT_MS) {
            await sleep(15_000);
            if (closesRenderer) {
              // No renderer slides the browser session meanwhile.
              await client.keepSignedIn();
              // The no-touch read: stop as soon as the thread is released.
              const state = await runtimeState();
              if (state === "detached") {
                record.timings.detachObservedAfterMs = Date.now() - idleStart;
                break;
              }
              // No page reads to print during a 35 min wait: keep the logged
              // runner's no-output watchdog fed (content-free).
              progress(
                `detach wait ${Math.round((Date.now() - idleStart) / 60_000)} min: runtime ${state ?? "unknown"}`,
              );
              continue;
            }
            if ((await stopButton().count()) > 0) sawStop = true;
            const sidebar = await sidebarActivity(page(), environmentName);
            sidebarReadings.add(sidebar);
            if (sidebar === "working") sawWorkingSidebar = true;
          }
          record.notes.push(`idle sidebar readings: ${[...sidebarReadings].join(",") || "none"}`);
          const cadence = readCadence(client.readTimes, idleStart + 30_000, Date.now());
          record.timings.idleReadsPerMinute = cadence.perMinute;
          record.timings.idleMaxGapMs = cadence.maxGapMs;
          record.notes.push(
            `idle read gaps: ${JSON.stringify(
              gapHistogram(client.readTimes, idleStart + 30_000, Date.now()),
            )}`,
          );
          const commandsDuring = Object.fromEntries(
            Object.entries(client.readCommands)
              .map(([name, count]) => [name, count - (commandsBefore[name] ?? 0)] as const)
              .filter(([, count]) => count > 0),
          );
          record.notes.push(`idle reads by command: ${JSON.stringify(commandsDuring)}`);
          // Sampled after the read counts so it is not one of them.
          const sweepsAfter = await sweepCounters();
          record.timings.backendGroupReads = sweepsAfter.read - sweepsBefore.read;
          record.timings.backendGroupSkips = sweepsAfter.skipped - sweepsBefore.skipped;
          const invalidations = invalidationCauseDelta(
            sweepsBefore.invalidations,
            sweepsAfter.invalidations,
            platform,
          );
          record.timings.idleInvalidations = invalidations.total ?? 0;
          record.notes.push(`idle invalidations by cause: ${JSON.stringify(invalidations)}`);
          // #2062: which discovery section announced, and which paths moved.
          record.notes.push(
            `idle discovery announcements by section: ${JSON.stringify(
              discoveryRenewalDelta(
                sweepsBefore.discoveryRenewals,
                sweepsAfter.discoveryRenewals,
                platform,
              ),
            )}`,
          );
          await expect
            .poll(runtimeState, { timeout: 40_000, intervals: [500] })
            .not.toBeUndefined();
          const detachedState = await runtimeState();
          record.notes.push(`no-touch runtime after idle wait: ${detachedState ?? "unknown"}`);
          const cadenceOnly = DETACH_WAIT_MS < idleDetachWindowMs(platform);
          // Claude reports whether its CLI is open (attached) or released by
          // the idle window (detached), as Cursor and Pi report their SDK
          // sessions and Codex reports whether its thread is loaded in the
          // current app-server (todo 7380). Only OpenCode exposes no session
          // detach state: its server lifetime is not a session observation.
          const reportsSessionDetach = detachedState === "attached" || detachedState === "detached";
          if (cadenceOnly || !reportsSessionDetach) {
            record.status = "not-exercised";
            record.notes.push(
              cadenceOnly
                ? "shortened wait: cadence only, idle detachment was not qualified"
                : "provider exposes no session detach state on its no-touch runtime observation",
            );
          } else {
            expect(stateAtStart, "the session was attached when the idle wait began").toBe(
              "attached",
            );
            await expect.poll(runtimeState, { timeout: 40_000, intervals: [500] }).toBe("detached");
          }
          expect(sawStop, "Stop never shows on an idle tab").toBe(false);
          if (!closesRenderer) {
            // A probe that cannot see the row reads `unknown`, which would pass the next check blind.
            expect(sidebarReadings.has("idle"), "the sidebar was read as idle while idle").toBe(
              true,
            );
          }
          expect(sawWorkingSidebar, "the sidebar never shows working on an idle tab").toBe(false);
          const word = `IDLEQA-REATTACH-${nonce()}`;
          // Reuse the pre-wait IDs: no tab-facing read between observing
          // detachment and dispatching the turn that must reattach it.
          const ids = new Set((before?.messages ?? []).map((message) => message.id));
          if (closesRenderer) {
            // A turn from outside the view, then a renderer again: a reopened
            // tab's own reads would re-attach before the turn did.
            await sendFromBackend(replyPrompt(word));
            const settled = await watchSettle(ids, word, {
              uiBoundMs: COMPLETION_BUDGET_MS,
              pageObserves: false,
            });
            record.timings.backendTurnSettledMs = settled.backendIdleAt - idleStart;
            await client.context.close();
            client = await openClient(browser, status, logicalSessionKey());
            await goToEnvironment();
            await expect(page().getByText(word, { exact: true }).first()).toBeVisible({
              timeout: 30_000,
            });
          } else {
            await sendFromComposer(replyPrompt(word));
            const settled = await watchSettle(ids, word, {
              uiBoundMs: COMPLETION_BUDGET_MS,
            });
            expectWithin(record, "uiLagMs", settled.uiLagMs, COMPLETION_BUDGET_MS + 1_000);
            expectWithin(record, "sidebarLagMs", settled.sidebarLagMs, SIDEBAR_BOUND_MS);
          }
          if (!cadenceOnly && reportsSessionDetach) {
            await expect.poll(runtimeState, { timeout: 40_000, intervals: [500] }).toBe("attached");
            record.notes.push("observed detached then attached through no-touch runtime discovery");
          }
          expect(before?.sessionId, "the original session exists").toBeTruthy();
          expect((await projection())?.sessionId).toBe(before?.sessionId);
        });

        const failures = failedCases(records);
        summary.finishedAt = new Date().toISOString();
        writeSummary();
        testInfo.annotations.push({
          type: "idle cases",
          description: Object.entries(records)
            .map(([name, record]) => `${name}=${record.status}`)
            .join(" "),
        });
        expect(failures, "every live idle-observation case settled").toEqual([]);
      } finally {
        await withFakeModelCleanup(fakeModels, async () => {
          writeSummary();
          if (environmentId) {
            await client.invoke("stop_environment", { environmentId }).catch(() => undefined);
            await client.invoke("delete_environment", { environmentId }).catch(() => undefined);
          }
          if (restoreOpenCodeAllowlist) {
            await restoreOpenCodeAllowlist().catch((error: unknown) => {
              summary.allowlistRestoreError = String(error).slice(0, 300);
              writeSummary();
            });
          }
          await client.context.close().catch(() => undefined);
        });
      }
    });
  }
});
