import { describe, expect, test } from "bun:test";

import {
  nextPartOrdinal,
  toolResultImagePartId,
  toolUseIdFromImagePartId,
} from "./transcript-part-ids.js";

describe("tool result image part ids", () => {
  test("round-trips the tool call a bridge attributed an image to", () => {
    expect(toolResultImagePartId("call_123", 0)).toBe("image:call_123:0");
    expect(toolUseIdFromImagePartId(toolResultImagePartId("call_123", 0))).toBe("call_123");
    expect(toolUseIdFromImagePartId(toolResultImagePartId("call_123", 7))).toBe("call_123");
  });

  test("keeps a tool call id that contains colons intact", () => {
    const id = toolResultImagePartId("server:tool:42", 3);
    expect(id).toBe("image:server:tool:42:3");
    expect(toolUseIdFromImagePartId(id)).toBe("server:tool:42");
  });

  test("rejects identifiers that are not tool result images", () => {
    // `progress:` and the ACP bridge's `<messageId>:<index>` share the shape
    // closely enough that a loose parser would claim them.
    expect(toolUseIdFromImagePartId("progress:call_123")).toBeNull();
    expect(toolUseIdFromImagePartId("abc123:0")).toBeNull();
    expect(toolUseIdFromImagePartId("image:call_123")).toBeNull();
    expect(toolUseIdFromImagePartId("image:call_123:last")).toBeNull();
    expect(toolUseIdFromImagePartId("image::0")).toBeNull();
    expect(toolUseIdFromImagePartId(undefined)).toBeNull();
  });
});

describe("nextPartOrdinal", () => {
  test("never reissues an ordinal after parts are shed from the front", () => {
    const message = { id: "m", parts: [] as { sourcePartId: string }[] };
    for (let index = 0; index < 10; index += 1) {
      message.parts.push({ sourcePartId: `m:${nextPartOrdinal(message)}` });
    }
    message.parts.splice(0, 6);
    const next = `m:${nextPartOrdinal(message)}`;
    expect(message.parts.map((part) => part.sourcePartId)).not.toContain(next);
    expect(next).toBe("m:10");
  });

  test("continues past the largest ordinal of a message it has not seen", () => {
    const restored = {
      parts: [
        { sourcePartId: "m:597" },
        { sourcePartId: "summary:598" },
        { sourcePartId: "m:599" },
      ],
    };
    expect(nextPartOrdinal(restored)).toBe(600);
    expect(nextPartOrdinal(restored)).toBe(601);
  });

  test("ignores suffixes that are not ordinals", () => {
    const message = {
      parts: [{ sourcePartId: "progress:call" }, { sourcePartId: "x:99999999999999999999" }],
    };
    expect(nextPartOrdinal(message)).toBe(2);
  });
});
