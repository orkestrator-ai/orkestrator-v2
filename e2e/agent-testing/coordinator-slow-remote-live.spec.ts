/**
 * A slow remote must not stop a coordinator message from fast-forwarding the
 * checkout to the upstream it has already fetched (to-do 4720), on a real
 * `dev:test --fixture` profile. Run it with
 * `mise run test:agent:coordinator-slow-remote`, which starts a disposable
 * credential-free profile that offers only Pi, runs this file and resets the
 * profile.
 *
 * Opt-in: skipped unless `ORKESTRATOR_AGENT_TEST_COORDINATOR_SLOW_REMOTE=1`.
 * Nothing is billed and nothing logs in: the main coordinators run on the
 * profile's own Pi bridge, whose isolated `models.json` names
 * `coordinator-slow-remote-fake-model.ts` on loopback. The real backend, Pi
 * bridge, project Git service, agent mail and renderer all run.
 *
 * Two disposable projects live in the profile's fixture directory, each a
 * checkout of its own local bare repository. Each checkout's origin is an SSH
 * URL served by a checkout-local `core.sshCommand` shim
 * (`slowSshShimScript`), which sleeps 15 s while its delay marker exists:
 * longer than the typed path's 3 s fetch bound and the mail path's 5 s wait.
 * Nothing touches host SSH or global Git configuration.
 *
 * 1. Baseline, delay off: a direct fetch and a backend fetch through each shim
 *    succeed, so each shim serves its own repository.
 * 2. The mail project's coordinator starts a turn the fake model parks, while
 *    its checkout is still current.
 * 3. Each remote moves two commits ahead; each checkout fetches them without
 *    merging, so both are clean and behind an upstream they already have.
 * 4. Both delay markers are created and stay until the end.
 * 5. Typed: the user types to the first project's main coordinator in the
 *    browser. The backend log must show `checkout.message-check
 *    outcome=fast-forwarded fetch=timed-out`, HEAD must reach the recorded
 *    upstream with a new reflog entry, and the header must stop saying
 *    "commits behind".
 * 6. Mail: mail to the second coordinator is held behind its running turn and
 *    the checkout stays behind. The turn is released with the delay still on;
 *    the redelivered mail must log `checkout.mail-follow
 *    outcome=fast-forwarded-fetched` and move HEAD to the upstream.
 *
 * The run writes a content-free summary (outcomes, counts, durations; no
 * prompts, paths or commit contents) to
 * `output/agent-testing/<run>/coordinator-slow-remote/summary.json`, and
 * screenshots to `output/visual-previews/coordinator-slow-remote-*.png`.
 */
import { expect, test, type Page } from "./browser-test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorSnapshot,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { profilePiAgentDirectory } from "../../scripts/pi-fake-model-shared";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import {
  authenticatedInvoke,
  profileStatus,
  repositoryRoot,
  type Invoke,
  type Project,
  type Status,
} from "./slash-command-live-support";
import {
  FAKE_MODEL_ID,
  HOLD_MARKER,
  findLogEntries,
  mailMarker,
  parseShimInvocations,
  slowSshShimScript,
  type LogEntry,
} from "./coordinator-slow-remote-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_SLOW_REMOTE === "1";
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-coordinator-slow-remote";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;

const PI_PROVIDER = "slow-remote-fake";
const MODEL_REF = `${PI_PROVIDER}/${FAKE_MODEL_ID}`;
/** Past the typed path's 3 s fetch bound and the mail path's 5 s wait. */
const DELAY_SECONDS = 15;
const TYPED_FETCH_BOUND_MS = 3_000;
const MAIL_FETCH_BOUND_MS = 5_000;
/** The backend's fetch cooldown (`FETCH_COOLDOWN_MS`), plus a margin. */
const FETCH_COOLDOWN_MS = 60_000;
const COOLDOWN_MARGIN_MS = 2_000;
const TURN_TIMEOUT_MS = 3 * 60_000;
const SSH_ORIGIN = "ssh://git@slow.invalid/repo.git";
const PREVIEWS = path.join(repositoryRoot, "output", "visual-previews");
const SUMMARY_DIR = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "coordinator-slow-remote",
);

