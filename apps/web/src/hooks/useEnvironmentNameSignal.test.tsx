import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import type { Environment } from "@/types";
import { useEnvironmentIdNameSignal } from "./useEnvironmentNameSignal";

const environment: Environment = {
  id: "env",
  projectId: "project",
  name: "feature",
  branch: "feature",
  containerId: "container",
  status: "running",
  environmentType: "containerized",
  prUrl: "https://github.com/acme/repo/pull/1",
  prState: "open",
  hasMergeConflicts: false,
  prMergeability: "clean",
  createdAt: "2026-10-28T00:00:00Z",
  networkAccessMode: "restricted",
  order: 0,
  agentActivityState: "waiting",
  agentActivityUpdatedAt: "2026-10-28T10:00:00Z",
};
const initialEnvironment = useEnvironmentStore.getState();
const initialActivity = useAgentActivityStore.getState();
const initialBuild = useBuildPipelineStore.getState();
const initialMonitor = usePrMonitorStore.getState();
beforeEach(() => {
  useEnvironmentStore.setState({ environments: [environment], deletingEnvironments: new Set() });
  useAgentActivityStore.setState({ containerStates: {}, containerStateUpdatedAt: {} });
  useBuildPipelineStore.setState({ activeBuildEnvironmentIds: new Set() });
  usePrMonitorStore.setState({
    syncStatus: "current",
    states: new Map([
      [
        environment.id,
        {
          environmentId: environment.id,
          mode: "normal",
          checkInProgress: false,
          consecutiveErrors: 0,
          lastCheckAt: "2026-10-28T10:00:00Z",
          lastSuccessfulCheckAt: "2026-10-28T10:00:00Z",
          prUrl: environment.prUrl,
          prState: "open",
          hasMergeConflicts: false,
          checkSummary: null,
        },
      ],
    ]),
  });
});
afterEach(() => {
  cleanup();
  useEnvironmentStore.setState(initialEnvironment, true);
  useAgentActivityStore.setState(initialActivity, true);
  useBuildPipelineStore.setState(initialBuild, true);
  usePrMonitorStore.setState(initialMonitor, true);
});

test("pipeline-only changes override waiting and restore it when work ends", () => {
  const { result } = renderHook(() => useEnvironmentIdNameSignal("env"));
  expect(result.current).toBe("needs-answer");
  act(() => useBuildPipelineStore.setState({ activeBuildEnvironmentIds: new Set(["env"]) }));
  expect(result.current).toBe("merge-ready");
  act(() => useBuildPipelineStore.setState({ activeBuildEnvironmentIds: new Set() }));
  expect(result.current).toBe("needs-answer");
});

test("Docker and stopped-container gates suppress waiting; local worktrees stay answerable", () => {
  const { result, rerender } = renderHook(() => useEnvironmentIdNameSignal("env"), {
    wrapper: ({ children }) => (
      <DockerAvailabilityProvider available={false}>{children}</DockerAvailabilityProvider>
    ),
  });
  expect(result.current).toBe("merge-ready");
  act(() =>
    useEnvironmentStore.setState({
      environments: [{ ...environment, environmentType: "local", status: "stopped" }],
    }),
  );
  rerender();
  expect(result.current).toBe("needs-answer");
});

test("stopped containers suppress signals and live activity updates restore priority", () => {
  useEnvironmentStore.setState({
    environments: [
      { ...environment, status: "stopped", hasMergeConflicts: true, prMergeability: "dirty" },
    ],
  });
  usePrMonitorStore.setState((state) => ({
    states: new Map([["env", { ...state.states.get("env")!, hasMergeConflicts: true }]]),
  }));
  const { result } = renderHook(() => useEnvironmentIdNameSignal("env"));
  expect(result.current).toBeNull();
  act(() =>
    useEnvironmentStore.setState({
      environments: [{ ...environment, hasMergeConflicts: true, prMergeability: "dirty" }],
    }),
  );
  expect(result.current).toBe("needs-answer");
  act(() =>
    useAgentActivityStore.setState({
      containerStates: { container: "working" },
      containerStateUpdatedAt: { container: "2026-10-28T11:00:00Z" },
    }),
  );
  expect(result.current).toBe("merge-conflicts");
});

for (const signal of ["waiting", "ready", "conflicts"] as const) {
  test(`deletion suppresses ${signal}, including persisted lifecycle state`, () => {
    if (signal !== "waiting")
      useEnvironmentStore.setState({
        environments: [
          {
            ...environment,
            agentActivityState: "idle",
            hasMergeConflicts: signal === "conflicts",
            prMergeability: signal === "conflicts" ? "dirty" : "clean",
          },
        ],
      });
    if (signal === "conflicts")
      usePrMonitorStore.setState((state) => ({
        states: new Map([["env", { ...state.states.get("env")!, hasMergeConflicts: true }]]),
      }));
    const { result } = renderHook(() => useEnvironmentIdNameSignal("env"));
    expect(result.current).toBe(
      signal === "waiting"
        ? "needs-answer"
        : signal === "ready"
          ? "merge-ready"
          : "merge-conflicts",
    );
    act(() => useEnvironmentStore.getState().setDeleting("env", true));
    expect(result.current).toBeNull();
    act(() =>
      useEnvironmentStore.setState({
        deletingEnvironments: new Set(),
        environments: [{ ...environment, lifecycleOperation: "deleting" }],
      }),
    );
    expect(result.current).toBeNull();
  });
}

test("missing and unselected environments have no signal", () => {
  const { result, rerender } = renderHook(({ id }) => useEnvironmentIdNameSignal(id), {
    initialProps: { id: null as string | null },
  });
  expect(result.current).toBeNull();
  rerender({ id: "missing" });
  expect(result.current).toBeNull();
});
