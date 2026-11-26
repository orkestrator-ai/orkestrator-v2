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
import type { CommandContext } from "./commands/context.js";
import { createCommandRegistry } from "./commands/registry.js";
import { MAX_TEXT_FILE_BYTES } from "./path-safety.js";
import {
  CONTAINER_WRITE_CONFLICT_EXIT,
  CONTAINER_WRITE_NOT_FILE_EXIT,
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

// `write_local_file` writes only a registered environment's worktree, so every
// temporary root is registered as a local environment.
const environmentFor = (id: string) => {
  const index = Number(id.slice("env-".length));
  return { id, environmentType: "local", worktreePath: roots[index] };
};
/** What each write told the diff service, in order. */
const diffNotices: string[] = [];
afterEach(() => {
  diffNotices.length = 0;
});
const context = {
  storage: {
    loadEnvironments: async () => roots.map((_, index) => environmentFor(`env-${index}`)),
    getEnvironment: async (id: string) => environmentFor(id),
  },
  runtime: {
    environments: {
      fence: { beginWorktreeMutation: () => () => undefined, beginMutation: () => () => undefined },
    },
    diffStats: {
      service: {
        invalidateChanges: ({ worktreePath }: { worktreePath: string }) =>
          diffNotices.push(`invalidate ${worktreePath}`),
        refresh: (environmentId: string) => diffNotices.push(`refresh ${environmentId}`),
      },
    },
  },
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

  test("keeps the replaced file's permission bits and leaves no temporary file", async () => {
    const root = await worktree();
    const target = path.join(root, "run.sh");
    await fs.writeFile(target, "echo one");
    await fs.chmod(target, 0o751);
    await write(
      {
        worktreePath: root,
        filePath: "run.sh",
        base64Data: b64("echo two"),
        expected: { sha256: fileContentSha256("echo one") },
      },
      context,
    );
    expect((await fs.stat(target)).mode & 0o777).toBe(0o751);
    expect(await fs.readFile(target, "utf8")).toBe("echo two");
    expect(await fs.readdir(root)).toEqual(["run.sh"]);
  });

  test("a symlinked file is compared through its link, like the editor read", async () => {
    const root = await worktree();
    await fs.writeFile(path.join(root, "real.txt"), "loaded");
    await fs.symlink("real.txt", path.join(root, "link.txt"));
    const error = await rejection(() =>
      write(
        {
          worktreePath: root,
          filePath: "link.txt",
          base64Data: b64("edited"),
          expected: { sha256: fileContentSha256("stale") },
        },
        context,
      ),
    );
    expect(isFileWriteConflict(error)).toBe(true);
    await write(
      {
        worktreePath: root,
        filePath: "link.txt",
        base64Data: b64("edited"),
        expected: { sha256: fileContentSha256("loaded") },
      },
      context,
    );
    expect((await fs.lstat(path.join(root, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(root, "real.txt"), "utf8")).toBe("edited");
  });

  test("confines checked symlink saves to the registered worktree", async () => {
    const worktreePath = await worktree();
    const outside = path.join(await worktree(), "outside.txt");
    await fs.writeFile(outside, "outside");
    const link = path.join(worktreePath, "link.txt");
    await fs.symlink(outside, link);
    const error = await rejection(() =>
      write(
        {
          worktreePath,
          filePath: "link.txt",
          base64Data: b64("edited"),
          expected: { sha256: fileContentSha256("outside") },
        },
        context,
      ),
    );
    expect(isFileWriteConflict(error)).toBe(true);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outside, "utf8")).toBe("outside");
  });

  test("refuses oversized replacements and leaves removed parent directories absent", async () => {
    const worktreePath = await worktree();
    const large = path.join(worktreePath, "large");
    await fs.writeFile(large, "");
    await fs.truncate(large, MAX_TEXT_FILE_BYTES + 1);
    for (const filePath of ["large", "removed/child.txt"]) {
      const error = await rejection(() =>
        write(
          {
            worktreePath,
            filePath,
            base64Data: b64("edited"),
            expected: { sha256: fileContentSha256("loaded") },
          },
          context,
        ),
      );
      expect(isFileWriteConflict(error)).toBe(true);
    }
    expect((await fs.stat(large)).size).toBe(MAX_TEXT_FILE_BYTES + 1);
    expect(await fs.readdir(worktreePath)).toEqual(["large"]);
  });

  test("recreates a missing file only if it is still absent", async () => {
    const worktreePath = await worktree();
    const filePath = "deleted.txt";
    const target = path.join(worktreePath, filePath);
    const args = { worktreePath, filePath, base64Data: b64("mine"), expected: { absent: true } };
    await fs.writeFile(target, Buffer.from([0, 1]));
    expect(isFileWriteConflict(await rejection(() => write(args, context)))).toBe(true);
    expect(await fs.readFile(target)).toEqual(Buffer.from([0, 1]));
    await fs.unlink(target);
    await write(args, context);
    expect(await fs.readFile(target, "utf8")).toBe("mine");
  });

  test("without a precondition (older clients, explicit overwrite) it writes as before", async () => {
    const root = await worktree();
    await fs.writeFile(path.join(root, "a.txt"), "changed by an agent");
    await write({ worktreePath: root, filePath: "a.txt", base64Data: b64("mine") }, context);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("mine");
  });

  // The tree and Changes must not depend on a watcher hint for a write the
  // backend made itself: a saturated fseventsd can withhold it for minutes.
  test("announces every write it attempted to the diff service, a refused one included", async () => {
    const root = await worktree();
    const environmentId = `env-${roots.indexOf(root)}`;
    await write({ worktreePath: root, filePath: "new.txt", base64Data: b64("new") }, context);
    expect(diffNotices).toEqual([`invalidate ${root}`, `refresh ${environmentId}`]);
    diffNotices.length = 0;
    const error = await rejection(() =>
      write(
        {
          worktreePath: root,
          filePath: "new.txt",
          base64Data: b64("edited"),
          expected: { sha256: fileContentSha256("stale") },
        },
        context,
      ),
    );
    expect(isFileWriteConflict(error)).toBe(true);
    expect(diffNotices).toEqual([`invalidate ${root}`, `refresh ${environmentId}`]);
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
    expect(diffNotices).toEqual([]);
  });

  test("a directory no environment is registered at is refused", async () => {
    const unregistered = await fs.mkdtemp(path.join(tmpdir(), "ork-file-precondition-other-"));
    try {
      await expect(
        write({ worktreePath: unregistered, filePath: "a.txt", base64Data: b64("x") }, context),
      ).rejects.toThrow("not the worktree of a registered local environment");
      await expect(fs.access(path.join(unregistered, "a.txt"))).rejects.toThrow();
    } finally {
      await fs.rm(unregistered, { recursive: true, force: true });
    }
  });
});

