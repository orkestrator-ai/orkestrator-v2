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
