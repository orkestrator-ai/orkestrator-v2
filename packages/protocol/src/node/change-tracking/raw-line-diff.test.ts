import { describe, expect, test } from "bun:test";
import {
  countRawLineChanges,
  countRawLines,
  diffRawLines,
  isProbablyBinary,
  tokenizeRawLines,
  utf8Bytes,
} from "./raw-line-diff";

const bytes = (text: string) => utf8Bytes(text);

function lines(count: number, changeAt = -1): string {
  let out = "";
  for (let index = 0; index < count; index++) {
    out += index === changeAt ? `changed ${index}\n` : `line ${index}\n`;
  }
  return out;
}

describe("raw-lines-v1 tokens", () => {
  test("a terminal LF adds no phantom line; an unterminated final line counts", () => {
    expect(countRawLines(bytes(""))).toBe(0);
    expect(countRawLines(bytes("a"))).toBe(1);
    expect(countRawLines(bytes("a\n"))).toBe(1);
    expect(countRawLines(bytes("a\nb"))).toBe(2);
    expect(countRawLines(bytes("\n\n"))).toBe(2);
    expect(tokenizeRawLines(bytes("a\r\nb"))).toEqual(["a\r\n", "b"]);
  });

  test("bare CR is not a separator", () => {
    expect(countRawLines(bytes("a\rb\rc"))).toBe(1);
  });
});

describe("raw-lines-v1 counts (C01, C12)", () => {
  test("C01: a 100-line replacement with one changed line is +1/-1", () => {
    const result = countRawLineChanges(bytes(lines(100)), bytes(lines(100, 50)));
    expect(result).toMatchObject({ kind: "counted", additions: 1, deletions: 1 });
  });

  test("C12: LF to CRLF on one line is one removal and one addition", () => {
    const result = countRawLineChanges(bytes("a\nb\nc\n"), bytes("a\nb\r\nc\n"));
    expect(result).toMatchObject({ kind: "counted", additions: 1, deletions: 1 });
  });

  test("C12: adding a missing final newline changes that line", () => {
    const result = countRawLineChanges(bytes("a\nb"), bytes("a\nb\n"));
    expect(result).toMatchObject({ kind: "counted", additions: 1, deletions: 1 });
  });

  test("C12: blank lines are preserved and counted", () => {
    const result = countRawLineChanges(bytes("a\n\nb\n"), bytes("a\nb\n"));
    expect(result).toMatchObject({ kind: "counted", additions: 0, deletions: 1 });
  });

  test("C12: non-UTF-8 bytes keep their identity", () => {
    const before = new Uint8Array([0x61, 0xff, 0x0a]);
    const after = new Uint8Array([0x61, 0xfe, 0x0a]);
    expect(countRawLineChanges(before, after)).toMatchObject({ additions: 1, deletions: 1 });
    expect(countRawLineChanges(before, before)).toMatchObject({ additions: 0, deletions: 0 });
  });

  test("equal input is an exact zero", () => {
    expect(countRawLineChanges(bytes("x\n"), bytes("x\n"))).toMatchObject({
      kind: "counted",
      additions: 0,
      deletions: 0,
    });
  });

  test("budgets return a labelled limit instead of whole-input counts", () => {
    const big = countRawLineChanges(bytes(lines(10)), bytes(lines(10, 3)), { maxInputBytes: 10 });
    expect(big).toMatchObject({ kind: "limit", reason: "input-bytes" });
    const far = countRawLineChanges(bytes(lines(50)), bytes(lines(50).replaceAll("line", "x")), {
      maxCountEditDistance: 5,
    });
    expect(far).toMatchObject({ kind: "limit", reason: "edit-distance" });
  });

  test("an exhausted CPU budget is reported, not approximated", () => {
    let now = 0;
    const clock = () => (now += 1000);
    const result = countRawLineChanges(
      bytes(lines(200)),
      bytes(lines(200).replaceAll("line", "x")),
      { cpuBudgetMs: 1 },
      clock,
    );
    expect(result).toMatchObject({ kind: "limit", reason: "cpu-budget" });
  });
});

describe("raw-lines-v1 hunks", () => {
  test("hunk counts equal the count-only pass", () => {
    const before = bytes(lines(40));
    const after = bytes(lines(40, 10).replace("line 30\n", ""));
    const counted = countRawLineChanges(before, after);
    const diff = diffRawLines(before, after);
    expect(diff.kind).toBe("diff");
    if (diff.kind !== "diff" || counted.kind !== "counted") return;
    expect(diff.additions).toBe(counted.additions);
    expect(diff.deletions).toBe(counted.deletions);
    const adds = diff.hunks.flatMap((h) => h.lines).filter((l) => l.type === "add").length;
    expect(adds).toBe(diff.additions);
  });

  test("an unterminated final line renders a no-newline marker", () => {
    const diff = diffRawLines(bytes("a\nb"), bytes("a\nc"));
    expect(diff.kind).toBe("diff");
    if (diff.kind !== "diff") return;
    expect(diff.hunks[0]!.lines.map((l) => l.type)).toEqual([
      "context",
      "remove",
      "no-newline",
      "add",
      "no-newline",
    ]);
  });

  test("a body beyond the hunk budget keeps exact counts", () => {
    const before = bytes(lines(300));
    const after = bytes(lines(300).replaceAll("line", "x"));
    const diff = diffRawLines(before, after, { maxHunkEditDistance: 10 });
    expect(diff).toMatchObject({ kind: "counts-only", additions: 300, deletions: 300 });
  });

  test("binary sniffing follows Git's NUL heuristic", () => {
    expect(isProbablyBinary(new Uint8Array([0x61, 0x00]))).toBe(true);
    expect(isProbablyBinary(bytes("text"))).toBe(false);
  });
});

for (const merged of [false, true])
  test(`output budget bounds rows inside a ${merged ? "merged-context" : "single large"} hunk`, () => {
    const before = merged ? "a\nb\nc\nd\ne\nf\n" : "";
    const after = merged ? "A\nb\nC\nd\nE\nf\n" : lines(100);
    const result = diffRawLines(bytes(before), bytes(after), {
      maxOutputLines: 5,
      contextLines: 3,
    });
    expect(result.kind).toBe("diff");
    if (result.kind !== "diff") return;
    expect(result.hunks.reduce((sum, h) => sum + 1 + h.lines.length, 0)).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
    expect(result.additions).toBe(merged ? 3 : 100);
  });
