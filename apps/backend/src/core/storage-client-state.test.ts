import { describe, expect, test } from "bun:test";
import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import type { CoordinatorPaneLayout } from "@orkestrator/protocol/coordinator-pane-layout";
import { COORDINATOR_ACTION_MARK_LIMITS } from "@orkestrator/protocol/coordinator-action-marks";
import { NOTICE_DISMISSAL_LIMITS } from "@orkestrator/protocol/notice-dismissals";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { COORDINATOR_ACTION_MARKS_FULL_ERROR } from "./storage-client-state.js";
import { createProject, StorageService } from "./storage.js";
import { withTemporaryStorage } from "./storage-test-support.js";

const layout = (conversationIds: string[]): CoordinatorPaneLayout => ({
  root: {
    kind: "leaf",
    id: "pane-1",
    conversationIds,
    activeConversationId: conversationIds[0] ?? null,
  },
  activePaneId: "pane-1",
});

const behind: ProjectGitStatus = {
  projectId: "p",
  repositoryRoot: "/checkout",
  revision: 1,
  branch: "main",
  detached: false,
  unborn: false,
  headCommit: "a".repeat(40),
  upstream: "origin/main",
  upstreamCommit: "b".repeat(40),
  remote: "origin",
  ahead: 0,
  behind: 2,
  remoteState: "fresh",
  fetchedAt: null,
  trackedChanges: 0,
  untrackedChanges: 0,
  conflicts: 0,
  mergeInProgress: false,
  rebaseInProgress: false,
  sequencerInProgress: false,
  operationState: "idle",
  repositoryOperationBlockedReason: null,
  branches: [],
  lastError: null,
};

