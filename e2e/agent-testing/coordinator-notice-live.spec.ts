/**
 * The coordinator notice hierarchy between two real `dev:test` profiles on
 * one host, on fixture Claude accounts and a loopback provider (to-do 7542
 * tasks 2 to 4). Run it with `mise run test:agent:coordinator:notice-live`,
 * which starts the provider, then two disposable credential-free profiles
 * that offer Claude and Pi, runs this file and resets both.
 *
 * Opt-in: skipped unless `ORKESTRATOR_AGENT_TEST_COORDINATOR_NOTICE_LIVE=1`.
 * `ORKESTRATOR_AGENT_TEST_PROFILE` is the command node ("desk"),
 * `ORKESTRATOR_AGENT_TEST_NOTICE_LEAF_PROFILE` the leaf and
 * `ORKESTRATOR_AGENT_TEST_NOTICE_FAKE_ORIGIN` the provider
 * (`coordinator-notice-fake-model.ts`). Both profiles were started with
 * `ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN` set to that origin, so their plan
 * usage reads go there; each profile's isolated Claude `settings.json` (never
 * `~/.claude`) sends the CLI's model calls there and its other HTTPS traffic
 * to a closed loopback proxy, and the leaf's isolated Pi `models.json` (never
 * `~/.pi`) names it. Every login is a fixture token in the profile's own
 * account directory. Nothing is billed and nothing logs in. The real
 * backends, node link, account registry and automatic switcher, Claude
 * bridges and pinned CLI, coordinators, Control MCP, build pipeline, leaf
 * outbox and the command node's collector all run; only the provider is
 * fake.
 *
 * - **Task 2: stops reach the command node once, grouped.** On the leaf a
 *   native tab, a delegated worker (launched by the leaf's Pi coordinator
 *   with `launch_environment`) and a build pipeline run on one limited
 *   account. The provider parks their refusals until all three have asked,
 *   then refuses them at once. The command node's Claude coordinator, on an
 *   account with headroom, must be woken once with one notice listing one
 *   tab, one delegated worker and one pipeline session; the leaf's
 *   coordinator must get none.
 * - **Task 3: a coordinator on the limited login moves first.** The command
 *   node's coordinator runs on its own entry of the login a leaf tab then
 *   stops on (same email), with automatic switching on and an account with
 *   headroom. The command node must move to that account, unpinned, before
 *   the wake, and no turn may run on the limited login.
 * - **Task 4: a stop raised while the link is down arrives once.** The
 *   command node is stopped, a leaf tab stops on a third limited login, the
 *   leaf profile is stopped and started again, then the command node is
 *   started. Its coordinator must be woken exactly once with that stop.
 *
 * What it cannot prove: the provider's real refusal wording and timing
 * (manual-test checklist, from retired to-do 1250), a real model's reaction
 * to a notice, or a link between two machines: one host shares a kernel and
 * loopback.
 *
 * Writes a content-free summary to
 * `output/agent-testing/<run>/coordinator-notice-live/summary.json`.
 */
import { expect, test, type BrowserContext } from "./browser-test";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
} from "@orkestrator/protocol/coordinator";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { outlivingProcessEnv } from "../../tests/private-tmpdir";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import {
  FIXTURE_ACCOUNTS,
  fixtureClaudeToken,
  launchPrompt,
  runMarker,
  type FixtureAccount,
  type NoticeFacts,
  type SessionKind,
} from "./coordinator-notice-fake-model-script";
import {
  attachLeaf,
  pointPiAt,
  sharedProject,
  signIn,
  until,
  waitForLeafLink,
  type Profile,
} from "./coordinator-two-node-support";
import { devTestRestartArgs } from "./profile-restart-args";
import { profileStatus, repositoryRoot, type Invoke } from "./slash-command-live-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_NOTICE_LIVE === "1";
const deskProfile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-notice-desk";
const leafProfile = process.env.ORKESTRATOR_AGENT_TEST_NOTICE_LEAF_PROFILE ?? "qa-notice-leaf";
const fakeOrigin = process.env.ORKESTRATOR_AGENT_TEST_NOTICE_FAKE_ORIGIN ?? "";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? deskProfile;

