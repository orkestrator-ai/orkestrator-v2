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
