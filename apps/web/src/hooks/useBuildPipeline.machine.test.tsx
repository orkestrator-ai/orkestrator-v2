import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import * as realBackend from "@/lib/backend";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { uiStore } from "@/stores/uiStore";
import type { KanbanTask } from "@/lib/backend";
import { portalStore } from "@/lib/portal/portal-store";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../../../tests/mocks/sonner";
import { appCommandStore } from "@/test/app-command-store";

const realBackendSnapshot = { ...realBackend };
const ownLaunchMock = mock(async (_input: unknown) =>
  buildPipelineFixture({ id: "pipeline-own", environmentId: "env-own" }),
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  launchBuildPipeline: ownLaunchMock,
  getKanbanImageData: mock(async () => "data:image"),
}));

const { useBuildPipeline } = await import("./useBuildPipeline");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const task: KanbanTask = {
  id: "task-1",
  projectId: "project-own",
  title: "Ship feature",
  description: "Implement the feature",
  acceptanceCriteria: "It works",
  status: "backlog",
  comments: [],
  images: [],
  createdAt: "",
  order: 0,
};

const builder = {
  machine: "builder",
  nodeId: "builder",
  projectId: "project-builder",
  name: "Builder",
};

const routed = spyOn(portalStore, "invokeOnNode");

beforeEach(() => {
  cleanup();
  ownLaunchMock.mockClear();
  routed.mockReset();
  routed.mockImplementation((async () =>
    buildPipelineFixture({
      id: "pipeline-remote",
      environmentId: "env-remote",
    })) as unknown as typeof portalStore.invokeOnNode);
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
  appCommandStore(buildPipelineStore).setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
  });
  appCommandStore(uiStore).setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("useBuildPipeline on another machine", () => {
  test("launches on the chosen machine with its own project and the ticket's link", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    let pipelineId: string | undefined;
    await act(async () => {
      pipelineId = await result.current.startBuild(task, "containerized", "claude", {
        machine: builder,
        networkAccessMode: "full",
        existingEnvironmentId: "env-on-this-machine",
        featurePlanId: "plan-here",
      });
    });

    expect(pipelineId).toBe("pipeline-remote");
    expect(ownLaunchMock).not.toHaveBeenCalled();
    expect(routed).toHaveBeenCalledTimes(1);
    const [nodeId, command, args] = routed.mock.calls[0]!;
    expect(String(nodeId)).toBe("builder");
    expect(command).toBe("launch_build_pipeline");
    expect(args).toMatchObject({
      taskId: "task-1",
      projectId: "project-builder",
      environmentType: "containerized",
      agentType: "claude",
      environmentOptions: { networkAccessMode: "full" },
      // Tickets sync under one id, so the other machine links its own copy.
      source: { type: "kanban", taskId: "task-1" },
    });
    // Ids that mean something only on this machine are not sent.
    expect(args!.existingEnvironmentId).toBeUndefined();
    expect(args!.featurePlanId).toBeUndefined();
  });

  test("keeps the other machine's pipeline out of this tab's store and selection", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local", undefined, { machine: builder });
    });

    expect(appCommandStore(buildPipelineStore).getState().pipelines.size).toBe(0);
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBeNull();
  });

  test("names the machine in the confirmation and offers to open it there", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local", undefined, { machine: builder });
    });

    const [message, options] = toastSuccessMock.mock.calls[0]!;
    expect(message).toBe("Build pipeline started on Builder");
    expect((options as { action: { label: string } }).action.label).toBe("Open on Builder");
  });

  test("a launch with no machine choice stays on this tab's own machine", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local");
    });

    expect(routed).not.toHaveBeenCalled();
    expect(ownLaunchMock).toHaveBeenCalledTimes(1);
    expect((ownLaunchMock.mock.calls[0]![0] as { projectId: string }).projectId).toBe(
      "project-own",
    );
  });

  test("reports a failed remote launch and starts nothing here", async () => {
    routed.mockImplementation(async () => {
      throw new Error("That node is not connected");
    });
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    let pipelineId: string | undefined = "unset";
    await act(async () => {
      pipelineId = await result.current.startBuild(task, "local", undefined, {
        machine: builder,
      });
    });

    expect(pipelineId).toBeUndefined();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(ownLaunchMock).not.toHaveBeenCalled();
  });
});
