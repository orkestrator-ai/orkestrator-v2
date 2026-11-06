import { describe, expect, test } from "bun:test";
import type { BridgeConnection } from "../agent-provider-contract.js";
import { HttpBridgeTranscriptReader } from "./transcript-reader.js";

const connection = {
  agent: "codex",
  baseUrl: "http://bridge.test",
  authToken: "test",
} as BridgeConnection;

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: "assistant",
    content: `message ${index}`,
    parts: [],
  }));

/**
 * A bridge whose `/transcript` route is missing. `honoursLimit: false` is a
 * bridge from before `?limit=`: it answers the whole window, untruncated.
 */
function legacyBridge(history: unknown[], honoursLimit: boolean) {
  const queries: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/transcript")) return new Response(null, { status: 404 });
    queries.push(parsed.search);
    const limit = Number(parsed.searchParams.get("limit") ?? "0");
    const cut = honoursLimit && limit > 0 && history.length > limit;
    return Response.json({
      messages: cut ? history.slice(-limit) : history,
      messageWindow: cut ? { truncated: true, omittedMessages: history.length - limit } : {},
    });
  }) as unknown as typeof fetch;
  return { reader: new HttpBridgeTranscriptReader("codex", connection, fetchImpl), queries };
}

const options = { limit: 10, targetBytes: 64 * 1024 };

describe("the /messages fallback", () => {
  test("asks the bridge for only the rows it keeps", async () => {
    const { reader, queries } = legacyBridge(rows(40), true);
    const snapshot = await reader.snapshot("session-1", options);
    expect(queries).toEqual(["?limit=10"]);
    if (!("messages" in snapshot)) throw new Error("expected a snapshot");
    expect(snapshot.messages.map((row) => (row as { id: string }).id)).toEqual(
      rows(40)
        .slice(-10)
        .map((row) => row.id),
    );
    // The bridge reported its cut, so the tail is not presented as the history.
    expect(snapshot.complete).toBe(false);
  });

  test("a history within the limit is complete", async () => {
    const { reader } = legacyBridge(rows(10), true);
    const snapshot = await reader.snapshot("session-1", options);
    if (!("messages" in snapshot)) throw new Error("expected a snapshot");
    expect(snapshot.messages).toHaveLength(10);
    expect(snapshot.complete).toBe(true);
  });

  test("a bridge that ignores ?limit= still gives a tail that is not called complete", async () => {
    const { reader } = legacyBridge(rows(40), false);
    const snapshot = await reader.snapshot("session-1", options);
    if (!("messages" in snapshot)) throw new Error("expected a snapshot");
    expect(snapshot.messages).toHaveLength(10);
    expect(snapshot.complete).toBe(false);
  });
});

describe("the legacy read with a limit", () => {
  test("reports its own cut as truncation, not as a transport bound", async () => {
    const { reader } = legacyBridge(rows(40), false);
    const legacy = await reader.legacy("session-1", 10);
    expect(legacy.messages).toHaveLength(10);
    expect(legacy.truncated).toBe(true);
    expect(legacy.omittedByTransport).toBe(false);
  });

  test("a whole window that fits is neither truncated nor bounded", async () => {
    const { reader } = legacyBridge(rows(5), false);
    const legacy = await reader.legacy("session-1", 10);
    expect(legacy.truncated).toBe(false);
    expect(legacy.omittedByTransport).toBe(false);
  });
});
