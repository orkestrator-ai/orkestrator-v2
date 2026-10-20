import { describe, expect, test } from "bun:test";
import { parseUnifiedPatch, unquoteGitPath } from "./unified-patch";

describe("hunk-aware unified patch parser", () => {
  test("C04: source lines that look like headers stay content inside a hunk", () => {
    const patch = [
      "diff --git a/x.c b/x.c",
      "--- a/x.c",
      "+++ b/x.c",
      "@@ -1,2 +1,2 @@",
      "---counter;",
      "+++counter;",
      " keep();",
    ].join("\n");
    const parsed = parseUnifiedPatch(patch);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.additions).toBe(1);
    expect(parsed.deletions).toBe(1);
    expect(parsed.complete).toBe(true);
    expect(parsed.files[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual([
      "--counter;",
      "++counter;",
      "keep();",
    ]);
  });

  test("multiple files and hunks, with rename, mode and binary metadata", () => {
    const patch = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 90%",
      "rename from old.txt",
      "rename to new.txt",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "@@ -10,0 +12,1 @@",
      "+three",
    ].join("\n");
    const parsed = parseUnifiedPatch(patch);
    if (parsed.kind !== "parsed") throw new Error("expected parse");
    expect(parsed.files.map((f) => [f.status, f.oldPath, f.newPath])).toEqual([
      ["renamed", "old.txt", "new.txt"],
      ["mode-changed", "run.sh", "run.sh"],
      ["modified", "img.png", "img.png"],
      ["added", null, "added.txt"],
    ]);
    expect(parsed.files[2]!.binary).toBe(true);
    expect(parsed.files[3]!.additions).toBe(3);
    expect(parsed.additions).toBe(4);
    expect(parsed.deletions).toBe(1);
    expect(parsed.complete).toBe(true);
  });

  test("no-newline markers are preserved but never counted", () => {
    const patch = [
      "--- a/x",
      "+++ b/x",
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+a",
    ].join("\n");
    const parsed = parseUnifiedPatch(patch);
    if (parsed.kind !== "parsed") throw new Error("expected parse");
    expect(parsed.additions).toBe(1);
    expect(parsed.deletions).toBe(1);
    expect(parsed.files[0]!.hunks[0]!.lines.map((l) => l.type)).toEqual([
      "remove",
      "no-newline",
      "add",
    ]);
  });

  test("C11: a truncated hunk is incomplete, not silently complete", () => {
    const parsed = parseUnifiedPatch(
      ["--- a/x", "+++ b/x", "@@ -1,5 +1,5 @@", "-a", "+b"].join("\n"),
    );
    if (parsed.kind !== "parsed") throw new Error("expected parse");
    expect(parsed.complete).toBe(false);
    expect(parsed.issues.map((i) => i.code)).toContain("truncated-hunk");
  });

  test("combined diffs route to an explicit unsupported result", () => {
    expect(parseUnifiedPatch("diff --cc file\n@@@ -1 -1 +1 @@@\n")).toEqual({
      kind: "unsupported",
      reason: "combined-diff",
    });
  });

  test("+/- prose outside a hunk is not counted", () => {
    const parsed = parseUnifiedPatch(
      ["+ not a patch", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b"].join("\n"),
    );
    if (parsed.kind !== "parsed") throw new Error("expected parse");
    expect(parsed.additions).toBe(1);
    expect(parsed.complete).toBe(false);
  });

  test("quoted paths with escapes decode to their bytes", () => {
    expect(unquoteGitPath('"a\\tb"')).toBe("a\tb");
    expect(unquoteGitPath('"caf\\303\\251"')).toBe("café");
    const parsed = parseUnifiedPatch(
      [
        'diff --git "a/sp ace" "b/sp ace"',
        '--- "a/sp ace"',
        '+++ "b/sp ace"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
    );
    if (parsed.kind !== "parsed") throw new Error("expected parse");
    expect(parsed.files[0]!.newPath).toBe("sp ace");
  });

  test("bounds cap rendered rows while counts remain exact", () => {
    const body = Array.from({ length: 50 }, (_, i) => `+l${i}`);
    const parsed = parseUnifiedPatch(
      ["--- a/x", "+++ b/x", "@@ -0,0 +1,50 @@", ...body].join("\n"),
      {
        maxOutputLines: 10,
      },
    );
    if (parsed.kind !== "parsed") throw new Error("expected parse");
    expect(parsed.additions).toBe(50);
    expect(parsed.bodyTruncated).toBe(true);
    expect(parsed.complete).toBe(true);
  });
});
