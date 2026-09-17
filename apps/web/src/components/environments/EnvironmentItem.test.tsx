import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentActivityState, Environment, EnvironmentType } from "@/types";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { EnvironmentItem } from "./EnvironmentItem";

function environmentFixture(overrides: Partial<Environment> & { name?: string } = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "Build: Pulsing icon",
    branch: "feature/pulsing-icon",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-09-17T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    agentActivityState: "idle",
    agentActivityUpdatedAt: "2026-09-17T09:00:00.000Z",
    ...overrides,
  };
}

const callbacks = {
  onSelect: mock(() => undefined),
  onDelete: mock(() => undefined),
  onStart: mock(() => undefined),
  onStop: mock(() => undefined),
  onRestart: mock(() => undefined),
};

function environmentIcon(name = /Pulsing icon/): SVGElement {
  const row = screen.getByRole("button", { name });
  const icon = row.querySelector("svg");
  if (!icon) throw new Error("Environment icon was not rendered");
  return icon;
}

function seedPipeline(
  overrides: Parameters<typeof buildPipelineFixture>[0] = {},
): ReturnType<typeof buildPipelineFixture> {
  const pipeline = buildPipelineFixture({
    environmentId: "env-1",
    phase: "addressing",
    ...overrides,
  });
  useBuildPipelineStore.getState().replacePipeline(pipeline);
  return pipeline;
}

function renderItem(environment: Environment = environmentFixture()) {
  return render(<EnvironmentItem environment={environment} isSelected={false} {...callbacks} />);
}

function expectWorking(icon: SVGElement) {
  expect(icon.classList).toContain("text-blue-500");
  expect(icon.classList).toContain("animate-pulse");
  expect(icon.classList).not.toContain("text-success");
  expect(icon.classList).not.toContain("text-amber-500");
}

function expectIdle(icon: SVGElement) {
  expect(icon.classList).toContain("text-success");
  expect(icon.classList).not.toContain("text-blue-500");
  expect(icon.classList).not.toContain("animate-pulse");
}

function expectWaiting(icon: SVGElement) {
  expect(icon.classList).toContain("text-amber-500");
  expect(icon.classList).toContain("animate-pulse");
  expect(icon.classList).not.toContain("text-blue-500");
}

beforeEach(() => {
  useAgentActivityStore.setState({
    containerStates: {},
    containerStateUpdatedAt: {},
  });
  useBuildPipelineStore.setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
    activeBuildEnvironmentIds: new Set(),
    viewedSessionIds: new Map(),
  });
});

afterEach(cleanup);

describe("EnvironmentItem build pipeline activity", () => {
  test("shows a pulsing blue computer while a pipeline step is in progress", () => {
    seedPipeline();
    renderItem();

    expectWorking(environmentIcon());
  });

  test("returns the computer to idle green after the pipeline finishes", () => {
    const pipeline = seedPipeline();
    renderItem();

    act(() => {
      useBuildPipelineStore.getState().replacePipeline({
        ...pipeline,
        phase: "complete",
        backendRevision: pipeline.backendRevision + 1,
      });
    });

    expectIdle(environmentIcon());
  });

  test("ignores a pipeline that belongs to a different environment", () => {
    seedPipeline({ environmentId: "env-other", taskId: "task-other", id: "pipeline-other" });
    renderItem();

    expectIdle(environmentIcon());
  });

  test.each(["paused", "failed"] as const)(
    "leaves idle green when this environment's pipeline is %s",
    (phase) => {
      seedPipeline({ phase });
      renderItem();

      expectIdle(environmentIcon());
    },
  );

  test.each(["waiting-for-setup", "creating-environment", "starting-environment"] as const)(
    "does not force working during setup phase %s",
    (phase) => {
      seedPipeline({ phase });
      renderItem();

      expectIdle(environmentIcon());
    },
  );

  test("falls back to waiting amber while setup is still pending", () => {
    seedPipeline({ phase: "waiting-for-setup" });
    renderItem(environmentFixture({ agentActivityState: "waiting" }));

    expectWaiting(environmentIcon());
  });

  test("does not force working when the pipeline carries a stallWarning", () => {
    seedPipeline({
      stallWarning: {
        sessionId: "session-1",
        detectedAt: "2026-09-17T09:00:00.000Z",
      },
    });
    renderItem();

    expectIdle(environmentIcon());
  });

  test("an active pipeline overrides a waiting agent with working blue", () => {
    seedPipeline();
    renderItem(environmentFixture({ agentActivityState: "waiting" }));

    expectWorking(environmentIcon());
  });

  test("pulses the container icon for a containerized environment", () => {
    seedPipeline({ environmentType: "containerized" });
    renderItem(
      environmentFixture({
        environmentType: "containerized" satisfies EnvironmentType,
        containerId: "container-1",
      }),
    );

    expectWorking(environmentIcon());
  });

  test("falls back to the environment's own working state after the pipeline finishes", () => {
    const pipeline = seedPipeline();
    renderItem(environmentFixture({ agentActivityState: "working" satisfies AgentActivityState }));

    act(() => {
      useBuildPipelineStore.getState().replacePipeline({
        ...pipeline,
        phase: "complete",
        backendRevision: pipeline.backendRevision + 1,
      });
    });

    expectWorking(environmentIcon());
  });
});
