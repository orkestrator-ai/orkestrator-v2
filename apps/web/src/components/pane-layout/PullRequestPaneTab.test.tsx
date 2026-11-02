import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installBackend,
  makeDetail,
  makeFiles,
  prRef,
  resetBackend,
  resetPullRequestsStore,
} from "@/components/pull-requests/pull-request-test-fixtures";
import { useFilesPanelStore } from "@/stores/filesPanelStore";
import { useUIStore } from "@/stores/uiStore";
import { PullRequestPaneTab } from "./PullRequestPaneTab";

beforeEach(() => {
  resetPullRequestsStore();
  useFilesPanelStore.setState({ isOpen: false, activeTab: "changes", pullRequestTabs: {} });
  useUIStore.setState({ selectedProjectId: "project", selectedEnvironmentId: "env" });
  installBackend({
    get_github_pull_request: () =>
      makeDetail({ body: "Follows [the API change](https://github.com/acme/api/pull/7)." }),
    get_github_pull_request_files: () => makeFiles(),
    get_github_pull_request_timeline: () => ({ ref: prRef, items: [], truncated: false }),
  });
});
afterEach(() => {
  cleanup();
  resetBackend();
  useUIStore.setState({ selectedProjectId: null, selectedEnvironmentId: null });
});

test("a pull request linked from a main-area pull request opens in the right-hand PR pane", async () => {
  const layout = usePaneLayoutStore.getState();
  layout.initialize(null, "env");
  const owner = usePaneLayoutStore.getState().environments.get("env")!;
  layout.addTab(
    owner.activePaneId,
    {
      id: "pr-tab",
      type: "pull-request",
      displayTitle: "PR",
      pullRequestData: { ref: prRef, view: "summary" },
    },
    "env",
  );
  render(
    <TooltipProvider>
      <PullRequestPaneTab
        tabId="pr-tab"
        environmentId="env"
        data={{ ref: prRef, view: "summary" }}
        isActive
      />
    </TooltipProvider>,
  );

  fireEvent.click(await screen.findByRole("link", { name: "the API change" }));

  const panel = useFilesPanelStore.getState();
  expect(panel.isOpen).toBe(true);
  expect(panel.activeTab).toBe("pull-request:acme/api#7");
  expect(panel.pullRequestTabs.env?.map((tab) => tab.ref)).toEqual([
    { owner: "acme", repo: "api", number: 7 },
  ]);
  expect(usePaneLayoutStore.getState().findPaneWithTab("pr-tab", "env")?.activeTabId).toBe(
    "pr-tab",
  );
  // The main-area pull request is still the one shown.
  expect(screen.getByRole("heading", { name: "feat: add usage history tab" })).toBeTruthy();
});

test("an inaccessible recognized PR falls back to its original URL only once", async () => {
  const { openPullRequestUrl } = await import("@/lib/pull-request-opener");
  const { FilesPanelPullRequests } =
    await import("@/components/files-panel/FilesPanelPullRequests");
  const calls: string[] = [];
  installBackend({
    get_github_pull_request: () => {
      throw new Error("Repository access denied");
    },
    open_in_browser: (args) => {
      calls.push(String(args.url));
    },
  });
  const url = "https://github.com/acme/private/pull/9/files";
  await openPullRequestUrl(url);
  const { rerender } = render(
    <TooltipProvider>
      <FilesPanelPullRequests targetId="env" />
    </TooltipProvider>,
  );
  await waitFor(() => expect(calls).toEqual([url]));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByText("Repository access denied")).toBeTruthy());
  rerender(
    <TooltipProvider>
      <FilesPanelPullRequests targetId="env" />
    </TooltipProvider>,
  );
  expect(calls).toEqual([url]);
  expect(useUIStore.getState().selectedEnvironmentId).toBe("env");
});
