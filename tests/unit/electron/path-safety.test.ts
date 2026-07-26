import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertBase64PayloadWithinLimit,
  MAX_BASE64_PAYLOAD_BYTES,
  MAX_WRITE_FILE_BYTES,
  readReadableHostFile,
  validateRelativeFilePath,
  workspaceFilePath,
} from "../../../apps/backend/src/core/path-safety";

describe("Electron backend path safety", () => {
  test("normalizes workspace-relative file paths", () => {
    expect(validateRelativeFilePath("src/components/App.tsx")).toBe("src/components/App.tsx");
    expect(validateRelativeFilePath("src\\components\\App.tsx")).toBe("src/components/App.tsx");
    expect(workspaceFilePath("notes/todo.md")).toBe("/workspace/notes/todo.md");
  });

  test("rejects absolute and traversal paths", () => {
    for (const unsafePath of ["/etc/passwd", "C:\\Users\\owner\\secret.txt", "../secret.txt", "src/../../secret.txt", "src/..\n/secret.txt"]) {
      expect(() => validateRelativeFilePath(unsafePath)).toThrow("Invalid file path");
    }
  });

  test("rejects write payloads above the configured file size cap", () => {
    expect(() => assertBase64PayloadWithinLimit(Buffer.alloc(MAX_WRITE_FILE_BYTES).toString("base64"))).not.toThrow();
    expect(() => assertBase64PayloadWithinLimit("a".repeat(MAX_BASE64_PAYLOAD_BYTES + 1))).toThrow("File payload exceeds");
    expect(() => assertBase64PayloadWithinLimit(Buffer.alloc(MAX_WRITE_FILE_BYTES + 1).toString("base64"))).toThrow("File payload exceeds");
    expect(() => assertBase64PayloadWithinLimit("not base64!")).toThrow("not valid base64");
  });

  test("reads a regular file through the bounded host-file helper", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "path-safety-reader-"));
    const filePath = path.join(root, "image.bin");
    await fs.writeFile(filePath, Buffer.from([0, 1, 2]));
    try {
      await expect(readReadableHostFile(filePath, [root])).resolves.toEqual(
        Buffer.from([0, 1, 2]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects files changed or replaced after the safe handle is opened", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "path-safety-mutation-"));
    const changedPath = path.join(root, "changed.bin");
    const replacedPath = path.join(root, "replaced.bin");
    await fs.writeFile(changedPath, "abc");
    await fs.writeFile(replacedPath, "original");
    try {
      await expect(readReadableHostFile(changedPath, [root], {
        afterInitialValidation: () => fs.appendFile(changedPath, "d"),
      })).rejects.toThrow("File changed while it was being read");

      await expect(readReadableHostFile(replacedPath, [root], {
        afterInitialValidation: async () => {
          await fs.rename(replacedPath, `${replacedPath}.old`);
          await fs.writeFile(replacedPath, "replacement");
        },
      })).rejects.toThrow("not a stable regular file");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
