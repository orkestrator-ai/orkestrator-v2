import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  actionableProviderFailureId,
  formatProviderFailureReset,
  isProviderFailureRow,
  messageReportsProviderFailure,
} from "./provider-failure";

function row(id: string, overrides: Partial<NativeMessage> = {}): NativeMessage {
  return { id, role: "assistant", content: "", parts: [], createdAt: "t", ...overrides };
}

describe("provider failure rows", () => {
  test("only an inline error row or the backend's terminal error row is one", () => {
    expect(isProviderFailureRow(row("error-opencode-m1"))).toBe(true);
    expect(isProviderFailureRow(row("native-terminal:error:abc"))).toBe(true);
    expect(isProviderFailureRow(row("native-terminal:stopped:abc"))).toBe(false);
    expect(isProviderFailureRow(row("assistant-1"))).toBe(false);
  });

  test("a reply that ended on an error status line reports a failure", () => {
    expect(
      messageReportsProviderFailure(
        row("a1", { parts: [{ type: "status", content: "failed", severity: "error" }] }),
      ),
    ).toBe(true);
    expect(
      messageReportsProviderFailure(
        row("a1", { parts: [{ type: "status", content: "note", severity: "warning" }] }),
      ),
    ).toBe(false);
  });

  test("only the last row's failure is actionable; anything after it retires it", () => {
    const failure = row("native-terminal:error:abc", { role: "system" });
    expect(actionableProviderFailureId([row("a1"), failure])).toBe(failure.id);
    expect(actionableProviderFailureId([failure, row("u1", { role: "user" })])).toBeUndefined();
    expect(actionableProviderFailureId([failure, row("a2")])).toBeUndefined();
    expect(actionableProviderFailureId([])).toBeUndefined();
  });
});

describe("formatProviderFailureReset", () => {
  const now = Date.parse("2026-11-19T10:00:00.000Z");

  test("a future reset is shown, a passed or invalid one is not", () => {
    expect(formatProviderFailureReset("2026-11-19T12:00:00.000Z", now, "en-GB")).toBeTruthy();
    expect(formatProviderFailureReset("2026-11-19T09:00:00.000Z", now, "en-GB")).toBeUndefined();
    expect(formatProviderFailureReset("soon", now, "en-GB")).toBeUndefined();
    expect(formatProviderFailureReset(undefined, now, "en-GB")).toBeUndefined();
  });

  test("a reset on another day names the day", () => {
    const sameDay = formatProviderFailureReset("2026-11-19T12:00:00.000Z", now, "en-GB")!;
    const otherDay = formatProviderFailureReset("2026-11-22T12:00:00.000Z", now, "en-GB")!;
    expect(otherDay.length).toBeGreaterThan(sameDay.length);
  });
});
