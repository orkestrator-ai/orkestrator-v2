import { describe, expect, test } from "bun:test";
import {
  DIAGNOSTIC_TAIL_MAX_BYTES,
  DIAGNOSTIC_TAIL_MAX_LINES,
  boundDiagnosticTail,
  boundedTailCommand,
} from "../../../apps/backend/src/core/container-log-bounds";

describe("diagnostic tail bounds", () => {
  test("bounds bytes at the source before lines", () => {
    expect(boundedTailCommand("/tmp/codex-bridge.log")).toBe(
      `tail -c ${DIAGNOSTIC_TAIL_MAX_BYTES} /tmp/codex-bridge.log 2>/dev/null | tail -n ${DIAGNOSTIC_TAIL_MAX_LINES} || true`,
    );
  });

  test("one enormous line cannot defeat a line limit", () => {
    const huge = `${"x".repeat(5 * DIAGNOSTIC_TAIL_MAX_BYTES)}\nlast line\n`;
    const bounded = boundDiagnosticTail(huge);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(DIAGNOSTIC_TAIL_MAX_BYTES + 64);
    expect(bounded.startsWith("[earlier output truncated]\n")).toBe(true);
    expect(bounded.endsWith("last line\n")).toBe(true);
  });

  test("keeps the most recent lines and marks truncation", () => {
    const lines = Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n");
    const bounded = boundDiagnosticTail(lines).split("\n");
    expect(bounded[0]).toBe("[earlier output truncated]");
    expect(bounded.at(-1)).toBe("line 999");
    expect(bounded.length).toBeLessThanOrEqual(DIAGNOSTIC_TAIL_MAX_LINES + 2);
    expect(boundDiagnosticTail("short\n")).toBe("short\n");
  });

  test("never splits a multibyte character into a replacement prefix", () => {
    const text = "é".repeat(DIAGNOSTIC_TAIL_MAX_BYTES);
    const bounded = boundDiagnosticTail(text).split("\n")[1] ?? "";
    expect(bounded.startsWith("�")).toBe(false);
  });
});
