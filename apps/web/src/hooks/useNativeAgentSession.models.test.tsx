import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

interface TestMessage {
  id: string;
  text: string;
}

const realBackendSnapshot = { ...realBackend };

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "backend-1",
  environmentId: "env-1",
  platform: "opencode",
  logicalSessionKey: "env-env-1:tab-1",
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
};

const substitution = {
  requestedModelId: "opencode/claude-sonnet-5",
  modelId: "opencode-go/gpt-5.6-luna",
  message: "Using connected model.",
};
const invokeMock = mock(async (_command: string, args?: Record<string, unknown>) => ({
  providerSessionId: "session-1",
  logicalSessionKey: "env-env-1:tab-1",
  environmentId: "env-1",
  agent: "opencode",
  ...(args?.modelSource === "default" ? { modelSubstitution: substitution } : {}),
}));
mock.module("@/lib/native/backend", () => ({ invoke: invokeMock }));

let phase: "idle" | "running" = "idle";

const getNativeAgentTranscriptUpdateMock = mock(
  async (): Promise<NativeAgentTranscriptUpdate<TestMessage>> => ({
    viewVersion: 1,
    status: "snapshot",
    token: "transcript-1",
    value: {
      identity,
      freshness: "current",
      messages: [{ id: "m1", text: "hello" }],
      historyEpoch: "epoch-1",
      historyComplete: true,
    },
  }),
);
const getNativeAgentSessionStateUpdateMock = mock(
  async (): Promise<NativeAgentSessionStateUpdate> => ({
    viewVersion: 1,
    status: "snapshot",
    token: `state-${phase}`,
    value: {
      identity,
      connection: "connected",
      turn: { phase },
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities("opencode"),
      notices: [],
    },
  }),
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: async () => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
  }),
  getNativeAgentTranscriptUpdate: getNativeAgentTranscriptUpdateMock,
  getNativeAgentSessionStateUpdate: getNativeAgentSessionStateUpdateMock,
  getNativeAgentDiscoveryUpdate: async () => ({
    viewVersion: 1,
    status: "unchanged",
    token: "discovery",
    identity,
  }),
  adoptNativeAgentSession: async () => ({}),
  getNativeAgentProjection: async () => null,
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");
const { resetResourceSync } = await import("@/lib/resource-sync");
const { resetReadCoordinatorForTests } = await import("@/lib/read-coordinator");

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/lib/native/backend", () => ({ invoke: mock(async () => undefined) }));
});

beforeEach(() => {
  phase = "idle";
  invokeMock.mockClear();
  resetNativeAgentSyncCapabilityForTests();
  getNativeAgentTranscriptUpdateMock.mockClear();
  getNativeAgentSessionStateUpdateMock.mockClear();
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeAgentProjectionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  resetResourceSync();
  useNativeAgentProjectionStore.getState().reset();
});

describe("useNativeAgentSession model selection IPC", () => {
  for (const explicit of [false, true]) {
    test(`forwards selection provenance and inherited substitution (explicit=${explicit})`, async () => {
      const onModelSubstituted = mock(() => undefined);
      renderHook(() =>
        useNativeAgentSession<TestMessage>({
          platform: "opencode",
          environmentId: "env-1",
          tabId: "tab-1",
          isActive: true,
          enabled: true,
          defaultAgentModel: "opencode/claude-sonnet-5",
          ...(explicit ? { initialAgentModel: "opencode/explicit" } : {}),
          onModelSubstituted,
        }),
      );
      await waitFor(() => expect(invokeMock).toHaveBeenCalled());
      if (explicit) expect(onModelSubstituted).not.toHaveBeenCalled();
      else await waitFor(() => expect(onModelSubstituted).toHaveBeenCalledWith(substitution));
      expect(invokeMock).toHaveBeenCalledWith(
        "ensure_native_agent_session",
        expect.objectContaining({
          modelSource: explicit ? "explicit" : "default",
          model: explicit ? "opencode/explicit" : substitution.requestedModelId,
        }),
      );
    });
  }
});