describe("client state storage", () => {
  test("coordinator layouts are revision-checked per project and announced", async () => {
    await withTemporaryStorage(async (storage) => {
      const changes: ResourceChange[] = [];
      storage.addResourceChangeListener((change) => changes.push(change));
      const state = storage.clientState;
      expect(state.getCoordinatorPaneLayout("p")).toBeNull();

      const first = state.saveCoordinatorPaneLayout("p", layout(["a"]), 0);
      expect(first).toMatchObject({ status: "saved", record: { revision: 1, projectId: "p" } });
      // A second client still at revision 0 loses and is handed the stored layout.
      const stale = state.saveCoordinatorPaneLayout("p", layout(["b"]), 0);
      expect(stale.status).toBe("conflict");
      expect(stale.status === "conflict" && stale.current?.layout).toEqual(layout(["a"]));
      const second = state.saveCoordinatorPaneLayout("p", layout(["a", "b"]), 1);
      expect(second.status === "saved" && second.record.revision).toBe(2);
      expect(state.getCoordinatorPaneLayout("p")?.layout).toEqual(layout(["a", "b"]));
      expect(
        changes.filter((change) => change.resource === "coordinator-pane-layout"),
      ).toHaveLength(2);

      expect(() => state.saveCoordinatorPaneLayout("p", { root: "nope" }, 2)).toThrow(
        "not a valid coordinator pane layout",
      );
    });
  });

  test("a decline only-if-absent never replaces a newer answer", async () => {
    await withTemporaryStorage(async (storage) => {
      const state = storage.clientState;
      state.recordCoordinatorUpstreamDecline("p", {
        upstream: "origin/main",
        upstreamCommit: "c1",
      });
      expect(
        state.recordCoordinatorUpstreamDecline(
          "p",
          { upstream: "origin/main", upstreamCommit: "old" },
          { onlyIfAbsent: true },
        ),
      ).toEqual({ upstream: "origin/main", upstreamCommit: "c1" });
      state.recordCoordinatorUpstreamDecline("p", {
        upstream: "origin/main",
        upstreamCommit: "c2",
      });
      expect(state.getCoordinatorUpstreamDecline("p")?.upstreamCommit).toBe("c2");
    });
  });

  test("auto-merge is set per project and turning it off removes the row", async () => {
    await withTemporaryStorage(async (storage) => {
      const state = storage.clientState;
      expect(state.getCoordinatorUpstreamAutoMerge("p")).toBe(false);
      expect(state.setCoordinatorUpstreamAutoMerge("p", true)).toBe(true);
      expect(state.getCoordinatorUpstreamAutoMerge("p")).toBe(true);
      expect(state.getCoordinatorUpstreamAutoMerge("q")).toBe(false);
      expect(state.setCoordinatorUpstreamAutoMerge("p", false)).toBe(false);
      expect(state.getCoordinatorUpstreamAutoMerge("p")).toBe(false);
      expect(state.setCoordinatorUpstreamAutoMerge("p", false)).toBe(false);
    });
  });

  test("a project's layout and decline are deleted with it", async () => {
    await withTemporaryStorage(async (storage) => {
      const project = await storage.addProject(createProject("https://example.invalid/r.git"));
      storage.clientState.saveCoordinatorPaneLayout(project.id, layout(["a"]), 0);
      storage.clientState.recordCoordinatorUpstreamDecline(project.id, {
        upstream: "origin/main",
        upstreamCommit: "c1",
      });
      storage.clientState.setCoordinatorUpstreamAutoMerge(project.id, true);
      await storage.removeProject(project.id);
      expect(storage.clientState.getCoordinatorPaneLayout(project.id)).toBeNull();
      expect(storage.clientState.getCoordinatorUpstreamDecline(project.id)).toBeNull();
      expect(storage.clientState.getCoordinatorUpstreamAutoMerge(project.id)).toBe(false);
    });
  });

  test("auto merge preferences survive reopening storage", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      storage.clientState.setCoordinatorUpstreamAutoMerge("enabled", true);
      storage.clientState.setCoordinatorUpstreamAutoMerge("disabled", true);
      storage.clientState.setCoordinatorUpstreamAutoMerge("disabled", false);
      const reopened = new StorageService(dataDir);
      await reopened.init();
      expect(reopened.clientState.getCoordinatorUpstreamAutoMerge("enabled")).toBe(true);
      expect(reopened.clientState.getCoordinatorUpstreamAutoMerge("disabled")).toBe(false);
      expect(reopened.clientState.getCoordinatorUpstreamAutoMerge("absent")).toBe(false);
    });
  });

  test("notice dismissals merge, reconcile, stay bounded and survive a reopen", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const state = storage.clientState;
      state.dismissNotices([{ sessionIdentity: "s1", occurrenceIds: ["n1"] }]);
      const merged = state.dismissNotices([
        { sessionIdentity: "s1", occurrenceIds: ["n2", "n1"] },
        { sessionIdentity: "s2", occurrenceIds: ["x"] },
      ]);
      expect(merged.sessions).toEqual([
        { sessionIdentity: "s1", occurrenceIds: ["n2", "n1"] },
        { sessionIdentity: "s2", occurrenceIds: ["x"] },
      ]);
      const unchanged = state.dismissNotices([{ sessionIdentity: "s2", occurrenceIds: ["x"] }]);
      expect(unchanged.revision).toBe(merged.revision);

      const reconciled = state.reconcileNoticeDismissals("s1", ["n1"]);
      expect(reconciled.sessions.find((s) => s.sessionIdentity === "s1")?.occurrenceIds).toEqual([
        "n1",
      ]);
      expect(
        state.reconcileNoticeDismissals("s2", []).sessions.some((s) => s.sessionIdentity === "s2"),
      ).toBe(false);

      state.dismissNotices(
        Array.from({ length: NOTICE_DISMISSAL_LIMITS.sessions + 5 }, (_, index) => ({
          sessionIdentity: `bulk-${index}`,
          occurrenceIds: ["n"],
        })).slice(-NOTICE_DISMISSAL_LIMITS.sessionsPerRequest),
      );
      state.dismissNotices([{ sessionIdentity: "latest", occurrenceIds: ["n"] }]);
      const bounded = state.listNoticeDismissals();
      expect(bounded.sessions.length).toBe(NOTICE_DISMISSAL_LIMITS.sessions);
      expect(bounded.sessions.at(-1)?.sessionIdentity).toBe("latest");

      const reopened = new StorageService(dataDir);
      await reopened.init();
      expect(reopened.clientState.listNoticeDismissals()).toEqual(bounded);
    });
  });
});

