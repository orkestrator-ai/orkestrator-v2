/**
 * Published transcript artifacts in the backend projection.
 *
 * The publication ledger is authoritative; projection places each
 * publication beside the call that published it, after the per-row cache,
 * and moves the view's token when the ledger moves. These tests drive the
 * real projection over a provider that behaves like a v2 bridge and a ledger
 * double with the `TranscriptArtifactService` read surface.
 */
import { describe, expect, test } from "bun:test";
import {
  bridgeTranscriptPage,
  bridgeTranscriptSummaryUpdate,
} from "@orkestrator/protocol/node/bridge-transcript-summary";
import {
  artifactPartContent,
  type ArtifactPublication,
} from "@orkestrator/protocol/transcript-artifacts";
import {
  RECORDED_ARTIFACT_ID,
  RECORDED_ARTIFACT_REVISION,
  RECORDED_PUBLISH_ARTIFACT_ARGS,
  SUCCESSFUL_PUBLISH_CONTRACT,
  publishArtifactCallContract,
} from "@orkestrator/protocol/testing/artifact-tool-fixtures";
import type {
  ProviderTranscriptPage,
  ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import { applyNativeAgentTranscriptDelta } from "@orkestrator/protocol/native-agent";
import {
  ArtifactOverlayIndex,
  overlayArtifactParts,
  type ArtifactLedgerReader,
} from "./native-agent-service-projection-artifacts.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";
import type { ProjectedMessageCache } from "./native-agent-projection-entries.js";
import type { NativeAgentService } from "./native-agent-service.js";
import { projectionInternals } from "./native-agent-service-test-collaborators.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;

interface TestPart extends Record<string, unknown> {
  type: string;
}

interface TestMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: TestPart[];
  createdAt: string;
}

function message(id: string, parts: TestPart[] = []): TestMessage {
  return {
    id,
    role: "assistant",
    content: `message ${id}`,
    parts,
    createdAt: "2026-10-20T00:00:00.000Z",
  };
}

function publishCall(
  toolUseId: string,
  args: Record<string, unknown> = RECORDED_PUBLISH_ARTIFACT_ARGS,
  toolState = "success",
): TestPart {
  return {
    type: "tool-invocation",
    content: "publish_artifact",
    sourcePartId: `${toolUseId}:part`,
    toolName: "mcp__orkestrator__publish_artifact",
    toolTitle: "orkestrator:publish_artifact",
    toolUseId,
    toolArgs: { ...args },
    toolState,
    toolOutput: '{"ok":true}',
  };
}

const sessionA = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:tab-a",
};
const sessionB = { ...sessionA, logicalSessionKey: "env-env-1:tab-b" };

/** The ledger read surface over an in-memory list of publications. */
function ledgerDouble(options: { leaky?: boolean } = {}) {
  const publications: ArtifactPublication[] = [];
  const listeners = new Set<(change: { environmentId: string; conversationKey: string }) => void>();
  let reads = 0;
  const reader: ArtifactLedgerReader = {
    onLedgerChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publicationsForConversation(environmentId, conversationKey, read = {}) {
      reads += 1;
      return publications
        .filter(
          (entry) =>
            options.leaky ||
            (entry.owner.environmentId === environmentId &&
              entry.owner.conversationKey === conversationKey),
        )
        .filter((entry) => entry.conversationSequence > (read.afterSequence ?? 0))
        .slice(0, read.limit ?? 1_000);
    },
    ledgerRevision(environmentId, conversationKey) {
      return publications
        .filter(
          (entry) =>
            options.leaky ||
            (entry.owner.environmentId === environmentId &&
              entry.owner.conversationKey === conversationKey),
        )
        .reduce((max, entry) => Math.max(max, entry.conversationSequence), 0);
    },
  };
  const publish = (input: {
    owner?: { environmentId: string; conversationKey: string };
    artifactId?: string;
    revision?: number;
    toolCallId?: string;
  }): ArtifactPublication => {
    const owner = input.owner ?? {
      environmentId: sessionA.environmentId,
      conversationKey: sessionA.logicalSessionKey,
    };
    const sequence =
      publications
        .filter((entry) => entry.owner.conversationKey === owner.conversationKey)
        .reduce((max, entry) => Math.max(max, entry.conversationSequence), 0) + 1;
    const publicationId = `pub_test${String(publications.length + 1).padStart(8, "0")}`;
    const artifactId = input.artifactId ?? RECORDED_ARTIFACT_ID;
    const revision = input.revision ?? RECORDED_ARTIFACT_REVISION;
    const publication: ArtifactPublication = {
      schemaVersion: 1,
      publicationId,
      artifactId,
      revision,
      receiptId: `rcpt_test${publicationId.slice(-8)}`,
      owner: { backendId: "backend-test", projectId: "project-1", ...owner },
      conversationSequence: sequence,
      publishedAt: "2026-10-20T00:00:01.000Z",
      ...(input.toolCallId ? { anchor: { toolCallId: input.toolCallId } } : {}),
      ref: {
        schemaVersion: 1,
        artifactId,
        revision,
        publicationId,
        kind: "chart",
        title: "Synthetic chart",
        summary: "Synthetic fixture chart.",
        provenance: { backendId: "backend-test", origin: "agent" },
      },
    };
    publications.push(publication);
    for (const listener of listeners) listener(owner);
    return publication;
  };
  return { reader, publications, publish, reads: () => reads };
}

