import { describe, expect, test } from "bun:test";

import {
  hasConflictMarkers,
  isBinaryContent,
  mergeFile,
  mergeText,
  mergeTrees,
  type MergeTreeFile,
} from "./merge.js";

const text = (value: string): MergeTreeFile => ({
  content: Buffer.from(value),
  executable: false,
});

describe("mergeText", () => {
  test("takes each side's change when they touch different lines", () => {
    const base = "one\ntwo\nthree\nfour\nfive\n";
    const ours = "one\nTWO\nthree\nfour\nfive\n";
    const theirs = "one\ntwo\nthree\nfour\nFIVE\n";
    const merged = mergeText(base, ours, theirs);
    expect(merged.clean).toBe(true);
    expect(merged.text).toBe("one\nTWO\nthree\nfour\nFIVE\n");
  });

  test("keeps insertions from both sides in place", () => {
    const base = "a\nb\nc\n";
    const merged = mergeText(base, "start\na\nb\nc\n", "a\nb\nc\nend\n");
    expect(merged).toMatchObject({ clean: true, text: "start\na\nb\nc\nend\n" });
  });

  test("reports a conflict with base, local and configured text", () => {
    const base = "title\nbody\nfooter\n";
    const merged = mergeText(base, "title\nlocal body\nfooter\n", "title\nnew body\nfooter\n");
    expect(merged.clean).toBe(false);
    expect(merged.conflicts).toBe(1);
    expect(merged.chunks).toEqual([
      { kind: "stable", lines: ["title\n"] },
      {
        kind: "conflict",
        base: ["body\n"],
        ours: ["local body\n"],
        theirs: ["new body\n"],
      },
      { kind: "stable", lines: ["footer\n"] },
    ]);
    expect(merged.text).toBe(
      "title\n<<<<<<< local\nlocal body\n||||||| base\nbody\n=======\nnew body\n>>>>>>> configured\nfooter\n",
    );
    expect(hasConflictMarkers(merged.text)).toBe(true);
    expect(hasConflictMarkers("title\nresolved\nfooter\n")).toBe(false);
  });

  test("an identical change on both sides is not a conflict", () => {
    const merged = mergeText("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n");
    expect(merged).toMatchObject({ clean: true, text: "a\nB\nc\n" });
  });

  test("deleted lines merge with an unrelated edit", () => {
    const base = "keep\ndrop me\nmiddle\nlast\n";
    const merged = mergeText(base, "keep\nmiddle\nlast\n", "keep\ndrop me\nmiddle\nLAST\n");
    expect(merged).toMatchObject({ clean: true, text: "keep\nmiddle\nLAST\n" });
  });

  test("a deletion against an edit of the same line conflicts", () => {
    const merged = mergeText("a\nb\nc\n", "a\nc\n", "a\nB\nc\n");
    expect(merged.clean).toBe(false);
    expect(merged.chunks[1]).toEqual({
      kind: "conflict",
      base: ["b\n"],
      ours: [],
      theirs: ["B\n"],
    });
  });

  test("CRLF files merge by line and keep their line ending", () => {
    const base = "one\r\ntwo\r\nthree\r\n";
    const merged = mergeText(base, "ONE\r\ntwo\r\nthree\r\n", "one\r\ntwo\r\nTHREE\r\n");
    expect(merged).toMatchObject({ clean: true, text: "ONE\r\ntwo\r\nTHREE\r\n" });
  });

  test("a side that only converted line endings does not conflict", () => {
    const base = "one\ntwo\n";
    const merged = mergeText(base, "one\r\ntwo\r\n", "one\nTWO\n");
    expect(merged).toMatchObject({ clean: true, text: "one\r\nTWO\r\n" });
  });

  test("a last line without a newline is kept as it is", () => {
    const merged = mergeText("a\nb", "A\nb", "a\nb");
    expect(merged).toMatchObject({ clean: true, text: "A\nb" });
  });

  test("large rewrites stay bounded and still merge", () => {
    const base = Array.from({ length: 3_000 }, (_, index) => `line ${index}\n`).join("");
    const ours = Array.from({ length: 3_000 }, (_, index) => `local ${index}\n`).join("");
    const merged = mergeText(base, ours, base);
    expect(merged).toMatchObject({ clean: true, text: ours });
  });
});

describe("mergeFile and mergeTrees", () => {
  test("binary files are never merged when both sides changed them", () => {
    const base: MergeTreeFile = { content: Buffer.from([0, 1, 2]), executable: false };
    const ours: MergeTreeFile = { content: Buffer.from([0, 1, 3]), executable: false };
    const theirs: MergeTreeFile = { content: Buffer.from([0, 1, 4]), executable: false };
    expect(isBinaryContent(base.content)).toBe(true);
    expect(isBinaryContent(Buffer.from("plain text"))).toBe(false);
    expect(isBinaryContent(Buffer.from([0xff, 0xfe, 0x41]))).toBe(true);
    expect(mergeFile("logo.png", base, ours, theirs)).toMatchObject({
      outcome: "conflict",
      kind: "binary",
    });
    expect(mergeFile("logo.png", base, ours, base)).toMatchObject({ outcome: "local" });
  });

  test("whole-file additions and deletions", () => {
    const base = new Map([
      ["SKILL.md", text("base\n")],
      ["gone.md", text("old\n")],
      ["edited-upstream.md", text("x\n")],
    ]);
    const ours = new Map([
      ["SKILL.md", text("base\n")],
      ["local-new.md", text("mine\n")],
    ]);
    const theirs = new Map([
      ["SKILL.md", text("base\n")],
      ["gone.md", text("old\n")],
      ["edited-upstream.md", text("y\n")],
      ["upstream-new.md", text("theirs\n")],
    ]);
    const outcomes = mergeTrees(base, ours, theirs);
    expect(outcomes.map((entry) => [entry.path, entry.outcome])).toEqual([
      ["SKILL.md", "unchanged"],
      ["edited-upstream.md", "conflict"],
      ["gone.md", "deleted"],
      ["local-new.md", "local"],
      ["upstream-new.md", "configured"],
    ]);
    expect(outcomes[1]).toMatchObject({ kind: "deleted-locally" });
  });

  test("an executable bit changed on one side is kept", () => {
    const base = { content: Buffer.from("a\nkeep\nb\n"), executable: false };
    const ours = { content: Buffer.from("A\nkeep\nb\n"), executable: true };
    const theirs = { content: Buffer.from("a\nkeep\nB\n"), executable: false };
    const merged = mergeFile("run.sh", base, ours, theirs);
    expect(merged).toMatchObject({ outcome: "merged" });
    if (merged.outcome === "merged") {
      expect(merged.file.executable).toBe(true);
      expect(merged.file.content.toString()).toBe("A\nkeep\nB\n");
    }
  });
});
