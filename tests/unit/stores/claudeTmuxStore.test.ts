import { describe, test, expect, beforeEach } from "bun:test";
import {
  createClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "../../../apps/web/src/stores/claudeTmuxStore";
import { seedQueuedPrompt } from "@/stores/testing/queue-projection";

describe("claudeTmuxStore", () => {
  beforeEach(() => {
    useClaudeTmuxStore.setState({
      tabs: new Map(),
      attachments: new Map(),
      draftText: new Map(),
      draftMentions: new Map(),
      messageQueue: new Map(),
      effortLevels: new Map(),
    });
  });

  describe("setBusy", () => {
    test("flipping to true without a backend clock does not invent busyStartedAt", () => {
      useClaudeTmuxStore.getState().setBusy("tab-1", true);
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.busy).toBe(true);
      expect(tab.busyStartedAt).toBeNull();
    });

    test("stores the backend busy clock verbatim", () => {
      useClaudeTmuxStore.getState().setBusy("tab-1", true, 1_234);
      expect(useClaudeTmuxStore.getState().getTab("tab-1").busyStartedAt).toBe(1_234);
    });

    test("flipping to false clears busyStartedAt", () => {
      useClaudeTmuxStore.getState().setBusy("tab-1", true, 1_234);
      useClaudeTmuxStore.getState().setBusy("tab-1", false);
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.busy).toBe(false);
      expect(tab.busyStartedAt).toBeNull();
    });

    test("redundant setBusy(true) preserves original busyStartedAt", () => {
      useClaudeTmuxStore.getState().setBusy("tab-1", true, 1_234);
      const first = useClaudeTmuxStore.getState().getTab("tab-1");
      const originalStart = first.busyStartedAt;
      // Advance wall-clock perceptibly before the no-op call.
      const wait = new Promise<void>((resolve) => setTimeout(resolve, 5));
      return wait.then(() => {
        useClaudeTmuxStore.getState().setBusy("tab-1", true);
        const second = useClaudeTmuxStore.getState().getTab("tab-1");
        expect(second.busy).toBe(true);
        // Dedup guard: the timestamp must not be refreshed by a no-op call,
        // otherwise the elapsed counter would reset on every duplicate event.
        expect(second.busyStartedAt).toBe(originalStart);
      });
    });

    test("redundant setBusy(false) is a no-op", () => {
      // Default state already has busy=false; calling setBusy(false) should
      // not allocate a new tab entry with a stale busyStartedAt.
      useClaudeTmuxStore.getState().setBusy("tab-1", false);
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.busy).toBe(false);
      expect(tab.busyStartedAt).toBeNull();
    });

    test("setBusy is scoped per tab", () => {
      useClaudeTmuxStore.getState().setBusy("tab-1", true, 1_234);
      useClaudeTmuxStore.getState().setBusy("tab-2", false);
      const t1 = useClaudeTmuxStore.getState().getTab("tab-1");
      const t2 = useClaudeTmuxStore.getState().getTab("tab-2");
      expect(t1.busy).toBe(true);
      expect(t2.busy).toBe(false);
      expect(t1.busyStartedAt).toBe(1_234);
      expect(t2.busyStartedAt).toBeNull();
    });

    test("setBusy preserves other tab fields", () => {
      useClaudeTmuxStore
        .getState()
        .setRunning("tab-1", true, { environmentId: "env-9", sessionId: "s" });
      useClaudeTmuxStore.getState().setBusy("tab-1", true);
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.running).toBe(true);
      expect(tab.environmentId).toBe("env-9");
      expect(tab.sessionId).toBe("s");
      expect(tab.busy).toBe(true);
    });
  });

  describe("getTab fallback", () => {
    test("returns an empty tab state for unknown tabs", () => {
      const tab = useClaudeTmuxStore.getState().getTab("never-seen");
      expect(tab.busy).toBe(false);
      expect(tab.busyStartedAt).toBeNull();
      expect(tab.running).toBe(false);
      expect(tab.messages).toEqual([]);
    });

    test("can keep the same tab id isolated across environments", () => {
      const env1Key = createClaudeTmuxStateKey("env-1", "default");
      const env2Key = createClaudeTmuxStateKey("env-2", "default");

      useClaudeTmuxStore
        .getState()
        .setRunning(env1Key, true, { environmentId: "env-1", sessionId: "s-1" });
      useClaudeTmuxStore
        .getState()
        .setRunning(env2Key, true, { environmentId: "env-2", sessionId: "s-2" });

      expect(useClaudeTmuxStore.getState().getTab(env1Key).sessionId).toBe("s-1");
      expect(useClaudeTmuxStore.getState().getTab(env2Key).sessionId).toBe("s-2");
    });

    test("returns emptyTabState for bare tabId when it matches multiple environments (ambiguous)", () => {
      const env1Key = createClaudeTmuxStateKey("env-1", "default");
      const env2Key = createClaudeTmuxStateKey("env-2", "default");

      useClaudeTmuxStore
        .getState()
        .setRunning(env1Key, true, { environmentId: "env-1", sessionId: "s-1" });
      useClaudeTmuxStore
        .getState()
        .setRunning(env2Key, true, { environmentId: "env-2", sessionId: "s-2" });

      // Bare tabId "default" matches both env-1 and env-2 → ambiguous → emptyTabState
      const tab = useClaudeTmuxStore.getState().getTab("default");
      expect(tab.running).toBe(false);
      expect(tab.sessionId).toBeNull();
      expect(tab.messages).toEqual([]);
    });
  });

  describe("resetTab", () => {
    test("clears the busy flag and timestamp", () => {
      useClaudeTmuxStore.getState().setBusy("tab-1", true);
      useClaudeTmuxStore.getState().resetTab("tab-1");
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.busy).toBe(false);
      expect(tab.busyStartedAt).toBeNull();
    });

    test("clears per-tab drafts and queue but preserves the effort preference", () => {
      const state = useClaudeTmuxStore.getState();
      state.setDraftText("tab-1", "unsent");
      seedQueuedPrompt(state, "tab-1", {
        id: "q-1",
        text: "queued",
        attachments: [],
      });
      state.setEffortLevel("tab-1", "xhigh");

      useClaudeTmuxStore.getState().resetTab("tab-1");

      const after = useClaudeTmuxStore.getState();
      expect(after.draftText.get("tab-1")).toBeUndefined();
      expect(after.messageQueue.get("tab-1")).toBeUndefined();
      // Effort is a per-tab preference (like the model default) and must
      // survive resetTab so it seeds the next launch in that tab.
      expect(after.effortLevels.get("tab-1")).toBe("xhigh");
    });
  });

  describe("setEffortLevel", () => {
    test("stores effort preferences per tab", () => {
      useClaudeTmuxStore.getState().setEffortLevel("tab-1", "low");
      useClaudeTmuxStore.getState().setEffortLevel("tab-2", "max");

      const state = useClaudeTmuxStore.getState();
      expect(state.effortLevels.get("tab-1")).toBe("low");
      expect(state.effortLevels.get("tab-2")).toBe("max");
      expect(state.effortLevels.get("tab-3")).toBeUndefined();
    });

    test("overwrites a previous preference for the same tab", () => {
      useClaudeTmuxStore.getState().setEffortLevel("tab-1", "low");
      useClaudeTmuxStore.getState().setEffortLevel("tab-1", "high");

      expect(useClaudeTmuxStore.getState().effortLevels.get("tab-1")).toBe(
        "high",
      );
    });
  });

  describe("replacePendingHooks", () => {
    test("replaces all pending hook buckets and clears stale entries", () => {
      useClaudeTmuxStore.getState().addPendingApproval("tab-1", {
        eventId: "old",
        toolName: "Bash",
        toolInput: {},
        payload: {},
        receivedAt: "old",
      });

      useClaudeTmuxStore.getState().replacePendingHooks("tab-1", {
        approvals: [],
        questions: [
          {
            eventId: "question",
            questions: [],
            toolInput: {},
            payload: {},
            receivedAt: "now",
          },
        ],
        plans: [],
        permissions: [
          {
            eventId: "permission",
            toolName: "Bash",
            toolInput: { command: "bun test" },
            permissionSuggestions: [],
            payload: {},
            receivedAt: "now",
          },
        ],
        elicitations: [],
      });

      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.pendingApprovals).toEqual([]);
      expect(tab.pendingQuestions.map((q) => q.eventId)).toEqual(["question"]);
      expect(tab.pendingPermissions.map((p) => p.eventId)).toEqual(["permission"]);
    });
  });

  describe("informational hook events", () => {
    const infoEvent = (
      id: string,
      kind: "Notification" | "Stop" = "Notification",
      message = id,
    ) => ({
      id,
      kind,
      message,
      receivedAt: `received-${message}`,
    });

    test("replaces a re-delivered event with the same id and kind", () => {
      const store = useClaudeTmuxStore.getState();
      store.pushInfoEvent("tab-1", infoEvent("event-1", "Notification", "old"));
      store.pushInfoEvent("tab-1", infoEvent("event-1", "Notification", "new"));

      expect(useClaudeTmuxStore.getState().getTab("tab-1").infoEvents).toEqual([
        infoEvent("event-1", "Notification", "new"),
      ]);
    });

    test("retains events that share an id but have different kinds", () => {
      const store = useClaudeTmuxStore.getState();
      store.pushInfoEvent("tab-1", infoEvent("event-1", "Notification"));
      store.pushInfoEvent("tab-1", infoEvent("event-1", "Stop"));

      expect(
        useClaudeTmuxStore
          .getState()
          .getTab("tab-1")
          .infoEvents.map(({ id, kind }) => ({ id, kind })),
      ).toEqual([
        { id: "event-1", kind: "Notification" },
        { id: "event-1", kind: "Stop" },
      ]);
    });

    test("keeps dismissal sticky across live delivery and authoritative replacement", () => {
      const store = useClaudeTmuxStore.getState();
      const dismissed = infoEvent("dismissed");
      store.pushInfoEvent("tab-1", dismissed);
      store.dismissInfoEvent("tab-1", dismissed.id);

      store.pushInfoEvent("tab-1", { ...dismissed, message: "live re-delivery" });
      store.replacePendingHooks("tab-1", {
        approvals: [],
        questions: [],
        plans: [],
        permissions: [],
        elicitations: [],
        infoEvents: [
          { ...dismissed, message: "authoritative re-delivery" },
          infoEvent("visible"),
        ],
      });

      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.infoEvents).toEqual([infoEvent("visible")]);
      expect(tab.dismissedInfoEventIds).toEqual(["dismissed"]);
    });

    test("bounds remembered dismissals to the newest 20 ids", () => {
      const store = useClaudeTmuxStore.getState();
      for (let index = 0; index < 25; index += 1) {
        store.dismissInfoEvent("tab-1", `event-${index}`);
      }

      expect(
        useClaudeTmuxStore.getState().getTab("tab-1").dismissedInfoEventIds,
      ).toEqual(Array.from({ length: 20 }, (_, index) => `event-${index + 5}`));
    });
  });
});
