import { describe, expect, test } from "bun:test";
import {
  AGENT_HANDOFF_ARRAY_FRAME_OVERHEAD,
  AGENT_HANDOFF_CLOSE,
  AGENT_HANDOFF_OPEN,
  AGENT_HANDOFF_TRANSCRIPT_CLOSE,
  agentHandoffCarrierJson,
  agentHandoffRecordCost,
  buildAgentHandoffCarrier,
  prependAgentHandoffHistory,
  selectAgentHandoffRecords,
  startsWithAgentHandoffCarrier,
  truncateAgentHandoffText,
  type AgentHandoffTranscriptRecord,
} from "./agent-handoff-frame.js";

function record(index: number, body = `body ${index}`): AgentHandoffTranscriptRecord {
  return {
    index,
    role: "assistant",
    sourceId: `message-${index}`,
    createdAt: "2026-07-27T10:00:00.000Z",
    body,
  };
}

describe("agent handoff frame", () => {
  test("escapes markup, so a string cannot synthesize a structural tag", () => {
    const json = agentHandoffCarrierJson({ body: `${AGENT_HANDOFF_CLOSE}&` });
    expect(json).not.toContain("<");
    expect(json).not.toContain(">");
    expect(json).not.toContain("&");
    expect(JSON.parse(json).body).toBe(`${AGENT_HANDOFF_CLOSE}&`);
  });

  test("truncation reports exactly what it dropped and never exceeds the limit by more than the notice", () => {
    const text = "x".repeat(1_000);
    const truncated = truncateAgentHandoffText(text, 100);
    expect(truncated).toContain("characters omitted");
    expect(truncated.length).toBeLessThanOrEqual(100);
    const kept = truncated.indexOf("\n");
    expect(truncated).toContain(`[${1_000 - kept} characters omitted]`);
    expect(truncateAgentHandoffText("short", 100)).toBe("short");
  });

  test("a record's cost covers its share of the nested array", () => {
    const records = Array.from({ length: 50 }, (_, index) => record(index));
    const total = records.reduce((sum, item) => sum + agentHandoffRecordCost(item), 0);
    expect(total + AGENT_HANDOFF_ARRAY_FRAME_OVERHEAD).toBeGreaterThanOrEqual(
      agentHandoffCarrierJson(records).length,
    );
  });

  test("keeps everything that fits, in order", () => {
    const records = [record(0), record(1), record(2)];
    expect(selectAgentHandoffRecords(records, 100_000)).toEqual({ records, omitted: 0 });
  });

  test("keeps the first record and the newest ones when the budget is short", () => {
    const records = Array.from({ length: 30 }, (_, index) => record(index));
    const budget = agentHandoffRecordCost(records[0]!) * 6;
    const selected = selectAgentHandoffRecords(records, budget);
    expect(selected.records[0]!.index).toBe(0);
    expect(selected.records.at(-1)!.index).toBe(29);
    expect(selected.omitted).toBe(30 - selected.records.length);
    expect(selected.omitted).toBeGreaterThan(0);
    expect(agentHandoffCarrierJson(selected.records).length).toBeLessThanOrEqual(budget);
  });

  test("one huge record cannot crowd out smaller, older context", () => {
    const records = [record(0), record(1), record(2, "y".repeat(10_000)), record(3)];
    const selected = selectAgentHandoffRecords(records, 2_000);
    expect(selected.records.map(({ index }) => index)).toEqual([0, 1, 3]);
    expect(selected.omitted).toBe(1);
  });

  test("builds a complete carrier inside its budget, with the notice after the frame", () => {
    const records = Array.from({ length: 2_000 }, (_, index) => record(index));
    const carrier = buildAgentHandoffCarrier({
      introduction: "Continue this.",
      metadata: { id: "handoff-1" },
      records,
      totalMessages: 5_000,
      omissionNotice: (omitted) => (omitted > 0 ? `\n${omitted} omitted.` : ""),
      budget: 20_000,
    });
    expect(carrier.prompt.length).toBeLessThanOrEqual(20_000);
    expect(carrier.prompt.startsWith(`${AGENT_HANDOFF_OPEN}\nContinue this.`)).toBe(true);
    expect(carrier.prompt.endsWith(AGENT_HANDOFF_CLOSE)).toBe(true);
    // Omissions count messages the caller never read, too.
    expect(carrier.omitted).toBe(5_000 - carrier.records.length);
    const notice = `\n${carrier.omitted} omitted.`;
    expect(carrier.prompt).toContain(`${AGENT_HANDOFF_TRANSCRIPT_CLOSE}${notice}`);
  });

  test("recognises a carrier only at the start of a complete frame", () => {
    const whole = `  ${AGENT_HANDOFF_OPEN} anything ${AGENT_HANDOFF_CLOSE}`;
    expect(startsWithAgentHandoffCarrier(whole)).toBe(true);
    expect(startsWithAgentHandoffCarrier(`quoted ${whole}`)).toBe(false);
    expect(startsWithAgentHandoffCarrier(AGENT_HANDOFF_OPEN)).toBe(false);
    expect(startsWithAgentHandoffCarrier(42)).toBe(false);
  });

  test("prepending is idempotent and needs a real carrier", () => {
    const once = prependAgentHandoffHistory("<carrier>", "hello");
    expect(once.startsWith("<carrier>")).toBe(true);
    expect(once.endsWith("hello")).toBe(true);
    expect(prependAgentHandoffHistory("<carrier>", once)).toBe(once);
    expect(prependAgentHandoffHistory("   ", "hello")).toBe("hello");
  });
});
