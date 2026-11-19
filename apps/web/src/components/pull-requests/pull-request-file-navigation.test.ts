import { describe, expect, test } from "bun:test";
import {
  NO_FILE_FILTERS,
  ancestorDirectories,
  buildFileTree,
  fileMatchesFilters,
  filtersActive,
  matchesFileQuery,
  nextFileAfter,
  nextThreadAfter,
  treeFileOrder,
  unresolvedByPath,
  unresolvedThreadOrder,
  type FileTreeNode,
} from "./pull-request-file-navigation";
import { makeFile, makeThread } from "./pull-request-test-fixtures";

function outline(nodes: readonly FileTreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === "file"
      ? [`${"  ".repeat(depth)}${node.name}`]
      : [
          `${"  ".repeat(depth)}${node.name}/ (${node.viewedCount}/${node.fileCount}, ${node.unresolvedCount})`,
          ...outline(node.children, depth + 1),
        ],
  );
}

const files = [
  makeFile({ path: "README.md" }),
  makeFile({ path: "apps/web/src/components/deep/Widget.tsx", viewedState: "viewed" }),
  makeFile({ path: "apps/web/src/components/deep/widget.test.tsx" }),
  makeFile({ path: "apps/web/src/lib/file10.ts" }),
  makeFile({ path: "apps/web/src/lib/file2.ts" }),
  makeFile({ path: "packages/protocol/index.ts", previousPath: "packages/protocol/main.ts" }),
];

describe("buildFileTree", () => {
  test("puts directories first, sorts naturally and folds single-child chains", () => {
    const unresolved = new Map([["apps/web/src/lib/file2.ts", 2]]);
    expect(outline(buildFileTree(files, unresolved))).toEqual([
      "apps/web/src/ (1/4, 2)",
      "  components/deep/ (1/2, 0)",
      "    widget.test.tsx",
      "    Widget.tsx",
      "  lib/ (0/2, 2)",
      "    file2.ts",
      "    file10.ts",
      "packages/protocol/ (0/1, 0)",
      "  index.ts",
      "README.md",
    ]);
  });

  test("the list follows the tree's order", () => {
    expect(treeFileOrder(buildFileTree(files)).map((file) => file.path)).toEqual([
      "apps/web/src/components/deep/widget.test.tsx",
      "apps/web/src/components/deep/Widget.tsx",
      "apps/web/src/lib/file2.ts",
      "apps/web/src/lib/file10.ts",
      "packages/protocol/index.ts",
      "README.md",
    ]);
  });

  test("folded directories keep their full path as the collapse key", () => {
    const [first] = buildFileTree(files);
    expect(first).toMatchObject({ kind: "directory", path: "apps/web/src" });
    expect(ancestorDirectories("apps/web/src/lib/file2.ts")).toEqual([
      "apps",
      "apps/web",
      "apps/web/src",
      "apps/web/src/lib",
    ]);
  });
});

describe("filters", () => {
  test("every search term must appear in the path or the previous path", () => {
    const file = files[5]!;
    expect(matchesFileQuery(file, "PROTOCOL index")).toBe(true);
    expect(matchesFileQuery(file, "main.ts")).toBe(true);
    expect(matchesFileQuery(file, "protocol widget")).toBe(false);
    expect(matchesFileQuery(file, "   ")).toBe(true);
  });

  test("unviewed and unresolved filters combine with the search", () => {
    const unresolved = new Map([["apps/web/src/lib/file2.ts", 1]]);
    const shown = (filters: typeof NO_FILE_FILTERS) =>
      files.filter((file) => fileMatchesFilters(file, filters, unresolved)).map((f) => f.path);
    expect(shown({ ...NO_FILE_FILTERS, unviewedOnly: true })).not.toContain(
      "apps/web/src/components/deep/Widget.tsx",
    );
    expect(shown({ ...NO_FILE_FILTERS, unresolvedOnly: true })).toEqual([
      "apps/web/src/lib/file2.ts",
    ]);
    expect(shown({ ...NO_FILE_FILTERS, query: "lib", unresolvedOnly: true })).toHaveLength(1);
    expect(filtersActive(NO_FILE_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILE_FILTERS, query: " x " })).toBe(true);
  });
});

describe("next file and conversation", () => {
  const ordered = treeFileOrder(buildFileTree(files));
  const unviewed = (file: (typeof files)[number]) => file.viewedState !== "viewed";

  test("next unviewed starts at the top, skips viewed files and wraps", () => {
    expect(nextFileAfter(ordered, null, unviewed)?.path).toBe(
      "apps/web/src/components/deep/widget.test.tsx",
    );
    expect(
      nextFileAfter(ordered, "apps/web/src/components/deep/widget.test.tsx", unviewed)?.path,
    ).toBe("apps/web/src/lib/file2.ts");
    expect(nextFileAfter(ordered, "README.md", unviewed)?.path).toBe(
      "apps/web/src/components/deep/widget.test.tsx",
    );
  });

  test("returns the current file when it is the only match, and null when none match", () => {
    expect(nextFileAfter(ordered, "README.md", (file) => file.path === "README.md")?.path).toBe(
      "README.md",
    );
    expect(nextFileAfter(ordered, null, () => false)).toBeNull();
    expect(nextFileAfter([], null, () => true)).toBeNull();
  });

  test("unresolved conversations follow file order, then line, outdated last", () => {
    const threads = [
      makeThread({ id: "readme", path: "README.md", line: 1 }),
      makeThread({ id: "late", path: "apps/web/src/lib/file2.ts", line: 40 }),
      makeThread({
        id: "outdated",
        path: "apps/web/src/lib/file2.ts",
        line: null,
        isOutdated: true,
      }),
      makeThread({ id: "early", path: "apps/web/src/lib/file2.ts", line: 3 }),
      makeThread({ id: "done", path: "apps/web/src/lib/file2.ts", line: 1, isResolved: true }),
      makeThread({ id: "hidden", path: "not/shown.ts", line: 1 }),
    ];
    const order = unresolvedThreadOrder(ordered, threads);
    expect(order.map((thread) => thread.id)).toEqual(["early", "late", "outdated", "readme"]);
    expect(nextThreadAfter(order, null)?.id).toBe("early");
    expect(nextThreadAfter(order, "outdated")?.id).toBe("readme");
    expect(nextThreadAfter(order, "readme")?.id).toBe("early");
    expect(nextThreadAfter([], null)).toBeNull();
    expect(unresolvedByPath(threads).get("apps/web/src/lib/file2.ts")).toBe(3);
  });
});
