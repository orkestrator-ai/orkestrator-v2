/**
 * Live Multi Review inactive-environment cycle against a real `dev:test
 * --fixture` profile.
 *
 * Opt-in only: each case runs a real two-reviewer Multi Review (one
 * preparation turn, two reviewer turns, one consolidation turn) on the host's
 * Claude and Codex credentials, so every case is skipped unless
 * `ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW=1`. The backend-restart case also
 * stops the profile and starts it again with its stored credential and
 * platform selection, so run this file on its own against a profile you
 * started by hand, never inside `test:agent:browser:isolated`.
 *
 * Every case launches through the real launcher (right-click Multi Review,
 * pick the models, Start), waits until a reviewer's prompt is sent, then
 * disturbs the review: leaves it unmounted in another environment, reloads the
 * renderer, restarts the backend, kills one reviewer's bridge, or kills only
 * the Claude reviewer's Claude Code process while its bridge stays up. The review
 * must still settle from backend state alone. On return, and again after a
 * reload, the snapshot and the tab must agree on phase, reviewer state,
 * reports, consolidation and controls. No reviewer may be cancelled, sent its
 * prompt twice, or moved to a fresh session. A reviewer whose turn a restart
 * or a dead bridge cut short may fail closed with a stated reason; the case
 * records each reviewer's outcome as an annotation.
 *
 * `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE=<n>` (2 to 32) adds a scale case:
 * an n-reviewer panel alternating Claude and Codex, started through
 * `start_multi_review`, sampled once a second for the backend's RSS and for
 * how many reviewers are setting up and running at once. It records tail
 * latency and peak RSS in `scale.json` beside the case's output.
 *
 * Models default to the cheapest each platform offers; override the picker
 * labels with `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CLAUDE_MODEL` and
 * `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CODEX_MODEL`. Nothing at module scope or
 * in a hook spawns `mise` or reads profile state, so the file stays inert
 * without the opt-in. Prompts and transcripts never reach test output.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { openSync, promises as fs } from "node:fs";
import path from "node:path";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { AgentModel } from "@orkestrator/protocol/native-agent";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  dataDir?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = {
  id: string;
  name: string;
  worktreePath?: string | null;
  claudeBridgePid?: number;
};
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Reviewer = MultiReviewWorkflow["reviewers"][number];
type ReviewerTranscript = {
  status: string;
  messages: unknown[];
  transcript?: "snapshot" | "unchanged";
  sourceToken?: string;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW === "1";
const CLAUDE_MODEL = process.env.ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CLAUDE_MODEL ?? "Haiku 4.5";
const CODEX_MODEL = process.env.ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CODEX_MODEL ?? "GPT-6-Luna";
const SCALE_REVIEWERS = Number(process.env.ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE ?? "0");
/** A real review on small models settles in a few minutes; allow for host load. */
const SETTLE_TIMEOUT_MS = 8 * 60_000;
const SETTLED_PHASES = new Set(["ready", "interactive", "completed", "failed", "cancelled"]);

test.describe.configure({ mode: "serial" });
// A multi-minute live trace outgrows the artifact sanitizer's 16 MiB bound, and
// an unsanitized trace may not be kept; failure screenshots still are.
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
  expect(
    status.status,
    `profile "${profile}" is not running; start it with mise run dev:test --fixture`,
  ).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  return status;
}

/** Signs the page in and returns an invoker bound to the profile's current gateway. */
async function signIn(page: Page, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  let login: { loginUrl?: unknown };
  try {
    login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  } catch {
    throw new Error("dev:login returned invalid JSON");
  }
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok() ?? false).toBe(true);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

/**
 * Stops the profile and starts it again with the credential and platform
 * selection stored in its `profile.json`, as quitting and reopening the app
 * would. `--fixture` is deliberately not passed: it recreates the fixture
 * repository, which every environment's worktree points at.
 */
