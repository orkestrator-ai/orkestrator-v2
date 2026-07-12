import { describe, expect, test } from "bun:test";
import {
  assertBase64PayloadWithinLimit,
  MAX_BASE64_PAYLOAD_BYTES,
  MAX_WRITE_FILE_BYTES,
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
});
