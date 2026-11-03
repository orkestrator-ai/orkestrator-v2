import { describe, expect, mock, test } from "bun:test";
import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import {
  fastForwardProjectCheckout,
  ProjectCheckoutMergeFollower,
  type ProjectCheckoutGit,
} from "./project-checkout-merge-follow.js";

const behind = {
  projectId: "project-1",
  upstream: "origin/main",
  upstreamCommit: "b".repeat(40),
  ahead: 0,
  behind: 2,
  trackedChanges: 0,
  untrackedChanges: 0,
  repositoryOperationBlockedReason: null,
} as unknown as ProjectGitStatus;

function fakeGit(overrides: Partial<ProjectCheckoutGit> = {}) {
  const git = {
    isCheckoutBusy: mock(async (_projectId: string) => false),
    fetch: mock(async (_projectId: string, _force?: boolean) => behind),
    sync: mock(async (_projectId: string) => ({ ...behind, behind: 0 })),
    ...overrides,
  };
  return git;
}

function manualTimers() {
  let now = 0;
  const timers: { at: number; callback: () => void }[] = [];
  return {
    now: () => now,
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { at: now + delayMs, callback };
      timers.push(timer);
      return timer;
    },
    cancel: (handle: unknown) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
    pending: () => timers.length,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((entry) => entry.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
    },
  };
}

describe("fastForwardProjectCheckout", () => {
  test("fetches past the cooldown and fast-forwards a clean, behind checkout", async () => {
    const git = fakeGit();
    expect(await fastForwardProjectCheckout(git, "project-1")).toBe("fast-forwarded");
    expect(git.fetch).toHaveBeenCalledWith("project-1", true);
    expect(git.sync).toHaveBeenCalledWith("project-1");
  });

  test.each([
    ["not-behind", { ...behind, behind: 0 }],
    ["not-behind", { ...behind, upstream: null, behind: null }],
    ["blocked", { ...behind, ahead: 1 }],
    ["blocked", { ...behind, trackedChanges: 1 }],
    ["blocked", { ...behind, repositoryOperationBlockedReason: "Finish the merge." }],
  ] as const)("leaves the checkout alone: %s", async (outcome, status) => {
    const git = fakeGit({ fetch: mock(async () => status as ProjectGitStatus) });
    expect(await fastForwardProjectCheckout(git, "project-1")).toBe(outcome);
    expect(git.sync).not.toHaveBeenCalled();
  });

  test("a running turn is not fetched or merged into", async () => {
    const git = fakeGit({ isCheckoutBusy: mock(async () => true) });
    expect(await fastForwardProjectCheckout(git, "project-1")).toBe("busy");
    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.sync).not.toHaveBeenCalled();
  });

  test("a turn that starts before the fast-forward reads as busy, not failed", async () => {
    const git = fakeGit({
      sync: mock(async () => {
        throw new Error("Stop the active coordinator turn before changing the checkout");
      }),
    });
    expect(await fastForwardProjectCheckout(git, "project-1")).toBe("busy");
  });

  test("an unreadable status or a refused fast-forward is reported, never thrown", async () => {
    expect(
      await fastForwardProjectCheckout(
        fakeGit({
          fetch: mock(async () => {
            throw new Error("offline");
          }),
        }),
        "project-1",
      ),
    ).toBe("no-status");
    expect(
      await fastForwardProjectCheckout(
        fakeGit({
          sync: mock(async () => {
            throw new Error("Not possible to fast-forward");
          }),
        }),
        "project-1",
      ),
    ).toBe("failed");
  });
});

