import { afterEach, describe, expect, test } from "bun:test";
import { useBugReportStore } from "@/stores/bugReportStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { openBugReport } from "./open-bug-report";

afterEach(() => {
  useBugReportStore.setState({ sheetOpen: false, draftInProgress: false });
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
});
