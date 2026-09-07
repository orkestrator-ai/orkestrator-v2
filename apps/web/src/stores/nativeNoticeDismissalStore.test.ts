import { afterEach, describe, expect, test } from "bun:test";
import { useNativeNoticeDismissalStore } from "./nativeNoticeDismissalStore";

const STORAGE_KEY = "native-notice-dismissals";

afterEach(() => {
  useNativeNoticeDismissalStore.getState().clear();
  localStorage.removeItem(STORAGE_KEY);
});

describe("native notice dismissals", () => {
  test("persists a dismissal and rehydrates it after renderer state is replaced", async () => {
    useNativeNoticeDismissalStore.getState().dismiss("codex/session-a", "occurrence-1");
    const persisted = localStorage.getItem(STORAGE_KEY);
    expect(persisted).not.toBeNull();

    useNativeNoticeDismissalStore.setState({ sessions: [] });
    localStorage.setItem(STORAGE_KEY, persisted!);
    await useNativeNoticeDismissalStore.persist.rehydrate();

    expect(useNativeNoticeDismissalStore.getState().sessions).toEqual([
      {
        sessionIdentity: "codex/session-a",
        occurrenceIds: ["occurrence-1"],
      },
    ]);
  });

  test("keeps occurrence and session retention bounded", () => {
    for (let session = 0; session < 55; session += 1) {
      for (let occurrence = 0; occurrence < 25; occurrence += 1) {
        useNativeNoticeDismissalStore
          .getState()
          .dismiss(`session-${session}`, `occurrence-${occurrence}`);
      }
    }

    const sessions = useNativeNoticeDismissalStore.getState().sessions;
    expect(sessions).toHaveLength(50);
    expect(sessions[0]?.sessionIdentity).toBe("session-5");
    expect(sessions.at(-1)?.occurrenceIds).toHaveLength(20);
    expect(sessions.at(-1)?.occurrenceIds[0]).toBe("occurrence-5");
  });
});
