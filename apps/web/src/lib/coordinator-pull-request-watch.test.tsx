import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    cleanup();
  });

  test("a pull request link rendered in a coordinator is reported once, and again when opened", () => {
    const open = mock(() => true);
    const { rerender } = render(
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
    render(<MarkdownLink href={PR_URL}>#12</MarkdownLink>);
    expect(watchCalls()).toEqual([]);
  });

  test("a rendered report is repeated only after the window", () => {
    const ref = { owner: "acme", repo: "app", number: 3 };
    reportCoordinatorPullRequest("project-a", ref, "rendered", 0);
    reportCoordinatorPullRequest("project-a", ref, "rendered", 1_000);
    // Another project is another watch.
    reportCoordinatorPullRequest("project-b", ref, "rendered", 1_000);
    expect(watchCalls()).toHaveLength(2);
    reportCoordinatorPullRequest("project-a", ref, "rendered", COORDINATOR_PR_WATCH_REPORT_TTL_MS);
    expect(watchCalls()).toHaveLength(3);
  });
});
