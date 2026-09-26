import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { readPatch, readPrompt } from "../src/client/inputs.js";
import { captureIo } from "./support/client-harness.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "ork-cli-inputs-"));
  directories.push(created);
  return created;
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected a failure");
}

describe("prompt input", () => {
  test("preserves file content exactly, including multibyte text and trailing newlines", async () => {
    const root = await directory();
    const text = "line one\n  indented — ünïcödé 🙂\n\n";
    await writeFile(path.join(root, "prompt.txt"), text);
    const io = captureIo({}, root);
    expect(await readPrompt(io, { "prompt-file": "prompt.txt" })).toBe(text);
  });

  test("reads stdin, rejects empty and invalid UTF-8, and bounds size", async () => {
    const io = captureIo({});
    io.stdinBytes = new TextEncoder().encode("from stdin");
    expect(await readPrompt(io, { "prompt-stdin": true })).toBe("from stdin");
    io.stdinBytes = new TextEncoder().encode("   \n\t");
    expect((await failure(readPrompt(io, { "prompt-stdin": true }))).code).toBe("empty-input");
    io.stdinBytes = new Uint8Array([0xff, 0xfe, 0x00]);
    expect((await failure(readPrompt(io, { "prompt-stdin": true }))).code).toBe("invalid-input");
    io.stdinBytes = new Uint8Array(PUBLIC_API_LIMITS.promptMaxBytes + 1).fill(97);
    expect((await failure(readPrompt(io, { "prompt-stdin": true }))).code).toBe("input-too-large");
  });

  test("sources are mutually exclusive and required", async () => {
    const io = captureIo({});
    expect((await failure(readPrompt(io, { prompt: "a", "prompt-stdin": true }))).code).toBe(
      "invalid-input",
    );
    expect((await failure(readPrompt(io, {}))).code).toBe("invalid-input");
  });

  test("an oversized or missing file is rejected without reading it whole or echoing its path contents", async () => {
    const root = await directory();
    await writeFile(path.join(root, "big.txt"), "x".repeat(PUBLIC_API_LIMITS.promptMaxBytes + 10));
    const io = captureIo({}, root);
    expect((await failure(readPrompt(io, { "prompt-file": "big.txt" }))).code).toBe(
      "input-too-large",
    );
    expect((await failure(readPrompt(io, { "prompt-file": "missing.txt" }))).code).toBe(
      "invalid-input",
    );
  });

  test("character limits apply after decoding", async () => {
    const io = captureIo({});
    io.stdinBytes = new TextEncoder().encode("é".repeat(PUBLIC_API_LIMITS.promptMaxChars + 1));
    expect((await failure(readPrompt(io, { "prompt-stdin": true }))).code).toBe("input-too-large");
  });
});

describe("patch input", () => {
  test("parses a JSON object and rejects other JSON", async () => {
    const root = await directory();
    await writeFile(
      path.join(root, "patch.json"),
      JSON.stringify({ set: { entryPort: 3000 }, unset: ["filesToCopy"] }),
    );
    await writeFile(path.join(root, "array.json"), "[1]");
    const io = captureIo({}, root);
    expect(await readPatch(io, { "patch-file": "patch.json" })).toEqual({
      set: { entryPort: 3000 },
      unset: ["filesToCopy"],
    });
    expect((await failure(readPatch(io, { "patch-file": "array.json" }))).code).toBe(
      "invalid-input",
    );
    expect(await readPatch(io, {})).toBeUndefined();
  });
});
