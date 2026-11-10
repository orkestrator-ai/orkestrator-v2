/**
 * The bridge's own Read, Grep (and Glob) and LS (to-do 7400 task 1), on a
 * temporary directory with the SDK's own ripgrep. The result shapes are
 * checked against the message descriptors in the installed `@cursor/sdk`
 * bundle, so an SDK bump that renames a field fails here rather than in a
 * live turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  grepTool,
  lsTool,
  MAX_MATCH_LINE_CHARS,
  readFileTool,
  readLineRange,
  resolveRipgrep,
  type GrepArgsLike,
  type TreeNode,
} from "./read-tools.js";

let root: string;
let ripgrep: string;
const nothingRefused = () => false;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cursor-read-tools-")));
  ripgrep = resolveRipgrep(root);
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\nfour\nfive");
  await writeFile(join(root, "src", "a.ts"), "const alpha = 1;\nconst beta = 2;\n");
  await writeFile(join(root, "src", "nested", "b.ts"), "const alpha = 3;\n");
  await writeFile(join(root, "src", "long.ts"), `const alpha = "${"x".repeat(1500)}";\n`);
  await writeFile(join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  await writeFile(
    join(root, "pixel.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
  );
  await writeFile(join(root, ".cursorignore"), "ignored.ts\n");
  await writeFile(join(root, "ignored.ts"), "const alpha = 4;\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/* ------------------------------------------------- SDK message shapes --- */

/** `Name|1 field 9|2 other #0 oneofName|…` as the SDK bundle declares each message. */
function sdkDescriptors(): Map<string, { fields: Set<string>; oneofs: Map<string, Set<string>> }> {
  const bundle = readFileSync(Bun.resolveSync("@cursor/sdk/bundled", import.meta.dir), "utf8");
  const camel = (name: string) =>
    name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
  const descriptors = new Map();
  for (const match of bundle.matchAll(/\["((?:Read|Grep|Ls)[A-Za-z]*)\|([^"]*)"/g)) {
    const fields = new Set<string>();
    const oneofs = new Map<string, Set<string>>();
    for (const entry of match[2]!.split("|")) {
      const [, name, , oneof] = entry.split(" ");
      if (!name) continue;
      if (oneof) {
        const members = oneofs.get(camel(oneof)) ?? new Set<string>();
        members.add(camel(name));
        oneofs.set(camel(oneof), members);
      } else {
        fields.add(camel(name));
      }
    }
    descriptors.set(match[1], { fields, oneofs });
  }
  return descriptors;
}

const descriptors = sdkDescriptors();

/** Which message a nested field or oneof member holds. */
const NESTED: Record<string, string> = {
  "ReadResult.result.success": "ReadSuccess",
  "ReadResult.result.error": "ReadError",
  "ReadResult.result.rejected": "ReadRejected",
  "ReadResult.result.fileNotFound": "ReadFileNotFound",
  "ReadResult.result.permissionDenied": "ReadPermissionDenied",
  "ReadResult.result.invalidFile": "ReadInvalidFile",
  "GrepResult.result.success": "GrepSuccess",
  "GrepResult.result.error": "GrepError",
  "GrepSuccess.workspaceResults": "GrepUnionResult",
  "GrepUnionResult.result.content": "GrepContentResult",
  "GrepUnionResult.result.files": "GrepFilesResult",
  "GrepUnionResult.result.count": "GrepCountResult",
  "GrepContentResult.matches": "GrepFileMatch",
  "GrepFileMatch.matches": "GrepContentMatch",
  "GrepCountResult.counts": "GrepFileCount",
  "LsResult.result.success": "LsSuccess",
  "LsResult.result.timeout": "LsTimeout",
  "LsResult.result.error": "LsError",
  "LsResult.result.rejected": "LsRejected",
  "LsSuccess.directoryTreeRoot": "LsDirectoryTreeNode",
  "LsTimeout.directoryTreeRoot": "LsDirectoryTreeNode",
  "LsDirectoryTreeNode.childrenDirs": "LsDirectoryTreeNode",
};

