import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { gitHubPullRequestKey } from "@orkestrator/protocol/github-pull-requests";
import { usePullRequestDetail } from "@/hooks/usePullRequestData";
import {
  callsFor,
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
import {
  PULL_REQUEST_DETAIL_POLL_MS,
  resourceKey,
  startPullRequestDetailPolling,
  usePullRequestsStore,
} from "./pullRequestsStore";

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

    await usePullRequestsStore.getState().loadDetail(prRef);
    expect(usePullRequestsStore.getState().errors.get(resourceKey("detail", key))).toBe("boom");
    expect(usePullRequestsStore.getState().details.has(key)).toBe(false);

    fail = false;
    const load = usePullRequestsStore.getState().loadDetail(prRef);
    expect(usePullRequestsStore.getState().loading.has(resourceKey("detail", key))).toBe(true);
    pending.resolve(makeDetail());
    await load;

    const state = usePullRequestsStore.getState();
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

    const older = usePullRequestsStore.getState().loadDetail(prRef);
    const newer = usePullRequestsStore.getState().loadDetail(prRef);
    second.resolve(makeDetail({ title: "newer" }));
    await newer;
    first.resolve(makeDetail({ title: "older" }));
    await older;

    expect(usePullRequestsStore.getState().details.get(key)?.title).toBe("newer");
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
    await usePullRequestsStore.getState().loadList("p1", "mine", " bug ");
    expect(callsFor("list_github_pull_requests")).toEqual([
      { projectId: "p1", filter: "mine", query: "bug" },
    ]);
    expect(usePullRequestsStore.getState().lists.has("p1:mine:bug")).toBe(true);
  });
});

describe("pullRequestsStore mutations", () => {
  test("setFileViewed is optimistic and reverts when GitHub rejects it", async () => {
    usePullRequestsStore.setState({ files: new Map([[key, makeFiles()]]) });
    const pending = deferred<never>();
    installBackend({ set_github_pull_request_file_viewed: () => pending.promise });

    const write = usePullRequestsStore.getState().setFileViewed(prRef, "src/app.ts", true);
    expect(usePullRequestsStore.getState().files.get(key)?.files[0]?.viewedState).toBe("viewed");
    pending.reject(new Error("denied"));
    await expect(write).rejects.toThrow("denied");
    expect(usePullRequestsStore.getState().files.get(key)?.files[0]?.viewedState).toBe("unviewed");
  });

  test("updateState stores the returned detail and re-fetches a loaded timeline", async () => {
    usePullRequestsStore.setState({
      details: new Map([[key, makeDetail()]]),
      timelines: new Map([[key, { ref: prRef, items: [], truncated: false }]]),
    });
    installBackend({
      update_github_pull_request_state: () => makeDetail({ state: "closed" }),
      get_github_pull_request_timeline: () => ({ ref: prRef, items: [], truncated: false }),
    });
    await usePullRequestsStore.getState().updateState(prRef, "close");
    expect(usePullRequestsStore.getState().details.get(key)?.state).toBe("closed");
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
    const { rerender, unmount } = renderHook(({ active }) => usePullRequestDetail(prRef, active), {
      initialProps: { active: true },
    });
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
