import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GitHubPullRequestDetail } from "@orkestrator/protocol/github-pull-requests";
import { useUIStore } from "@/stores/uiStore";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";
import { mockToastSuccess } from "../../../../../tests/mocks/sonner";
import { PullRequestView } from "./PullRequestView";
import { mergeBlockedReason, mergeWarning } from "./pull-request-format";
import {
  callsFor,
  installBackend,
  makeDetail,
  makeFiles,
  prRef,
  resetBackend,
  resetPullRequestsStore,
} from "./pull-request-test-fixtures";

function renderView(detail: GitHubPullRequestDetail, props: { onSummaryLoaded?: () => void } = {}) {
  installBackend({
    get_github_pull_request: () => detail,
    get_github_pull_request_timeline: () => ({ ref: prRef, items: [], truncated: false }),
    get_github_pull_request_files: () => makeFiles(),
    merge_github_pull_request: () => ({
      merged: true,
      sha: "merged-sha",
      branchDeleted: !detail.isCrossRepository,
    }),
  });
  return render(
    <PullRequestView
      pullRequest={prRef}
      layout="sidebar"
      headerActions={<button type="button">Host action</button>}
      {...props}
    />,
  );
}

beforeEach(() => {
  resetPullRequestsStore();
});

afterEach(() => {
  cleanup();
  resetBackend();
});

describe("PullRequestView", () => {
  test("renders the summary header, metadata and comments", async () => {
    const onSummaryLoaded = mock(() => undefined);
    renderView(makeDetail(), { onSummaryLoaded });

    expect(await screen.findByText("feat: add usage history tab")).toBeTruthy();
    expect(screen.getByText("acme/widget")).toBeTruthy();
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByTestId("pull-request-state-badge").textContent).toBe("Open");
    expect(screen.getByText("gh pr checkout 42 --repo acme/widget")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("feature/usage")).toBeTruthy();
    expect(screen.getByText("56 files")).toBeTruthy();
    expect(screen.getByText("+3,831")).toBeTruthy();
    expect(screen.getByText("Host action")).toBeTruthy();
    expect(screen.getByTestId("checks-summary").textContent).toBe("1 failing");

    const reviewers = screen.getAllByTestId("pull-request-reviewer");
    expect(reviewers.map((item) => item.getAttribute("title"))).toEqual([
      "grace: approved",
      "linus: review requested",
    ]);
    expect(screen.getByText("enhancement")).toBeTruthy();
    expect(screen.getByText("usage")).toBeTruthy(); // markdown body rendered
    expect(screen.getByText("Comments (1)")).toBeTruthy();
    expect(screen.getByText("This is great.")).toBeTruthy();
    expect(onSummaryLoaded).toHaveBeenCalledWith({
      title: "feat: add usage history tab",
      state: "open",
      isDraft: false,
    });
    // Timeline and files are lazy.
    expect(callsFor("get_github_pull_request_timeline")).toHaveLength(0);
    expect(callsFor("get_github_pull_request_files")).toHaveLength(0);
  });

  test("loads the timeline and files only when their tabs open", async () => {
    renderView(makeDetail());
    await screen.findByText("feat: add usage history tab");

    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    await waitFor(() => expect(callsFor("get_github_pull_request_timeline")).toHaveLength(1));
    expect(await screen.findByText("No activity yet.")).toBeTruthy();
    expect(callsFor("get_github_pull_request_files")).toHaveLength(0);

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(callsFor("get_github_pull_request_files")).toHaveLength(1));
    expect(await screen.findByText("0 / 1 viewed")).toBeTruthy();
  });

  test("shows an inline credential hint and retries a failed load", async () => {
    let fail = true;
    installBackend({
      get_github_pull_request: () =>
        fail
          ? Promise.reject(new Error("GitHub authentication failed. Check the GitHub credentials."))
          : makeDetail(),
    });
    render(<PullRequestView pullRequest={prRef} layout="page" />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Settings → Version control/)).toBeTruthy();
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("feat: add usage history tab")).toBeTruthy();
  });

  test.each([
    [{ mergeability: "dirty" } as const, /conflicts/],
    [{ mergeability: "behind" } as const, /out of date/],
    [{ mergeability: "blocked" } as const, /required reviews or status checks/],
    [{ mergeability: "unknown" } as const, /still checking/],
    [{ isDraft: true, mergeability: "unavailable" } as const, /Draft pull requests/],
    [
      { viewerPermissions: { canWrite: true, canMerge: false, isAuthor: false } },
      /permission to merge/,
    ],
  ])("disables Merge with a reason (%o)", async (overrides, reason) => {
    renderView(makeDetail(overrides));
    await screen.findByText("feat: add usage history tab");
    const merge = screen.getByRole("button", { name: "Merge" });
    expect(merge.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("merge-reason").textContent).toMatch(reason);
  });

  test("an unstable branch can still merge, with a warning", async () => {
    renderView(makeDetail({ mergeability: "unstable" }));
    await screen.findByText("feat: add usage history tab");
    const merge = screen.getByRole("button", { name: "Merge" });
    expect(merge.hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("merge-reason").textContent).toMatch(/failing or still running/);
  });

  test("merging confirms the method and pins the head sha", async () => {
    renderView(makeDetail());
    await screen.findByText("feat: add usage history tab");
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/will be deleted after merging/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Squash and merge" }));
    await waitFor(() => expect(callsFor("merge_github_pull_request")).toHaveLength(1));
    expect(callsFor("merge_github_pull_request")[0]).toEqual({
      owner: "acme",
      repo: "widget",
      number: 42,
      method: "squash",
      deleteBranch: true,
      expectedHeadSha: "abc1234def5678",
    });
  });

  test("hides the Merge button once the pull request is merged", async () => {
    renderView(makeDetail({ state: "merged", mergeability: "unavailable" }));
    await screen.findByText("feat: add usage history tab");
    expect(screen.queryByRole("button", { name: "Merge" }) === null).toBe(true);
    expect(screen.getByTestId("pull-request-state-badge").textContent).toBe("Merged");
  });

  test("authors can only comment in a review", async () => {
    renderView(
      makeDetail({ viewerPermissions: { canWrite: true, canMerge: true, isAuthor: true } }),
    );
    await screen.findByText("feat: add usage history tab");
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Approve" }) === null).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Request changes" }) === null).toBe(true);
    expect(within(dialog).getByText(/you can only comment/)).toBeTruthy();
  });
});

