import { beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useGlobalActivityMonitor } from "./useGlobalActivityMonitor";

describe("backend-owned activity projection", () => {
  beforeEach(() => {
    useAgentActivityStore.setState({
      tabStates: {},
      containerStates: {},
      containerStateUpdatedAt: {},
    });
    useEnvironmentStore.setState({ environments: [] });
  });

  test("bulk replacement exactly projects the environment snapshot", () => {
    useAgentActivityStore.getState().replaceActivitySnapshot([
      {
        id: "env-a",
        agentActivityState: "working",
        agentActivityUpdatedAt: "2026-08-04T10:00:00.000Z",
      },
      {
        id: "env-b",
        agentActivityState: "waiting",
        agentActivityUpdatedAt: "2026-08-04T10:00:01.000Z",
      },
    ]);
    expect(useAgentActivityStore.getState().containerStates).toEqual({
      "env-a": "working",
      "env-b": "waiting",
    });

    useAgentActivityStore.getState().replaceActivitySnapshot([
      {
        id: "env-a",
        agentActivityState: "idle",
        agentActivityUpdatedAt: "2026-08-04T10:00:02.000Z",
      },
    ]);
    expect(useAgentActivityStore.getState().containerStates).toEqual({
      "env-a": "idle",
    });
  });

  test("rehydrates the latest backend snapshot after the observer remounts", async () => {
    useEnvironmentStore.setState({
      environments: [{
        id: "env-a",
        agentActivityState: "working",
        agentActivityUpdatedAt: "2026-08-04T10:00:00.000Z",
      }] as never,
    });
    const first = renderHook(() => useGlobalActivityMonitor());
    await act(async () => undefined);
    expect(useAgentActivityStore.getState().containerStates).toEqual({
      "env-a": "working",
    });

    first.unmount();
    useEnvironmentStore.setState({
      environments: [{
        id: "env-b",
        agentActivityState: "waiting",
        agentActivityUpdatedAt: "2026-08-04T10:01:00.000Z",
      }] as never,
    });
    expect(useAgentActivityStore.getState().containerStates).toEqual({
      "env-a": "working",
    });

    const second = renderHook(() => useGlobalActivityMonitor());
    await act(async () => undefined);
    expect(useAgentActivityStore.getState().containerStates).toEqual({
      "env-b": "waiting",
    });
    second.unmount();
  });

  test("projects environment-store updates while the observer stays mounted", async () => {
    useEnvironmentStore.setState({
      environments: [{
        id: "env-a",
        agentActivityState: "working",
        agentActivityUpdatedAt: "2026-08-04T10:00:00.000Z",
      }] as never,
    });
    const observer = renderHook(() => useGlobalActivityMonitor());
    await act(async () => undefined);
    expect(useAgentActivityStore.getState().containerStates).toEqual({
      "env-a": "working",
    });

    act(() => {
      useEnvironmentStore.setState({
        environments: [{
          id: "env-b",
          agentActivityState: "waiting",
          agentActivityUpdatedAt: "2026-08-04T10:01:00.000Z",
        }] as never,
      });
    });

    expect(useAgentActivityStore.getState().containerStates).toEqual({
      "env-b": "waiting",
    });
    observer.unmount();
  });
});