/** Fails on any field the SDK's message of that name does not declare. */
function expectSdkShape(type: string, value: unknown): void {
  const descriptor = descriptors.get(type);
  expect(descriptor, `the SDK declares ${type}`).toBeDefined();
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (field === undefined) continue;
    const oneof = descriptor!.oneofs.get(key);
    if (oneof) {
      const { case: member, value: inner } = field as { case: string; value: unknown };
      expect(oneof.has(member), `${type}.${key} has a member ${member}`).toBe(true);
      const nested = NESTED[`${type}.${key}.${member}`];
      if (nested) expectSdkShape(nested, inner);
      continue;
    }
    expect(descriptor!.fields.has(key), `${type} declares ${key}`).toBe(true);
    const nested = NESTED[`${type}.${key}`];
    if (!nested) continue;
    const children = Array.isArray(field)
      ? field
      : type === "GrepSuccess"
        ? Object.values(field as Record<string, unknown>)
        : [field];
    for (const child of children) expectSdkShape(nested, child);
  }
}

/* ---------------------------------------------------------------- Read --- */

describe("readLineRange", () => {
  test("follows the SDK's one-based, end-relative ranges", () => {
    expect(readLineRange(5, false, {})).toEqual({ applied: false });
    expect(readLineRange(5, false, { offset: 2, limit: 2 })).toEqual({
      applied: true,
      start: 1,
      end: 3,
    });
    expect(readLineRange(5, false, { offset: -2 })).toEqual({ applied: true, start: 3, end: 5 });
    expect(readLineRange(5, false, { limit: 1 })).toEqual({ applied: true, start: 0, end: 1 });
    expect(readLineRange(5, false, { offset: 9 })).toEqual({ applied: false });
    expect(readLineRange(5, true, { offset: 1 })).toEqual({ applied: false });
  });
});

describe("readFileTool", () => {
  test("reads text, a range of it, and caps an unranged read at maxChars", async () => {
    const whole = await readFileTool(join(root, "lines.txt"), {});
    expect(whole.result).toMatchObject({
      case: "success",
      value: {
        output: { case: "content", value: "one\ntwo\nthree\nfour\nfive" },
        totalLines: 5,
        fileSize: 23n,
        truncated: false,
        rangeApplied: false,
      },
    });
    expectSdkShape("ReadResult", whole);

    const range = await readFileTool(join(root, "lines.txt"), { offset: 2, limit: 2 });
    expect(range.result).toMatchObject({
      case: "success",
      value: { output: { value: "two\nthree\n" }, rangeApplied: true },
    });

    const capped = await readFileTool(join(root, "lines.txt"), { maxChars: 3 });
    expect(capped.result).toMatchObject({
      case: "success",
      value: { output: { value: "one\nt" }, truncated: true },
    });
  });

  test("answers a directory, a missing file and binary data as the SDK does", async () => {
    for (const [path, expected] of [
      [join(root, "src"), { case: "invalidFile" }],
      [join(root, "missing.txt"), { case: "fileNotFound" }],
      [join(root, "blob.bin"), { case: "invalidFile" }],
    ] as const) {
      const result = await readFileTool(path, {});
      expect(result.result).toMatchObject(expected);
      expectSdkShape("ReadResult", result);
    }
  });

  test("returns an image's bytes", async () => {
    const result = await readFileTool(join(root, "pixel.png"), {});
    expect(result.result.case).toBe("success");
    const value = result.result.value as { output: { case: string; value: Uint8Array } };
    expect(value.output.case).toBe("data");
    expect(value.output.value.byteLength).toBe(10);
  });

  test("a success value clones for the SDK's digest wrapper, outside its fields", async () => {
    const result = await readFileTool(join(root, "lines.txt"), {});
    const value = result.result.value as Record<string, unknown> & { clone(): typeof value };
    expect(Object.keys(value)).not.toContain("clone");
    const copy = value.clone();
    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
    expect(typeof copy.clone).toBe("function");
  });
});

