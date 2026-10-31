import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { sessionGoal, type NativeAgentGoal } from "@orkestrator/protocol/native-agent-goal";
import { StorageService } from "./storage.js";

const input = {
  key: "claude-goal-session-key",
  environmentId: "env-1",
  agent: "claude" as const,
  logicalSessionKey: "env-env-1:tab-1",
  origin: "interactive-native" as const,
  interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
};

function goal(overrides: Partial<NativeAgentGoal> = {}): NativeAgentGoal {
  return {
    goalId: "g1",
    objective: "Make the tests pass",
    status: "active",
    providerSessionId: "provider-1",
    iterations: 0,
    maxIterations: 20,
    noProgressStreak: 0,
    setAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

async function withStorage(
  run: (storage: StorageService, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-goal-storage-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: dataDir,
  });
  await storage.adoptNativeAgentSession({ ...input, providerSessionId: "provider-1" });
  try {
    await run(storage, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("native agent goal storage", () => {
  test("a session with no goal loads unchanged", async () => {
    await withStorage(async (storage) => {
      const session = await storage.getNativeAgentSession(input.key);
      expect(session?.goal).toBeUndefined();
      expect(session?.goalHistory).toBeUndefined();
    });
  });

  test("a goal survives a restart, on the session record", async () => {
    await withStorage(async (storage, dataDir) => {
      await storage.updateNativeAgentGoal(input.key, () => goal());
      const restarted = new StorageService(dataDir);
      await restarted.init();
      const session = await restarted.getNativeAgentSession(input.key);
      expect(sessionGoal(session!)?.goalId).toBe("g1");
    });
  });

  test("undefined changes nothing, and a missing session reports so", async () => {
    await withStorage(async (storage) => {
      await storage.updateNativeAgentGoal(input.key, () => goal());
      const before = await storage.getNativeAgentSession(input.key);
      const after = await storage.updateNativeAgentGoal(input.key, () => undefined);
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(await storage.updateNativeAgentGoal("missing", () => goal())).toBeUndefined();
    });
  });

  test("a stale updater sees the current goal and can decline", async () => {
    await withStorage(async (storage) => {
      await storage.updateNativeAgentGoal(input.key, () => goal());
      await storage.updateNativeAgentGoal(input.key, () => goal({ goalId: "g2" }));
      const after = await storage.updateNativeAgentGoal(input.key, (current) =>
        current?.goalId === "g1" ? goal({ goalId: "g1", iterations: 9 }) : undefined,
      );
      expect(sessionGoal(after!)?.goalId).toBe("g2");
    });
  });

  test("concurrent updates serialize, so none is lost", async () => {
    await withStorage(async (storage) => {
      await storage.updateNativeAgentGoal(input.key, () => goal());
      await Promise.all(
        Array.from({ length: 10 }, () =>
          storage.updateNativeAgentGoal(input.key, (current) =>
            current ? { ...current, iterations: current.iterations + 1 } : undefined,
          ),
        ),
      );
      const session = await storage.getNativeAgentSession(input.key);
      expect(sessionGoal(session!)?.iterations).toBe(10);
    });
  });

  test("a replaced or cleared goal moves to a bounded history without its output", async () => {
    await withStorage(async (storage) => {
      for (let index = 0; index < 8; index += 1) {
        await storage.updateNativeAgentGoal(input.key, () =>
          goal({
            goalId: `g${index}`,
            status: "claimed",
            lastCheck: {
              passed: false,
              exitCode: 1,
              durationMs: 1,
              outputTail: "secret-ish output",
              at: new Date(0).toISOString(),
            },
          }),
        );
      }
      const cleared = await storage.updateNativeAgentGoal(input.key, () => null);
      expect(cleared?.goal).toBeUndefined();
      expect(cleared?.goalHistory?.map((entry) => entry.goalId)).toEqual([
        "g3",
        "g4",
        "g5",
        "g6",
        "g7",
      ]);
      expect(cleared?.goalHistory?.every((entry) => entry.lastCheck?.outputTail === "")).toBe(true);
    });
  });

  test("an update to the same goal does not touch history", async () => {
    await withStorage(async (storage) => {
      await storage.updateNativeAgentGoal(input.key, () => goal());
      const after = await storage.updateNativeAgentGoal(input.key, () => goal({ iterations: 1 }));
      expect(after?.goalHistory).toBeUndefined();
    });
  });

  test("a malformed goal reads as absent, and the session stays readable", async () => {
    await withStorage(async (storage) => {
      await storage.updateNativeAgentGoal(input.key, () => goal({ objective: "fine" }));
      await storage.updateNativeAgentGoal(input.key, () => {
        return { goalId: "" } as unknown as NativeAgentGoal;
      });
      const session = await storage.getNativeAgentSession(input.key);
      expect(session).not.toBeNull();
      expect(sessionGoal(session!)).toBeUndefined();
    });
  });

  test("environment deletion takes the goal with the session", async () => {
    await withStorage(async (storage) => {
      await storage.updateNativeAgentGoal(input.key, () => goal());
      await storage.deleteNativeAgentSessionsByEnvironment("env-1");
      expect(await storage.getNativeAgentSession(input.key)).toBeFalsy();
    });
  });
});
