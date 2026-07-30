import { describe, expect, test } from "bun:test";
import {
  MAX_RAW_APPLY_PATCH_CHANGES,
  MAX_RAW_APPLY_PATCH_SCAN_CHARS,
  parseRawApplyPatchChanges,
  rawApplyPatchParts,
} from "./apply-patch.js";

describe("raw apply_patch normalization", () => {
  test("extracts ordered add, update, move, and delete changes", () => {
    const changes = parseRawApplyPatchChanges(`*** Begin Patch
*** Add File: src/added.ts
+export const added = true;
*** Update File: src/changed.ts
@@
-old
+new
*** Update File: src/old-name.ts
*** Move to: src/new-name.ts
@@
-before
+after
*** Delete File: src/removed.ts
*** End Patch`);

    expect(changes).toHaveLength(4);
    expect(changes.map(({ path, targetPath, kind }) => ({
      path,
      targetPath,
      kind,
    }))).toEqual([
      { path: "src/added.ts", targetPath: "src/added.ts", kind: "add" },
      { path: "src/changed.ts", targetPath: "src/changed.ts", kind: "update" },
      { path: "src/old-name.ts", targetPath: "src/new-name.ts", kind: "move" },
      { path: "src/removed.ts", targetPath: "src/removed.ts", kind: "delete" },
    ]);
    expect(changes[0]).toMatchObject({ additions: 1, deletions: 0 });
    expect(changes[1]).toMatchObject({ additions: 1, deletions: 1 });
    expect(changes[2]?.diff).toContain("+++ b/src/new-name.ts");
  });

  test("creates one bounded normalized edit part per parsed file", () => {
    const parts = rawApplyPatchParts(
      `*** Begin Patch
*** Update File: src/a.ts
@@
-a
+A
*** Add File: src/b.ts
+B
*** End Patch`,
      "/workspace",
      "failure",
    );

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      content: "src/a.ts",
      toolName: "apply_patch",
      toolState: "failure",
      toolTitle: "update: src/a.ts",
      toolDiff: {
        filePath: "/workspace/src/a.ts",
        additions: 1,
        deletions: 1,
      },
    });
    expect(parts[1]).toMatchObject({
      content: "src/b.ts",
      toolTitle: "add: src/b.ts",
      toolDiff: { filePath: "/workspace/src/b.ts" },
    });
  });

  test("bounds both the scanned input and retained file count", () => {
    const manyChanges = Array.from(
      { length: MAX_RAW_APPLY_PATCH_CHANGES + 10 },
      (_value, index) => `*** Add File: file-${index}.txt\n+${index}`,
    ).join("\n");
    expect(parseRawApplyPatchChanges(
      `*** Begin Patch\n${manyChanges}\n*** End Patch`,
    )).toHaveLength(MAX_RAW_APPLY_PATCH_CHANGES);

    const beyondScan = `${"x".repeat(MAX_RAW_APPLY_PATCH_SCAN_CHARS)}
*** Add File: unseen.txt
+unseen
*** End Patch`;
    expect(parseRawApplyPatchChanges(beyondScan)).toEqual([]);
  });

  test("retains the files before the cap when it is hit mid-patch", () => {
    // The cap is reached at a *header*, which is the `break` path rather than
    // the early return inside `finishCurrent`. Everything before it survives.
    const changes = parseRawApplyPatchChanges(
      `*** Begin Patch\n${Array.from(
        { length: MAX_RAW_APPLY_PATCH_CHANGES + 5 },
        (_value, index) => `*** Add File: file-${index}.txt\n+${index}`,
      ).join("\n")}\n*** End Patch`,
    );

    expect(changes).toHaveLength(MAX_RAW_APPLY_PATCH_CHANGES);
    expect(changes[0]?.path).toBe("file-0.txt");
    expect(changes.at(-1)?.path).toBe(`file-${MAX_RAW_APPLY_PATCH_CHANGES - 1}.txt`);
  });

  test("a header truncated mid-line by the scan cap is not half-parsed", () => {
    const head = "*** Begin Patch\n*** Add File: seen.txt\n+seen\n";
    const marker = "*** Add File: ";
    // Land the cap exactly at the end of the header keyword, so the slice keeps
    // `*** Add File: ` with no path at all.
    const filler = "+".repeat(
      MAX_RAW_APPLY_PATCH_SCAN_CHARS - head.length - 1 - marker.length,
    );
    const changes = parseRawApplyPatchChanges(
      `${head}${filler}\n${marker}truncated.txt\n+never\n*** End Patch`,
    );

    // The anchored `(.+)$` needs at least one path character, so the severed
    // header matches nothing and no phantom file is invented.
    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe("seen.txt");
    expect(changes[0]?.diff).not.toContain("truncated.txt");
  });
});

