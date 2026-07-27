import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };
const mockGetAgentHandoff = mock(
  async (_handoffId: string): Promise<Record<string, unknown> | null> => null,
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getAgentHandoff: mockGetAgentHandoff,
}));

import {
  AGENT_HANDOFF_VERSION,
  createAgentHandoffSnapshot,
  resetAgentHandoffCache,
  type AgentHandoffSnapshot,
  type AgentProvider,
} from "@/lib/agent-handoff";
import { useAgentHandoff } from "./useAgentHandoff";

function message(
  id: string,
  role: NativeMessage["role"],
  content: string,
): NativeMessage {
  return {
    id,
    role,
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-07-27T12:00:00.000Z",
  };
}

function handoff(
  id: string,
  options: {
    destinationProvider?: AgentProvider;
    environmentId?: string;
    messages?: NativeMessage[];
  } = {},
): AgentHandoffSnapshot {
  return createAgentHandoffSnapshot({
    id,
    environmentId: options.environmentId ?? "env-1",
    sourceProvider: "claude",
    destinationProvider: options.destinationProvider ?? "codex",
    sourceSessionId: "source-session",
    messages: options.messages ?? [message("source-1", "user", "Continue the work")],
    now: "2026-07-27T12:00:00.000Z",
  });
}

function record(snapshot: AgentHandoffSnapshot): Record<string, unknown> {
  return {
    id: snapshot.id,
    environmentId: snapshot.environmentId,
    version: AGENT_HANDOFF_VERSION,
    snapshot,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  resetAgentHandoffCache();
  mockGetAgentHandoff.mockReset();
  mockGetAgentHandoff.mockResolvedValue(null);
});

