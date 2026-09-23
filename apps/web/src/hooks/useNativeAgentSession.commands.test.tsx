/**
 * Command plumbing in the native-agent session hook: catalogue state from
 * progressive discovery, the explicit command refresh, and command intent on
 * dispatch and queue — with a command's argument bytes left alone.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  NativeAgentCommandCatalogueState,
  NativeAgentDiscoveryUpdate,
  NativeAgentSessionProjection,
  NativeAgentSessionStateUpdate,
  NativeAgentSlashCommand,
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
  platform: "codex",
  logicalSessionKey: "env-env-1:tab-1",
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
};

const COMMANDS: NativeAgentSlashCommand[] = [
  {
    name: "/review",
    id: "codex:/review",
    source: "project",
    executionKind: "bridge-template",
    bindingRevision: "rev-1",
  },
];
const READY: NativeAgentCommandCatalogueState = { status: "ready", revision: 4, enhanced: true };

let discoveryUpdates: Array<
  () => NativeAgentDiscoveryUpdate | Promise<NativeAgentDiscoveryUpdate>
> = [];
let transcriptUpdates: Array<() => NativeAgentTranscriptUpdate<TestMessage>> = [];
let stateUpdates: Array<() => NativeAgentSessionStateUpdate> = [];

const unchanged = (token: string) => ({
  viewVersion: 1 as const,
  status: "unchanged" as const,
  token,
  identity,
});
const getNativeAgentDiscoveryUpdateMock = mock(async () => {
  const next = discoveryUpdates.shift();
  return next ? next() : (unchanged("discovery-unscripted") satisfies NativeAgentDiscoveryUpdate);
});
const getNativeAgentTranscriptUpdateMock = mock(async () => {
  const next = transcriptUpdates.shift();
  return next ? next() : unchanged("transcript-unscripted");
});
const getNativeAgentSessionStateUpdateMock = mock(async () => {
  const next = stateUpdates.shift();
  return next ? next() : unchanged("state-unscripted");
});
const refreshNativeAgentCommandsMock = mock(
  async (): Promise<{
    outcome: "reread";
    message?: string;
    projection: NativeAgentSessionProjection<TestMessage> | null;
  }> => ({
    outcome: "reread",
    projection: {
      platform: "codex",
      environmentId: "env-1",
      sessionId: "session-1",
      connection: "connected",
      turn: { phase: "idle" },
      messages: [],
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities("codex"),
      slashCommands: COMMANDS,
      slashCommandCatalogue: {
        ...READY,
        revision: 9,
        lastRefresh: { outcome: "reread", at: "2026-09-23T00:00:00.000Z" },
      },
      revision: 50,
      generation: "generation-1",
    },
  }),
);
const dispatchNativeAgentIntentMock = mock(async (input: { requestId: string }) => ({
  outcome: "accepted" as const,
  requestId: input.requestId,
}));
const enqueuePromptQueueMessageMock = mock(async () => ({}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: async () => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
  }),
  getNativeAgentTranscriptUpdate: getNativeAgentTranscriptUpdateMock,
  getNativeAgentSessionStateUpdate: getNativeAgentSessionStateUpdateMock,
  getNativeAgentDiscoveryUpdate: getNativeAgentDiscoveryUpdateMock,
  ensureNativeAgentSession: async () => ({
    providerSessionId: "session-1",
    logicalSessionKey: "env-env-1:tab-1",
    environmentId: "env-1",
    agent: "codex",
  }),
  adoptNativeAgentSession: async () => ({}),
  getNativeAgentProjection: async () => null,
  refreshNativeAgentCommands: refreshNativeAgentCommandsMock,
  dispatchNativeAgentIntent: dispatchNativeAgentIntentMock,
  enqueuePromptQueueMessage: enqueuePromptQueueMessageMock,
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests, nativeSubmissionText } =
  await import("./useNativeAgentSession");

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function transcriptSnapshot(token: string): NativeAgentTranscriptUpdate<TestMessage> {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity,
      freshness: "current",
      messages: [{ id: "m1", text: "hello" }],
      historyEpoch: "epoch-1",
      historyComplete: true,
    },
  };
}

function stateSnapshot(token: string): NativeAgentSessionStateUpdate {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity,
      connection: "connected",
      turn: { phase: "idle" },
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities("codex"),
      notices: [],
    },
  };
}

function discoverySnapshot(
  token: string,
  commands: NativeAgentSlashCommand[],
  catalogue?: NativeAgentCommandCatalogueState,
): NativeAgentDiscoveryUpdate {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity,
      sections: {
        commands: {
          availability: "ready",
          value: commands,
          revision: 1,
          ...(catalogue ? { catalogue } : {}),
        },
      },
    },
  };
}

function renderSession() {
  return renderHook(() =>
    useNativeAgentSession<TestMessage>({
      platform: "codex",
      environmentId: "env-1",
      tabId: "tab-1",
      isActive: true,
      enabled: true,
    }),
  );
}

beforeEach(() => {
  resetNativeAgentSyncCapabilityForTests();
  discoveryUpdates = [];
  transcriptUpdates = [];
  stateUpdates = [];
  getNativeAgentDiscoveryUpdateMock.mockClear();
  refreshNativeAgentCommandsMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  enqueuePromptQueueMessageMock.mockClear();
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeAgentProjectionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useNativeAgentProjectionStore.getState().reset();
});

describe("useNativeAgentSession commands", () => {
  test("applies the discovery catalogue state beside the command rows", async () => {
    transcriptUpdates = [() => transcriptSnapshot("t-1")];
    stateUpdates = [() => stateSnapshot("s-1")];
    discoveryUpdates = [() => discoverySnapshot("d-1", COMMANDS, READY)];
    const { result } = renderSession();
    await waitFor(() => expect(result.current.projection?.slashCommandCatalogue).toEqual(READY));
    expect(result.current.projection?.slashCommands).toEqual(COMMANDS);
  });

  test("keeps a discovery snapshot that lands before any projection exists", async () => {
    let releaseTranscript!: () => void;
    const heldTranscript = new Promise<NativeAgentTranscriptUpdate<TestMessage>>((resolve) => {
      releaseTranscript = () => resolve(transcriptSnapshot("t-1"));
    });
    let releaseState!: () => void;
    const heldState = new Promise<NativeAgentSessionStateUpdate>((resolve) => {
      releaseState = () => resolve(stateSnapshot("s-1"));
    });
    transcriptUpdates = [() => heldTranscript as never];
    stateUpdates = [() => heldState as never];
    const loading: NativeAgentCommandCatalogueState = {
      status: "loading",
      revision: 1,
      enhanced: true,
    };
    discoveryUpdates = [() => discoverySnapshot("d-1", [], loading)];
    const { result } = renderSession();
    await waitFor(() => expect(getNativeAgentDiscoveryUpdateMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    releaseTranscript();
    releaseState();
    await waitFor(() => expect(result.current.projection?.slashCommandCatalogue).toEqual(loading));
    expect(result.current.projection?.slashCommands).toEqual([]);
  });

  test("a legacy discovery view leaves the catalogue state absent", async () => {
    transcriptUpdates = [() => transcriptSnapshot("t-1")];
    stateUpdates = [() => stateSnapshot("s-1")];
    discoveryUpdates = [() => discoverySnapshot("d-1", COMMANDS)];
    const { result } = renderSession();
    await waitFor(() => expect(result.current.projection?.slashCommands).toEqual(COMMANDS));
    expect(result.current.projection?.slashCommandCatalogue).toBeUndefined();
  });

  test("refreshCommands asks the backend and installs the projection it returns", async () => {
    transcriptUpdates = [() => transcriptSnapshot("t-1")];
    stateUpdates = [() => stateSnapshot("s-1")];
    const { result } = renderSession();
    await waitFor(() => expect(result.current.projection).toBeTruthy());
    let outcome: Awaited<ReturnType<typeof result.current.refreshCommands>> | undefined;
    await act(async () => {
      outcome = await result.current.refreshCommands();
    });
    expect(outcome?.outcome).toBe("reread");
    expect(refreshNativeAgentCommandsMock).toHaveBeenCalledWith({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "env-env-1:tab-1",
    });
    expect(result.current.projection?.slashCommandCatalogue?.lastRefresh?.outcome).toBe("reread");
  });

  test("dispatch and queue carry the intent and keep a command's argument bytes", async () => {
    transcriptUpdates = [() => transcriptSnapshot("t-1")];
    stateUpdates = [() => stateSnapshot("s-1")];
    const { result } = renderSession();
    await waitFor(() => expect(result.current.projection).toBeTruthy());
    const intent = {
      kind: "selected" as const,
      commandId: "codex:/review",
      bindingRevision: "rev-1",
    };
    const raw = "  /review\tsrc/a.ts \n  second line  ";
    await act(async () => {
      await result.current.send(raw, { requestId: "req-1", command: intent });
    });
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "/review\tsrc/a.ts \n  second line  ",
        command: intent,
        requestId: "req-1",
      }),
    );

    await act(async () => {
      await result.current.enqueue(raw, { requestId: "req-2", command: intent });
    });
    expect(enqueuePromptQueueMessageMock).toHaveBeenCalledWith(
      "codex\0env-env-1:tab-1",
      "env-1",
      expect.objectContaining({
        id: "req-2",
        text: "/review\tsrc/a.ts \n  second line  ",
        command: intent,
      }),
    );

    await act(async () => {
      await result.current.send("  plain text  ", { requestId: "req-3" });
    });
    const plain = dispatchNativeAgentIntentMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(plain.prompt).toBe("plain text");
    expect("command" in plain).toBe(false);
  });

  test("literal text is trimmed like any ordinary prompt", () => {
    expect(nativeSubmissionText("  /x y  ", { kind: "literal" })).toBe("/x y");
    expect(nativeSubmissionText("  /x y  ", { kind: "typed" })).toBe("/x y  ");
    expect(nativeSubmissionText("  /x y  ")).toBe("/x y");
  });
});