type Identity = { environmentId: string; agent: "pi"; logicalSessionKey: string };
type Projection = { turn: { phase: string; error?: string }; messages: unknown[] };
type Calls = {
  completions: number;
  refused: number;
  heldTotal: number;
  held: number;
  mailCalls: number;
};
type MailMessage = {
  id: string;
  placement?: string;
  route?: string;
  trust?: string;
  from?: { kind?: string; environmentId?: string; tabId?: string };
};
const WORKER_TAB = "slow-remote-worker";

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

function note(type: string, value: unknown): void {
  test.info().annotations.push({
    type,
    description: typeof value === "string" ? value : JSON.stringify(value),
  });
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(PREVIEWS, { recursive: true });
  await page.screenshot({ path: path.join(PREVIEWS, `coordinator-slow-remote-${name}.png`) });
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    // Never the host's global or system Git configuration.
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(0, 400)}`);
  }
  return result.stdout.trim();
}

function commit(cwd: string, file: string): void {
  writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", `Add ${file}`]);
}

/** The fake model on loopback; its own handle stops it. */
async function startFakeModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "coordinator-slow-remote-fake-model.ts")],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
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
 * Names the fake provider in the profile's isolated Pi `models.json` and makes
 * it Pi's saved default (never `~/.pi`); returns the restore.
 */
function pointPiAt(status: Status, baseUrl: string): () => void {
  const root = path.resolve(status.dataDir!);
  const directory = profilePiAgentDirectory(root);
  const models = path.join(directory, "models.json");
  const settings = path.join(directory, "settings.json");
  for (const file of [models, settings]) {
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Pi config escapes the profile");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const restore = snapshotFixtureFiles([models, settings]);
  const read = (file: string) =>
    existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  const existing = read(models) as { providers?: Record<string, unknown> };
  writeFileSync(
    models,
    `${JSON.stringify(
      {
        ...existing,
        providers: {
          ...existing.providers,
          [PI_PROVIDER]: {
            name: "Slow-remote fake",
            baseUrl,
            api: "openai-completions",
            apiKey: "slow-remote-fake-not-a-key",
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsUsageInStreaming: true,
              maxTokensField: "max_tokens",
            },
            models: [
              {
                id: FAKE_MODEL_ID,
                name: "Slow remote 1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                // Large, so the coordinator prompt never triggers compaction.
                contextWindow: 1_000_000,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    settings,
    `${JSON.stringify(
      { ...read(settings), defaultProvider: PI_PROVIDER, defaultModel: FAKE_MODEL_ID },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return restore;
}

/** One disposable project: a bare repository, its checkout and the slow shim. */
interface SlowProject {
  label: "typed" | "mail";
  dir: string;
  bare: string;
  checkout: string;
  shim: string;
  invocations: string;
  delayMarker: string;
  savedOrigin: string;
  project?: Project;
  identity?: Identity;
  conversationId?: string;
  startHead?: string;
  upstream?: string;
  reflogBefore?: number;
}

function createSlowProject(scratch: string, label: SlowProject["label"]): SlowProject {
  const dir = path.join(scratch, label);
  const bare = path.join(dir, `slow-remote-${label}.git`);
  const checkout = path.join(dir, `slow-remote-${label}`);
  mkdirSync(checkout, { recursive: true, mode: 0o700 });
  git(checkout, ["init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "slow-remote@example.invalid"]);
  git(checkout, ["config", "user.name", "Slow remote"]);
  git(checkout, ["config", "commit.gpgsign", "false"]);
  commit(checkout, "README.md");
  git(dir, ["clone", "-q", "--bare", checkout, bare]);
  git(checkout, ["remote", "add", "origin", bare]);
  git(checkout, ["fetch", "-q", "origin"]);
  git(checkout, ["branch", "-q", "--set-upstream-to", "origin/main", "main"]);
  return {
    label,
    dir,
    bare,
    checkout,
    shim: path.join(dir, "slow-ssh.sh"),
    invocations: path.join(dir, "ssh-invocations"),
    delayMarker: path.join(dir, "delay"),
    savedOrigin: bare,
  };
}

/** Points the checkout's origin at the SSH shim; nothing outside the checkout changes. */
function installShim(project: SlowProject): void {
  project.savedOrigin = git(project.checkout, ["remote", "get-url", "origin"]);
  writeFileSync(
    project.shim,
    slowSshShimScript({
      bareRepository: project.bare,
      invocations: project.invocations,
      delayMarker: project.delayMarker,
      delaySeconds: DELAY_SECONDS,
    }),
    { mode: 0o700 },
  );
  git(project.checkout, ["config", "core.sshCommand", project.shim]);
  git(project.checkout, ["config", "ssh.variant", "simple"]);
  git(project.checkout, ["remote", "set-url", "origin", SSH_ORIGIN]);
}

function restoreShim(project: SlowProject): void {
  if (!existsSync(path.join(project.checkout, ".git"))) return;
  git(project.checkout, ["remote", "set-url", "origin", project.savedOrigin]);
  for (const key of ["core.sshCommand", "ssh.variant"]) {
    spawnSync("git", ["config", "--unset", key], { cwd: project.checkout });
  }
}

function invocations(project: SlowProject): number[] {
  return existsSync(project.invocations)
    ? parseShimInvocations(readFileSync(project.invocations, "utf8"))
    : [];
}

/** Two commits land on the remote, pushed straight to the bare repository. */
function advanceRemote(project: SlowProject): void {
  const publisher = path.join(project.dir, "publisher");
  git(project.dir, ["clone", "-q", project.bare, publisher]);
  git(publisher, ["config", "user.email", "publisher@example.invalid"]);
  git(publisher, ["config", "user.name", "Publisher"]);
  git(publisher, ["config", "commit.gpgsign", "false"]);
  commit(publisher, "one.txt");
  commit(publisher, "two.txt");
  git(publisher, ["push", "-q", "origin", "main"]);
}

function reflogCount(project: SlowProject): number {
  return git(project.checkout, ["reflog", "show", "--format=%H", "HEAD"])
    .split("\n")
    .filter(Boolean).length;
}

/** Backend log text appended since `offset`. */
function logSince(file: string, offset: number): string {
  if (!existsSync(file)) return "";
  const text = readFileSync(file);
  return text.subarray(Math.min(offset, text.length)).toString("utf8");
}

function logSize(file: string): number {
  return existsSync(file) ? statSync(file).size : 0;
}

async function gitStatus(invoke: Invoke, projectId: string): Promise<ProjectGitStatus> {
  return invoke<ProjectGitStatus>("get_project_git_status", { projectId });
}

/** Assigns Pi to a fresh main coordinator conversation on the project. */
async function startCoordinator(
  invoke: Invoke,
  project: SlowProject,
  cleanup: Array<() => Promise<unknown>>,
): Promise<void> {
  const projectId = project.project!.id;
  let snapshot = await invoke<CoordinatorSnapshot>("ensure_project_coordinator", { projectId });
  if (!coordinatorMainConversation(snapshot.workspace)) {
    snapshot = await invoke<CoordinatorSnapshot>("create_coordinator_conversation", { projectId });
  }
  const conversation = coordinatorMainConversation(snapshot.workspace)!;
  const qualification = snapshot.providerAvailability.pi;
  expect(
    qualification?.available,
    `Pi is not offered to Coordinator: ${qualification?.reason ?? "no qualification"}`,
  ).toBe(true);
  snapshot = await invoke<CoordinatorSnapshot>("assign_coordinator_conversation_agent", {
    projectId,
    conversationId: conversation.id,
    agent: "pi",
  });
  cleanup.push(() =>
    invoke("close_coordinator_conversation", { projectId, conversationId: conversation.id }),
  );
  project.conversationId = conversation.id;
  project.identity = {
    environmentId: coordinatorRuntimeId(snapshot.workspace.id, conversation.id),
    agent: "pi",
    logicalSessionKey: conversation.logicalSessionKey,
  };
  await invoke("ensure_native_agent_session", { ...project.identity, model: MODEL_REF });
}

async function projection(invoke: Invoke, identity: Identity): Promise<Projection | null> {
  return invoke<Projection | null>("get_native_agent_projection", identity);
}

async function waitForPhase(
  invoke: Invoke,
  identity: Identity,
  accept: (phase: string) => boolean,
  message: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const view = await projection(invoke, identity);
        if (view?.turn.phase === "error") throw new Error(`${message}: the turn failed`);
        return view ? accept(view.turn.phase) : false;
      },
      { timeout: TURN_TIMEOUT_MS, intervals: [500], message },
    )
    .toBe(true);
}

/** The behind count read from Git itself, not from the backend. */
function behind(project: SlowProject): number {
  return Number(git(project.checkout, ["rev-list", "--count", "HEAD..@{upstream}"]));
}

/** Waits until the backend's last fetch of the project is past its cooldown. */
async function waitPastFetchCooldown(invoke: Invoke, projectId: string): Promise<void> {
  const fetchedAt = (await gitStatus(invoke, projectId)).fetchedAt;
  const age = fetchedAt ? Date.now() - Date.parse(fetchedAt) : Infinity;
  const wait = FETCH_COOLDOWN_MS + COOLDOWN_MARGIN_MS - age;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

test.describe("Coordinator checkout sync with a slow remote", () => {
  test.skip(
    !LIVE,
    "opt-in: set ORKESTRATOR_AGENT_TEST_COORDINATOR_SLOW_REMOTE=1 (fake model, no billing)",
  );
  test.setTimeout(15 * 60_000);

  test("a typed message and a held mail fast-forward to the fetched upstream", async ({ page }) => {
    page.setDefaultTimeout(30_000);
    const status = profileStatus(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    expect(status.flavor).toBe("agent-test");
    expect(status.dataDir, "dev:status reported no data directory").toBeTruthy();
    const runtime = resolveRuntimeProfile({
      repositoryRoot,
      requestedId: profile,
      flavor: "agent-test",
    });
    expect(status.dataDir).toBe(runtime.dataDir);
    const backendLog = path.join(runtime.logDir, "electron.log");
    const scratch = path.join(runtime.fixtureDir, `slow-remote-${Date.now()}`);
    expect(scratch.startsWith(`${runtime.fixtureDir}${path.sep}`)).toBe(true);
    const invoke = await authenticatedInvoke(page, status, profile);

    const summary: Record<string, unknown> = { profile, delaySeconds: DELAY_SECONDS };
    const cleanup: Array<() => Promise<unknown>> = [];
    const restores: Array<() => void> = [];
    const projects: SlowProject[] = [];
    const model = await startFakeModel();
    try {
      restores.push(pointPiAt(status, `${model.origin}/v1`));
      note("model", `pi on a loopback fake (${MODEL_REF}); no login, nothing billed`);

      // --- 1. Two disposable projects behind delayed SSH shims ------------
      for (const label of ["typed", "mail"] as const) {
        const slow = createSlowProject(scratch, label);
        projects.push(slow);
        slow.project = await invoke<Project>("add_project", {
          gitUrl: slow.bare,
          localPath: slow.checkout,
        });
        const projectId = slow.project.id;
        cleanup.push(() => invoke("remove_project", { projectId }));
        await invoke("patch_repository_settings", {
          projectId,
          updates: {
            agentSettings: {
              defaultAgent: "pi",
              platforms: { pi: { mode: "native", model: MODEL_REF } },
            },
          },
        });
        installShim(slow);
        // Delay off: a direct fetch and a backend fetch each reach the shim,
        // which serves this project's own repository.
        const before = invocations(slow).length;
        git(slow.checkout, ["fetch", "-q", "origin"]);
        const fetched = await invoke<ProjectGitStatus>("fetch_project_git", {
          projectId,
          force: true,
        });
        expect(fetched.remoteState, `${label}: the baseline backend fetch failed`).toBe("fresh");
        expect(fetched.lastError ?? null).toBeNull();
        expect(invocations(slow).length, `${label}: the shim was not used`).toBe(before + 2);
        expect(git(slow.checkout, ["rev-parse", "HEAD"])).toBe(
          git(slow.bare, ["rev-parse", "main"]),
        );
      }
      const [typed, mail] = projects as [SlowProject, SlowProject];
      summary.baseline = Object.fromEntries(
        projects.map((slow) => [slow.label, { shimInvocations: invocations(slow).length }]),
      );

      for (const slow of projects) await startCoordinator(invoke, slow, cleanup);

      // The mail project's worker: a Pi tab in a local environment of the
      // same project, so its report takes the coordinator route, as a
      // worker's report does.
      const workerEnvironment = await invoke<{ id: string; name: string }>("create_environment", {
        projectId: mail.project!.id,
        name: `slow-remote-worker-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      cleanup.push(() =>
        invoke("delete_environment", { environmentId: workerEnvironment.id }).catch(
          () => undefined,
        ),
      );
      await invoke("start_environment", { environmentId: workerEnvironment.id });
      const workerLayout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: workerEnvironment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: workerEnvironment.id,
        expectedRevision: workerLayout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-slow-remote-worker",
          root: {
            kind: "leaf",
            id: "pane-slow-remote-worker",
            activeTabId: WORKER_TAB,
            tabs: [
              {
                id: WORKER_TAB,
                type: "agent-native",
                nativeAgentData: {
                  environmentId: workerEnvironment.id,
                  platform: "pi",
                  isLocal: true,
                },
                initialAgentModel: MODEL_REF,
              },
            ],
          },
        },
      });
      const worker: Identity = {
        environmentId: workerEnvironment.id,
        agent: "pi",
        logicalSessionKey: `env-${workerEnvironment.id}:${WORKER_TAB}`,
      };
      await invoke("ensure_native_agent_session", { ...worker, model: MODEL_REF });

      // --- 2. The mail coordinator's turn starts while it is current ------
      const heldBefore = (await calls(model.origin)).heldTotal;
      await invoke("dispatch_native_agent_prompt", {
        ...mail.identity!,
        prompt: `Read the README and wait. ${HOLD_MARKER}`,
        requestId: `slow-remote-held-${Date.now()}`,
        model: MODEL_REF,
      });
      await expect
        .poll(async () => (await calls(model.origin)).held, {
          timeout: TURN_TIMEOUT_MS,
          message: "the mail coordinator's turn never reached the fake model",
        })
        .toBe(1);
      expect((await calls(model.origin)).heldTotal).toBe(heldBefore + 1);
      await waitForPhase(invoke, mail.identity!, (phase) => phase !== "idle", "held turn running");
      expect(behind(mail), "the held turn started on a checkout that was already behind").toBe(0);

      // --- 3. Each remote moves on; each checkout fetches without merging --
      for (const slow of projects) {
        advanceRemote(slow);
        const before = invocations(slow).length;
        git(slow.checkout, ["fetch", "-q", "origin"]);
        expect(invocations(slow).length).toBe(before + 1);
        expect(git(slow.checkout, ["status", "--porcelain"])).toBe("");
        expect(behind(slow)).toBe(2);
        slow.startHead = git(slow.checkout, ["rev-parse", "HEAD"]);
        slow.upstream = git(slow.checkout, ["rev-parse", "@{upstream}"]);
        slow.reflogBefore = reflogCount(slow);
      }

      // The panel opens inside the fetch cooldown, so its own fetch-on-open
      // does not reach the remote: the typed check makes the slow fetch.
      await page.goto(status.browserUrl!);
      for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
        const button = page.getByRole("button", { name: label, exact: true });
        if (await button.isVisible().catch(() => false)) await button.click();
      }
      const projectRow = page
        .getByRole("button", { name: new RegExp(`^${typed.project!.name}`) })
        .first();
      await projectRow.click();
      await expect(page.getByRole("tab", { name: "Coordinator", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      const header = page.getByText(/commits behind|Up to date|Remote status is stale/).first();
      await expect(header).toHaveText("2 commits behind", { timeout: 30_000 });
      await shot(page, "typed-before");

      // --- 4. Both remotes become slow ------------------------------------
      for (const slow of projects) writeFileSync(slow.delayMarker, "");

      // --- 5. Typed message ------------------------------------------------
      await waitPastFetchCooldown(invoke, typed.project!.id);
      const typedLogOffset = logSize(backendLog);
      const typedShimBefore = invocations(typed).length;
      const typedCompletions = (await calls(model.origin)).completions;
      const composeBar = page.getByTestId("shared-native-compose-bar");
      const composer = composeBar.getByRole("textbox").first();
      await expect(composer).toBeVisible({ timeout: 90_000 });
      await composer.fill("What changed upstream?");
      const sentAt = Date.now();
      await composer.press("Enter");
      await expect(composer).toHaveText("", { timeout: 30_000 });

      let typedCheck: LogEntry | undefined;
      await expect
        .poll(
          () => {
            typedCheck = findLogEntries(
              logSince(backendLog, typedLogOffset),
              "coordinator",
              "checkout.message-check",
            ).find((entry) => entry.fields.projectId === typed.project!.id);
            return typedCheck?.fields;
          },
          { timeout: 60_000, message: "no checkout.message-check for the typed project" },
        )
        .toBeTruthy();
      expect(typedCheck!.fields).toMatchObject({ outcome: "fast-forwarded", fetch: "timed-out" });
      const typedDuration = Number(typedCheck!.fields.durationMs);
      expect(typedDuration).toBeGreaterThanOrEqual(TYPED_FETCH_BOUND_MS);
      const typedShim = invocations(typed).slice(typedShimBefore);
      expect(typedShim.length, "the typed check never reached the slow remote").toBeGreaterThan(0);
      expect(git(typed.checkout, ["rev-parse", "HEAD"])).toBe(typed.upstream);
      expect(reflogCount(typed)).toBe(typed.reflogBefore! + 1);
      // The late fetch is still pending when the merge has already happened.
      const typedHeadAt = Date.now();
      expect(typedHeadAt - typedShim[0]!).toBeLessThan(DELAY_SECONDS * 1_000);
      await expect(header).not.toHaveText(/commits behind/, { timeout: 10_000 });
      await shot(page, "typed-after");
      await waitForPhase(invoke, typed.identity!, (phase) => phase === "idle", "typed turn");
      expect((await calls(model.origin)).completions).toBeGreaterThan(typedCompletions);
      // The late fetch settles on the same, already merged commit.
      await expect
        .poll(async () => (await gitStatus(invoke, typed.project!.id)).operationState, {
          timeout: (DELAY_SECONDS + 30) * 1_000,
        })
        .toBe("idle");
      const typedSettled = await gitStatus(invoke, typed.project!.id);
      expect(typedSettled).toMatchObject({ behind: 0, ahead: 0, remoteState: "fresh" });
      await expect(header).toHaveText("Up to date");
      await shot(page, "typed-settled");
      summary.typed = {
        outcome: typedCheck!.fields.outcome,
        fetch: typedCheck!.fields.fetch,
        durationMs: typedDuration,
        shimInvocations: typedShim.length,
        shimStartAfterSendMs: typedShim[0]! - sentAt,
        headMatchesFetchedUpstream: true,
        newReflogEntries: reflogCount(typed) - typed.reflogBefore!,
        headerAfter: await header.textContent(),
      };

      // --- 6. Mail held behind the running turn ---------------------------
      await waitPastFetchCooldown(invoke, mail.project!.id);
      const mailLogOffset = logSize(backendLog);
      const mailboxes = await invoke<{
        mailboxes: Array<{ environmentId: string; tabId: string }>;
      }>("list_agent_mailboxes", { projectId: mail.project!.id });
      const mailbox = mailboxes.mailboxes.find(
        (entry) => entry.environmentId === mail.identity!.environmentId,
      );
      expect(mailbox, "the mail coordinator has no mailbox").toBeTruthy();
      const inbox = async () =>
        (
          await invoke<{ messages: MailMessage[] }>("get_agent_mail_mailbox", {
            environmentId: mailbox!.environmentId,
            tabId: mailbox!.tabId,
          })
        ).messages;
      const earlier = new Set((await inbox()).map((message) => message.id));
      // The worker reports to its coordinator through Orkestrator's
      // send_message tool, while the coordinator's turn is still running.
      const mailCallsBefore = (await calls(model.origin)).mailCalls;
      await invoke("dispatch_native_agent_prompt", {
        ...worker,
        prompt: `Report to the coordinator. ${mailMarker({
          toEnvironmentId: mailbox!.environmentId,
          toTabId: mailbox!.tabId,
          fromTabId: WORKER_TAB,
        })}`,
        requestId: `slow-remote-worker-${Date.now()}`,
        model: MODEL_REF,
      });
      let sentId: string | undefined;
      await expect
        .poll(
          async () => {
            sentId = (await inbox()).find((message) => !earlier.has(message.id))?.id;
            return sentId;
          },
          { timeout: TURN_TIMEOUT_MS, message: "the worker's mail never reached the coordinator" },
        )
        .toBeTruthy();
      expect((await calls(model.origin)).mailCalls).toBe(mailCallsBefore + 1);
      await waitForPhase(invoke, worker, (phase) => phase === "idle", "worker turn");
      const readMail = async () => (await inbox()).find((message) => message.id === sentId);
      const arrived = await readMail();
      expect(arrived?.from?.kind, "the mail is not from the worker tab").toBe("tab");
      expect(arrived?.from?.environmentId).toBe(workerEnvironment.id);
      await expect
        .poll(async () => (await readMail())?.placement, {
          timeout: 30_000,
          message: "the mail was not held behind the running turn",
        })
        .toMatch(/^(pending-inject|inject-held)$/);
      const heldPlacement = await readMail();
      // Delivery waits on the coordinator's running turn before it reaches
      // the checkout step at all.
      let waiting: LogEntry | undefined;
      await expect
        .poll(
          () => {
            waiting = findLogEntries(
              logSince(backendLog, mailLogOffset),
              "agent-mail",
              "delivery.waiting",
            ).find((entry) => entry.fields.messageId === sentId);
            return waiting?.fields.reason;
          },
          { timeout: 30_000, message: "the mail did not wait behind the running turn" },
        )
        .toBe("working");
      expect(git(mail.checkout, ["rev-parse", "HEAD"])).toBe(mail.startHead);
      expect(behind(mail)).toBe(2);
      expect(
        findLogEntries(
          logSince(backendLog, mailLogOffset),
          "coordinator",
          "checkout.mail-follow",
        ).filter((entry) => entry.fields.projectId === mail.project!.id),
        "a mail follow ran while the turn was running",
      ).toEqual([]);

      // The turn ends with the remote still slow; the mail is redelivered.
      const mailShimBefore = invocations(mail).length;
      const releasedAt = Date.now();
      await fetch(`${model.origin}/__release`, { method: "POST" });
      let mailFollow: LogEntry | undefined;
      await expect
        .poll(
          () => {
            mailFollow = findLogEntries(
              logSince(backendLog, mailLogOffset),
              "coordinator",
              "checkout.mail-follow",
            ).find((entry) => entry.fields.projectId === mail.project!.id);
            return mailFollow?.fields.outcome;
          },
          { timeout: 90_000, message: "no checkout.mail-follow for the mail project" },
        )
        .toBe("fast-forwarded-fetched");
      const mailMergedAt = Date.now();
      const mailShim = invocations(mail).slice(mailShimBefore);
      expect(mailShim.length, "the redelivered mail never reached the slow remote").toBeGreaterThan(
        0,
      );
      // The fallback waited out the 5 s bound on a fetch that was still pending.
      expect(mailMergedAt - mailShim[0]!).toBeGreaterThanOrEqual(MAIL_FETCH_BOUND_MS);
      expect(mailMergedAt - mailShim[0]!).toBeLessThan(DELAY_SECONDS * 1_000);
      expect(git(mail.checkout, ["rev-parse", "HEAD"])).toBe(mail.upstream);
      expect(reflogCount(mail)).toBe(mail.reflogBefore! + 1);
      await expect
        .poll(async () => (await readMail())?.placement, { timeout: TURN_TIMEOUT_MS })
        .toBe("injected");
      await waitForPhase(invoke, mail.identity!, (phase) => phase === "idle", "mail turn");
      summary.mail = {
        sender: arrived?.from?.kind,
        trust: arrived?.trust,
        route: arrived?.route,
        heldPlacement: heldPlacement?.placement,
        heldReason: waiting?.fields.reason,
        outcome: mailFollow!.fields.outcome,
        shimInvocations: mailShim.length,
        shimStartAfterReleaseMs: mailShim[0]! - releasedAt,
        mergedAfterShimStartMs: mailMergedAt - mailShim[0]!,
        headMatchesFetchedUpstream: true,
        newReflogEntries: reflogCount(mail) - mail.reflogBefore!,
        finalPlacement: (await readMail())?.placement,
      };
      summary.calls = await calls(model.origin);
      summary.passed = true;
      note("summary", summary);
    } finally {
      // Remove the delay, let owned fetches settle, then undo the checkouts'
      // local settings before the profile is reset.
      for (const slow of projects) rmSync(slow.delayMarker, { force: true });
      await fetch(`${model.origin}/__release`, { method: "POST" }).catch(() => undefined);
      for (const slow of projects) {
        if (!slow.project) continue;
        await expect
          .poll(
            async () =>
              (await gitStatus(invoke, slow.project!.id).catch(() => null))?.operationState ??
              "idle",
            { timeout: (DELAY_SECONDS + 30) * 1_000 },
          )
          .toBe("idle")
          .catch(() => undefined);
        restoreShim(slow);
      }
      for (const step of cleanup.reverse()) await step().catch(() => undefined);
      for (const restore of restores.reverse()) restore();
      await stopChild(model.child);
      mkdirSync(SUMMARY_DIR, { recursive: true });
      writeFileSync(
        path.join(SUMMARY_DIR, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
