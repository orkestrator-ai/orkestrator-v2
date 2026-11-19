import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import {
  gitHubPullRequestComparisonKey,
  gitHubPullRequestKey,
} from "@orkestrator/protocol/github-pull-requests";
import { usePullRequestDetail } from "@/hooks/usePullRequestData";
import {
  callsFor,
  comparisonBase,
  deferred,
  installBackend,
  makeDetail,
  makeFiles,
  prRef,
  resetBackend,
  resetPullRequestsStore,
} from "@/components/pull-requests/pull-request-test-fixtures";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../tests/helpers/controlled-timeout";
import type { GitHubPullRequestFilePatch } from "@orkestrator/protocol/github-pull-requests";
import {
  MAX_CACHED_FILE_PATCHES,
  MAX_CACHED_FILE_PATCH_ROWS,
  PULL_REQUEST_DETAIL_POLL_MS,
  filePatchKey,
  pullRequestsStore,
  resourceKey,
  startPullRequestDetailPolling,
} from "./pullRequestsStore";
import { appCommandStore } from "@/test/app-command-store";

const key = gitHubPullRequestKey(prRef);

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

beforeEach(() => {
  resetPullRequestsStore();
  setVisibility("visible");
});

afterEach(() => {
  resetBackend();
  setVisibility("visible");
});

describe("pullRequestsStore reads", () => {
  test("loadDetail tracks loading, stores the detail and clears a previous error", async () => {
    const pending = deferred<ReturnType<typeof makeDetail>>();
    let fail = true;
    installBackend({
      get_github_pull_request: () => (fail ? Promise.reject(new Error("boom")) : pending.promise),
    });

    await appCommandStore(pullRequestsStore).getState().loadDetail(prRef);
    expect(
      appCommandStore(pullRequestsStore).getState().errors.get(resourceKey("detail", key)),
    ).toBe("boom");
    expect(appCommandStore(pullRequestsStore).getState().details.has(key)).toBe(false);

    fail = false;
    const load = appCommandStore(pullRequestsStore).getState().loadDetail(prRef);
    expect(
      appCommandStore(pullRequestsStore).getState().loading.has(resourceKey("detail", key)),
    ).toBe(true);
    pending.resolve(makeDetail());
    await load;

    const state = appCommandStore(pullRequestsStore).getState();
    expect(state.loading.has(resourceKey("detail", key))).toBe(false);
    expect(state.errors.has(resourceKey("detail", key))).toBe(false);
    expect(state.details.get(key)?.title).toBe("feat: add usage history tab");
    expect(callsFor("get_github_pull_request").at(-1)).toEqual({
      owner: "acme",
      repo: "widget",
      number: 42,
    });
  });

  test("a stale response cannot overwrite a newer one", async () => {
    const first = deferred<ReturnType<typeof makeDetail>>();
    const second = deferred<ReturnType<typeof makeDetail>>();
    const queue = [first, second];
    installBackend({ get_github_pull_request: () => queue.shift()!.promise });

    const older = appCommandStore(pullRequestsStore).getState().loadDetail(prRef);
    const newer = appCommandStore(pullRequestsStore).getState().loadDetail(prRef);
    second.resolve(makeDetail({ title: "newer" }));
    await newer;
    first.resolve(makeDetail({ title: "older" }));
    await older;

    expect(appCommandStore(pullRequestsStore).getState().details.get(key)?.title).toBe("newer");
  });

  test("loadList keys results by project, filter and query", async () => {
    installBackend({
      list_github_pull_requests: (args) => ({
        repository: { owner: "acme", repo: "widget", fullName: "acme/widget", htmlUrl: "" },
        viewer: { login: "ada" },
        filter: args.filter,
        pullRequests: [],
        hasMore: false,
      }),
    });
    await appCommandStore(pullRequestsStore).getState().loadList("p1", "mine", " bug ");
    expect(callsFor("list_github_pull_requests")).toEqual([
      { projectId: "p1", filter: "mine", query: "bug" },
    ]);
    expect(appCommandStore(pullRequestsStore).getState().lists.has("p1:mine:bug")).toBe(true);
  });
});