afterEach(cleanup);

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("useAgentHandoff", () => {
  test("returns provider messages immediately when no handoff is requested", () => {
    const providerMessage = message("provider-1", "assistant", "Already here");
    const { result } = renderHook(() =>
      useAgentHandoff(undefined, "codex", "env-1", [providerMessage])
    );

    expect(result.current).toMatchObject({
      handoffId: null,
      handoff: null,
      loading: false,
      ready: true,
      error: null,
      initialPrompt: undefined,
    });
    expect(result.current.displayMessages).toEqual([providerMessage]);
    expect(mockGetAgentHandoff).not.toHaveBeenCalled();
  });

  test("is synchronously not ready while loading, then exposes the validated handoff", async () => {
    const pending = deferred<Record<string, unknown> | null>();
    const snapshot = handoff("handoff-success");
    mockGetAgentHandoff.mockImplementationOnce(async () => pending.promise);

    const { result } = renderHook(() =>
      useAgentHandoff("handoff-success", "codex", "env-1", [])
    );

    expect(result.current).toMatchObject({
      handoffId: "handoff-success",
      handoff: null,
      loading: true,
      ready: false,
      error: null,
      initialPrompt: undefined,
    });

    await act(async () => pending.resolve(record(snapshot)));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.handoff?.id).toBe("handoff-success");
    expect(result.current.initialPrompt).toBe(snapshot.bootstrapPrompt);
    expect(result.current.displayMessages.map(({ id }) => id)).toEqual([
      "handoff:handoff-success:source:source-1",
      "handoff:handoff-success:boundary",
    ]);
  });

  test("suppresses the initial prompt once the authoritative destination transcript has started", async () => {
    const snapshot = handoff("handoff-restored");
    mockGetAgentHandoff.mockResolvedValueOnce(record(snapshot));
    const providerMessage = message(
      "provider-restored",
      "assistant",
      "A restored response without a bootstrap marker",
    );

    const { result } = renderHook(() =>
      useAgentHandoff("handoff-restored", "codex", "env-1", [providerMessage])
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.initialPrompt).toBeUndefined();
    expect(result.current.displayMessages.map(({ id }) => id)).toEqual([
      "handoff:handoff-restored:source:source-1",
      "handoff:handoff-restored:boundary",
      "provider-restored",
    ]);
  });

  test("reports a missing handoff and leaves the destination usable", async () => {
    const { result } = renderHook(() =>
      useAgentHandoff("handoff-missing", "codex", "env-1", [])
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.handoff).toBeNull();
    expect(result.current.error).toBe(
      "The transferred conversation could not be loaded.",
    );
    expect(result.current.displayMessages[0]).toMatchObject({
      id: "handoff:handoff-missing:error",
      role: "system",
      content: "The transferred conversation could not be loaded.",
    });
  });

  test("rejects a handoff intended for another provider", async () => {
    const snapshot = handoff("handoff-provider");
    mockGetAgentHandoff.mockResolvedValueOnce(record(snapshot));

    const { result } = renderHook(() =>
      useAgentHandoff("handoff-provider", "opencode", "env-1", [])
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.handoff).toBeNull();
    expect(result.current.error).toBe("This transfer belongs to another agent.");
    expect(result.current.initialPrompt).toBeUndefined();
  });

  test("rejects a handoff intended for another environment", async () => {
    const snapshot = handoff("handoff-environment");
    mockGetAgentHandoff.mockResolvedValueOnce(record(snapshot));

    const { result } = renderHook(() =>
      useAgentHandoff("handoff-environment", "codex", "env-2", [])
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.handoff).toBeNull();
    expect(result.current.error).toBe(
      "This transfer belongs to another environment.",
    );
    expect(result.current.initialPrompt).toBeUndefined();
  });

  test("shows load errors before provider messages and then unblocks sending", async () => {
    const providerMessage = message("provider-1", "assistant", "Existing output");
    mockGetAgentHandoff.mockRejectedValueOnce(new Error("handoff storage unavailable"));

    const { result } = renderHook(() =>
      useAgentHandoff("handoff-error", "codex", "env-1", [providerMessage])
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBe("handoff storage unavailable");
    expect(result.current.displayMessages.map(({ id }) => id)).toEqual([
      "handoff:handoff-error:error",
      "provider-1",
    ]);
    expect(result.current.initialPrompt).toBeUndefined();
  });

  test("ignores a stale load after the requested handoff changes", async () => {
    const firstPending = deferred<Record<string, unknown> | null>();
    const secondPending = deferred<Record<string, unknown> | null>();
    const firstSnapshot = handoff("handoff-first");
    const secondSnapshot = handoff("handoff-second");
    mockGetAgentHandoff.mockImplementation(async (handoffId) =>
      handoffId === "handoff-first" ? firstPending.promise : secondPending.promise
    );

    const { result, rerender } = renderHook(
      ({ handoffId }: { handoffId: string }) =>
        useAgentHandoff(handoffId, "codex", "env-1", []),
      { initialProps: { handoffId: "handoff-first" } },
    );

    rerender({ handoffId: "handoff-second" });
    expect(result.current).toMatchObject({
      handoffId: "handoff-second",
      loading: true,
      ready: false,
    });

    await act(async () => secondPending.resolve(record(secondSnapshot)));
    await waitFor(() => expect(result.current.handoff?.id).toBe("handoff-second"));

    await act(async () => firstPending.resolve(record(firstSnapshot)));
    expect(result.current.handoff?.id).toBe("handoff-second");
    expect(result.current.error).toBeNull();
  });

  test("closes readiness synchronously when provider or environment changes for the same id", async () => {
    const snapshot = handoff("handoff-revalidated");
    mockGetAgentHandoff.mockResolvedValue(record(snapshot));

    const { result, rerender } = renderHook(
      ({
        destinationProvider,
        environmentId,
      }: {
        destinationProvider: AgentProvider;
        environmentId: string;
      }) => useAgentHandoff(
        "handoff-revalidated",
        destinationProvider,
        environmentId,
        [],
      ),
      {
        initialProps: {
          destinationProvider: "codex" as AgentProvider,
          environmentId: "env-1",
        },
      },
    );
    await waitFor(() => expect(result.current.handoff?.id).toBe("handoff-revalidated"));

    rerender({ destinationProvider: "opencode", environmentId: "env-1" });
    expect(result.current.ready).toBe(false);
    expect(result.current.initialPrompt).toBeUndefined();
    await waitFor(() =>
      expect(result.current.error).toBe("This transfer belongs to another agent.")
    );

    rerender({ destinationProvider: "codex", environmentId: "env-2" });
    expect(result.current.ready).toBe(false);
    expect(result.current.initialPrompt).toBeUndefined();
    await waitFor(() =>
      expect(result.current.error).toBe(
        "This transfer belongs to another environment.",
      )
    );
  });
});
