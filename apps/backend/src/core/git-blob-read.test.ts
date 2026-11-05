import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LocalGitFetches } from "./commands-files.js";
import { readLocalFileAtBranch } from "./commands-files.js";
import {
  GIT_BATCH_HEADER_MAX_BYTES,
  containerGitBlobReadCommand,
  decodeGitBatchOutput,
  parseGitBatchHeader,
  readGitBlob,
} from "./git-blob-read.js";
import { MAX_TEXT_FILE_BYTES } from "./path-safety.js";
import { runCommand } from "./shell.js";

const OID = "a".repeat(40);

describe("git cat-file --batch output", () => {
  test("headers name an object, or say no single object answers", () => {
    expect(parseGitBatchHeader(`${OID} blob 12`)).toEqual({
      kind: "object",
      oid: OID,
      type: "blob",
      size: 12,
    });
    expect(parseGitBatchHeader("main:src/missing.ts missing")).toEqual({ kind: "missing" });
    expect(parseGitBatchHeader("abc ambiguous")).toEqual({ kind: "missing" });
    expect(() => parseGitBatchHeader("fatal: not a git repository")).toThrow("unexpected header");
  });

  test("a blob is returned only whole, and an oversized one from its header", () => {
    const body = Buffer.from("hello world\n");
    const full = Buffer.concat([Buffer.from(`${OID} blob ${body.byteLength}\n`), body]);
    expect(decodeGitBatchOutput(full, 1024)).toEqual({ kind: "blob", bytes: body });
    // The trailing newline after the body is not part of the blob.
    const withTrailer = Buffer.concat([full, Buffer.from("\n")]);
    expect(decodeGitBatchOutput(withTrailer, 1024)).toEqual({ kind: "blob", bytes: body });
    expect(decodeGitBatchOutput(full.subarray(0, full.byteLength - 3), 1024)).toBeNull();
    expect(decodeGitBatchOutput(Buffer.from(`${OID} blob 99999999\nxx`), 1024)).toEqual({
      kind: "too-large",
      size: 99999999,
    });
    expect(decodeGitBatchOutput(Buffer.from(`${OID} tree 30\n`), 1024)).toEqual({
      kind: "not-blob",
      type: "tree",
    });
    expect(decodeGitBatchOutput(Buffer.alloc(0), 1024)).toBeNull();
    expect(() =>
      decodeGitBatchOutput(Buffer.alloc(GIT_BATCH_HEADER_MAX_BYTES + 1, 0x61), 1),
    ).toThrow("unexpected header");
  });

  test("the container command runs one cat-file and quotes the object name", () => {
    const command = containerGitBlobReadCommand("main:it's here.txt", 10);
    expect(command).toBe(
      `printf '%s\\n' 'main:it'\\''s here.txt' | git cat-file --batch 2>/dev/null | head -c ${10 + GIT_BATCH_HEADER_MAX_BYTES + 1} | base64`,
    );
    expect(command.match(/\bgit\b/g)).toHaveLength(1);
  });
});

describe("reading a blob from a repository", () => {
  let repo: string;
  let headOid: string;
  const fetches: LocalGitFetches = { ensureFetched: async () => undefined };
  const git = (...args: string[]) => runCommand("git", ["-C", repo, ...args]);

  beforeAll(async () => {
    repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), "git-blob-read-")));
    await git("init", "-q", "-b", "main");
    mkdirSync(path.join(repo, "src"));
    writeFileSync(path.join(repo, "src", "app.ts"), "export const answer = 42;\n");
    writeFileSync(path.join(repo, "it's here.txt"), "quoted\n");
    writeFileSync(path.join(repo, "big.txt"), Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 0x61));
    writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 0]));
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "init",
    );
    headOid = (await git("rev-parse", "HEAD")).stdout.trim();
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("one process answers a blob, a missing path, a tree and an oversized blob", async () => {
    const blob = await readGitBlob(repo, `${headOid}:src/app.ts`, 1024);
    expect(blob.kind === "blob" && blob.bytes.toString()).toBe("export const answer = 42;\n");
    expect(await readGitBlob(repo, `${headOid}:src/missing.ts`, 1024)).toEqual({
      kind: "missing",
    });
    expect(await readGitBlob(repo, `${headOid}:src`, 1024)).toEqual({
      kind: "not-blob",
      type: "tree",
    });
    expect(await readGitBlob(repo, `${headOid}:big.txt`, 16)).toEqual({
      kind: "too-large",
      size: MAX_TEXT_FILE_BYTES + 1,
    });
    await expect(readGitBlob(repo, "main\n:src/app.ts", 1024)).rejects.toThrow(
      "Invalid git object name",
    );
    await expect(readGitBlob(path.join(repo, "absent"), "HEAD:src/app.ts", 1024)).rejects.toThrow();
  });

  test("the container command's output decodes to the same answers", async () => {
    const run = async (object: string, maxBytes: number) =>
      decodeGitBatchOutput(
        Buffer.from(
          (
            await runCommand("bash", ["-c", containerGitBlobReadCommand(object, maxBytes)], {
              cwd: repo,
            })
          ).stdout,
          "base64",
        ),
        maxBytes,
      );
    const quoted = await run("main:it's here.txt", 1024);
    expect(quoted?.kind === "blob" && quoted.bytes.toString()).toBe("quoted\n");
    expect(await run("main:nope.txt", 1024)).toEqual({ kind: "missing" });
    // Cut after the header plus the limit: refused from the header.
    expect(await run("main:big.txt", MAX_TEXT_FILE_BYTES)).toEqual({
      kind: "too-large",
      size: MAX_TEXT_FILE_BYTES + 1,
    });
  });

  test("a branch read returns text, null for a missing path, and refuses what the editor cannot open", async () => {
    await expect(readLocalFileAtBranch(repo, "src/app.ts", "main", fetches)).resolves.toEqual({
      path: "src/app.ts",
      content: "export const answer = 42;\n",
      language: "typescript",
    });
    await expect(
      readLocalFileAtBranch(repo, "src/missing.ts", "main", fetches),
    ).resolves.toBeNull();
    await expect(readLocalFileAtBranch(repo, "big.txt", "main", fetches)).rejects.toThrow(
      "too large",
    );
    await expect(readLocalFileAtBranch(repo, "binary.bin", "main", fetches)).rejects.toThrow(
      "Binary files",
    );
    await expect(
      readLocalFileAtBranch(repo, "src/app.ts", "no-such-branch", fetches),
    ).rejects.toThrow("Not a valid object name");
  });
});

for (const stdoutEnds of [false, true]) {
  test(`a stuck ${stdoutEnds ? "stderr" : "stdout"} pipe cannot outlive the deadline`, async () => {
    const kill = mock(() => {});
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      stdout: new ReadableStream({
        start(controller) {
          if (stdoutEnds) controller.close();
        },
      }),
      stderr: new ReadableStream(),
      exitCode: null,
      kill,
    } as unknown as ReturnType<typeof Bun.spawn>);
    try {
      await expect(readGitBlob("/absent", "HEAD:file", 100, { timeoutMs: 20 })).rejects.toThrow(
        "timed out",
      );
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      spawn.mockRestore();
    }
  });
}
