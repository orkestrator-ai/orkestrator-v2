import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { filesPanelStore, uiStore } from "@/stores";
const filesState = appCommandStore(filesPanelStore).getState();
const uiState = appCommandStore(uiStore).getState();
import * as realLoaders from "@/lib/lazy-view-loaders";
import { appCommandStore } from "@/test/app-command-store";
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
  appCommandStore(filesPanelStore).setState(filesState, true);
  appCommandStore(uiStore).setState(uiState, true);
});
test.each([false, true])(
  "pull request surface loading and import failure stay scoped (view=%s)",
  async (view) => {
    appCommandStore(uiStore).setState({
      selectedProjectId: "project",
      selectedEnvironmentId: null,
    });
    if (view)
      appCommandStore(filesPanelStore)
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
    expect(screen.queryByRole("button", { name: "Retry view" }) === null).toBe(true);
    expect(rejectImport).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reload application" })).toBeTruthy();
    expect(screen.getByText("Files shell")).toBeTruthy();
  },
);
