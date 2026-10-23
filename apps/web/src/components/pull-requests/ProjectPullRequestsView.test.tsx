import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalProvider, useTerminalContext } from "@/contexts/TerminalContext";
import { useProjectPullRequestsStore } from "@/stores/projectPullRequestsStore";
import { useFilesPanelStore } from "@/stores/filesPanelStore";
import { useUIStore } from "@/stores/uiStore";
import { FilesPanelPullRequests } from "@/components/files-panel/FilesPanelPullRequests";
import { FilesPanelHeader } from "@/components/files-panel/FilesPanelHeader";
import { ProjectPullRequestsView } from "./ProjectPullRequestsView";
import {
  installBackend,
  makeDetail,
  makeFiles,
  makeListItem,
  prRef,
  resetBackend,
  resetPullRequestsStore,
} from "./pull-request-test-fixtures";

beforeEach(() => {
  resetPullRequestsStore();
  useProjectPullRequestsStore.setState({ projects: {} });
  useFilesPanelStore.setState({ pullRequestTabs: {}, activeTab: "pull-requests" });
  useUIStore.setState({ selectedProjectId: "project", selectedEnvironmentId: null });
  installBackend({
    list_github_pull_requests: () => ({
      repository: { owner: "acme", repo: "widget", fullName: "acme/widget", htmlUrl: "" },
      viewer: { login: "ada" },
      filter: "open",
      pullRequests: [makeListItem(42), makeListItem(43)],
      hasMore: false,
    }),
    get_github_pull_request: (args) =>
      makeDetail({
        ref: { ...prRef, number: Number(args.number) },
        title: `Detail ${args.number}`,
      }),
    get_github_pull_request_files: () => makeFiles(),
    get_github_pull_request_timeline: () => ({ ref: prRef, items: [], truncated: false }),
  });
});
afterEach(() => {
  cleanup();
  resetBackend();
});

test("project host opens, focuses, closes and restores tabs across projects", async () => {
  const { rerender } = render(<ProjectPullRequestsView projectId="project" />);
  fireEvent.click(await screen.findByText("Pull request 42"));
  expect(await screen.findByRole("heading", { name: "Detail 42" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Pull requests" }));
  fireEvent.click(await screen.findByText("Pull request 43"));
  expect(await screen.findByRole("heading", { name: "Detail 43" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: /#42/ }));
  expect(await screen.findByRole("heading", { name: "Detail 42" })).toBeTruthy();
  // Reopening requests the code view without adding a duplicate project tab.
  act(() => useProjectPullRequestsStore.getState().openPullRequest("project", prRef, "code"));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"),
  );
  expect(useProjectPullRequestsStore.getState().projects.project?.tabs).toHaveLength(2);
  rerender(<ProjectPullRequestsView projectId="other" />);
  expect(await screen.findByText("Pull request 42")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Detail 42" }) === null).toBe(true);
  rerender(<ProjectPullRequestsView projectId="project" />);
  expect(await screen.findByRole("heading", { name: "Detail 42" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Close acme\/widget #42/ }));
  expect(await screen.findByRole("heading", { name: "Detail 43" })).toBeTruthy();
  // Simulate persisted reload: the saved refs and summary survive, view requests reset.
  const state = useProjectPullRequestsStore.getState();
  const restored = useProjectPullRequestsStore.persist.getOptions().merge!(
    { projects: state.projects },
    state,
  );
  act(() => useProjectPullRequestsStore.setState(restored));
  rerender(<ProjectPullRequestsView projectId="project" />);
  expect(await screen.findByRole("heading", { name: "Detail 43" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Close acme\/widget #43/ }));
  expect(await screen.findByText("Pull request 42")).toBeTruthy();
});

const createTab = mock(() => true);
function RegisterTabs() {
  const { setCreateTab } = useTerminalContext();
  useEffect(() => {
    setCreateTab(createTab);
    return () => setCreateTab(null);
  }, [setCreateTab]);
  return null;
}

function Panel({ targetId }: { targetId: string }) {
  return (
    <>
      <FilesPanelHeader targetId={targetId} onRefresh={() => {}} />
      <FilesPanelPullRequests targetId={targetId} />
    </>
  );
}

test("sidebar keeps targets separate, restores tabs, and expands only after main-tab creation succeeds", async () => {
  createTab.mockClear();
  createTab.mockReturnValue(false);
  useFilesPanelStore.getState().openPullRequest("env-a", prRef, "code");
  const { rerender } = render(
    <TerminalProvider>
      <RegisterTabs />
      <Panel targetId="env-a" />
    </TerminalProvider>,
  );
  expect(await screen.findByRole("heading", { name: "Detail 42" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open in main area" }));
  expect(useFilesPanelStore.getState().pullRequestTabs["env-a"]).toHaveLength(1);
  rerender(
    <TerminalProvider>
      <RegisterTabs />
      <Panel targetId="env-b" />
    </TerminalProvider>,
  );
  expect(await screen.findByText("Pull request 42")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Detail 42" }) === null).toBe(true);
  rerender(
    <TerminalProvider>
      <RegisterTabs />
      <Panel targetId="env-a" />
    </TerminalProvider>,
  );
  expect(await screen.findByRole("heading", { name: "Detail 42" })).toBeTruthy();
  // Restoring resets the requested view but retains the PR identity.
  const state = useFilesPanelStore.getState();
  act(() =>
    useFilesPanelStore.setState(
      useFilesPanelStore.persist.getOptions().merge!(
        { pullRequestTabs: state.pullRequestTabs },
        state,
      ),
    ),
  );
  expect(await screen.findByRole("heading", { name: "Detail 42" })).toBeTruthy();
  createTab.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Open in main area" }));
  expect(createTab).toHaveBeenLastCalledWith("pull-request", {
    pullRequest: { ref: prRef, view: "summary" },
  });
  expect(useFilesPanelStore.getState().pullRequestTabs["env-a"]).toBeUndefined();
  expect(await screen.findByText("Pull request 42")).toBeTruthy();
});