describe("pullRequestsStore single-file patches", () => {
  const HEAD = "a".repeat(40);
  const comparison = { headSha: HEAD, comparisonBase };
  const revision = gitHubPullRequestComparisonKey(comparison);
  const patchOf = (path: string, rows = 1): GitHubPullRequestFilePatch => ({
    ref: prRef,
    path,
    ...comparison,
    outcome: "loaded",
    patchAvailable: true,
    hunks: [
      {
        header: "@@",
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: rows,
        lines: Array.from({ length: rows }, (_, index) => ({
          type: "add" as const,
          text: `${index}`,
          oldLine: null,
          newLine: index + 1,
        })),
      },
    ],
  });
  const store = () => appCommandStore(pullRequestsStore).getState();

  test("caches by comparison and path and does not repeat a read in flight", async () => {
    const pending = deferred<GitHubPullRequestFilePatch>();
    installBackend({ get_github_pull_request_file_patch: () => pending.promise });
    const file = { path: "a.ts", ...comparison, index: 3 };
    const first = store().loadFilePatch(prRef, file);
    const second = store().loadFilePatch(prRef, file);
    expect(callsFor("get_github_pull_request_file_patch")).toHaveLength(1);
    pending.resolve(patchOf("a.ts"));
    await Promise.all([first, second]);
    expect(store().filePatches.get(filePatchKey(key, revision, "a.ts"))?.outcome).toBe("loaded");
  });

  test("evicts the stalest patches by count and rows, never the newest", async () => {
    installBackend({
      get_github_pull_request_file_patch: (args) =>
        patchOf(String(args.path), args.path === "huge.ts" ? MAX_CACHED_FILE_PATCH_ROWS + 1 : 1),
    });
    for (let index = 0; index <= MAX_CACHED_FILE_PATCHES; index++) {
      await store().loadFilePatch(prRef, { path: `f${index}.ts`, ...comparison });
    }
    expect(store().filePatches.size).toBe(MAX_CACHED_FILE_PATCHES);
    expect(store().filePatches.has(filePatchKey(key, revision, "f0.ts"))).toBe(false);

    await store().loadFilePatch(prRef, { path: "huge.ts", ...comparison });
    expect(Array.from(store().filePatches.keys())).toEqual([
      filePatchKey(key, revision, "huge.ts"),
    ]);
  });

  test("a new file list drops patches read at an older head", async () => {
    installBackend({
      get_github_pull_request_file_patch: (args) => patchOf(String(args.path)),
      get_github_pull_request_files: () => makeFiles({ headSha: "b".repeat(40) }),
    });
    await store().loadFilePatch(prRef, { path: "a.ts", ...comparison });
    expect(store().filePatches.size).toBe(1);
    await store().loadFiles(prRef);
    expect(store().filePatches.size).toBe(0);
  });

  test.each([
    ["retarget", { headSha: HEAD, comparisonBase: { ref: "release", sha: "e".repeat(40) } }],
    ["push", { headSha: "b".repeat(40), comparisonBase }],
  ] as const)(
    "a %s invalidates cached patches and drops old in-flight successes",
    async (_, next) => {
      const pending = deferred<GitHubPullRequestFilePatch>();
      installBackend({
        get_github_pull_request_file_patch: (args) => {
          if (args.path === "pending.ts") return pending.promise;
          const patch = patchOf(String(args.path));
          return args.path === "current.ts" ? { ...patch, ...next } : patch;
        },
        get_github_pull_request_files: () => makeFiles(next),
      });
      await store().loadFilePatch(prRef, { path: "cached.ts", ...comparison });
      const oldRead = store().loadFilePatch(prRef, { path: "pending.ts", ...comparison });
      await store().loadFiles(prRef);
      const currentRead = store().loadFilePatch(prRef, { path: "current.ts", ...next });
      await currentRead;
      pending.resolve(patchOf("pending.ts"));
      await oldRead;

      expect(Array.from(store().filePatches.keys())).toEqual([
        filePatchKey(key, gitHubPullRequestComparisonKey(next), "current.ts"),
      ]);
    },
  );

  test.each([false, true])(
    "moved patch reads share a list refresh (poll already running: %s)",
    async (pollAlreadyRunning) => {
      const first = deferred<GitHubPullRequestFilePatch>();
      const second = deferred<GitHubPullRequestFilePatch>();
      const list = deferred<ReturnType<typeof makeFiles>>();
      const newHead = "b".repeat(40);
      installBackend({
        get_github_pull_request_file_patch: ({ path, headSha }) => {
          if (headSha === newHead) return { ...patchOf(String(path)), headSha: newHead };
          return path === "first.ts" ? first.promise : second.promise;
        },
        get_github_pull_request_files: () => list.promise,
      });

      const firstRead = store().loadFilePatch(prRef, { path: "first.ts", ...comparison });
      const secondRead = store().loadFilePatch(prRef, { path: "second.ts", ...comparison });
      const poll = pollAlreadyRunning ? store().loadFiles(prRef) : undefined;
      for (const [pending, path] of [
        [first, "first.ts"],
        [second, "second.ts"],
      ] as const) {
        pending.resolve({
          ...patchOf(path),
          headSha: newHead,
          outcome: "head-moved",
          patchAvailable: false,
          hunks: [],
        });
        await pending.promise;
      }
      await act(async () => {});
      expect(callsFor("get_github_pull_request_files")).toHaveLength(1);
      expect(store().errors.size).toBe(0);
      list.resolve(makeFiles({ headSha: newHead }));
      await Promise.all([firstRead, secondRead, poll]);
      expect(store().errors.size).toBe(0);
      expect(callsFor("get_github_pull_request_files")).toHaveLength(1);

      await store().loadFilePatch(prRef, { path: "first.ts", ...comparison, headSha: newHead });
      expect(Array.from(store().filePatches.values()).map((patch) => patch.headSha)).toEqual([
        newHead,
      ]);
    },
  );

  test("a superseded recovery stays pending until the newer file list settles", async () => {
    const recovery = deferred<ReturnType<typeof makeFiles>>();
    const poll = deferred<ReturnType<typeof makeFiles>>();
    const nextHead = "b".repeat(40);
    const loadKey = resourceKey("file-patch", filePatchKey(key, revision, "a.ts"));
    let reads = 0;
    installBackend({
      get_github_pull_request_file_patch: () => ({
        ...patchOf("a.ts"),
        headSha: nextHead,
        outcome: "head-moved",
        hunks: [],
      }),
      get_github_pull_request_files: () => (++reads === 1 ? recovery.promise : poll.promise),
    });
    const read = store().loadFilePatch(prRef, { ...comparison, path: "a.ts" });
    await act(async () => {});
    expect(reads).toBe(1);

    const newer = store().loadFiles(prRef);
    await act(async () => recovery.resolve(makeFiles(comparison)));
    expect(store().loading.has(loadKey)).toBe(true);
    expect(store().errors.has(loadKey)).toBe(false);
    poll.resolve(makeFiles({ headSha: nextHead }));
    await Promise.all([newer, read]);
    expect(store().loading.has(loadKey)).toBe(false);
    expect(store().errors.has(loadKey)).toBe(false);
    expect(store().files.get(key)?.headSha).toBe(nextHead);
  });
});