/* ---------------------------------------------------------------- Grep --- */

function grep(args: GrepArgsLike, refused = nothingRefused, target = root) {
  return grepTool(args, { cwd: root, target, refused, ripgrep });
}

function union(result: Awaited<ReturnType<typeof grep>>) {
  if (result.result.case !== "success") throw new Error(JSON.stringify(result));
  const workspaceResults = result.result.value.workspaceResults as Record<
    string,
    { result: { case: string; value: Record<string, unknown> } }
  >;
  expect(Object.keys(workspaceResults)).toEqual([root]);
  return workspaceResults[root]!.result;
}

describe("grepTool", () => {
  test("content mode returns each matching line by file, honouring .cursorignore", async () => {
    const result = await grep({
      pattern: "alpha",
      outputMode: "content",
      sort: "path",
      sortAscending: true,
    });
    expectSdkShape("GrepResult", result);
    const content = union(result);
    expect(content.case).toBe("content");
    const matches = content.value.matches as {
      file: string;
      matches: { lineNumber: number; content: string; contentTruncated: boolean }[];
    }[];
    expect(matches.map((match) => match.file)).toEqual([
      "src/a.ts",
      "src/long.ts",
      "src/nested/b.ts",
    ]);
    expect(matches[0]!.matches[0]).toMatchObject({ lineNumber: 1, content: "const alpha = 1;" });
    const long = matches[1]!.matches[0]!;
    expect(long.contentTruncated).toBe(true);
    expect(long.content.length).toBe(MAX_MATCH_LINE_CHARS);
    expect(content.value.totalMatchedLines).toBe(3);
  });

  test("context lines are marked as context", async () => {
    const content = union(
      await grep(
        { pattern: "beta", outputMode: "content", contextBefore: 1, path: "src/a.ts" },
        undefined,
        join(root, "src", "a.ts"),
      ),
    );
    const lines = (content.value.matches as { matches: { isContextLine: boolean }[] }[])[0]!
      .matches;
    expect(lines.map((line) => line.isContextLine)).toEqual([true, false]);
  });

  test("files and count modes, with an offset and a head limit", async () => {
    const files = union(
      await grep({
        pattern: "alpha",
        outputMode: "files_with_matches",
        sort: "path",
        sortAscending: true,
        headLimit: 2,
      }),
    );
    expect(files).toMatchObject({
      case: "files",
      value: { files: ["src/a.ts", "src/long.ts"], totalFiles: 3, headLimitApplied: 2 },
    });
    const counts = union(
      await grep({
        pattern: "const",
        outputMode: "count",
        sort: "path",
        sortAscending: true,
        offset: 1,
      }),
    );
    expect(counts).toMatchObject({
      case: "count",
      value: {
        counts: [
          { file: "src/long.ts", count: 1 },
          { file: "src/nested/b.ts", count: 1 },
        ],
        totalFiles: 3,
        totalMatches: 4,
        offsetApplied: 1,
      },
    });
  });

  test("a glob lists files by name, and every file is checked before it is returned", async () => {
    const refused = (path: string) => path.endsWith("b.ts");
    const files = union(
      await grep(
        {
          pattern: "",
          glob: "**/*.ts",
          outputMode: "files_with_matches",
          sort: "path",
          sortAscending: true,
        },
        refused,
      ),
    );
    // ripgrep's globs override ignore files, so the ignored file is listed.
    expect(files.value.files).toEqual(["ignored.ts", "src/a.ts", "src/long.ts"]);
    expect(files.value.totalFiles).toBe(3);
  });

  test("reports an invalid pattern and an unknown mode as errors", async () => {
    expect((await grep({ pattern: "(", outputMode: "content" })).result.case).toBe("error");
    expect((await grep({ pattern: "x", outputMode: "everything" })).result.case).toBe("error");
    expect((await grep({ pattern: "x" }, undefined, join(root, "missing"))).result).toMatchObject({
      case: "error",
      value: { error: expect.stringContaining("does not exist") },
    });
  });
});

