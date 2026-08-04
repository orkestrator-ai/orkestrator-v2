import { beforeEach, describe, expect, test } from "bun:test";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import {
  isEnvironmentActivityTransition,
  isEnvironmentCompletionTransition,
} from "./useGlobalActivityMonitor";

describe("backend-owned activity projection", () => {
  beforeEach(() => {
    useAgentActivityStore.setState({
      tabStates: {},
      containerStates: {},
      containerStateUpdatedAt: {},
      containerRefCounts: {},
    });
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

  test("classifies backend transition edges", () => {
    expect(isEnvironmentActivityTransition("idle", "working")).toBe(true);
    expect(isEnvironmentActivityTransition("working", "idle")).toBe(true);
    expect(isEnvironmentActivityTransition("waiting", "idle")).toBe(false);
    expect(isEnvironmentCompletionTransition("working", "waiting")).toBe(true);
    expect(isEnvironmentCompletionTransition("idle", "waiting")).toBe(false);
  });
});
