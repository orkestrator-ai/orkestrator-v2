import { describe, expect, test } from "bun:test";
import {
  DIAGNOSTIC_TAIL_MAX_BYTES,
  DIAGNOSTIC_TAIL_MAX_LINES,
  boundDiagnosticTail,
  boundedTailCommand,
} from "../src/core/container-log-bounds";
import { AUTH_SECRET_CANARIES } from "../../../tests/helpers/auth-secret-canaries.js";

const { anthropicApiKey, cursorApiKey, refreshToken, xaiApiKey } = AUTH_SECRET_CANARIES;
// GitHub's own shapes: the shared canary's underscores make it no real PAT.
const classicPat = `ghp_${"ORKCANARY".padEnd(36, "0")}`;
const fineGrainedPat = `github_pat_${"ORKCANARY".padEnd(22, "0")}_${"0".repeat(59)}`;

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

  test("scrubs credentials from the tail and leaves plain lines alone", () => {
    const plain = [
      "2026-11-03T09:00:00Z INFO bridge listening on 0.0.0.0:4096",
      "GET /session/ses_abc123/status 200 3ms",
      "warn: retrying model catalogue fetch (attempt 2 of 3)",
    ] as const;
    const text = [
      plain[0],
      `git push failed: https://x-access-token:${classicPat}@github.com/acme/repo.git`,
      `mcp auth failed for ${classicPat}`,
      `gh auth: ${fineGrainedPat}`,
      `anthropic rejected ${anthropicApiKey}`,
      plain[1],
      `grok key ${xaiApiKey} expired`,
      `cursor ${cursorApiKey}`,
      `refreshing with ${refreshToken}`,
      plain[2],
      "",
    ].join("\n");

    const bounded = boundDiagnosticTail(text);

    const secrets = [anthropicApiKey, classicPat, cursorApiKey, fineGrainedPat, refreshToken];
    for (const secret of [...secrets, xaiApiKey]) {
      expect(bounded).not.toContain(secret);
    }
    expect(bounded).not.toContain("ORKCANARY");
    expect(bounded.split("\n")).toEqual([
      plain[0],
      "git push failed: https://[redacted]@github.com/acme/repo.git",
      "mcp auth failed for [redacted]",
      "gh auth: [redacted]",
      "anthropic rejected [redacted]",
      plain[1],
      "grok key [redacted] expired",
      "cursor [redacted]",
      "refreshing with [redacted]",
      plain[2],
      "",
    ]);
    expect(boundDiagnosticTail(`${plain.join("\n")}\n`)).toBe(`${plain.join("\n")}\n`);
  });

  test.each(["x".repeat(64 * 1024), "a-".repeat(32 * 1024)])(
    "redacts a maximum-size identifier run without an event-loop stall %#",
    (text) => {
      const start = performance.now();
      const result = boundDiagnosticTail(text);
      const elapsed = performance.now() - start;
      expect(result).toBe(text);
      // Previously 1–2 seconds; generous headroom over the linear pass.
      expect(elapsed).toBeLessThan(250);
    },
  );

  test("redacts decoded credentials in JSON records mixed with raw and malformed lines", () => {
    const record = JSON.stringify({
      orklog: 1,
      ts: "2026-11-03T10:00:00Z",
      level: "warn",
      area: "updater",
      event: "check.failed",
      fields: {
        message: 'password: "hunter2abc"',
        detail: '{"client_secret": "nestedCanary123"}',
        error: { name: "Error", message: 'client_secret: "errorCanary123"' },
      },
    });
    const malformed = "not JSON password=rawCanary123";
    const result = boundDiagnosticTail([record, malformed, "plain line", ""].join("\n"));
    for (const secret of ["hunter2abc", "nestedCanary123", "errorCanary123", "rawCanary123"]) {
      expect(result).not.toContain(secret);
    }
    const lines = result.split("\n");
    expect(JSON.parse(lines[0]!).fields.message).toBe("password: [redacted]");
    expect(lines.slice(1)).toEqual(["not JSON password=[redacted]", "plain line", ""]);
  });

  test("a redacted tail keeps the byte and line caps", () => {
    const line = `token rotated ${classicPat} ok`;
    const text = Array.from({ length: 5_000 }, () => line).join("\n");
    expect(Buffer.byteLength(text)).toBeGreaterThan(DIAGNOSTIC_TAIL_MAX_BYTES);

    const bounded = boundDiagnosticTail(text);
    const [marker, ...rest] = bounded.split("\n");
    expect(marker).toBe("[earlier output truncated]");
    expect(Buffer.byteLength(rest.join("\n"))).toBeLessThanOrEqual(DIAGNOSTIC_TAIL_MAX_BYTES);
    expect(rest.length).toBeLessThanOrEqual(DIAGNOSTIC_TAIL_MAX_LINES + 1);
    expect(bounded).not.toContain("ORKCANARY");
    expect(rest.at(-1)).toBe("token rotated [redacted] ok");
  });

  test("a replacement longer than its match cannot push the tail past the byte cap", () => {
    // Each `sig=a` grows by nine bytes once redacted. Few enough lines that
    // only the byte cap can cut this.
    const line = `GET /d?sig=a${"&sig=a".repeat(100)}`;
    const text = Array.from({ length: 100 }, () => line).join("\n");
    expect(Buffer.byteLength(text)).toBeLessThan(DIAGNOSTIC_TAIL_MAX_BYTES);

    const bounded = boundDiagnosticTail(text);
    const [marker, ...rest] = bounded.split("\n");
    expect(marker).toBe("[earlier output truncated]");
    expect(Buffer.byteLength(rest.join("\n"))).toBeLessThanOrEqual(DIAGNOSTIC_TAIL_MAX_BYTES);
    expect(rest.length).toBeLessThan(100);
    expect(rest.at(-1)).toBe(`GET /d?sig=[redacted]${"&sig=[redacted]".repeat(100)}`);
  });
});
