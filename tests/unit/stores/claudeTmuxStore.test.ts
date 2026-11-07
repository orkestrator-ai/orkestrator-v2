import { describe, test, expect, beforeEach } from "bun:test";
import {
  claudeTmuxStore,
  createClaudeTmuxStateKey,
} from "../../../apps/web/src/stores/claudeTmuxStore";
import { seedQueuedPrompt } from "@/stores/testing/queue-projection";
import { appCommandStore } from "../../../apps/web/src/test/app-command-store";

describe("claudeTmuxStore", () => {
  beforeEach(() => {
    appCommandStore(claudeTmuxStore).setState({
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
      appCommandStore(claudeTmuxStore).getState().setBusy("tab-1", true);
      const tab = appCommandStore(claudeTmuxStore).getState().getTab("tab-1");
      expect(tab.busy).toBe(true);
      expect(tab.busyStartedAt).toBeNull();
    });

    test("stores the backend busy clock verbatim", () => {
      appCommandStore(claudeTmuxStore).getState().setBusy("tab-1", true, 1_234);
      expect(appCommandStore(claudeTmuxStore).getState().getTab("tab-1").busyStartedAt).toBe(1_234);
    });

    test("flipping to false clears busyStartedAt", () => {
      appCommandStore(claudeTmuxStore).getState().setBusy("tab-1", true, 1_234);
      appCommandStore(claudeTmuxStore).getState().setBusy("tab-1", false);
      const tab = appCommandStore(claudeTmuxStore).getState().getTab("tab-1");
      expect(tab.busy).toBe(false);
      expect(tab.busyStartedAt).toBeNull();
    });

    test("redundant setBusy(true) preserves original busyStartedAt", () => {
      appCommandStore(claudeTmuxStore).getState().setBusy("tab-1", true, 1_234);
      const first = appCommandStore(claudeTmuxStore).getState().getTab("tab-1");
      const originalStart = first.busyStartedAt;
      // Advance wall-clock perceptibly before the no-op call.
      const wait = new Promise<void>((resolve) => setTimeout(resolve, 5));
      return wait.then(() => {
        appCommandStore(claudeTmuxStore).getState().setBusy("tab-1", true);
        const second = appCommandStore(claudeTmuxStore).getState().getTab("tab-1");
        expect(second.busy).toBe(true);
        // Dedup guard: the timestamp must not be refreshed by a no-op call,
        // otherwise the elapsed counter would reset on every duplicate event.
        expect(second.busyStartedAt).toBe(originalStart);
      });
    });

    test("redundant setBusy(false) is a no-op", () => {
      // Default state already has busy=false; calling setBusy(false) should
      // not allocate a new tab entry with a stale busyStartedAt.
      appCommandStore(claudeTmuxStore).getState().setBusy("tab-1", false);
      const tab = appCommandStore(claudeTmuxStore).getState().getTab("tab-1");
      expect(tab.busy).toBe(false);
      expect(tab.busyStartedAt).toBeNull();
    });

    test("setBusy is scoped per tab", () => {
      appCommandStore(claudeTmuxStore).getState().setBusy("tab-1", true, 1_234);
      appCommandStore(claudeTmuxStore).getState().setBusy("tab-2", false);
      const t1 = appCommandStore(claudeTmuxStore).getState().getTab("tab-1");
      const t2 = appCommandStore(claudeTmuxStore).getState().getTab("tab-2");
      expect(t1.busy).toBe(true);
      expect(t2.busy).toBe(false);
      expect(t1.busyStartedAt).toBe(1_234);
      expect(t2.busyStartedAt).toBeNull();
    });

    test("setBusy preserves other tab fields", () => {
      appCommandStore(claudeTmuxStore)
        .getState()
        .setRunning("tab-1", true, { environmentId: "env-9", sessionId: "s" });
      appCommandStore(claudeTmuxStore).getState().setBusy("tab-1", true);
      const tab = appCommandStore(claudeTmuxStore).getState().getTab("tab-1");
      expect(tab.running).toBe(true);
      expect(tab.environmentId).toBe("env-9");
      expect(tab.sessionId).toBe("s");
      expect(tab.busy).toBe(true);
    });
  });

  describe("getTab fallback", () => {
    test("returns an empty tab state for unknown tabs", () => {
      const tab = appCommandStore(claudeTmuxStore).getState().getTab("never-seen");
      expect(tab.busy).toBe(false);
      expect(tab.busyStartedAt).toBeNull();
      expect(tab.running).toBe(false);
      expect(tab.messages).toEqual([]);
    });

    test("can keep the same tab id isolated across environments", () => {
      const env1Key = createClaudeTmuxStateKey("env-1", "default");
      const env2Key = createClaudeTmuxStateKey("env-2", "default");

      appCommandStore(claudeTmuxStore)
        .getState()
        .setRunning(env1Key, true, { environmentId: "env-1", sessionId: "s-1" });
      appCommandStore(claudeTmuxStore)
        .getState()
        .setRunning(env2Key, true, { environmentId: "env-2", sessionId: "s-2" });

      expect(appCommandStore(claudeTmuxStore).getState().getTab(env1Key).sessionId).toBe("s-1");
      expect(appCommandStore(claudeTmuxStore).getState().getTab(env2Key).sessionId).toBe("s-2");
    });

    test("returns emptyTabState for bare tabId when it matches multiple environments (ambiguous)", () => {
      const env1Key = createClaudeTmuxStateKey("env-1", "default");
      const env2Key = createClaudeTmuxStateKey("env-2", "default");

      appCommandStore(claudeTmuxStore)
        .getState()
        .setRunning(env1Key, true, { environmentId: "env-1", sessionId: "s-1" });
      appCommandStore(claudeTmuxStore)
        .getState()
        .setRunning(env2Key, true, { environmentId: "env-2", sessionId: "s-2" });

      // Bare tabId "default" matches both env-1 and env-2 → ambiguous → emptyTabState
      const tab = appCommandStore(claudeTmuxStore).getState().getTab("default");
      expect(tab.running).toBe(false);
      expect(tab.sessionId).toBeNull();
      expect(tab.messages).toEqual([]);
    });
  });

  describe("resetTab", () => {
    test("clears the busy flag and timestamp", () => {
      appCommandStore(claudeTmuxStore).getState().setBusy("tab-1", true);
      appCommandStore(claudeTmuxStore).getState().resetTab("tab-1");
      const tab = appCommandStore(claudeTmuxStore).getState().getTab("tab-1");
      expect(tab.busy).toBe(false);
      expect(tab.busyStartedAt).toBeNull();
    });

    test("clears per-tab drafts and queue but preserves the effort preference", () => {
      const state = appCommandStore(claudeTmuxStore).getState();
      state.setDraftText("tab-1", "unsent");
      seedQueuedPrompt(state, "tab-1", {
        id: "q-1",
        text: "queued",
        attachments: [],
      });
      state.setEffortLevel("tab-1", "xhigh");

      appCommandStore(claudeTmuxStore).getState().resetTab("tab-1");

      const after = appCommandStore(claudeTmuxStore).getState();
      expect(after.draftText.get("tab-1")).toBeUndefined();
      expect(after.messageQueue.get("tab-1")).toBeUndefined();
      // Effort is a per-tab preference (like the current model selection) and must
      // survive resetTab so it seeds the next launch in that tab.
      expect(after.effortLevels.get("tab-1")).toBe("xhigh");
    });
  });

  describe("setEffortLevel", () => {
    test("stores effort preferences per tab", () => {
      appCommandStore(claudeTmuxStore).getState().setEffortLevel("tab-1", "low");
      appCommandStore(claudeTmuxStore).getState().setEffortLevel("tab-2", "max");

      const state = appCommandStore(claudeTmuxStore).getState();
      expect(state.effortLevels.get("tab-1")).toBe("low");
      expect(state.effortLevels.get("tab-2")).toBe("max");
      expect(state.effortLevels.get("tab-3")).toBeUndefined();
    });

    test("overwrites a previous preference for the same tab", () => {
      appCommandStore(claudeTmuxStore).getState().setEffortLevel("tab-1", "low");
      appCommandStore(claudeTmuxStore).getState().setEffortLevel("tab-1", "high");

      expect(appCommandStore(claudeTmuxStore).getState().effortLevels.get("tab-1")).toBe("high");
    });
  });

  describe("replacePendingHooks", () => {
    test("replaces all pending hook buckets and clears stale entries", () => {
      appCommandStore(claudeTmuxStore).getState().addPendingApproval("tab-1", {
        eventId: "old",
        toolName: "Bash",
        toolInput: {},
        payload: {},
        receivedAt: "old",
      });

      appCommandStore(claudeTmuxStore)
        .getState()
        .replacePendingHooks("tab-1", {
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

      const tab = appCommandStore(claudeTmuxStore).getState().getTab("tab-1");
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
      const store = appCommandStore(claudeTmuxStore).getState();
      store.pushInfoEvent("tab-1", infoEvent("event-1", "Notification", "old"));
      store.pushInfoEvent("tab-1", infoEvent("event-1", "Notification", "new"));

      expect(appCommandStore(claudeTmuxStore).getState().getTab("tab-1").infoEvents).toEqual([
        infoEvent("event-1", "Notification", "new"),
      ]);
    });

    test("retains events that share an id but have different kinds", () => {
      const store = appCommandStore(claudeTmuxStore).getState();
      store.pushInfoEvent("tab-1", infoEvent("event-1", "Notification"));
      store.pushInfoEvent("tab-1", infoEvent("event-1", "Stop"));

      expect(
        appCommandStore(claudeTmuxStore)
          .getState()
          .getTab("tab-1")
          .infoEvents.map(({ id, kind }) => ({ id, kind })),
      ).toEqual([
        { id: "event-1", kind: "Notification" },
        { id: "event-1", kind: "Stop" },
      ]);
    });

    test("keeps dismissal sticky across live delivery and authoritative replacement", () => {
      const store = appCommandStore(claudeTmuxStore).getState();
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
        infoEvents: [{ ...dismissed, message: "authoritative re-delivery" }, infoEvent("visible")],
      });

      const tab = appCommandStore(claudeTmuxStore).getState().getTab("tab-1");
      expect(tab.infoEvents).toEqual([infoEvent("visible")]);
      expect(tab.dismissedInfoEventIds).toEqual(["dismissed"]);
    });

    test("bounds remembered dismissals to the newest 20 ids", () => {
      const store = appCommandStore(claudeTmuxStore).getState();
      for (let index = 0; index < 25; index += 1) {
        store.dismissInfoEvent("tab-1", `event-${index}`);
      }

      expect(
        appCommandStore(claudeTmuxStore).getState().getTab("tab-1").dismissedInfoEventIds,
      ).toEqual(Array.from({ length: 20 }, (_, index) => `event-${index + 5}`));
    });
  });
});