describe("coordinator action marks", () => {
  test("marks are per conversation, idempotent, announced and never leak", async () => {
    await withTemporaryStorage(async (storage) => {
      const changes: ResourceChange[] = [];
      storage.addResourceChangeListener((change) => changes.push(change));
      const state = storage.clientState;
      expect(state.getCoordinatorActionMarks("p", "c1")).toEqual({
        projectId: "p",
        conversationId: "c1",
        revision: 0,
        cardIds: [],
      });

      const first = state.setCoordinatorActionMark("p", "c1", "toolu_1", true);
      expect(first).toEqual({
        projectId: "p",
        conversationId: "c1",
        revision: 1,
        cardIds: ["toolu_1"],
      });
      // The same mark again changes nothing and keeps the revision.
      expect(state.setCoordinatorActionMark("p", "c1", "toolu_1", true).revision).toBe(1);
      const second = state.setCoordinatorActionMark("p", "c1", ":pr:https://x/pull/2", true);
      expect(second.cardIds).toEqual(["toolu_1", ":pr:https://x/pull/2"]);

      // Another conversation, and the same conversation id in another project, see nothing.
      expect(state.getCoordinatorActionMarks("p", "c2").cardIds).toEqual([]);
      expect(state.getCoordinatorActionMarks("q", "c1").cardIds).toEqual([]);

      const cleared = state.setCoordinatorActionMark("p", "c1", "toolu_1", false);
      expect(cleared).toMatchObject({ revision: 3, cardIds: [":pr:https://x/pull/2"] });
      // Clearing a mark that is not there changes nothing.
      expect(state.setCoordinatorActionMark("p", "c1", "toolu_1", false).revision).toBe(3);
      // The last mark cleared keeps the row, so the revision keeps moving forward.
      state.setCoordinatorActionMark("p", "c1", ":pr:https://x/pull/2", false);
      expect(state.getCoordinatorActionMarks("p", "c1")).toMatchObject({
        revision: 4,
        cardIds: [],
      });

      expect(
        changes
          .filter((change) => change.resource === "coordinator-action-marks")
          .map(({ id, projectId }) => ({ id, projectId })),
      ).toEqual(Array.from({ length: 4 }, () => ({ id: "c1", projectId: "p" })));
      expect(() => state.setCoordinatorActionMark("p", "c1", "", true)).toThrow("cardId");
    });
  });

  test("a full conversation refuses a further mark instead of evicting one", async () => {
    await withTemporaryStorage(async (storage) => {
      const state = storage.clientState;
      for (let index = 0; index < COORDINATOR_ACTION_MARK_LIMITS.marksPerConversation; index += 1) {
        state.setCoordinatorActionMark("p", "c", `card-${index}`, true);
      }
      expect(() => state.setCoordinatorActionMark("p", "c", "one-more", true)).toThrow(
        COORDINATOR_ACTION_MARKS_FULL_ERROR,
      );
      const stored = state.getCoordinatorActionMarks("p", "c");
      expect(stored.cardIds).toHaveLength(COORDINATOR_ACTION_MARK_LIMITS.marksPerConversation);
      expect(stored.cardIds[0]).toBe("card-0");
      // Clearing one makes room again.
      state.setCoordinatorActionMark("p", "c", "card-0", false);
      expect(state.setCoordinatorActionMark("p", "c", "one-more", true).cardIds.at(-1)).toBe(
        "one-more",
      );
    });
  });

  test("marks survive reopening storage and go with their project", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const project = await storage.addProject(createProject("https://example.invalid/r.git"));
      const other = await storage.addProject(createProject("https://example.invalid/s.git"));
      storage.clientState.setCoordinatorActionMark(project.id, "c1", "a", true);
      storage.clientState.setCoordinatorActionMark(project.id, "c2", "b", true);
      storage.clientState.setCoordinatorActionMark(other.id, "c1", "c", true);

      const reopened = new StorageService(dataDir);
      await reopened.init();
      expect(reopened.clientState.getCoordinatorActionMarks(project.id, "c1")).toMatchObject({
        revision: 1,
        cardIds: ["a"],
      });
      expect(reopened.clientState.getCoordinatorActionMarks(project.id, "c2").cardIds).toEqual([
        "b",
      ]);

      const changes: ResourceChange[] = [];
      reopened.addResourceChangeListener((change) => changes.push(change));
      await reopened.removeProject(project.id);
      expect(reopened.clientState.getCoordinatorActionMarks(project.id, "c1").cardIds).toEqual([]);
      expect(reopened.clientState.getCoordinatorActionMarks(project.id, "c2").cardIds).toEqual([]);
      expect(reopened.clientState.getCoordinatorActionMarks(other.id, "c1").cardIds).toEqual(["c"]);
      expect(
        changes
          .filter((change) => change.resource === "coordinator-action-marks")
          .map(({ id, deleted }) => ({ id, deleted }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual([
        { id: "c1", deleted: true },
        { id: "c2", deleted: true },
      ]);
    });
  });
});

