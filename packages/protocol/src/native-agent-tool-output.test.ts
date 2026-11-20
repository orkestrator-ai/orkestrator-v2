import { describe, expect, test } from "bun:test";
import {
  TOOL_OUTPUT_ERROR_MAX_BYTES,
  TOOL_OUTPUT_READ_DEFAULT_BYTES,
  TOOL_OUTPUT_READ_MAX_BYTES,
  boundToolOutputError,
  clampToolOutputLimit,
  parseToolOutputReadInput,
  sliceToolOutput,
} from "./native-agent-tool-output.js";
import {
  PUSH_LIMITS,
  TOOL_OUTPUT_PUSH_TOPIC,
  formatToolOutputPushKey,
  parseToolOutputPushKey,
} from "./push-events.js";

const bytes = (value: string) => new TextEncoder().encode(value).length;

describe("sliceToolOutput", () => {
  test("tail returns the newest bytes and says what came before", () => {
    const output = "0123456789";
    const slice = sliceToolOutput(output, { mode: "tail", limit: 4 });
    expect(slice).toMatchObject({
      text: "6789",
      start: 6,
      end: 10,
      totalBytes: 10,
      truncatedBefore: true,
    });
    expect(slice.reset).toBeUndefined();
    const whole = sliceToolOutput(output, { mode: "tail", limit: 64 });
    expect(whole).toMatchObject({ text: output, start: 0, truncatedBefore: false });
  });

  test("range appends from a held end and honours its anchor", () => {
    const first = sliceToolOutput("line 1\n", { mode: "tail", limit: 64 });
    const grown = "line 1\nline 2\nline 3\n";
    const next = sliceToolOutput(grown, {
      mode: "range",
      cursor: first.end,
      anchor: first.endAnchor,
      limit: 7,
    });
    expect(next).toMatchObject({ text: "line 2\n", start: 7, end: 14, totalBytes: 21 });
    expect(next.reset).toBeUndefined();
    const rest = sliceToolOutput(grown, {
      mode: "range",
      cursor: next.end,
      anchor: next.endAnchor,
      limit: 64,
    });
    expect(rest).toMatchObject({ text: "line 3\n", start: 14, end: 21 });
    // Nothing new: an empty range at the end.
    const none = sliceToolOutput(grown, {
      mode: "range",
      cursor: rest.end,
      anchor: rest.endAnchor,
      limit: 64,
    });
    expect(none).toMatchObject({ text: "", start: 21, end: 21 });
  });

  test("retains literal U+FEFF at a range boundary", () => {
    const output = "first\ufeffsecond";
    const first = sliceToolOutput(output, { mode: "range", cursor: 0, limit: 5 });
    const next = sliceToolOutput(output, {
      mode: "range",
      cursor: first.end,
      anchor: first.endAnchor,
      limit: 64,
    });
    expect(first.text + next.text).toBe(output);
    expect(next.end).toBe(bytes(output));
  });

  test("a rewritten output answers the tail with reset", () => {
    const first = sliceToolOutput("abcdef", { mode: "tail", limit: 64 });
    const rewritten = sliceToolOutput("xyzdefghi", {
      mode: "range",
      cursor: first.end,
      anchor: first.endAnchor,
      limit: 4,
    });
    expect(rewritten).toMatchObject({ reset: true, text: "fghi", start: 5, end: 9 });
  });

  test("a rewrite before the last 64 bytes resets the displayed prefix", () => {
    const suffix = "same adjacent bytes ".repeat(8);
    const old = sliceToolOutput("old\n" + suffix, { mode: "tail", limit: 512 });
    expect(
      sliceToolOutput("new\n" + suffix + "final", {
        mode: "range",
        cursor: old.end,
        anchor: old.endAnchor,
        limit: 512,
      }),
    ).toMatchObject({ reset: true, text: "new\n" + suffix + "final" });
  });

  test("a cursor past the end or without one resets", () => {
    expect(sliceToolOutput("abc", { mode: "range", cursor: 10, limit: 2 })).toMatchObject({
      reset: true,
      text: "bc",
    });
    expect(sliceToolOutput("abc", { mode: "before", limit: 2 })).toMatchObject({ reset: true });
  });

  test("before reads history ending at a held start", () => {
    const output = "aaaa bbbb cccc";
    const tail = sliceToolOutput(output, { mode: "tail", limit: 4 });
    expect(tail.text).toBe("cccc");
    const earlier = sliceToolOutput(output, {
      mode: "before",
      cursor: tail.start,
      anchor: tail.startAnchor,
      limit: 5,
    });
    expect(earlier).toMatchObject({ text: "bbbb ", start: 5, end: 10, truncatedBefore: true });
    const first = sliceToolOutput(output, {
      mode: "before",
      cursor: earlier.start,
      anchor: earlier.startAnchor,
      limit: 64,
    });
    expect(first).toMatchObject({ text: "aaaa ", start: 0, end: 5, truncatedBefore: false });
  });

  test("never splits a character", () => {
    const output = "é".repeat(10); // two bytes each
    const tail = sliceToolOutput(output, { mode: "tail", limit: 5 });
    expect(tail.text).toBe("éé");
    expect(tail.start).toBe(16);
    expect(bytes(tail.text)).toBe(4);
    const range = sliceToolOutput(output, { mode: "range", cursor: 0, limit: 5 });
    expect(range).toMatchObject({ text: "éé", start: 0, end: 4 });
    // A cursor inside a character is not a cursor this read gave out.
    expect(sliceToolOutput(output, { mode: "range", cursor: 3, limit: 5 }).reset).toBe(true);
    const before = sliceToolOutput(output, { mode: "before", cursor: 10, limit: 5 });
    expect(before).toMatchObject({ text: "éé", start: 6, end: 10 });
  });

  test("the answer never carries more than the bound", () => {
    const output = "x".repeat(TOOL_OUTPUT_READ_MAX_BYTES * 3);
    const tail = sliceToolOutput(output, { mode: "tail", limit: 10 * TOOL_OUTPUT_READ_MAX_BYTES });
    expect(bytes(tail.text)).toBe(TOOL_OUTPUT_READ_MAX_BYTES);
    expect(tail.totalBytes).toBe(TOOL_OUTPUT_READ_MAX_BYTES * 3);
  });
});