describe("raw apply_patch input shapes", () => {
  const PATCH = `*** Begin Patch
*** Add File: src/added.ts
+added
*** End Patch`;

  test("accepts a verbatim custom_tool_call string", () => {
    expect(parseRawApplyPatchChanges(PATCH)).toHaveLength(1);
  });

  test("accepts a pre-parsed arguments record carrying the patch under `input`", () => {
    expect(parseRawApplyPatchChanges({ input: PATCH })).toHaveLength(1);
  });

  test("accepts JSON-encoded function_call arguments", () => {
    // A `function_call`-shaped apply_patch escapes its newlines, so the patch is
    // invisible until the arguments are decoded.
    expect(parseRawApplyPatchChanges(JSON.stringify({ input: PATCH })))
      .toHaveLength(1);
  });

  test("refuses oversized JSON arguments rather than decoding them", () => {
    const oversized = JSON.stringify({
      input: PATCH,
      padding: "x".repeat(MAX_RAW_APPLY_PATCH_SCAN_CHARS),
    });
    expect(oversized.length).toBeGreaterThan(MAX_RAW_APPLY_PATCH_SCAN_CHARS);
    // Treated as patch text, which contains no control lines once encoded.
    expect(parseRawApplyPatchChanges(oversized)).toEqual([]);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an array", ["*** Begin Patch"]],
    ["an empty string", ""],
    ["a whitespace-only string", "   \n\t  "],
    ["a record without `input`", { arguments: "*** Begin Patch" }],
    ["a record whose `input` is not a string", { input: 12 }],
    ["a record whose `input` is blank", { input: "   " }],
    ["unparseable JSON-looking arguments", "{not json"],
    ["JSON arguments that decode to an array", "[1,2,3]"],
  ])("returns no changes for %s", (_label, value) => {
    expect(parseRawApplyPatchChanges(value)).toEqual([]);
    expect(rawApplyPatchParts(value, "/workspace", "success")).toEqual([]);
  });

  test("returns no changes for a patch with no recognised control lines", () => {
    // The truncated call app-server sends while the patch is still streaming.
    expect(parseRawApplyPatchChanges("*** Begin Patch")).toEqual([]);
    expect(parseRawApplyPatchChanges("just some prose")).toEqual([]);
  });
});

