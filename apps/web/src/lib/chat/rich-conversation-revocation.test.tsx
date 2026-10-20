import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactPublicationView,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { invoke } from "@/lib/native/backend";
import { GatewayHttpError } from "@/lib/native/gateway-http-error";
import { dispatchResourceChange, resetResourceSync } from "@/lib/resource-sync";
import {
  artifactConversationRevocationCounters,
  artifactRequestCacheStats,
  clearArtifactRequestCache,
  resetArtifactConversationRevocations,
  useArtifactPublication,
} from "@/lib/chat/artifact-requests";
import {
  artifactPublicationCacheSize,
  clearArtifactPublicationCache,
  useArtifactPublications,
} from "@/hooks/useArtifactPublications";
import { richBlockViewKey, richCacheKey, type RichTranscriptScope } from "@/lib/chat/rich-identity";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { resetRichContentResetTracking, richContentResetCounters } from "./rich-content-reset";

/*
 * Real deletion/revocation signals clear one conversation's protected rich
 * content (render cache, view state, artifact reads, ledger) and nothing else.
 */

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function scope(logicalSessionKey: string): RichTranscriptScope {
  return { backendId: "backend-A", environmentId: "env-1", logicalSessionKey, generation: "g1" };
}

const DELETED = scope("env-env-1:tab-deleted");
const SIBLING = scope("env-env-1:tab-sibling");

function publication(publicationId: string, sequence = 1): ArtifactPublicationView {
  return {
    ref: {
      schemaVersion: 1,
      artifactId: `art_${publicationId}`,
      revision: 1,
      publicationId,
      kind: "chart",
      title: "Chart",
      summary: "Synthetic",
      provenance: { backendId: "backend-A", origin: "agent" },
    },
    publishedAt: "2026-10-20T10:00:00.000Z",
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
  } as ArtifactPublicationView;
}

/** Backend state per conversation key: its publications, or a failure. */
let ledgers: Map<string, ArtifactPublicationView[]>;
let ledgerFailure: Map<string, unknown>;
let publicationFailure: Map<string, unknown>;

function artifactFailure(code: string): Error {
  return Object.assign(new Error(JSON.stringify({ code, message: `${code} failure` })), { code });
}

function listCalls(conversation: string): number {
  return invokeMock.mock.calls.filter(
    ([command, args]) =>
      command === TRANSCRIPT_ARTIFACT_COMMANDS.listPublications &&
      (args as { logicalSessionKey?: string }).logicalSessionKey === conversation,
  ).length;
}

beforeEach(() => {
  ledgers = new Map();
  ledgerFailure = new Map();
  publicationFailure = new Map();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    const conversation = String(args?.logicalSessionKey);
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.listPublications) {
      if (ledgerFailure.has(conversation)) throw ledgerFailure.get(conversation);
      return { publications: ledgers.get(conversation) ?? [], nextSequence: null };
    }
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) {
      const key = `${conversation}/${String(args?.publicationId)}`;
      if (publicationFailure.has(key)) throw publicationFailure.get(key);
      const found = (ledgers.get(conversation) ?? []).find(
        (entry) => entry.ref.publicationId === args?.publicationId,
      );
      if (!found) throw artifactFailure("not_found");
      return found;
    }
    return undefined;
  });
  richRenderScheduler.clear();
  useRichContentViewStore.getState().reset();
  clearArtifactRequestCache();
  clearArtifactPublicationCache();
  resetRichContentResetTracking();
  resetArtifactConversationRevocations();
  resetResourceSync();
});

afterEach(cleanup);

function renderKey(target: RichTranscriptScope): string {
  return richCacheKey({
    kind: "highlight",
    scope: target,
    contentHash: "same-content",
    rendererVersion: "v",
    theme: "dark",
  });
}

async function seedDerivedContent(target: RichTranscriptScope): Promise<void> {
  await richRenderScheduler.request({
    key: renderKey(target),
    lane: "highlight",
    sourceBytes: 4,
    run: async () => ({ value: "tokens", bytes: 8 }),
  }).promise;
  useRichContentViewStore
    .getState()
    .update(richBlockViewKey(target, "m1", "p1", "code:0"), { wrap: true });
}

function viewKeys(): string[] {
  return Array.from(useRichContentViewStore.getState().entries.keys());
}

function expectOnlySiblingRemains(): void {
  expect(richRenderScheduler.peek(renderKey(DELETED)) === null).toBe(true);
  expect(richRenderScheduler.peek(renderKey(SIBLING))?.ok).toBe(true);
  expect(viewKeys()).toEqual([richBlockViewKey(SIBLING, "m1", "p1", "code:0")]);
}

