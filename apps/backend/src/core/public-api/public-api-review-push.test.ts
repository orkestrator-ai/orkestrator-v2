import { afterEach, describe, expect, test } from "bun:test";
import {
  createPushChangesPrompt,
  createReviewPrompt,
} from "@orkestrator/protocol/git-workflow-prompts";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";

/**
 * The single-agent Review and Push Changes buttons as public actions: the
 * backend builds their prompts (resolving the target branch and the saved
 * review instruction itself) and opens the tab through `session.start`'s path.
 */

afterEach(cleanupSessionHarnesses);

type Harness = Awaited<ReturnType<typeof setup>>["harness"];

/** Record every `launch_native_agent_job` call while still running it. */
function captureLaunches(harness: Harness): Record<string, unknown>[] {
  const job = harness.commands.get("launch_native_agent_job")!;
  const sent: Record<string, unknown>[] = [];
  harness.commands.set("launch_native_agent_job", async (args, context) => {
    sent.push(args);
    return job(args, context);
  });
  return sent;
}

async function configure(
  harness: Harness,
  projectId: string,
  options: { prBaseBranch?: string; reviewInstruction?: string },
) {
  const config = await harness.storage.loadConfig();
  await harness.storage.saveConfig({
    ...config,
    global: {
      ...config.global,
      ...(options.reviewInstruction ? { reviewInstruction: options.reviewInstruction } : {}),
    },
    repositories: {
      ...config.repositories,
      ...(options.prBaseBranch !== undefined
        ? {
            [projectId]: {
              defaultBranch: "main",
              ...config.repositories?.[projectId],
              prBaseBranch: options.prBaseBranch,
            },
          }
        : {}),
    },
  });
}

async function setPullRequest(harness: Harness, prState: "open" | "merged" | "closed" | null) {
  const environment = (await harness.storage.getEnvironment("env-1"))!;
  await harness.storage.updateEnvironment("env-1", {
    ...environment,
    prUrl: prState ? "https://github.com/acme/site/pull/7" : null,
    prState,
  });
}

describe("review.start", () => {
  test("builds the Review prompt server-side from the project's base branch and saved instruction", async () => {
    const { harness, stub, projectId } = await setup();
    await configure(harness, projectId, {
      prBaseBranch: "develop",
      reviewInstruction: "Review only {{targetBranch}}'s public API.",
    });
    const launches = captureLaunches(harness);
    const started = await harness.call<{ sessionId: string; tabId: string; runId: string }>(
      "review.start",
      { environmentId: "env-1" },
      { requestId: "review-1" },
    );
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    expect(started.receipt).toMatchObject({ action: "review.start", state: "running" });
    expect(stub.sends.at(-1)!.prompt).toBe(
      createReviewPrompt("develop", "Review only {{targetBranch}}'s public API."),
    );
    expect(stub.sends.at(-1)!.prompt).toContain("Review only develop's public API.");
    expect(launches[0]).toMatchObject({ title: "Review", reviewTab: true });
    // The receipt carries IDs only, never the prompt or the instruction.
    expect(JSON.stringify(started.receipt)).not.toContain("public API");

    // The tab is a review tab, as the button's is, so it offers Address all.
    const layout = await harness.storage.getPaneLayout("env-1");
    const tabs = JSON.stringify(layout?.root);
    expect(tabs).toContain(`"id":"${started.result.tabId}"`);
    expect(tabs).toContain('"isReviewTab":true');

    const replay = await harness.call(
      "review.start",
      { environmentId: "env-1" },
      { requestId: "review-1" },
    );
    expect(replay.receipt?.replayed).toBe(true);
    expect(stub.sends).toHaveLength(1);
  });

  test("an explicit target branch wins, and a cleared base falls back to main", async () => {
    const { harness, stub, projectId } = await setup();
    await configure(harness, projectId, { prBaseBranch: "" });
    const fallback = await harness.call(
      "review.start",
      { environmentId: "env-1" },
      { requestId: "review-main" },
    );
    if (!fallback.ok) throw new Error(`${fallback.error.code}: ${fallback.error.message}`);
    expect(stub.sends.at(-1)!.prompt).toBe(createReviewPrompt("main"));

    const explicit = await harness.call(
      "review.start",
      { environmentId: "env-1", targetBranch: "release/v2" },
      { requestId: "review-release" },
    );
    if (!explicit.ok) throw new Error(`${explicit.error.code}: ${explicit.error.message}`);
    expect(stub.sends.at(-1)!.prompt).toBe(createReviewPrompt("release/v2"));
  });

  test("uses the review action default", async () => {
    const { harness } = await setup();
    const config = await harness.storage.loadConfig();
    await harness.storage.saveConfig({
      ...config,
      global: {
        ...config.global,
        agentSettings: { actionDefaults: { review: { platform: "claude", model: "opus" } } },
      },
    });
    harness.commands.set("get_native_agent_model_catalog", async () => [
      { platform: "claude", id: "opus", label: "Opus", reasoning: [] },
    ]);
    const launches = captureLaunches(harness);
    const started = await harness.call(
      "review.start",
      { environmentId: "env-1" },
      { requestId: "review-default" },
    );
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    expect(launches[0]).toMatchObject({ agent: "claude", modelId: "opus" });
  });
});

describe("launch_native_agent_job reviewTab", () => {
  test("accepts only an explicit true", async () => {
    const { harness } = await setup();
    const launch = harness.commands.get("launch_native_agent_job")!;
    await expect(
      launch(
        {
          environmentId: "env-1",
          requestId: "bad-review-tab",
          agent: "claude",
          prompt: "Review",
          reviewTab: false,
        },
        harness.context,
      ),
    ).rejects.toThrow("reviewTab must be true when given");
  });
});

describe("pr.push", () => {
  test("starts the Push Changes agent on an open pull request", async () => {
    const { harness, stub } = await setup();
    await setPullRequest(harness, "open");
    const launches = captureLaunches(harness);
    const started = await harness.call(
      "pr.push",
      { environmentId: "env-1" },
      { requestId: "push-1" },
    );
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    expect(started.receipt).toMatchObject({ action: "pr.push", state: "running" });
    expect(stub.sends.at(-1)!.prompt).toBe(createPushChangesPrompt());
    expect(launches[0]).toMatchObject({ title: "Git Push" });
    expect(launches[0]?.reviewTab).toBeUndefined();
    expect(launches[0]?.completionAction).toBeUndefined();
  });

  for (const prState of [null, "merged", "closed"] as const) {
    test(`is refused when the environment's pull request is ${prState ?? "missing"}`, async () => {
      const { harness, stub } = await setup();
      await setPullRequest(harness, prState);
      const refused = await harness.call(
        "pr.push",
        { environmentId: "env-1" },
        { requestId: `push-${prState}` },
      );
      expect(!refused.ok && refused.error.code).toBe("conflict");
      expect(stub.sends).toHaveLength(0);
    });
  }

  test("takes no target branch", async () => {
    const { harness } = await setup();
    await setPullRequest(harness, "open");
    const refused = await harness.call(
      "pr.push",
      { environmentId: "env-1", targetBranch: "main" },
      { requestId: "push-branch" },
    );
    expect(!refused.ok && refused.error.code).toBe("invalid-input");
  });
});
