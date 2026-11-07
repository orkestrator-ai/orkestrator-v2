import { beforeEach, afterEach, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import type { Environment, Project } from "@/types";
import { uiStore } from "@/stores/uiStore";

import { projectPullRequestsStore } from "@/stores/projectPullRequestsStore";

import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { BackendId } from "@orkestrator/protocol/federation";
import { environmentStore } from "@/stores/environmentStore";
import { filesPanelStore } from "@/stores/filesPanelStore";
import { projectStore } from "@/stores/projectStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  currentFilesPanelTargetId,
  openPullRequestInApp,
  openPullRequestUrl,
  PullRequestOpenerProvider,
  usePullRequestOpener,
} from "./pull-request-opener";
import { filesPanelTestState, setFilesPanelTestState } from "@/test/files-panel-state";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { appCommandStore } from "@/test/app-command-store";

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
const project = { id: "project", name: "Project", localPath: "/repo" } as Project;

beforeEach(() => {
  appCommandStore(uiStore).setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    projectBoardTab: "home",
  });
  appCommandStore(environmentStore).setState({ environments: [] });
  appCommandStore(projectStore).setState({ projects: [project] });
  setFilesPanelTestState({ pullRequestTabs: {}, isOpen: false, activeTab: "changes" });
  appCommandStore(projectPullRequestsStore).setState({ projects: {} });
  useRemoteWorkspaceStore.setState({ active: null, openNodes: [], requests: {} });
});
afterEach(() => {
  cleanup();
  resetWindowScopeForTests();
});

/** What the main view shows; opening a pull request must leave all of it alone. */
function mainView() {
  const ui = appCommandStore(uiStore).getState();
  return {
    selectedProjectId: ui.selectedProjectId,
    selectedEnvironmentId: ui.selectedEnvironmentId,
    projectBoardTab: ui.projectBoardTab,
    projectPullRequests: appCommandStore(projectPullRequestsStore).getState().projects,
  };
}

test("returns false for browser fallback without a selected host", () => {
  expect(currentFilesPanelTargetId()).toBeNull();
  expect(openPullRequestInApp(ref)).toBe(false);
  expect(useFilesPanelChromeStore.getState().isOpen).toBe(false);
});

test("a project page opens the pull request in the project root's pane, not its Pull requests tab", () => {
  appCommandStore(uiStore).setState({
    selectedProjectId: "project",
    projectBoardTab: "coordinator" as never,
  });
  const before = mainView();
  expect(openPullRequestInApp(ref, "timeline")).toBe(true);
  const panel = filesPanelTestState();
  expect(panel.isOpen).toBe(true);
  expect(panel.activeTab).toBe("pull-request:acme/repo#7");
  expect(panel.pullRequestTabs["project-root:project"]?.[0]?.view).toBe("timeline");
  expect(mainView()).toEqual(before);
});

test("an unknown selected project has no pane to host the pull request", () => {
  appCommandStore(uiStore).setState({ selectedProjectId: "missing" });
  expect(openPullRequestInApp(ref)).toBe(false);
});

test.each([false, true])(
  "ordinary environments use their files panel (projectHome=%s on home)",
  (projectHome) => {
    appCommandStore(environmentStore).setState({ environments: [{ ...environment, projectHome }] });
    appCommandStore(uiStore).setState({ selectedEnvironmentId: "env", selectedProjectId: "other" });
    const before = mainView();
    expect(openPullRequestInApp(ref, "code")).toBe(true);
    expect(appCommandStore(filesPanelStore).getState().pullRequestTabs.env?.[0]?.view).toBe("code");
    expect(useFilesPanelChromeStore.getState().isOpen).toBe(true);
    expect(mainView()).toEqual(before);
  },
);

test("project home on a board page opens in the pane and keeps the board tab", () => {
  appCommandStore(environmentStore).setState({
    environments: [{ ...environment, projectHome: true }],
  });
  appCommandStore(uiStore).setState({
    selectedEnvironmentId: "env",
    selectedProjectId: "project",
    projectBoardTab: "features",
  });
  const before = mainView();
  expect(openPullRequestInApp(ref)).toBe(true);
  expect(appCommandStore(filesPanelStore).getState().pullRequestTabs.env).toHaveLength(1);
  expect(useFilesPanelChromeStore.getState().isOpen).toBe(true);
  expect(mainView()).toEqual(before);
});

test("a pull request from another project opens in the current view's pane", () => {
  appCommandStore(environmentStore).setState({ environments: [environment] });
  appCommandStore(uiStore).setState({ selectedEnvironmentId: "env", selectedProjectId: "project" });
  const foreign = { owner: "other-org", repo: "elsewhere", number: 3 };
  expect(openPullRequestInApp(foreign)).toBe(true);
  expect(appCommandStore(filesPanelStore).getState().pullRequestTabs.env?.[0]?.ref).toEqual(
    foreign,
  );
  expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env");
});