/** A provider that behaves like a v2 bridge over an in-memory history. */
function summaryProvider(history: { messages: TestMessage[]; epoch: number; revision: number }) {
  const generation = "g1";
  const snapshotCalls: Array<{ knownSourceToken?: string }> = [];
  const transcriptSnapshot = async (
    _sessionId: string,
    options: { limit: number; targetBytes: number; knownSourceToken?: string },
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> => {
    snapshotCalls.push(
      options.knownSourceToken ? { knownSourceToken: options.knownSourceToken } : {},
    );
    const update = bridgeTranscriptSummaryUpdate(history.messages, {
      sessionIdentity: "provider-session",
      generation,
      contentEpoch: history.epoch,
      revision: history.revision,
      limit: options.limit,
      targetBytes: options.targetBytes,
      complete: true,
      pages: true,
      ...(options.knownSourceToken ? { knownToken: options.knownSourceToken } : {}),
    });
    if (update.status === "unchanged") return { unchanged: true, sourceToken: update.token };
    return {
      messages: update.value.messages,
      historyStartIndex: update.value.startIndex,
      sourceToken: update.token,
      complete: update.value.complete,
      generation,
      historyEpoch: `${generation}:${history.epoch}`,
      freshness: "current",
      representation: "summary",
      ...(update.value.historyCursor ? { historyCursor: update.value.historyCursor } : {}),
    };
  };
  let pageReads = 0;
  const transcriptPage = async (
    _sessionId: string,
    options: { cursor: string; limit: number; targetBytes: number },
  ): Promise<ProviderTranscriptPage | undefined> => {
    pageReads += 1;
    const page = bridgeTranscriptPage(history.messages, {
      generation,
      contentEpoch: history.epoch,
      complete: true,
      ...options,
    });
    if (page.status !== "page") return { status: "expired" };
    return {
      status: "page",
      messages: page.messages,
      historyStartIndex: page.startIndex,
      ...(page.nextCursor ? { historyCursor: page.nextCursor } : {}),
      complete: page.complete,
      truncated: page.truncated,
      historyEpoch: `${generation}:${history.epoch}`,
      representation: "summary",
    };
  };
  const stub = createProviderStub("codex", {
    transcriptSnapshot,
    transcriptPage,
    messages: async () => history.messages,
  });
  return { stub, snapshotCalls, pageReads: () => pageReads };
}

function partsOf(row: unknown): TestPart[] {
  return (row as TestMessage).parts;
}

function artifactParts(row: unknown): TestPart[] {
  return partsOf(row).filter((part) => part.type === "artifact");
}

function rowById(rows: readonly unknown[], id: string): TestMessage {
  const row = rows.find((candidate) => (candidate as TestMessage).id === id);
  if (!row) throw new Error(`row ${id} missing`);
  return row as TestMessage;
}

async function pageAll(
  service: NativeAgentService,
  identity: typeof sessionA,
  cursor: string | undefined,
): Promise<TestMessage[]> {
  const rows: TestMessage[] = [];
  while (cursor) {
    const page = await service.getMessagePage({
      ...identity,
      syncVersion: 1,
      before: cursor,
      limit: 60,
    });
    rows.unshift(...(page.messages as TestMessage[]));
    cursor = page.nextCursor;
  }
  return rows;
}

describe("artifact publications in the transcript projection", () => {
  test("attach to the end of the anchored row, then by arguments; nothing else moves", async () => {
    const ledger = ledgerDouble();
    const history = {
      messages: [
        { ...message("prompt"), role: "user" as const },
        message("m1", [{ type: "text", content: "Publishing." }, publishCall("call-1")]),
        // An idempotent retry with the same arguments: the anchor still wins.
        message("m2", [publishCall("call-2")]),
        message("m3", [
          publishCall("call-3", { artifactId: "art_second0001", expectedRevision: 1 }),
        ]),
        // A failed publish never anchors anything.
        message("m4", [
          publishCall("call-4", { artifactId: "art_failed0001", expectedRevision: 1 }, "error"),
        ]),
      ],
      epoch: 1,
      revision: 1,
    };
    const anchored = ledger.publish({ toolCallId: "call-1" });
    const byArgs = ledger.publish({ artifactId: "art_second0001", revision: 1 });
    ledger.publish({ artifactId: "art_failed0001", revision: 1 });
    const { stub } = summaryProvider(history);
    await withService(
      {
        prefix: "orkestrator-artifact-anchor-",
        provider: async () => stub.provider,
        artifactLedger: () => ledger.reader,
      },
      async ({ service }) => {
        await service.ensureSession(sessionA);
        const update = await service.getTranscriptUpdate({
          ...sessionA,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        const rows = update.value.messages;
        // No synthetic rows: the unanchored (failed-call) publication is the
        // renderer's to place.
        expect(rows.map((row) => (row as TestMessage).id)).toEqual([
          "prompt",
          "m1",
          "m2",
          "m3",
          "m4",
        ]);
        const m1 = rowById(rows, "m1");
        expect(m1.parts.at(-1)).toEqual({
          type: "artifact",
          content: artifactPartContent(anchored.ref),
          artifact: anchored.ref,
          publishedAt: anchored.publishedAt,
          conversationSequence: anchored.conversationSequence,
          sourcePartId: `artifact:${anchored.publicationId}`,
        });
        expect(m1.parts.slice(0, 2).map((part) => part.type)).toEqual(["text", "tool-invocation"]);
        expect(publishArtifactCallContract(m1.parts[1]!)).toEqual({
          ...SUCCESSFUL_PUBLISH_CONTRACT,
        });
        expect(artifactParts(rowById(rows, "m2"))).toEqual([]);
        expect(artifactParts(rowById(rows, "m3")).map((part) => part.sourcePartId)).toEqual([
          `artifact:${byArgs.publicationId}`,
        ]);
        expect(artifactParts(rowById(rows, "m4"))).toEqual([]);
      },
    );
  });

  test("a ledger change moves the token and delivers the updated row past the provider's unchanged", async () => {
    const ledger = ledgerDouble();
    const history = {
      messages: [message("m0"), message("m1", [publishCall("call-1")]), message("m2")],
      epoch: 1,
      revision: 1,
    };
    const { stub, snapshotCalls } = summaryProvider(history);
    await withService(
      {
        prefix: "orkestrator-artifact-ledger-change-",
        provider: async () => stub.provider,
        artifactLedger: () => ledger.reader,
      },
      async ({ service }) => {
        await service.ensureSession(sessionA);
        const read = (knownToken?: string) =>
          service.getTranscriptUpdate({
            ...sessionA,
            viewVersion: 1,
            liveWindow,
            ...(knownToken ? { knownToken } : { forceSnapshot: true }),
          });
        const first = await read();
        if (first.status !== "snapshot") throw new Error("expected a snapshot");
        expect(artifactParts(rowById(first.value.messages, "m1"))).toEqual([]);
        const settled = await read(first.token);
        expect(settled.status).toBe("unchanged");

        const publication = ledger.publish({ toolCallId: "call-1" });
        const before = snapshotCalls.length;
        const second = await read(first.token);
        if (second.status !== "delta") throw new Error(`expected a delta, got ${second.status}`);
        expect(second.token).not.toBe(first.token);
        // The provider history did not change; its "unchanged" was bypassed.
        expect(snapshotCalls[before]?.knownSourceToken).toBeUndefined();
        const upserts = [
          ...second.delta.messageUpserts,
          ...(second.delta.messagePatches ?? []),
        ] as unknown[];
        expect(upserts).toHaveLength(1);
        const view = applyNativeAgentTranscriptDelta(first.value, second.delta);
        if (!view) throw new Error("expected the delta to apply");
        expect(
          artifactParts(rowById(view.messages, "m1")).map((part) => part.sourcePartId),
        ).toEqual([`artifact:${publication.publicationId}`]);
        expect(view.revisedMessages).toBeUndefined();

        // Settled again: the source-token shortcut is used once more.
        const third = await read(second.token);
        expect(third.status).toBe("unchanged");
        expect(snapshotCalls.at(-1)?.knownSourceToken).toBeString();
      },
    );
  });

  test("a row outside the window reaches readers through revisedMessages and history pages", async () => {
    const ledger = ledgerDouble();
    const history = {
      messages: Array.from({ length: 150 }, (_, index) =>
        index === 10 ? message("m10", [publishCall("call-10")]) : message(`m${index}`),
      ),
      epoch: 1,
      revision: 1,
    };
    const { stub, pageReads } = summaryProvider(history);
    await withService(
      {
        prefix: "orkestrator-artifact-revised-",
        provider: async () => stub.provider,
        artifactLedger: () => ledger.reader,
      },
      async ({ service }) => {
        await service.ensureSession(sessionA);
        const read = (knownToken?: string) =>
          service.getTranscriptUpdate({
            ...sessionA,
            viewVersion: 1,
            liveWindow,
            ...(knownToken ? { knownToken } : { forceSnapshot: true }),
          });
        const first = await read();
        if (first.status !== "snapshot") throw new Error("expected a snapshot");
        expect(first.value.historyPaging).toBe("direct");
        const cursor = first.value.historyCursor;
        const before = await pageAll(service, sessionA, cursor);
        expect(artifactParts(rowById(before, "m10"))).toEqual([]);
        const pagesRead = pageReads();

        const publication = ledger.publish({ toolCallId: "call-10" });
        const second = await read(first.token);
        if (second.status !== "delta") throw new Error(`expected a delta, got ${second.status}`);
        expect(second.delta.messageUpserts).toEqual([]);
        const revised = second.delta.revisedMessages ?? [];
        expect(revised.map((row) => (row as TestMessage).id)).toEqual(["m10"]);
        expect(artifactParts(revised[0]).map((part) => part.sourcePartId)).toEqual([
          `artifact:${publication.publicationId}`,
        ]);
        // The revised row is the whole row, its call intact.
        expect(partsOf(revised[0])[0]?.toolUseId).toBe("call-10");

        // Pages answer from their cache with the publication placed.
        const after = await pageAll(service, sessionA, cursor);
        expect(pageReads()).toBe(pagesRead);
        expect(artifactParts(rowById(after, "m10")).map((part) => part.sourcePartId)).toEqual([
          `artifact:${publication.publicationId}`,
        ]);

        // A later streaming change does not resend it; a snapshot still has it.
        history.messages[149] = { ...history.messages[149]!, content: "streamed" };
        history.revision += 1;
        const third = await read(second.token);
        if (third.status !== "delta") throw new Error(`expected a delta, got ${third.status}`);
        expect(third.delta.revisedMessages).toEqual([]);
        const snapshot = await read();
        if (snapshot.status !== "snapshot") throw new Error("expected a snapshot");
        expect(
          (snapshot.value.revisedMessages ?? []).map((row) => (row as TestMessage).id),
        ).toEqual(["m10"]);
      },
    );
  });

  test("a row that leaves the window as its publication commits is sent as revised", async () => {
    const ledger = ledgerDouble();
    const history = {
      messages: Array.from({ length: 100 }, (_, index) =>
        index === 0 ? message("m0", [publishCall("call-0")]) : message(`m${index}`),
      ),
      epoch: 1,
      revision: 1,
    };
    const { stub } = summaryProvider(history);
    await withService(
      {
        prefix: "orkestrator-artifact-aging-",
        provider: async () => stub.provider,
        artifactLedger: () => ledger.reader,
      },
      async ({ service }) => {
        await service.ensureSession(sessionA);
        const read = (knownToken?: string) =>
          service.getTranscriptUpdate({
            ...sessionA,
            viewVersion: 1,
            liveWindow,
            ...(knownToken ? { knownToken } : { forceSnapshot: true }),
          });
        const first = await read();
        if (first.status !== "snapshot") throw new Error("expected a snapshot");
        expect(rowById(first.value.messages, "m0")).toBeDefined();

        history.messages.push(message("m100"), message("m101"));
        history.revision += 1;
        const publication = ledger.publish({ toolCallId: "call-0" });
        const second = await read(first.token);
        if (second.status !== "delta") throw new Error(`expected a delta, got ${second.status}`);
        const view = applyNativeAgentTranscriptDelta(first.value, second.delta);
        if (!view) throw new Error("expected the delta to apply");
        expect(view.messages.some((row) => (row as TestMessage).id === "m0")).toBe(false);
        const revised = view.revisedMessages ?? [];
        expect(revised.map((row) => (row as TestMessage).id)).toEqual(["m0"]);
        expect(artifactParts(revised[0]).map((part) => part.sourcePartId)).toEqual([
          `artifact:${publication.publicationId}`,
        ]);
      },
    );
  });

  test("never shows one session's publication in another session, or another environment's", async () => {
    // A ledger that ignored ownership must still not leak across sessions.
    const ledger = ledgerDouble({ leaky: true });
    const transcript = () => ({
      messages: [message("m1", [publishCall("call-1")])],
      epoch: 1,
      revision: 1,
    });
    ledger.publish({
      owner: { environmentId: "env-1", conversationKey: sessionB.logicalSessionKey },
    });
    const { stub } = summaryProvider(transcript());
    await withService(
      {
        prefix: "orkestrator-artifact-isolation-",
        provider: async () => stub.provider,
        artifactLedger: () => ledger.reader,
      },
      async ({ service }) => {
        for (const identity of [sessionA, sessionB]) await service.ensureSession(identity);
        const view = async (identity: typeof sessionA) => {
          const update = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          if (update.status !== "snapshot") throw new Error("expected a snapshot");
          return update.value.messages;
        };
        expect(artifactParts(rowById(await view(sessionA), "m1"))).toEqual([]);
        expect(artifactParts(rowById(await view(sessionB), "m1"))).toHaveLength(1);
      },
    );

    // Same conversation key, other environment: not this session's either.
    const other = ledgerDouble({ leaky: true });
    other.publish({
      owner: { environmentId: "env-2", conversationKey: sessionB.logicalSessionKey },
    });
    const index = new ArtifactOverlayIndex(() => other.reader);
    expect(index.overlay("env-1", sessionB.logicalSessionKey)?.publications ?? []).toEqual([]);
    expect(index.overlay("env-2", sessionB.logicalSessionKey)?.publications).toHaveLength(1);
  });

  test("the per-row cache keeps provider rows only", async () => {
    const ledger = ledgerDouble();
    const history = {
      messages: [message("m0"), message("m1", [publishCall("call-1")])],
      epoch: 1,
      revision: 1,
    };
    ledger.publish({ toolCallId: "call-1" });
    const { stub } = summaryProvider(history);
    await withService(
      {
        prefix: "orkestrator-artifact-row-cache-",
        provider: async () => stub.provider,
        artifactLedger: () => ledger.reader,
      },
      async ({ service }) => {
        await service.ensureSession(sessionA);
        const read = async () => {
          const update = await service.getTranscriptUpdate({
            ...sessionA,
            viewVersion: 1,
            liveWindow,
            forceSnapshot: true,
          });
          if (update.status !== "snapshot") throw new Error("expected a snapshot");
          return update.value.messages;
        };
        const overlaid = rowById(await read(), "m1");
        expect(artifactParts(overlaid)).toHaveLength(1);
        const cache = projectionInternals(service).projectedMessages;
        expect(cache.size).toBeGreaterThan(0);
        const cachedRows = Array.from(
          (
            cache as unknown as {
              entries: Map<string, { projected: unknown }>;
            }
          ).entries.values(),
          (entry) => entry.projected,
        );
        expect(cachedRows.some((row) => (row as TestMessage).id === "m1")).toBe(true);
        for (const row of cachedRows) {
          expect(artifactParts(row)).toEqual([]);
          expect(row).not.toBe(overlaid);
        }

        // The publication is gone (the conversation's artifacts were deleted):
        // the reused rows carry nothing from the earlier ledger read.
        ledger.publications.length = 0;
        expect(artifactParts(rowById(await read(), "m1"))).toEqual([]);
      },
    );
  });

  test("the whole-transcript projection used by exports and the CLI carries the part", async () => {
    const ledger = ledgerDouble();
    const rows = [message("m0"), message("m1", [publishCall("call-1")])];
    const publication = ledger.publish({ toolCallId: "call-1" });
    const stub = createProviderStub("codex", { messages: async () => rows });
    await withService(
      {
        prefix: "orkestrator-artifact-legacy-",
        provider: async () => stub.provider,
        artifactLedger: () => ledger.reader,
      },
      async ({ service }) => {
        await service.ensureSession(sessionA);
        const projection = await service.getProjection(sessionA);
        expect(
          artifactParts(rowById(projection!.messages, "m1")).map((part) => part.sourcePartId),
        ).toEqual([`artifact:${publication.publicationId}`]);
        const sync = await service.getProjectionUpdate({
          ...sessionA,
          syncVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (sync.status !== "snapshot") throw new Error("expected a snapshot");
        expect(artifactParts(rowById(sync.projection.messages, "m1"))).toHaveLength(1);
      },
    );
  });
});

describe("ledger reads", () => {
  test("are repeated only when the ledger revision moves, and a failing ledger yields no overlay", () => {
    const ledger = ledgerDouble();
    ledger.publish({ toolCallId: "call-1" });
    const index = new ArtifactOverlayIndex(() => ledger.reader);
    const first = index.overlay(sessionA.environmentId, sessionA.logicalSessionKey);
    expect(first?.publications).toHaveLength(1);
    expect(index.overlay(sessionA.environmentId, sessionA.logicalSessionKey)).toBe(first);
    expect(ledger.reads()).toBe(1);
    ledger.publish({ artifactId: "art_second0001", revision: 1 });
    const second = index.overlay(sessionA.environmentId, sessionA.logicalSessionKey);
    expect(second?.publications).toHaveLength(2);
    expect(ledger.reads()).toBe(2);

    // Deleted and restarted at the same sequence: the commit hint drops the
    // kept read even though the revision number is the same again.
    ledger.publications.length = 0;
    ledger.publish({ artifactId: "art_restart0001", revision: 1 });
    ledger.publish({ artifactId: "art_restart0002", revision: 1 });
    expect(
      index
        .overlay(sessionA.environmentId, sessionA.logicalSessionKey)
        ?.publications.map((entry) => entry.artifactId),
    ).toEqual(["art_restart0001", "art_restart0002"]);

    const failing = new ArtifactOverlayIndex(() => ({
      ledgerRevision: () => 3,
      publicationsForConversation: () => {
        throw new Error("storage unavailable");
      },
    }));
    expect(failing.overlay("env-1", "env-env-1:tab-a")).toBeNull();
  });

  test("overlaying is idempotent and never mutates a row", () => {
    const ledger = ledgerDouble();
    ledger.publish({ toolCallId: "call-1" });
    const overlay = new ArtifactOverlayIndex(() => ledger.reader).overlay(
      sessionA.environmentId,
      sessionA.logicalSessionKey,
    );
    const rows = [message("m1", [publishCall("call-1")])];
    const frozen = JSON.stringify(rows);
    const once = overlayArtifactParts(rows, overlay);
    expect(JSON.stringify(rows)).toBe(frozen);
    expect(artifactParts(once[0])).toHaveLength(1);
    const twice = overlayArtifactParts(once, overlay);
    expect(twice).toBe(once);
    // Memoized per ledger read: the same base row yields the same object.
    expect(overlayArtifactParts(rows, overlay)[0]).toBe(once[0]);
  });
});
