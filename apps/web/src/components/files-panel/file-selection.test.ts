import { describe, expect, test } from "bun:test";
import type { FileNode } from "@/lib/backend";
import {
  collectAllFilePaths,
  collectVisibleFilePaths,
  decodeWorkspaceFileDrag,
  encodeWorkspaceFileDrag,
  pathsForFileAction,
  resolveFileSelection,
} from "./file-selection";

const tree: FileNode[] = [
  {
    name: "src",
    path: "src",
    isDirectory: true,
    children: [
      { name: "App.tsx", path: "src/App.tsx", isDirectory: false },
      { name: "main.ts", path: "src/main.ts", isDirectory: false },
      {
        name: "lib",
        path: "src/lib",
        isDirectory: true,
        children: [{ name: "util.ts", path: "src/lib/util.ts", isDirectory: false }],
      },
    ],
  },
  { name: "README.md", path: "README.md", isDirectory: false },
];

describe("file selection helpers", () => {
  test("collects visible files from expanded folders only", () => {
    expect(collectVisibleFilePaths(tree, [])).toEqual(["README.md"]);
    expect(collectVisibleFilePaths(tree, ["src"])).toEqual([
      "src/App.tsx",
      "src/main.ts",
      "README.md",
    ]);
    expect(collectVisibleFilePaths(tree, new Set(["src", "src/lib"]))).toEqual([
      "src/App.tsx",
      "src/main.ts",
      "src/lib/util.ts",
      "README.md",
    ]);
  });

  test("collects every file path regardless of expansion", () => {
    expect(collectAllFilePaths(tree)).toEqual([
      "src/App.tsx",
      "src/main.ts",
      "src/lib/util.ts",
      "README.md",
    ]);
  });

  test("resolves single, additive, and range selection", () => {
    const visible = ["src/App.tsx", "src/main.ts", "README.md"];

    expect(resolveFileSelection("src/main.ts", {}, visible, "src/App.tsx")).toEqual({
      type: "single",
      path: "src/main.ts",
    });
    expect(resolveFileSelection("README.md", { metaKey: true }, visible, "src/App.tsx")).toEqual({
      type: "add",
      path: "README.md",
    });
    expect(resolveFileSelection("README.md", { shiftKey: true }, visible, "src/App.tsx")).toEqual({
      type: "range",
      paths: ["src/App.tsx", "src/main.ts", "README.md"],
    });
    expect(resolveFileSelection("src/App.tsx", { shiftKey: true }, visible, "README.md")).toEqual({
      type: "range",
      paths: ["src/App.tsx", "src/main.ts", "README.md"],
    });
  });

  test("range selection falls back when the anchor is missing", () => {
    const visible = ["src/App.tsx", "src/main.ts"];
    expect(resolveFileSelection("src/main.ts", { shiftKey: true }, visible, null)).toEqual({
      type: "range",
      paths: ["src/main.ts"],
    });
    expect(resolveFileSelection("src/main.ts", { shiftKey: true }, visible, "missing.ts")).toEqual({
      type: "range",
      paths: ["src/main.ts"],
    });
    expect(resolveFileSelection("gone.ts", { shiftKey: true }, visible, "src/App.tsx")).toEqual({
      type: "single",
      path: "gone.ts",
    });
  });

  test("prefers range selection when Shift and Command are both held", () => {
    expect(
      resolveFileSelection(
        "src/main.ts",
        { shiftKey: true, metaKey: true },
        ["src/App.tsx", "src/main.ts"],
        "src/App.tsx",
      ),
    ).toEqual({
      type: "range",
      paths: ["src/App.tsx", "src/main.ts"],
    });
  });

  test("encodes and decodes drag payloads including legacy single paths", () => {
    expect(decodeWorkspaceFileDrag(encodeWorkspaceFileDrag(["src/App.tsx", "README.md"]))).toEqual([
      "src/App.tsx",
      "README.md",
    ]);
    expect(decodeWorkspaceFileDrag("src/App.tsx")).toEqual(["src/App.tsx"]);
    expect(decodeWorkspaceFileDrag("")).toEqual([]);
    expect(decodeWorkspaceFileDrag(JSON.stringify(["", "src/App.tsx"]))).toEqual(["src/App.tsx"]);
  });

  test("uses the whole selection only when the clicked file is already selected", () => {
    expect(pathsForFileAction("src/App.tsx", new Set(["src/App.tsx"]))).toEqual(["src/App.tsx"]);
    expect(pathsForFileAction("src/App.tsx", new Set(["src/App.tsx", "README.md"]))).toEqual([
      "src/App.tsx",
      "README.md",
    ]);
    expect(pathsForFileAction("main.ts", new Set(["src/App.tsx", "README.md"]))).toEqual([
      "main.ts",
    ]);
  });
});