describe("pullRequestsStore mutations", () => {
  test("setFileViewed is optimistic and reverts when GitHub rejects it", async () => {
    appCommandStore(pullRequestsStore).setState({ files: new Map([[key, makeFiles()]]) });
    const pending = deferred<never>();
    installBackend({
      set_github_pull_request_file_viewed: () => pending.promise,
      get_github_pull_request_files: () => makeFiles(),
    });

    const write = appCommandStore(pullRequestsStore)
      .getState()
      .setFileViewed(prRef, "src/app.ts", true);
    expect(
      appCommandStore(pullRequestsStore).getState().files.get(key)?.files[0]?.viewedState,
    ).toBe("viewed");
    pending.reject(new Error("denied"));
    await expect(write).rejects.toThrow("denied");
    expect(
      appCommandStore(pullRequestsStore).getState().files.get(key)?.files[0]?.viewedState,
    ).toBe("unviewed");
  });

  test("updateState stores the returned detail and re-fetches a loaded timeline", async () => {
    appCommandStore(pullRequestsStore).setState({
      details: new Map([[key, makeDetail()]]),
      timelines: new Map([[key, { ref: prRef, items: [], truncated: false }]]),
    });
    installBackend({
      update_github_pull_request_state: () => makeDetail({ state: "closed" }),
      get_github_pull_request_timeline: () => ({ ref: prRef, items: [], truncated: false }),
    });
    await appCommandStore(pullRequestsStore).getState().updateState(prRef, "close");
    expect(appCommandStore(pullRequestsStore).getState().details.get(key)?.state).toBe("closed");
    expect(callsFor("update_github_pull_request_state")).toEqual([
      { owner: "acme", repo: "widget", number: 42, action: "close" },
    ]);
    expect(callsFor("get_github_pull_request_timeline")).toHaveLength(1);
  });
});

