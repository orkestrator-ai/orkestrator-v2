import { PromptRejectedError } from "../agent-provider-contract.js";
import { afterEach, describe, expect, test } from "bun:test";
import type { MultiReviewActionResult } from "@orkestrator/protocol/multi-review";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";

/**
 * The environment buttons as public actions: Create PR and Resolve
 * Conflicts open an agent tab through the `session.start` path with the
 * button's prompt, and Multi Review launches through the unscoped Multi Review
 * button command under an ID reserved from the operation.
 */

afterEach(cleanupSessionHarnesses);

describe("pr.create and pr.resolve", () => {
  test("pr.create starts the PR agent with the button's prompt as a run", async () => {
    const { harness, stub } = await setup();
    const started = await harness.call<{ sessionId: string; tabId: string; runId: string }>(
      "pr.create",
      { environmentId: "env-1", targetBranch: "develop" },
      { requestId: "pr-1" },
    );
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    expect(started.receipt).toMatchObject({ action: "pr.create", state: "running" });
    expect(started.result.runId).toBe(started.receipt!.operationId);
    const sent = stub.sends.at(-1)!;
    expect(sent.prompt).toContain("complete PR creation workflow");
    expect(sent.prompt).toContain("git fetch origin develop");
    // The receipt carries IDs only, never the prompt.
    expect(JSON.stringify(started.receipt)).not.toContain("PR creation workflow");

    const replay = await harness.call(
      "pr.create",
      { environmentId: "env-1", targetBranch: "develop" },
      { requestId: "pr-1" },
    );
    expect(replay.receipt?.operationId).toBe(started.receipt!.operationId);
    expect(replay.receipt?.replayed).toBe(true);
    expect(stub.sends).toHaveLength(1);

    const run = await harness.call("run.get", { operationId: started.receipt!.operationId });
    expect(run.ok).toBe(true);
  });

  test("pr.create is refused when the environment already has a pull request", async () => {
    const { harness, stub } = await setup();
    const environment = (await harness.storage.getEnvironment("env-1"))!;
    await harness.storage.updateEnvironment("env-1", {
      ...environment,
      prUrl: "https://github.com/acme/site/pull/7",
    });
    const refused = await harness.call(
      "pr.create",
      { environmentId: "env-1" },
      { requestId: "pr-2" },
    );
    expect(!refused.ok && refused.error.code).toBe("conflict");
    expect(stub.sends).toHaveLength(0);
  });

  test("pr.resolve merges the environment's base branch by default", async () => {
    const { harness, stub } = await setup();
    const environment = (await harness.storage.getEnvironment("env-1"))!;
    await harness.storage.updateEnvironment("env-1", { ...environment, prBaseBranch: "release" });
    const started = await harness.call(
      "pr.resolve",
      { environmentId: "env-1" },
      { requestId: "r-1" },
    );
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    expect(stub.sends.at(-1)!.prompt).toContain(
      "Resolve any merge conflicts with the target remote branch (release)",
    );
  });

  test("model and reasoning need an agent", async () => {
    const { harness } = await setup();
    const refused = await harness.call(
      "pr.create",
      { environmentId: "env-1", model: "opus" },
      { requestId: "pr-3" },
    );
    expect(!refused.ok && refused.error.code).toBe("invalid-input");
  });
});

