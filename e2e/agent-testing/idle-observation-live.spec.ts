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
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  failedCases,
  freshToolResults,
  gapHistogram,
  readCadence,
  selectedCases,
  shellOutputContainsMarker,
  sidebarActivityFromClass,
  type CaseRecord,
  type IdleObservationCase,
} from "./idle-observation-live-support";
import { dismissSidebarTooltip } from "./sidebar-tooltip";

type Status = {
  status: string;
  profile?: string;
  browserUrl?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
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
  backgroundTasks?: Array<{ id: string; status: string; description?: string }>;
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
/** Longer than every bridge's 10 min idle detach. */
const DETACH_WAIT_MS = Number(process.env.ORKESTRATOR_AGENT_TEST_IDLE_DETACH_WAIT_MS ?? "630000");

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
  readTimes: number[];
  /** Reads per backend command, for the evidence record. */
  readCommands: Record<string, number>;
}

async function openClient(browser: Browser, status: Status, logicalSessionKey: string) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  await context.addInitScript(installFaultSeams);
  const page = await context.newPage();
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
  return { context, page, invoke, readTimes, readCommands } satisfies Client;
}

async function openEnvironment(page: Page, projectName: string, environmentName: string) {
  const expand = page.getByRole("button", {
    name: `Expand project ${projectName}`,
  });
  const entry = page.getByText(environmentName, { exact: true }).first();
  await expect(expand.or(entry)).toBeVisible({ timeout: 60_000 });
  for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
    const continueButton = page.getByRole("button", {
      name: label,
      exact: true,
    });
    if (await continueButton.isVisible()) await continueButton.click();
  }
  if (await expand.isVisible()) await expand.click();
  await dismissSidebarTooltip(page, projectName);
  await entry.click();
}

/** The sidebar icon's activity state for one environment row. */
async function sidebarActivity(page: Page, environmentName: string): Promise<string> {
  const className = await page
    .evaluate((name) => {
      const label = Array.from(document.querySelectorAll("span")).find(
        (span) => span.textContent === name && span.id,
      );
      let node: Element | null = label ?? null;
      while (node && !node.querySelector("svg.shrink-0.transition-colors")) {
        node = node.parentElement;
      }
      return node?.querySelector("svg.shrink-0.transition-colors")?.getAttribute("class") ?? null;
    }, environmentName)
    .catch(() => null);
  return sidebarActivityFromClass(className);
}