describe("read bounds", () => {
  test("limits are clamped", () => {
    expect(clampToolOutputLimit(undefined)).toBe(TOOL_OUTPUT_READ_DEFAULT_BYTES);
    expect(clampToolOutputLimit(0)).toBe(1);
    expect(clampToolOutputLimit(1e12)).toBe(TOOL_OUTPUT_READ_MAX_BYTES);
    expect(clampToolOutputLimit(Number.NaN)).toBe(TOOL_OUTPUT_READ_DEFAULT_BYTES);
  });

  test("errors are cut to their bound", () => {
    expect(boundToolOutputError("short")).toBe("short");
    const long = boundToolOutputError("e".repeat(TOOL_OUTPUT_ERROR_MAX_BYTES * 2));
    expect(bytes(long)).toBeLessThanOrEqual(TOOL_OUTPUT_ERROR_MAX_BYTES + 3);
  });

  const session = { environmentId: "env", agent: "codex", logicalSessionKey: "tab" };

  test("input is validated without echoing values", () => {
    expect(parseToolOutputReadInput({ ...session, toolUseId: "call-1" })).toEqual({
      ...session,
      toolUseId: "call-1",
      mode: "tail",
      limit: TOOL_OUTPUT_READ_DEFAULT_BYTES,
    });
    expect(
      parseToolOutputReadInput({
        ...session,
        toolUseId: "call-1",
        mode: "range",
        cursor: 12,
        anchor: "e12.0000abcd",
        limit: 1e9,
      }),
    ).toMatchObject({ mode: "range", cursor: 12, limit: TOOL_OUTPUT_READ_MAX_BYTES });
    const secret = "secret-tool-id ".repeat(40);
    expect(() => parseToolOutputReadInput({ ...session, toolUseId: secret })).toThrow(
      "toolUseId must be a bounded, non-blank string",
    );
    expect(() => parseToolOutputReadInput({ ...session, toolUseId: " " })).toThrow();
    expect(() => parseToolOutputReadInput({ ...session, toolUseId: "c", mode: "all" })).toThrow(
      "mode must be tail, range or before",
    );
    expect(() => parseToolOutputReadInput({ ...session, toolUseId: "c", mode: "range" })).toThrow(
      "cursor is required for range and before reads",
    );
    expect(() =>
      parseToolOutputReadInput({ ...session, toolUseId: "c", mode: "range", cursor: -1 }),
    ).toThrow("cursor must be a non-negative integer");
    expect(() =>
      parseToolOutputReadInput({ ...session, toolUseId: "c", anchor: "a".repeat(100) }),
    ).toThrow("anchor must be a bounded string");
    expect(() =>
      parseToolOutputReadInput({ ...session, toolUseId: "c", detailRef: "d".repeat(200) }),
    ).toThrow("detailRef must be a bounded string");
  });
});

describe("tool-output push keys", () => {
  test("round-trip a call id that needs encoding, under a session key with slashes", () => {
    const key = {
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "pipeline/worker:1",
      toolUseId: "call/with space",
    };
    const formatted = formatToolOutputPushKey(key);
    expect(formatted).toBe("env-1/codex/pipeline/worker:1/call%2Fwith%20space");
    expect(parseToolOutputPushKey(formatted)).toEqual(key);
    expect(TOOL_OUTPUT_PUSH_TOPIC).toBe("tool-output");
  });

  test("refuses non-canonical, empty and oversized keys", () => {
    expect(parseToolOutputPushKey("env/codex/tab/")).toBeNull();
    expect(parseToolOutputPushKey("env/codex/tab/%zz")).toBeNull();
    // `a` spelled as `%61` names the same call as `a`: only one spelling is a key.
    expect(parseToolOutputPushKey("env/codex/tab/%61")).toBeNull();
    expect(parseToolOutputPushKey("env/codex/call")).toBeNull();
    expect(parseToolOutputPushKey(`env/codex/tab/${"c".repeat(300)}`)).toBeNull();
    expect(parseToolOutputPushKey(`env/codex/${"t".repeat(PUSH_LIMITS.maxKeyBytes)}/c`)).toBeNull();
  });
});
