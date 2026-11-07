import { afterEach, beforeEach, describe, expect, mock, test, spyOn } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { invoke } from "@/lib/native/backend";
import { MarkdownLink } from "@/components/chat/MessageMarkdown";
import { PullRequestOpenerProvider } from "@/lib/pull-request-opener";
import {
  COORDINATOR_PR_WATCH_REPORT_TTL_MS,
  CoordinatorPullRequestWatchProvider,
  reportCoordinatorPullRequest,
  resetCoordinatorPullRequestWatchReports,
} from "./coordinator-pull-request-watch";

const nativeInvoke = invoke as ReturnType<typeof mock>;
const PR_URL = "https://github.com/acme/app/pull/12";

function watchCalls(): unknown[] {
  return nativeInvoke.mock.calls
    .filter((call) => call[0] === "watch_coordinator_pull_request")
    .map((call) => call[1]);
}

describe("coordinator pull request watch", () => {
  beforeEach(() => {
    nativeInvoke.mockClear();
    resetCoordinatorPullRequestWatchReports();
  });
  afterEach(() => {
    resetCoordinatorPullRequestWatchReports();
    cleanup();
  });

  test("a pull request link rendered in a coordinator is reported once, and again when opened", () => {
    const open = mock(() => true);
    const { rerender } = renderInAppCommandScope(
      <PullRequestOpenerProvider open={open}>
        <CoordinatorPullRequestWatchProvider projectId="project-a">
          <MarkdownLink href={PR_URL}>#12</MarkdownLink>
          <MarkdownLink href="https://example.com/docs">docs</MarkdownLink>
        </CoordinatorPullRequestWatchProvider>
      </PullRequestOpenerProvider>,
    );
    expect(watchCalls()).toEqual([
      { projectId: "project-a", owner: "acme", repo: "app", number: 12, source: "rendered" },
    ]);

    // Re-rendering (a virtualized row coming back, streaming) does not report again.
    rerender(
      <PullRequestOpenerProvider open={open}>
        <CoordinatorPullRequestWatchProvider projectId="project-a">
          <MarkdownLink href={`${PR_URL}/files`}>#12 files</MarkdownLink>
        </CoordinatorPullRequestWatchProvider>
      </PullRequestOpenerProvider>,
    );
    expect(watchCalls()).toHaveLength(1);

    fireEvent.click(screen.getByText("#12 files"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(watchCalls()).toEqual([
      { projectId: "project-a", owner: "acme", repo: "app", number: 12, source: "rendered" },
      { projectId: "project-a", owner: "acme", repo: "app", number: 12, source: "opened" },
    ]);
  });

  test("links outside a coordinator are not reported", () => {
    renderInAppCommandScope(<MarkdownLink href={PR_URL}>#12</MarkdownLink>);
    expect(watchCalls()).toEqual([]);
  });

  test("a rendered report is repeated only after the window", async () => {
    const ref = { owner: "acme", repo: "app", number: 3 };
    reportCoordinatorPullRequest("project-a", ref, "rendered", 0);
    reportCoordinatorPullRequest("project-a", ref, "rendered", 1_000);
    // Another project is another watch.
    reportCoordinatorPullRequest("project-b", ref, "rendered", 1_000);
    expect(watchCalls()).toHaveLength(2);
    await waitFor(() => expect(watchCalls()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    reportCoordinatorPullRequest(
      "project-a",
      ref,
      "rendered",
      COORDINATOR_PR_WATCH_REPORT_TTL_MS + 100,
    );
    expect(watchCalls()).toHaveLength(3);
  });
});

test("a failed mounted report retries and a failed remounted report is not cached", async () => {
  resetCoordinatorPullRequestWatchReports();
  nativeInvoke.mockClear();
  const timers: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    if (delay === 5_000) {
      timers.push(callback);
      return 1;
    }
    return realSetTimeout(callback, delay);
  }) as typeof setTimeout);
  try {
    nativeInvoke.mockRejectedValueOnce(new Error("offline"));
    const view = renderInAppCommandScope(
      <CoordinatorPullRequestWatchProvider projectId="retry-project">
        <MarkdownLink href={PR_URL}>retry</MarkdownLink>
      </CoordinatorPullRequestWatchProvider>,
    );
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    expect(watchCalls()).toHaveLength(2);
    view.unmount();
    resetCoordinatorPullRequestWatchReports();
    nativeInvoke.mockRejectedValueOnce(new Error("offline"));
    const mountAgain = () =>
      renderInAppCommandScope(
        <CoordinatorPullRequestWatchProvider projectId="remount">
          <MarkdownLink href={PR_URL}>remounted</MarkdownLink>
        </CoordinatorPullRequestWatchProvider>,
      );
    const failed = mountAgain();
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    expect(timers).toHaveLength(1);
    failed.unmount();
    mountAgain();
    // The remounted link shares the outstanding retry rather than caching failure.
    expect(watchCalls()).toHaveLength(3);
    timers.shift()!();
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    expect(watchCalls()).toHaveLength(4);
  } finally {
    timer.mockRestore();
    resetCoordinatorPullRequestWatchReports();
    cleanup();
  }
});
