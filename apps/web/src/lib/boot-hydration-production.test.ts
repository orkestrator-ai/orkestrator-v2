import { afterEach, expect, spyOn, test } from "bun:test";
import * as native from "@/lib/native/backend";
import * as backend from "@/lib/backend";
import { hydrateBootPromptQueues, hydrateBootMultiReviewWorkflows } from "./boot-hydration";
import { createPromptQueueSources } from "./prompt-queue-sources";
import { promptQueueKey, resetPromptQueueRevisions } from "./prompt-queue-persistence";
import { hydrateBuildPipelinesForProject } from "./build-pipeline-persistence";
import { useClaudeTmuxStore } from "@/stores/claudeTmuxStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { BUILD_PIPELINE_VERSION, useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { workflowVocabularyFixtures } from "./workflow-vocabulary.test-support";
import { environmentRequests, hydrationRequests } from "./hydration-request-limiter";

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  resetPromptQueueRevisions();
  useClaudeTmuxStore.setState({ messageQueue: new Map() });
  useMultiReviewStore.setState({ workflows: new Map() });
  useBuildPipelineStore.setState({ pipelines: new Map() });
});

test("six pending environment loads leave shared slots for snapshots and pipelines", async () => {
  const finish: Array<() => void> = [];
  const invoke = spyOn(native, "invoke").mockImplementation(
    <T>(command: string) =>
      (command === "get_environments"
        ? new Promise<unknown>((resolve) => finish.push(() => resolve([])))
        : Promise.resolve([])) as Promise<T>,
  );
  try {
    const loads = Array.from({ length: 6 }, (_, i) => backend.getEnvironments(`p${i}`));
    expect(environmentRequests.inFlight).toBe(2);
    expect(hydrationRequests.inFlight).toBe(2);
    expect(await backend.getEnvironmentSnapshots("p0")).toEqual([]);
    expect(await backend.listBuildPipelines("p0")).toEqual([]);
    expect(finish).toHaveLength(2);
    for (let i = 0; i < 3; i++) {
      for (const resolve of finish.splice(0)) resolve();
      await nextTask();
    }
    await Promise.all(loads);
    await hydrationRequests.whenIdle();
  } finally {
    invoke.mockRestore();
  }
});

test("cold hydration uses production wrappers and batch adapters, bounds mixed reads and preserves real projections", async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `e${i}`);
  const { review, pipeline } = workflowVocabularyFixtures();
  const timestamp = "2026-11-06T00:00:00.000Z";
  let active = 0;
  let peak = 0;
  const calls: string[] = [];
  const sources = createPromptQueueSources();
  const handle = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    const input = args as { environmentIds: string[]; projectId: string };
    active++;
    peak = Math.max(peak, active);
    calls.push(command);
    try {
      await nextTask();
      if (command === "get_environments" || command === "get_environment_snapshots") return [];
      if (command === "list_build_pipelines")
        return [
          {
            id: `pipeline-${input.projectId}`,
            projectId: input.projectId,
            environmentId: "e0",
            version: BUILD_PIPELINE_VERSION,
            revision: 4,
            updatedAt: timestamp,
            snapshot: {
              ...pipeline,
              id: `pipeline-${input.projectId}`,
              projectId: input.projectId,
              environmentId: "e0",
            },
          },
        ];
      if (command === "list_environment_hydration")
        return {
          environments: input.environmentIds.map((id) => ({
            environmentId: id,
            promptQueues:
              id === "e0"
                ? { status: "failed" }
                : {
                    status: "ok",
                    records: [
                      {
                        queueKey: promptQueueKey("claude-tmux", `env:${id}:tab:t`),
                        environmentId: id,
                        revision: 3,
                        updatedAt: timestamp,
                        messages: [{ id: `message-${id}`, text: "fixture", attachments: [] }],
                      },
                    ],
                  },
            multiReviewWorkflows: {
              status: "ok",
              records: [
                {
                  id: `review-${id}`,
                  environmentId: id,
                  version: 1,
                  revision: 5,
                  updatedAt: timestamp,
                  snapshot: { ...review, id: `review-${id}`, environmentId: id },
                },
              ],
            },
          })),
        };
      throw new Error(`Unexpected command ${command}`);
    } finally {
      active--;
    }
  };
  const invoke = spyOn(native, "invoke").mockImplementation(
    <T>(command: string, args?: Record<string, unknown>) => handle(command, args) as Promise<T>,
  );
  try {
    // Keep an existing queue when its authoritative list is unavailable.
    useClaudeTmuxStore.setState({
      messageQueue: new Map([
        ["env:e0:tab:t", [{ id: "retained", text: "fixture", attachments: [] }]],
      ]),
    });
    const results = await Promise.allSettled([
      ...Array.from({ length: 10 }, (_, i) => backend.getEnvironments(`p${i}`)),
      ...Array.from({ length: 10 }, (_, i) => backend.getEnvironmentSnapshots(`p${i}`)),
      ...Array.from({ length: 10 }, (_, i) => hydrateBuildPipelinesForProject(`p${i}`)),
      ...ids.flatMap((id) => [
        hydrateBootPromptQueues(id, sources),
        hydrateBootMultiReviewWorkflows(id),
      ]),
    ]);
    await hydrationRequests.whenIdle();
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(peak).toBe(6);
    expect(calls.filter((c) => c === "list_environment_hydration")).toHaveLength(2);
    expect(calls).not.toContain("list_prompt_queues");
    expect(calls).not.toContain("list_multi_review_workflows");
    expect(useClaudeTmuxStore.getState().messageQueue.get("env:e0:tab:t")).toEqual([
      { id: "retained", text: "fixture", attachments: [] },
    ]);
    for (const id of ids.slice(1)) {
      expect(useClaudeTmuxStore.getState().messageQueue.get(`env:${id}:tab:t`)).toEqual([
        { id: `message-${id}`, text: "fixture", attachments: [] },
      ]);
    }
    for (const id of ids) {
      expect(useMultiReviewStore.getState().workflows.get(`review-${id}`)).toEqual({
        ...review,
        id: `review-${id}`,
        environmentId: id,
        backendRevision: 5,
      });
    }
    expect(useBuildPipelineStore.getState().pipelines.size).toBe(10);
    expect(useBuildPipelineStore.getState().pipelines.get("pipeline-p0")).toEqual({
      ...pipeline,
      id: "pipeline-p0",
      projectId: "p0",
      environmentId: "e0",
      backendRevision: 4,
    });
  } finally {
    invoke.mockRestore();
  }
});
