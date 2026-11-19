import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { GitHubPullRequestFilePatch } from "@orkestrator/protocol/github-pull-requests";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { pullRequestsStore, usePullRequestsStore } from "@/stores/pullRequestsStore";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { AUTO_EXPAND_FILE_LIMIT, PullRequestCodeTab } from "./PullRequestCodeTab";
import {
  callsFor,
  deferred,
  installBackend,
  makeFile,
  makeFiles,
  makeThread,
  prRef,
  resetBackend,
  resetPullRequestsStore,
} from "./pull-request-test-fixtures";
import { appCommandStore } from "@/test/app-command-store";

const key = "acme/widget#42";

function ConnectedCodeTab() {
  const files = usePullRequestsStore((state) => state.files.get(key));
  return files ? <PullRequestCodeTab pullRequest={prRef} files={files} canComment /> : null;
}

const originalScrollIntoView = Element.prototype.scrollIntoView;
let scrolledTo: string[] = [];

beforeEach(() => {
  resetPullRequestsStore();
  scrolledTo = [];
  Element.prototype.scrollIntoView = mock(function (this: HTMLElement) {
    scrolledTo.push(this.dataset.threadId ?? this.dataset.path ?? "?");
  });
});

afterEach(() => {
  cleanup();
  resetBackend();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

const HEAD = "a".repeat(40);

function deferredFile(path: string) {
  return makeFile({ path, patchAvailable: false, patchDeferred: true, hunks: [] });
}

function loadedPatch(path: string): GitHubPullRequestFilePatch {
  return {
    ref: prRef,
    path,
    headSha: HEAD,
    outcome: "loaded",
    patchAvailable: true,
    hunks: makeFile().hunks,
  };
}

function seed(files: ReturnType<typeof makeFiles>) {
  appCommandStore(pullRequestsStore).setState({ files: new Map([[key, files]]) });
}

/** A pull request too large to auto-expand, with one deeply nested file. */
function largePullRequest(overrides: Partial<ReturnType<typeof makeFiles>> = {}) {
  const filler = Array.from({ length: AUTO_EXPAND_FILE_LIMIT + 5 }, (_, index) =>
    makeFile({ path: `src/filler/file-${index}.ts` }),
  );
  return makeFiles({
    headSha: HEAD,
    files: [...filler, deferredFile("apps/web/src/components/deep/nested/Target.tsx")],
    ...overrides,
  });
}

describe("PullRequestCodeTab", () => {
  test("viewed checkbox is optimistic, collapses the file and reverts on failure", async () => {
    appCommandStore(pullRequestsStore).setState({ files: new Map([[key, makeFiles()]]) });
    const pending = deferred<never>();
    installBackend({
      set_github_pull_request_file_viewed: () => pending.promise,
      get_github_pull_request_files: () => makeFiles(),
    });
    renderInAppCommandScope(<ConnectedCodeTab />);

    expect(screen.getByTestId("pull-request-diff")).toBeTruthy();
    const checkbox = screen.getByRole("checkbox", { name: "Viewed src/app.ts" });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("viewed-count").textContent).toBe("1 / 1 viewed");
    expect(screen.queryByTestId("pull-request-diff") === null).toBe(true);
    expect(callsFor("set_github_pull_request_file_viewed")).toEqual([
      { owner: "acme", repo: "widget", number: 42, path: "src/app.ts", viewed: true },
    ]);

    await act(async () => {
      pending.reject(new Error("GitHub said no"));
      await pending.promise.catch(() => undefined);
    });
    await waitFor(() => expect(checkbox.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByTestId("viewed-count").textContent).toBe("0 / 1 viewed");
    expect(mockToastError).toHaveBeenCalledWith("GitHub said no");
  });

  test("files without a patch link to GitHub instead of a diff", () => {
    appCommandStore(pullRequestsStore).setState({
      files: new Map([
        [key, makeFiles({ files: [makeFile({ patchAvailable: false, hunks: [] })] })],
      ]),
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    expect(screen.getByText(/Diff not available here/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /View on GitHub/ })).toBeTruthy();
  });

  test("large pull requests start with every file collapsed", () => {
    const many = Array.from({ length: AUTO_EXPAND_FILE_LIMIT + 1 }, (_, index) =>
      makeFile({ path: `src/file-${index}.ts` }),
    );
    appCommandStore(pullRequestsStore).setState({
      files: new Map([[key, makeFiles({ files: many })]]),
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    expect(screen.queryByTestId("pull-request-diff") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand all files" }));
    expect(screen.getAllByTestId("pull-request-diff")).toHaveLength(many.length);
  });

  test("selecting a deeply nested file in the tree opens it and loads only its patch", async () => {
    seed(largePullRequest());
    const patch = deferred<GitHubPullRequestFilePatch>();
    installBackend({ get_github_pull_request_file_patch: () => patch.promise });
    renderInAppCommandScope(<ConnectedCodeTab />);

    fireEvent.click(screen.getByRole("button", { name: "Show file tree" }));
    const tree = screen.getByRole("navigation", { name: "Changed files" });
    const target = "apps/web/src/components/deep/nested/Target.tsx";
    // The single-child chain is one row.
    expect(within(tree).getByText("apps/web/src/components/deep/nested")).toBeTruthy();
    fireEvent.click(within(tree).getByRole("button", { name: /Target\.tsx/ }));

    await waitFor(() => expect(screen.getByTestId("file-patch-loading")).toBeTruthy());
    expect(callsFor("get_github_pull_request_file_patch")).toEqual([
      {
        owner: "acme",
        repo: "widget",
        number: 42,
        path: target,
        headSha: HEAD,
        index: AUTO_EXPAND_FILE_LIMIT + 5,
      },
    ]);
    expect(callsFor("get_github_pull_request_files")).toHaveLength(0);
    expect(scrolledTo).toEqual([target]);
    expect(
      within(tree)
        .getByRole("button", { name: /Target\.tsx/ })
        .getAttribute("aria-current"),
    ).toBe("true");

    await act(async () => {
      patch.resolve(loadedPatch(target));
      await patch.promise;
    });
    await waitFor(() => expect(screen.getAllByTestId("pull-request-diff")).toHaveLength(1));
  });

  test("a failed file patch keeps its own error and retries on request", async () => {
    seed(largePullRequest());
    let fail = true;
    installBackend({
      get_github_pull_request_file_patch: (args) => {
        if (fail) throw new Error("GitHub rate limit");
        return loadedPatch(String(args.path));
      },
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    const target = "apps/web/src/components/deep/nested/Target.tsx";
    fireEvent.click(screen.getByRole("button", { name: `Expand ${target}` }));

    await waitFor(() => expect(screen.getByTestId("file-patch-error")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("GitHub rate limit");
    // The failure does not retry by itself.
    expect(callsFor("get_github_pull_request_file_patch")).toHaveLength(1);

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("pull-request-diff")).toBeTruthy());
    expect(callsFor("get_github_pull_request_file_patch")).toHaveLength(2);
  });

  test("expand all does not fetch deferred patches; each loads on request", async () => {
    seed(largePullRequest());
    installBackend({
      get_github_pull_request_file_patch: (args) => loadedPatch(String(args.path)),
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    fireEvent.click(screen.getByRole("button", { name: "Expand all files" }));
    expect(screen.getByTestId("file-patch-deferred")).toBeTruthy();
    expect(callsFor("get_github_pull_request_file_patch")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("pull-request-diff")).toHaveLength(AUTO_EXPAND_FILE_LIMIT + 6),
    );
  });

  test("a moved head reloads the file list instead of caching the patch", async () => {
    seed(largePullRequest());
    installBackend({
      // GitHub keeps moving: every read answers that the head moved on.
      get_github_pull_request_file_patch: (args) => ({
        ...loadedPatch(String(args.path)),
        headSha: "c".repeat(40),
        outcome: "head-moved",
        patchAvailable: false,
        hunks: [],
      }),
      get_github_pull_request_files: () => largePullRequest({ headSha: "b".repeat(40) }),
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand apps/web/src/components/deep/nested/Target.tsx",
      }),
    );
    await waitFor(() => expect(callsFor("get_github_pull_request_files")).toHaveLength(1));
    // The file stays open and asks again at the new head.
    await waitFor(() => expect(callsFor("get_github_pull_request_file_patch")).toHaveLength(2));
    expect(callsFor("get_github_pull_request_file_patch")[1]?.headSha).toBe("b".repeat(40));
    // Once per head, never in a loop: the second answer stays as that head's error.
    // The second head-moved reloads the list once more, which answers the
    // same head; once everything has settled nothing asks again.
    await waitFor(() => expect(callsFor("get_github_pull_request_files")).toHaveLength(2));
    await waitFor(() => expect(appCommandStore(pullRequestsStore).getState().loading.size).toBe(0));
    await act(async () => {});
    expect(screen.getByTestId("file-patch-error")).toBeTruthy();
    expect(callsFor("get_github_pull_request_file_patch")).toHaveLength(2);
    expect(appCommandStore(pullRequestsStore).getState().filePatches.size).toBe(0);
  });

  test("search and filters narrow the list and say how many files they hide", () => {
    seed(
      makeFiles({
        files: [
          makeFile({ path: "src/a.ts", viewedState: "viewed" }),
          makeFile({ path: "src/b.ts" }),
          makeFile({ path: "docs/c.md" }),
        ],
        threads: [makeThread({ id: "t1", path: "docs/c.md" })],
      }),
    );
    renderInAppCommandScope(<ConnectedCodeTab />);
    const shown = () =>
      screen.getAllByTestId("pull-request-file").map((section) => section.dataset.path);
    expect(shown()).toEqual(["docs/c.md", "src/a.ts", "src/b.ts"]);

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files by path" }), {
      target: { value: "src" },
    });
    expect(shown()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(screen.getByTestId("file-filter-summary").textContent).toContain(
      "Showing 2 of 3 files · 1 hidden",
    );

    fireEvent.click(screen.getByRole("button", { name: "Only unviewed files" }));
    expect(shown()).toEqual(["src/b.ts"]);
    expect(screen.getByTestId("file-filter-summary").textContent).toContain("2 hidden");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Only files with unresolved conversations" }),
    );
    expect(shown()).toEqual(["docs/c.md"]);
    // The viewed count always covers the whole pull request.
    expect(screen.getByTestId("viewed-count").textContent).toBe("1 / 3 viewed");
  });

  test("next unviewed walks shown files in order and skips viewed ones", () => {
    seed(
      makeFiles({
        files: [
          makeFile({ path: "a.ts" }),
          makeFile({ path: "b.ts", viewedState: "viewed" }),
          makeFile({ path: "c.ts" }),
        ],
      }),
    );
    renderInAppCommandScope(<ConnectedCodeTab />);
    const next = screen.getByRole("button", { name: "Next unviewed" });
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(scrolledTo).toEqual(["a.ts", "c.ts", "a.ts"]);
  });

  test("next unresolved jumps to each open conversation, waiting for a deferred patch", async () => {
    const target = "apps/web/src/components/deep/nested/Target.tsx";
    seed(
      largePullRequest({
        threads: [
          makeThread({ id: "resolved", path: "src/filler/file-0.ts", isResolved: true }),
          makeThread({ id: "first", path: "src/filler/file-3.ts" }),
          makeThread({ id: "deep", path: target }),
        ],
      }),
    );
    const patch = deferred<GitHubPullRequestFilePatch>();
    installBackend({ get_github_pull_request_file_patch: () => patch.promise });
    renderInAppCommandScope(<ConnectedCodeTab />);
    const next = screen.getByRole("button", { name: "Next unresolved conversation" });
    expect(screen.getByTestId("unresolved-position").textContent).toBe("2");

    // Tree order: the nested `apps/` file comes before `src/`. Its patch is
    // deferred, so the jump waits for it rather than landing early.
    fireEvent.click(next);
    await waitFor(() => expect(screen.getByTestId("file-patch-loading")).toBeTruthy());
    expect(scrolledTo).toEqual([]);
    await act(async () => {
      patch.resolve(loadedPatch(target));
      await patch.promise;
    });
    await waitFor(() => expect(scrolledTo).toEqual(["deep"]));
    expect(screen.getByTestId("unresolved-position").textContent).toBe("1/2");
    expect(document.activeElement?.getAttribute("data-thread-id")).toBe("deep");

    fireEvent.click(next);
    await waitFor(() => expect(scrolledTo).toEqual(["deep", "first"]));
    expect(screen.getByTestId("unresolved-position").textContent).toBe("2/2");
    expect(document.activeElement?.getAttribute("data-thread-id")).toBe("first");

    // Wraps to the start.
    fireEvent.click(next);
    await waitFor(() => expect(scrolledTo).toEqual(["deep", "first", "deep"]));
  });

  test("conversations on a file without a diff are still shown", () => {
    seed(
      makeFiles({
        files: [makeFile({ patchAvailable: false, hunks: [] })],
        threads: [makeThread({ id: "t1" })],
      }),
    );
    renderInAppCommandScope(<ConnectedCodeTab />);
    expect(
      within(screen.getByTestId("file-threads-without-diff")).getByText("body of t1"),
    ).toBeTruthy();
  });
});
