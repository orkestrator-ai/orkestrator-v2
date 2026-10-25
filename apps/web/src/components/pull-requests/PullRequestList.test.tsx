import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PullRequestList } from "./PullRequestList";
import {
  callsFor,
  installBackend,
  makeList,
  makeListItem,
  resetBackend,
  resetPullRequestsStore,
} from "./pull-request-test-fixtures";

beforeEach(() => {
  resetPullRequestsStore();
  installBackend({
    list_github_pull_requests: (args) =>
      makeList(
        args.filter === "closed"
          ? []
          : [
              makeListItem(3, { labels: [{ name: "bug", color: "d73a4a" }], commentsCount: 2 }),
              makeListItem(5, { isDraft: true, checksState: "failure" }),
              makeListItem(7, { title: "Environment branch" }),
            ],
        { filter: args.filter as "open" },
      ),
  });
});

afterEach(() => {
  cleanup();
  resetBackend();
});

describe("PullRequestList", () => {
  test("switching filters lists with the matching filter", async () => {
    render(<PullRequestList projectId="project-1" layout="sidebar" onOpenPullRequest={() => {}} />);
    await screen.findByText("Pull request 3");
    expect(callsFor("list_github_pull_requests")).toEqual([
      { projectId: "project-1", filter: "open" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    await waitFor(() =>
      expect(callsFor("list_github_pull_requests").at(-1)).toEqual({
        projectId: "project-1",
        filter: "mine",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review requested" }));
    await waitFor(() =>
      expect(callsFor("list_github_pull_requests").at(-1)).toEqual({
        projectId: "project-1",
        filter: "review-requested",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(await screen.findByText("No closed pull requests.")).toBeTruthy();
    expect(callsFor("list_github_pull_requests").at(-1)).toEqual({
      projectId: "project-1",
      filter: "closed",
    });
  });

  test("search is debounced and passed as the query", async () => {
    render(<PullRequestList projectId="project-1" layout="sidebar" onOpenPullRequest={() => {}} />);
    await screen.findByText("Pull request 3");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search pull requests" }), {
      target: { value: "  usage " },
    });
    expect(callsFor("list_github_pull_requests")).toHaveLength(1);
    await waitFor(() =>
      expect(callsFor("list_github_pull_requests").at(-1)).toEqual({
        projectId: "project-1",
        filter: "open",
        query: "usage",
      }),
    );
  });

  test("pins the highlighted pull request and opens rows by reference", async () => {
    const onOpen = mock(() => undefined);
    render(
      <PullRequestList
        projectId="project-1"
        layout="page"
        highlightNumber={7}
        onOpenPullRequest={onOpen}
      />,
    );
    await screen.findByText("Environment branch");
    const rows = screen.getAllByTestId("pull-request-row");
    expect(rows.map((row) => row.getAttribute("data-number"))).toEqual(["7", "3", "5"]);
    expect(rows[0]!.textContent).toContain("This environment");
    expect(rows[2]!.textContent).toContain("Draft");
    expect(rows[1]!.textContent).toContain("bug");

    fireEvent.click(rows[1]!);
    expect(onOpen).toHaveBeenCalledWith({ owner: "acme", repo: "widget", number: 3 });
  });

  test("shows errors inline with a retry", async () => {
    let fail = true;
    installBackend({
      list_github_pull_requests: () =>
        fail ? Promise.reject(new Error("GitHub could not list pull requests.")) : makeList([]),
    });
    render(<PullRequestList projectId="project-1" layout="sidebar" onOpenPullRequest={() => {}} />);
    expect(await screen.findByText("GitHub could not list pull requests.")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No open pull requests.")).toBeTruthy();
  });
});