describe("ProjectCheckoutMergeFollower", () => {
  test("follows a merge once per PR", async () => {
    const git = fakeGit();
    const follower = new ProjectCheckoutMergeFollower();
    follower.follow("project-1", git, "https://github.com/o/r/pull/1");
    await follower.idle();
    follower.follow("project-1", git, "https://github.com/o/r/pull/1");
    await follower.idle();
    expect(git.sync).toHaveBeenCalledTimes(1);
    follower.follow("project-1", git, "https://github.com/o/r/pull/2");
    await follower.idle();
    expect(git.sync).toHaveBeenCalledTimes(2);
    expect(follower.isFollowing("project-1")).toBe(false);
  });

  test("retries while a turn holds the checkout, then fast-forwards", async () => {
    const timers = manualTimers();
    let busy = true;
    const git = fakeGit({ isCheckoutBusy: mock(async () => busy) });
    const follower = new ProjectCheckoutMergeFollower({ ...timers, retryIntervalMs: 1_000 });
    follower.follow("project-1", git, "pr-1");
    await follower.idle();
    expect(git.sync).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(1);

    timers.advance(1_000);
    await follower.idle();
    expect(git.sync).not.toHaveBeenCalled();

    busy = false;
    timers.advance(1_000);
    await follower.idle();
    expect(git.sync).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
    expect(follower.isFollowing("project-1")).toBe(false);
  });

  test("gives up after the retry window; the next coordinator message merges instead", async () => {
    const timers = manualTimers();
    const git = fakeGit({ isCheckoutBusy: mock(async () => true) });
    const follower = new ProjectCheckoutMergeFollower({
      ...timers,
      retryIntervalMs: 1_000,
      retryWindowMs: 2_500,
    });
    follower.follow("project-1", git, "pr-1");
    await follower.idle();
    for (let step = 0; step < 4; step += 1) {
      timers.advance(1_000);
      await follower.idle();
    }
    // Attempts at 0, 1s, 2s and 3s; the one at 3s is past the window, so it stops.
    expect(git.isCheckoutBusy).toHaveBeenCalledTimes(4);
    expect(timers.pending()).toBe(0);
    expect(follower.isFollowing("project-1")).toBe(false);
  });

  test("a merge during an attempt reruns it once; merges while waiting share the retry", async () => {
    let finishFetch!: () => void;
    const fetch = mock(
      (_projectId: string, _force?: boolean) =>
        new Promise<ProjectGitStatus>((resolve) => {
          finishFetch = () => resolve(behind);
        }),
    );
    const git = fakeGit({ fetch });
    const follower = new ProjectCheckoutMergeFollower();
    follower.follow("project-1", git, "pr-1");
    await Promise.resolve();
    await Promise.resolve();
    follower.follow("project-1", git, "pr-2");
    follower.follow("project-1", git, "pr-3");
    finishFetch();
    await Promise.resolve();
    for (let turn = 0; turn < 10 && fetch.mock.calls.length < 2; turn += 1) {
      await Promise.resolve();
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    finishFetch();
    await follower.idle();
    expect(git.sync).toHaveBeenCalledTimes(2);
    expect(follower.isFollowing("project-1")).toBe(false);
  });

  test("shutdown cancels a scheduled retry and refuses new work", async () => {
    const timers = manualTimers();
    const git = fakeGit({ isCheckoutBusy: mock(async () => true) });
    const follower = new ProjectCheckoutMergeFollower({ ...timers, retryIntervalMs: 1_000 });
    follower.follow("project-1", git, "pr-1");
    await follower.idle();
    expect(timers.pending()).toBe(1);
    follower.shutdown();
    expect(timers.pending()).toBe(0);
    follower.follow("project-2", git, "pr-2");
    await follower.idle();
    expect(git.isCheckoutBusy).toHaveBeenCalledTimes(1);
  });
});

test("a stale cached fetch retries and recovers without another merge", async () => {
  const timers = manualTimers();
  let fresh = false;
  const git = fakeGit({
    fetch: mock(async () =>
      fresh
        ? behind
        : ({
            ...behind,
            behind: 0,
            remoteState: "stale",
            lastError: { operation: "fetch", message: "offline" },
          } as ProjectGitStatus),
    ),
  });
  const follower = new ProjectCheckoutMergeFollower({ ...timers, retryIntervalMs: 1000 });
  follower.follow("project-1", git, "pr-recover");
  await follower.idle();
  expect(git.sync).not.toHaveBeenCalled();
  expect(timers.pending()).toBe(1);
  fresh = true;
  timers.advance(1000);
  await follower.idle();
  expect(git.sync).toHaveBeenCalledTimes(1);
  follower.shutdown();
});

test("an expired fetch failure permits a later observation of the same PR", async () => {
  const timers = manualTimers();
  const fetch = mock(async (_projectId: string, _force?: boolean): Promise<ProjectGitStatus> => {
    throw new Error("offline");
  });
  const git = fakeGit({ fetch });
  const follower = new ProjectCheckoutMergeFollower({
    ...timers,
    retryIntervalMs: 1000,
    retryWindowMs: 500,
  });
  follower.follow("project-1", git, "pr-retry");
  await follower.idle();
  timers.advance(1000);
  await follower.idle();
  fetch.mockImplementation(async () => behind);
  follower.follow("project-1", git, "pr-retry");
  await follower.idle();
  expect(git.sync).toHaveBeenCalledTimes(1);
  follower.shutdown();
});