describe("pull request polling", () => {
  let clock: ControlledTimeout;
  beforeEach(() => {
    clock = installControlledTimeout(PULL_REQUEST_DETAIL_POLL_MS, { label: "detail poll" });
    installBackend({ get_github_pull_request: () => makeDetail() });
  });
  afterEach(() => {
    clock.restore();
  });

  test("polls while visible, skips while hidden and stops cleanly", () => {
    const stop = startPullRequestDetailPolling(prRef);
    expect(clock.pendingCount()).toBe(1);

    clock.advance();
    expect(callsFor("get_github_pull_request")).toHaveLength(1);
    expect(clock.pendingCount()).toBe(1);

    setVisibility("hidden");
    clock.advance();
    expect(callsFor("get_github_pull_request")).toHaveLength(1);
    expect(clock.pendingCount()).toBe(1);

    stop();
    expect(clock.pendingCount()).toBe(0);
  });

  test("the detail hook polls only while active", async () => {
    const { rerender, unmount } = renderHookInAppCommandScope(
      ({ active }) => usePullRequestDetail(prRef, active),
      {
        initialProps: { active: true },
      },
    );
    expect(clock.pendingCount()).toBe(1);
    expect(callsFor("get_github_pull_request")).toHaveLength(1);

    rerender({ active: false });
    expect(clock.pendingCount()).toBe(0);

    rerender({ active: true });
    expect(clock.pendingCount()).toBe(1);
    unmount();
    expect(clock.pendingCount()).toBe(0);
    await act(async () => {});
  });
});

test("a files read predating a viewed write cannot undo acknowledged state", async () => {
  const old = deferred<ReturnType<typeof makeFiles>>();
  const refreshed = deferred<ReturnType<typeof makeFiles>>();
  const reads = [old, refreshed];
  appCommandStore(pullRequestsStore).setState({ files: new Map([[key, makeFiles()]]) });
  installBackend({
    get_github_pull_request_files: () => reads.shift()!.promise,
    set_github_pull_request_file_viewed: () => ({ viewedState: "viewed" }),
  });
  const read = appCommandStore(pullRequestsStore).getState().loadFiles(prRef);
  await appCommandStore(pullRequestsStore).getState().setFileViewed(prRef, "src/app.ts", true);
  old.resolve(makeFiles());
  await read;
  expect(appCommandStore(pullRequestsStore).getState().files.get(key)?.files[0]?.viewedState).toBe(
    "viewed",
  );
  refreshed.resolve(makeFiles({ files: [{ ...makeFiles().files[0]!, viewedState: "viewed" }] }));
  await act(async () => {});
  expect(appCommandStore(pullRequestsStore).getState().files.get(key)?.files[0]?.viewedState).toBe(
    "viewed",
  );
  expect(appCommandStore(pullRequestsStore).getState().loading.has(resourceKey("files", key))).toBe(
    false,
  );
});
