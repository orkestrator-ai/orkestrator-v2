/**
 * How many transcript bytes the backend reads from a provider for the reads
 * report 0110 (E9) is about: a prompt send, a turn-state read, and an evicted
 * summary-backed tool detail. Also the `/messages` fallback of a bridge whose
 * `/transcript` route is missing.
 *
 * The provider is a fake over an in-memory history of fixed-size rows, and
 * every byte is counted where it leaves the fake, as the JSON a bridge would
 * send. No provider turn runs.
 */
import { describe, expect, test } from "bun:test";
import {
  bridgeTranscriptPage,
  bridgeTranscriptSummaryUpdate,
  readBridgeTranscriptDetail,
} from "@orkestrator/protocol/node/bridge-transcript-summary";
import type {
  ProviderInteractiveSnapshot,
  ProviderTranscriptDetail,
  ProviderTranscriptPage,
  ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import type { BridgeConnection } from "./agent-provider-contract.js";
import { HttpBridgeTranscriptReader } from "./http-bridge-transcript-reader.js";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";
import { projectionInternals } from "./native-agent-service-test-collaborators.js";

const ROWS = 400;
const OUTPUT_BYTES = 8_000;
const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;
const identity = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:read-bytes",
};

interface Row {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: Array<Record<string, unknown>>;
  createdAt: string;
}

