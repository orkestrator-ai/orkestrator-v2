import { describe, expect, mock, test } from "bun:test";
import {
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorWorkspace,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import { fastForwardBeforeCoordinatorMail } from "./coordinator-mail-upstream.js";
import type { ProjectCheckoutGit } from "./project-checkout-merge-follow.js";

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
  return {
    isCheckoutBusy: mock(async (_projectId: string) => false),
    fetch: mock(async (_projectId: string, _force?: boolean) => behind),
    sync: mock(async (_projectId: string) => ({ ...behind, behind: 0 })),
    syncAfterMerge: mock(async (_projectId: string) => ({ ...behind, behind: 0 })),
    ...overrides,
  };
}

function storageWith(
  conversation: Partial<CoordinatorConversation> = {},
  workspace: Partial<CoordinatorWorkspace> = {},
) {
  const record = {
    id: "coord-1",
    projectId: "project-1",
    lifecycleState: "ready",
    conversations: [
      { id: "conv-1", tabId: "tab-1", agent: "claude", role: "main", ...conversation },
    ],
    ...workspace,
  } as unknown as CoordinatorWorkspace;
  return {
    coordinators: {
      getCoordinatorWorkspaceById: async (id: string) => (id === record.id ? record : null),
    },
  } as never;
}

const runtimeId = coordinatorRuntimeId("coord-1", "conv-1");

