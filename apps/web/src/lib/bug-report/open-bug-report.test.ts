import { afterEach, describe, expect, test } from "bun:test";
import { useBugReportStore } from "@/stores/bugReportStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { openBugReport } from "./open-bug-report";

afterEach(() => {
  useBugReportStore.setState({ sheetOpen: false, sheetNodeId: null, draftInProgress: false });
  useRemoteWorkspaceStore.setState({ active: null, openNodes: [], requests: {} });
});

describe("openBugReport", () => {
  test("opens this window's own sheet for its own machine", () => {
    openBugReport();
    expect(useBugReportStore.getState().sheetOpen).toBe(true);
    useBugReportStore.getState().closeSheet();
    openBugReport(null);
    expect(useBugReportStore.getState().sheetOpen).toBe(true);
  });

  test("another node in front gets the window's sheet on its scope, without a new request", () => {
    useRemoteWorkspaceStore.setState({
      active: { nodeId: "node-b", projectId: "p1", environmentId: "e1" },
      openNodes: ["node-b"],
      requests: {},
    });
    openBugReport();
    expect(useBugReportStore.getState()).toMatchObject({ sheetOpen: true, sheetNodeId: "node-b" });
    // Already in front: nothing is asked of its workspace.
    expect(useRemoteWorkspaceStore.getState().requests["node-b"]).toBeUndefined();
  });

  test("a node not in front is shown on its launcher, and its sheet opens here", () => {
    openBugReport("node-c");
    expect(useRemoteWorkspaceStore.getState().requests["node-c"]?.request).toEqual({});
    expect(useBugReportStore.getState()).toMatchObject({ sheetOpen: true, sheetNodeId: "node-c" });
  });
});