/** Both conversations shown with a loaded ledger, a loaded publication and derived content. */
async function showBoth() {
  ledgers.set(DELETED.logicalSessionKey, [publication("pub-d")]);
  ledgers.set(SIBLING.logicalSessionKey, [publication("pub-s")]);
  const deletedLedger = renderHook(() => useArtifactPublications(DELETED, []));
  const siblingLedger = renderHook(() => useArtifactPublications(SIBLING, []));
  const deletedRead = renderHook(() => useArtifactPublication(DELETED, "pub-d"));
  const siblingRead = renderHook(() => useArtifactPublication(SIBLING, "pub-s"));
  await waitFor(() => expect(deletedLedger.result.current).toHaveLength(1));
  await waitFor(() => expect(siblingLedger.result.current).toHaveLength(1));
  await waitFor(() => expect(deletedRead.result.current.status).toBe("ready"));
  await waitFor(() => expect(siblingRead.result.current.status).toBe("ready"));
  await seedDerivedContent(DELETED);
  await seedDerivedContent(SIBLING);
  expect(artifactRequestCacheStats().entries).toBe(2);
  return { deletedLedger, siblingLedger, deletedRead, siblingRead };
}

describe("conversation deletion clears that conversation's protected rich content", () => {
  test("the backend's transcript-artifact hint for a deleted conversation clears it once", async () => {
    const { deletedLedger, siblingLedger } = await showBoth();

    // deleteConversation removed every record, then announced the hint.
    ledgers.delete(DELETED.logicalSessionKey);
    act(() =>
      dispatchResourceChange({
        resource: "transcript-artifact",
        id: DELETED.logicalSessionKey,
        revision: 10,
      }),
    );

    await waitFor(() => expect(artifactConversationRevocationCounters.deleted).toBe(1));
    expect(richContentResetCounters.conversation).toBe(1);
    expectOnlySiblingRemains();
    expect(artifactRequestCacheStats().entries).toBe(1);
    await waitFor(() => expect(deletedLedger.result.current).toHaveLength(0));
    expect(siblingLedger.result.current).toHaveLength(1);

    // A later hint for the (still empty) conversation clears nothing more.
    const reads = listCalls(DELETED.logicalSessionKey);
    act(() =>
      dispatchResourceChange({
        resource: "transcript-artifact",
        id: DELETED.logicalSessionKey,
        revision: 11,
      }),
    );
    await waitFor(() => expect(listCalls(DELETED.logicalSessionKey)).toBeGreaterThan(reads));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(richContentResetCounters.conversation).toBe(1);
  });

  test("a hint that only changed drafts (ledger unchanged) clears nothing", async () => {
    await showBoth();
    const reads = listCalls(DELETED.logicalSessionKey);
    act(() =>
      dispatchResourceChange({
        resource: "transcript-artifact",
        id: DELETED.logicalSessionKey,
        revision: 10,
      }),
    );
    await waitFor(() => expect(listCalls(DELETED.logicalSessionKey)).toBeGreaterThan(reads));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(richContentResetCounters.conversation).toBe(0);
    expect(viewKeys()).toHaveLength(2);
  });

  test("a conversation deleted while its transcript was unmounted is cleared on remount", async () => {
    const { deletedLedger } = await showBoth();
    deletedLedger.unmount();
    // No subscriber saw the deletion hint.
    ledgers.delete(DELETED.logicalSessionKey);
    expect(artifactPublicationCacheSize()).toBe(2);

    const remounted = renderHook(() => useArtifactPublications(DELETED, []));
    // The cached ledger is shown first; the authoritative read finds nothing.
    expect(remounted.result.current).toHaveLength(1);
    await waitFor(() => expect(artifactConversationRevocationCounters.deleted).toBe(1));
    expectOnlySiblingRemains();
    await waitFor(() => expect(remounted.result.current).toHaveLength(0));
  });

  test("a ledger read failing with not_found for the conversation clears it", async () => {
    await showBoth();
    ledgerFailure.set(DELETED.logicalSessionKey, artifactFailure("not_found"));
    act(() =>
      dispatchResourceChange({
        resource: "transcript-artifact",
        id: DELETED.logicalSessionKey,
        revision: 10,
      }),
    );
    await waitFor(() => expect(artifactConversationRevocationCounters.deleted).toBe(1));
    expectOnlySiblingRemains();
  });
});