test("another machine's workspace has its own pane, so the window falls back", () => {
  appCommandStore(environmentStore).setState({ environments: [environment] });
  appCommandStore(uiStore).setState({ selectedEnvironmentId: "env", selectedProjectId: "project" });
  // The window's selection moves to the other node, so this node's shows nothing.
  useRemoteWorkspaceStore.getState().open("node-2", {});
  expect(openPullRequestInApp(ref)).toBe(false);
  expect(useFilesPanelChromeStore.getState().isOpen).toBe(false);
});

test("with a leaf shown in the window's tree, the pull request opens in the leaf's files panel", () => {
  // The command node has a selection of its own, which must not receive it.
  appCommandStore(environmentStore).setState({ environments: [environment] });
  appCommandStore(uiStore).setState({ selectedEnvironmentId: "env", selectedProjectId: "project" });
  const windowScope = getWindowScope();
  const leafId = "bk_leaf-pr" as BackendId;
  const leaf = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: leafId }) });
  leaf.store(projectStore).setState({ projects: [project] });
  leaf.store(environmentStore).setState({ environments: [{ ...environment, id: "leaf-env" }] });
  // The window shows the leaf's environment, as a sidebar click on it does.
  windowScope.select({ nodeId: leafId, projectId: "project", environmentId: "leaf-env" });

  expect(openPullRequestInApp(ref, "timeline")).toBe(true);
  const tabs = leaf.store(filesPanelStore).getState().pullRequestTabs["leaf-env"];
  expect(tabs?.[0]?.ref).toEqual(ref);
  expect(tabs?.[0]?.view).toBe("timeline");
  expect(useFilesPanelChromeStore.getState().isOpen).toBe(true);
  // Nothing went to the command node's panel.
  expect(
    windowScope.commandScope().store(filesPanelStore).getState().pullRequestTabs.env,
  ).toBeUndefined();

  // A node with no open scope here: the window falls back.
  windowScope.select({ nodeId: "bk_unopened" as BackendId, projectId: "p", environmentId: null });
  expect(openPullRequestInApp(ref)).toBe(false);
});

test("subtree providers route links to their host and acknowledge handling", () => {
  const calls: unknown[] = [];
  const { result } = renderHook(usePullRequestOpener, {
    wrapper: ({ children }) => (
      <PullRequestOpenerProvider open={(...args) => void calls.push(args)}>
        {children}
      </PullRequestOpenerProvider>
    ),
  });
  expect(result.current(ref, "code")).toBe(true);
  expect(calls).toEqual([[ref, "code"]]);
});

/** Stands in for the desktop shell, which is how `openInBrowser` reaches a browser. */
function withBrowser() {
  const openExternal = mock((_url: string) => Promise.resolve());
  const original = window.orkestrator;
  window.orkestrator = { ...original, shell: { ...original?.shell, openExternal } } as never;
  return { openExternal, restore: () => (window.orkestrator = original) };
}

test("a provider can decline, so the link falls back to the browser", () => {
  const { result } = renderHook(usePullRequestOpener, {
    wrapper: ({ children }) => (
      <PullRequestOpenerProvider open={() => false}>{children}</PullRequestOpenerProvider>
    ),
  });
  expect(result.current(ref)).toBe(false);
});

test("openPullRequestUrl opens GitHub pull request links in the pane", async () => {
  const browser = withBrowser();
  try {
    const opener = mock(() => true);
    expect(await openPullRequestUrl("https://github.com/acme/repo/pull/7/files", { opener })).toBe(
      true,
    );
    expect(opener).toHaveBeenCalledWith(
      { owner: "acme", repo: "repo", number: 7, view: "code" },
      "code",
    );
    expect(browser.openExternal).not.toHaveBeenCalled();
  } finally {
    browser.restore();
  }
});

test.each([
  ["an explicit external open", "https://github.com/acme/repo/pull/7", true, true],
  ["a URL the pane cannot show", "https://example.com/acme/repo/pull/7", false, false],
  ["a pane with no host", "https://github.com/acme/repo/pull/7", false, true],
])("openPullRequestUrl falls back to the browser for %s", async (_, url, external, isPr) => {
  const browser = withBrowser();
  try {
    const opener = mock(() => false);
    expect(await openPullRequestUrl(url, { external, opener })).toBe(false);
    expect(opener).toHaveBeenCalledTimes(!external && isPr ? 1 : 0);
    expect(browser.openExternal).toHaveBeenCalledWith(url);
  } finally {
    browser.restore();
  }
});
