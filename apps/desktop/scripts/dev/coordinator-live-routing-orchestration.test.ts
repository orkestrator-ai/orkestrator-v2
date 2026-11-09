import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import { runCoordinatorCleanup, type DelegationCoordinator } from "./coordinator-live-observer.js";
import { runRoutingScenario } from "./coordinator-live-routing-orchestration.js";
import type { RoutingCase } from "./coordinator-live-routing.js";
import { STATUS_REVIEWEE_FILE } from "./coordinator-live-status.js";

const token = "scripted";
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const tool = (
  toolName: string,
  toolArgs: Record<string, unknown>,
): CoordinatorTranscriptMessage => ({
  role: "assistant",
  parts: [{ toolName, toolArgs, toolState: "success" }],
});

/**
 * How the scripted coordinator answers each request. The default routes every
 * case as the rules say; each flag makes one case misroute.
 */
type Script = {
  /** The build request goes to a prompt environment instead. */
  buildToEnvironment?: boolean;
  failedInvestigation?: boolean;
  reusedInvestigation?: boolean;
  rollingProjection?: boolean;
  instantTurns?: boolean;
  /** The build is started with an explicit agent. */
  buildOverridesAgent?: boolean;
  /** The investigation becomes a ticket and a build. */
  investigateBuilds?: boolean;
  /** The review is launched with auto-fix and auto-PR on. */
  reviewAutomation?: boolean;
  /** The finished build opens a PR whatever its ticket says. */
  ignoresDelivery?: boolean;
  /** One case's coordinator turn fails. */
  failTurn?: RoutingCase;
};

