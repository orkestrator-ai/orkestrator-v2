import { afterEach, describe, expect, test, type Mock } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  dispatchNativeAgentIntent,
  dispatchNativeAgentPrompt,
  enqueuePromptQueueMessage,
  getNativeAgentDiscoveryUpdate,
  getNativeAgentProjectionUpdate,
  refreshNativeAgentCommands,
} from "./workflows";

// `@/lib/native/backend` is replaced once for every suite in tests/setup.ts.
const invokeMock = invoke as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

afterEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("native command wrappers", () => {
  test("refreshNativeAgentCommands calls the refresh command and returns its outcome", async () => {
    const result = { outcome: "deferred" as const, message: "Busy", projection: null };
    invokeMock.mockImplementation(async () => result);
    const input = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey: "k" };
    await expect(refreshNativeAgentCommands(input)).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenLastCalledWith("refresh_native_agent_commands", input);
  });

  test("dispatch wrappers pass command intent through unchanged", async () => {
    const command = { kind: "selected" as const, commandId: "codex:/review", bindingRevision: "r" };
    const base = {
      environmentId: "env-1",
      agent: "codex" as const,
      logicalSessionKey: "k",
      prompt: "/review a  \n",
      requestId: "req-1",
      command,
    };
    await dispatchNativeAgentIntent(base);
    expect(invokeMock).toHaveBeenLastCalledWith("dispatch_native_agent_intent", base);
    await dispatchNativeAgentPrompt(base);
    expect(invokeMock).toHaveBeenLastCalledWith("dispatch_native_agent_prompt", base);
  });

  test("queued messages keep their command intent", async () => {
    const message = { id: "q-1", text: "/review a", command: { kind: "literal" as const } };
    await enqueuePromptQueueMessage("queue", "env-1", message);
    expect(invokeMock).toHaveBeenLastCalledWith("enqueue_prompt_queue_message", {
      queueKey: "queue",
      environmentId: "env-1",
      message,
    });
  });
});

/*
 * Mixed-version: what the renderer's own response guards accept from a backend
 * on either side of the command catalogue (ff4026b4e, #827). The backend
 * before it sent `slashCommands` rows without `id`, `executionKind` or
 * `bindingRevision`, and no `slashCommandCatalogue` or section `catalogue`.
 */
