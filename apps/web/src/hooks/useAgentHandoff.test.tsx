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
  prependAgentHandoffHistory,
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
      pendingHistory: undefined,
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
      pendingHistory: undefined,
    });

    await act(async () => pending.resolve(record(snapshot)));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.handoff?.id).toBe("handoff-success");
    expect(result.current.pendingHistory).toBe(snapshot.bootstrapPrompt);
    expect(result.current.displayMessages.map(({ id }) => id)).toEqual([
      "handoff:handoff-success:source:source-1",
      "handoff:handoff-success:boundary",
    ]);
  });

  test("suppresses pending history once the authoritative destination transcript has started", async () => {
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

    expect(result.current.pendingHistory).toBeUndefined();
    expect(result.current.displayMessages.map(({ id }) => id)).toEqual([
      "handoff:handoff-restored:source:source-1",
      "handoff:handoff-restored:boundary",
      "provider-restored",
    ]);
  });

  test.each([
    ["optimistic", "optimistic-first-send", "Pending user prompt", "user"],
    ["error", "error-first-send", "The first send failed", "system"],
    ["system", "system-first-send", "Query stopped by user.", "system"],
  ] as const)(
    "keeps pending history after a client-only %s row",
    async (_kind, id, content, role) => {
      const snapshot = handoff(`handoff-client-only-${_kind}`);
      mockGetAgentHandoff.mockResolvedValueOnce(record(snapshot));

      const { result } = renderHook(() =>
        useAgentHandoff(
          snapshot.id,
          "codex",
          "env-1",
          [message(id, role, content)],
        )
      );
      await waitFor(() => expect(result.current.ready).toBe(true));

      expect(result.current.pendingHistory).toBe(snapshot.bootstrapPrompt);
    },
  );

  test("consumes pending history when a client-only row contains its structural carrier", async () => {
    const snapshot = handoff("handoff-optimistic-carrier");
    const transported = prependAgentHandoffHistory(
      snapshot.bootstrapPrompt,
      "Continue from the transfer",
    );
    mockGetAgentHandoff.mockResolvedValueOnce(record(snapshot));

    const { result } = renderHook(() =>
      useAgentHandoff(
        snapshot.id,
        "codex",
        "env-1",
        [message("optimistic-carrier", "user", transported)],
      )
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.pendingHistory).toBeUndefined();
    expect(result.current.displayMessages.map((row) => row.content)).toEqual([
      "Continue the work",
      expect.stringContaining("Continued in"),
      "Continue from the transfer",
    ]);
  });

  test("hides a retry carrier that follows a client-only error row", async () => {
    const snapshot = handoff("handoff-retry-after-error");
    const transported = prependAgentHandoffHistory(
      snapshot.bootstrapPrompt,
      "Continue after the error",
    );
    mockGetAgentHandoff.mockResolvedValueOnce(record(snapshot));

    const { result } = renderHook(() =>
      useAgentHandoff(
        snapshot.id,
        "codex",
        "env-1",
        [
          message("error-first-send", "assistant", "First send failed"),
          message("optimistic-retry", "user", transported),
        ],
      )
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.pendingHistory).toBeUndefined();
    expect(result.current.displayMessages.map(({ content }) => content)).toEqual([
      "Continue the work",
      expect.stringContaining("Continued in"),
      "First send failed",
      "Continue after the error",
    ]);
    expect(result.current.displayMessages.some(
      ({ content }) => content.includes("<orkestrator-handoff"),
    )).toBe(false);
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

  test("imports a transfer addressed to an ACP agent", async () => {
    const snapshot = handoff("handoff-cursor", { destinationProvider: "cursor" });
    mockGetAgentHandoff.mockResolvedValueOnce(record(snapshot));

    const { result } = renderHook(() =>
      useAgentHandoff("handoff-cursor", "cursor", "env-1", [])
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.handoff?.destinationProvider).toBe("cursor");
    expect(result.current.displayMessages.map(({ content }) => content)).toEqual([
      "Continue the work",
      expect.stringContaining("Continued in Cursor from Claude"),
    ]);
    // Nothing has been sent yet, so the history still rides the first prompt.
    expect(result.current.pendingHistory).toBe(snapshot.bootstrapPrompt);
  });

  test("rejects a transfer addressed to a different ACP agent", async () => {
    const snapshot = handoff("handoff-grok", { destinationProvider: "grok" });
    mockGetAgentHandoff.mockResolvedValueOnce(record(snapshot));

    const { result } = renderHook(() =>
      useAgentHandoff("handoff-grok", "cursor", "env-1", [])
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.handoff).toBeNull();
    expect(result.current.error).toBe("This transfer belongs to another agent.");
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
    expect(result.current.pendingHistory).toBeUndefined();
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
    expect(result.current.pendingHistory).toBeUndefined();
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
    expect(result.current.pendingHistory).toBeUndefined();
  });

  test("uses a safe generic error for a non-Error load rejection", async () => {
    mockGetAgentHandoff.mockRejectedValueOnce("storage rejected without an Error");

    const { result } = renderHook(() =>
      useAgentHandoff("handoff-non-error", "codex", "env-1", [])
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBe(
      "The transferred conversation could not be loaded.",
    );
    expect(result.current.pendingHistory).toBeUndefined();
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

  test("revalidates an identity change while the original load is in flight", async () => {
    const pending = deferred<Record<string, unknown> | null>();
    const snapshot = handoff("handoff-in-flight-identity");
    mockGetAgentHandoff.mockImplementation(async () => pending.promise);

    const { result, rerender } = renderHook(
      ({ environmentId }: { environmentId: string }) =>
        useAgentHandoff(snapshot.id, "codex", environmentId, []),
      { initialProps: { environmentId: "env-1" } },
    );

    rerender({ environmentId: "env-2" });
    expect(result.current).toMatchObject({
      handoffId: snapshot.id,
      handoff: null,
      loading: true,
      ready: false,
      error: null,
    });

    await act(async () => pending.resolve(record(snapshot)));
    await waitFor(() =>
      expect(result.current.error).toBe(
        "This transfer belongs to another environment.",
      )
    );
    expect(result.current.handoff).toBeNull();
  });

  test("resets synchronously when the handoff is removed during an in-flight load", async () => {
    const pending = deferred<Record<string, unknown> | null>();
    const snapshot = handoff("handoff-reset-in-flight");
    mockGetAgentHandoff.mockImplementationOnce(async () => pending.promise);

    const { result, rerender } = renderHook(
      ({ handoffId }: { handoffId?: string }) =>
        useAgentHandoff(handoffId, "codex", "env-1", []),
      {
        initialProps: {
          handoffId: snapshot.id,
        } as { handoffId: string | undefined },
      },
    );
    expect(result.current.ready).toBe(false);

    rerender({ handoffId: undefined });
    expect(result.current).toMatchObject({
      handoffId: null,
      handoff: null,
      loading: false,
      ready: true,
      error: null,
      pendingHistory: undefined,
    });

    await act(async () => pending.resolve(record(snapshot)));
    expect(result.current).toMatchObject({
      handoffId: null,
      handoff: null,
      loading: false,
      ready: true,
      error: null,
      pendingHistory: undefined,
    });
  });

  test("cancels an in-flight load when the consumer unmounts", async () => {
    const pending = deferred<Record<string, unknown> | null>();
    const snapshot = handoff("handoff-unmounted");
    mockGetAgentHandoff.mockImplementationOnce(async () => pending.promise);

    const { result, unmount } = renderHook(() =>
      useAgentHandoff(snapshot.id, "codex", "env-1", [])
    );
    expect(result.current.ready).toBe(false);

    unmount();
    await act(async () => pending.resolve(record(snapshot)));

    expect(mockGetAgentHandoff).toHaveBeenCalledTimes(1);
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
    expect(result.current.pendingHistory).toBeUndefined();
    await waitFor(() =>
      expect(result.current.error).toBe("This transfer belongs to another agent.")
    );

    rerender({ destinationProvider: "codex", environmentId: "env-2" });
    expect(result.current.ready).toBe(false);
    expect(result.current.pendingHistory).toBeUndefined();
    await waitFor(() =>
      expect(result.current.error).toBe(
        "This transfer belongs to another environment.",
      )
    );
  });

  test("the error row keeps the timestamp it was created with", async () => {
    mockGetAgentHandoff.mockResolvedValue(null);
    const { result, rerender } = renderHook(
      ({ providerMessages }: { providerMessages: NativeMessage[] }) =>
        useAgentHandoff("handoff-missing", "codex", "env-1", providerMessages),
      { initialProps: { providerMessages: [] as NativeMessage[] } },
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());

    const errorRow = result.current.displayMessages[0]!;
    expect(errorRow.id).toBe("handoff:handoff-missing:error");
    const createdAt = errorRow.createdAt;

    /*
     * A fresh array identity on every streaming tick is normal. Deriving the
     * timestamp during render would move it each time, so the row's displayed
     * time — and the response duration measured from it — would drift.
     */
    for (let tick = 0; tick < 3; tick += 1) {
      rerender({
        providerMessages: [message(`streamed-${tick}`, "assistant", `chunk ${tick}`)],
      });
      expect(result.current.displayMessages[0]!.createdAt).toBe(createdAt);
    }
    // Still usable: an unloadable transfer must not strand the composer.
    expect(result.current.ready).toBe(true);
  });

  test("imported rows keep their identity while the provider transcript streams", async () => {
    const snapshot = handoff("handoff-stable", {
      messages: [
        message("source-1", "user", "Start here"),
        message("source-2", "assistant", "Working on it"),
      ],
    });
    mockGetAgentHandoff.mockResolvedValue(record(snapshot));

    const { result, rerender } = renderHook(
      ({ providerMessages }: { providerMessages: NativeMessage[] }) =>
        useAgentHandoff("handoff-stable", "codex", "env-1", providerMessages),
      { initialProps: { providerMessages: [] as NativeMessage[] } },
    );
    await waitFor(() => expect(result.current.handoff?.id).toBe("handoff-stable"));

    const importedBefore = result.current.displayMessages.slice(0, 3);
    expect(importedBefore.map((row) => row.id)).toEqual([
      "handoff:handoff-stable:source:source-1",
      "handoff:handoff-stable:source:source-2",
      "handoff:handoff-stable:boundary",
    ]);

    /*
     * Rebuilding the imported rows inside the transcript memo would hand React
     * new objects on every token, re-rendering the whole imported history.
     */
    for (let tick = 0; tick < 3; tick += 1) {
      rerender({
        providerMessages: [message("live", "assistant", "x".repeat(tick + 1))],
      });
      const importedAfter = result.current.displayMessages.slice(0, 3);
      importedAfter.forEach((row, index) => {
        expect(row).toBe(importedBefore[index]!);
      });
    }
  });

  test("hides a consumed carrier whose snapshot has already been deleted", async () => {
    const snapshot = handoff("handoff-consumed");
    const bootstrap: NativeMessage = {
      id: "bootstrap",
      role: "user",
      content: `${snapshot.bootstrapPrompt}\n\ncarry on`,
      parts: [{ type: "text", content: `${snapshot.bootstrapPrompt}\n\ncarry on` }],
      createdAt: "2026-07-27T12:01:00.000Z",
    };
    const reply = message("reply", "assistant", "Understood.");

    /*
     * This is the post-resume state: `agentHandoffId` is gone (the snapshot was
     * deleted), but the prompt it produced is still the session's first message.
     * No backend read should happen, and the raw frame must stay hidden.
     */
    const { result } = renderHook(() =>
      useAgentHandoff(
        undefined,
        "codex",
        "env-1",
        [bootstrap, reply],
        "handoff-consumed",
      )
    );

    expect(mockGetAgentHandoff).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(true);
    expect(result.current.handoff).toBeNull();
    expect(result.current.displayMessages.map((row) => row.content)).toEqual([
      "carry on",
      "Understood.",
    ]);
    expect(
      result.current.displayMessages.some((row) => row.content.includes("orkestrator-handoff")),
    ).toBe(false);
  });
});