describe("review.*", () => {
  function fakeReviews(harness: Awaited<ReturnType<typeof setup>>["harness"]) {
    const launches: Array<Record<string, unknown>> = [];
    const result = (outcome: "opened" | "partial"): MultiReviewActionResult =>
      ({
        workflow: {
          id: "review-1",
          environmentId: "env-1",
          projectId: "p",
          phase: "reviewing",
        },
        reused: false,
        outcome,
        ui: { status: outcome === "opened" ? "opened" : "unavailable" },
        ...(outcome === "partial" ? { recovery: "Close a tab and open it again." } : {}),
      }) as unknown as MultiReviewActionResult;
    let next: "opened" | "partial" = "opened";
    harness.commands.set("launch_controller_multi_review", async (args) => {
      launches.push(args);
      return result(next);
    });
    Object.assign(harness.context, { multiReviews: { cancel: async () => ({}) } });
    return {
      launches,
      fail() {
        next = "partial";
      },
    };
  }

  test("review.launch runs the Multi Review button once per request key", async () => {
    const { harness } = await setup();
    const reviews = fakeReviews(harness);
    const input = { environmentId: "env-1", autoFix: true, autoPr: true };
    const launched = await harness.call("review.launch", input, { requestId: "review-key" });
    if (!launched.ok) throw new Error(`${launched.error.code}: ${launched.error.message}`);
    expect(launched.result).toMatchObject({ workflowId: "review-1", outcome: "opened" });
    expect(reviews.launches).toHaveLength(1);
    const sent = reviews.launches[0]!;
    expect(sent.input).toMatchObject({ ...input, requestId: launched.receipt!.operationId });
    expect(String(sent.reservedId)).toMatch(/^public-[0-9a-f]{32}$/);

    const replay = await harness.call("review.launch", input, { requestId: "review-key" });
    expect(replay.receipt?.replayed).toBe(true);
    expect(reviews.launches).toHaveLength(1);
  });

  test("review.launch carries each reviewer's lens, and its receipt carries no lens text", async () => {
    const { harness } = await setup();
    const reviews = fakeReviews(harness);
    const lens = { label: "Security", instruction: "Trace untrusted input to its sinks." };
    const input = {
      environmentId: "env-1",
      reviewers: [
        { agent: "claude", model: "opus", lens },
        { agent: "codex", model: "gpt-5.5" },
      ],
    };
    const launched = await harness.call("review.launch", input, { requestId: "review-lens" });
    if (!launched.ok) throw new Error(`${launched.error.code}: ${launched.error.message}`);
    expect((reviews.launches[0]!.input as { reviewers: unknown }).reviewers).toEqual(
      input.reviewers,
    );
    expect(JSON.stringify(launched.receipt)).not.toContain("untrusted");
    expect(JSON.stringify(launched.result)).not.toContain("untrusted");
    // A different lens under the same key is a different intent.
    const conflict = await harness.call(
      "review.launch",
      { ...input, reviewers: [{ ...input.reviewers[0], lens: { ...lens, label: "Perf" } }] },
      { requestId: "review-lens" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
    expect(reviews.launches).toHaveLength(1);

    for (const reviewers of [
      [{ agent: "claude", model: "opus", lens: { label: "x".repeat(65), instruction: "x" } }],
      [{ agent: "claude", model: "opus", lens: { label: "L", instruction: "é".repeat(2049) } }],
      [{ agent: "claude", model: "opus", lens: { label: "L" } }],
    ]) {
      const refused = await harness.call(
        "review.launch",
        { environmentId: "env-1", reviewers },
        { requestId: `review-bad-lens-${reviewers[0]!.lens.label.length}` },
      );
      expect(!refused.ok && refused.error.code).toBe("invalid-input");
    }
    const lensOnFix = await harness.call(
      "review.launch",
      { environmentId: "env-1", fixModel: { agent: "claude", model: "opus", lens } },
      { requestId: "review-lens-fix" },
    );
    expect(!lensOnFix.ok && lensOnFix.error.code).toBe("invalid-input");
  });

  test("a review whose tab could not open is a partial outcome with its recovery", async () => {
    const { harness } = await setup();
    const reviews = fakeReviews(harness);
    reviews.fail();
    const launched = await harness.call(
      "review.launch",
      { environmentId: "env-1" },
      { requestId: "review-partial" },
    );
    expect(!launched.ok && launched.error.code).toBe("partial-failure");
    expect(launched.receipt?.state).toBe("partial");
    expect(!launched.ok && launched.error.message).toContain("Close a tab");
  });

  test("bad review rows are refused before admission", async () => {
    const { harness } = await setup();
    fakeReviews(harness);
    const refused = await harness.call(
      "review.launch",
      { environmentId: "env-1", reviewers: [{ agent: "claude" }] },
      { requestId: "review-bad" },
    );
    expect(!refused.ok && refused.error.code).toBe("invalid-input");
    expect(refused.receipt).toBeUndefined();
  });

  test("reads and surface actions of an unknown review are not-found", async () => {
    const { harness } = await setup();
    fakeReviews(harness);
    const get = await harness.call("review.get", { workflowId: "missing" });
    expect(!get.ok && get.error.code).toBe("not-found");
    const cancel = await harness.call(
      "review.cancel",
      { workflowId: "missing" },
      { requestId: "cancel-1" },
    );
    expect(!cancel.ok && cancel.error.code).toBe("not-found");
    const list = await harness.call<{ items: unknown[] }>("review.list", {
      environmentId: "env-1",
    });
    expect(list.ok && list.result.items).toEqual([]);
  });
});

describe("PR button defaults and lifecycle", () => {
  for (const button of ["pr.create", "pr.resolve"] as const) {
    test(`${button} action defaults supply agent/model/reasoning and an explicit model drops inherited Fast`, async () => {
      const { harness } = await setup();
      const config = await harness.storage.loadConfig();
      await harness.storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          agentSettings: {
            actionDefaults: {
              pr: { platform: "claude", model: "opus", reasoningEffort: "high", fastMode: true },
              resolve: {
                platform: "claude",
                model: "opus",
                reasoningEffort: "high",
                fastMode: true,
              },
            },
          },
        },
      });
      harness.commands.set("get_native_agent_model_catalog", async () => [
        {
          platform: "claude",
          id: "opus",
          label: "Opus",
          supportsSpeed: true,
          reasoning: [{ id: "high", label: "High" }],
        },
        { platform: "claude", id: "haiku", label: "Haiku", supportsSpeed: false, reasoning: [] },
      ]);
      const job = harness.commands.get("launch_native_agent_job")!;
      const sent: Record<string, unknown>[] = [];
      harness.commands.set("launch_native_agent_job", async (args, context) => {
        sent.push(args);
        return job(args, context);
      });
      const inherited = await harness.call(
        button,
        { environmentId: "env-1" },
        { requestId: "default-pr" },
      );
      expect(inherited.ok).toBe(true);
      expect(sent[0]).toMatchObject({
        agent: "claude",
        modelId: "opus",
        reasoningId: "high",
        fastMode: true,
      });
      const overridden = await harness.call(
        button,
        { environmentId: "env-1", agent: "claude", model: "haiku" },
        { requestId: "explicit-pr" },
      );
      expect(overridden.ok).toBe(true);
      expect(sent[1]).toMatchObject({ agent: "claude", modelId: "haiku" });
      expect(sent[1]?.fastMode).toBeUndefined();
      expect(sent[1]?.reasoningId).toBeUndefined();
    });
  }

  for (const monitorFails of [false, true]) {
    test(`PR monitor starts after acceptance and ${monitorFails ? "failure preserves the accepted run" : "replay never starts it twice"}`, async () => {
      const { harness, stub } = await setup();
      const watches: unknown[] = [];
      harness.commands.set("pr_monitor_watch", async (args) => {
        watches.push(args);
        if (monitorFails) throw new Error("monitor unavailable");
      });
      const input = { environmentId: "env-1" };
      const first = await harness.call("pr.create", input, { requestId: "watch-pr" });
      expect(first.receipt?.dispatch?.state).toBe("accepted");
      expect(first.receipt?.state).toBe("running");
      await harness.call("pr.create", input, { requestId: "watch-pr" });
      expect(watches).toEqual([{ environmentId: "env-1", mode: "create-pending" }]);
      expect(stub.sends).toHaveLength(1);
    });
  }

  for (const action of ["pr.create", "pr.resolve"] as const) {
    test(`${action} defaults to the configured agent and settles on its provider evidence`, async () => {
      const { harness, service, stub } = await setup();
      const config = await harness.storage.loadConfig();
      await harness.storage.saveConfig({
        ...config,
        global: { ...config.global, agentSettings: { defaultAgent: "claude" } },
      });
      if (action === "pr.resolve")
        await harness.storage.updateEnvironment("env-1", {
          prUrl: "https://github.com/acme/site/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });
      const refreshes: unknown[] = [];
      harness.commands.set("pr_monitor_agent_turn_completed", async (args) => {
        refreshes.push(args);
      });
      const started = await harness.call<{ sessionId: string; tabId: string }>(
        action,
        { environmentId: "env-1" },
        { requestId: "complete" },
      );
      expect(started.ok).toBe(true);
      if (action === "pr.resolve")
        expect(
          (await harness.storage.getEnvironment("env-1"))?.prRecheckAfterAgentCompletionArmedAt,
        ).toBeDefined();
      await service.reconcileAgentActivity();
      stub.setStatus(async () => "idle");
      await service.reconcileAgentActivity();
      const observed = await harness.call("run.get", { operationId: started.receipt!.operationId });
      expect(observed.receipt?.state).toBe("succeeded");
      if (action === "pr.resolve") expect(refreshes).toEqual([{ environmentId: "env-1" }]);
    });

    test(`${action} can be steered and stopped using the original run ID`, async () => {
      const { setActivity } = await import("./test-provider.js");
      const { harness, service, stub } = await setup();
      Object.assign(stub.provider, {
        activeSteerRun: async () => ({ state: "running", runId: "provider-turn" }),
        steerSupported: async () => true,
        steerStatus: async () => "dispatched",
        performSessionAction: async () => ({ outcome: "applied" }),
      });
      const started = await harness.call<{ sessionId: string; tabId: string }>(
        action,
        { environmentId: "env-1" },
        { requestId: "controlled" },
      );
      if (!started.ok) throw new Error(started.error.message);
      const steer = await harness.call(
        "session.steer",
        {
          sessionId: started.result.sessionId,
          text: "focus",
          expectedOperationId: started.receipt!.operationId,
        },
        { requestId: "steer" },
      );
      expect(steer.ok).toBe(true);
      const stop = await harness.call(
        "session.stop",
        { sessionId: started.result.sessionId, expectedOperationId: started.receipt!.operationId },
        { requestId: "stop" },
      );
      expect(stop.ok).toBe(true);
      setActivity(service, "claude", started.result.tabId, stub.sends[0]!.sessionId, "idle");
      const observed = await harness.call("run.get", { operationId: started.receipt!.operationId });
      expect(observed.receipt?.state).toBe("cancelled");
    });

    test(`${action} dispatch rejection remains failed and never starts the monitor`, async () => {
      const { harness, stub } = await setup();
      const watches: unknown[] = [];
      harness.commands.set("pr_monitor_watch", async (args) => {
        watches.push(args);
      });
      stub.setSend(async () => {
        throw new PromptRejectedError("provider refused");
      });
      const refused = await harness.call(
        action,
        { environmentId: "env-1" },
        { requestId: "rejected" },
      );
      expect(!refused.ok && refused.error.code).toBe("operation-failed");
      expect(refused.receipt?.dispatch?.state).toBe("rejected");
      expect(watches).toHaveLength(0);
    });
  }
});
