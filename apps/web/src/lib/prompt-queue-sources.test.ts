import { afterEach, describe, expect, test } from "bun:test";
import { createPromptQueueSources } from "./prompt-queue-sources";
import { useClaudeStore } from "@/stores/claudeStore";
import { useClaudeTmuxStore } from "@/stores/claudeTmuxStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";

/**
 * Every adapter reaches its store through `as unknown as AnyQueueStore`, so
 * neither the compiler nor the type system verifies that the store really
 * exposes `messageQueue`. These tests exercise the adapters against the real
 * stores, which is the only thing that would catch a rename on either side.
 */

const stores = {
  claude: useClaudeStore,
  codex: useCodexStore,
  opencode: useOpenCodeStore,
  "claude-tmux": useClaudeTmuxStore,
} as const;

afterEach(() => {
  for (const store of Object.values(stores)) {
    (store as unknown as { setState: (partial: unknown) => void })
      .setState({ messageQueue: new Map() });
  }
});

describe("createPromptQueueSources", () => {
  test("exposes one uniquely namespaced source per agent", () => {
    const agents = createPromptQueueSources().map((source) => source.agent);
    expect(agents.sort()).toEqual(["claude", "claude-tmux", "codex", "opencode"]);
    expect(new Set(agents).size).toBe(agents.length);
  });

  test("no agent namespace contains the key separator", () => {
    // promptQueueKey joins on a NUL and parses at the first one, so a namespace
    // containing one would decode as a different agent.
    for (const source of createPromptQueueSources()) {
      expect(source.agent).not.toContain("\u0000");
      expect(source.agent.length).toBeGreaterThan(0);
    }
  });
});

describe("store adapters", () => {
  for (const [agent, store] of Object.entries(stores)) {
    describe(agent, () => {
      test("reads the store's live messageQueue map", () => {
        const source = createPromptQueueSources().find((entry) => entry.agent === agent)!;
        expect(source.getQueues()).toBeInstanceOf(Map);
        expect(source.getQueues()).toBe(
          (store.getState() as { messageQueue: unknown }).messageQueue as never,
        );
      });

      test("setQueue writes through to the store with a fresh map identity", () => {
        const source = createPromptQueueSources().find((entry) => entry.agent === agent)!;
        const before = source.getQueues();

        source.setQueue("session-key", [{ id: "a" }]);

        const after = source.getQueues();
        expect(after.get("session-key")).toEqual([{ id: "a" }]);
        // Zustand selectors detect the projection change by map identity.
        expect(after).not.toBe(before);
      });

      test("setQueue skips an identical application so hydration cannot loop", () => {
        const source = createPromptQueueSources().find((entry) => entry.agent === agent)!;
        source.setQueue("session-key", [{ id: "a" }]);
        const applied = source.getQueues();

        source.setQueue("session-key", [{ id: "a" }]);

        expect(source.getQueues()).toBe(applied);
      });

    });
  }
});

describe("environmentIdFor", () => {
  test("recovers the environment from the shared native session key", () => {
    for (const agent of ["claude", "codex", "opencode"]) {
      const source = createPromptQueueSources().find((entry) => entry.agent === agent)!;
      expect(source.environmentIdFor("env-abc123:tab-1")).toBe("abc123");
    }
  });

  test("returns null for a key carrying no recoverable environment", () => {
    // An unscoped queue could never be cleaned up when its environment goes,
    // so the adapter must be able to recognise one and decline to scope it.
    for (const source of createPromptQueueSources()) {
      expect(source.environmentIdFor("nonsense")).toBeNull();
    }
  });

  test("tmux recovers the environment from its own scoped key form", () => {
    const source = createPromptQueueSources().find((entry) => entry.agent === "claude-tmux")!;
    expect(source.environmentIdFor("env:abc123:tab:tab-1")).toBe("abc123");
  });
});
