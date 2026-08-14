import { describe, expect, test } from "bun:test";
import {
  createAcpClient,
  createAcpSession,
  getAcpMessageWindow,
  mergeAcpMessageWindow,
  normalizeAcpComposer,
  type AcpMessage,
  type AcpMessageWindow,
} from "./acp-client";
import { EMPTY_NATIVE_AGENT_COMPOSER_STATE } from "@orkestrator/protocol/native-agent";

const nativeFetch = globalThis.fetch;

function message(id: string, content: string): AcpMessage {
  return {
    id,
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function window(
  baseIndex: number,
  messages: AcpMessage[],
  overrides: Partial<AcpMessageWindow> = {},
): AcpMessageWindow {
  return {
    messages,
    baseIndex,
    totalMessages: baseIndex + messages.length,
    revision: 1,
    status: "running",
    ...overrides,
  };
}

describe("mergeAcpMessageWindow", () => {
  test("replaces the mutating tail and keeps the finalized prefix", () => {
    const current = { messages: [message("a", "one"), message("b", "two")], baseIndex: 0 };
    const merged = mergeAcpMessageWindow(
      current,
      window(1, [message("b", "two and a half"), message("c", "three")]),
    );
    expect(merged.baseIndex).toBe(0);
    expect(merged.messages.map((entry) => entry.content))
      .toEqual(["one", "two and a half", "three"]);
  });

  test("takes the window outright when the bridge evicted history the client still held", () => {
    // The transcript bound dropped the client's leading messages, so its own
    // base is stale and the window is the only consistent view.
    const current = { messages: [message("a", "one"), message("b", "two")], baseIndex: 0 };
    const merged = mergeAcpMessageWindow(current, window(0, [message("z", "rebuilt")]));
    expect(merged).toEqual({
      messages: [message("z", "rebuilt")],
      baseIndex: 0,
    });
  });

  test("does not splice a gap when the window starts beyond what the client holds", () => {
    const current = { messages: [message("a", "one")], baseIndex: 0 };
    const merged = mergeAcpMessageWindow(current, window(5, [message("f", "six")]));
    expect(merged).toEqual({ messages: [message("f", "six")], baseIndex: 5 });
  });

  test("appends cleanly when the client is exactly caught up", () => {
    const current = { messages: [message("a", "one")], baseIndex: 3 };
    const merged = mergeAcpMessageWindow(current, window(3, [message("a", "one"), message("b", "two")]));
    expect(merged.baseIndex).toBe(3);
    expect(merged.messages.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  test("handles an empty client transcript", () => {
    const merged = mergeAcpMessageWindow(
      { messages: [], baseIndex: 0 },
      window(0, [message("a", "first")]),
    );
    expect(merged).toEqual({ messages: [message("a", "first")], baseIndex: 0 });
  });
});

describe("ACP bridge authentication", () => {
  test("carries the bridge credential in its dedicated proxy-safe header", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({
        id: "session-1",
        provider: "cursor",
        status: "idle",
        messages: [],
        baseIndex: 0,
        revision: 0,
      }), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await createAcpSession(createAcpClient("http://127.0.0.1:4099", "bridge-secret"));
    } finally {
      globalThis.fetch = nativeFetch;
    }

    expect(request?.headers.get("x-orkestrator-acp-token")).toBe("bridge-secret");
    expect(request?.headers.has("authorization")).toBe(false);
  });
});

describe("normalizeAcpComposer", () => {
  test("replaces missing or malformed snapshots with the empty composer", () => {
    expect(normalizeAcpComposer(undefined)).toEqual(EMPTY_NATIVE_AGENT_COMPOSER_STATE);
    expect(normalizeAcpComposer({ models: [] } as never)).toEqual(EMPTY_NATIVE_AGENT_COMPOSER_STATE);
  });

  test("keeps a normalized snapshot intact", () => {
    const composer = {
      ...EMPTY_NATIVE_AGENT_COMPOSER_STATE,
      models: [{ id: "composer-2.5", platform: "cursor" as const, label: "Composer 2.5" }],
      selectedModelId: "composer-2.5",
    };
    expect(normalizeAcpComposer(composer)).toEqual(composer);
  });

  test("does not share the empty composer's arrays between callers", () => {
    const first = normalizeAcpComposer(undefined);
    const second = normalizeAcpComposer(undefined);
    expect(first.models).not.toBe(second.models);
    expect(first.modes).not.toBe(second.modes);
  });
});

describe("getAcpMessageWindow", () => {
  async function windowFrom(body: Record<string, unknown>): Promise<AcpMessageWindow> {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    try {
      return await getAcpMessageWindow(createAcpClient("http://127.0.0.1:4099", "token"), "s1", 0);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  }

  // A window is incremental. A bridge old enough not to send `composer` must
  // leave the field absent so the caller keeps the snapshot it already has,
  // rather than being handed an empty composer that blanks its model picker.
  test("leaves composer undefined when the bridge omits it", async () => {
    const slice = await windowFrom({
      messages: [],
      baseIndex: 0,
      totalMessages: 0,
      revision: 3,
      status: "idle",
    });
    expect(slice.composer).toBeUndefined();
  });

  test("leaves composer undefined when the bridge sends an unusable one", async () => {
    const slice = await windowFrom({
      messages: [],
      baseIndex: 0,
      totalMessages: 0,
      revision: 3,
      status: "idle",
      composer: { models: "not-an-array" },
    });
    expect(slice.composer).toBeUndefined();
  });

  test("passes a usable composer through", async () => {
    const composer = { ...EMPTY_NATIVE_AGENT_COMPOSER_STATE, selectedModelId: "gpt-5.5" };
    const slice = await windowFrom({
      messages: [],
      baseIndex: 0,
      totalMessages: 0,
      revision: 3,
      status: "idle",
      composer,
    });
    expect(slice.composer).toEqual(composer);
  });
});