const PI = {
  id: "notice-qa",
  name: "Coordinator notice fake",
  model: "notice-qa-1",
  modelName: "Notice QA 1",
  apiKey: "notice-qa-not-a-key",
};
const PI_REF = `${PI.id}/${PI.model}`;
const SHARED_GIT_URL = "https://github.com/orkestrator-qa/notice-hierarchy.git";
const CHECKOUT = "notice-qa";
/** A port nothing listens on: the CLI's HTTPS traffic to any real host fails here. */
const CLOSED_PROXY = "http://127.0.0.1:9";
const LIMIT_SUBJECT = /stopped on the "claude" limit/;

type ClaudeCall = {
  account: FixtureAccount | "unknown";
  marker?: { kind: SessionKind; run: string };
  refused: boolean;
  parked: boolean;
};
type Wake = { by: "claude" | "pi"; account?: FixtureAccount | "unknown"; notices: NoticeFacts[] };
type Calls = {
  claude: ClaudeCall[];
  wakes: Wake[];
  piCompletions: number;
  piToolCalls: Record<string, number>;
  usageReads: Record<string, number>;
  refused: number;
  hold: boolean;
  parked: number;
};
type MailSummary = {
  id: string;
  from: { kind: string };
  placement: string;
  placementReason?: string;
  subject?: string;
};
type Coordinator = {
  invoke: Invoke;
  projectId: string;
  conversationId: string;
  environmentId: string;
  tabId: string;
  logicalSessionKey: string;
  agent: "claude" | "pi";
};
type StoredAccounts = {
  active?: Record<string, string>;
  autoSwitch?: Record<
    string,
    { pin?: unknown; lastSwitch?: { reason?: string; to?: string; from?: string } }
  >;
};

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

async function calls(): Promise<Calls> {
  return (await (await fetch(`${fakeOrigin}/__calls`)).json()) as Calls;
}

async function control(route: "hold" | "release"): Promise<void> {
  const response = await fetch(`${fakeOrigin}/__${route}`, { method: "POST" });
  expect(response.ok, `fake /__${route}`).toBe(true);
}

/** Reads or replaces one backend store of a running profile through Bun (`backend-store.ts`). */
function backendStore(
  dataDir: string,
  file: string,
  action: "read" | "write",
  value?: unknown,
): { value: unknown } | null {
  const result = spawnSync(
    "bun",
    [path.join(import.meta.dirname, "backend-store.ts"), dataDir, file, action],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: value === undefined ? undefined : JSON.stringify(value),
    },
  );
  if (result.status !== 0) throw new Error(`backend-store ${action} failed`);
  return action === "read" ? (JSON.parse(result.stdout) as { value: unknown } | null) : null;
}

function insideProfile(status: Profile["status"], ...parts: string[]): string {
  const root = path.resolve(status.dataDir!);
  const file = path.join(root, ...parts);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("A fixture path escapes the profile");
  return file;
}

/**
 * The profile's isolated Claude `settings.json` (every account directory
 * links it) sends the CLI to the provider; returns the restore.
 */
