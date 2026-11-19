import { describe, expect, test } from "bun:test";
import {
  AGENT_MAIL_KEYED_ROW_CACHE_MAX_LENGTH,
  AGENT_MAIL_KEYED_ROW_CACHE_MAX_ROWS,
  AGENT_MAIL_MESSAGE_LOCATION_MAX,
  AgentMailKeyedRows,
} from "./storage-agent-mail-keyed-rows.js";

describe("agent mail keyed rows", () => {
  test("reuses a parsed row only while its serialized value is unchanged", () => {
    const keyed = new AgentMailKeyedRows();
    const parsed = { messages: [] };
    keyed.remember("mailboxes\0a", { value: "v1", parsed });
    expect(keyed.cached("mailboxes\0a", "v1")).toBe(parsed);
    expect(keyed.cached("mailboxes\0a", "v2")).toBeUndefined();
    expect(keyed.cached("mailboxes\0b", "v1")).toBeUndefined();
  });

  test("evicts the least recently used rows past the count bound", () => {
    const keyed = new AgentMailKeyedRows();
    for (let index = 0; index <= AGENT_MAIL_KEYED_ROW_CACHE_MAX_ROWS; index += 1) {
      keyed.remember(`row-${index}`, { value: `${index}`, parsed: index });
      // Keep the first row recently used, so the second is evicted instead.
      if (index === 1) expect(keyed.cached("row-0", "0")).toBe(0);
    }
    expect(keyed.sizes().rows).toBe(AGENT_MAIL_KEYED_ROW_CACHE_MAX_ROWS);
    expect(keyed.cached("row-0", "0")).toBe(0);
    expect(keyed.cached("row-1", "1")).toBeUndefined();
  });

  test("bounds the serialized length kept and skips a row larger than the bound", () => {
    const keyed = new AgentMailKeyedRows();
    const half = "x".repeat(AGENT_MAIL_KEYED_ROW_CACHE_MAX_LENGTH / 2);
    keyed.remember("a", { value: half, parsed: "a" });
    keyed.remember("b", { value: half, parsed: "b" });
    keyed.remember("c", { value: "small", parsed: "c" });
    expect(keyed.sizes().length).toBeLessThanOrEqual(AGENT_MAIL_KEYED_ROW_CACHE_MAX_LENGTH);
    expect(keyed.cached("a", half)).toBeUndefined();
    expect(keyed.cached("c", "small")).toBe("c");
    keyed.remember("huge", { value: `${half}${half}!`, parsed: "huge" });
    expect(keyed.cached("huge", `${half}${half}!`)).toBeUndefined();
    // Replacing a row's value releases the old value's length.
    keyed.remember("c", { value: "smaller", parsed: "c2" });
    expect(keyed.cached("c", "smaller")).toBe("c2");
    expect(keyed.sizes().length).toBe(half.length + "smaller".length);
  });

  test("locates mailbox messages and bounces, oldest location evicted first", () => {
    const keyed = new AgentMailKeyedRows();
    keyed.index("mailboxes", "e1\0agent", { messages: [{ id: "m1" }, { id: "m2" }, null] });
    keyed.index("idempotency", "scope\0request", { bounce: { id: "b1" } });
    keyed.index("counterparts", "m3", { id: "m3" });
    keyed.index("mailboxes", "broken", { messages: "not a list" });
    expect(keyed.locate("m1")).toEqual({ collection: "mailboxes", key: "e1\0agent" });
    expect(keyed.locate("b1")).toEqual({ collection: "idempotency", key: "scope\0request" });
    expect(keyed.locate("m3")).toBeUndefined();
    // A message seen in another mailbox moves there.
    keyed.index("mailboxes", "e2\0agent", { messages: [{ id: "m1" }] });
    expect(keyed.locate("m1")).toEqual({ collection: "mailboxes", key: "e2\0agent" });

    const many = Array.from({ length: AGENT_MAIL_MESSAGE_LOCATION_MAX }, (_, index) => ({
      id: `bulk-${index}`,
    }));
    keyed.index("mailboxes", "bulk", { messages: many });
    expect(keyed.sizes().locations).toBe(AGENT_MAIL_MESSAGE_LOCATION_MAX);
    expect(keyed.locate("m2")).toBeUndefined();
    expect(keyed.locate(`bulk-${AGENT_MAIL_MESSAGE_LOCATION_MAX - 1}`)).toEqual({
      collection: "mailboxes",
      key: "bulk",
    });
  });
});
