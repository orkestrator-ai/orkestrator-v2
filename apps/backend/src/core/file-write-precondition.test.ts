import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fileContentSha256,
  isFileWriteConflict,
  parseFileWritePrecondition,
} from "@orkestrator/protocol/file-write-precondition";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import {
  CONTAINER_WRITE_CONFLICT_EXIT,
  containerFileWriteScript,
  serializeFileWrite,
} from "./file-write-precondition.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function worktree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ork-file-precondition-"));
  roots.push(root);
  return root;
}

const context = {
  storage: { loadEnvironments: async () => [] },
  runtime: { environments: { fence: { beginWorktreeMutation: () => () => undefined } } },
} as unknown as CommandContext;

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

async function rejection(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("write_local_file with a precondition", () => {
  const write = createCommandRegistry().get("write_local_file")!;

  test("writes while the file still has the loaded content", async () => {
    const root = await worktree();
    await fs.writeFile(path.join(root, "a.txt"), "﻿loaded ✓\n");
    await write(
      {
        worktreePath: root,
        filePath: "a.txt",
        base64Data: b64("edited"),
        expected: { sha256: fileContentSha256("﻿loaded ✓\n") },
      },
      context,
    );
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("edited");
  });

  test("refuses with a conflict when the file changed, and leaves it untouched", async () => {
    const root = await worktree();
    await fs.writeFile(path.join(root, "a.txt"), "changed by an agent");
    const error = await rejection(() =>
      write(
        {
          worktreePath: root,
          filePath: "a.txt",
          base64Data: b64("edited"),
          expected: { sha256: fileContentSha256("loaded") },
        },
        context,
      ),
    );
    expect(isFileWriteConflict(error)).toBe(true);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("changed by an agent");
  });

  test("a deleted file is a conflict, not a recreation", async () => {
    const root = await worktree();
    const error = await rejection(() =>
      write(
        {
          worktreePath: root,
          filePath: "gone.txt",
          base64Data: b64("edited"),
          expected: { sha256: fileContentSha256("loaded") },
        },
        context,
      ),
    );
    expect(isFileWriteConflict(error)).toBe(true);
    await expect(fs.access(path.join(root, "gone.txt"))).rejects.toThrow();
  });

  test("without a precondition (older clients, explicit overwrite) it writes as before", async () => {
    const root = await worktree();
    await fs.writeFile(path.join(root, "a.txt"), "changed by an agent");
    await write({ worktreePath: root, filePath: "a.txt", base64Data: b64("mine") }, context);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("mine");
  });

  test("a malformed precondition is rejected before anything is written", async () => {
    const root = await worktree();
    await expect(
      write(
        { worktreePath: root, filePath: "a.txt", base64Data: b64("x"), expected: { sha256: "x" } },
        context,
      ),
    ).rejects.toThrow("sha256");
    await expect(fs.access(path.join(root, "a.txt"))).rejects.toThrow();
  });
});

describe("parseFileWritePrecondition", () => {
  test("accepts only a lower-case hex digest", () => {
    const sha256 = fileContentSha256("x");
    expect(parseFileWritePrecondition(undefined)).toBeUndefined();
    expect(parseFileWritePrecondition({ sha256 })).toEqual({ sha256 });
    expect(() => parseFileWritePrecondition({ sha256: sha256.toUpperCase() })).toThrow();
    expect(() => parseFileWritePrecondition({ sha256, extra: 1 })).toThrow();
    expect(() => parseFileWritePrecondition("abc")).toThrow();
  });
});

const hasSha256sum = spawnSync("sha256sum", ["--version"]).status === 0;

describe.skipIf(!hasSha256sum)("the container writer script", () => {
  function run(script: string, input: string) {
    return spawnSync("bash", ["-c", script], { input: b64(input) });
  }

  test("writes when the digest matches and exits with the conflict status otherwise", async () => {
    const root = await worktree();
    const target = path.join(root, "it's here.txt");
    await fs.writeFile(target, "loaded");
    const ok = run(containerFileWriteScript(target, { sha256: fileContentSha256("loaded") }), "v2");
    expect(ok.status).toBe(0);
    expect(await fs.readFile(target, "utf8")).toBe("v2");

    const stale = run(
      containerFileWriteScript(target, { sha256: fileContentSha256("loaded") }),
      "v3",
    );
    expect(stale.status).toBe(CONTAINER_WRITE_CONFLICT_EXIT);
    expect(await fs.readFile(target, "utf8")).toBe("v2");

    const missing = run(
      containerFileWriteScript(path.join(root, "missing.txt"), {
        sha256: fileContentSha256(""),
      }),
      "x",
    );
    expect(missing.status).toBe(CONTAINER_WRITE_CONFLICT_EXIT);

    expect(run(containerFileWriteScript(target, undefined), "forced").status).toBe(0);
    expect(await fs.readFile(target, "utf8")).toBe("forced");
  });
});

test("serializeFileWrite runs writes to one key in order", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const first = serializeFileWrite("k", async () => {
    await gate;
    order.push("first");
  });
  const second = serializeFileWrite("k", async () => {
    order.push("second");
  });
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "second"]);
});