async function restartProfile(logFile: string): Promise<Status> {
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const stored = JSON.parse(
    await fs.readFile(path.join(runtime.profileRoot, "profile.json"), "utf8"),
  ) as { credentialSources?: string[]; agentPlatforms?: string[] };
  const stop = spawnSync("mise", ["run", "dev:stop", "--profile", profile], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(stop.status, `dev:stop failed: ${stop.stderr}`).toBe(0);
  const args = [
    "apps/desktop/scripts/dev-test.ts",
    "--profile",
    profile,
    ...(stored.credentialSources ?? []).flatMap((source) => ["--credential-source", source]),
    ...(stored.agentPlatforms?.length
      ? ["--agent-platforms", stored.agentPlatforms.join(",")]
      : []),
  ];
  const output = openSync(logFile, "a");
  // The launcher is a foreground supervisor; it outlives this test and is
  // stopped with the profile, exactly like the one the caller started.
  const launcher = spawn("bun", args, {
    cwd: repositoryRoot,
    detached: true,
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
      { timeout: 180_000, intervals: [2_000] },
    )
    .toBe(true);
  return status!;
}

/** The authoritative snapshot of one workflow. */
async function readWorkflow(invoke: Invoke, workflowId: string): Promise<MultiReviewWorkflow> {
  return (
    await invoke<{ snapshot: MultiReviewWorkflow }>("get_multi_review_workflow", { workflowId })
  ).snapshot;
}

/** Phase, errors and reviewer states, without any prompt, transcript or report content. */
function describeWorkflow(workflow: MultiReviewWorkflow): string {
  return JSON.stringify({
    phase: workflow.phase,
    error: workflow.error,
    activeRequest: workflow.activeRequest && {
      kind: workflow.activeRequest.kind,
      state: workflow.activeRequest.state,
    },
    reviewers: workflow.reviewers.map((reviewer) => ({
      agent: reviewer.agent,
      status: reviewer.status,
      dispatchState: reviewer.dispatchState,
      resultReminderSent: reviewer.resultReminderSent,
      restartContinuationSent: reviewer.restartContinuationSent,
      error: reviewer.error,
    })),
  });
}

/** The text of a transcript row, from its content or its text parts. */
function rowText(message: { content?: unknown; parts?: unknown }): string {
  if (typeof message.content === "string" && message.content) return message.content;
  if (!Array.isArray(message.parts)) return "";
  return message.parts
    .map((part) => {
      const { text, content } = (part ?? {}) as { text?: unknown; content?: unknown };
      return typeof text === "string" ? text : typeof content === "string" ? content : "";
    })
    .join("");
}

/**
 * Each user turn in a reviewer transcript tail, named by the designed
 * follow-up it opens with. Only these labels are reported, never the text.
 */
function userTurnKinds(messages: unknown[]): string[] {
  return messages
    .filter(
      (message): message is { content?: unknown; parts?: unknown } =>
        typeof message === "object" &&
        message !== null &&
        (message as { role?: unknown }).role === "user",
    )
    .map((message) => {
      const text = rowText(message);
      if (text.startsWith("Orkestrator restarted while you were working")) return "restart";
      if (text.startsWith("Orkestrator has not received your")) return "reminder";
      if (text.startsWith("Your structured report already passed")) return "commit nudge";
      const tag = /^\s*<([a-z_]{1,40})>/.exec(text)?.[1];
      return tag ? `<${tag}>` : "prompt";
    });
}

/** The prompts a reviewer may legitimately have been sent: the review plus each designed follow-up. */
function allowedTurns(reviewer: Reviewer): number {
  return (
    1 +
    (reviewer.resultReminderSent ? 1 : 0) +
    (reviewer.restartContinuationSent ? 1 : 0) +
    (reviewer.schemaRepairAttempts ?? 0)
  );
}

class MultiReviewCycle {
  invoke!: Invoke;
  status!: Status;
  fixture!: Project;
  readonly environments: Environment[] = [];
  workflowId: string | undefined;

  constructor(
    private readonly page: Page,
    private readonly name: string,
  ) {}

  async open(): Promise<void> {
    this.status = readyStatus();
    this.invoke = await signIn(this.page, this.status);
    // A profile restarted without `--fixture` (as the restart case does) no
    // longer reports its test project, but the seeded copy is still there.
    const testProject =
      this.status.testProject ??
      path.join(
        resolveRuntimeProfile({ repositoryRoot, requestedId: profile, flavor: "agent-test" })
          .fixtureDir,
        "test-project",
      );
    const fixture = (await this.invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === testProject,
    );
    expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
    this.fixture = fixture!;
    for (const role of ["review", "elsewhere"]) {
      const environment = await this.invoke<Environment>("create_environment", {
        projectId: this.fixture.id,
        name: `mr-${this.name}-${role}-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      this.environments.push(environment);
      await this.invoke("start_environment", { environmentId: environment.id });
    }
    const target = await this.environment();
    expect(target.worktreePath).toBeTruthy();
    // A small change with one real defect (the percentage is never divided by
    // 100), so reviewers have something to report without a long turn.
    await fs.writeFile(
      path.join(target.worktreePath!, "discount.ts"),
      [
        "/** Applies a percentage discount to a price in cents. */",
        "export function applyDiscount(priceCents: number, percent: number): number {",
        "  if (percent > 100) throw new Error('percent must be at most 100');",
        "  return priceCents - priceCents * percent;",
        "}",
        "",
      ].join("\n"),
    );
  }

  /** The review environment, re-read so pids and paths are current. */
  environment(): Promise<Environment> {
    return this.invoke<Environment>("get_environment", {
      environmentId: this.environments[0]!.id,
    });
  }

  async reconnect(status: Status): Promise<void> {
    this.status = status;
    this.invoke = await signIn(this.page, status);
  }

  async gotoApp(): Promise<void> {
    await this.page.goto(this.status.browserUrl!);
    const expand = this.page.getByRole("button", {
      name: `Expand project ${this.fixture.name}`,
    });
    const entry = this.page.getByText(this.environments[0]!.name, { exact: true }).first();
    await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
    await expect(
      this.page.getByText("Checking Docker availability...", { exact: true }),
    ).toBeHidden({ timeout: 30_000 });
    for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
      const button = this.page.getByRole("button", {
        name: label,
        exact: true,
      });
      if (await button.isVisible()) await button.click();
    }
    await expect(
      this.page.getByText("Checking CLI tools installation...", {
        exact: true,
      }),
    ).toBeHidden({ timeout: 30_000 });
    if (await expand.isVisible()) await expand.click();
  }

  async openEnvironment(index: 0 | 1): Promise<void> {
    // Leave the previous row before crossing the sidebar's hover-detail card.
    await this.page.mouse.move(1100, 20);
    await this.page
      .getByText(this.environments[index]!.name, { exact: true })
      .first()
      .click({ timeout: 15_000 });
  }

  async chooseModel(row: string, platform: "claude" | "codex", model: string, effort?: string) {
    const trigger = this.page.getByRole("button", {
      name: `${row} model`,
      exact: true,
    });
    const menu = this.page.locator("[data-native-model-picker]");
    await trigger.click();
    await menu.getByRole("button", { name: `${platform} models`, exact: true }).click();
    await menu
      .getByRole("group", { name: "Models" })
      .getByRole("menuitemradio", {
        name: new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
      })
      .first()
      .click();
    if (effort) {
      if (!(await menu.isVisible())) await trigger.click();
      await menu
        .getByRole("group", { name: "Reasoning" })
        .getByRole("menuitemradio", { name: effort, exact: true })
        .click();
    }
    // Escape only while the menu is open: with it closed, Escape closes the dialog.
    if (await menu.isVisible()) await this.page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toContainText(model);
  }

  /** Launches through the real launcher and returns the saved workflow. */
  async launch(): Promise<MultiReviewWorkflow> {
    await this.gotoApp();
    await this.openEnvironment(0);
    const button = this.page.getByRole("button", {
      name: "Multi Review",
      exact: true,
    });
    await expect(button).toBeEnabled({ timeout: 60_000 });
    await button.click({ button: "right" });
    const dialog = this.page.getByRole("dialog", {
      name: "Configure Multi Review",
    });
    await expect(dialog).toBeVisible();
    const summary = dialog.getByTestId("multi-review-work-summary");
    await expect(summary).toContainText("2 reviewer turns");
    await this.chooseModel("Reviewer 1", "claude", CLAUDE_MODEL);
    await this.chooseModel("Reviewer 2", "codex", CODEX_MODEL, "Low");
    await this.chooseModel("Preparation & consolidation model", "codex", CODEX_MODEL, "Low");
    await this.chooseModel("Fix model", "codex", CODEX_MODEL, "Low");
    // Two different configurations: the launcher must not warn about duplicates.
    await expect(dialog.getByTestId("multi-review-duplicate-warning")).toHaveText("");
    await expect(
      dialog.getByRole("checkbox", { name: "Auto-fix after consolidation" }),
    ).not.toBeChecked();
    await dialog.getByRole("button", { name: "Start 2-model review", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(this.multiReviewHeading()).toBeVisible({ timeout: 30_000 });
    const workflows = await this.invoke<Array<{ id: string; snapshot: MultiReviewWorkflow }>>(
      "list_multi_review_workflows",
      {
        environmentId: this.environments[0]!.id,
      },
    );
    expect(workflows).toHaveLength(1);
    this.workflowId = workflows[0]!.id;
    const workflow = workflows[0]!.snapshot;
    expect(workflow.reviewers.map((reviewer) => [reviewer.agent, reviewer.model])).toEqual([
      ["claude", expect.any(String)],
      ["codex", expect.any(String)],
    ]);
    expect(workflow.autoFix ?? false).toBe(false);
    return workflow;
  }

  read(): Promise<MultiReviewWorkflow> {
    return readWorkflow(this.invoke, this.workflowId!);
  }

  /** Waits until the given reviewers' prompts are sent and their turns are live. */
  async waitForRunningReviewers(indexes: number[]): Promise<MultiReviewWorkflow> {
    let workflow: MultiReviewWorkflow | undefined;
    let preparationRestarted = false;
    await expect
      .poll(
        async () => {
          workflow = await this.read();
          if (workflow.phase === "failed") {
            // A small preparation model occasionally ends its turn without
            // calling its result tool, even after its reminder turn. That
            // happens before anything this spec disturbs, so restart the step
            // once, as a user would, and record it rather than fail the cycle.
            if (
              !preparationRestarted &&
              workflow.reviewers.every((reviewer) => !reviewer.requestId)
            ) {
              preparationRestarted = true;
              test.info().annotations.push({
                type: "preparation-restarted",
                description: workflow.error ?? "no error",
              });
              await this.invoke("restart_multi_review_step", {
                workflowId: this.workflowId,
                kind: "prepare",
              });
              return false;
            }
            throw new Error(`Multi Review failed before review: ${workflow.error ?? "no error"}`);
          }
          return indexes.every((index) => {
            const reviewer = workflow!.reviewers[index];
            return reviewer?.status === "running" && reviewer.dispatchState === "sent";
          });
        },
        { timeout: 6 * 60_000, intervals: [1_000] },
      )
      .toBe(true);
    return workflow!;
  }

  /** Waits until the review reaches a phase it cannot leave on its own. */
  async waitForSettled(): Promise<MultiReviewWorkflow> {
    let workflow: MultiReviewWorkflow | undefined;
    await expect
      .poll(
        async () => {
          workflow = await this.read();
          return SETTLED_PHASES.has(workflow.phase);
        },
        { timeout: SETTLE_TIMEOUT_MS, intervals: [2_000] },
      )
      .toBe(true);
    return workflow!;
  }

  /** Waits for the review to settle and requires it to be consolidated and ready. */
  async waitForReady(): Promise<MultiReviewWorkflow> {
    const workflow = await this.waitForSettled();
    expect(workflow.phase, describeWorkflow(workflow)).toBe("ready");
    return workflow;
  }

  /** Records how each reviewer came through a disruption, for the qualification log. */
  recordOutcomes(workflow: MultiReviewWorkflow, disruption: string): number[] {
    const failed: number[] = [];
    for (const [index, reviewer] of workflow.reviewers.entries()) {
      if (reviewer.status === "failed") failed.push(index);
      test.info().annotations.push({
        type: `reviewer-${index + 1}-${reviewer.agent}-after-${disruption}`,
        description: `${reviewer.status}${reviewer.restartContinuationSent ? " after the restart continuation" : ""}${reviewer.resultReminderSent ? " after the result reminder" : ""}${reviewer.error ? `: ${reviewer.error}` : ""}`,
      });
    }
    return failed;
  }

  multiReviewHeading() {
    return this.page.getByRole("heading", {
      name: "Multi Review",
      exact: true,
    });
  }

  /**
   * Snapshot checks that need no UI: settled, consolidated, no reviewer
   * cancelled, and no reviewer re-sent its prompt or moved to a fresh session.
   */
  async verifySnapshot(
    before: MultiReviewWorkflow,
    expectations: { failedReviewers?: number[] } = {},
  ): Promise<MultiReviewWorkflow> {
    const workflow = await this.read();
    const allFailed = workflow.reviewers.every((_reviewer, index) =>
      expectations.failedReviewers?.includes(index),
    );
    if (allFailed) {
      // With no report left there is nothing to consolidate: the review fails
      // closed and says why, and its reviewers stay restartable.
      expect(workflow.phase, describeWorkflow(workflow)).toBe("failed");
      expect(workflow.error).toBeTruthy();
    } else {
      expect(workflow.phase, describeWorkflow(workflow)).toBe("ready");
      expect(workflow.consolidatedReport).toBeDefined();
      expect(workflow.activeRequest).toBeUndefined();
    }
    expect(workflow.cancellingSince).toBeUndefined();
    for (const [index, reviewer] of workflow.reviewers.entries()) {
      const earlier = before.reviewers[index]!;
      expect(reviewer.status, `reviewer ${index + 1}`).not.toBe("cancelled");
      if (expectations.failedReviewers?.includes(index)) {
        expect(reviewer.status, `reviewer ${index + 1}`).toBe("failed");
        expect(reviewer.error, `reviewer ${index + 1} failed without saying why`).toBeTruthy();
      } else {
        expect(reviewer.status, `reviewer ${index + 1}: ${reviewer.error ?? ""}`).toBe("completed");
        expect(reviewer.report, `reviewer ${index + 1} has no report`).toBeDefined();
      }
      if (earlier.providerSessionId) {
        // Same session, same start: recovery continued the turn rather than
        // restarting the reviewer from scratch.
        expect(reviewer.providerSessionId, `reviewer ${index + 1} session`).toBe(
          earlier.providerSessionId,
        );
        expect(reviewer.startedAt, `reviewer ${index + 1} start`).toBe(earlier.startedAt);
      }
      if (earlier.requestId && reviewer.requestId !== earlier.requestId) {
        // A new request id is legitimate only for a designed follow-up turn.
        expect(
          reviewer.resultReminderSent === true ||
            reviewer.restartContinuationSent === true ||
            (reviewer.schemaRepairAttempts ?? 0) > 0,
          `reviewer ${index + 1} was re-dispatched under a new request id`,
        ).toBe(true);
      }
      if (reviewer.status === "completed") {
        const transcript = await this.invoke<ReviewerTranscript>(
          "get_multi_review_reviewer_transcript",
          { workflowId: this.workflowId, reviewerId: reviewer.id },
        );
        expect(transcript.messages.length).toBeGreaterThan(0);
        const kinds = userTurnKinds(transcript.messages);
        const turns = kinds.length;
        expect(turns, `reviewer ${index + 1} prompt count`).toBeGreaterThanOrEqual(1);
        expect(
          turns,
          `reviewer ${index + 1} was sent a prompt twice (${kinds.join(", ")})`,
        ).toBeLessThanOrEqual(allowedTurns(reviewer));
        // #833's conditional read: a current token answers `unchanged` with no messages.
        if (transcript.sourceToken) {
          const again = await this.invoke<ReviewerTranscript>(
            "get_multi_review_reviewer_transcript",
            {
              workflowId: this.workflowId,
              reviewerId: reviewer.id,
              knownSourceToken: transcript.sourceToken,
            },
          );
          expect(again.transcript).toBe("unchanged");
          expect(again.messages).toHaveLength(0);
        }
      }
    }
    return workflow;
  }

  pipeline() {
    return this.page.getByRole("tablist", { name: "Multi Review pipeline" }).first();
  }

  /** The graph node for one reviewer, named "Reviewer N · agent, Status, …". */
  reviewerNode(workflow: MultiReviewWorkflow, index: number) {
    const reviewer = workflow.reviewers[index]!;
    return this.pipeline().getByRole("tab", {
      name: new RegExp(`^Reviewer ${index + 1} · ${reviewer.agent},`),
    });
  }

  /** Tab checks: graph, inspector, findings and controls agree with the snapshot. */
  async verifyTab(workflow: MultiReviewWorkflow): Promise<void> {
    await expect(this.multiReviewHeading()).toBeVisible({ timeout: 30_000 });
    await expect(this.pipeline()).toBeVisible();
    await expect(this.pipeline().locator('[data-flow-node="reviewer"]')).toHaveCount(
      workflow.reviewers.length,
    );
    for (const [index, reviewer] of workflow.reviewers.entries()) {
      const node = this.reviewerNode(workflow, index);
      await expect(node).toHaveAttribute(
        "data-flow-state",
        reviewer.status === "completed" ? "complete" : "failed",
      );
      if (reviewer.report) {
        await expect(node).toHaveAccessibleName(
          new RegExp(`${reviewer.report.issues.length} issues? found`),
        );
      }
    }
    await expect(
      this.pipeline().getByRole("tab", { name: /^Review package, Package ready/ }),
    ).toBeVisible();
    const inspector = this.page.getByTestId("multi-review-inspector");
    // A failed reviewer says why, offers Restart and no Stop.
    for (const [index, reviewer] of workflow.reviewers.entries()) {
      if (reviewer.status !== "failed") continue;
      await this.reviewerNode(workflow, index).click();
      await expect(inspector).toContainText(reviewer.error!.slice(0, 40));
      await expect(
        inspector.getByRole("button", { name: `Restart Reviewer ${index + 1}`, exact: true }),
      ).toBeEnabled();
      await expect(inspector.getByRole("button", { name: /^Stop / })).toHaveCount(0);
    }
    const completed = workflow.reviewers.findIndex((reviewer) => reviewer.status === "completed");
    if (completed < 0) {
      // Nothing to consolidate: the review failed closed before consolidation.
      await expect(
        this.pipeline().getByRole("tab", { name: /^Consolidation, Complete/ }),
      ).toHaveCount(0);
      return;
    }
    await expect(
      this.pipeline().getByRole("tab", { name: /^Consolidation, Complete/ }),
    ).toBeVisible();
    await expect(this.pipeline().getByRole("tab", { name: /^Fix, Ready to start/ })).toBeVisible();
    // A completed reviewer's inspector shows its transcript tail from the backend.
    await this.reviewerNode(workflow, completed).click();
    await expect(inspector.getByTestId("multi-review-transcript-tail")).not.toBeEmpty({
      timeout: 30_000,
    });
    // A settled review offers no reviewer Stop, and offers Fix.
    await expect(inspector.getByRole("button", { name: /^Stop / })).toHaveCount(0);
    await expect(this.page.getByRole("button", { name: "Fix", exact: true })).toBeEnabled();
  }

  /** Opens a completed reviewer's read-only transcript tab (#833) and checks it renders. */
  async openReviewerTab(workflow: MultiReviewWorkflow): Promise<void> {
    const completed = workflow.reviewers.findIndex((reviewer) => reviewer.status === "completed");
    await this.reviewerNode(workflow, completed).click();
    await this.page
      .getByTestId("multi-review-inspector")
      .getByRole("button", {
        name: new RegExp(`^Open Reviewer ${completed + 1} transcript`),
      })
      .click();
    await this.verifyReviewerTab();
  }

  async verifyReviewerTab(): Promise<void> {
    await expect(this.page.getByRole("heading", { level: 1, name: / review$/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(this.page.getByText(/· Read only$/).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(this.page.getByText("Reviewer report", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
  }

  async cleanup(): Promise<void> {
    if (this.workflowId) {
      await this.invoke("cancel_multi_review", {
        workflowId: this.workflowId,
      }).catch(() => undefined);
    }
    for (const environment of this.environments) {
      await this.invoke("stop_environment", {
        environmentId: environment.id,
      }).catch(() => undefined);
      await this.invoke("delete_environment", {
        environmentId: environment.id,
      }).catch(() => undefined);
    }
  }
}

/**
 * Kills one bridge this profile's backend spawned. It must be a Claude bridge
 * whose parent is the profile's live backend, so nothing another profile or
 * checkout owns is ever signalled.
 */
function killOwnedBridge(pid: number): void {
  const status = profileStatus() as Status & { pids?: { backend?: number } };
  const backend = status.pids?.backend;
  expect(backend, "dev:status reported no backend pid").toBeTruthy();
  const command = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const match = /^\s*(\d+)\s+(.*)$/.exec(command.stdout.trim());
  expect(match, `bridge ${pid} is not running`).toBeTruthy();
  expect(Number(match![1]), "the bridge is not a child of this profile's backend").toBe(backend);
  expect(match![2], "the pid is not a Claude bridge").toMatch(/claude-bridge/);
  process.kill(pid, "SIGKILL");
}

/**
 * Kills the Claude Code CLI under one bridge this profile's backend spawned,
 * leaving the bridge itself up. The bridge must pass {@link killOwnedBridge}'s
 * ownership checks, and exactly one direct child of it must be a Claude Code
 * process (the reviewer's turn), so nothing else is ever signalled.
 */
function killOwnedClaudeCli(bridgePid: number): number {
  const status = profileStatus() as Status & { pids?: { backend?: number } };
  const backend = status.pids?.backend;
  expect(backend, "dev:status reported no backend pid").toBeTruthy();
  const table = spawnSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  const rows = table.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }));
  const bridge = rows.find((row) => row.pid === bridgePid);
  expect(bridge, `bridge ${bridgePid} is not running`).toBeTruthy();
  expect(bridge!.ppid, "the bridge is not a child of this profile's backend").toBe(backend);
  expect(bridge!.command, "the pid is not a Claude bridge").toMatch(/claude-bridge/);
  // The Agent SDK runs the pinned `claude` binary in stream-json mode; its
  // arguments name MCP config files, so match the executable, not keywords.
  const clis = rows.filter(
    (row) =>
      row.ppid === bridgePid &&
      /\/claude --output-format stream-json(\s|$)/.test(row.command) &&
      !/claude-bridge/.test(row.command),
  );
  expect(clis.length, "expected exactly one Claude Code process under the bridge").toBe(1);
  process.kill(clis[0]!.pid, "SIGKILL");
  return clis[0]!.pid;
}

test.describe("live Multi Review inactive-environment cycle", () => {
  test.skip(!LIVE_OPT_IN, "opt-in live Multi Review against the isolated fixture");
  test.setTimeout(15 * 60_000);

  test("settles while unmounted in another environment and rehydrates after reload", async ({
    page,
  }) => {
    page.setDefaultTimeout(15_000);
    const cycle = new MultiReviewCycle(page, "unmount");
    try {
      await cycle.open();
      await cycle.launch();
      const before = await cycle.waitForRunningReviewers([0]);
      await cycle.openEnvironment(1);
      await expect(cycle.multiReviewHeading()).toHaveCount(0);
      await cycle.waitForReady();
      const settled = await cycle.verifySnapshot(before);
      await cycle.openEnvironment(0);
      await cycle.verifyTab(settled);
      await page.reload();
      await cycle.gotoApp();
      await cycle.openEnvironment(0);
      await cycle.verifyTab(settled);
      await cycle.openReviewerTab(settled);
      // The reviewer tab is pane layout state; it must rehydrate from the backend too.
      await page.reload();
      await cycle.gotoApp();
      await cycle.openEnvironment(0);
      await cycle.verifyReviewerTab();
    } finally {
      await cycle.cleanup();
    }
  });

  test("survives a renderer reload while reviewers run", async ({ page }) => {
    page.setDefaultTimeout(15_000);
    const cycle = new MultiReviewCycle(page, "reload");
    try {
      await cycle.open();
      await cycle.launch();
      const before = await cycle.waitForRunningReviewers([0]);
      await page.reload();
      await cycle.gotoApp();
      await cycle.openEnvironment(0);
      await expect(cycle.multiReviewHeading()).toBeVisible({ timeout: 30_000 });
      const live = await cycle.read();
      expect(live.phase).not.toBe("cancelled");
      expect(live.reviewers.every((reviewer) => reviewer.status !== "cancelled")).toBe(true);
      await cycle.openEnvironment(1);
      await cycle.waitForReady();
      const settled = await cycle.verifySnapshot(before);
      await cycle.openEnvironment(0);
      await cycle.verifyTab(settled);
    } finally {
      await cycle.cleanup();
    }
  });

  test("converges after a backend restart while reviewers run", async ({ page }, testInfo) => {
    page.setDefaultTimeout(15_000);
    const cycle = new MultiReviewCycle(page, "restart");
    try {
      await cycle.open();
      await cycle.launch();
      const before = await cycle.waitForRunningReviewers([0, 1]);
      await cycle.openEnvironment(1);
      const restarted = await restartProfile(testInfo.outputPath("dev-test-restart.log"));
      await cycle.reconnect(restarted);
      const resumed = await cycle.read();
      expect(resumed.phase).not.toBe("cancelled");
      // Both bridges report a turn the restart cut short, and the runner
      // continues it once in the same session, so both reviewers must finish.
      // Outcomes are still recorded. Everything else is held: no cancellation,
      // no prompt beyond the designed follow-ups, no fresh session, and a tab
      // that agrees with the snapshot.
      const settledAfterRestart = await cycle.waitForSettled();
      const failed = cycle.recordOutcomes(settledAfterRestart, "restart");
      for (const reviewer of settledAfterRestart.reviewers) {
        expect(reviewer.status, describeWorkflow(settledAfterRestart)).toBe("completed");
      }
      const settled = await cycle.verifySnapshot(before, { failedReviewers: failed });
      await cycle.gotoApp();
      await cycle.openEnvironment(0);
      await cycle.verifyTab(settled);
      await page.reload();
      await cycle.gotoApp();
      await cycle.openEnvironment(0);
      await cycle.verifyTab(settled);
    } finally {
      await cycle.cleanup();
    }
  });

  test("isolates an interrupted reviewer bridge to that reviewer", async ({ page }) => {
    page.setDefaultTimeout(15_000);
    const cycle = new MultiReviewCycle(page, "bridge");
    try {
      await cycle.open();
      await cycle.launch();
      const before = await cycle.waitForRunningReviewers([0, 1]);
      await cycle.openEnvironment(1);
      const environment = await cycle.environment();
      expect(environment.claudeBridgePid, "the Claude reviewer has no bridge pid").toBeTruthy();
      killOwnedBridge(environment.claudeBridgePid!);
      const after = await cycle.waitForReady();
      // The Codex peer must finish on its own report whatever happened to Claude.
      expect(after.reviewers[1]!.status, describeWorkflow(after)).toBe("completed");
      // The restarted bridge reports the Claude turn cut short, so the reviewer
      // continues in its own session and finishes.
      const failed = cycle.recordOutcomes(after, "bridge-kill");
      expect(after.reviewers[0]!.status, describeWorkflow(after)).toBe("completed");
      const settled = await cycle.verifySnapshot(before, { failedReviewers: failed });
      await cycle.openEnvironment(0);
      await cycle.verifyTab(settled);
      await page.reload();
      await cycle.gotoApp();
      await cycle.openEnvironment(0);
      await cycle.verifyTab(settled);
    } finally {
      await cycle.cleanup();
    }
  });

  test("continues a reviewer whose Claude Code process was killed under a live bridge", async ({
    page,
  }) => {
    page.setDefaultTimeout(15_000);
    const cycle = new MultiReviewCycle(page, "cli");
    try {
      await cycle.open();
      await cycle.launch();
      const before = await cycle.waitForRunningReviewers([0, 1]);
      await cycle.openEnvironment(1);
      const environment = await cycle.environment();
      expect(environment.claudeBridgePid, "the Claude reviewer has no bridge pid").toBeTruthy();
      killOwnedClaudeCli(environment.claudeBridgePid!);
      const after = await cycle.waitForReady();
      expect(after.reviewers[1]!.status, describeWorkflow(after)).toBe("completed");
      // The bridge stayed up and reports the signalled CLI as a turn cut short
      // (`process_killed_by_signal`), so the reviewer continues once in its
      // own session and finishes.
      const failed = cycle.recordOutcomes(after, "cli-kill");
      expect(after.reviewers[0]!.status, describeWorkflow(after)).toBe("completed");
      expect(after.reviewers[0]!.restartContinuationSent, describeWorkflow(after)).toBe(true);
      expect((await cycle.environment()).claudeBridgePid, "the bridge was replaced").toBe(
        environment.claudeBridgePid,
      );
      const settled = await cycle.verifySnapshot(before, { failedReviewers: failed });
      await cycle.openEnvironment(0);
      await cycle.verifyTab(settled);
      await page.reload();
      await cycle.gotoApp();
      await cycle.openEnvironment(0);
      await cycle.verifyTab(settled);
    } finally {
      await cycle.cleanup();
    }
  });
  test("scale: a mixed real-provider panel keeps the fan-out caps", async ({ page }, testInfo) => {
    test.skip(
      !(Number.isInteger(SCALE_REVIEWERS) && SCALE_REVIEWERS >= 2 && SCALE_REVIEWERS <= 32),
      "set ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE to a panel size from 2 to 32",
    );
    test.setTimeout(45 * 60_000);
    page.setDefaultTimeout(15_000);
    const cycle = new MultiReviewCycle(page, `scale${SCALE_REVIEWERS}`);
    try {
      await cycle.open();
      const environmentId = cycle.environments[0]!.id;
      const catalog = await cycle.invoke<AgentModel[]>("get_native_agent_model_catalog", {
        environmentId,
      });
      const pick = (platform: "claude" | "codex", label: string) => {
        const model = catalog.find(
          (entry) => entry.platform === platform && entry.label.startsWith(label),
        );
        expect(model, `no ${platform} model labelled ${label}`).toBeTruthy();
        return model!.id;
      };
      const claude = { agent: "claude" as const, model: pick("claude", CLAUDE_MODEL) };
      const codex = {
        agent: "codex" as const,
        model: pick("codex", CODEX_MODEL),
        reasoningEffort: "low",
      };
      const targetBranch = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: cycle.fixture.localPath!,
        encoding: "utf8",
      }).stdout.trim();
      expect(targetBranch, "the fixture project has no branch").toBeTruthy();
      const backend = (profileStatus() as Status & { pids?: { backend?: number } }).pids?.backend;
      expect(backend, "dev:status reported no backend pid").toBeTruthy();
      const rssMiB = () => {
        const kib = Number(
          spawnSync("ps", ["-o", "rss=", "-p", String(backend)], { encoding: "utf8" }).stdout,
        );
        return Number.isFinite(kib) ? kib / 1024 : 0;
      };
      const baselineRssMiB = rssMiB();
      const started = await cycle.invoke<MultiReviewWorkflow>("start_multi_review", {
        environmentId,
        projectId: cycle.fixture.id,
        targetBranch,
        reviewers: Array.from({ length: SCALE_REVIEWERS }, (_, index) =>
          index % 2 === 0 ? claude : codex,
        ),
        reviewModel: codex,
        fixModel: codex,
      });
      cycle.workflowId = started.id;
      const launchedAt = Date.now();
      let peakRssMiB = baselineRssMiB;
      let maxSettingUp = 0;
      const maxRunning: Record<string, number> = {};
      let workflow = started;
      while (!SETTLED_PHASES.has(workflow.phase) && Date.now() - launchedAt < 40 * 60_000) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        workflow = await cycle.read();
        peakRssMiB = Math.max(peakRssMiB, rssMiB());
        // A reviewer between admission and its sent prompt is setting up.
        const settingUp = workflow.reviewers.filter(
          (reviewer) => reviewer.status === "running" && reviewer.dispatchState !== "sent",
        ).length;
        maxSettingUp = Math.max(maxSettingUp, settingUp);
        for (const agent of ["claude", "codex"]) {
          const running = workflow.reviewers.filter(
            (reviewer) => reviewer.agent === agent && reviewer.status === "running",
          ).length;
          maxRunning[agent] = Math.max(maxRunning[agent] ?? 0, running);
        }
      }
      const latencies = workflow.reviewers
        .filter((reviewer) => reviewer.startedAt && reviewer.completedAt)
        .map((reviewer) => Date.parse(reviewer.completedAt!) - Date.parse(reviewer.startedAt!))
        .sort((left, right) => left - right);
      const quantile = (q: number) =>
        latencies.length
          ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!
          : null;
      const result = {
        reviewers: SCALE_REVIEWERS,
        phase: workflow.phase,
        completed: workflow.reviewers.filter((reviewer) => reviewer.status === "completed").length,
        failed: workflow.reviewers.filter((reviewer) => reviewer.status === "failed").length,
        wallMs: Date.now() - launchedAt,
        reviewerLatencyMs: {
          p50: quantile(0.5),
          p95: quantile(0.95),
          max: latencies.at(-1) ?? null,
        },
        baselineRssMiB: Math.round(baselineRssMiB),
        peakRssMiB: Math.round(peakRssMiB),
        maxSettingUpObserved: maxSettingUp,
        maxRunningObserved: maxRunning,
      };
      await fs.writeFile(testInfo.outputPath("scale.json"), `${JSON.stringify(result, null, 2)}\n`);
      test.info().annotations.push({ type: "scale", description: JSON.stringify(result) });
      expect(SETTLED_PHASES.has(workflow.phase), describeWorkflow(workflow)).toBe(true);
      // Sampled once a second, so these can only catch a cap being exceeded.
      expect(maxSettingUp).toBeLessThanOrEqual(4);
      for (const reviewer of workflow.reviewers) {
        if (reviewer.status === "failed")
          expect(reviewer.error, describeWorkflow(workflow)).toBeTruthy();
        else expect(reviewer.status, describeWorkflow(workflow)).toBe("completed");
      }
    } finally {
      await cycle.cleanup();
    }
  });
});
