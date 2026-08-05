import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertBase64PayloadWithinLimit,
  base64DecodedByteLength,
  MAX_BASE64_PAYLOAD_BYTES,
  MAX_WRITE_FILE_BYTES,
  writeConfinedFile,
} from "./path-safety.js";

/**
 * `writeConfinedFile` is the only writer behind every command that puts an
 * untrusted payload into a worktree, so its confinement branches are covered
 * here rather than through one command that happens to reach them.
 */

const temporaryRoots: string[] = [];

async function createWorktree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ork-confined-write-"));
  temporaryRoots.push(root);
  return root;
}

/** True when the filesystem under `root` folds case, as APFS does by default. */
async function foldsCase(root: string): Promise<boolean> {
  const probe = path.join(root, "CaseProbe");
  await fs.mkdir(probe);
  try {
    await fs.stat(path.join(root, "caseprobe"));
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("assertBase64PayloadWithinLimit", () => {
  test("returns the normalized payload and rejects empty or truncated base64", () => {
    expect(assertBase64PayloadWithinLimit("QUJD")).toBe("QUJD");
    expect(assertBase64PayloadWithinLimit("QU\nJ D\t")).toBe("QUJD");

    // A 0-byte attachment is still advertised to the agent as an image, so the
    // attachment path opts in. A plain file write must stay able to truncate:
    // the editor sends an empty payload when the user clears a buffer.
    expect(assertBase64PayloadWithinLimit("")).toBe("");
    expect(assertBase64PayloadWithinLimit("   \n ")).toBe("");
    expect(() => assertBase64PayloadWithinLimit("", { rejectEmpty: true }))
      .toThrow("must not be empty");
    expect(() => assertBase64PayloadWithinLimit("   \n ", { rejectEmpty: true }))
      .toThrow("must not be empty");
    expect(() => assertBase64PayloadWithinLimit("QUJ")).toThrow("not valid base64");
    expect(() => assertBase64PayloadWithinLimit("QQ=Q")).toThrow("not valid base64");
    expect(() => assertBase64PayloadWithinLimit("**")).toThrow("not valid base64");
  });

  test("reports an oversized payload as oversized, not as malformed base64", () => {
    // The oversize check runs first on purpose: this payload is also not a
    // multiple of four, and "not valid base64" would be a misleading answer.
    expect(() => assertBase64PayloadWithinLimit("a".repeat(MAX_BASE64_PAYLOAD_BYTES + 1)))
      .toThrow("File payload exceeds");
    expect(() => assertBase64PayloadWithinLimit(
      Buffer.alloc(MAX_WRITE_FILE_BYTES + 1).toString("base64"),
    )).toThrow("File payload exceeds");
    expect(() => assertBase64PayloadWithinLimit(
      Buffer.alloc(MAX_WRITE_FILE_BYTES).toString("base64"),
    )).not.toThrow();
  });

  test("computes the decoded size without decoding", () => {
    for (const size of [1, 2, 3, 4, 5, 6, 1_000]) {
      const encoded = Buffer.alloc(size, 7).toString("base64");
      expect(base64DecodedByteLength(encoded)).toBe(size);
    }
  });
});

describe("writeConfinedFile", () => {
  test("creates private ancestors and a private file", async () => {
    const root = await createWorktree();
    const written = await writeConfinedFile(
      root,
      ".orkestrator/initial-prompt/batch/image.png",
      Buffer.from("A").toString("base64"),
    );

    expect(written).toBe(path.join(
      await fs.realpath(root),
      ".orkestrator/initial-prompt/batch/image.png",
    ));
    await expect(fs.readFile(written, "utf8")).resolves.toBe("A");
    expect((await fs.stat(written)).mode & 0o777).toBe(0o600);
    for (const directory of [".orkestrator", ".orkestrator/initial-prompt", ".orkestrator/initial-prompt/batch"]) {
      expect((await fs.stat(path.join(root, directory))).mode & 0o777).toBe(0o700);
    }
  });

  test("strips whitespace from the payload before decoding", async () => {
    const root = await createWorktree();
    const written = await writeConfinedFile(root, "notes/data.bin", "QUJD\nREVG Rw=\t=");
    await expect(fs.readFile(written, "utf8")).resolves.toBe("ABCDEFG");
  });

  test("accepts a pre-decoded buffer without re-validating it as base64", async () => {
    const root = await createWorktree();
    const written = await writeConfinedFile(root, "notes/data.bin", Buffer.from([0, 1, 255]));
    await expect(fs.readFile(written)).resolves.toEqual(Buffer.from([0, 1, 255]));
    await expect(writeConfinedFile(
      root,
      "notes/huge.bin",
      Buffer.alloc(MAX_WRITE_FILE_BYTES + 1),
    )).rejects.toThrow("File payload exceeds");
  });

  test("refuses to adopt an existing file unless the caller asked to overwrite", async () => {
    const root = await createWorktree();
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "notes/data.bin"), "planted");

    await expect(writeConfinedFile(root, "notes/data.bin", "QQ=="))
      .rejects.toThrow(/EEXIST/);
    await expect(fs.readFile(path.join(root, "notes/data.bin"), "utf8")).resolves.toBe("planted");

    // The overwrite-intended path truncates rather than failing, and must not
    // leave any tail of the longer previous contents behind.
    const written = await writeConfinedFile(root, "notes/data.bin", "QQ==", { exclusive: false });
    await expect(fs.readFile(written, "utf8")).resolves.toBe("A");
  });

  test("rejects a symlinked ancestor and a regular file standing in for one", async () => {
    const root = await createWorktree();
    const external = await createWorktree();
    await fs.symlink(external, path.join(root, ".orkestrator"));
    await expect(writeConfinedFile(root, ".orkestrator/image.png", "QQ=="))
      .rejects.toThrow("symlink or non-directory ancestor");
    expect(await fs.readdir(external)).toEqual([]);

    const fileRoot = await createWorktree();
    await fs.writeFile(path.join(fileRoot, ".orkestrator"), "not a directory");
    await expect(writeConfinedFile(fileRoot, ".orkestrator/image.png", "QQ=="))
      .rejects.toThrow("symlink or non-directory ancestor");
  });

  test("reports a missing worktree instead of creating one", async () => {
    const root = await createWorktree();
    await expect(writeConfinedFile(path.join(root, "gone"), "a/b.png", "QQ=="))
      .rejects.toThrow(/ENOENT/);
  });

  test("accepts a pre-existing directory whose on-disk casing differs", async () => {
    const root = await createWorktree();
    if (!await foldsCase(root)) return;
    // mkdir returns EEXIST, lstat reports a plain directory, and realpath
    // answers with the on-disk `.Orkestrator`. Comparing that string to the
    // requested `.orkestrator` would reject a directory that is not a symlink.
    await fs.mkdir(path.join(root, ".Orkestrator"));

    const written = await writeConfinedFile(root, ".orkestrator/image.png", "QQ==");
    await expect(fs.readFile(written, "utf8")).resolves.toBe("A");
    expect(await fs.readdir(path.join(root, ".Orkestrator"))).toEqual(["image.png"]);
  });

  test("validates the path before touching the filesystem", async () => {
    const root = await createWorktree();
    await expect(writeConfinedFile(root, "../escape.png", "QQ=="))
      .rejects.toThrow("parent directory traversal");
    await expect(writeConfinedFile(root, "notes/truncated.png", "QUJ"))
      .rejects.toThrow("not valid base64");
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("writes an empty payload as a 0-byte file rather than rejecting it", async () => {
    // Clearing a file in the editor sends an empty payload; refusing it here
    // would make "select all, delete, save" fail.
    const root = await createWorktree();
    const written = await writeConfinedFile(root, "notes/empty.txt", "", {
      exclusive: false,
    });
    await expect(fs.readFile(written, "utf8")).resolves.toBe("");
  });

  /**
   * The remaining branches guard against the target being replaced between the
   * checks and the write. There is no way to lose that race deterministically
   * from a test, so each one is driven by making the corresponding syscall
   * report the outcome the race would have produced.
   */
  describe("replacement races", () => {
    test("refuses a parent that resolves outside the worktree", async () => {
      const root = await createWorktree();
      const canonicalRoot = await fs.realpath(root);
      const realpath = fs.realpath.bind(fs);
      const spy = spyOn(fs, "realpath").mockImplementation((async (target: string, ...rest: unknown[]) => {
        if (target === path.join(canonicalRoot, ".orkestrator")) return "/elsewhere";
        return realpath(target as never, ...rest as never[]);
      }) as typeof fs.realpath);
      try {
        await expect(writeConfinedFile(root, ".orkestrator/image.png", "QQ=="))
          .rejects.toThrow("path leaves the local worktree");
      } finally {
        spy.mockRestore();
      }
    });

    test("refuses a target that resolves outside the worktree", async () => {
      const root = await createWorktree();
      const canonicalRoot = await fs.realpath(root);
      const target = path.join(canonicalRoot, "notes", "image.png");
      const realpath = fs.realpath.bind(fs);
      const spy = spyOn(fs, "realpath").mockImplementation((async (candidate: string, ...rest: unknown[]) => {
        if (candidate === target) return "/elsewhere/image.png";
        return realpath(candidate as never, ...rest as never[]);
      }) as typeof fs.realpath);
      try {
        await expect(writeConfinedFile(root, "notes/image.png", "QQ=="))
          .rejects.toThrow("outside the local worktree");
      } finally {
        spy.mockRestore();
      }
      // The partially written file is removed rather than left for the caller.
      expect(await fs.readdir(path.join(root, "notes"))).toEqual([]);
    });

    test("refuses a target whose identity changed while it was being opened", async () => {
      const root = await createWorktree();
      const target = path.join(await fs.realpath(root), "notes", "image.png");
      const lstat = fs.lstat.bind(fs);
      const spy = spyOn(fs, "lstat").mockImplementation((async (candidate: string, ...rest: unknown[]) => {
        const stats = await lstat(candidate as never, ...rest as never[]);
        if (candidate === target) Object.assign(stats, { ino: stats.ino + 1 });
        return stats;
      }) as typeof fs.lstat);
      try {
        await expect(writeConfinedFile(root, "notes/image.png", "QQ=="))
          .rejects.toThrow("changed while it was being opened");
      } finally {
        spy.mockRestore();
      }
      expect(await fs.readdir(path.join(root, "notes"))).toEqual([]);
    });

    test("refuses a target whose identity changed while it was being written", async () => {
      const root = await createWorktree();
      const target = path.join(await fs.realpath(root), "notes", "image.png");
      const lstat = fs.lstat.bind(fs);
      let targetReads = 0;
      const spy = spyOn(fs, "lstat").mockImplementation((async (candidate: string, ...rest: unknown[]) => {
        const stats = await lstat(candidate as never, ...rest as never[]);
        // Only the post-write check sees the swap; the pre-write one must pass
        // so the failure is attributed to the write, not to the open.
        if (candidate === target && (targetReads += 1) > 1) {
          Object.assign(stats, { ino: stats.ino + 1 });
        }
        return stats;
      }) as typeof fs.lstat);
      try {
        await expect(writeConfinedFile(root, "notes/image.png", "QQ=="))
          .rejects.toThrow("changed while it was being written");
      } finally {
        spy.mockRestore();
      }
      expect(await fs.readdir(path.join(root, "notes"))).toEqual([]);
    });

    test("refuses a parent directory swapped between validation and the write", async () => {
      const root = await createWorktree();
      const canonicalRoot = await fs.realpath(root);
      const parent = path.join(canonicalRoot, "notes");
      const lstat = fs.lstat.bind(fs);
      let parentReads = 0;
      const spy = spyOn(fs, "lstat").mockImplementation((async (candidate: string, ...rest: unknown[]) => {
        const stats = await lstat(candidate as never, ...rest as never[]);
        // The loop's own lstat is first; the identity re-check before the open
        // is second and must see a different directory.
        if (candidate === parent && (parentReads += 1) > 1) {
          Object.assign(stats, { ino: stats.ino + 1 });
        }
        return stats;
      }) as typeof fs.lstat);
      try {
        await expect(writeConfinedFile(root, "notes/image.png", "QQ=="))
          .rejects.toThrow("symlink ancestor is not allowed");
      } finally {
        spy.mockRestore();
      }
      expect(await fs.readdir(parent)).toEqual([]);
    });

    test("refuses a descriptor that is not a regular file", async () => {
      const root = await createWorktree();
      const open = fs.open.bind(fs);
      const spy = spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
        const handle = await open(...args as Parameters<typeof fs.open>);
        return Object.assign(Object.create(Object.getPrototypeOf(handle)), handle, {
          stat: async () => Object.assign(await handle.stat(), { isFile: () => false }),
          close: () => handle.close(),
        });
      }) as typeof fs.open);
      try {
        await expect(writeConfinedFile(root, "notes/image.png", "QQ=="))
          .rejects.toThrow("not a regular file");
      } finally {
        spy.mockRestore();
      }
    });
  });
});
