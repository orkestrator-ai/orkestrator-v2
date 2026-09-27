import { describe, expect, test } from "bun:test";
import {
  bridgeTranscriptPage,
  bridgeTranscriptSummaryUpdate,
  readBridgeTranscriptDetail,
} from "@orkestrator/protocol/bridge-transcript-summary";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/progressive-transcript";
import { codexConnection, httpProvider } from "./agent-provider-test-support.js";
import { HttpBridgeTranscriptCapabilities } from "./http-bridge-transcript-v2.js";
import type { NativeAgentRuntimeProvider } from "./agent-provider-contract.js";

const messages = [
  { id: "prompt", role: "user", content: "question", parts: [], createdAt: "2026-09-27T00:00:00Z" },
  {
    id: "m1",
    role: "assistant",
    content: "",
    parts: [
      {
        type: "tool-invocation",
        content: "Read",
        sourcePartId: "m1:0",
        toolUseId: "call",
        toolOutput: "x".repeat(700 * 1024),
      },
    ],
    createdAt: "2026-09-27T00:00:00Z",
  },
];

const readOptions = {
  sessionIdentity: "session-1",
  generation: "g",
  contentEpoch: 1,
  revision: 1,
  complete: true,
};

/** A bridge serving v2, or an older one that ignores `version=2`. */
function bridge(version: 1 | 2, extra: { details?: boolean; pages?: boolean } = {}) {
  return httpProvider((url) => {
    const parsed = new URL(url);
    const limit = Number(parsed.searchParams.get("limit"));
    const targetBytes = Number(parsed.searchParams.get("targetBytes"));
    if (parsed.pathname.endsWith("/transcript/detail")) {
      if (!extra.details) return new Response("", { status: 404 });
      return Response.json(
        readBridgeTranscriptDetail(messages, parsed.searchParams.get("locator") ?? ""),
      );
    }
    if (parsed.pathname.endsWith("/transcript/page")) {
      if (!extra.pages) return new Response("", { status: 404 });
      return Response.json(
        bridgeTranscriptPage(messages, {
          generation: "g",
          contentEpoch: 1,
          complete: true,
          cursor: parsed.searchParams.get("cursor") ?? "",
          limit,
          targetBytes,
        }),
      );
    }
    if (parsed.pathname.endsWith("/transcript")) {
      const options = {
        ...readOptions,
        limit,
        targetBytes,
        knownToken: parsed.searchParams.get("knownToken") ?? undefined,
      };
      return Response.json(
        version === 2 && parsed.searchParams.get("version") === "2"
          ? bridgeTranscriptSummaryUpdate(messages, { ...options, pages: true })
          : bridgeTranscriptUpdate(messages as never, options),
      );
    }
    return new Response("", { status: 404 });
  }, codexConnection);
}

const summaryRead = { limit: 1, targetBytes: 512 * 1024, representation: "summary" as const };

function runtime(provider: unknown): NativeAgentRuntimeProvider {
  return provider as NativeAgentRuntimeProvider;
}

describe("bridge transcript v2 negotiation", () => {
  test("an unknown session's 404 does not disable summaries for another session", async () => {
    const { provider, requests } = httpProvider((url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/missing/")) return new Response("", { status: 404 });
      return Response.json(
        bridgeTranscriptSummaryUpdate(messages, {
          ...readOptions,
          limit: 1,
          targetBytes: 512 * 1024,
          pages: true,
        }),
      );
    }, codexConnection);
    await runtime(provider).transcriptSnapshot!("missing", summaryRead);
    const found = await runtime(provider).transcriptSnapshot!("session-1", summaryRead);
    if ("unchanged" in found) throw new Error("expected snapshot");
    expect(found.representation).toBe("summary");
    expect(new URL(requests.at(-1)!.url).searchParams.get("version")).toBe("2");
  });
  test("a v2 bridge answers summaries whose details and pages resolve exactly", async () => {
    const { provider, requests } = bridge(2, { details: true, pages: true });
    const snapshot = await runtime(provider).transcriptSnapshot!("session-1", summaryRead);
    if ("unchanged" in snapshot) throw new Error("expected a snapshot");
    expect(snapshot.representation).toBe("summary");
    expect(snapshot.historyCursor).toBeDefined();
    const part = (snapshot.messages[0] as { parts: Array<Record<string, unknown>> }).parts[0]!;
    const locator = (part.detail as { locator: string }).locator;
    const detail = await runtime(provider).transcriptDetail!("session-1", locator);
    expect(detail).toEqual({ status: "ok", detail: { toolOutput: "x".repeat(700 * 1024) } });
    const page = await runtime(provider).transcriptPage!("session-1", {
      cursor: snapshot.historyCursor!,
      limit: 10,
      targetBytes: 512 * 1024,
    });
    expect(page).toMatchObject({ status: "page", historyStartIndex: 0, complete: true });
    expect(requests.map((request) => new URL(request.url).searchParams.get("version"))[0]).toBe(
      "2",
    );
  });

  test("an older bridge's v1 answer is used as-is and remembered", async () => {
    const { provider, requests } = bridge(1);
    const first = await runtime(provider).transcriptSnapshot!("session-1", summaryRead);
    if ("unchanged" in first) throw new Error("expected a snapshot");
    expect(first.representation).toBeUndefined();
    // The raw body came back in the v1 window: the prompt was pushed out.
    expect((first.messages as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["m1"]);
    await runtime(provider).transcriptSnapshot!("session-1", summaryRead);
    const versions = requests.map((request) => new URL(request.url).searchParams.get("version"));
    // One v2 attempt, answered v1, then v1 without asking again.
    expect(versions).toEqual(["2", "1"]);
  });

  test("a missing detail or page route means unsupported for this connection", async () => {
    const { provider, requests } = bridge(2);
    expect(await runtime(provider).transcriptDetail!("session-1", "bd1.x")).toBeUndefined();
    expect(await runtime(provider).transcriptDetail!("session-1", "bd1.x")).toBeUndefined();
    expect(
      await runtime(provider).transcriptPage!("session-1", {
        cursor: "bp1.x",
        limit: 1,
        targetBytes: 1,
      }),
    ).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  test("an unreachable or failing bridge proves nothing about capability", async () => {
    let fail = true;
    const { provider } = httpProvider(() => {
      if (fail) return new Response("busy", { status: 503 });
      return Response.json(
        bridgeTranscriptSummaryUpdate(messages, {
          ...readOptions,
          limit: 1,
          targetBytes: 512 * 1024,
          pages: true,
        }),
      );
    }, codexConnection);
    await expect(runtime(provider).transcriptSnapshot!("session-1", summaryRead)).rejects.toThrow();
    fail = false;
    const snapshot = await runtime(provider).transcriptSnapshot!("session-1", summaryRead);
    expect("unchanged" in snapshot ? undefined : snapshot.representation).toBe("summary");
  });

  test("a malformed v2 envelope is an error, not a silent v1 fallback", async () => {
    const { provider } = httpProvider(
      () => Response.json({ version: 2, status: "snapshot", token: "t", value: { messages: 1 } }),
      codexConnection,
    );
    await expect(runtime(provider).transcriptSnapshot!("session-1", summaryRead)).rejects.toThrow(
      "malformed",
    );
  });

  test("negative answers expire so an upgraded bridge is found again", () => {
    let now = 0;
    const capabilities = new HttpBridgeTranscriptCapabilities(() => now);
    capabilities.markUnsupported("pages");
    expect(capabilities.supports("pages")).toBe(false);
    now = 10 * 60_000;
    expect(capabilities.supports("pages")).toBe(true);
  });
});