describe("fastForwardBeforeCoordinatorMail", () => {
  test("fast-forwards the main coordinator's checkout with a cooldown-bound fetch", async () => {
    const git = fakeGit();
    expect(await fastForwardBeforeCoordinatorMail({ storage: storageWith(), git }, runtimeId)).toBe(
      "fast-forwarded",
    );
    expect(git.fetch).toHaveBeenCalledWith("project-1", false);
    // The merge-sync path, so the mail turn's admission waits for it.
    expect(git.syncAfterMerge).toHaveBeenCalledWith("project-1");
    expect(git.sync).not.toHaveBeenCalled();
  });

  test.each([
    ["an ordinary environment", "env-1", storageWith()],
    ["a side agent", runtimeId, storageWith({ role: "side", sideOrdinal: 1 })],
    ["a conversation with no agent yet", runtimeId, storageWith({ agent: undefined })],
    ["a paused coordinator", runtimeId, storageWith({}, { lifecycleState: "paused" } as never)],
    ["a closed conversation", runtimeId, storageWith({ closedAt: "2026-01-01T00:00:00Z" })],
    ["a missing coordinator", coordinatorRuntimeId("other", "conv-1"), storageWith()],
  ])("skips %s", async (_label, id, storage) => {
    const git = fakeGit();
    expect(await fastForwardBeforeCoordinatorMail({ storage, git }, id)).toBe("skipped");
    expect(git.isCheckoutBusy).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
  });

  test("skips when there is no project Git service", async () => {
    expect(
      await fastForwardBeforeCoordinatorMail({ storage: storageWith(), git: undefined }, runtimeId),
    ).toBe("skipped");
  });

  test("leaves a checkout under a running turn, or one Git cannot fast-forward, alone", async () => {
    const busy = fakeGit({ isCheckoutBusy: mock(async () => true) });
    expect(
      await fastForwardBeforeCoordinatorMail({ storage: storageWith(), git: busy }, runtimeId),
    ).toBe("busy");
    expect(busy.fetch).not.toHaveBeenCalled();

    const diverged = fakeGit({ fetch: mock(async () => ({ ...behind, ahead: 1 })) });
    expect(
      await fastForwardBeforeCoordinatorMail({ storage: storageWith(), git: diverged }, runtimeId),
    ).toBe("blocked");
    expect(diverged.syncAfterMerge).not.toHaveBeenCalled();
  });

  test("a slow fetch delays the mail only to the bound, and never merges late", async () => {
    let finishFetch!: (status: ProjectGitStatus) => void;
    const git = fakeGit({
      fetch: mock(
        () =>
          new Promise<ProjectGitStatus>((resolve) => {
            finishFetch = resolve;
          }),
      ),
    });
    expect(
      await fastForwardBeforeCoordinatorMail(
        { storage: storageWith(), git, timeoutMs: 5 },
        runtimeId,
      ),
    ).toBe("timed-out");
    finishFetch(behind);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(git.syncAfterMerge).not.toHaveBeenCalled();
    expect(git.sync).not.toHaveBeenCalled();
  });

  test.each(["failure", "timeout"])("backs off repeated mail after %s", async (mode) => {
    let now = 100;
    const git = fakeGit({
      fetch: mock(async () => {
        if (mode === "failure") throw new Error("offline");
        return new Promise<ProjectGitStatus>(() => undefined);
      }),
    });
    const deps = { storage: storageWith(), git, timeoutMs: 1, now: () => now };
    expect(await fastForwardBeforeCoordinatorMail(deps, runtimeId)).toBe(
      mode === "failure" ? "no-status" : "timed-out",
    );
    expect(await fastForwardBeforeCoordinatorMail(deps, runtimeId)).toBe("cooldown");
    expect(git.fetch).toHaveBeenCalledTimes(1);
    now += 60_000;
    await fastForwardBeforeCoordinatorMail(deps, runtimeId);
    expect(git.fetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["the fetch times out", { fetch: mock(() => new Promise<ProjectGitStatus>(() => undefined)) }],
    ["the fetch fails", { fetch: mock(async () => ({ ...behind, remoteState: "stale" })) }],
    [
      "the sync fails",
      {
        syncAfterMerge: mock(async () => {
          throw new Error("Could not read from remote repository.");
        }),
      },
    ],
  ] as const)(
    "when %s, the upstream commit already fetched is still merged",
    async (_label, overrides) => {
      const git = fakeGit({
        ...overrides,
        fastForwardToFetchedUpstream: mock(async () => ({
          outcome: "fast-forwarded" as const,
          status: { ...behind, behind: 0 } as ProjectGitStatus,
        })),
      } as Partial<ProjectCheckoutGit>);
      expect(
        await fastForwardBeforeCoordinatorMail(
          { storage: storageWith(), git, timeoutMs: 5 },
          runtimeId,
        ),
      ).toBe("fast-forwarded-fetched");
      expect(git.fastForwardToFetchedUpstream).toHaveBeenCalledTimes(1);
    },
  );

  test("a busy or blocked checkout gets no fetched-upstream merge", async () => {
    const local = mock(async () => ({ outcome: "fast-forwarded" as const, status: behind }));
    const busy = fakeGit({
      isCheckoutBusy: mock(async () => true),
      fastForwardToFetchedUpstream: local,
    });
    expect(
      await fastForwardBeforeCoordinatorMail({ storage: storageWith(), git: busy }, runtimeId),
    ).toBe("busy");
    const dirty = fakeGit({
      fetch: mock(async () => ({ ...behind, untrackedChanges: 1 })),
      fastForwardToFetchedUpstream: local,
    });
    expect(
      await fastForwardBeforeCoordinatorMail({ storage: storageWith(), git: dirty }, runtimeId),
    ).toBe("blocked");
    expect(local).not.toHaveBeenCalled();
  });

  test("mail held behind a running turn does not spend the cooldown", async () => {
    // The mail is held while the turn runs and redelivered when it ends; that
    // delivery is the one the checkout has to be current for.
    let running = true;
    const git = fakeGit({ isCheckoutBusy: mock(async () => running) });
    const deps = { storage: storageWith(), git, now: () => 100 };
    expect(await fastForwardBeforeCoordinatorMail(deps, runtimeId)).toBe("busy");
    running = false;
    expect(await fastForwardBeforeCoordinatorMail(deps, runtimeId)).toBe("fast-forwarded");
    expect(git.fetch).toHaveBeenCalledTimes(1);
  });

  test("a turn starting during fetch releases the fallback's busy cooldown", async () => {
    let running = false;
    let finishFetch!: (status: ProjectGitStatus) => void;
    let fetchAttempts = 0;
    const git = fakeGit({
      isCheckoutBusy: mock(async () => running),
      fetch: mock(() => {
        if (++fetchAttempts > 1) return Promise.resolve(behind);
        running = true;
        return new Promise<ProjectGitStatus>((resolve) => {
          finishFetch = resolve;
        });
      }),
      fastForwardToFetchedUpstream: mock(async () => ({
        outcome: "busy" as const,
        status: null,
      })),
    });
    const deps = { storage: storageWith(), git, timeoutMs: 5, now: () => 100 };
    expect(await fastForwardBeforeCoordinatorMail(deps, runtimeId)).toBe("busy");
    finishFetch(behind);
    await Promise.resolve();
    running = false;
    expect(await fastForwardBeforeCoordinatorMail(deps, runtimeId)).toBe("fast-forwarded");
    expect(git.fetch).toHaveBeenCalledTimes(2);
  });

  test("never throws: a failing lookup or Git service reads as failed", async () => {
    const storage = {
      coordinators: {
        getCoordinatorWorkspaceById: async () => {
          throw new Error("store unavailable");
        },
      },
    } as never;
    expect(await fastForwardBeforeCoordinatorMail({ storage, git: fakeGit() }, runtimeId)).toBe(
      "failed",
    );
    const git = fakeGit({
      isCheckoutBusy: mock(async () => {
        throw new Error("boom");
      }),
    });
    expect(await fastForwardBeforeCoordinatorMail({ storage: storageWith(), git }, runtimeId)).toBe(
      "failed",
    );
    const refused = fakeGit({
      syncAfterMerge: mock(async () => {
        throw new Error("Not possible to fast-forward");
      }),
    });
    expect(
      await fastForwardBeforeCoordinatorMail({ storage: storageWith(), git: refused }, runtimeId),
    ).toBe("failed");
  });
});