describe("client state commands", () => {
  async function withCommands(
    projectGit: Partial<NonNullable<CommandContext["projectGit"]>>,
    run: (
      call: (name: string, args?: Record<string, unknown>) => Promise<unknown>,
      projectId: string,
    ) => Promise<void>,
  ) {
    await withTemporaryStorage(async (storage) => {
      const project = await storage.addProject(createProject("https://example.invalid/r.git"));
      const commands = createCommandRegistry();
      const context = { storage, projectGit } as unknown as CommandContext;
      await run(async (name, args = {}) => commands.get(name)!(args, context), project.id);
    });
  }

  test("advertise every capability but the retired auto-merge setting", async () => {
    await withCommands({}, async (call) => {
      expect(await call("get_client_state_capabilities")).toEqual({
        coordinatorPaneLayouts: true,
        coordinatorUpstreamMerge: true,
        coordinatorUpstreamAutoMerge: false,
        noticeDismissals: true,
        environmentAttention: true,
      });
    });
  });

  test("a mergeable checkout is always merged automatically, except under a running turn", async () => {
    let busy = false;
    let fetches = 0;
    const projectGit = {
      isCheckoutBusy: async () => busy,
      fetch: async () => {
        fetches += 1;
        return behind;
      },
    };
    await withCommands(projectGit, async (call, projectId) => {
      expect(await call("check_coordinator_upstream_merge", { projectId })).toEqual({
        offer: true,
        status: behind,
        automatic: true,
      });
      busy = true;
      const before = fetches;
      expect(await call("check_coordinator_upstream_merge", { projectId })).toEqual({
        offer: false,
        reason: "turn-running",
        status: null,
      });
      expect(fetches).toBe(before);
      await expect(
        call("check_coordinator_upstream_merge", { projectId: "missing" }),
      ).rejects.toThrow("Project not found");
    });
  });

  test("a decline or the auto-merge setting an older client stores no longer holds a merge back", async () => {
    const projectGit = { isCheckoutBusy: async () => false, fetch: async () => behind };
    await withCommands(projectGit, async (call, projectId) => {
      await call("decline_coordinator_upstream_merge", {
        projectId,
        upstream: "origin/main",
        upstreamCommit: behind.upstreamCommit,
      });
      expect(
        await call("set_coordinator_upstream_auto_merge", { projectId, enabled: false }),
      ).toEqual({ enabled: false });
      expect(await call("check_coordinator_upstream_merge", { projectId })).toEqual({
        offer: true,
        status: behind,
        automatic: true,
      });
      // The retired commands still validate what older clients send.
      await expect(
        call("set_coordinator_upstream_auto_merge", { projectId, enabled: "yes" }),
      ).rejects.toThrow("enabled must be a boolean");
      await expect(
        call("set_coordinator_upstream_auto_merge", { projectId: "missing", enabled: true }),
      ).rejects.toThrow("Project not found");
    });
  });

  test("a failed fetch still fast-forwards to the upstream commit already fetched", async () => {
    // A slow or unreachable remote: the fetch reports failure, but the two
    // upstream commits are already on disk and the checkout is clean.
    const stale = {
      ...behind,
      remoteState: "stale",
      lastError: { operation: "fetch", message: "Permission denied (publickey)" },
    };
    const merged = { ...behind, behind: 0 };
    let localMerges = 0;
    const projectGit = {
      isCheckoutBusy: async () => false,
      fetch: async () => stale,
      fastForwardToFetchedUpstream: async () => {
        localMerges += 1;
        return { outcome: "fast-forwarded" as const, status: merged };
      },
    };
    await withCommands(projectGit as never, async (call, projectId) => {
      expect(await call("check_coordinator_upstream_merge", { projectId })).toEqual({
        offer: false,
        reason: "fast-forwarded",
        status: merged,
      });
      expect(localMerges).toBe(1);
    });
  });

  test("a blocked checkout is not offered", async () => {
    const projectGit = {
      isCheckoutBusy: async () => false,
      fetch: async () => ({ ...behind, trackedChanges: 1 }),
    };
    await withCommands(projectGit, async (call, projectId) => {
      expect(await call("check_coordinator_upstream_merge", { projectId })).toMatchObject({
        offer: false,
        reason: "blocked",
      });
    });
  });

  test("layout saves reject a malformed revision and unknown projects", async () => {
    await withCommands({}, async (call, projectId) => {
      await expect(
        call("save_coordinator_pane_layout", {
          projectId,
          layout: layout(["a"]),
          expectedRevision: -1,
        }),
      ).rejects.toThrow("expectedRevision");
      await expect(
        call("save_coordinator_pane_layout", {
          projectId: "missing",
          layout: layout(["a"]),
          expectedRevision: 0,
        }),
      ).rejects.toThrow("Project not found");
      expect(
        await call("save_coordinator_pane_layout", {
          projectId,
          layout: layout(["a"]),
          expectedRevision: 0,
        }),
      ).toMatchObject({ status: "saved" });
      expect(await call("get_coordinator_pane_layout", { projectId })).toMatchObject({
        revision: 1,
      });
    });
  });
});

