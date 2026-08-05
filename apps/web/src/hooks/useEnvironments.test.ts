import { afterEach, describe, expect, mock, test } from "bun:test";
import { useClaudeStore } from "@/stores/claudeStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import type { Environment } from "@/types";
import {
  cleanupDeletedEnvironmentSubscriptions,
  cleanupSubscriptionsRemovedByProjectSnapshot,
} from "./useEnvironments";

const originalClaudeClose = useClaudeStore.getState().closeEventSubscription;
const originalOpenCodeClose = useOpenCodeStore.getState().closeEventSubscription;

afterEach(() => {
  useClaudeStore.setState({ closeEventSubscription: originalClaudeClose });
  useOpenCodeStore.setState({ closeEventSubscription: originalOpenCodeClose });
  useEnvironmentStore.setState({ environments: [] });
});

function environment(id: string, projectId: string): Environment {
  return {
    id,
    projectId,
    name: id,
    branch: id,
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    setupPhase: "ready",
  };
}

describe("cleanupDeletedEnvironmentSubscriptions", () => {
  test("stops both store-owned subscriptions for the deleted environment", () => {
    const closeClaude = mock((_environmentId: string) => {});
    const closeOpenCode = mock((_environmentId: string) => {});
    useClaudeStore.setState({ closeEventSubscription: closeClaude });
    useOpenCodeStore.setState({ closeEventSubscription: closeOpenCode });

    cleanupDeletedEnvironmentSubscriptions("env-deleted");

    expect(closeClaude).toHaveBeenCalledWith("env-deleted");
    expect(closeOpenCode).toHaveBeenCalledWith("env-deleted");
  });

  test("stops only subscriptions removed by an authoritative project snapshot", () => {
    const closeClaude = mock((_environmentId: string) => {});
    const closeOpenCode = mock((_environmentId: string) => {});
    useClaudeStore.setState({ closeEventSubscription: closeClaude });
    useOpenCodeStore.setState({ closeEventSubscription: closeOpenCode });
    const removed = environment("removed", "project-1");
    const surviving = environment("surviving", "project-1");
    const otherProject = environment("other-project", "project-2");
    useEnvironmentStore.setState({
      environments: [removed, surviving, otherProject],
    });

    cleanupSubscriptionsRemovedByProjectSnapshot("project-1", [surviving]);

    expect(closeClaude.mock.calls).toEqual([["removed"]]);
    expect(closeOpenCode.mock.calls).toEqual([["removed"]]);
  });
});