/* ------------------------------------------------------------------ LS --- */

function names(node: TreeNode): string[] {
  return [
    ...node.childrenFiles.map((file) => join(node.absPath, file.name)),
    ...node.childrenDirs.flatMap(names),
  ];
}

describe("lsTool", () => {
  test("lists a tree, without ignored or refused files", async () => {
    const result = await lsTool(
      root,
      { ignore: ["*.bin"] },
      { refused: (path) => path.endsWith("png"), ripgrep },
    );
    expectSdkShape("LsResult", result);
    expect(result.result.case).toBe("success");
    if (result.result.case !== "success") return;
    expect(names(result.result.value.directoryTreeRoot).sort()).toEqual(
      [".cursorignore", "lines.txt", "src/a.ts", "src/long.ts", "src/nested/b.ts"].map((file) =>
        join(root, file),
      ),
    );
    const src = result.result.value.directoryTreeRoot.childrenDirs[0]!;
    expect(src.absPath).toBe(join(root, "src"));
    expect(src.childrenWereProcessed).toBe(true);
  });

  test("preserves newline filenames as one listing entry", async () => {
    const directory = join(root, "newline-listing");
    await mkdir(directory);
    await writeFile(join(directory, "one\ntwo.txt"), "fixture");
    const result = await lsTool(directory, {}, { refused: nothingRefused, ripgrep });
    expect(result.result.case).toBe("success");
    if (result.result.case !== "success") return;
    expect(names(result.result.value.directoryTreeRoot)).toEqual([join(directory, "one\ntwo.txt")]);
  });

  test.skipIf(process.platform === "win32")(
    "lists nested paths when rooted at the filesystem root",
    async () => {
      const fakeRipgrep = join(root, "fake-ripgrep");
      await writeFile(fakeRipgrep, "#!/bin/sh\nprintf 'tmp/project/file.txt\\0'\n", {
        mode: 0o755,
      });
      const result = await lsTool("/", {}, { refused: nothingRefused, ripgrep: fakeRipgrep });
      expect(result.result).toEqual({
        case: "success",
        value: {
          directoryTreeRoot: {
            absPath: "/",
            childrenFiles: [],
            childrenWereProcessed: true,
            fullSubtreeExtensionCounts: {},
            childrenDirs: [
              {
                absPath: "/tmp",
                childrenFiles: [],
                childrenWereProcessed: true,
                fullSubtreeExtensionCounts: {},
                childrenDirs: [
                  {
                    absPath: "/tmp/project",
                    childrenFiles: [{ name: "file.txt" }],
                    childrenDirs: [],
                    childrenWereProcessed: true,
                    fullSubtreeExtensionCounts: {},
                  },
                ],
              },
            ],
          },
        },
      });
    },
  );

  test("answers a file and a missing path as errors", async () => {
    for (const path of [join(root, "lines.txt"), join(root, "missing")]) {
      const result = await lsTool(path, {}, { refused: nothingRefused, ripgrep });
      expect(result.result.case).toBe("error");
      expectSdkShape("LsResult", result);
    }
  });
});

describe("resolveRipgrep", () => {
  test("prefers CURSOR_RIPGREP_PATH, then the SDK's own binary, never one in the workspace", () => {
    expect(resolveRipgrep(root, { CURSOR_RIPGREP_PATH: ripgrep })).toBe(ripgrep);
    expect(ripgrep).toContain(`sdk-${process.platform}-${process.arch}`);
    // A workspace that contains the binary does not supply it.
    const inside = resolveRipgrep("/", {});
    expect(inside).toBe(process.platform === "win32" ? "rg.exe" : "rg");
    expect(resolveRipgrep(root, {}, [root])).toBe(process.platform === "win32" ? "rg.exe" : "rg");
  });
});
