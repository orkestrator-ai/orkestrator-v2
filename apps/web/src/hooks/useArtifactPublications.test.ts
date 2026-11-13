import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactPublicationView,
} from "@orkestrator/protocol/transcript-artifact-commands";
import * as backend from "@/lib/backend";
import { invoke } from "@/lib/native/backend";
import {
  RESOURCE_COALESCE_MS,
  dispatchResourceChange,
  resetResourceSync,
} from "@/lib/resource-sync";
import { installControlledTimeout } from "../../../../tests/helpers/controlled-timeout";
import type { RichTranscriptScope } from "@/lib/chat/rich-identity";
import {
  clearArtifactPublicationCache,
  clearArtifactPublicationsForEnvironment,
  MAX_LEDGER_PAGES,
  MAX_RETAINED_PUBLICATIONS,
  readArtifactLedger,
  useArtifactPublications,
} from "./useArtifactPublications";

/** The hook's first three retry delays (`RETRY_DELAYS_MS` in useArtifactPublications.ts). */
const RETRY_BACKOFF_MS = [500, 1_500, 4_000] as const;

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

const SCOPE: RichTranscriptScope = {
  backendId: "backend-1",
  environmentId: "env-1",
  logicalSessionKey: "env-env-1:tab-1",
  generation: "gen-1",
};

function publication(sequence: number): ArtifactPublicationView {
  const id = String(sequence).padStart(8, "0");
  return {
    ref: {
      schemaVersion: 1,
      artifactId: `art_${id}`,
      revision: 1,
      publicationId: `pub_${id}`,
      kind: "chart",
      title: `Chart ${sequence}`,
      summary: "Synthetic",
      provenance: { backendId: "backend-1", origin: "agent" },
    },
    publishedAt: new Date(Date.UTC(2026, 9, 20, 10, 0, sequence)).toISOString(),
    conversationSequence: sequence,
    kind: "chart",
    receipt: {
      receiptId: "rcpt_x",
      completedAt: "2026-10-20T10:00:00Z",
      profile: null,
      captures: [],
      semantics: "not-assessed",
    },
    source: { sha256: "a", byteLength: 1, effectiveSha256: "a" },
    availability: "available",
  };
}

/** A backend ledger of `total` publications served in forward pages. */
function serveLedger(getTotal: () => number) {
  const calls: Array<Record<string, unknown>> = [];
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command !== TRANSCRIPT_ARTIFACT_COMMANDS.listPublications) return undefined;
    calls.push(args ?? {});
    const total = getTotal();
    const after = typeof args?.afterSequence === "number" ? args.afterSequence : 0;
    const limit = typeof args?.limit === "number" ? args.limit : 100;
    const publications: ArtifactPublicationView[] = [];
    for (let sequence = after + 1; sequence <= Math.min(total, after + limit); sequence++) {
      publications.push(publication(sequence));
    }
    const last = publications.at(-1)?.conversationSequence ?? null;
    return { publications, nextSequence: last !== null && last < total ? last : null };
  });
  return calls;
}

/**
 * Delivers one resource change through resource-sync's coalescing timer
 * without sleeping past it. The caller's next assertion therefore follows a
 * delivery that has happened, not a wait that merely outlasted one.
 */
async function deliverResourceChange(change: Parameters<typeof dispatchResourceChange>[0]) {
  const coalesce = installControlledTimeout(RESOURCE_COALESCE_MS, {
    label: "resource-sync coalescing",
  });
  let armed = 0;
  try {
    act(() => {
      dispatchResourceChange(change);
      armed = coalesce.pendingCount();
      coalesce.advance();
    });
  } finally {
    expect(coalesce.restore()).toBe(0);
  }
  expect(armed).toBe(1);
  await flushMicrotasks();
}

/** Lets promise chains started by a delivered change or an advanced timer finish. */
async function flushMicrotasks() {
  await act(async () => {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  });
}

beforeEach(() => {
  clearArtifactPublicationCache();
  invokeMock.mockReset();
});

