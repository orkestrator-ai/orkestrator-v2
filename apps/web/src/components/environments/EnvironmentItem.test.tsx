import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentActivityState, Environment, EnvironmentType } from "@/types";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { useEnvironmentDiffStore } from "@/stores/environmentDiffStore";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";
import {
  environmentProjectionFixture,
  exactCount,
  resetChangeProjectionStore,
  unknownCount,
} from "@/components/files-panel/change-projection-test-fixture";
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

function environmentIcon(name = /Pulsing icon/): HTMLElement {
  const row = screen.getByRole("button", { name });
  const ring = row.querySelector<HTMLElement>('[data-testid="environment-status-ring"]');
  if (!ring) throw new Error("Environment status marker was not rendered");
  return ring;
}

function environmentMarker(name: RegExp): HTMLElement {
  const marker = screen
    .getByRole("button", { name })
    .querySelector<HTMLElement>('[data-testid="environment-status-marker"]');
  if (!marker) throw new Error("Environment status marker was not rendered");
  return marker;
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

function expectWorking(halo: HTMLElement) {
  expect(halo.parentElement?.getAttribute("data-state")).toBe("working");
  expect(halo.classList).toContain("bg-red-500/50");
  expect(halo.classList).toContain("animate-pulse");
  expect(halo.classList).not.toContain("bg-yellow-400/50");
}

function expectIdle(halo: HTMLElement) {
  expect(halo.parentElement?.getAttribute("data-state")).toBe("idle");
  expect(halo.classList).toContain("opacity-0");
  expect(halo.classList).not.toContain("bg-red-500/50");
  expect(halo.classList).not.toContain("animate-pulse");
}

function expectWaiting(halo: HTMLElement) {
  expect(halo.parentElement?.getAttribute("data-state")).toBe("waiting");
  expect(halo.classList).toContain("bg-yellow-400/50");
  expect(halo.classList).toContain("animate-pulse");
  expect(halo.classList).not.toContain("bg-red-500/50");
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
  resetChangeProjectionStore();
  useEnvironmentDiffStore.setState({ stats: new Map() });
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

describe("EnvironmentItem project home", () => {
  test("labels the project checkout instead of showing the record's name", () => {
    renderItem(environmentFixture({ name: "project-home", projectHome: true }));

    const row = screen.getByRole("button", { name: /Project home/ });
    expect(row.textContent).toContain("Project home");
    expect(row.textContent).not.toContain("project-home");
    expect(environmentMarker(/Project home/).dataset.shape).toBe("circle");
  });

  test("marks a local environment with a dot and a container with a square", () => {
    renderItem(environmentFixture({ name: "feature-work" }));
    expect(environmentMarker(/feature-work/).dataset.shape).toBe("circle");
    cleanup();

    renderItem(
      environmentFixture({
        name: "boxed-work",
        environmentType: "containerized",
        containerId: "container-1",
      }),
    );
    expect(environmentMarker(/boxed-work/).dataset.shape).toBe("square");
  });
});

test("a renamed project home shows its saved display name", () => {
  renderItem(environmentFixture({ projectHome: true, name: "Release checkout" }));
  expect(screen.getByRole("button", { name: /Release checkout/ })).toBeTruthy();
  expect(Boolean(screen.queryByText("Project home"))).toBe(false);
});

describe("EnvironmentItem change badge", () => {
  const legacyStats = { additions: 99, deletions: 98, filesChanged: 7, truncated: false };

  function badge() {
    return screen.queryByTestId("environment-change-badge");
  }

  test("renders the backend projection's counters instead of the legacy mirror", () => {
    useEnvironmentDiffStore.setState({ stats: new Map([["env-1", legacyStats]]) });
    useChangeProjectionStore.getState().applyProjection(environmentProjectionFixture("env-1"));
    renderItem();

    expect(badge()?.textContent).toBe("+12-3");
    expect(badge()?.getAttribute("data-measurement-id")).toBe("m-1");
    expect(badge()?.getAttribute("title")).toContain("Environment changes");
    expect(document.body.textContent).not.toContain("+99");
  });

  test("an unknown count renders as ? and never as 0", () => {
    useChangeProjectionStore.getState().applyProjection(
      environmentProjectionFixture("env-1", {
        state: "partial",
        coverageState: "partial",
        counters: { additions: unknownCount(), deletions: exactCount(4), changedFiles: null },
        reasonKeys: ["changes.reason.untracked-scan-capped"],
      }),
    );
    renderItem();

    expect(badge()?.textContent).toBe("~+?-4");
    expect(badge()?.textContent).not.toContain("+0");
    expect(badge()?.getAttribute("data-change-state")).toBe("partial");
    expect(badge()?.getAttribute("title")).toContain("Too many untracked files to count them all");
  });

  test("a stale projection keeps the approximate mark and explains it on hover", async () => {
    useChangeProjectionStore.getState().applyProjection(
      environmentProjectionFixture("env-1", {
        state: "stale",
        observationState: "stale",
        reasonKeys: ["changes.reason.stale"],
      }),
    );
    renderItem();
    expect(badge()?.textContent).toBe("~+12-3");

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Pulsing icon/ }));
    await waitFor(() => expect(screen.getByTestId("environment-change-summary")).toBeTruthy());
    const summary = screen.getByTestId("environment-change-summary").textContent ?? "";
    expect(summary).toContain("2 files changed");
    expect(summary).toContain("Last refresh failed; showing the previous result");
    expect(summary).toContain("+12 added");
  });

  test("the backend's hidden badge stays hidden even when the legacy mirror has numbers", () => {
    useEnvironmentDiffStore.setState({ stats: new Map([["env-1", legacyStats]]) });
    useChangeProjectionStore.getState().applyProjection(
      environmentProjectionFixture("env-1", {
        badge: { visible: false, mode: "none" },
        hasFileChanges: false,
        counters: { additions: exactCount(0), deletions: exactCount(0), changedFiles: 0 },
      }),
    );
    renderItem();
    expect(badge()).toBeNull();
    expect(document.body.textContent).not.toContain("+99");
  });

  test("an older backend without a projection falls back to the legacy mirror", () => {
    useEnvironmentDiffStore.setState({ stats: new Map([["env-1", legacyStats]]) });
    renderItem();
    expect(badge()).toBeNull();
    expect(document.body.textContent).toContain("+99-98");
  });
});
