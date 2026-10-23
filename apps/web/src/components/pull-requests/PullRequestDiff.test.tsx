import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GitHubPullRequestReviewThread } from "@orkestrator/protocol/github-pull-requests";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";
import { PullRequestDiff, anchorThreads, commentAnchorForLine } from "./PullRequestDiff";
import {
  callsFor,
  installBackend,
  makeFile,
  makeFiles,
  prRef,
  resetBackend,
  resetPullRequestsStore,
} from "./pull-request-test-fixtures";

function thread(
  id: string,
  side: "LEFT" | "RIGHT",
  line: number | null,
  overrides: Partial<GitHubPullRequestReviewThread> = {},
): GitHubPullRequestReviewThread {
  return {
    id,
    path: "src/app.ts",
    line,
    startLine: null,
    side,
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    comments: [
      {
        id: Number(id.replace(/\D/g, "")) || 1,
        nodeId: `node-${id}`,
        body: `body of ${id}`,
        author: { login: "grace" },
        createdAt: "2026-10-22T10:00:00.000Z",
        updatedAt: "2026-10-22T10:00:00.000Z",
        htmlUrl: "https://github.com/acme/widget/pull/42#discussion",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  resetPullRequestsStore();
});

afterEach(() => {
  cleanup();
  resetBackend();
});

describe("anchorThreads", () => {
  test("anchors RIGHT threads to new lines and LEFT threads to old lines", () => {
    const file = makeFile();
    const threads = [
      thread("t1", "RIGHT", 2),
      thread("t2", "LEFT", 2),
      thread("t3", "LEFT", 3),
      thread("t4", "RIGHT", 1, { isOutdated: true }),
      thread("t5", "RIGHT", 99),
    ];
    const { byLine, unplaced } = anchorThreads(file, threads);
    // Lines: 0 context(1/1), 1 remove(old 2), 2 add(new 2), 3 context(3/3)
    expect(byLine.get("0:2")?.map((t) => t.id)).toEqual(["t1"]);
    expect(byLine.get("0:1")?.map((t) => t.id)).toEqual(["t2"]);
    expect(byLine.get("0:3")?.map((t) => t.id)).toEqual(["t3"]);
    expect(byLine.has("0:0")).toBe(false);
    expect(unplaced.map((t) => t.id)).toEqual(["t4", "t5"]);
  });

  test("new comments anchor RIGHT/newLine except on removed lines", () => {
    expect(commentAnchorForLine({ type: "add", text: "", oldLine: null, newLine: 5 })).toEqual({
      side: "RIGHT",
      line: 5,
    });
    expect(commentAnchorForLine({ type: "context", text: "", oldLine: 4, newLine: 6 })).toEqual({
      side: "RIGHT",
      line: 6,
    });
    expect(commentAnchorForLine({ type: "remove", text: "", oldLine: 7, newLine: null })).toEqual({
      side: "LEFT",
      line: 7,
    });
    expect(
      commentAnchorForLine({ type: "no-newline", text: "", oldLine: null, newLine: null }),
    ).toBeNull();
  });
});

describe("PullRequestDiff", () => {
  test("renders gutters and places threads beneath their lines", () => {
    render(
      <PullRequestDiff
        pullRequest={prRef}
        file={makeFile()}
        threads={[thread("t1", "RIGHT", 2), thread("t2", "LEFT", 1, { isOutdated: true })]}
        commitId="abc"
        canComment
      />,
    );

    const lines = screen.getAllByTestId("diff-line");
    expect(lines).toHaveLength(4);
    expect(lines[2]!.getAttribute("data-new-line")).toBe("2");
    expect(lines[2]!.textContent).toContain("new second");

    const placed = screen.getAllByTestId("diff-line-threads");
    expect(placed).toHaveLength(1);
    // The thread container directly follows the added line it anchors to.
    expect(lines[2]!.nextElementSibling).toBe(placed[0]!);
    expect(within(placed[0]!).getByText("body of t1")).toBeTruthy();

    const outdated = screen.getByTestId("diff-unplaced-threads");
    expect(within(outdated).getByText("Outdated comments")).toBeTruthy();
    expect(within(outdated).getByText("body of t2")).toBeTruthy();
  });

  test("resolved threads start collapsed", () => {
    render(
      <PullRequestDiff
        pullRequest={prRef}
        file={makeFile()}
        threads={[thread("t1", "RIGHT", 2, { isResolved: true })]}
        commitId="abc"
        canComment
      />,
    );
    expect(screen.getByText(/Resolved conversation/)).toBeTruthy();
    expect(screen.queryByText("body of t1") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Resolved conversation/ }));
    expect(screen.getByText("body of t1")).toBeTruthy();
  });

  test.each([
    ["Comment on old line 2", "LEFT", 2],
    ["Comment on new line 2", "RIGHT", 2],
    ["Comment on new line 3", "RIGHT", 3],
  ] as const)("%s posts a review comment with side %s line %d", async (label, side, line) => {
    usePullRequestsStore.setState({
      files: new Map([["acme/widget#42", makeFiles()]]),
    });
    installBackend({
      add_github_pull_request_review_comment: () => ({
        id: 900,
        nodeId: "n900",
        body: "Looks off",
        author: { login: "ada" },
        createdAt: "2026-10-23T10:00:00.000Z",
        updatedAt: "2026-10-23T10:00:00.000Z",
        htmlUrl: "",
      }),
      get_github_pull_request_files: () => makeFiles(),
    });
    render(
      <PullRequestDiff
        pullRequest={prRef}
        file={makeFile()}
        threads={[]}
        commitId="head-sha-1"
        canComment
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), {
      target: { value: "Looks off" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    await waitFor(() => expect(callsFor("add_github_pull_request_review_comment")).toHaveLength(1));
    expect(callsFor("add_github_pull_request_review_comment")[0]).toEqual({
      owner: "acme",
      repo: "widget",
      number: 42,
      commitId: "head-sha-1",
      comment: { path: "src/app.ts", line, side, body: "Looks off" },
    });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Review comment" }) === null).toBe(true),
    );
    // The files resource (threads) is re-fetched after the write.
    await waitFor(() => expect(callsFor("get_github_pull_request_files")).toHaveLength(1));
  });

  test("hides the comment affordance when commenting is not allowed", () => {
    render(
      <PullRequestDiff
        pullRequest={prRef}
        file={makeFile()}
        threads={[]}
        commitId="abc"
        canComment={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /Comment on/ }) === null).toBe(true);
  });
});
