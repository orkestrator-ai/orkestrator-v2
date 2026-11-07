import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installBackend,
  makeDetail,
  makeFiles,
  prRef,
  resetBackend,
  resetPullRequestsStore,
} from "@/components/pull-requests/pull-request-test-fixtures";
import { uiStore } from "@/stores/uiStore";
import { PullRequestPaneTab } from "./PullRequestPaneTab";
import { filesPanelTestState, setFilesPanelTestState } from "@/test/files-panel-state";
import { appCommandStore } from "@/test/app-command-store";

beforeEach(() => {
  resetPullRequestsStore();
  setFilesPanelTestState({ isOpen: false, activeTab: "changes", pullRequestTabs: {} });
  appCommandStore(uiStore).setState({ selectedProjectId: "project", selectedEnvironmentId: "env" });
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
  appCommandStore(uiStore).setState({ selectedProjectId: null, selectedEnvironmentId: null });
});

test("a pull request linked from a main-area pull request opens in the right-hand PR pane", async () => {
  const layout = appCommandStore(paneLayoutStore).getState();
  layout.initialize(null, "env");
  const owner = appCommandStore(paneLayoutStore).getState().environments.get("env")!;
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
  renderInAppCommandScope(
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

  const panel = filesPanelTestState();
  expect(panel.isOpen).toBe(true);
  expect(panel.activeTab).toBe("pull-request:acme/api#7");
  expect(panel.pullRequestTabs.env?.map((tab) => tab.ref)).toEqual([
    { owner: "acme", repo: "api", number: 7 },
  ]);
  expect(
    appCommandStore(paneLayoutStore).getState().findPaneWithTab("pr-tab", "env")?.activeTabId,
  ).toBe("pr-tab");
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
  const { rerender } = renderInAppCommandScope(
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
  expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env");
});

test("reopening after failure waits for the pending new load and preserves a terminal deep link", async () => {
  const { act } = await import("@testing-library/react");
  const { createTerminalLinkActivator } = await import("@/lib/terminal-links");
  const { openPullRequestUrl } = await import("@/lib/pull-request-opener");
  const { FilesPanelPullRequests } =
    await import("@/components/files-panel/FilesPanelPullRequests");
  const calls: string[] = [];
  installBackend({
    get_github_pull_request: () => {
      throw new Error("Denied");
    },
    open_in_browser: (args) => {
      calls.push(String(args.url));
    },
  });
  const url = "https://github.com/acme/widget/pull/42/files?view=split#diff-123";
  createTerminalLinkActivator({
    environmentId: "env",
    sourceTabId: "terminal",
    openExternal: async () => {},
  })({ button: 0, ctrlKey: true, shiftKey: false, metaKey: false } as MouseEvent, url);
  renderInAppCommandScope(
    <TooltipProvider>
      <FilesPanelPullRequests targetId="env" />
    </TooltipProvider>,
  );
  await waitFor(() => expect(calls).toEqual([url]));
  let resolve!: (detail: ReturnType<typeof makeDetail>) => void;
  installBackend({
    get_github_pull_request: () =>
      new Promise((done) => {
        resolve = done;
      }),
    open_in_browser: (args) => {
      calls.push(String(args.url));
    },
    get_github_pull_request_files: () => makeFiles(),
  });
  await act(async () => {
    await openPullRequestUrl(url);
  });
  await waitFor(() => expect(resolve).toBeDefined());
  expect(calls).toEqual([url]);
  await act(async () => {
    resolve(makeDetail());
  });
  expect(await screen.findByRole("heading", { name: "feat: add usage history tab" })).toBeTruthy();
  expect(calls).toEqual([url]);
});
