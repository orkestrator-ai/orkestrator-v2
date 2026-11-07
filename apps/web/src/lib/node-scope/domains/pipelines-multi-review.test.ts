/**
 * The `pipelines` and `multi-review` domain clients over a `lib/backend`
 * factory client (plan item 7007), against fake nodes: version 0 for a client
 * without negotiation or a pre-contract node (today's exact calls, answered as
 * sent), version 1 for a node that advertises the domain (envelope with its
 * critical keys, decoded results), and the `lib/backend` factories on top.
 */
import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { createBuildPipelinesApi } from "@/lib/backend/build-pipelines";
import { createMultiReviewsApi } from "@/lib/backend/multi-reviews";
import { createSignal } from "@/lib/node-scope/signal";
import { multiReview } from "./multi-review";
import { pipelines } from "./pipelines";

const CURRENT: NegotiatedDomains = {
  pipelines: { min: 1, max: 1 },
  "multi-review": { min: 1, max: 1 },
};

function fakeClient(answer: (command: string) => unknown, domains?: NegotiatedDomains | null) {
  const invokeRaw = mock(async (command: string, ..._rest: unknown[]) => answer(command));
  const client: BackendClient = {
    invokeRaw: invokeRaw as unknown as BackendClient["invokeRaw"],
    ...(domains === undefined
      ? {}
      : {
          domains: createSignal<NegotiatedDomains | null>(domains),
          capabilities: createSignal<ReadonlySet<string> | null>(null),
        }),
  };
  return { client, invokeRaw };
}

const pipeline = { id: "p1", phase: "building", sessions: [], later: true };
const record = {
  version: 1,
  id: "w1",
  environmentId: "env",
  snapshot: { id: "w1" },
  updatedAt: "2026-11-07T00:00:00.000Z",
  revision: 2,
};

describe("pipelines and multi-review domain clients over a lib/backend client", () => {
  test("a client without negotiation sends today's calls and gets the answers as sent", async () => {
    const legacy = { id: 7, older: true };
    const { client, invokeRaw } = fakeClient(() => legacy);
    await expect(pipelines(client).pause_build_pipeline({ pipelineId: "p1" })).resolves.toBe(
      legacy as never,
    );
    await expect(createMultiReviewsApi(client).cancelMultiReview("w1")).resolves.toBe(
      legacy as never,
    );
    expect(invokeRaw.mock.calls).toEqual([
      ["pause_build_pipeline", { pipelineId: "p1" }],
      ["cancel_multi_review", { workflowId: "w1" }],
    ] as never);
  });

  test("a pre-contract node (no domains) takes version 0 too", async () => {
    const { client, invokeRaw } = fakeClient(() => null, null);
    await expect(createBuildPipelinesApi(client).getBuildPipeline("p1")).resolves.toBeNull();
    expect(invokeRaw.mock.calls).toEqual([["get_build_pipeline", { pipelineId: "p1" }]] as never);
  });

  test("a node with the domains gets the envelope, critical keys and decoded results", async () => {
    const { client, invokeRaw } = fakeClient(
      (command) => (command === "get_multi_review_workflow" ? record : pipeline),
      CURRENT,
    );
    await expect(
      createBuildPipelinesApi(client).restartBuildPipelineStep("p1", "s1", {
        agent: "codex",
        model: "m",
      } as never),
    ).resolves.toEqual(pipeline as never);
    expect(invokeRaw.mock.calls[0]).toEqual([
      "restart_build_pipeline_step",
      { pipelineId: "p1", stageId: "s1", selection: { agent: "codex", model: "m" } },
      { envelope: { domain: "pipelines", version: 1, critical: ["selection"] } },
    ] as never);
    await expect(
      createMultiReviewsApi(client).getMultiReviewWorkflowConditional("w1", 1),
    ).resolves.toEqual(record as never);
    expect(invokeRaw.mock.calls[1]?.[2]).toEqual({
      envelope: { domain: "multi-review", version: 1 },
    });
  });

  test("a version-1 answer that does not match its schema is refused", async () => {
    const { client } = fakeClient(() => ({ id: 3 }), CURRENT);
    await expect(multiReview(client).retry_multi_review({ workflowId: "w1" })).rejects.toThrow(
      "Invalid result from retry_multi_review",
    );
  });
});