function history(count = ROWS): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
    parts: [
      {
        type: "tool-invocation",
        content: "Read",
        sourcePartId: `m${index}:0`,
        toolUseId: `call-${index}`,
        toolOutput: String(index % 10).repeat(OUTPUT_BYTES),
        toolState: "success",
      },
    ],
    createdAt: new Date(index * 1_000).toISOString(),
  }));
}

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** A v2-bridge-shaped provider that counts what each read returns. */
function countingProvider(messages: Row[]) {
  const read = { raw: 0, rawRows: 0, rawCalls: 0, summary: 0, detail: 0, state: 0 };
  const tail = (limit: number | undefined) =>
    limit !== undefined && messages.length > limit ? messages.slice(-limit) : messages;
  const interactiveSnapshot = async (
    _sessionId: string,
    options?: { limit?: number },
  ): Promise<ProviderInteractiveSnapshot> => {
    const rows = tail(options?.limit);
    read.raw += bytesOf(rows);
    read.rawRows += rows.length;
    read.rawCalls += 1;
    return {
      status: "idle",
      messages: rows,
      messagesComplete: rows.length === messages.length,
      providerRevision: 1,
    };
  };
  const transcriptSnapshot = async (
    _sessionId: string,
    options: { limit: number; targetBytes: number; knownSourceToken?: string },
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> => {
    const update = bridgeTranscriptSummaryUpdate(messages, {
      sessionIdentity: "provider-session",
      generation: "g1",
      contentEpoch: 1,
      revision: 1,
      limit: options.limit,
      targetBytes: options.targetBytes,
      complete: true,
      pages: true,
      ...(options.knownSourceToken ? { knownToken: options.knownSourceToken } : {}),
    });
    if (update.status === "unchanged") return { unchanged: true, sourceToken: update.token };
    read.summary += bytesOf(update.value.messages);
    return {
      messages: update.value.messages,
      historyStartIndex: update.value.startIndex,
      sourceToken: update.token,
      complete: update.value.complete,
      generation: "g1",
      historyEpoch: "g1:1",
      freshness: "current",
      representation: "summary",
      historyPageable: true,
      ...(update.value.historyCursor ? { historyCursor: update.value.historyCursor } : {}),
    };
  };
  const transcriptDetail = async (
    _sessionId: string,
    locator: string,
  ): Promise<ProviderTranscriptDetail | undefined> => {
    const result = readBridgeTranscriptDetail(messages, locator);
    if (result.status !== "ok") return { status: "missing" };
    read.detail += bytesOf(result.detail);
    return { status: "ok", detail: result.detail };
  };
  const transcriptPage = async (
    _sessionId: string,
    options: { cursor: string; limit: number; targetBytes: number },
  ): Promise<ProviderTranscriptPage | undefined> => {
    const page = bridgeTranscriptPage(messages, {
      generation: "g1",
      contentEpoch: 1,
      complete: true,
      ...options,
    });
    if (page.status !== "page") return { status: "expired" };
    read.summary += bytesOf(page.messages);
    return {
      status: "page",
      messages: page.messages,
      historyStartIndex: page.startIndex,
      ...(page.nextCursor ? { historyCursor: page.nextCursor } : {}),
      complete: page.complete,
      truncated: page.truncated,
      historyEpoch: "g1:1",
      representation: "summary",
    };
  };
  const stub = createProviderStub("codex", {
    interactiveSnapshot,
    transcriptSnapshot,
    transcriptDetail,
    transcriptPage,
    sessionStateSnapshot: async () => {
      read.state += 1;
      return { status: "idle", providerRevision: 1 };
    },
    messages: async (_sessionId: string, options?: { limit?: number }) => {
      const rows = tail(options?.limit);
      read.raw += bytesOf(rows);
      read.rawRows += rows.length;
      read.rawCalls += 1;
      return rows;
    },
  } as Parameters<typeof createProviderStub>[1]);
  const reset = () => {
    for (const key of Object.keys(read) as Array<keyof typeof read>) read[key] = 0;
  };
  return { stub, read, reset };
}

async function settled(service: { shutdown?: unknown }): Promise<void> {
  const internals = projectionInternals(service as never);
  await waitForCondition(
    () =>
      internals.projectionRefreshes.size === 0 &&
      internals.progressiveReads.size === 0 &&
      internals.progressiveTrailing.size === 0,
  );
}

/*
 * Baseline on 69a3b4ca5, before E9, with this fixture (400 rows, 3,292,561
 * bytes): a prompt send read 33 raw rows (271,676 bytes); a one-message
 * projection for a turn check read 2 raw rows (16,466 bytes); an evicted
 * remote detail read all 400 raw rows (3,292,561 bytes) and still failed; the
 * `/messages` fallback received 3,292,610 bytes to keep 100 rows. Set
 * `E9_FIGURES` to a path to write the figures this run measured.
 */
describe("transcript read bytes (report 0110)", () => {
  test("turn checks, evicted remote details and the /messages fallback read no extra rows", async () => {
    const messages = history();
    const { stub, read, reset } = countingProvider(messages);
    const figures: Record<string, unknown> = {
      historyRows: messages.length,
      historyBytes: bytesOf(messages),
    };
    await withService(
      { prefix: "orkestrator-read-bytes-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        // A renderer reading the summary window, as the native tab does.
        const view = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (view.status !== "snapshot") throw new Error("expected a snapshot");
        await settled(service);

        reset();
        const sent = await service.dispatchIntent({
          ...identity,
          prompt: "next",
          requestId: "send-1",
        });
        expect(sent.outcome).toBe("accepted");
        await waitForCondition(() => read.rawCalls > 0 || read.state > 0);
        await settled(service);
        figures.promptSend = { ...read };
        // The dropped post-dispatch refresh reads a 32-row tail plus one (0150 task 3).
        expect(read.rawRows).toBeLessThanOrEqual(33);

        // What the turn checks now call (0150 task 2): no transcript at all.
        reset();
        const state = await service.getSessionStateUpdate({
          ...identity,
          viewVersion: 1,
          forceSnapshot: true,
        });
        await settled(service);
        expect(state.status).toBe("snapshot");
        figures.turnStateRead = { ...read };
        expect(read.raw + read.summary).toBe(0);
        expect(read.state).toBe(1);

        // TX-15: the inline-body context duplicates only that short tail.
        const internals = projectionInternals(service);
        const sessionEntries = (
          internals.projectedMessages as unknown as {
            sessions: Map<string, { entries: Map<string, unknown> }>;
          }
        ).sessions;
        // Key: session, remote provider session (empty for inline bodies), coordinator, row.
        const byContext = { summary: 0, inline: 0 };
        for (const session of sessionEntries.values()) {
          for (const key of session.entries.keys()) {
            if (key.split("\0")[1]) byContext.summary += 1;
            else byContext.inline += 1;
          }
        }
        figures.projectedRowEntries = byContext;
        expect(byContext.inline).toBeLessThanOrEqual(33);

        // 0110: an evicted remote detail is recovered without a raw read.
        const row = view.value.messages.at(-1) as Row;
        const detailRef = row.parts[0]!.detailRef as string;
        internals.evictToolDetails();
        reset();
        const details = await service.getProjectionToolDetails({ ...identity, detailRef });
        await settled(service);
        figures.evictedRemoteDetail = { ...read };
        expect(details.toolOutput).toBe(messages.at(-1)!.parts[0]!.toolOutput as string);
        expect(read.raw).toBe(0);
      },
    );

    // 0200: the `/messages` fallback of a bridge whose `/transcript` answers 404.
    let fallbackBytes = 0;
    let fallbackQuery = "";
    const fetchImpl = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/transcript")) return new Response("{}", { status: 404 });
      fallbackQuery = parsed.search;
      const limit = Number(parsed.searchParams.get("limit") ?? "0");
      const rows = limit > 0 ? messages.slice(-limit) : messages;
      const body = JSON.stringify({
        messages: rows,
        messageWindow: { truncated: rows.length < messages.length },
      });
      fallbackBytes += Buffer.byteLength(body);
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const connection = {
      agent: "codex",
      baseUrl: "http://bridge.test",
      authToken: "test",
    } as BridgeConnection;
    const reader = new HttpBridgeTranscriptReader("codex", connection, fetchImpl);
    const snapshot = await reader.snapshot("provider-session", {
      limit: liveWindow.messages,
      targetBytes: liveWindow.targetBytes,
    });
    if (!("messages" in snapshot)) throw new Error("expected a snapshot");
    figures.messagesFallback = {
      bytes: fallbackBytes,
      query: fallbackQuery,
      rows: snapshot.messages.length,
      complete: snapshot.complete,
    };
    expect(fallbackQuery).toBe(`?limit=${liveWindow.messages}`);
    expect(snapshot.messages).toHaveLength(liveWindow.messages);
    expect(snapshot.complete).toBe(false);
    expect(fallbackBytes).toBeLessThan(bytesOf(messages.slice(-liveWindow.messages)) + 1024);

    if (process.env.E9_FIGURES) {
      await Bun.write(process.env.E9_FIGURES, JSON.stringify(figures, null, 2));
    }
  });
});
