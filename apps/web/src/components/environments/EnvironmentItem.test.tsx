import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Environment } from "@/types";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { EnvironmentItem } from "./EnvironmentItem";

const environment: Environment = {
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
};

const callbacks = {
  onSelect: mock(() => undefined),
  onDelete: mock(() => undefined),
  onStart: mock(() => undefined),
  onStop: mock(() => undefined),
  onRestart: mock(() => undefined),
};

function environmentIcon(): SVGElement {
  const row = screen.getByRole("button", { name: /Pulsing icon/ });
  const icon = row.querySelector("svg");
  if (!icon) throw new Error("Environment icon was not rendered");
  return icon;
}

beforeEach(() => {
  useAgentActivityStore.setState({
    containerStates: {},
    containerStateUpdatedAt: {},
  });
  useBuildPipelineStore.setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
    viewedSessionIds: new Map(),
  });
});

afterEach(cleanup);

describe("EnvironmentItem build pipeline activity", () => {
  test("shows a pulsing blue computer while a pipeline step is in progress", () => {
    const pipeline = buildPipelineFixture({
      environmentId: environment.id,
      phase: "addressing",
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([environment.id]),
    });

    render(<EnvironmentItem environment={environment} isSelected={false} {...callbacks} />);

    expect(environmentIcon().classList).toContain("text-blue-500");
    expect(environmentIcon().classList).toContain("animate-pulse");
    expect(environmentIcon().classList).not.toContain("text-success");
  });

  test("returns the computer to idle green after the pipeline finishes", () => {
    const pipeline = buildPipelineFixture({
      environmentId: environment.id,
      phase: "addressing",
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([environment.id]),
    });
    render(<EnvironmentItem environment={environment} isSelected={false} {...callbacks} />);

    act(() => {
      useBuildPipelineStore.getState().replacePipeline({
        ...pipeline,
        phase: "complete",
        backendRevision: pipeline.backendRevision + 1,
      });
    });

    expect(environmentIcon().classList).toContain("text-success");
    expect(environmentIcon().classList).not.toContain("text-blue-500");
    expect(environmentIcon().classList).not.toContain("animate-pulse");
  });
});
