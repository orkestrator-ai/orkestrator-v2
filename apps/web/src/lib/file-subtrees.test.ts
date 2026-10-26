import { describe, expect, test } from "bun:test";
import type { FileNode } from "@/lib/backend";
import { expandedTruncatedDirectories, mergeFileSubtrees } from "./file-subtrees";

const file = (path: string): FileNode => ({
  name: path.split("/").at(-1)!,
  path,
  isDirectory: false,
  extension: ".md",
});
const folder = (path: string, children: FileNode[] = [], truncated = false): FileNode => ({
  name: path.split("/").at(-1)!,
  path,
  isDirectory: true,
  children,
  ...(truncated ? { truncated: true } : {}),
});

const tree = [
  folder(".claude", [folder(".claude/skills", [folder(".claude/skills/release", [], true)])]),
  folder(".turbo", [], true),
  file("README.md"),
];

describe("mergeFileSubtrees", () => {
  test("returns the tree itself when nothing was read", () => {
    expect(mergeFileSubtrees(tree, {})).toBe(tree);
  });

  test("grafts reads ancestors first and keeps a still-incomplete directory truncated", () => {
    const merged = mergeFileSubtrees(tree, {
      ".turbo/cache": { children: [file(".turbo/cache/run.log")], truncated: false },
      ".turbo": { children: [folder(".turbo/cache", [], true)], truncated: true },
      ".claude/skills/release": {
        children: [file(".claude/skills/release/SKILL.md")],
        truncated: false,
      },
    });

    expect(merged).toEqual([
      folder(".claude", [
        folder(".claude/skills", [
          folder(".claude/skills/release", [file(".claude/skills/release/SKILL.md")]),
        ]),
      ]),
      folder(".turbo", [folder(".turbo/cache", [file(".turbo/cache/run.log")])], true),
      file("README.md"),
    ]);
    // Untouched branches keep their identity.
    expect(merged[2]).toBe(tree[2]);
    expect(tree[1]).toEqual(folder(".turbo", [], true));
  });

  test("ignores reads of directories the tree now lists in full or no longer has", () => {
    const complete = [folder("src", [file("src/a.md")])];
    expect(
      mergeFileSubtrees(complete, {
        src: { children: [], truncated: false },
        gone: { children: [file("gone/b.md")], truncated: false },
      }),
    ).toBe(complete);
  });
});

describe("expandedTruncatedDirectories", () => {
  test("finds truncated directories reachable through expanded ancestors only", () => {
    expect(
      expandedTruncatedDirectories(
        tree,
        new Set([".claude", ".claude/skills", ".claude/skills/release", ".turbo"]),
      ),
    ).toEqual([".claude/skills/release", ".turbo"]);
    expect(
      expandedTruncatedDirectories(tree, new Set([".claude", ".claude/skills/release"])),
    ).toEqual([]);
  });
});
