import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { constants as fsConstants, fstatSync, promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INPUT_LIMITS,
  readInputsManifest,
  stagePortableInputs,
  type InputSourceRoots,
  type StagingOptions,
} from "../src/core/portable-inputs";
import {
  darwinDescriptorClone,
  platformDescriptorClone,
  type DescriptorClone,
} from "../src/core/portable-inputs-clone";
import { tempDir } from "./container-lifecycle-fixtures";

// `stat`, `xattr`, `chflags`, `df` and `mount` run below; Bun's 5 s default is
// too tight for them under aggregate load.
setDefaultTimeout(30_000);

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const linux = process.platform === "linux";
const darwin = process.platform === "darwin";

/**
 * The filesystem type of the volume holding `directory` on macOS (`apfs`,
 * `hfs`, …), read from `df` and `mount` rather than from the clone under
 * test, so a broken clone cannot make the APFS tests skip themselves.
 */
function darwinFilesystemType(directory: string): string | undefined {
  const lines = execFileSync("df", ["-P", directory], { encoding: "utf8", timeout: 10_000 })
    .trim()
    .split("\n");
  // Filesystem, blocks, used, available, capacity, then the mount point (which may hold spaces).
  const mountPoint = lines.at(-1)?.split(/\s+/).slice(5).join(" ");
  if (!mountPoint) return undefined;
  const mounts = execFileSync("mount", [], { encoding: "utf8", timeout: 10_000 });
  for (const line of mounts.split("\n")) {
    const match = / on (.+) \(([^,)]+)/.exec(line);
    if (match?.[1] === mountPoint) return match[2];
  }
  return undefined;
}

/**
 * Whether the temporary directory the fixtures use is on APFS. There the
 * clone must work: a missing `bun:ffi` binding or a failing `fclonefileat`
 * fails the APFS tests rather than passing them with nothing asserted. Only
 * a temporary directory on another filesystem skips them.
 */
const tmpIsApfs = darwin && darwinFilesystemType(os.tmpdir()) === "apfs";

/** The macOS descriptor clone, which must be available wherever the APFS tests run. */
function requiredDarwinClone(): DescriptorClone {
  const clone = darwinDescriptorClone();
  expect(clone).toBeFunction();
  return clone!;
}

async function write(file: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** Plain files (cloneable), a filtered settings file and a guarded skill (always read). */
async function fixture() {
  const root = await tempDir("ork-inputs-clone-");
  cleanup.push(root);
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  await write(path.join(home, ".claude", "CLAUDE.md"), "memory");
  await write(path.join(home, ".claude", "commands", "review.md"), "command");
  await write(path.join(home, ".claude", "plugins", "market", "a.js"), "a".repeat(4096));
  await write(path.join(home, ".claude", "plugins", "market", "b.js"), "b".repeat(8192));
  await write(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { SECRET: "SENTINEL" }, enabledPlugins: { "x@market": true } }),
  );
  await write(path.join(home, ".claude", "skills", "s", "SKILL.md"), "# skill");
  const roots: InputSourceRoots = { home, agentTest: false, includeClaudeCredentials: false };
  return { root, home, dataDir, roots };
}

type CopyCall = { source: string; destination: string; mode: number };

/** A `copyFile` that copies through (no reflink) and records what it was asked. */
function recordingCopy(calls: CopyCall[]): NonNullable<StagingOptions["copyFile"]> {
  return (async (source: string, destination: string, mode: number) => {
    calls.push({ source, destination, mode });
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  }) as NonNullable<StagingOptions["copyFile"]>;
}

async function contents(directory: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (relative: string) => {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (child !== "manifest.json") {
        out[child] = await fs.readFile(path.join(directory, child), "utf8");
      }
    }
  };
  await walk("");
  return out;
}