function pointClaudeAt(status: Profile["status"]): () => void {
  const file = insideProfile(status, "agent-credentials", "claude", "settings.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const restore = snapshotFixtureFiles([file]);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: fakeOrigin,
          HTTPS_PROXY: CLOSED_PROXY,
          https_proxy: CLOSED_PROXY,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
          DISABLE_AUTOUPDATER: "1",
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return restore;
}

/**
 * Fixture Claude accounts in the profile's own account directory and
 * registry; returns their ids and the registry restore. Each login is a
 * fixture token only the provider knows.
 */
function stageAccounts(
  status: Profile["status"],
  names: FixtureAccount[],
  active: FixtureAccount,
): { ids: Record<string, string>; restore: () => void } {
  const original = backendStore(status.dataDir!, "agent-accounts.json", "read");
  const ids: Record<string, string> = {};
  for (const name of names) {
    const id = randomUUID();
    ids[name] = id;
    const home = insideProfile(status, "agent-accounts", "claude", id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const { email } = FIXTURE_ACCOUNTS[name];
    writeFileSync(
      path.join(home, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: fixtureClaudeToken(name),
          refreshToken: `fixture-refresh-${name}`,
          expiresAt: Date.now() + 7 * 24 * 3_600_000,
          scopes: ["user:inference", "user:profile"],
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_20x",
        },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: {
          emailAddress: email,
          accountUuid: `fixture-${name}`,
          organizationUuid: "fixture-org",
        },
      }),
      { mode: 0o600 },
    );
  }
  backendStore(status.dataDir!, "agent-accounts.json", "write", {
    version: 1,
    accounts: names.map((name) => ({
      id: ids[name],
      platform: "claude",
      label: name,
      createdAt: "2026-11-11T00:00:00Z",
      identity: { email: FIXTURE_ACCOUNTS[name].email },
    })),
    active: { claude: ids[active] },
  });
  return {
    ids,
    restore: () => {
      if (original) backendStore(status.dataDir!, "agent-accounts.json", "write", original.value);
    },
  };
}

function storedAccounts(status: Profile["status"]): StoredAccounts {
  return (backendStore(status.dataDir!, "agent-accounts.json", "read")?.value ??
    {}) as StoredAccounts;
}

/** Claude and Pi native, Pi on the provider, Pi allowed as a coordinator. */
async function configure(invoke: Invoke): Promise<() => Promise<void>> {
  const config = await invoke<{ global: Record<string, unknown> }>("get_config");
  const previous = {
    coordinatorProviderTiers: config.global.coordinatorProviderTiers,
    agentSettings: config.global.agentSettings,
  };
  const agentSettings = (config.global.agentSettings ?? {}) as Record<string, unknown>;
  const platforms = (agentSettings.platforms ?? {}) as Record<string, Record<string, unknown>>;
  await invoke("update_global_config", {
    global: {
      ...config.global,
      coordinatorProviderTiers: "provider-configured",
      agentSettings: {
        ...agentSettings,
        platforms: {
          ...platforms,
          claude: { ...platforms.claude, mode: "native" },
          pi: { ...platforms.pi, mode: "native", model: PI_REF },
        },
      },
    },
  });
  return async () => {
    const current = await invoke<{ global: Record<string, unknown> }>("get_config");
    await invoke("update_global_config", { global: { ...current.global, ...previous } });
  };
}

/** A fresh main coordinator conversation on `agent`, with its session started. */
async function mainCoordinator(
  invoke: Invoke,
  projectId: string,
  agent: "claude" | "pi",
): Promise<Coordinator> {
  let snapshot = await invoke<CoordinatorSnapshot>("ensure_project_coordinator", { projectId });
  const earlier = coordinatorMainConversation(snapshot.workspace);
  if (earlier?.agent) {
    snapshot = await invoke<CoordinatorSnapshot>("close_coordinator_conversation", {
      projectId,
      conversationId: earlier.id,
    });
  }
  if (!coordinatorMainConversation(snapshot.workspace)) {
    snapshot = await invoke<CoordinatorSnapshot>("create_coordinator_conversation", { projectId });
  }
  const conversation = coordinatorMainConversation(snapshot.workspace)!;
  expect(snapshot.controlMcp.running, "Control MCP is not running").toBe(true);
  snapshot = await invoke<CoordinatorSnapshot>("assign_coordinator_conversation_agent", {
    projectId,
    conversationId: conversation.id,
    agent,
  });
  const environmentId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
  await invoke("ensure_native_agent_session", {
    environmentId,
    agent,
    logicalSessionKey: conversation.logicalSessionKey,
    ...(agent === "pi" ? { model: PI_REF } : { model: "sonnet" }),
  });
  return {
    invoke,
    projectId,
    conversationId: conversation.id,
    environmentId,
    tabId: conversation.tabId,
    logicalSessionKey: conversation.logicalSessionKey,
    agent,
  };
}

