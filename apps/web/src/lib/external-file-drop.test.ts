import { describe, expect, test } from "bun:test";
import {
  dropBaseName,
  dropParentPath,
  ExternalDropLimitError,
  isDroppedDirectoryEntry,
  planExternalFolderCopy,
  workspacePathInDropTarget,
  type DroppedDirectoryEntry,
  type DroppedEntry,
  type DroppedFileEntry,
} from "./external-file-drop";

type FakeTree = { [name: string]: FakeTree | File };

function fileEntry(file: File): DroppedFileEntry {
  return { name: file.name, isFile: true, isDirectory: false, file: (success) => success(file) };
}

/** A directory entry whose reader answers in batches of `batchSize`, like Chromium's 100. */
function directoryEntry(name: string, tree: FakeTree, batchSize = 2): DroppedDirectoryEntry {
  const children: DroppedEntry[] = Object.entries(tree).map(([childName, child]) =>
    child instanceof File ? fileEntry(child) : directoryEntry(childName, child, batchSize),
  );
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (success) => {
          const batch = children.slice(offset, offset + batchSize);
          offset += batch.length;
          success(batch);
        },
      };
    },
  };
}

function file(name: string, contents = "x"): File {
  return new File([contents], name);
}

describe("planExternalFolderCopy", () => {
  test("plans every nested folder before its contents, reading entries in batches", async () => {
    const readme = file("README.md", "hello");
    const nested = file("deep.txt", "abc");
    const plan = await planExternalFolderCopy([
      directoryEntry("temp", {
        "README.md": readme,
        "a.txt": file("a.txt"),
        "b.txt": file("b.txt"),
        empty: {},
        sub: { inner: { "deep.txt": nested } },
      }),
    ]);

    expect(plan.folders).toEqual(["temp", "temp/empty", "temp/sub", "temp/sub/inner"]);
    expect(plan.files.map((entry) => [entry.directory, entry.path])).toEqual([
      ["temp", "temp/README.md"],
      ["temp", "temp/a.txt"],
      ["temp", "temp/b.txt"],
      ["temp/sub/inner", "temp/sub/inner/deep.txt"],
    ]);
    expect(plan.files[0]!.file).toBe(readme);
    expect(plan.files[3]!.file).toBe(nested);
    expect(plan.totalBytes).toBe(5 + 1 + 1 + 3);
    expect(plan.skipped).toEqual([]);
  });

  test("leaves out Git metadata and .DS_Store at any depth", async () => {
    const plan = await planExternalFolderCopy([
      directoryEntry("project", {
        ".git": { HEAD: file("HEAD") },
        ".DS_Store": file(".DS_Store"),
        src: { ".git": file(".git"), "main.ts": file("main.ts") },
      }),
      directoryEntry(".git", { config: file("config") }),
    ]);

    expect(plan.folders).toEqual(["project", "project/src"]);
    expect(plan.files.map((entry) => entry.path)).toEqual(["project/src/main.ts"]);
    expect(plan.skipped).toEqual(["project/.DS_Store", "project/.git", "project/src/.git", ".git"]);
  });

  test("refuses a drop over the entry or byte limit before anything is copied", async () => {
    const tree = { "a.txt": file("a.txt", "aaaa"), "b.txt": file("b.txt", "bbbb") };

    await expect(
      planExternalFolderCopy([directoryEntry("many", tree)], { maxEntries: 2 }),
    ).rejects.toBeInstanceOf(ExternalDropLimitError);
    await expect(
      planExternalFolderCopy([directoryEntry("many", tree)], { maxEntries: 2 }),
    ).rejects.toThrow("Drop folders holding up to 2 files and folders at a time");
    await expect(
      planExternalFolderCopy([directoryEntry("big", tree)], { maxBytes: 6 }),
    ).rejects.toBeInstanceOf(ExternalDropLimitError);
    expect(
      (await planExternalFolderCopy([directoryEntry("fits", tree)], { maxEntries: 3 })).files,
    ).toHaveLength(2);
  });

  test("reports a directory that cannot be read", async () => {
    const unreadable: DroppedDirectoryEntry = {
      name: "locked",
      isFile: false,
      isDirectory: true,
      createReader: () => ({
        readEntries: (_success, error) => error?.(new Error("Permission denied")),
      }),
    };

    await expect(planExternalFolderCopy([unreadable])).rejects.toThrow("Permission denied");
  });
});

describe("external drop paths", () => {
  test("joins drop-relative paths onto the target directory", () => {
    expect(workspacePathInDropTarget(".", "temp/sub")).toBe("temp/sub");
    expect(workspacePathInDropTarget("archive", "temp/sub")).toBe("archive/temp/sub");
    expect(workspacePathInDropTarget("archive", "")).toBe("archive");
    expect(dropParentPath("temp")).toBe("");
    expect(dropParentPath("temp/sub/inner")).toBe("temp/sub");
    expect(dropBaseName("temp/sub/inner")).toBe("inner");
  });

  test("recognises only readable directory entries", () => {
    expect(isDroppedDirectoryEntry(directoryEntry("temp", {}))).toBe(true);
    expect(isDroppedDirectoryEntry({ isDirectory: true })).toBe(false);
    expect(isDroppedDirectoryEntry(fileEntry(file("a.txt")))).toBe(false);
    expect(isDroppedDirectoryEntry(null)).toBe(false);
  });
});
