import { describe, expect, mock, test } from "bun:test";
import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import {
  checkUpstreamBeforeMessage,
  type CoordinatorMessageGit,
} from "./coordinator-message-upstream.js";
import type { FetchedUpstreamFastForward } from "./project-git-service.js";

const behind = {
  projectId: "project-1",
  upstream: "origin/main",
  upstreamCommit: "b".repeat(40),
  ahead: 0,
  behind: 2,
  trackedChanges: 0,
  untrackedChanges: 0,
  remoteState: "fresh",
  lastError: null,
  repositoryOperationBlockedReason: null,
} as unknown as ProjectGitStatus;

const merged = { ...behind, behind: 0 } as ProjectGitStatus;

/** What a fetch that could not reach the remote leaves: local refs only. */
const failedFetch = {
  ...behind,
  remoteState: "stale",
  lastError: { operation: "fetch", message: "Permission denied (publickey)" },
} as unknown as ProjectGitStatus;

function fakeGit(overrides: Partial<CoordinatorMessageGit> = {}) {
  return {
    isCheckoutBusy: mock(async (_projectId: string) => false),
    fetch: mock(async (_projectId: string, _force?: boolean) => behind),
    fastForwardToFetchedUpstream: mock(
      async (_projectId: string): Promise<FetchedUpstreamFastForward> => ({
        outcome: "fast-forwarded",
        status: merged,
      }),
    ),
    ...overrides,
  };
}

const hangingFetch = () => new Promise<ProjectGitStatus>(() => undefined);

describe("checkUpstreamBeforeMessage", () => {
  test("a fetch in time is decided by the protocol rule and merges nothing itself", async () => {
    const git = fakeGit();
    expect(await checkUpstreamBeforeMessage(git, "project-1")).toEqual({
      offer: true,
      status: behind,
      automatic: true,
    });
    expect(git.fetch).toHaveBeenCalledWith("project-1");
    expect(git.fastForwardToFetchedUpstream).not.toHaveBeenCalled();
  });

  test.each([
    ["times out", { fetch: mock(hangingFetch) }],
    ["fails", { fetch: mock(async () => failedFetch) }],
    [
      "throws",
      {
        fetch: mock(async () => {
          throw new Error("offline");
        }),
      },
    ],
  ])(
    "when the fetch %s, fast-forwards to the upstream already fetched",
    async (_label, overrides) => {
      const git = fakeGit(overrides);
      expect(await checkUpstreamBeforeMessage(git, "project-1", { timeoutMs: 5 })).toEqual({
        offer: false,
        reason: "fast-forwarded",
        status: merged,
      });
      expect(git.fastForwardToFetchedUpstream).toHaveBeenCalledTimes(1);
    },
  );

  test("a late fetch after the bound starts nothing further", async () => {
    let finish!: (status: ProjectGitStatus) => void;
    const git = fakeGit({
      fetch: mock(
        () =>
          new Promise<ProjectGitStatus>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    await checkUpstreamBeforeMessage(git, "project-1", { timeoutMs: 5 });
    finish(behind);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(git.fastForwardToFetchedUpstream).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["blocked", "blocked"],
    ["not-behind", "not-behind"],
  ] as const)("a slow fetch over a checkout that is %s merges nothing", async (outcome, reason) => {
    const left = { ...behind, ahead: 1 } as ProjectGitStatus;
    const git = fakeGit({
      fetch: mock(hangingFetch),
      fastForwardToFetchedUpstream: mock(async () => ({ outcome, status: left })),
    });
    expect(await checkUpstreamBeforeMessage(git, "project-1", { timeoutMs: 5 })).toEqual({
      offer: false,
      reason,
      status: left,
    });
  });

  test("leaves a busy checkout alone, before and after a slow fetch", async () => {
    const busy = fakeGit({ isCheckoutBusy: mock(async () => true) });
    expect(await checkUpstreamBeforeMessage(busy, "project-1")).toEqual({
      offer: false,
      reason: "turn-running",
      status: null,
    });
    expect(busy.fetch).not.toHaveBeenCalled();
    expect(busy.fastForwardToFetchedUpstream).not.toHaveBeenCalled();

    const startedMeanwhile = fakeGit({
      fetch: mock(hangingFetch),
      fastForwardToFetchedUpstream: mock(async () => ({ outcome: "busy" as const, status: null })),
    });
    expect(
      await checkUpstreamBeforeMessage(startedMeanwhile, "project-1", { timeoutMs: 5 }),
    ).toEqual({ offer: false, reason: "turn-running", status: null });
  });

  test("a failed local fast-forward still answers, so the message is sent", async () => {
    const git = fakeGit({
      fetch: mock(async () => failedFetch),
      fastForwardToFetchedUpstream: mock(async () => {
        throw new Error("Unable to create index.lock");
      }),
    });
    expect(await checkUpstreamBeforeMessage(git, "project-1", { timeoutMs: 5 })).toEqual({
      offer: false,
      reason: "no-status",
      status: failedFetch,
    });
  });
});
