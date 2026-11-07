import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useBugReportStore } from "@/stores/bugReportStore";
import { useInTreeNodesStore } from "@/stores/inTreeNodesStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { openBugReport } from "./open-bug-report";

// The realm cases run under the rollback setting (plan item 6001); the
// in-tree cases turn it off, as the default is.
beforeEach(() => useInTreeNodesStore.setState({ useRealmsForRemoteMachines: true }));

afterEach(() => {
  useBugReportStore.setState({ sheetOpen: false, sheetNodeId: null, draftInProgress: false });
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  useRemoteWorkspaceStore.setState({ active: null, realms: [], requests: {} });
});

describe("openBugReport", () => {
  test("opens this window's own sheet for its own machine", () => {
    openBugReport();
    expect(useBugReportStore.getState().sheetOpen).toBe(true);
    useBugReportStore.getState().closeSheet();
    openBugReport(null);
    expect(useBugReportStore.getState().sheetOpen).toBe(true);
  });

  test("asks another machine's realm to open its sheet, keeping its selection", () => {
    useRemoteWorkspaceStore.setState({
      active: { nodeId: "node-b", projectId: "p1", environmentId: "e1" },
      realms: ["node-b"],
    });
    openBugReport();
    expect(useBugReportStore.getState().sheetOpen).toBe(false);
    const request = useRemoteWorkspaceStore.getState().requests["node-b"]?.request;
    expect(request).toMatchObject({
      type: "select",
      projectId: "p1",
      environmentId: "e1",
      bugReport: true,
    });
  });

  test("opens a machine that is not in front on its launcher", () => {
    openBugReport("node-c");
    expect(useRemoteWorkspaceStore.getState().requests["node-c"]?.request).toEqual({
      type: "select",
      bugReport: true,
    });
  });

  test("a node shown in the window's tree gets the window's sheet on its scope, without a realm request", () => {
    useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
    useRemoteWorkspaceStore.setState({
      active: { nodeId: "node-b", projectId: "p1", environmentId: "e1" },
      realms: ["node-b"],
      requests: {},
    });
    openBugReport();
    expect(useBugReportStore.getState()).toMatchObject({ sheetOpen: true, sheetNodeId: "node-b" });
    // Already in front: nothing is asked of its workspace.
    expect(useRemoteWorkspaceStore.getState().requests["node-b"]).toBeUndefined();
  });

  test("an in-tree node not in front is shown on its launcher, and its sheet opens here", () => {
    useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
    openBugReport("node-c");
    expect(useRemoteWorkspaceStore.getState().requests["node-c"]?.request).toEqual({
      type: "select",
    });
    expect(useBugReportStore.getState()).toMatchObject({ sheetOpen: true, sheetNodeId: "node-c" });
  });
});
