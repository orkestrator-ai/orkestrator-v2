import { afterEach, describe, expect, test } from "bun:test";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import {
  evictNativeAgentHistoryCaches,
  useNativeAgentProjectionStore,
} from "./nativeAgentProjectionStore";

function projection(id: string, messages: unknown[] = []): NativeAgentSessionProjection {
  return {
    platform: "codex",
    environmentId: "env-1",
    sessionId: id,
    connection: "connected",
    turn: { phase: "idle" },
    messages,
    interactions: [],
    composerControls: [],
    capabilities: {
      attachments: { files: false, images: false },
      queue: false,
      resume: false,
      fork: false,
      slashCommands: false,
      backgroundTasks: false,
      composer: {
        provider: false,
        model: false,
        reasoning: false,
        speed: false,
        mode: false,
      },
    },
    revision: 1,
    generation: "generation-1",
  };
}

function seedSession(key: string, historyBytes: number): void {
  const live = projection(`${key}-live`, [{ id: `${key}-live-message` }]);
  useNativeAgentProjectionStore
    .getState()
    .setProjection(
      key,
      projection(`${key}-materialized`, [{ id: `${key}-history-message` }, ...live.messages]),
      {
        token: `${key}-token`,
        liveProjection: live,
        historyEpoch: "epoch-1",
        historyComplete: false,
        historyMessages: [{ id: `${key}-history-message` }],
        historyBytes,
      },
    );
}

afterEach(() => useNativeAgentProjectionStore.getState().reset());

describe("native agent projection history cache", () => {
  test("evicts inactive history while retaining its bounded live projection", () => {
    for (const key of ["session-a", "session-b", "session-c"]) seedSession(key, 8);

    evictNativeAgentHistoryCaches("session-c", 5, 20);

    const state = useNativeAgentProjectionStore.getState();
    expect([...state.syncCaches.keys()]).toEqual(["session-c"]);
    expect(state.projections.get("session-a")?.sessionId).toBe("session-a-live");
    expect(state.projections.get("session-b")?.sessionId).toBe("session-b-live");
    expect(state.projections.get("session-c")?.sessionId).toBe("session-c-materialized");
  });

  test("counts each eviction so a mounted reader can drop its own copy", () => {
    seedSession("session-a", 8);
    seedSession("session-b", 8);

    evictNativeAgentHistoryCaches("session-b", 8, 12);
    expect(useNativeAgentProjectionStore.getState().historyEvictions.get("session-a")).toBe(1);
    expect(useNativeAgentProjectionStore.getState().historyEvictions.has("session-b")).toBe(false);

    // A later mount repopulates the cache; the next eviction must be visible as
    // a change rather than repeating a value the reader already honoured.
    seedSession("session-a", 8);
    evictNativeAgentHistoryCaches("session-b", 8, 12);
    expect(useNativeAgentProjectionStore.getState().historyEvictions.get("session-a")).toBe(2);
  });

  test("does nothing when the retained history already fits", () => {
    seedSession("session-a", 8);

    evictNativeAgentHistoryCaches("session-b", 1, 100);

    expect([...useNativeAgentProjectionStore.getState().syncCaches.keys()]).toEqual(["session-a"]);
    expect(useNativeAgentProjectionStore.getState().historyEvictions.size).toBe(0);
  });

  test("releases the eviction counter once nothing is left to compare against", () => {
    seedSession("session-a", 8);
    seedSession("session-b", 8);
    evictNativeAgentHistoryCaches("session-b", 8, 12);
    expect(useNativeAgentProjectionStore.getState().historyEvictions.has("session-a")).toBe(true);

    useNativeAgentProjectionStore.getState().setProjection("session-a", null, null);

    expect(useNativeAgentProjectionStore.getState().historyEvictions.has("session-a")).toBe(false);
  });
});
