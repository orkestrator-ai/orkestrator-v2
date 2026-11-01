import { describe, expect, test } from "bun:test";
import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import type { CoordinatorPaneLayout } from "@orkestrator/protocol/coordinator-pane-layout";
import { NOTICE_DISMISSAL_LIMITS } from "@orkestrator/protocol/notice-dismissals";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
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

  test("a project's layout and decline are deleted with it", async () => {
    await withTemporaryStorage(async (storage) => {
      const project = await storage.addProject(createProject("https://example.invalid/r.git"));
      storage.clientState.saveCoordinatorPaneLayout(project.id, layout(["a"]), 0);
      storage.clientState.recordCoordinatorUpstreamDecline(project.id, {
        upstream: "origin/main",
        upstreamCommit: "c1",
      });
      await storage.removeProject(project.id);
      expect(storage.clientState.getCoordinatorPaneLayout(project.id)).toBeNull();
      expect(storage.clientState.getCoordinatorUpstreamDecline(project.id)).toBeNull();
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

  test("advertise every capability", async () => {
    await withCommands({}, async (call) => {
      expect(await call("get_client_state_capabilities")).toEqual({
        coordinatorPaneLayouts: true,
        coordinatorUpstreamMerge: true,
        noticeDismissals: true,
        environmentAttention: true,
      });
    });
  });

  test("the upstream merge offer honours stored declines and running turns", async () => {
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
      });
      await call("decline_coordinator_upstream_merge", {
        projectId,
        upstream: "origin/main",
        upstreamCommit: behind.upstreamCommit,
      });
      expect(await call("check_coordinator_upstream_merge", { projectId })).toMatchObject({
        offer: false,
        reason: "declined",
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
