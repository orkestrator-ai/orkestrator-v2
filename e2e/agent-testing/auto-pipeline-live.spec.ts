/**
 * The Auto-pipeline launch flow end to end on a real `dev:test --fixture`
 * profile with a scripted fake model (to-do 7547 task 4). Run it with
 * `mise run test:agent:auto-pipeline`, which starts a disposable credential-free
 * profile that offers only Pi, runs this file and resets the profile.
 *
 * Opt-in: skipped unless `ORKESTRATOR_AGENT_TEST_AUTO_PIPELINE=1`. Nothing is
 * billed and nothing logs in: every model call the profile's own Pi bridge
 * makes goes to `auto-pipeline-fake-model.ts` on loopback, which the profile's
 * isolated Pi `models.json` names. The real backend, Pi bridge, Pi SDK
 * sessions, Git worktree, ticket store and renderer all run.
 *
 * The one case walks the whole path a user takes:
 *
 * 1. An interactive Pi tab in a prompt environment writes a file (one fake
 *    shell call) and goes idle.
 * 2. In the browser: click "To pipeline" on that tab. The tab's own agent is
 *    sent the drafting request and calls `convert_to_pipeline`; wait for its
 *    draft, edit the title, add a criterion, confirm.
 * 3. The backend creates the in-progress ticket, commits the pending file with
 *    the promotion trailer and adopts the tab as the finished Build.
 * 4. The ticket's delivery is set to commit-only while Verify is parked, the
 *    user switches to another environment, Verify is released and the
 *    pipeline finishes with nobody watching it.
 * 5. Back on the environment, and again after a reload, the graph shows the
 *    finished, commit-only run from backend state.
 *
 * Screenshots (desktop and 390 px) go to `output/visual-previews/`. Prompts,
 * transcripts and the result capability never reach test output.
 *
 * `ORKESTRATOR_AGENT_TEST_AUTO_PIPELINE_REVIEWERS` (1-4, default 1; the
 * runner's `--reviewers`) sizes the review panel. When the backend logs the
 * `build-pipeline` area at debug, as the runner arranges, the spec also counts
 * every review pass's prompt-context reads from the profile's log (BG-11's
 * live count, to-do 7566 (retired)): one `review.prompt-reads` line per
 * review fan-out pass that built, or tried to build, reviewer prompts
 * (`auto-pipeline-prompt-reads.ts`). Only a panel of two or
 * more uses the fan-out. Counts only, written to `prompt-reads.json` beside
 * the suite's results.
 */
import { expect, test, type Page } from "./browser-test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import {
  authenticatedInvoke,
  profileStatus,
  repositoryRoot,
  sidebarNavigator,
  type Environment,
  type Invoke,
  type Project,
  type Status,
} from "./slash-command-live-support";
import { promptReadsFromLogs } from "./auto-pipeline-prompt-reads";
import {
  FAKE_DRAFT_TITLE,
  FIXTURE_FILE_TEXT,
  VERIFY_TOOL,
} from "./auto-pipeline-fake-model-script";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_AUTO_PIPELINE === "1";
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-auto-pipeline";

const PI_PROVIDER = "autopipe-fake";
const PI_MODEL = "autopipe-1";
const MODEL_REF = `${PI_PROVIDER}/${PI_MODEL}`;
const SOURCE_TAB = "auto-pipeline-source";
const FIXTURE_FILE = "notes/auto-pipeline.txt";
const EDITED_TITLE = `${FAKE_DRAFT_TITLE} (reviewed)`;
const ADDED_CRITERION = "The pipeline keeps its commits in the environment.";
const TURN_TIMEOUT_MS = 3 * 60_000;
const PIPELINE_TIMEOUT_MS = 8 * 60_000;
const PREVIEWS = path.join(repositoryRoot, "output", "visual-previews");
const REVIEWERS = Number(process.env.ORKESTRATOR_AGENT_TEST_AUTO_PIPELINE_REVIEWERS ?? "1");
const COUNT_PROMPT_READS = /(^|,)build-pipeline=(debug|trace)(,|$)/.test(
  process.env.ORKESTRATOR_LOG_LEVEL ?? "",
);
const RUN_OUTPUT = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile,
  "auto-pipeline",
);

type Calls = {
  completions: number;
  refused: number;
  submissions: Record<string, number>;
  held: string[];
};
type Projection = {
  turn: { phase: string; error?: string };
  messages: unknown[];
};
type Ticket = {
  id: string;
  title: string;
  status: string;
  acceptanceCriteria?: string;
  sections?: { delivery?: { policy?: string } };
};

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
  await page.screenshot({ path: path.join(PREVIEWS, `auto-pipeline-live-${name}.png`) });
}

