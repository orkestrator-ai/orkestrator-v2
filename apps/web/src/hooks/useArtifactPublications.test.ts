import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactPublicationView,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { invoke } from "@/lib/native/backend";
import { dispatchResourceChange, resetResourceSync } from "@/lib/resource-sync";
import type { RichTranscriptScope } from "@/lib/chat/rich-identity";
import {
  clearArtifactPublicationCache,
  MAX_LEDGER_PAGES,
  MAX_RETAINED_PUBLICATIONS,
  readArtifactLedger,
  useArtifactPublications,
} from "./useArtifactPublications";

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
    const ledger = await readArtifactLedger(SCOPE);
    expect(ledger).toHaveLength(1_500);
    expect(ledger.omittedOlder ?? 0).toBe(0);
    expect(ledger.incomplete ?? false).toBe(false);
    expect(ledger.at(-1)!.conversationSequence).toBe(1_500);
  });

  test("keeps the newest publications and counts the omitted older ones", async () => {
    const total = MAX_RETAINED_PUBLICATIONS + 450;
    serveLedger(() => total);
    const ledger = await readArtifactLedger(SCOPE);
    expect(ledger).toHaveLength(MAX_RETAINED_PUBLICATIONS);
    expect(ledger.omittedOlder).toBe(450);
    expect(ledger[0]!.conversationSequence).toBe(451);
    expect(ledger.at(-1)!.conversationSequence).toBe(total);
  });

  test("stops at the page bound and marks the ledger incomplete", async () => {
    const calls = serveLedger(() => 1_000_000);
    const ledger = await readArtifactLedger(SCOPE);
    expect(calls).toHaveLength(MAX_LEDGER_PAGES);
    expect(ledger.incomplete).toBe(true);
    expect(ledger).toHaveLength(MAX_RETAINED_PUBLICATIONS);
  });
});

describe("useArtifactPublications live updates", () => {
  test("a transcript-artifact event for this conversation re-reads the ledger", async () => {
    let total = 1;
    const calls = serveLedger(() => total);
    const { result } = renderHook(() => useArtifactPublications(SCOPE, []));
    await waitFor(() => expect(result.current).toHaveLength(1));
    const before = calls.length;

    // Another conversation's event is ignored.
    total = 2;
    dispatchResourceChange({ resource: "transcript-artifact", id: "env-env-1:tab-2", revision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
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
    dispatchResourceChange({
      resource: "transcript-artifact",
      id: SCOPE.logicalSessionKey,
      revision: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls.length).toBe(before);
  });
});

test("stable unresolved calls retry through empty and failed ledger reads without hints", async () => {
  const times: number[] = [];
  invokeMock.mockImplementation(async (command: string) => {
    if (command !== TRANSCRIPT_ARTIFACT_COMMANDS.listPublications) return undefined;
    times.push(Date.now());
    if (times.length === 2) throw new Error("temporary transport failure");
    return { publications: times.length >= 4 ? [publication(1)] : [], nextSequence: null };
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
  const { result, unmount } = renderHook(() => useArtifactPublications(SCOPE, messages));
  await waitFor(() => expect(result.current).toHaveLength(1), { timeout: 9000 });
  expect(times).toHaveLength(4);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(450);
  expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(1400);
  expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(3900);
  unmount();
}, 12000);

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
  const { unmount } = renderHook(() => useArtifactPublications(SCOPE, messages));
  await waitFor(() => expect(reads).toBe(2), { timeout: 2000 });
  unmount();
  finish({ publications: [publication(1)], nextSequence: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
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