describe("merge rules", () => {
  test("clean branches merge without a warning", () => {
    expect(mergeBlockedReason(makeDetail())).toBeNull();
    expect(mergeWarning(makeDetail())).toBeNull();
  });

  test("a repository without merge methods blocks merging", () => {
    expect(mergeBlockedReason(makeDetail({ allowedMergeMethods: [] }))).toMatch(/merge method/);
  });
});

test("fork merges keep the head branch and never report skipped deletion as a failure", async () => {
  mockToastSuccess.mockClear();
  renderView(makeDetail({ isCrossRepository: true, headRepositoryFullName: "fork/widget" }));
  await screen.findByText("feat: add usage history tab");
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("The head branch will be kept.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Squash and merge" }));
  await waitFor(() => expect(callsFor("merge_github_pull_request")).toHaveLength(1));
  expect(callsFor("merge_github_pull_request")[0]).toMatchObject({ deleteBranch: false });
  expect(JSON.stringify(mockToastSuccess.mock.calls)).not.toContain("could not be deleted");
});

test("both checkout actions copy the viewed repository regardless of project selection", async () => {
  mockWriteText.mockClear();
  useUIStore.setState({ selectedProjectId: "unrelated-project" });
  renderView(makeDetail());
  const command = "gh pr checkout 42 --repo acme/widget";
  fireEvent.click(await screen.findByTitle("Copy checkout command"));
  await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(command));
  mockWriteText.mockClear();
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
    ctrlKey: false,
  });
  const item = await screen.findByRole("menuitem", { name: `Copy ${command}` });
  fireEvent.click(item);
  await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(command));
});

test("a capped summary clearly identifies missing newer comments and links to the full conversation", async () => {
  renderView(makeDetail({ commentsTruncated: true }));
  expect(await screen.findByText(/Newer comments are omitted/)).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Read the full conversation on GitHub" }).getAttribute("href"),
  ).toBe("https://github.com/acme/widget/pull/42");
});

test("the label picker sends one change from a stale detail without replacing other labels", async () => {
  let detail = makeDetail();
  installBackend({
    get_github_pull_request: () => detail,
    list_github_repository_labels: () => [{ name: "bug", color: "ff0000" }],
    change_github_pull_request_label: () => {
      detail = makeDetail({
        labels: [
          { name: "externally-added", color: "aaaaaa" },
          { name: "bug", color: "ff0000" },
        ],
      });
      return detail.labels;
    },
  });
  render(<PullRequestView pullRequest={prRef} layout="page" />);
  await screen.findByText("feat: add usage history tab");
  fireEvent.pointerDown(screen.getByRole("button", { name: "Edit labels" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "bug" }));
  await waitFor(() => expect(callsFor("change_github_pull_request_label")).toHaveLength(1));
  expect(callsFor("change_github_pull_request_label")[0]).toEqual({
    ...prRef,
    name: "bug",
    present: true,
  });
  expect(callsFor("set_github_pull_request_labels")).toHaveLength(0);
  expect(await screen.findByText("externally-added")).toBeTruthy();
});