async function fixture(script: Script = {}) {
  const now = () => new Date().toISOString();
  const worktree = await mkdtemp(path.join(tmpdir(), "routing-orchestration-"));
  directories.push(worktree);
  const messages: CoordinatorTranscriptMessage[] = [];
  const tickets: Array<Record<string, unknown>> = [];
  const environments: Array<Record<string, unknown>> = [{ id: "fixture-local", name: "fixture" }];
  const workflows: Array<Record<string, unknown>> = script.reusedInvestigation
    ? [
        {
          kind: "environment",
          conversationId: "conversation",
          resourceId: "fixture-local",
          delegation: {
            requestedAt: "old-request",
            workerTabId: "startup-agent",
            state: "completed",
            wokenAt: "old-wake",
          },
        },
      ]
    : [];
  const pipelines = new Map<string, Record<string, unknown>>();
  const reviews: Array<Record<string, unknown>> = [];
  const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
  let config: Record<string, unknown> = { agentSettings: { defaultAgent: "claude" } };
  let repositorySettings: Record<string, unknown> = {};
  let workingReads = 0;
  let turnError: string | undefined;
  /** Reads left until the investigating worker reports. */
  let reportReads = -1;
  let next = 0;
  const id = (prefix: string) => `${prefix}-${++next}`;

  const startBuild = (taskId: string, args: Record<string, unknown> = {}) => {
    const pipelineId = id("pipeline");
    pipelines.set(pipelineId, {
      id: pipelineId,
      taskId,
      phase: "building",
      sessions: [{ phase: "build" }],
    });
    workflows.push({
      kind: "build-pipeline",
      conversationId: "conversation",
      resourceId: pipelineId,
    });
    messages.push(
      tool("mcp__orkestrator__start_build_pipeline", {
        requestId: id("request"),
        taskId,
        baseBranch: "main",
        baseCommit: "0".repeat(40),
        ...args,
      }),
    );
  };
  const createTicket = (title: string) => {
    const ticketId = id("ticket");
    tickets.push({ id: ticketId, title, acceptanceCriteria: "- tests pass", sections: {} });
    messages.push(
      tool("mcp__orkestrator__create_ticket", { title, acceptanceCriteria: "- tests pass" }),
    );
    return ticketId;
  };
  const launchWorker = () => {
    const environmentId = id("worker");
    environments.push({ id: environmentId, name: environmentId });
    workflows.push({
      kind: "environment",
      conversationId: "conversation",
      resourceId: environmentId,
      delegation: { requestedAt: now(), workerTabId: "startup-agent", state: "running" },
    });
    messages.push(tool("launch_environment", { name: environmentId, prompt: "run it" }));
    reportReads = 3;
  };

  const respond = (prompt: string) => {
    const kind: RoutingCase = prompt.includes("clampPercent")
      ? "build"
      : prompt.includes("bun run check")
        ? "investigate"
        : prompt.includes("Review the work")
          ? "review"
          : "delivery";
    if (script.rollingProjection) {
      for (let i = 0; i < 195; i++) messages.push({ role: "assistant" });
    }
    messages.push({ role: "user", content: "harness prompt" });
    if (script.failTurn === kind) {
      turnError = "provider error";
      return;
    }
    if (kind === "build" || kind === "delivery") {
      if (kind === "build" && script.buildToEnvironment) return launchWorker();
      const ticketId = createTicket(kind);
      startBuild(
        ticketId,
        kind === "build" && script.buildOverridesAgent ? { agentType: "codex" } : {},
      );
      return;
    }
    if (kind === "investigate") {
      if (script.investigateBuilds) {
        startBuild(createTicket("investigate"));
        return;
      }
      if (script.failedInvestigation) {
        messages.push({ parts: [{ toolName: "launch_environment", toolState: "error" }] });
        return;
      }
      if (script.reusedInvestigation) {
        workflows[0]!.delegation = {
          requestedAt: now(),
          workerTabId: "reused-tab",
          state: "running",
        };
        messages.push(
          tool("send_prompt_to_tab", { environmentId: "fixture-local", tabId: "reused-tab" }),
        );
        reportReads = 30;
        return;
      }
      return launchWorker();
    }
    const environmentId = environments.find((item) =>
      String(item.name).startsWith("routing-review-"),
    )!.id as string;
    const automation = script.reviewAutomation ? { autoFix: true, autoPr: true } : {};
    const reviewId = id("review");
    reviews.push({ id: reviewId, environmentId, ...automation });
    workflows.push({ kind: "multi-review", conversationId: "conversation", resourceId: reviewId });
    messages.push(
      tool("launch_multi_review", { requestId: id("request"), environmentId, ...automation }),
    );
  };

  /** A build finishes on its second read: the first is the harness's, straight after the turn. */
  const advancePipeline = (pipeline: Record<string, unknown>) => {
    pipeline.reads = Number(pipeline.reads ?? 0) + 1;
    if (pipeline.phase !== "building" || (pipeline.reads as number) < 2) return;
    const ticket = tickets.find((item) => item.id === pipeline.taskId);
    const policy =
      (ticket?.sections as { delivery?: { policy?: string } } | undefined)?.delivery?.policy ??
      "open-pr";
    const effective = script.ignoresDelivery ? "open-pr" : policy;
    pipeline.delivery = { policy: effective, decidedAt: now() };
    pipeline.phase = "complete";
    if (effective !== "commit-only") {
      (pipeline.sessions as unknown[]).push({ phase: "pr" });
      pipeline.prUrl = "https://example.invalid/pr/1";
    }
  };

  const invoke: DelegationCoordinator["invoke"] = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    commands.push({ command, args });
    let value: unknown = null;
    switch (command) {
      case "get_kanban_tasks":
        value = tickets.map((ticket) => ({ ...ticket }));
        break;
      case "delete_kanban_task":
        tickets.splice(
          tickets.findIndex((ticket) => ticket.id === args.taskId),
          1,
        );
        break;
      case "update_kanban_task": {
        const ticket = tickets.find((item) => item.id === args.taskId)!;
        ticket.sections = { ...(ticket.sections as object), ...(args.sections as object) };
        break;
      }
      case "get_environments":
        value = environments.map((environment) => ({ ...environment }));
        break;
      case "create_environment": {
        const environmentId = id("environment");
        environments.push({ id: environmentId, name: args.name, branch: args.name });
        value = { id: environmentId };
        break;
      }
      case "get_environment":
        value = {
          ...environments.find((item) => item.id === args.environmentId),
          worktreePath: worktree,
        };
        break;
      case "start_environment":
      case "stop_environment":
        break;
      case "delete_environment":
        environments.splice(
          environments.findIndex((item) => item.id === args.environmentId),
          1,
        );
        break;
      case "get_config":
        value = { global: { ...config }, repositories: { project: { ...repositorySettings } } };
        break;
      case "update_global_config":
        config = { ...(args.global as Record<string, unknown>) };
        break;
      case "patch_repository_settings":
        repositorySettings = { ...repositorySettings, ...(args.updates as object) };
        for (const key of (args.unset as string[] | undefined) ?? [])
          delete repositorySettings[key];
        break;
      case "get_project_coordinator":
        value = { workflows: workflows.map((workflow) => ({ ...workflow })) };
        break;
      case "get_build_pipeline": {
        const pipeline = pipelines.get(String(args.pipelineId));
        if (pipeline) advancePipeline(pipeline);
        value = pipeline
          ? { id: pipeline.id, snapshot: structuredClone(pipeline), revision: 1 }
          : null;
        break;
      }
      case "cancel_build_pipeline": {
        const pipeline = pipelines.get(String(args.pipelineId))!;
        pipeline.phase = "failed";
        pipeline.cancelledAt = now();
        value = { ...pipeline };
        break;
      }
      case "list_multi_review_workflows":
        value = reviews.filter((review) => review.environmentId === args.environmentId);
        break;
      case "cancel_multi_review":
        break;
      case "dispatch_native_agent_intent":
        workingReads = script.instantTurns ? 0 : 2;
        if (String(args.prompt).includes("Review the work") && script.reusedInvestigation) {
          expect(reportReads).toBe(0);
        }
        respond(String(args.prompt));
        break;
      case "get_prompt_queue":
        value = { messages: [] };
        break;
      case "get_agent_mail_mailbox":
        value = { messages: [] };
        break;
      case "get_native_agent_projection":
        if (args.environmentId === "coordinator") {
          let phase = "idle";
          if (turnError) {
            phase = "error";
            turnError = undefined;
          } else if (workingReads > 0) {
            workingReads -= 1;
            phase = "working";
          }
          if (reportReads > 0 && --reportReads === 0) {
            for (const workflow of workflows) {
              const delegation = workflow.delegation as Record<string, unknown> | undefined;
              if (delegation?.state === "running") {
                Object.assign(delegation, {
                  state: "completed",
                  completedAt: now(),
                  wokenAt: now(),
                });
              }
            }
            workingReads = 2;
          }
          value = {
            turn: { phase, error: phase === "error" ? "provider error" : undefined },
            messages: messages.map((row, i) => ({ ...row, id: String(i) })).slice(-200),
          };
        } else {
          value = { turn: { phase: reportReads > 0 ? "working" : "idle" }, messages: [] };
        }
        break;
      default:
        throw new Error(`unscripted command ${command}`);
    }
    return value as T;
  };
  const coordinator: DelegationCoordinator = {
    invoke,
    identity: { environmentId: "coordinator", agent: "claude", logicalSessionKey: "coord" },
    conversation: { id: "conversation", tabId: "coord-tab" },
    projectId: "project",
  };
  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform: "claude",
    verdict: "passed",
    startedAt: "test",
  };
  return {
    coordinator,
    summary,
    commands,
    worktree,
    tickets,
    environments,
    config: () => config,
    repositorySettings: () => repositorySettings,
  };
}

