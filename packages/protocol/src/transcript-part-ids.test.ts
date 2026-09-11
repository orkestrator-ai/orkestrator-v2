import { describe, expect, test } from "bun:test";

import { toolResultImagePartId, toolUseIdFromImagePartId } from "./transcript-part-ids.js";

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
