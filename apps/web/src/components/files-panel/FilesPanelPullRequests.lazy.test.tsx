import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { useFilesPanelStore, useUIStore } from "@/stores";
const filesState = useFilesPanelStore.getState();
const uiState = useUIStore.getState();
import * as realLoaders from "@/lib/lazy-view-loaders";
const snapshot = { ...realLoaders };
const rejectImport = mock(async () => {
  throw new Error("Failed to fetch dynamically imported module");
});
mock.module("@/lib/lazy-view-loaders", () => ({
  ...snapshot,
  loadPullRequestList: rejectImport,
  loadPullRequestView: rejectImport,
}));
const { FilesPanelPullRequests } = await import("./FilesPanelPullRequests");
afterAll(() => mock.module("@/lib/lazy-view-loaders", () => snapshot));
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
    expect(screen.getByText("This part of the app failed to load")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry view" })).toBeNull();
    expect(rejectImport).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reload application" })).toBeTruthy();
    expect(screen.getByText("Files shell")).toBeTruthy();
  },
);