afterEach(() => {
  cleanup();
  resetResourceSync();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("readArtifactLedger", () => {
  test("reads every page of a ledger within the bound", async () => {
    serveLedger(() => 1_500);
    const ledger = await readArtifactLedger(SCOPE, backend);
    expect(ledger).toHaveLength(1_500);
    expect(ledger.omittedOlder ?? 0).toBe(0);
    expect(ledger.incomplete ?? false).toBe(false);
    expect(ledger.at(-1)!.conversationSequence).toBe(1_500);
  });

  test("keeps the newest publications and counts the omitted older ones", async () => {
    const total = MAX_RETAINED_PUBLICATIONS + 450;
    serveLedger(() => total);
    const ledger = await readArtifactLedger(SCOPE, backend);
    expect(ledger).toHaveLength(MAX_RETAINED_PUBLICATIONS);
    expect(ledger.omittedOlder).toBe(450);
    expect(ledger[0]!.conversationSequence).toBe(451);
    expect(ledger.at(-1)!.conversationSequence).toBe(total);
  });

  test("stops at the page bound and marks the ledger incomplete", async () => {
    const calls = serveLedger(() => 1_000_000);
    const ledger = await readArtifactLedger(SCOPE, backend);
    expect(calls).toHaveLength(MAX_LEDGER_PAGES);
    expect(ledger.incomplete).toBe(true);
    expect(ledger).toHaveLength(MAX_RETAINED_PUBLICATIONS);
  });
});

describe("useArtifactPublications live updates", () => {
  test("an environment clear drops all its ledgers while other environments retain theirs", async () => {
    const sameEnvironment = { ...SCOPE, logicalSessionKey: "env-env-1:tab-2" };
    const otherEnvironment = {
      ...SCOPE,
      environmentId: "env-2",
      logicalSessionKey: "env-env-2:tab-1",
    };
    let holdReads = false;
    const pending: Array<() => void> = [];
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== TRANSCRIPT_ARTIFACT_COMMANDS.listPublications) return undefined;
      if (holdReads) {
        await new Promise<void>((resolve) => pending.push(resolve));
      }
      return { publications: [publication(1)], nextSequence: null };
    });
    const first = renderHook(() => useArtifactPublications(SCOPE, []));
    const second = renderHook(() => useArtifactPublications(sameEnvironment, []));
    const other = renderHook(() => useArtifactPublications(otherEnvironment, []));
    await waitFor(() => {
      expect(first.result.current).toHaveLength(1);
      expect(second.result.current).toHaveLength(1);
      expect(other.result.current).toHaveLength(1);
    });

    holdReads = true;
    try {
      act(() => clearArtifactPublicationsForEnvironment(SCOPE.environmentId));
      await waitFor(() => expect(pending).toHaveLength(3));
      // None of the new-epoch reads has answered: only the cleared environment is empty.
      expect(first.result.current).toHaveLength(0);
      expect(second.result.current).toHaveLength(0);
      expect(other.result.current).toHaveLength(1);

      other.unmount();
      const remountedOther = renderHook(() => useArtifactPublications(otherEnvironment, []));
      const remountedCleared = renderHook(() => useArtifactPublications(SCOPE, []));
      expect(remountedOther.result.current).toHaveLength(1);
      expect(remountedCleared.result.current).toHaveLength(0);

      holdReads = false;
      await act(async () => {
        for (const release of pending) release();
      });
      await waitFor(() => {
        expect(first.result.current).toHaveLength(1);
        expect(second.result.current).toHaveLength(1);
        expect(remountedOther.result.current).toHaveLength(1);
        expect(remountedCleared.result.current).toHaveLength(1);
      });
    } finally {
      for (const release of pending) release();
    }
  });

  test("a transcript-artifact event for this conversation re-reads the ledger", async () => {
    let total = 1;
    const calls = serveLedger(() => total);
    const { result } = renderHook(() => useArtifactPublications(SCOPE, []));
    await waitFor(() => expect(result.current).toHaveLength(1));
    const before = calls.length;

    // Another conversation's event is ignored.
    total = 2;
    await deliverResourceChange({
      resource: "transcript-artifact",
      id: "env-env-1:tab-2",
      revision: 1,
    });
    expect(calls.length).toBe(before);
    expect(result.current).toHaveLength(1);

    dispatchResourceChange({
      resource: "transcript-artifact",
      id: SCOPE.logicalSessionKey,
      revision: 2,
    });
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.at(-1)!.logicalSessionKey).toBe(SCOPE.logicalSessionKey);
  });

  test("unmounting stops listening", async () => {
    const calls = serveLedger(() => 1);
    const { result, unmount } = renderHook(() => useArtifactPublications(SCOPE, []));
    await waitFor(() => expect(result.current).toHaveLength(1));
    unmount();
    const before = calls.length;
    await deliverResourceChange({
      resource: "transcript-artifact",
      id: SCOPE.logicalSessionKey,
      revision: 3,
    });
    expect(calls.length).toBe(before);
  });
});