describe("raw apply_patch control-line handling", () => {
  test("parses CRLF patches identically to LF", () => {
    const lf = parseRawApplyPatchChanges(
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+A\n*** End Patch",
    );
    const crlf = parseRawApplyPatchChanges(
      "*** Begin Patch\r\n*** Update File: src/a.ts\r\n@@\r\n-a\r\n+A\r\n*** End Patch",
    );

    expect(crlf).toEqual(lf);
    expect(crlf[0]).toMatchObject({
      path: "src/a.ts",
      kind: "update",
      additions: 1,
      deletions: 1,
    });
  });

  test("drops the `*** End of File` marker from the rendered diff", () => {
    const changes = parseRawApplyPatchChanges(`*** Begin Patch
*** Update File: src/a.ts
@@
-a
+A
*** End of File
*** End Patch`);

    expect(changes[0]?.diff).not.toContain("End of File");
    expect(changes[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  test("flushes the trailing file when `*** End Patch` is missing", () => {
    // Codex truncates a patch it never finished emitting; the last file still
    // has to render rather than being silently dropped.
    const changes = parseRawApplyPatchChanges(`*** Begin Patch
*** Add File: src/a.ts
+a
*** Add File: src/b.ts
+b`);

    expect(changes.map((change) => change.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(changes[1]).toMatchObject({ additions: 1, deletions: 0 });
  });

  test("ignores a header with an empty path and does not attribute its body", () => {
    const changes = parseRawApplyPatchChanges(`*** Begin Patch
*** Add File:${" "}
+orphaned
*** Add File: src/real.ts
+real
*** End Patch`);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe("src/real.ts");
    expect(changes[0]?.diff).not.toContain("orphaned");
  });

  test("ignores `*** Move to:` with no preceding file header", () => {
    const changes = parseRawApplyPatchChanges(`*** Begin Patch
*** Move to: src/nowhere.ts
*** Add File: src/a.ts
+a
*** End Patch`);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: "src/a.ts",
      targetPath: "src/a.ts",
      kind: "add",
    });
  });

  test("ignores `*** Move to:` with an empty target path", () => {
    const changes = parseRawApplyPatchChanges(`*** Begin Patch
*** Update File: src/a.ts
*** Move to:${" "}
@@
-a
+A
*** End Patch`);

    expect(changes[0]).toMatchObject({
      path: "src/a.ts",
      targetPath: "src/a.ts",
      kind: "update",
    });
    expect(changes[0]?.diff).toContain("+++ b/src/a.ts");
  });

  test("synthesises /dev/null headers for add and delete", () => {
    const [added, removed] = parseRawApplyPatchChanges(`*** Begin Patch
*** Add File: src/new.ts
+new
*** Delete File: src/gone.ts
*** End Patch`);

    expect(added?.diff).toContain("--- /dev/null");
    expect(added?.diff).toContain("+++ b/src/new.ts");
    expect(removed?.diff).toContain("--- a/src/gone.ts");
    expect(removed?.diff).toContain("+++ /dev/null");
  });
});

describe("rawApplyPatchParts path and kind rendering", () => {
  test("renders a move with both paths and a move_path argument", () => {
    const parts = rawApplyPatchParts(
      `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-a
+A
*** End Patch`,
      "/workspace",
      "success",
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      content: "src/new.ts",
      toolTitle: "move: src/old.ts → src/new.ts",
      toolArgs: { path: "src/old.ts", kind: "move", move_path: "src/new.ts" },
      // The diff belongs to the destination, which is where the UI links.
      toolDiff: { filePath: "/workspace/src/new.ts" },
    });
  });

  test("omits move_path when the target is the source", () => {
    const [part] = rawApplyPatchParts(
      "*** Begin Patch\n*** Add File: src/a.ts\n+a\n*** End Patch",
      "/workspace",
      "success",
    );

    expect(part?.toolArgs).toEqual({ path: "src/a.ts", kind: "add" });
  });

  test("keeps an absolute path in the patch rather than re-joining it to cwd", () => {
    const [part] = rawApplyPatchParts(
      "*** Begin Patch\n*** Update File: /tmp/elsewhere/a.ts\n@@\n-a\n+A\n*** End Patch",
      "/workspace",
      "success",
    );

    expect(part?.toolDiff?.filePath).toBe("/tmp/elsewhere/a.ts");
  });

  test.each(["pending", "success", "failure"] as const)(
    "propagates the %s tool state to every file",
    (state) => {
      const parts = rawApplyPatchParts(
        "*** Begin Patch\n*** Add File: a.ts\n+a\n*** Add File: b.ts\n+b\n*** End Patch",
        "/workspace",
        state,
      );

      expect(parts).toHaveLength(2);
      // apply_patch is atomic: one file failing means none were written, so a
      // single state across every part is the honest rendering.
      expect(parts.map((part) => part.toolState)).toEqual([state, state]);
    },
  );
});