describe("registered local file roots", () => {
  const registry = createCommandRegistry();

  for (const environmentType of ["container", undefined]) {
    test(`refuses reads and writes for a matching ${environmentType ?? "legacy non-local"} root`, async () => {
      const root = await worktree();
      await fs.writeFile(path.join(root, "a.txt"), "unchanged");
      const nonLocalContext = {
        ...context,
        storage: {
          loadEnvironments: async () => [{ id: "non-local", environmentType, worktreePath: root }],
        },
      } as unknown as CommandContext;
      const args = { worktreePath: root, filePath: "a.txt", base64Data: b64("changed") };
      for (const command of ["read_local_file", "write_local_file"]) {
        await expect(registry.get(command)!(args, nonLocalContext)).rejects.toThrow(
          "not the worktree of a registered local environment",
        );
      }
      expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("unchanged");
    });
  }

  test("refuses a write when the stored root moves during mutation admission and releases both fences", async () => {
    const previousRoot = await worktree();
    const movedRoot = await worktree();
    for (const root of [previousRoot, movedRoot]) {
      await fs.writeFile(path.join(root, "a.txt"), "unchanged");
    }
    let currentRoot = previousRoot;
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => (admitted = resolve));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    let worktreeReleased = false;
    let environmentReleased = false;
    const movingContext = {
      storage: {
        loadEnvironments: async () => [
          { id: "moving", environmentType: "local", worktreePath: previousRoot },
        ],
        getEnvironment: async () => {
          await gate;
          return { id: "moving", environmentType: "local", worktreePath: currentRoot };
        },
      },
      runtime: {
        environments: {
          fence: {
            beginWorktreeMutation: () => () => {
              worktreeReleased = true;
            },
            beginMutation: () => {
              admitted();
              return () => {
                environmentReleased = true;
              };
            },
          },
        },
      },
    } as unknown as CommandContext;
    const pending = rejection(() =>
      registry.get("write_local_file")!(
        {
          worktreePath: previousRoot,
          filePath: "a.txt",
          base64Data: b64("changed"),
        },
        movingContext,
      ),
    );
    try {
      await admission;
      currentRoot = movedRoot;
    } finally {
      resume();
    }
    expect(await pending).toMatchObject({ message: "The worktree moved; refresh before saving" });
    expect(worktreeReleased).toBe(true);
    expect(environmentReleased).toBe(true);
    for (const root of [previousRoot, movedRoot]) {
      expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("unchanged");
    }
  });
});