/** Whether `directory`'s filesystem reflinks (btrfs, XFS, bcachefs). */
async function reflinks(directory: string): Promise<boolean> {
  const source = path.join(directory, ".probe-source");
  await fs.writeFile(source, "probe");
  try {
    await fs.copyFile(source, `${source}-clone`, fsConstants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(source, { force: true });
    await fs.rm(`${source}-clone`, { force: true });
  }
}

describe("portable input staging by reflink", () => {
  test.skipIf(!linux)(
    "clones only files staged byte for byte, from the checked descriptor",
    async () => {
      const { dataDir, roots } = await fixture();
      const calls: CopyCall[] = [];
      const staged = await stagePortableInputs(
        dataDir,
        "clone",
        new Set(["claude"] as const),
        roots,
        new Date(),
        INPUT_LIMITS,
        { copyFile: recordingCopy(calls) },
      );
      const destinations = calls.map((call) => path.relative(staged.directory, call.destination));
      // The revision is renamed into place after copying, so the calls name the partial one.
      expect(
        destinations.map((name) => name.replace(/^\.\.\/\.[^/]+\.partial\//, "")).sort(),
      ).toEqual([
        "claude-config/CLAUDE.md",
        "claude-config/commands/review.md",
        "claude-config/plugins/market/a.js",
        "claude-config/plugins/market/b.js",
      ]);
      for (const call of calls) {
        expect(call.source).toMatch(/^\/proc\/self\/fd\/\d+$/);
        expect(call.mode).toBe(fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE);
      }
      expect(staged.clonedFiles).toBe(4);
      const files = await contents(staged.directory);
      expect(files["claude-config/settings.json"]).not.toContain("SENTINEL");
      expect(files["claude-config/skills/s/SKILL.md"]).toBe("# skill");
      for (const name of Object.keys(files)) {
        expect((await fs.stat(path.join(staged.directory, name))).mode & 0o777).toBe(0o600);
      }
    },
  );

  test("a clone and a copy stage the same files with the same accounting", async () => {
    const { dataDir, roots } = await fixture();
    const cloned = await stagePortableInputs(
      dataDir,
      "cloned",
      new Set(["claude"] as const),
      roots,
      new Date(),
      INPUT_LIMITS,
      { copyFile: recordingCopy([]) },
    );
    const copied = await stagePortableInputs(
      dataDir,
      "copied",
      new Set(["claude"] as const),
      roots,
      new Date(),
      INPUT_LIMITS,
      { cloneFiles: false },
    );
    expect(copied.clonedFiles).toBe(0);
    expect(await contents(cloned.directory)).toEqual(await contents(copied.directory));
    expect(cloned.providers).toEqual(copied.providers);
    expect((await readInputsManifest(dataDir, "cloned", cloned.revision))?.providers).toEqual(
      copied.providers,
    );
  });

  test.skipIf(!linux)(
    "a filesystem that cannot clone falls back to a copy, asked once",
    async () => {
      const { dataDir, roots } = await fixture();
      let attempts = 0;
      const staged = await stagePortableInputs(
        dataDir,
        "fallback",
        new Set(["claude"] as const),
        roots,
        new Date(),
        INPUT_LIMITS,
        {
          copyFile: (async (_source: string, destination: string) => {
            attempts += 1;
            // As a failed clone may: the destination exists, empty.
            await fs.writeFile(destination, "");
            throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
          }) as NonNullable<StagingOptions["copyFile"]>,
        },
      );
      expect(attempts).toBe(1);
      expect(staged.clonedFiles).toBe(0);
      const files = await contents(staged.directory);
      expect(files["claude-config/plugins/market/b.js"]).toBe("b".repeat(8192));
      expect(files["claude-config/CLAUDE.md"]).toBe("memory");
      expect(staged.providers[0]!.skipped).toEqual({});
    },
  );

  test.skipIf(!linux)(
    "a file that grew past the limit before its clone is not staged",
    async () => {
      const { dataDir, roots } = await fixture();
      const limits = { ...INPUT_LIMITS, fileBytes: 10_000 };
      const staged = await stagePortableInputs(
        dataDir,
        "grown",
        new Set(["claude"] as const),
        roots,
        new Date(),
        limits,
        {
          copyFile: (async (source: string, destination: string) => {
            const text = await fs.readFile(source, "utf8");
            // a.js is within the limit when checked and past it when cloned.
            await fs.writeFile(destination, text.startsWith("a") ? text.repeat(3) : text);
          }) as NonNullable<StagingOptions["copyFile"]>,
        },
      );
      const files = await contents(staged.directory);
      // A tree is staged all or nothing, so the plugin directory goes with it.
      expect(Object.keys(files).filter((name) => name.includes("/plugins/"))).toEqual([]);
      expect(files["claude-config/CLAUDE.md"]).toBe("memory");
      expect(staged.providers[0]!.skipped["too-large"]).toBe(1);
      expect(staged.providers[0]!.files).toBe(Object.keys(files).length);
    },
  );

  test.skipIf(!linux)(
    "an existing clone destination surfaces EEXIST without overwriting it",
    async () => {
      const { dataDir, roots } = await fixture();
      let attempts = 0;
      const staged = await stagePortableInputs(
        dataDir,
        "exists",
        new Set(["claude"] as const),
        roots,
        new Date(),
        INPUT_LIMITS,
        {
          copyFile: (async (source: string, destination: string) => {
            attempts += 1;
            if (destination.endsWith("/CLAUDE.md")) {
              await fs.writeFile(destination, "existing destination");
            }
            await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
          }) as NonNullable<StagingOptions["copyFile"]>,
        },
      );
      // EEXIST surfaces to the provider's unreadable-file handling. It must
      // neither delete/overwrite the destination nor disable later clones.
      expect(staged.providers[0]!.skipped["unreadable"]).toBe(1);
      expect(staged.clonedFiles).toBe(3);
      expect(attempts).toBe(4);
      expect(
        await fs.readFile(path.join(staged.directory, "claude-config/CLAUDE.md"), "utf8"),
      ).toBe("existing destination");
    },
  );

  test("a staged file stays independent of its source in both directions", async () => {
    const { dataDir, roots, home } = await fixture();
    const canClone = linux ? await reflinks(dataDir) : tmpIsApfs;
    const staged = await stagePortableInputs(
      dataDir,
      "isolated",
      new Set(["claude"] as const),
      roots,
    );
    if (canClone) expect(staged.clonedFiles).toBeGreaterThan(0);
    else expect(staged.clonedFiles).toBe(0);
    const source = path.join(home, ".claude", "plugins", "market", "a.js");
    const copy = path.join(staged.directory, "claude-config", "plugins", "market", "a.js");
    expect(await fs.readFile(copy, "utf8")).toBe("a".repeat(4096));
    expect((await fs.stat(copy)).ino).not.toBe((await fs.stat(source)).ino);
    await fs.writeFile(copy, "changed in the revision");
    expect(await fs.readFile(source, "utf8")).toBe("a".repeat(4096));
    await fs.writeFile(source, "changed on the host");
    const second = await stagePortableInputs(
      dataDir,
      "isolated-2",
      new Set(["claude"] as const),
      roots,
    );
    expect(await fs.readFile(copy, "utf8")).toBe("changed in the revision");
    expect(
      await fs.readFile(
        path.join(second.directory, "claude-config", "plugins", "market", "a.js"),
        "utf8",
      ),
    ).toBe("changed on the host");
  });
});

/** BSD file flags of `file` (`stat -f %f`), 0 when none are set. */
function fileFlags(file: string): number {
  return Number(execFileSync("stat", ["-f", "%f", file], { encoding: "utf8" }).trim());
}

function xattrNames(file: string): string[] {
  return execFileSync("xattr", [file], { encoding: "utf8" }).split("\n").filter(Boolean);
}

describe("portable input staging by APFS clone (macOS)", () => {
  test("only Linux and macOS have a descriptor clone", () => {
    expect(platformDescriptorClone(undefined, "win32")).toBeUndefined();
    expect(platformDescriptorClone(undefined, "linux")).toBeFunction();
    expect(darwinDescriptorClone("linux")).toBeUndefined();
    // Outside Bun there is no `bun:ffi`: staging copies rather than failing.
    expect(
      darwinDescriptorClone("darwin", () => {
        throw new Error("Cannot find module 'bun:ffi'");
      }),
    ).toBeUndefined();
  });

  test.skipIf(!tmpIsApfs)(
    "clones from the checked descriptor, not the path, as a plain file",
    async () => {
      const root = await tempDir("ork-inputs-apfs-");
      cleanup.push(root);
      const clone = requiredDarwinClone();
      const source = path.join(root, "source");
      await fs.writeFile(source, "checked bytes");
      execFileSync("xattr", ["-w", "org.orkestrator.probe", "planted", source]);
      execFileSync("chflags", ["nodump", source]);
      const handle = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        // A file swapped in at the path after the check must not be staged.
        await fs.writeFile(path.join(root, "swap"), "unchecked bytes");
        await fs.rename(path.join(root, "swap"), source);
        const destination = path.join(root, "clone");
        await clone(handle.fd, destination);
        expect(await fs.readFile(destination, "utf8")).toBe("checked bytes");
        expect(fileFlags(destination)).toBe(0);
        expect(xattrNames(destination)).not.toContain("org.orkestrator.probe");
        // An existing destination is never replaced.
        await fs.writeFile(destination, "existing");
        await expect(clone(handle.fd, destination)).rejects.toMatchObject({ code: "EEXIST" });
        expect(await fs.readFile(destination, "utf8")).toBe("existing");
      } finally {
        await handle.close();
      }
    },
  );

  test.skipIf(!tmpIsApfs)("an immutable source still clones to a removable file", async () => {
    const root = await tempDir("ork-inputs-apfs-uchg-");
    cleanup.push(root);
    const clone = requiredDarwinClone();
    const source = path.join(root, "source");
    await fs.writeFile(source, "locked");
    execFileSync("chflags", ["uchg", source]);
    try {
      const handle = await fs.open(source, "r");
      const destination = path.join(root, "clone");
      try {
        await clone(handle.fd, destination);
      } finally {
        await handle.close();
      }
      expect(fileFlags(destination)).toBe(0);
      await fs.chmod(destination, 0o600);
      await fs.rm(destination);
    } finally {
      execFileSync("chflags", ["nouchg", source]);
    }
  });

  test.skipIf(!tmpIsApfs)("staging on APFS clones every file staged byte for byte", async () => {
    const { dataDir, roots } = await fixture();
    requiredDarwinClone();
    const staged = await stagePortableInputs(dataDir, "apfs", new Set(["claude"] as const), roots);
    // CLAUDE.md, commands/review.md and the two plugin files; settings.json is
    // filtered and the skill guarded, so both are read and written instead.
    expect(staged.clonedFiles).toBe(4);
    const files = await contents(staged.directory);
    expect(files["claude-config/plugins/market/b.js"]).toBe("b".repeat(8192));
    expect(files["claude-config/settings.json"]).not.toContain("SENTINEL");
    for (const name of Object.keys(files)) {
      expect((await fs.stat(path.join(staged.directory, name))).mode & 0o777).toBe(0o600);
    }
  });

  test("the descriptor clone gets the checked file's descriptor", async () => {
    const { dataDir, roots, home } = await fixture();
    const seen: Array<{ destination: string; ino: number }> = [];
    const recording: DescriptorClone = async (fd, destination) => {
      seen.push({ destination, ino: fstatSync(fd).ino });
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    };
    await stagePortableInputs(
      dataDir,
      "fd",
      new Set(["claude"] as const),
      roots,
      new Date(),
      INPUT_LIMITS,
      {
        cloneDescriptor: recording,
      },
    );
    // One attempt, then the source's device is refused for the rest of the run.
    expect(seen).toHaveLength(1);
    const relative = seen[0]!.destination.replace(/^.*\/claude-config\//, "");
    expect(seen[0]!.ino).toBe((await fs.lstat(path.join(home, ".claude", relative))).ino);
  });

  test("a volume that cannot clone (HFS+, another device) falls back to a copy", async () => {
    const { dataDir, roots } = await fixture();
    let attempts = 0;
    const staged = await stagePortableInputs(
      dataDir,
      "apfs-fallback",
      new Set(["claude"] as const),
      roots,
      new Date(),
      INPUT_LIMITS,
      {
        cloneDescriptor: async (_fd, destination) => {
          attempts += 1;
          await fs.writeFile(destination, "");
          throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
        },
      },
    );
    expect(attempts).toBe(1);
    expect(staged.clonedFiles).toBe(0);
    const files = await contents(staged.directory);
    expect(files["claude-config/plugins/market/a.js"]).toBe("a".repeat(4096));
    expect(files["claude-config/CLAUDE.md"]).toBe("memory");
    expect(staged.providers[0]!.skipped).toEqual({});
  });

  test("cloneFiles: false never asks the descriptor clone", async () => {
    const { dataDir, roots } = await fixture();
    let attempts = 0;
    const staged = await stagePortableInputs(
      dataDir,
      "no-clone",
      new Set(["claude"] as const),
      roots,
      new Date(),
      INPUT_LIMITS,
      {
        cloneFiles: false,
        cloneDescriptor: async () => {
          attempts += 1;
        },
      },
    );
    expect(attempts).toBe(0);
    expect(staged.clonedFiles).toBe(0);
  });
});

type ScrubStep = "lchflags" | "listxattr" | "removexattr";

/**
 * A stand-in for `bun:ffi` whose `fclonefileat` "clones" by writing the
 * destination, as the real call does before the scrub runs, and whose scrub
 * call `failAt` fails with `errno`. The clone's xattrs are `xattrs`.
 */
function fakeDarwinFfi(options: { failAt?: ScrubStep; errno?: number; xattrs?: string[] }) {
  const removed: string[] = [];
  let errno = 0;
  const text = (value: unknown) => (value as Buffer).toString("utf8").replace(/\0$/, "");
  const fail = (step: ScrubStep, result: number) => {
    if (options.failAt !== step) return result;
    errno = options.errno ?? 1;
    return -1;
  };
  const listing = Buffer.from((options.xattrs ?? []).map((name) => `${name}\0`).join(""));
  const symbols = {
    fclonefileat: (_fd: number, _dirfd: number, name: unknown) => {
      writeFileSync(text(name), "cloned");
      return 0;
    },
    lchflags: () => fail("lchflags", 0),
    listxattr: (_path: unknown, names: unknown, size: number) => {
      if (names !== null) listing.copy(names as Buffer, 0, 0, size);
      return fail("listxattr", listing.length);
    },
    removexattr: (_path: unknown, name: unknown) => {
      removed.push(text(name));
      return fail("removexattr", 0);
    },
    __error: () => 0,
  };
  const ffi = {
    dlopen: () => ({ symbols }),
    FFIType: new Proxy({}, { get: (_target, key) => key }),
    ptr: (value: Buffer) => value,
    read: { i32: () => errno },
  };
  return { loadFfi: () => ffi, removed };
}

describe("a macOS clone whose scrub fails", () => {
  test("clears every xattr but the provenance, and treats ENOATTR as cleared", async () => {
    const root = await tempDir("ork-inputs-scrub-");
    cleanup.push(root);
    const fake = fakeDarwinFfi({
      xattrs: ["com.apple.provenance", "org.orkestrator.a", "org.orkestrator.b"],
      failAt: "removexattr",
      errno: 93,
    });
    const clone = darwinDescriptorClone("darwin", fake.loadFfi)!;
    await clone(0, path.join(root, "clone"));
    expect(fake.removed).toEqual(["org.orkestrator.a", "org.orkestrator.b"]);
  });

  for (const failAt of ["lchflags", "listxattr", "removexattr"] as const) {
    test(`a failing ${failAt} rejects, and staging removes the clone and copies`, async () => {
      const make = () =>
        darwinDescriptorClone(
          "darwin",
          fakeDarwinFfi({ failAt, errno: 13, xattrs: ["org.orkestrator.a"] }).loadFfi,
        )!;
      const root = await tempDir("ork-inputs-scrub-");
      cleanup.push(root);
      const destination = path.join(root, "clone");
      await expect(make()(0, destination)).rejects.toMatchObject({ code: "EACCES" });

      const { dataDir, roots } = await fixture();
      const clone = make();
      let attempts = 0;
      const staged = await stagePortableInputs(
        dataDir,
        `scrub-${failAt}`,
        new Set(["claude"] as const),
        roots,
        new Date(),
        INPUT_LIMITS,
        {
          cloneDescriptor: async (fd, target) => {
            attempts += 1;
            await clone(fd, target);
          },
        },
      );
      // The half-made clone is gone: the copy that replaced it holds the source's bytes.
      expect(attempts).toBe(1);
      expect(staged.clonedFiles).toBe(0);
      const files = await contents(staged.directory);
      expect(files["claude-config/plugins/market/a.js"]).toBe("a".repeat(4096));
      expect(files["claude-config/CLAUDE.md"]).toBe("memory");
      expect(Object.values(files)).not.toContain("cloned");
    });
  }
});
