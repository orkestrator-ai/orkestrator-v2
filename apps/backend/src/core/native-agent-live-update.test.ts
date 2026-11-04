import { afterEach, describe, expect, test } from "bun:test";
import type {
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
} from "@orkestrator/protocol/native-agent";
import { createCommandRegistry } from "./commands-registry.js";
import {
  readNativeAgentLiveUpdate,
  type NativeAgentLiveUpdateReads,
} from "./native-agent-live-update.js";
import type { NativeAgentLiveUpdateInput } from "./native-agent-service-shared.js";

const identity = {
  backendInstanceId: "backend-1",
  environmentId: "env-1",
  platform: "claude" as const,
  logicalSessionKey: "env-env-1:tab-1",
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
};
const liveWindow = { messages: 100, targetBytes: 512 * 1024 };
const input: NativeAgentLiveUpdateInput = {
  environmentId: "env-1",
  agent: "claude",
  logicalSessionKey: "env-env-1:tab-1",
  viewVersion: 1,
  liveWindow,
  transcriptToken: "transcript-token",
  stateToken: "state-token",
  patchVersion: 2,
};
const transcriptUnchanged: NativeAgentTranscriptUpdate = {
  viewVersion: 1,
  status: "unchanged",
  token: "transcript-token",
  identity,
};
const stateUnchanged: NativeAgentSessionStateUpdate = {
  viewVersion: 1,
  status: "unchanged",
  token: "state-token",
  identity,
};

function reads(overrides: Partial<NativeAgentLiveUpdateReads> = {}): NativeAgentLiveUpdateReads {
  return {
    getTranscriptUpdate: async () => transcriptUnchanged,
    getSessionStateUpdate: async () => stateUnchanged,
    ...overrides,
  };
}

const unsettled = new Set<() => void>();
function never<T>(): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    unsettled.add(() => reject(new Error("late failure")));
  });
}

afterEach(() => {
  for (const settle of unsettled) settle();
  unsettled.clear();
});

describe("readNativeAgentLiveUpdate", () => {
  test("gives each part its own token and the session's identity", async () => {
    const seen: Record<string, unknown> = {};
    const update = await readNativeAgentLiveUpdate(
      reads({
        getTranscriptUpdate: async (received) => {
          seen.transcript = received;
          return transcriptUnchanged;
        },
        getSessionStateUpdate: async (received) => {
          seen.state = received;
          return stateUnchanged;
        },
      }),
      input,
    );
    const session = {
      environmentId: "env-1",
      agent: "claude",
      logicalSessionKey: "env-env-1:tab-1",
      viewVersion: 1,
    };
    expect(seen.transcript).toEqual({
      ...session,
      liveWindow,
      knownToken: "transcript-token",
      patchVersion: 2,
    });
    expect(seen.state).toEqual({ ...session, knownToken: "state-token" });
    expect(update).toEqual({
      viewVersion: 1,
      transcript: transcriptUnchanged,
      state: stateUnchanged,
    });
  });

  test("answers as soon as both parts have, without waiting for the deadline", async () => {
    const startedAt = Date.now();
    await readNativeAgentLiveUpdate(reads(), input, 60_000);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("a slow transcript cannot hold session state back", async () => {
    const update = await readNativeAgentLiveUpdate(
      reads({ getTranscriptUpdate: () => never() }),
      input,
      5,
    );
    expect(update.transcript).toEqual({ viewVersion: 1, status: "pending" });
    expect(update.state).toEqual(stateUnchanged);
  });

  test("a slow state read cannot hold the transcript back", async () => {
    const update = await readNativeAgentLiveUpdate(
      reads({ getSessionStateUpdate: () => never() }),
      input,
      5,
    );
    expect(update.state).toEqual({ viewVersion: 1, status: "pending" });
    expect(update.transcript).toEqual(transcriptUnchanged);
  });

  test("a part that throws answers unavailable and leaves the other part's answer", async () => {
    const update = await readNativeAgentLiveUpdate(
      reads({
        getSessionStateUpdate: async () => {
          throw new Error("the provider went away");
        },
      }),
      input,
    );
    expect(update.state).toEqual({
      viewVersion: 1,
      status: "unavailable",
      retryable: true,
      error: "the provider went away",
    });
    expect(update.transcript).toEqual(transcriptUnchanged);
  });

  test("a part that fails after the answer went out is not an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      await readNativeAgentLiveUpdate(reads({ getTranscriptUpdate: () => never() }), input, 5);
      for (const settle of unsettled) settle();
      unsettled.clear();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("get_native_agent_live_update", () => {
  test("is advertised, validates its window and passes the tokens on", async () => {
    const received: NativeAgentLiveUpdateInput[] = [];
    const nativeAgents = {
      observationStatus: () => ({ stamp: { generation: "g", revision: 0 } }),
      getLiveUpdate: async (update: NativeAgentLiveUpdateInput) => {
        received.push(update);
        return { viewVersion: 1, transcript: transcriptUnchanged, state: stateUnchanged };
      },
    };
    const registry = createCommandRegistry();
    const invoke = (command: string, args: Record<string, unknown>) =>
      registry.get(command)!(args, { nativeAgents } as never);
    const capabilities = (await invoke("get_native_agent_sync_capabilities", {})) as {
      liveUpdateVersions?: number[];
    };
    expect(capabilities.liveUpdateVersions).toEqual([1]);

    const args = { ...input } as unknown as Record<string, unknown>;
    await invoke("get_native_agent_live_update", args);
    expect(received).toEqual([input]);

    await expect(
      Promise.resolve(
        invoke("get_native_agent_live_update", {
          ...args,
          liveWindow: { messages: 5, targetBytes: 1 },
        }),
      ),
    ).rejects.toThrow("live window");
    await expect(
      Promise.resolve(invoke("get_native_agent_live_update", { ...args, viewVersion: 2 })),
    ).rejects.toThrow("unsupported");
    expect(received).toHaveLength(1);
  });
});