async function mailbox(coordinator: Coordinator): Promise<MailSummary[]> {
  const snapshot = await coordinator.invoke<{ messages: MailSummary[] }>("get_agent_mail_mailbox", {
    environmentId: coordinator.environmentId,
    tabId: coordinator.tabId,
  });
  return snapshot.messages;
}

const limitNotices = (messages: MailSummary[]) =>
  messages.filter((m) => m.from.kind === "system" && LIMIT_SUBJECT.test(m.subject ?? ""));

/** A running local environment of the shared project. */
async function environment(invoke: Invoke, projectId: string, name: string): Promise<string> {
  const created = await invoke<{ id: string }>("create_environment", {
    projectId,
    name,
    environmentType: "local",
  });
  await invoke("start_environment", { environmentId: created.id });
  await until(
    `environment ${name} to run`,
    () => invoke<{ status: string }>("get_environment", { environmentId: created.id }),
    (environment) => environment.status === "running",
    120_000,
  );
  return created.id;
}

/** One native Claude tab turn carrying `marker`. */
async function nativeTurn(invoke: Invoke, environmentId: string, marker: string): Promise<void> {
  const identity = {
    environmentId,
    agent: "claude",
    logicalSessionKey: `env-${environmentId}:notice-qa`,
    origin: "interactive-native",
  };
  await invoke("ensure_native_agent_session", {
    ...identity,
    sessionMode: "build",
    model: "sonnet",
  });
  await invoke("dispatch_native_agent_prompt", {
    ...identity,
    mode: "build",
    prompt: `Do the fixture task. ${marker}`,
    requestId: randomUUID(),
  });
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed in the QA checkout`);
  return result.stdout.trim();
}

/** Waits until no Claude call has reached the provider for 15 s. */
async function settle(): Promise<Calls> {
  let settled = await calls();
  for (let quiet = 0; quiet < 3;) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const next = await calls();
    quiet =
      next.claude.length === settled.claude.length && next.wakes.length === settled.wakes.length
        ? quiet + 1
        : 0;
    settled = next;
  }
  return settled;
}

function runAsync(command: string, args: string[], timeoutMs: number) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function stopProfile(name: string): Promise<void> {
  expect(await runAsync("mise", ["run", "dev:stop", "--profile", name], 120_000)).toBe(0);
  await until(
    `profile ${name} to stop`,
    async () => profileStatus(name).status,
    (status) => status !== "ready",
    60_000,
  );
}

/**
 * Starts a stopped profile again with the selection it was started with. It
 * inherits this run's environment, so the usage origin and headless mode
 * hold; the isolated runner stops and resets it like the first launcher.
 */
async function startProfile(name: string): Promise<void> {
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: name,
    flavor: "agent-test",
  });
  const stored = JSON.parse(
    readFileSync(path.join(runtime.profileRoot, "profile.json"), "utf8"),
  ) as { credentialSources?: string[]; agentPlatforms?: string[] };
  const output = openSync(
    test.info().outputPath(`dev-test-restart-${name}-${Date.now()}.log`),
    "a",
  );
  // `--fixture` stays off: it recreates the repository every worktree points at.
  const launcher = spawn("bun", devTestRestartArgs(name, stored), {
    cwd: repositoryRoot,
    detached: true,
    env: outlivingProcessEnv(),
    stdio: ["ignore", output, output],
  });
  launcher.unref();
  await until(
    `profile ${name} to be ready again`,
    async () => profileStatus(name),
    (status) => status.status === "ready" && Boolean(status.browserUrl),
    300_000,
  );
}

function writeSummary(summary: Record<string, unknown>): void {
  const directory = path.join(
    repositoryRoot,
    "output",
    "agent-testing",
    runId,
    "coordinator-notice-live",
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

const wakesOf = (fake: Calls, by: Wake["by"]) => fake.wakes.filter((wake) => wake.by === by);
const markerCalls = (fake: Calls, run: string) =>
  fake.claude.filter((call) => call.marker?.run === run);

test.describe("coordinator notice hierarchy between two profiles on fixture accounts", () => {
  test.skip(
    !LIVE,
    "opt-in: set ORKESTRATOR_AGENT_TEST_COORDINATOR_NOTICE_LIVE=1 (loopback provider, no billing)",
  );
  test.setTimeout(45 * 60_000);

  test("usage-limit stops on a leaf reach the command node's coordinator once, grouped, after a move and across restarts", async ({
    page,
    browser,
  }) => {
    page.setDefaultTimeout(30_000);
    expect(new URL(fakeOrigin).hostname, "the provider is not on loopback").toBe("127.0.0.1");
    const summary: Record<string, unknown> = {
      version: 1,
      verdict: "failed",
      startedAt: new Date().toISOString(),
    };
    const started = Date.now();
    const contexts: BrowserContext[] = [];
    const newPage = async () => {
      const context = await browser.newContext();
      contexts.push(context);
      return context.newPage();
    };
    let desk = await signIn(page, deskProfile);
    // A second browser context: both gateways are on 127.0.0.1, whose
    // cookies do not tell ports apart.
    let leaf = await signIn(await newPage(), leafProfile);
    const cleanup: Array<() => Promise<unknown>> = [];
    const created: Array<{ profile: () => Profile; environmentId: string }> = [];
    const pipelines: string[] = [];
    let fake: Calls | undefined;
    try {
      // Named before any Claude or Pi bridge starts, so the first one reads it.
      const restoreClaude = [pointClaudeAt(desk.status), pointClaudeAt(leaf.status)];
      const restorePi = pointPiAt(leaf.status, `${fakeOrigin}/pi/v1`, PI);
      cleanup.push(async () => {
        for (const restore of restoreClaude) restore();
        restorePi();
      });
      const leafAccounts = stageAccounts(leaf.status, ["leaf-a", "leaf-b", "leaf-c"], "leaf-a");
      const deskAccounts = stageAccounts(desk.status, ["desk-b", "desk-h"], "desk-h");
      cleanup.push(async () => {
        leafAccounts.restore();
        deskAccounts.restore();
      });
      const restoreDeskConfig = await configure(desk.invoke);
      const restoreLeafConfig = await configure(leaf.invoke);
      cleanup.push(
        () => restoreDeskConfig(),
        () => restoreLeafConfig(),
      );
      // Automatic switching stays off on the leaf (its stops are plain stops)
      // and on the command node until task 3.
      for (const profile of [desk, leaf]) {
        await profile.invoke("set_agent_account_auto_switch", {
          platform: "claude",
          enabled: false,
        });
      }

      const deskProject = await sharedProject(desk, CHECKOUT, SHARED_GIT_URL);
      const leafProject = await sharedProject(leaf, CHECKOUT, SHARED_GIT_URL);
      let nodeId = "";
      nodeId = await attachLeaf(desk, leaf, (attached) => {
        nodeId = attached;
        cleanup.push(() => desk.invoke("forget_node", { nodeId: attached }));
      });
      summary.attached = true;

      const deskCoordinator = await mainCoordinator(desk.invoke, deskProject.id, "claude");
      const leafCoordinator = await mainCoordinator(leaf.invoke, leafProject.id, "pi");
      cleanup.push(
        () =>
          desk.invoke("close_coordinator_conversation", {
            projectId: deskCoordinator.projectId,
            conversationId: deskCoordinator.conversationId,
          }),
        () =>
          leaf.invoke("close_coordinator_conversation", {
            projectId: leafCoordinator.projectId,
            conversationId: leafCoordinator.conversationId,
          }),
      );
      const deskMailbox = () => mailbox({ ...deskCoordinator, invoke: desk.invoke });
      const leafMailbox = () => mailbox({ ...leafCoordinator, invoke: leaf.invoke });
      const baseline = await settle();
      expect(limitNotices(await deskMailbox()), "a fresh desk main holds a notice").toEqual([]);

      // --- Task 2: a native tab, a delegated worker and a pipeline worker. ---
      const run2 = `t2-${randomUUID().slice(0, 8)}`;
      await control("hold");
      const tabEnvironment = await environment(leaf.invoke, leafProject.id, `notice-tab-${run2}`);
      created.push({ profile: () => leaf, environmentId: tabEnvironment });
      await nativeTurn(leaf.invoke, tabEnvironment, runMarker("tab", run2));
      const baseCommit = git(leafProject.checkout, "rev-parse", "HEAD");
      await leaf.invoke("dispatch_native_agent_intent", {
        environmentId: leafCoordinator.environmentId,
        agent: "pi",
        logicalSessionKey: leafCoordinator.logicalSessionKey,
        prompt: launchPrompt({
          projectId: leafProject.id,
          environmentType: "local",
          name: `notice-worker-${run2}`,
          agent: "claude",
          baseBranch: "main",
          baseCommit,
          prompt: `Do the delegated fixture task. ${runMarker("worker", run2)}`,
        }),
        requestId: `notice-qa-launch-${run2}`,
        mode: "build",
      });
      const pipeline = await leaf.invoke<{ id: string; environmentId: string }>(
        "start_build_pipeline",
        {
          taskId: `notice-qa-${run2}`,
          projectId: leafProject.id,
          environmentType: "local",
          agentType: "claude",
          taskTitle: "Notice QA task",
          taskSnapshot: {
            title: "Notice QA task",
            description: `Do the pipeline fixture task. ${runMarker("pipeline", run2)}`,
            acceptanceCriteria: "The fixture passes",
            comments: [],
            images: [],
          },
        },
      );
      pipelines.push(pipeline.id);
      created.push({ profile: () => leaf, environmentId: pipeline.environmentId });
      const parkedKinds = (counts: Calls) =>
        new Set(
          markerCalls(counts, run2)
            .filter((call) => call.parked)
            .map((c) => c.marker!.kind),
        );
      fake = await until(
        "all three leaf sessions to reach the limited account",
        calls,
        (counts) => parkedKinds(counts).size === 3,
        600_000,
      );
      const worker = (
        await leaf.invoke<Array<{ id: string; name: string }>>("get_environments", {
          projectId: leafProject.id,
        })
      ).find((entry) => entry.name.includes(`notice-worker-${run2}`));
      if (worker) created.push({ profile: () => leaf, environmentId: worker.id });
      await control("release");
      fake = await until(
        "the command node's coordinator to be woken with the leaf's stops",
        calls,
        (counts) => wakesOf(counts, "claude").length > wakesOf(baseline, "claude").length,
        300_000,
      );
      fake = await settle();
      const task2Wakes = wakesOf(fake, "claude").slice(wakesOf(baseline, "claude").length);
      const task2Notices = limitNotices(await deskMailbox());
      const task2 = {
        leafCalls: markerCalls(fake, run2).map(({ account, marker, refused }) => ({
          account,
          kind: marker!.kind,
          refused,
        })),
        deskWakes: task2Wakes,
        deskNotices: task2Notices.map(({ placement, placementReason }) => ({
          placement,
          placementReason,
        })),
        leafCoordinatorWakes: wakesOf(fake, "pi").length,
        leafCoordinatorNotices: limitNotices(await leafMailbox()).length,
        launchCalls: Object.entries(fake.piToolCalls)
          .filter(([name]) => name.endsWith("launch_environment"))
          .reduce((sum, [, count]) => sum + count, 0),
      };
      summary.task2 = task2;
      expect(task2.launchCalls).toBe(1);
      expect(new Set(task2.leafCalls.map((call) => call.account))).toEqual(new Set(["leaf-a"]));
      expect(task2.deskWakes).toEqual([
        {
          by: "claude",
          account: "desk-h",
          notices: [
            {
              tab: 1,
              worker: 1,
              pipeline: 1,
              coordinator: 0,
              movedFirst: false,
              kept: false,
              followUp: false,
            },
          ],
        },
      ]);
      expect(task2.deskNotices).toEqual([{ placement: "injected", placementReason: undefined }]);
      expect(task2.leafCoordinatorWakes).toBe(0);
      expect(task2.leafCoordinatorNotices).toBe(0);
      summary.task2Verdict = "passed";

      // --- Task 3: the command node's coordinator on the limited login moves first. ---
      const run3 = `t3-${randomUUID().slice(0, 8)}`;
      await leaf.invoke("set_active_agent_account", {
        platform: "claude",
        accountId: leafAccounts.ids["leaf-b"],
      });
      await desk.invoke("set_active_agent_account", {
        platform: "claude",
        accountId: deskAccounts.ids["desk-b"],
      });
      await desk.invoke("set_agent_account_auto_switch", { platform: "claude", enabled: true });
      for (const name of ["desk-b", "desk-h"] as const) {
        await desk.invoke("set_agent_account_auto_switch", {
          platform: "claude",
          email: FIXTURE_ACCOUNTS[name].email,
          included: true,
        });
      }
      // The limited login resets sooner, so automatic switching keeps it.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const deskBefore = storedAccounts(desk.status);
      expect(deskBefore.active?.claude, "the command node left the shared login by itself").toBe(
        deskAccounts.ids["desk-b"],
      );
      const beforeTask3 = await calls();
      const task3Environment = await environment(leaf.invoke, leafProject.id, `notice-${run3}`);
      created.push({ profile: () => leaf, environmentId: task3Environment });
      await nativeTurn(leaf.invoke, task3Environment, runMarker("tab", run3));
      fake = await until(
        "the command node's coordinator to be woken after its move",
        calls,
        (counts) => wakesOf(counts, "claude").length > wakesOf(beforeTask3, "claude").length,
        300_000,
      );
      fake = await settle();
      const deskAfter = storedAccounts(desk.status);
      const task3 = {
        leafCalls: markerCalls(fake, run3).map(({ account, refused }) => ({ account, refused })),
        deskWakes: wakesOf(fake, "claude").slice(wakesOf(beforeTask3, "claude").length),
        callsOnSharedLoginAtDesk: fake.claude
          .slice(beforeTask3.claude.length)
          .filter((call) => call.account === "desk-b").length,
        deskActiveMovedToHeadroom: deskAfter.active?.claude === deskAccounts.ids["desk-h"],
        deskPinned: Boolean(deskAfter.autoSwitch?.claude?.pin),
        lastSwitchReason: deskAfter.autoSwitch?.claude?.lastSwitch?.reason ?? null,
        deskNotices: limitNotices(await deskMailbox()).length,
        leafCoordinatorNotices: limitNotices(await leafMailbox()).length,
      };
      summary.task3 = task3;
      expect(task3.leafCalls.every((call) => call.account === "leaf-b" && call.refused)).toBe(true);
      expect(task3.deskWakes).toEqual([
        {
          by: "claude",
          account: "desk-h",
          notices: [
            {
              tab: 1,
              worker: 0,
              pipeline: 0,
              coordinator: 0,
              movedFirst: true,
              kept: false,
              followUp: false,
            },
          ],
        },
      ]);
      expect(task3.callsOnSharedLoginAtDesk).toBe(0);
      expect(task3.deskActiveMovedToHeadroom).toBe(true);
      expect(task3.deskPinned).toBe(false);
      expect(task3.deskNotices).toBe(2);
      expect(task3.leafCoordinatorNotices).toBe(0);
      summary.task3Verdict = "passed";
      // Task 4's coordinator stays on the account with headroom.
      await desk.invoke("set_agent_account_auto_switch", { platform: "claude", enabled: false });

      // --- Task 4: a stop raised while the link is down arrives once. ---
      const run4 = `t4-${randomUUID().slice(0, 8)}`;
      await leaf.invoke("set_active_agent_account", {
        platform: "claude",
        accountId: leafAccounts.ids["leaf-c"],
      });
      const task4Environment = await environment(leaf.invoke, leafProject.id, `notice-${run4}`);
      created.push({ profile: () => leaf, environmentId: task4Environment });
      const beforeTask4 = await calls();
      await stopProfile(deskProfile);
      await nativeTurn(leaf.invoke, task4Environment, runMarker("tab", run4));
      fake = await until(
        "the leaf tab to be refused while the command node is down",
        calls,
        (counts) => markerCalls(counts, run4).some((call) => call.refused),
        300_000,
      );
      // Long enough for the stop to be raised and queued for the command node.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const leafWhileDown = limitNotices(await leafMailbox()).length;
      await stopProfile(leafProfile);
      await startProfile(leafProfile);
      leaf = await signIn(await newPage(), leafProfile);
      await startProfile(deskProfile);
      desk = await signIn(await newPage(), deskProfile);
      await waitForLeafLink(desk, leaf, nodeId, 180_000);
      fake = await until(
        "the command node's coordinator to be woken with the queued stop",
        calls,
        (counts) => wakesOf(counts, "claude").length > wakesOf(beforeTask4, "claude").length,
        300_000,
      );
      // Retries, the restart and the reconnect have had their chance to repeat it.
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      fake = await settle();
      const task4 = {
        leafCalls: markerCalls(fake, run4).map(({ account, refused }) => ({ account, refused })),
        deskWakes: wakesOf(fake, "claude").slice(wakesOf(beforeTask4, "claude").length),
        deskNotices: limitNotices(await deskMailbox()).length,
        leafCoordinatorNoticesWhileDown: leafWhileDown,
        leafCoordinatorNotices: limitNotices(await leafMailbox()).length,
        leafCoordinatorWakes: wakesOf(fake, "pi").length,
      };
      summary.task4 = task4;
      expect(task4.leafCalls.every((call) => call.account === "leaf-c" && call.refused)).toBe(true);
      expect(task4.deskWakes).toEqual([
        {
          by: "claude",
          account: "desk-h",
          notices: [
            {
              tab: 1,
              worker: 0,
              pipeline: 0,
              coordinator: 0,
              movedFirst: false,
              kept: false,
              followUp: false,
            },
          ],
        },
      ]);
      expect(task4.deskNotices).toBe(3);
      expect(task4.leafCoordinatorNoticesWhileDown).toBe(0);
      expect(task4.leafCoordinatorNotices).toBe(0);
      expect(task4.leafCoordinatorWakes).toBe(0);
      summary.task4Verdict = "passed";
      expect(fake.refused, "the provider refused a request it does not serve").toBe(0);
      summary.verdict = "passed";
    } catch (error) {
      summary.reason = error instanceof Error ? error.message.slice(0, 2_000) : String(error);
      throw error;
    } finally {
      await control("release").catch(() => undefined);
      const failures: string[] = [];
      for (const pipelineId of pipelines) {
        await leaf
          .invoke("cancel_build_pipeline", { pipelineId })
          .catch((error: unknown) => failures.push(String(error).slice(0, 300)));
      }
      for (const { profile, environmentId } of created.reverse()) {
        await profile()
          .invoke("delete_environment", { environmentId })
          .catch((error: unknown) => failures.push(String(error).slice(0, 300)));
      }
      for (const step of cleanup.reverse()) {
        await step().catch((error: unknown) =>
          failures.push(error instanceof Error ? error.message.slice(0, 300) : String(error)),
        );
      }
      if (failures.length > 0) summary.cleanupFailures = failures;
      fake ??= await calls().catch(() => undefined);
      summary.usageReads = fake?.usageReads ?? null;
      summary.providerRefusedRequests = fake?.refused ?? null;
      summary.durationMs = Date.now() - started;
      writeSummary(summary);
      for (const context of contexts) await context.close();
    }
  });
});
