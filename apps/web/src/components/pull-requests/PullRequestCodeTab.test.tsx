import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { GitHubPullRequestFilePatch } from "@orkestrator/protocol/github-pull-requests";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import {
  MAX_CACHED_FILE_PATCHES,
  MAX_CACHED_FILE_PATCH_ROWS,
  pullRequestsStore,
  usePullRequestsStore,
} from "@/stores/pullRequestsStore";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { AUTO_EXPAND_FILE_LIMIT, PullRequestCodeTab } from "./PullRequestCodeTab";
import {
  callsFor,
  comparisonBase,
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
    comparisonBase,
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
        comparisonBase,
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

  test("Load diff after Expand all follows the next head and stops if the comparison cannot recover", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Expand all files" }));
    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    await waitFor(() => expect(callsFor("get_github_pull_request_files")).toHaveLength(1));
    // The file stays open and asks again at the new head.
    await waitFor(() => expect(callsFor("get_github_pull_request_file_patch")).toHaveLength(2));
    expect(callsFor("get_github_pull_request_file_patch")[1]?.headSha).toBe("b".repeat(40));
    // The second refresh returns the unchanged comparison, so Retry is offered.
    await waitFor(() => expect(callsFor("get_github_pull_request_files")).toHaveLength(2));
    await waitFor(() => expect(appCommandStore(pullRequestsStore).getState().loading.size).toBe(0));
    await act(async () => {});
    expect(screen.getByTestId("file-patch-error")).toBeTruthy();
    expect(callsFor("get_github_pull_request_file_patch")).toHaveLength(2);
    expect(appCommandStore(pullRequestsStore).getState().filePatches.size).toBe(0);
  });

  test("parallel moved replies refresh once and reload both requested files at the new base", async () => {
    const paths = ["first.ts", "second.ts"];
    const files = paths.map(deferredFile);
    const nextBase = { ref: "release", sha: "e".repeat(40) };
    const pending = deferred<ReturnType<typeof makeFiles>>();
    seed(makeFiles({ headSha: HEAD, files }));
    installBackend({
      get_github_pull_request_file_patch: ({ path, comparisonBase: base }) => {
        const patch = { ...loadedPatch(String(path)), comparisonBase: nextBase };
        return (base as typeof nextBase).ref === nextBase.ref
          ? patch
          : { ...patch, outcome: "head-moved", patchAvailable: false, hunks: [] };
      },
      get_github_pull_request_files: () => pending.promise,
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    const buttons = screen.getAllByRole("button", { name: "Load diff" });
    await act(async () => {
      for (const button of buttons) fireEvent.click(button);
    });
    expect(screen.getAllByTestId("file-patch-loading")).toHaveLength(2);
    expect(screen.queryAllByTestId("file-patch-error")).toHaveLength(0);
    expect(callsFor("get_github_pull_request_files")).toHaveLength(1);
    await act(async () =>
      pending.resolve(makeFiles({ headSha: HEAD, files, comparisonBase: nextBase })),
    );
    expect(screen.getAllByTestId("pull-request-diff")).toHaveLength(2);
    expect(callsFor("get_github_pull_request_file_patch").slice(2)).toMatchObject([
      { path: paths[0], headSha: HEAD, comparisonBase: nextBase },
      { path: paths[1], headSha: HEAD, comparisonBase: nextBase },
    ]);
    expect(callsFor("get_github_pull_request_files")).toHaveLength(1);
  });

  test("an older list without a base still shows the GitHub fallback", () => {
    const path = "src/app.ts";
    seed(
      makeFiles({
        comparisonBase: undefined,
        files: [deferredFile(path)],
        threads: [makeThread({ id: "older" })],
      }),
    );
    installBackend({});
    renderInAppCommandScope(<ConnectedCodeTab />);
    fireEvent.click(screen.getByRole("button", { name: "Next unresolved conversation" }));
    expect(screen.getByRole("button", { name: "View on GitHub" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("review-thread"));
    expect(callsFor("get_github_pull_request_file_patch")).toHaveLength(0);
  });

  test("opening more deferred diffs than the cache holds settles without refetching", async () => {
    const paths = Array.from(
      { length: MAX_CACHED_FILE_PATCHES + 1 },
      (_, index) => `file-${index}.ts`,
    );
    seed(makeFiles({ headSha: HEAD, files: paths.map(deferredFile) }));
    let allowLoads = paths.length + 1;
    installBackend({
      get_github_pull_request_file_patch: ({ path }) => {
        if (allowLoads-- <= 0) throw new Error("Unexpected automatic reload");
        return loadedPatch(String(path));
      },
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    for (const path of paths) {
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: `Expand ${path}` })),
      );
    }

    expect(callsFor("get_github_pull_request_file_patch").map((call) => call.path)).toEqual(paths);
    expect(screen.getAllByTestId("pull-request-diff")).toHaveLength(MAX_CACHED_FILE_PATCHES);
    const evicted = screen.getByTestId("file-patch-deferred");
    await act(async () =>
      fireEvent.click(within(evicted).getByRole("button", { name: "Load diff" })),
    );
    expect(callsFor("get_github_pull_request_file_patch").map((call) => call.path)).toEqual([
      ...paths,
      paths[0],
    ]);
    expect(screen.getAllByTestId("pull-request-diff")).toHaveLength(MAX_CACHED_FILE_PATCHES);
  });

  test("row-budget eviction does not reload an expanded deferred file", async () => {
    const path = "src/app.ts";
    const otherPull = { ...prRef, number: 43 };
    seed(makeFiles({ headSha: HEAD, files: [deferredFile(path)] }));
    const filler = loadedPatch("filler.ts");
    const rows = MAX_CACHED_FILE_PATCH_ROWS / 6;
    filler.hunks = [
      {
        header: "@@ -0,0 +1,10000 @@",
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: rows,
        lines: Array.from({ length: rows }, (_, index) => ({
          type: "add",
          text: "filler",
          oldLine: null,
          newLine: index + 1,
        })),
      },
    ];
    installBackend({
      get_github_pull_request_file_patch: (args) =>
        args.number === otherPull.number
          ? { ...filler, ref: otherPull, path: String(args.path) }
          : loadedPatch(path),
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    await screen.findByTestId("pull-request-diff");

    await act(async () => {
      const { loadFilePatch } = appCommandStore(pullRequestsStore).getState();
      for (let index = 0; index < 6; index++) {
        await loadFilePatch(otherPull, {
          path: `other-${index}.ts`,
          headSha: HEAD,
          comparisonBase,
        });
      }
    });
    expect(screen.getByTestId("file-patch-deferred")).toBeTruthy();
    expect(
      callsFor("get_github_pull_request_file_patch").filter((args) => args.number === prRef.number),
    ).toHaveLength(1);
  });

  test("embedded hunks take precedence when the next list includes a deferred file's diff", async () => {
    const path = "src/app.ts";
    seed(makeFiles({ headSha: HEAD, files: [deferredFile(path)] }));
    const embedded = makeFile();
    const firstHunk = embedded.hunks[0]!;
    embedded.hunks = [
      { ...firstHunk, lines: [{ type: "add", text: "embedded patch", oldLine: null, newLine: 1 }] },
    ];
    installBackend({
      get_github_pull_request_file_patch: () => loadedPatch(path),
      get_github_pull_request_files: () => makeFiles({ headSha: HEAD, files: [embedded] }),
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    await screen.findByText("new second");
    await act(async () => appCommandStore(pullRequestsStore).getState().loadFiles(prRef));
    expect(screen.getByText("embedded patch")).toBeTruthy();
    expect(screen.queryByText("new second") === null).toBe(true);
  });

  test("keeps captured inline coordinates and text across a deferred refresh", async () => {
    const path = "src/app.ts";
    const files = [deferredFile(path)];
    const nextHead = "b".repeat(40);
    const replacement = deferred<GitHubPullRequestFilePatch>();
    seed(makeFiles({ headSha: HEAD, files }));
    installBackend({
      get_github_pull_request_file_patch: ({ headSha }) =>
        headSha === nextHead ? replacement.promise : loadedPatch(path),
      get_github_pull_request_files: () => makeFiles({ headSha: nextHead, files }),
      add_github_pull_request_review_comment: () => ({ id: 901 }),
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    fireEvent.click(await screen.findByRole("button", { name: "Comment on old line 2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), {
      target: { value: "original inline draft" },
    });

    await act(async () => appCommandStore(pullRequestsStore).getState().loadFiles(prRef));
    expect(screen.getByTestId("file-patch-loading")).toBeTruthy();
    const { hunks } = loadedPatch(path);
    const hunk = hunks[0]!;
    await act(async () =>
      replacement.resolve({
        ...loadedPatch(path),
        headSha: nextHead,
        hunks: [
          { ...hunk, lines: [{ type: "add", text: "new revision", oldLine: null, newLine: 99 }] },
        ],
      }),
    );
    expect(screen.getByText("new revision")).toBeTruthy();
    expect(screen.getByText(/Commenting on the original revision/)).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Review comment" }) as HTMLTextAreaElement).value,
    ).toBe("original inline draft");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add comment" })));
    expect(callsFor("add_github_pull_request_review_comment")[0]).toMatchObject({
      commitId: HEAD,
      comment: { path, side: "LEFT", line: 2, body: "original inline draft" },
    });
    expect(screen.queryByRole("textbox", { name: "Review comment" }) === null).toBe(true);
  });

  test("keeps inline and reply drafts when filtering unmounts the file", async () => {
    seed(makeFiles({ threads: [makeThread({ id: "keep-reply" })] }));
    renderInAppCommandScope(<ConnectedCodeTab />);
    fireEvent.click(screen.getByRole("button", { name: "Comment on new line 2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), {
      target: { value: "in progress" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reply to conversation" }), {
      target: { value: "reply in progress" },
    });
    const search = screen.getByRole("searchbox", { name: "Filter files by path" });
    await act(async () => search.focus());
    fireEvent.change(search, { target: { value: "other file" } });
    expect(screen.queryAllByTestId("pull-request-file")).toHaveLength(0);
    fireEvent.change(search, { target: { value: "" } });
    expect(
      (screen.getByRole("textbox", { name: "Review comment" }) as HTMLTextAreaElement).value,
    ).toBe("in progress");
    expect(
      (screen.getByRole("textbox", { name: "Reply to conversation" }) as HTMLTextAreaElement).value,
    ).toBe("reply in progress");
    expect(document.activeElement).toBe(search);
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

  test("a pending conversation waits for the replacement comparison and focuses its line", async () => {
    const path = "src/app.ts";
    const first = deferred<GitHubPullRequestFilePatch>();
    const second = deferred<GitHubPullRequestFilePatch>();
    const list = deferred<ReturnType<typeof makeFiles>>();
    const nextHead = "b".repeat(40);
    const files = [deferredFile(path)];
    seed(makeFiles({ headSha: HEAD, files, threads: [makeThread({ id: "moving" })] }));
    installBackend({
      get_github_pull_request_file_patch: ({ headSha }) =>
        headSha === HEAD ? first.promise : second.promise,
      get_github_pull_request_files: () => list.promise,
    });
    renderInAppCommandScope(<ConnectedCodeTab />);
    const next = screen.getByRole("button", { name: "Next unresolved conversation" });
    await act(async () => next.focus());
    fireEvent.click(next);
    await act(async () =>
      first.resolve({
        ...loadedPatch(path),
        headSha: nextHead,
        outcome: "head-moved",
        patchAvailable: false,
        hunks: [],
      }),
    );
    expect(screen.getByTestId("file-patch-loading")).toBeTruthy();
    expect(scrolledTo).toEqual([]);
    expect(document.activeElement).toBe(next);
    await act(async () =>
      list.resolve(
        makeFiles({
          headSha: nextHead,
          files,
          threads: [makeThread({ id: "moving", line: 3 })],
        }),
      ),
    );
    expect(callsFor("get_github_pull_request_file_patch").map((call) => call.headSha)).toEqual([
      HEAD,
      nextHead,
    ]);
    expect(scrolledTo).toEqual([]);
    await act(async () => second.resolve({ ...loadedPatch(path), headSha: nextHead }));
    const row = screen.getByTestId("diff-line-threads");
    expect(row.previousElementSibling?.getAttribute("data-new-line")).toBe("3");
    expect(document.activeElement).toBe(within(row).getByTestId("review-thread"));
    expect(scrolledTo).toEqual(["moving"]);
  });

  test.each(["filter", "collapse"] as const)(
    "cancels a pending conversation jump when the file is hidden by %s",
    async (action) => {
      const path = "src/app.ts";
      const patch = deferred<GitHubPullRequestFilePatch>();
      seed(
        makeFiles({
          headSha: HEAD,
          files: [deferredFile(path)],
          threads: [makeThread({ id: "stale" })],
        }),
      );
      installBackend({ get_github_pull_request_file_patch: () => patch.promise });
      renderInAppCommandScope(<ConnectedCodeTab />);
      fireEvent.click(screen.getByRole("button", { name: "Next unresolved conversation" }));
      expect(screen.getByTestId("file-patch-loading")).toBeTruthy();
      const search = screen.getByRole("searchbox", { name: "Filter files by path" });
      if (action === "filter") fireEvent.change(search, { target: { value: "unrelated" } });
      else fireEvent.click(screen.getByRole("button", { name: "Collapse all files" }));
      await act(async () => patch.resolve(loadedPatch(path)));
      await act(async () => search.focus());
      if (action === "filter") fireEvent.change(search, { target: { value: "" } });
      else fireEvent.click(screen.getByRole("button", { name: "Expand all files" }));
      expect(screen.getByTestId("review-thread")).toBeTruthy();
      expect(scrolledTo).toEqual([]);
      expect(document.activeElement).toBe(search);
    },
  );

  test("next unresolved reaches an outdated conversation on an empty rename", () => {
    seed(
      makeFiles({
        files: [makeFile({ status: "renamed", previousPath: "src/old.ts", hunks: [] })],
        threads: [makeThread({ id: "rename-outdated", line: null, isOutdated: true })],
      }),
    );
    renderInAppCommandScope(<ConnectedCodeTab />);
    expect(screen.getByText("No textual changes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next unresolved conversation" }));
    expect(screen.getByText("Outdated comments")).toBeTruthy();
    expect(scrolledTo).toEqual(["rename-outdated"]);
    expect(document.activeElement).toBe(screen.getByTestId("review-thread"));
  });

  test.each([
    ["not-found", "GitHub no longer lists this file"],
    ["loaded", "Diff not available here"],
  ] as const)(
    "shows the notice and conversations after a %s result without hunks",
    async (outcome, notice) => {
      const path = "src/app.ts";
      seed(
        makeFiles({
          headSha: HEAD,
          files: [deferredFile(path)],
          threads: [makeThread({ id: "unplaced" })],
        }),
      );
      installBackend({
        get_github_pull_request_file_patch: () => ({
          ...loadedPatch(path),
          outcome,
          patchAvailable: false,
          hunks: [],
        }),
      });
      renderInAppCommandScope(<ConnectedCodeTab />);
      fireEvent.click(screen.getByRole("button", { name: "Next unresolved conversation" }));
      await screen.findByText(new RegExp(notice));
      expect(screen.getByRole("button", { name: "View on GitHub" })).toBeTruthy();
      expect(screen.getByTestId("file-threads-without-diff")).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByTestId("review-thread"));
    },
  );

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