describe("parseFileWritePrecondition", () => {
  test("accepts only a lower-case hex digest", () => {
    const sha256 = fileContentSha256("x");
    expect(parseFileWritePrecondition(undefined)).toBeUndefined();
    expect(parseFileWritePrecondition({ sha256 })).toEqual({ sha256 });
    expect(parseFileWritePrecondition({ absent: true })).toEqual({ absent: true });
    expect(() => parseFileWritePrecondition({ absent: true, sha256 })).toThrow();
    expect(() => parseFileWritePrecondition({ sha256: sha256.toUpperCase() })).toThrow();
    expect(() => parseFileWritePrecondition({ sha256, extra: 1 })).toThrow();
    expect(() => parseFileWritePrecondition("abc")).toThrow();
  });
});

describe("the container writer script", () => {
  function run(script: string, input: string) {
    return spawnSync("bash", ["-c", script], { input: b64(input) });
  }
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const script = (root: string, target: string, loaded: string | undefined, payload: string) =>
    containerFileWriteScript(
      target,
      loaded === undefined ? undefined : { sha256: fileContentSha256(loaded) },
      bytes(payload),
      root,
    );

  test.skipIf(process.platform !== "linux")(
    "writes when the digest matches and exits with the conflict status otherwise",
    async () => {
      const root = await worktree();
      const target = path.join(root, "it's here.txt");
      await fs.writeFile(target, "loaded");
      const ok = run(script(root, target, "loaded", "v2"), "v2");
      expect(ok.status).toBe(0);
      expect(await fs.readFile(target, "utf8")).toBe("v2");

      const stale = run(script(root, target, "loaded", "v3"), "v3");
      expect(stale.status).toBe(CONTAINER_WRITE_CONFLICT_EXIT);
      expect(await fs.readFile(target, "utf8")).toBe("v2");

      const missing = run(script(root, path.join(root, "missing.txt"), "", "x"), "x");
      expect(missing.status).toBe(CONTAINER_WRITE_CONFLICT_EXIT);

      expect(run(script(root, target, undefined, "forced"), "forced").status).toBe(0);
      expect(await fs.readFile(target, "utf8")).toBe("forced");
      // Every temporary file is published or removed.
      expect((await fs.readdir(root)).sort()).toEqual(["it's here.txt"]);
    },
  );

  test("never publishes a truncated payload and leaves the target as it was", async () => {
    const root = await worktree();
    const target = path.join(root, "a.txt");
    await fs.writeFile(target, "loaded");
    // The client promised more bytes than arrived (it died mid-transfer).
    const result = run(
      containerFileWriteScript(target, { sha256: fileContentSha256("loaded") }, 1_000, root),
      "partial",
    );
    expect(result.status).not.toBe(0);
    expect(await fs.readFile(target, "utf8")).toBe("loaded");
    expect(await fs.readdir(root)).toEqual(["a.txt"]);
  });

  test.skipIf(process.platform !== "linux")(
    "keeps the replaced file's permission bits",
    async () => {
      const root = await worktree();
      const target = path.join(root, "run.sh");
      await fs.writeFile(target, "echo one");
      await fs.chmod(target, 0o751);
      expect(run(script(root, target, "echo one", "echo two"), "echo two").status).toBe(0);
      expect((await fs.stat(target)).mode & 0o777).toBe(0o751);
      expect(await fs.readFile(target, "utf8")).toBe("echo two");
    },
  );

  test.skipIf(process.platform !== "linux")(
    "keeps ownership and extended attributes on replacement",
    async () => {
      const { dlopen, FFIType, ptr } = await import("bun:ffi");
      const root = await worktree();
      const target = path.join(root, "with-attributes");
      await fs.writeFile(target, "loaded");
      const { uid, gid } = await fs.stat(target);
      const libc = dlopen("libc.so.6", {
        setxattr: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.i32],
          returns: FFIType.i32,
        },
        getxattr: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
          returns: FFIType.i32,
        },
      });
      try {
        const name = Buffer.from(target + "\0");
        const key = Buffer.from("user.orkestrator-test\0");
        const value = Buffer.from("retained");
        expect(libc.symbols.setxattr(ptr(name), ptr(key), ptr(value), value.length, 0)).toBe(0);
        expect(run(script(root, target, "loaded", "edited"), "edited").status).toBe(0);
        expect(await fs.stat(target)).toMatchObject({ uid, gid });
        const actual = Buffer.alloc(value.length);
        expect(libc.symbols.getxattr(ptr(name), ptr(key), ptr(actual), actual.length)).toBe(
          value.length,
        );
        expect(actual).toEqual(value);
      } finally {
        libc.close();
      }
    },
  );

  test("a directory is a conflict for a checked write and a type error otherwise", async () => {
    const root = await worktree();
    const target = path.join(root, "dir");
    await fs.mkdir(target);
    expect(run(script(root, target, "loaded", "x"), "x").status).toBe(
      CONTAINER_WRITE_CONFLICT_EXIT,
    );
    expect(run(script(root, target, undefined, "x"), "x").status).toBe(
      CONTAINER_WRITE_NOT_FILE_EXIT,
    );
    expect(await fs.readdir(target)).toEqual([]);
  });

  test("creates a long basename atomically and refuses a recreation once the path exists", async () => {
    const root = await worktree();
    const name = "a".repeat(255);
    const target = path.join(root, name);
    const recreate = containerFileWriteScript(target, { absent: true }, 1, root);
    expect(run(recreate, "x").status).toBe(0);
    expect(run(recreate, "y").status).toBe(CONTAINER_WRITE_CONFLICT_EXIT);
    expect(await fs.readFile(target, "utf8")).toBe("x");
    expect(await fs.readdir(root)).toEqual([name]);
  });

  test.skipIf(process.platform !== "linux")(
    "a symlink save publishes to the in-workspace referent",
    async () => {
      const root = await worktree();
      const target = path.join(root, "real.txt");
      const link = path.join(root, "link.txt");
      await fs.writeFile(target, "loaded");
      await fs.symlink("real.txt", link);
      expect(run(script(root, link, "loaded", "x"), "x").status).toBe(0);
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe("x");
    },
  );

  test.skipIf(process.platform !== "linux")(
    "publishes to the exact entry when the target becomes a directory",
    async () => {
      const root = await worktree();
      const target = path.join(root, "target.txt");
      const mutation = path.join(root, "replace-before-rename.cjs");
      await fs.writeFile(target, "loaded");
      await fs.writeFile(
        mutation,
        `
      const fs = require("node:fs");
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        fs.unlinkSync(to);
        fs.mkdirSync(to);
        rename(from, to);
      };
    `,
      );
      const result = spawnSync("bash", ["-c", script(root, target, "loaded", "edited")], {
        input: b64("edited"),
        env: { ...process.env, NODE_OPTIONS: `--require="${mutation}"` },
      });
      expect(result.status).toBe(CONTAINER_WRITE_CONFLICT_EXIT);
      expect(await fs.readdir(target)).toEqual([]);
      expect((await fs.readdir(root)).sort()).toEqual(["replace-before-rename.cjs", "target.txt"]);
    },
  );

  test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
    "respects write access to the existing inode",
    async () => {
      const root = await worktree();
      const target = path.join(root, "readonly.txt");
      await fs.writeFile(target, "loaded", { mode: 0o444 });
      expect(run(script(root, target, "loaded", "edited"), "edited").status).not.toBe(0);
      expect(await fs.readFile(target, "utf8")).toBe("loaded");
      expect(await fs.readdir(root)).toEqual(["readonly.txt"]);
    },
  );

  test("creates a missing file and its directory without a precondition", async () => {
    const root = await worktree();
    const target = path.join(root, "nested", "new.txt");
    expect(run(script(root, target, undefined, "fresh"), "fresh").status).toBe(0);
    expect(await fs.readFile(target, "utf8")).toBe("fresh");
    expect(await fs.readdir(path.join(root, "nested"))).toEqual(["new.txt"]);
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