test.describe("live idle observation", () => {
  test.skip(
    !LIVE_OPT_IN,
    "opt-in live turns against the isolated fixture; set ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1",
  );

  for (const platform of SELECTED) {
    const label = LABELS[platform];
    test(`${label}: idle observation settles every live case`, async ({ browser }, testInfo) => {
      const detachSelected = CASES.includes("detach");
      test.setTimeout(TURN_TIMEOUT_MS * 9 + (detachSelected ? DETACH_WAIT_MS : 0) + 300_000);
      testInfo.annotations.push({ type: "profile", description: profile });
      const status = profileStatus();
      expect(status.profile, "dev:status answered for a different profile").toBe(profile);
      expect(status.status, `profile "${profile}" is not running`).toBe("ready");

      const records: Record<string, CaseRecord> = {};
      const summary: Record<string, unknown> = {
        platform,
        profile,
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
      const logicalSessionKey = () => `env-${environmentId}:${tabId}`;
      let client = await openClient(browser, status, "__pending__");
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
      const environment = await bootstrapInvoke<Environment>("create_environment", {
        projectId: fixture!.id,
        name: `idle-live-${platform}-${Date.now()}`,
        networkAccessMode: "restricted",
        environmentType: "local",
      });
      environmentId = environment.id;
      environmentName = environment.name;
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

      const model = MODELS.get(platform);
      if (model) summary.model = model;
      /** Start the current environment with one native tab and its session. */
      const prepareEnvironment = async () => {
        await client.invoke("start_environment", { environmentId });
        const layout = await client.invoke<{ revision?: number } | null>("get_pane_layout", {
          environmentId,
        });
        await client.invoke("save_pane_layout", {
          environmentId,
          expectedRevision: layout?.revision ?? 0,
          layout: {
            version: PANE_LAYOUT_VERSION,
            containerId: null,
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
                  nativeAgentData: { environmentId, platform, isLocal: true },
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

      try {
        await prepareEnvironment();
        const auth = await client
          .invoke<{ state?: string } | null>("get_native_agent_auth_status", identity())
          .catch(() => null);
        summary.auth = auth?.state ?? null;
        if (auth?.state && /signed-out|unauthenticated|authentication-required/.test(auth.state)) {
          summary.skipped = `${label} is not signed in (${auth.state})`;
          testInfo.skip(true, summary.skipped as string);
        }

        const initial = await projection();
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
          await page().goto(status.browserUrl!);
          await openEnvironment(page(), fixture!.name, environmentName);
          await expect(composer()).toBeVisible({ timeout: 90_000 });
          await page().evaluate((id) => {
            (window as unknown as { __idleQa: { watch: string | null } }).__idleQa.watch = id;
          }, environmentId);
        };
        await goToEnvironment();

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
          let backendIdleAt: number | null = null;
          let uiSettledAt: number | null = null;
          let sidebarIdleAt: number | null = null;
          let sawWorking = false;
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
            if (observePage && sidebarIdleAt === null && backendIdleAt !== null) {
              const sidebar = await sidebarActivity(page(), environmentName);
              if (sidebar === "idle") sidebarIdleAt = Date.now();
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

        // A warm-up turn starts the provider runtime, so later cases time observation, not boot.
        {
          const word = `IDLEQA-WARM-${nonce()}`;
          const before = await messageIds();
          await sendFromComposer(replyPrompt(word));
          const warm = await watchSettle(before, word, {
            uiBoundMs: COMPLETION_BUDGET_MS,
          });
          summary.warmup = {
            uiLagMs: warm.uiLagMs,
            sidebarLagMs: warm.sidebarLagMs,
          };
        }

        await runCase("missed-final", async (record) => {
          // Long enough for a qualified provider's view to reach its 15 s step.
          const idleStart = Date.now();
          await sleep(35_000);
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

        await runCase("approval", async (record) => {
          // A provider without an "ask" composer mode asks only under the
          // execution policy, which a session takes when it is created: run
          // this case in a second environment created with `approvals: "ask"`.
          const home = { environmentId, environmentName };
          let policyEnvironment: Environment | null = null;
          try {
            if (askMode) {
              await setControls({ approvalMode: askMode.id });
            } else {
              policyEnvironment = await client.invoke<Environment>("create_environment", {
                projectId: fixture!.id,
                name: `idle-ask-${platform}-${Date.now()}`,
                networkAccessMode: "restricted",
                environmentType: "local",
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
          record.notes.push(
            `tools: ${tools.join(", ") || "none"}; background tasks seen: ${maxTasks}`,
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
          if (
            !tools.some((name) => /task|agent|spawn|delegate|sub/i.test(name)) &&
            maxTasks === 0
          ) {
            record.status = "not-exercised";
            record.notes.push("no sub-agent tool call or task was observed");
          }
        });

        await runCase("background", async (record) => {
          const marker = `IDLEQA-BGOUT-${nonce()}`;
          const word = `IDLEQA-BG-${nonce()}`;
          const before = await messageIds();
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
          record.timings.backgroundIndicatorLagMs =
            taskShownAt !== null && taskStartedAt !== null ? taskShownAt - taskStartedAt : null;
          if (!sawRunningTask) {
            record.status = "not-exercised";
            record.notes.push("no running background task appeared in the projection");
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
          const shownMarker = await freshToolOutputContains(before, marker);
          record.notes.push(`task output reached the transcript: ${shownMarker}`);
          if (sawRunningTask) {
            expect(
              shownMarker,
              "the exercised background task produced fresh tool-result output",
            ).toBe(true);
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

        await runCase("detach", async (record) => {
          const before = await projection();
          record.notes.push(`runtime before: ${before?.runtime?.state ?? "unknown"}`);
          const idleStart = Date.now();
          const commandsBefore = { ...client.readCommands };
          let sawStop = false;
          let sawWorkingSidebar = false;
          while (Date.now() - idleStart < DETACH_WAIT_MS) {
            await sleep(15_000);
            if ((await stopButton().count()) > 0) sawStop = true;
            if ((await sidebarActivity(page(), environmentName)) === "working") {
              sawWorkingSidebar = true;
            }
          }
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
          await expect
            .poll(runtimeState, { timeout: 40_000, intervals: [500] })
            .not.toBeUndefined();
          const detachedState = await runtimeState();
          record.notes.push(`no-touch runtime after idle wait: ${detachedState ?? "unknown"}`);
          const cadenceOnly = DETACH_WAIT_MS < 630_000;
          // OpenCode's server lifetime and Codex's engine health are not a
          // session detach observation; Claude currently exposes no state here.
          const reportsSessionDetach = detachedState === "attached" || detachedState === "detached";
          if (cadenceOnly || !reportsSessionDetach) {
            record.status = "not-exercised";
            record.notes.push(
              cadenceOnly
                ? "shortened wait: cadence only, idle detachment was not qualified"
                : "provider exposes no session detach state on its no-touch runtime observation",
            );
          } else {
            await expect.poll(runtimeState, { timeout: 40_000, intervals: [500] }).toBe("detached");
          }
          expect(sawStop, "Stop never shows on an idle tab").toBe(false);
          expect(sawWorkingSidebar, "the sidebar never shows working on an idle tab").toBe(false);
          const word = `IDLEQA-REATTACH-${nonce()}`;
          // Reuse the pre-wait IDs: no tab-facing read between observing
          // detachment and dispatching the turn that must reattach it.
          const ids = new Set((before?.messages ?? []).map((message) => message.id));
          await sendFromComposer(replyPrompt(word));
          const settled = await watchSettle(ids, word, {
            uiBoundMs: COMPLETION_BUDGET_MS,
          });
          expectWithin(record, "uiLagMs", settled.uiLagMs, COMPLETION_BUDGET_MS + 1_000);
          expectWithin(record, "sidebarLagMs", settled.sidebarLagMs, SIDEBAR_BOUND_MS);
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
        writeSummary();
        await client.invoke("stop_environment", { environmentId }).catch(() => undefined);
        await client.invoke("delete_environment", { environmentId }).catch(() => undefined);
        await client.context.close().catch(() => undefined);
      }
    });
  }
});