describe("mixed-version: command fields in projection and discovery payloads", () => {
  const identity = {
    backendInstanceId: "backend-1",
    environmentId: "env-1",
    platform: "codex" as const,
    logicalSessionKey: "k",
    providerSessionId: "session-1",
    sourceGeneration: "generation-1",
  };
  const discoveryInput = {
    environmentId: "env-1",
    agent: "codex" as const,
    logicalSessionKey: "k",
    viewVersion: 1 as const,
    sections: ["commands" as const],
  };
  const discovery = (commands: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    viewVersion: 1,
    status: "snapshot",
    token: "d-1",
    value: { identity, sections: { commands }, ...extra },
  });
  const projectionInput = {
    environmentId: "env-1",
    agent: "codex" as const,
    logicalSessionKey: "k",
    syncVersion: 1 as const,
    liveWindow: { messages: 100, targetBytes: 512 * 1024 } as const,
  };
  const projection = (extra: Record<string, unknown> = {}) => ({
    platform: "codex",
    environmentId: "env-1",
    sessionId: "session-1",
    connection: "connected",
    turn: { phase: "idle" },
    messages: [],
    interactions: [],
    composerControls: [],
    capabilities: {},
    revision: 1,
    generation: "generation-1",
    ...extra,
  });
  const snapshot = (value: Record<string, unknown>) => ({
    syncVersion: 1,
    status: "snapshot",
    token: "t-1",
    projection: value,
    historyEpoch: "epoch-1",
    historyComplete: true,
  });

  test("an older backend's commands section without catalogue state is accepted as is", async () => {
    const response = discovery({
      availability: "ready",
      revision: 1,
      value: [{ name: "/review", description: "Review", source: "template" }],
    });
    invokeMock.mockImplementation(async () => response);
    await expect(getNativeAgentDiscoveryUpdate(discoveryInput)).resolves.toEqual(response as never);
  });

  test("a newer backend's unknown fields in the section, its state and its rows are accepted", async () => {
    const response = discovery(
      {
        availability: "ready",
        revision: 2,
        value: [
          {
            name: "/review",
            id: "codex:/review",
            source: "template",
            executionKind: "bridge-template",
            bindingRevision: "r1",
            futureRowField: { anything: true },
          },
        ],
        catalogue: {
          status: "ready",
          revision: 2,
          enhanced: true,
          futureCatalogueField: 1,
        },
        futureSectionField: "x",
      },
      { futureViewField: [] },
    );
    invokeMock.mockImplementation(async () => response);
    await expect(getNativeAgentDiscoveryUpdate(discoveryInput)).resolves.toEqual(response as never);
  });

  test("an unknown section availability or section name fails the whole discovery read", async () => {
    // Known limitation: the guard is strict here. The backend answers only the
    // sections a renderer asked for, so a new section is safe; a new
    // availability word is not, and would leave the menu on its last answer
    // (the hook ignores a failed discovery read).
    for (const response of [
      discovery({ availability: "partial", revision: 1, value: [] }),
      {
        ...discovery({ availability: "ready", revision: 1, value: [] }),
        value: {
          identity,
          sections: { commands: { availability: "ready", revision: 1, value: [] }, skills: {} },
        },
      },
    ]) {
      invokeMock.mockImplementation(async () => response);
      await expect(getNativeAgentDiscoveryUpdate(discoveryInput)).rejects.toThrow(
        "Invalid native agent discovery update response",
      );
    }
  });

  test("sync-v1 snapshots are accepted with or without command fields, and with unknown ones", async () => {
    for (const value of [
      // An older backend: no command fields at all, or legacy rows only.
      projection(),
      projection({ slashCommands: [{ name: "/review", source: "project" }] }),
      // A current backend, plus fields a newer one may add.
      projection({
        slashCommands: [{ name: "/review", id: "codex:/review", source: "project" }],
        slashCommandCatalogue: { status: "ready", revision: 3, enhanced: true },
        futureProjectionField: { anything: true },
      }),
    ]) {
      invokeMock.mockImplementation(async () => snapshot(value));
      await expect(getNativeAgentProjectionUpdate(projectionInput)).resolves.toMatchObject({
        status: "snapshot",
        projection: value,
      });
    }
  });

  test("a sync-v1 delta naming a projection field this renderer does not know is refused", async () => {
    // Known limitation, not reached inside the support window: this renderer
    // reads projections progressively and asks sync-v1 only for forced
    // snapshots, which accept unknown fields (above). A renderer old enough
    // to poll sync-v1 deltas would refuse every delta that changes a field it
    // predates, such as `slashCommandCatalogue`, and keep its old view.
    const delta = (setFields: Record<string, unknown>) => ({
      syncVersion: 1,
      status: "delta",
      baseToken: "t-1",
      token: "t-2",
      historyEpoch: "epoch-1",
      historyComplete: true,
      delta: {
        messageUpserts: [],
        deletedMessageIds: [],
        setFields,
        unsetFields: [],
        revision: 2,
        generation: "generation-1",
      },
    });
    invokeMock.mockImplementation(async () =>
      delta({ slashCommandCatalogue: { status: "stale", revision: 4, enhanced: true } }),
    );
    await expect(getNativeAgentProjectionUpdate(projectionInput)).resolves.toMatchObject({
      status: "delta",
    });
    invokeMock.mockImplementation(async () => delta({ futureProjectionField: 1 }));
    await expect(getNativeAgentProjectionUpdate(projectionInput)).rejects.toThrow(
      "Invalid native agent projection update response",
    );
  });
});
