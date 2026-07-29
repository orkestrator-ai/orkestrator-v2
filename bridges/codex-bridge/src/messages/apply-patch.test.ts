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
});
