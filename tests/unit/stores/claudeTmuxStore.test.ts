import { describe, test, expect, beforeEach } from "bun:test";
import { useClaudeTmuxStore } from "../../../src/stores/claudeTmuxStore";

describe("claudeTmuxStore", () => {
  beforeEach(() => {
    useClaudeTmuxStore.setState({ tabs: new Map() });
  });

  describe("setBusy", () => {
    test("flipping to true records busyStartedAt", () => {
      const before = Date.now();
      useClaudeTmuxStore.getState().setBusy("tab-1", true);
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.busy).toBe(true);
      expect(tab.busyStartedAt).not.toBeNull();
      expect(tab.busyStartedAt!).toBeGreaterThanOrEqual(before);
    });

    test("flipping to false clears busyStartedAt", () => {
      useClaudeTmuxStore.getState().setBusy("tab-1", true);
      useClaudeTmuxStore.getState().setBusy("tab-1", false);
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.busy).toBe(false);
      expect(tab.busyStartedAt).toBeNull();
    });

    test("redundant setBusy(true) preserves original busyStartedAt", () => {
      useClaudeTmuxStore.getState().setBusy("tab-1", true);
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
      useClaudeTmuxStore.getState().setBusy("tab-1", true);
      useClaudeTmuxStore.getState().setBusy("tab-2", false);
      const t1 = useClaudeTmuxStore.getState().getTab("tab-1");
      const t2 = useClaudeTmuxStore.getState().getTab("tab-2");
      expect(t1.busy).toBe(true);
      expect(t2.busy).toBe(false);
      expect(t1.busyStartedAt).not.toBeNull();
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
  });

  describe("resetTab", () => {
    test("clears the busy flag and timestamp", () => {
      useClaudeTmuxStore.getState().setBusy("tab-1", true);
      useClaudeTmuxStore.getState().resetTab("tab-1");
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.busy).toBe(false);
      expect(tab.busyStartedAt).toBeNull();
    });
  });
});