describe("coordinator action mark commands", () => {
  async function withConversations(
    run: (
      call: (name: string, args?: Record<string, unknown>) => Promise<unknown>,
      projectId: string,
    ) => Promise<void>,
  ) {
    await withTemporaryStorage(async (storage) => {
      const project = await storage.addProject(createProject("https://example.invalid/r.git"));
      // Only the workspace's conversation list matters to these commands.
      const coordinators = {
        getCoordinatorWorkspace: async (projectId: string) =>
          projectId === project.id
            ? { conversations: [{ id: "conv-open" }, { id: "conv-closed", closedAt: "x" }] }
            : null,
      };
      const scoped = Object.assign(Object.create(storage) as StorageService, { coordinators });
      const commands = createCommandRegistry();
      const context = { storage: scoped } as unknown as CommandContext;
      await run(async (name, args = {}) => commands.get(name)!(args, context), project.id);
    });
  }

  test("read and set a conversation's marks, closed conversations included", async () => {
    await withConversations(async (call, projectId) => {
      expect(
        await call("get_coordinator_action_marks", { projectId, conversationId: "conv-open" }),
      ).toEqual({ projectId, conversationId: "conv-open", revision: 0, cardIds: [] });
      expect(
        await call("set_coordinator_action_mark", {
          projectId,
          conversationId: "conv-open",
          cardId: "toolu_1",
          done: true,
        }),
      ).toEqual({ projectId, conversationId: "conv-open", revision: 1, cardIds: ["toolu_1"] });
      expect(
        await call("set_coordinator_action_mark", {
          projectId,
          conversationId: "conv-closed",
          cardId: "toolu_2",
          done: true,
        }),
      ).toMatchObject({ cardIds: ["toolu_2"] });
      expect(
        await call("get_coordinator_action_marks", { projectId, conversationId: "conv-open" }),
      ).toMatchObject({ cardIds: ["toolu_1"] });
    });
  });

  test("refuse unknown projects, unknown conversations and malformed marks", async () => {
    await withConversations(async (call, projectId) => {
      await expect(
        call("get_coordinator_action_marks", { projectId: "missing", conversationId: "conv-open" }),
      ).rejects.toThrow("Project not found");
      await expect(
        call("get_coordinator_action_marks", { projectId, conversationId: "elsewhere" }),
      ).rejects.toThrow("Coordinator conversation not found");
      await expect(
        call("set_coordinator_action_mark", {
          projectId,
          conversationId: "conv-open",
          cardId: "toolu_1",
          done: "yes",
        }),
      ).rejects.toThrow();
      await expect(
        call("set_coordinator_action_mark", {
          projectId,
          conversationId: "conv-open",
          cardId: " ",
          done: true,
        }),
      ).rejects.toThrow("cardId");
    });
  });
});