async function run(script: Script = {}) {
  const scripted = await fixture(script);
  const cleanup: Array<() => Promise<unknown>> = [];
  const lines: string[] = [];
  const previous = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
  process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = "300";
  try {
    const result = await runRoutingScenario({
      coordinator: scripted.coordinator,
      summary: scripted.summary,
      cleanup,
      token,
      pollIntervalMs: 1,
      quietMs: 5,
      log: (line) => lines.push(line),
    });
    const reviewed = await readFile(
      path.join(scripted.worktree, STATUS_REVIEWEE_FILE.path),
      "utf8",
    ).catch(() => null);
    return { ...result, ...scripted, reviewed, lines };
  } finally {
    if (previous === undefined)
      delete process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
    else process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = previous;
    await runCoordinatorCleanup(cleanup, scripted.summary);
  }
}

const failed = (checks: Array<{ name: string; passed: boolean }>) =>
  checks.filter((item) => !item.passed).map((item) => item.name);

test("a coordinator that routes every request as the rules say qualifies", async () => {
  const { checks, observed, commands, reviewed } = await run();
  expect(checks.filter((item) => !item.passed)).toEqual([]);
  expect(checks.map((item) => item.name)).toEqual(
    expect.arrayContaining([
      "build-finished",
      "investigate-finished",
      "review-finished",
      "delivery-finished",
      "delivery-commit-only-complete",
      "delivery-no-pr-stage",
      "no-user-action",
    ]),
  );
  expect(reviewed).toBe(STATUS_REVIEWEE_FILE.content);
  expect(observed).toMatchObject({
    "build:create_ticket": 1,
    "build:start_build_pipeline": 1,
    "investigate:launch_environment": 1,
    "review:launch_multi_review": 1,
    "delivery:start_build_pipeline": 1,
  });
  // The first build and the review are cancelled once judged; the commit-only build is not.
  const cancelled = commands.filter((item) => item.command === "cancel_build_pipeline");
  expect(cancelled.map((item) => item.args.pipelineId)).toEqual(["pipeline-2"]);
  expect(commands.some((item) => item.command === "cancel_multi_review")).toBe(true);
  const flip = commands.find((item) => item.command === "update_kanban_task");
  expect(flip?.args).toEqual({
    taskId: expect.any(String),
    sections: { delivery: { policy: "commit-only" } },
  });
});

