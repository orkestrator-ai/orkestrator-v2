import { lazy } from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import * as realList from "@/components/pull-requests/PullRequestList";
import * as realView from "@/components/pull-requests/PullRequestView";
import { useFilesPanelStore, useUIStore } from "@/stores";
const listSnapshot = { ...realList };
const viewSnapshot = { ...realView };
const filesState = useFilesPanelStore.getState();
const uiState = useUIStore.getState();
mock.module("@/components/pull-requests/PullRequestList", () => ({
  PullRequestList: lazy(async () => {
    throw new Error("Failed to fetch dynamically imported module");
  }),
}));
mock.module("@/components/pull-requests/PullRequestView", () => ({
  PullRequestView: lazy(async () => {
    throw new Error("Failed to fetch dynamically imported module");
  }),
}));
const { FilesPanelPullRequests } = await import("./FilesPanelPullRequests");
afterAll(() => {
  mock.module("@/components/pull-requests/PullRequestList", () => listSnapshot);
  mock.module("@/components/pull-requests/PullRequestView", () => viewSnapshot);
});
afterEach(() => {
  cleanup();
  useFilesPanelStore.setState(filesState, true);
  useUIStore.setState(uiState, true);
});
test.each([false, true])(
  "pull request surface loading and import failure stay scoped (view=%s)",
  async (view) => {
    useUIStore.setState({ selectedProjectId: "project", selectedEnvironmentId: null });
    if (view)
      useFilesPanelStore
        .getState()
        .openPullRequest("target", { owner: "owner", repo: "repo", number: 1 });
    render(
      <main>
        <nav>Files shell</nav>
        <FilesPanelPullRequests targetId="target" />
      </main>,
    );
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload application" })).toBeTruthy();
    expect(screen.getByText("Files shell")).toBeTruthy();
  },
);
