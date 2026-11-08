import { describe, expect, test } from "bun:test";
import {
  checkOpenCode2Admission,
  classifyOpenCode2SteerLanding,
  isOpenCode2InputId,
  mintOpenCode2InputId,
  newestOpenCode2IdleId,
} from "./steer.js";
import type { OpenCode2Message } from "./types.js";

const user = (id: string, text = id): OpenCode2Message => ({
  id,
  type: "user",
  text,
  time: { created: 1 },
});
const answer = (id: string): OpenCode2Message => ({
  id,
  type: "assistant",
  content: [{ type: "text", text: "ok" }],
  time: { created: 1 },
});
const idle = (id: string): OpenCode2Message => ({
  id,
  type: "idle",
  outcome: "succeeded",
  time: { created: 1 },
});

describe("mintOpenCode2InputId", () => {
  test("matches OpenCode's message id format and sorts by time", () => {
    const zero = () => new Uint8Array(14);
    const first = mintOpenCode2InputId(1_794_177_118_945, zero);
    const second = mintOpenCode2InputId(1_794_177_118_945, zero);
    const later = mintOpenCode2InputId(1_794_177_118_946, zero);
    for (const id of [first, second, later]) expect(isOpenCode2InputId(id)).toBe(true);
    // Same millisecond: the counter keeps them distinct and ordered.
    expect(first < second).toBe(true);
    expect(second < later).toBe(true);
  });

  test("encodes the timestamp the way OpenCode does", () => {
    // Low 48 bits of timestamp * 0x1000 + counter, as packages/schema/src/identifier.ts.
    // A fresh millisecond, so the counter is 1.
    const id = mintOpenCode2InputId(1_794_177_118_944, () => new Uint8Array(14));
    expect(id).toBe("msg_1bd4a32e000100000000000000");
  });

  test("rejects ids OpenCode would refuse or did not mint", () => {
    expect(isOpenCode2InputId("not-a-msg-id")).toBe(false);
    expect(isOpenCode2InputId("msg_orkprobe0001")).toBe(false);
    expect(isOpenCode2InputId(undefined)).toBe(false);
  });
});

describe("checkOpenCode2Admission", () => {
  const sent = { id: "msg_1bd4a3246001bUla9iz3fnVsLQ", text: "steer me" };

  test("an answer echoing the sent input is admitted", () => {
    expect(
      checkOpenCode2Admission(
        { id: sent.id, type: "user", payload: { text: "steer me" }, delivery: "steer" },
        sent,
      ),
    ).toEqual({ kind: "admitted" });
  });

  test("the original record for a reused id with other text is a conflict", () => {
    // 2.2.6 answers 200 with the first record and drops the new text.
    expect(
      checkOpenCode2Admission({ id: sent.id, payload: { text: "the first text" } }, sent),
    ).toEqual({ kind: "conflict" });
  });

  test("anything else proves nothing", () => {
    expect(checkOpenCode2Admission(null, sent)).toEqual({ kind: "unrecognized" });
    expect(checkOpenCode2Admission({ id: "msg_other" }, sent)).toEqual({ kind: "unrecognized" });
    expect(checkOpenCode2Admission({ id: sent.id }, sent)).toEqual({ kind: "unrecognized" });
  });
});

describe("classifyOpenCode2SteerLanding", () => {
  // The 2.2.6 probe's timelines, as rows.
  const midRun = [user("p1"), answer("a1"), user("steer"), answer("a2"), idle("i1")];

  test("a steer with no idle row before it, in a session that never settled, is same-run", () => {
    expect(classifyOpenCode2SteerLanding(midRun, "steer", undefined)).toBe("same-run");
  });

  test("a steer after the anchor with no idle row between is same-run", () => {
    const history = [...midRun, user("p2"), answer("a3"), user("steer2"), answer("a4"), idle("i2")];
    expect(classifyOpenCode2SteerLanding(history, "steer2", "i1")).toBe("same-run");
  });

  test("a steer behind an idle row the provider had not seen started a new run", () => {
    const history = [...midRun, user("p2"), answer("a3"), idle("i2"), user("late"), answer("a4")];
    expect(classifyOpenCode2SteerLanding(history, "late", "i1")).toBe("new-run");
  });

  test("a steer not yet in history is pending", () => {
    expect(classifyOpenCode2SteerLanding(midRun, "missing", "i1")).toBe("pending");
  });

  test("a page without the anchor cannot be compared", () => {
    expect(classifyOpenCode2SteerLanding([user("late")], "late", "i1")).toBe("unknown");
  });

  test("newestOpenCode2IdleId finds the anchor for the next steer", () => {
    expect(newestOpenCode2IdleId([...midRun, user("p2"), idle("i2"), user("p3")])).toBe("i2");
    expect(newestOpenCode2IdleId([user("p1")])).toBeUndefined();
  });
});
