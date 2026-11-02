/**
 * The shared agent branch runner logs under its host's prefix: review
 * fan-outs keep `[review-fanout]`, graph activations use `[graph-agent]`.
 * Log lines carry error text the runner bounds, never payloads.
 */
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AgentBranchCommitQueue } from "./agent-branch-commits.js";
import { attachAgentBeforeDispatch } from "./agent-branch-runner.js";
import { AGENT_BRANCH_LOG_OWNER } from "./agent-branch-types.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";

const warn = spyOn(console, "warn").mockImplementation(() => undefined);

afterEach(() => {
  warn.mockClear();
});

afterAll(() => {
  warn.mockRestore();
});

const failingProvider = {
  prepareDispatch: mock(async () => {
    throw new Error("attach failed");
  }),
} as unknown as BuildPipelineProvider;

describe("agent branch log prefix", () => {
  test("review fan-outs keep the review prefix", async () => {
    expect(AGENT_BRANCH_LOG_OWNER).toBe("review-fanout");
    await attachAgentBeforeDispatch(failingProvider, "session-1");
    expect(String(warn.mock.calls[0]?.[0])).toContain("owner=review-fanout ");
  });

  test("a host's prefix replaces it", async () => {
    await attachAgentBeforeDispatch(failingProvider, "session-1", undefined, "graph-agent");
    expect(String(warn.mock.calls[0]?.[0])).toContain("owner=graph-agent ");
    const queue = new AgentBranchCommitQueue(
      async () => {
        throw new Error("save failed");
      },
      () => undefined,
      "graph-agent",
    );
    queue.stageObservation();
    await queue.flushObservations();
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes("observation.checkpoint-failed owner=graph-agent "),
      ),
    ).toBe(true);
  });
});
