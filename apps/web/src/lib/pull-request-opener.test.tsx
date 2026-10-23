import { beforeEach, afterEach, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import type { Environment } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useFilesPanelStore } from "@/stores/filesPanelStore";
import { useProjectPullRequestsStore } from "@/stores/projectPullRequestsStore";
import {
  openPullRequestInApp,
  PullRequestOpenerProvider,
  usePullRequestOpener,
} from "./pull-request-opener";
const ref = { owner: "acme", repo: "repo", number: 7 };
const environment: Environment = {
  id: "env",
  projectId: "project",
  name: "env",
  branch: "feature",
  containerId: "container",
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-01-01",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "containerized",
};
beforeEach(() => {
  useUIStore.setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    projectBoardTab: "home",
  });
  useEnvironmentStore.setState({ environments: [] });
  useFilesPanelStore.setState({ pullRequestTabs: {}, isOpen: false });
  useProjectPullRequestsStore.setState({ projects: {} });
});
afterEach(cleanup);

test("returns false for browser fallback without a selected host", () => {
  expect(openPullRequestInApp(ref)).toBe(false);
  expect(useFilesPanelStore.getState().isOpen).toBe(false);
});

test("project selection opens project tabs and selects Pull requests", () => {
  useUIStore.setState({ selectedProjectId: "project" });
  expect(openPullRequestInApp(ref, "timeline")).toBe(true);
  expect(useProjectPullRequestsStore.getState().projects.project?.tabs[0]?.view).toBe("timeline");
  expect(useUIStore.getState().projectBoardTab).toBe("pull-requests");
});

test.each([false, true])(
  "ordinary environments use their files panel (projectHome=%s on home)",
  (projectHome) => {
    useEnvironmentStore.setState({ environments: [{ ...environment, projectHome }] });
    useUIStore.setState({ selectedEnvironmentId: "env", selectedProjectId: "other" });
    expect(openPullRequestInApp(ref, "code")).toBe(true);
    expect(useFilesPanelStore.getState().pullRequestTabs.env?.[0]?.view).toBe("code");
    expect(useFilesPanelStore.getState().isOpen).toBe(true);
    expect(useProjectPullRequestsStore.getState().projects).toEqual({});
  },
);

test("project home on a board page routes to its own project", () => {
  useEnvironmentStore.setState({ environments: [{ ...environment, projectHome: true }] });
  useUIStore.setState({
    selectedEnvironmentId: "env",
    selectedProjectId: "other",
    projectBoardTab: "features",
  });
  expect(openPullRequestInApp(ref)).toBe(true);
  expect(useProjectPullRequestsStore.getState().projects.project?.tabs).toHaveLength(1);
  expect(useFilesPanelStore.getState().isOpen).toBe(false);
});

test("subtree providers route links to their host and acknowledge handling", () => {
  const calls: unknown[] = [];
  const { result } = renderHook(usePullRequestOpener, {
    wrapper: ({ children }) => (
      <PullRequestOpenerProvider open={(...args) => calls.push(args)}>
        {children}
      </PullRequestOpenerProvider>
    ),
  });
  expect(result.current(ref, "code")).toBe(true);
  expect(calls).toEqual([[ref, "code"]]);
});

test("an ordinary environment on another board tab still routes to the files panel", () => {
  useEnvironmentStore.setState({ environments: [environment] });
  useUIStore.setState({
    selectedEnvironmentId: "env",
    selectedProjectId: "project",
    projectBoardTab: "features",
  });
  expect(openPullRequestInApp(ref)).toBe(true);
  expect(useFilesPanelStore.getState().pullRequestTabs.env).toHaveLength(1);
  expect(useUIStore.getState().projectBoardTab).toBe("features");
});
