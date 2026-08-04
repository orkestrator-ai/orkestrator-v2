import { describe, expect, test } from "bun:test";
import {
  findOpenCodeMessageId,
  openCodeRequestMarker,
  resolveOpenCodeMessageId,
} from "./opencode-message-id";

function entry(info: Record<string, unknown>): { info: Record<string, unknown> } {
  return { info };
}

describe("OpenCode caller-owned message IDs", () => {
  test("places consecutive requests between completed server turns", () => {
    const sessionId = "ses_fcd9281c1001abcdefghijklmn";
    const first = resolveOpenCodeMessageId(sessionId, [], "zz");
    const firstAssistant = "msg_fcd9281c2001hsJUIHGDARuWRB";
    const history = [
      entry({ id: first, role: "user" }),
      entry({ id: firstAssistant, role: "assistant", parentID: first }),
    ];
    const second = resolveOpenCodeMessageId(sessionId, history, "aa");

    expect(first < firstAssistant).toBe(true);
    expect(firstAssistant < second).toBe(true);
    expect(second.endsWith(openCodeRequestMarker("aa"))).toBe(true);
  });

  test("orders accepted requests sharing one server prefix by send order", () => {
    const sessionId = "ses_fcd9281c1001abcdefghijklmn";
    const first = resolveOpenCodeMessageId(sessionId, [], "zz");
    const second = resolveOpenCodeMessageId(
      sessionId,
      [entry({ id: first, role: "user" })],
      "aa",
    );

    expect(first < second).toBe(true);
  });

  test("recovers the exact ID from either side of the parent relationship", () => {
    const id = resolveOpenCodeMessageId("invalid-session", [], "request-1", 1);
    expect(resolveOpenCodeMessageId(
      "invalid-session",
      [entry({ id, role: "user" })],
      "request-1",
      999,
    )).toBe(id);
    expect(findOpenCodeMessageId(
      [entry({ id: "assistant", role: "assistant", parentID: id })],
      "request-1",
    )).toBe(id);
  });

  test("keeps aliased-looking request IDs distinct and ignores malformed entries", () => {
    const sessionId = "ses_fcd9281c1001abcdefghijklmn";
    const plain = resolveOpenCodeMessageId(sessionId, [null, 1, {}], "foo");
    const prefixed = resolveOpenCodeMessageId(
      sessionId,
      [entry({ id: plain, role: "user" })],
      "msg_foo",
    );

    expect(plain).not.toBe(prefixed);
    expect(findOpenCodeMessageId([null, { info: null }], "foo")).toBeUndefined();
  });

  test.each(["", "   "])("rejects a blank request ID (%j)", (requestId) => {
    expect(() => resolveOpenCodeMessageId("session", [], requestId)).toThrow(TypeError);
    expect(() => findOpenCodeMessageId([], requestId)).toThrow(TypeError);
  });
});