/** The fake model, started on loopback with Verify parked; its own handle stops it. */
async function startFakeModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn("bun", [path.join(import.meta.dirname, "auto-pipeline-fake-model.ts")], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, AUTO_PIPELINE_FAKE_HOLD: VERIFY_TOOL },
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
function pointPiAt(status: Status, baseUrl: string): () => void {
  const root = path.resolve(status.dataDir!);
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
        name: "Auto-pipeline fake",
        baseUrl,
        api: "openai-completions",
        apiKey: "autopipe-fake-not-a-key",
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
            name: "Autopipe 1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            // Large, so the drafting prompt (transcript plus diff) never
            // triggers Pi's auto-compaction, which would be another call.
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

async function startEnvironment(invoke: Invoke, projectId: string, name: string) {
  const created = await invoke<Environment>("create_environment", {
    projectId,
    name: `${name}-${Date.now()}`,
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  await invoke("start_environment", { environmentId: created.id });
  const started = await invoke<Environment & { branch?: string }>("get_environment", {
    environmentId: created.id,
  });
  expect(started.worktreePath, `${name} has no worktree`).toBeTruthy();
  return started;
}

function git(worktree: string, args: string[]): string {
  const result = spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

async function pipelineOf(invoke: Invoke, projectId: string, environmentId: string) {
  const pipelines = await invoke<
    Array<{ id: string; environmentId?: string; snapshot: BuildPipeline }>
  >("list_build_pipelines", { projectId });
  return pipelines.find(
    (entry) => (entry.environmentId ?? entry.snapshot.environmentId) === environmentId,
  )?.snapshot;
}

test.describe("Auto-pipeline on a fake model", () => {
  test.skip(!LIVE, "opt-in: set ORKESTRATOR_AGENT_TEST_AUTO_PIPELINE=1 (fake model, no billing)");
  test.setTimeout(20 * 60_000);

  test("promotes an idle prompt tab and finishes the pipeline unwatched", async ({ page }) => {
    page.setDefaultTimeout(30_000);
    // On a host whose user cannot reach Docker (or has no GitHub CLI) a modal
    // startup notice can open after any reload, at any point of a later step,
    // and hide the sidebar. Dismiss it whenever it appears.
    for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
      await page.addLocatorHandler(
        page.getByRole("button", { name: label, exact: true }),
        (button) => button.click(),
      );
    }
    const status = profileStatus(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    expect(status.dataDir, "dev:status reported no data directory").toBeTruthy();
    expect(Number.isInteger(REVIEWERS) && REVIEWERS >= 1 && REVIEWERS <= 4).toBe(true);
    const invoke = await authenticatedInvoke(page, status, profile);
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === status.testProject,
    );
    expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
    const projectId = fixture!.id;

    const model = await startFakeModel();
    const restores: Array<() => void> = [];
    try {
      // The fake is named before any Pi bridge starts, so the first one reads it.
      restores.push(pointPiAt(status, `${model.origin}/v1`));
      // The saved Build defaults drive drafting and every later stage: Pi on
      // the fake model, `REVIEWERS` reviewers (one by default).
      await invoke("patch_repository_settings", {
        projectId,
        updates: {
          agentSettings: {
            defaultAgent: "pi",
            platforms: { pi: { mode: "native", model: MODEL_REF } },
            multiReview: { reviewerCount: REVIEWERS },
          },
        },
      });
      note("model", `pi on a loopback fake (${MODEL_REF}); no login, nothing billed`);

      const source = await startEnvironment(invoke, projectId, "auto-pipeline-source");
      const other = await startEnvironment(invoke, projectId, "auto-pipeline-other");
      const worktree = source.worktreePath!;
      const baseHead = git(worktree, ["rev-parse", "HEAD"]);

      // --- 1. The interactive tab does the work --------------------------
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: source.id,
      });
      await invoke("save_pane_layout", {
        environmentId: source.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-auto-pipeline",
          root: {
            kind: "leaf",
            id: "pane-auto-pipeline",
            activeTabId: SOURCE_TAB,
            tabs: [
              {
                id: SOURCE_TAB,
                type: "agent-native",
                nativeAgentData: { environmentId: source.id, platform: "pi", isLocal: true },
                initialAgentModel: MODEL_REF,
              },
            ],
          },
        },
      });
      const identity = {
        environmentId: source.id,
        agent: "pi",
        logicalSessionKey: `env-${source.id}:${SOURCE_TAB}`,
      };
      await invoke("ensure_native_agent_session", { ...identity, model: MODEL_REF });
      await invoke("dispatch_native_agent_prompt", {
        ...identity,
        prompt: `Write the qualification note. [write:${FIXTURE_FILE}]`,
        requestId: `auto-pipeline-source-${Date.now()}`,
        model: MODEL_REF,
      });
      const projection = () => invoke<Projection>("get_native_agent_projection", identity);
      await expect
        .poll(
          async () => {
            const view = await projection();
            if (view.turn.phase === "error") throw new Error("the source turn failed");
            return view.turn.phase === "idle" && existsSync(path.join(worktree, FIXTURE_FILE));
          },
          {
            timeout: TURN_TIMEOUT_MS,
            intervals: [1_000],
            message: "the source turn never settled",
          },
        )
        .toBe(true);
      expect(readFileSync(path.join(worktree, FIXTURE_FILE), "utf8").trim()).toBe(
        FIXTURE_FILE_TEXT,
      );
      const sourceRows = (await projection()).messages.length;
      const sourceCalls = (await calls(model.origin)).completions;

      // --- 2. Draft and confirm in the browser -------------------------------
      await page.goto(status.browserUrl!);
      const navigate = sidebarNavigator(page, fixture!.name);
      // A startup notice the handler above dismissed mid-navigation can leave
      // the narrow layout's drawer closed, so a navigation is retried whole.
      const open = (name: string) =>
        expect(() => navigate(name)).toPass({ timeout: 120_000, intervals: [1_000] });
      await open(source.name);
      const toPipeline = page.getByRole("button", { name: "To pipeline", exact: true });
      await expect(toPipeline).toBeEnabled({ timeout: 60_000 });
      await shot(page, "launch-desktop");
      await toPipeline.click();

      // The draft opens in its own Auto-pipeline tab, written by the tab's own agent.
      const review = page.getByRole("region", { name: "Auto-pipeline draft" });
      const title = review.getByLabel("Title", { exact: true });
      await expect(title).toHaveValue(FAKE_DRAFT_TITLE, { timeout: TURN_TIMEOUT_MS });
      expect((await calls(model.origin)).submissions.convert_to_pipeline).toBe(1);
      // The agent's closing reply follows its tool call; confirming needs the tab idle.
      await expect
        .poll(async () => (await projection()).turn.phase, {
          timeout: TURN_TIMEOUT_MS,
          intervals: [1_000],
          message: "the source tab never went idle after drafting",
        })
        .toBe("idle");
      // Drafting was an ordinary turn in the source tab: it grew the transcript.
      const draftedRows = (await projection()).messages.length;
      expect(draftedRows).toBeGreaterThan(sourceRows);
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, "draft-narrow");

      await title.fill(EDITED_TITLE);
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await review.getByRole("button", { name: "Add criterion" }).click();
      await review.getByRole("textbox", { name: "Criterion 3", exact: true }).fill(ADDED_CRITERION);
      await shot(page, "draft-edited-narrow");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(review.getByText(`?? ${FIXTURE_FILE}`)).toBeVisible();
      await page.getByRole("button", { name: "Confirm Auto-pipeline" }).click();

      await page.setViewportSize({ width: 1280, height: 900 });

      // --- 3. What confirmation published -------------------------------------
      let pipeline: BuildPipeline | undefined;
      await expect
        .poll(async () => (pipeline = await pipelineOf(invoke, projectId, source.id))?.id, {
          // Covers the confirmation itself, which the tab no longer blocks on.
          timeout: 180_000,
          message: "no pipeline was admitted for the environment",
        })
        .toBeTruthy();
      // Without a known generation the read answers the plain list.
      const tickets = await invoke<Ticket[]>("get_kanban_tasks", { projectId });
      const ticket = tickets.find((entry) => entry.id === pipeline!.taskId);
      expect(ticket?.title).toBe(EDITED_TITLE);
      expect(ticket?.status).toBe("in-progress");
      expect(ticket?.acceptanceCriteria).toContain(ADDED_CRITERION);
      const adopted = pipeline!.sessions[0]!;
      expect(adopted).toMatchObject({ phase: "build", adoptedFromTabId: SOURCE_TAB });
      const promotion = git(worktree, ["log", "-1", "--format=%B"]);
      expect(promotion).toContain(EDITED_TITLE);
      expect(promotion).toMatch(/Orkestrator-Auto-Pipeline: [0-9a-f-]{36}/);
      expect(git(worktree, ["rev-parse", "HEAD^"])).toBe(baseHead);
      expect(git(worktree, ["ls-files", FIXTURE_FILE])).toBe(FIXTURE_FILE);

      // The user picks commit-only delivery while the run is still before Verify.
      await invoke("update_kanban_task", {
        taskId: ticket!.id,
        sections: { delivery: { policy: "commit-only" } },
      });

      // --- 4. Verify parked; leave; let it finish unwatched -------------------
      await expect
        .poll(async () => (await calls(model.origin)).held, {
          timeout: PIPELINE_TIMEOUT_MS,
          intervals: [2_000],
          message: "the pipeline never reached Verify",
        })
        .toContain(VERIFY_TOOL);
      await expect(page.getByText(EDITED_TITLE).first()).toBeVisible();
      await shot(page, "verifying-desktop");

      await open(other.name);
      await expect(page.getByRole("button", { name: "Multi Review", exact: true })).toBeVisible();
      await fetch(`${model.origin}/__release?tool=${VERIFY_TOOL}`, { method: "POST" });
      await expect
        .poll(
          async () => {
            const current = await pipelineOf(invoke, projectId, source.id);
            if (current?.phase === "failed") throw new Error("the pipeline failed");
            return current?.phase;
          },
          {
            timeout: PIPELINE_TIMEOUT_MS,
            intervals: [2_000],
            message: "the pipeline never completed",
          },
        )
        .toBe("complete");
      const finished = (await pipelineOf(invoke, projectId, source.id))!;
      expect(finished.delivery?.policy).toBe("commit-only");
      expect(finished.sessions.some((session) => session.phase === "pr")).toBe(false);
      expect(git(worktree, ["status", "--porcelain"])).toBe("");
      // Read before the UI checks below, so a UI failure cannot lose the count
      // (the runner resets the profile, logs included, when the spec ends).
      if (COUNT_PROMPT_READS) {
        expect(status.logDir, "dev:status reported no log directory").toBeTruthy();
        const reads = promptReadsFromLogs(status.logDir!);
        const record = {
          reviewers: REVIEWERS,
          logFile: reads.file,
          passes: reads.passes,
          prompts: reads.passes.reduce((sum, pass) => sum + pass.prompts, 0),
          notesReads: reads.passes.reduce((sum, pass) => sum + pass.notesReads, 0),
        };
        mkdirSync(RUN_OUTPUT, { recursive: true });
        writeFileSync(
          path.join(RUN_OUTPUT, "prompt-reads.json"),
          `${JSON.stringify(record, null, 2)}\n`,
        );
        note("review-prompt-reads", record);
        // One reviewer runs as a single stage session, not the fan-out, so
        // only a panel is counted. Every reviewer's prompt was built in some
        // pass, and each pass that built prompts read the project notes once
        // for all of them (BG-11).
        if (REVIEWERS > 1) expect(record.prompts).toBeGreaterThanOrEqual(REVIEWERS);
        for (const pass of reads.passes) {
          expect(pass).toMatchObject({ instructionReads: 1, notesReads: 1 });
        }
      }

      // --- 5. Back, and after a reload, from backend state --------------------
      // Completion opens the run's Notes tab; the graph is one click away.
      // Hidden copies of other views stay mounted, so only visible ones count.
      const showFinished = async () => {
        await open(source.name);
        const openPipeline = page
          .getByRole("button", { name: "Open pipeline", exact: true })
          .filter({ visible: true })
          .first();
        const header = page
          .getByTestId("build-pipeline-header-phase")
          .filter({ visible: true })
          .first();
        await expect(openPipeline.or(header).first()).toBeVisible({ timeout: 60_000 });
        if (await openPipeline.isVisible()) {
          await expect(page.getByText("Passed").filter({ visible: true }).first()).toBeVisible();
          await openPipeline.click();
        }
        await expect(header).toHaveText(/commits kept in the environment/i, { timeout: 60_000 });
      };
      await showFinished();
      await page.reload();
      await showFinished();
      await shot(page, "complete-desktop");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await showFinished();
      await shot(page, "complete-narrow");

      // Confirming and the pipeline never sent the source tab another turn.
      expect((await projection()).messages.length).toBe(draftedRows);
      const final = await calls(model.origin);
      expect(final.completions).toBeGreaterThan(sourceCalls);
      expect(final.submissions).toMatchObject({
        convert_to_pipeline: 1,
        submit_validation_plan: 1,
        submit_review_report: REVIEWERS,
        [VERIFY_TOOL]: 1,
      });
      note("fake-model-calls", { completions: final.completions, submissions: final.submissions });
      note("pipeline", {
        phase: finished.phase,
        delivery: finished.delivery?.policy,
        sessions: finished.sessions.map((session) => session.label),
      });
    } finally {
      for (const restore of restores.reverse()) restore();
      await stopChild(model.child);
    }
  });
});