describe("artifact reads that fail for the whole conversation clear it", () => {
  test("one missing publication in a live conversation clears nothing", async () => {
    await showBoth();
    const missing = renderHook(() => useArtifactPublication(DELETED, "pub-gone"));
    await waitFor(() => expect(missing.result.current.status).toBe("error"));
    await waitFor(() => expect(artifactConversationRevocationCounters.verifications).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(richContentResetCounters.conversation).toBe(0);
    expect(viewKeys()).toHaveLength(2);
  });

  test("not_found after the conversation's ledger emptied clears it (verified by re-reading)", async () => {
    await showBoth();
    // Deleted with no hint delivered (e.g. a gap), and a reader asks again.
    ledgers.delete(DELETED.logicalSessionKey);
    const reread = renderHook(() => useArtifactPublication(DELETED, "pub-other"));
    await waitFor(() => expect(reread.result.current.status).toBe("error"));
    await waitFor(() => expect(artifactConversationRevocationCounters.deleted).toBe(1));
    expectOnlySiblingRemains();
    expect(artifactRequestCacheStats().entries).toBe(1);
  });

  test("not_found for a conversation this window never loaded clears nothing", async () => {
    await seedDerivedContent(DELETED);
    const read = renderHook(() => useArtifactPublication(DELETED, "pub-forged"));
    await waitFor(() => expect(read.result.current.status).toBe("error"));
    await waitFor(() => expect(artifactConversationRevocationCounters.verifications).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(richContentResetCounters.conversation).toBe(0);
    expect(richRenderScheduler.peek(renderKey(DELETED))?.ok).toBe(true);
  });

  test("a 403 on one publication while the conversation's ledger is readable clears nothing", async () => {
    await showBoth();
    publicationFailure.set(
      `${DELETED.logicalSessionKey}/pub-x`,
      new GatewayHttpError(403, "Forbidden"),
    );
    const read = renderHook(() => useArtifactPublication(DELETED, "pub-x"));
    await waitFor(() => expect(read.result.current.status).toBe("error"));
    await waitFor(() => expect(artifactConversationRevocationCounters.verifications).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(richContentResetCounters.conversation).toBe(0);
    expect(viewKeys()).toHaveLength(2);
  });

  test("a conversation whose reads are all forbidden is cleared once, even as readers retry", async () => {
    const { deletedRead } = await showBoth();
    const forbidden = new GatewayHttpError(403, "Forbidden");
    ledgerFailure.set(DELETED.logicalSessionKey, forbidden);
    publicationFailure.set(`${DELETED.logicalSessionKey}/pub-x`, forbidden);
    const read = renderHook(() => useArtifactPublication(DELETED, "pub-x"));
    await waitFor(() => expect(artifactConversationRevocationCounters.permission).toBe(1));
    expectOnlySiblingRemains();
    // The clear re-requests mounted reads (the earlier publication still
    // answers, the ledger does not); nothing clears a second time.
    await waitFor(() => expect(read.result.current.status).toBe("error"));
    await waitFor(() => expect(deletedRead.result.current.status).toBe("ready"));
    act(() => read.result.current.retry());
    await waitFor(() => expect(read.result.current.status).toBe("error"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(artifactConversationRevocationCounters.permission).toBe(1);
    expect(richContentResetCounters.conversation).toBe(1);
  });

  test("a permission error code on the ledger read clears the conversation", async () => {
    await showBoth();
    ledgerFailure.set(DELETED.logicalSessionKey, artifactFailure("permission_denied"));
    act(() =>
      dispatchResourceChange({
        resource: "transcript-artifact",
        id: DELETED.logicalSessionKey,
        revision: 10,
      }),
    );
    await waitFor(() => expect(artifactConversationRevocationCounters.permission).toBe(1));
    expectOnlySiblingRemains();
  });

  test("a transient ledger failure clears nothing", async () => {
    await showBoth();
    ledgerFailure.set(DELETED.logicalSessionKey, artifactFailure("storage_unavailable"));
    const reads = listCalls(DELETED.logicalSessionKey);
    act(() =>
      dispatchResourceChange({
        resource: "transcript-artifact",
        id: DELETED.logicalSessionKey,
        revision: 10,
      }),
    );
    await waitFor(() => expect(listCalls(DELETED.logicalSessionKey)).toBeGreaterThan(reads));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(richContentResetCounters.conversation).toBe(0);
    expect(viewKeys()).toHaveLength(2);
  });
});