test("stable unresolved calls retry through empty and failed ledger reads without hints", async () => {
  let reads = 0;
  invokeMock.mockImplementation(async (command: string) => {
    if (command !== TRANSCRIPT_ARTIFACT_COMMANDS.listPublications) return undefined;
    reads++;
    if (reads === 2) throw new Error("temporary transport failure");
    return { publications: reads >= 4 ? [publication(1)] : [], nextSequence: null };
  });
  // Each backoff delay is controlled separately. A retry is armed only after
  // the previous read settles, so a delay having one timer pending proves both
  // that the hook asked for exactly that delay and that no read has run since.
  const [first, second, third] = RETRY_BACKOFF_MS.map((delay) =>
    installControlledTimeout(delay, { label: `artifact retry backoff ${delay}` }),
  );
  const messages = [
    {
      id: "m",
      role: "assistant",
      content: "",
      createdAt: "2026-10-20T10:00:00Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "mcp__orkestrator__publish_artifact",
          toolState: "success",
          toolArgs: { artifactId: "art_00000001", expectedRevision: 1 },
        },
      ],
    },
  ] as import("@/lib/chat/native-message-types").NativeMessage[];
  const { result, unmount } = renderHook(() => useArtifactPublications(SCOPE, messages));
  try {
    // The mount read and the first retry's timer are both armed on mount.
    await waitFor(() => expect(first!.pendingCount()).toBe(1));
    expect(reads).toBe(1);
    await act(async () => {
      first!.advance();
    });
    await waitFor(() => expect(second!.pendingCount()).toBe(1));
    expect(reads).toBe(2);
    expect(third!.pendingCount()).toBe(0);
    await act(async () => {
      second!.advance();
    });
    await waitFor(() => expect(third!.pendingCount()).toBe(1));
    expect(reads).toBe(3);
    await act(async () => {
      third!.advance();
    });
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(reads).toBe(4);
    unmount();
  } finally {
    // Newest first: each clock restores the timer functions it replaced.
    for (const clock of [third, second, first]) clock!.restore();
  }
});

test("unmount fences a retry read and cannot repopulate the cache", async () => {
  let finish!: (value: unknown) => void;
  let reads = 0;
  invokeMock.mockImplementation(async () => {
    reads++;
    if (reads === 1) return { publications: [], nextSequence: null };
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const messages = [
    {
      id: "m",
      role: "assistant",
      content: "",
      createdAt: "2026-10-20T10:00:00Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "mcp__orkestrator__publish_artifact",
          toolState: "success",
          toolArgs: { artifactId: "art_00000001", expectedRevision: 1 },
        },
      ],
    },
  ] as import("@/lib/chat/native-message-types").NativeMessage[];
  // The first retry's backoff runs on a controlled clock instead of 500 real ms.
  const retry = installControlledTimeout(RETRY_BACKOFF_MS[0], { label: "artifact retry backoff" });
  let unmount!: () => void;
  try {
    ({ unmount } = renderHook(() => useArtifactPublications(SCOPE, messages)));
    await waitFor(() => expect(retry.pendingCount()).toBe(1));
    await act(async () => {
      retry.advance();
    });
    await waitFor(() => expect(reads).toBe(2));
  } finally {
    retry.restore();
  }
  unmount();
  finish({ publications: [publication(1)], nextSequence: null });
  await flushMicrotasks();
  // Hold the remount's fresh read: its first paint exposes any stale write
  // to the cache by the unmounted subscriber, without relying on an epoch reset.
  invokeMock.mockImplementation(() => new Promise(() => undefined));
  const remounted = renderHook(() => useArtifactPublications(SCOPE, []));
  expect(remounted.result.current).toHaveLength(0);
  remounted.unmount();
});

test("a failed ledger read preserves protected content; a successful empty ledger revokes it", async () => {
  const { registerProtectedRichCache } = await import("@/lib/chat/rich-content-reset");
  let revocations = 0;
  const unregister = registerProtectedRichCache("ledger-storage-regression", {
    clearAll() {},
    clearConversation: () => {
      revocations++;
    },
  });
  let mode: "content" | "error" | "empty" = "content";
  let reads = 0;
  invokeMock.mockImplementation(async (command: string) => {
    if (command !== TRANSCRIPT_ARTIFACT_COMMANDS.listPublications) return undefined;
    reads++;
    if (mode === "error")
      throw new Error(
        JSON.stringify({
          code: "storage_unavailable",
          message: "unavailable",
          retryClass: "transient",
        }),
      );
    return { publications: mode === "content" ? [publication(1)] : [], nextSequence: null };
  });
  try {
    const { result } = renderHook(() => useArtifactPublications(SCOPE, []));
    await waitFor(() => expect(result.current).toHaveLength(1));
    mode = "error";
    dispatchResourceChange({
      resource: "transcript-artifact",
      id: SCOPE.logicalSessionKey,
      revision: 40,
    });
    await waitFor(() => expect(reads).toBe(2));
    expect(revocations).toBe(0);
    expect(result.current).toHaveLength(1);
    mode = "empty";
    dispatchResourceChange({
      resource: "transcript-artifact",
      id: SCOPE.logicalSessionKey,
      revision: 41,
    });
    await waitFor(() => expect(revocations).toBeGreaterThan(0));
    expect(result.current).toHaveLength(0);
  } finally {
    cleanup();
    unregister();
  }
});