test("the saved defaults are set for the run and restored, and every ticket and environment is removed", async () => {
  const { config, repositorySettings, tickets, environments, summary } = await run();
  expect(summary.verdict).toBe("passed");
  expect(config()).toEqual({ agentSettings: { defaultAgent: "claude" } });
  expect(repositorySettings()).toEqual({});
  expect(tickets).toEqual([]);
  expect(environments.map((item) => item.id)).toEqual(["fixture-local"]);
});

test("a specified change sent to a prompt environment fails the build case only", async () => {
  const { checks } = await run({ buildToEnvironment: true });
  expect(failed(checks)).toEqual([
    "build-ticket-created",
    "build-pipeline-started",
    "build-ticket-before-build",
    "build-defaults-kept",
    "build-no-other-workflow",
  ]);
});

test("a build that overrides the saved agent fails defaults-kept", async () => {
  const { checks } = await run({ buildOverridesAgent: true });
  expect(failed(checks)).toEqual(["build-defaults-kept"]);
  expect(checks.find((item) => item.name === "build-defaults-kept")?.detail).toBe(
    "overrode agentType",
  );
});

test("an investigation turned into a build fails, and the build is cancelled", async () => {
  const { checks, commands } = await run({ investigateBuilds: true });
  expect(failed(checks)).toEqual(["investigate-delegated", "investigate-no-build-or-review"]);
  expect(commands.filter((item) => item.command === "cancel_build_pipeline")).toHaveLength(2);
});

test("a review launched with auto-fix and auto-PR fails, from the call and the workflow", async () => {
  const { checks } = await run({ reviewAutomation: true });
  expect(failed(checks)).toEqual(["review-auto-actions-off"]);
  expect(checks.find((item) => item.name === "review-auto-actions-off")?.detail).toBe(
    "requested autoFix, autoPr; workflow autoFix true, autoPr true",
  );
});

test("a commit-only build that opens a PR fails", async () => {
  const { checks } = await run({ ignoresDelivery: true });
  expect(failed(checks)).toEqual(["delivery-commit-only-complete", "delivery-no-pr-stage"]);
});

test("a failed turn fails its case and the later cases still run", async () => {
  const { checks } = await run({ failTurn: "build" });
  expect(failed(checks)).toEqual(["build-finished"]);
  expect(checks.find((item) => item.name === "build-finished")?.detail).toContain("provider error");
  for (const name of ["investigate-finished", "review-finished", "delivery-finished"]) {
    expect(checks.find((item) => item.name === name)?.passed).toBe(true);
  }
});

test("each case edge prints a content-free progress line", async () => {
  const { lines } = await run({ failTurn: "review" });
  expect(lines.map((line) => line.replace(/\d+s$/, "Ns"))).toEqual([
    "[coordinator-live] claude: routing case build started",
    "[coordinator-live] claude: routing case build finished in Ns",
    "[coordinator-live] claude: routing case investigate started",
    "[coordinator-live] claude: routing case investigate finished in Ns",
    "[coordinator-live] claude: routing case review started",
    "[coordinator-live] claude: routing case review failed after Ns",
    "[coordinator-live] claude: routing case delivery started",
    "[coordinator-live] claude: routing case delivery finished in Ns",
  ]);
});

test("a failed investigation launch without a backend worker fails delegation", async () => {
  const { checks } = await run({ failedInvestigation: true });
  expect(failed(checks)).toEqual(["investigate-delegated"]);
});

test("a reused worker's late report and wake finish before the review begins", async () => {
  const { checks, observed } = await run({ reusedInvestigation: true });
  expect(failed(checks)).toEqual([]);
  expect(observed["investigate:send_prompt_to_tab"]).toBe(1);
});

test("cases still collect calls after the projection fills and rolls", async () => {
  const { checks } = await run({ rollingProjection: true, instantTurns: true });
  expect(failed(checks)).toEqual([]);
});
