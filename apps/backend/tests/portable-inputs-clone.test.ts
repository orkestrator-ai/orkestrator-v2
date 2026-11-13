import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { constants as fsConstants, fstatSync, promises as fs } from "node:fs";
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

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const linux = process.platform === "linux";
const darwin = process.platform === "darwin";

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
    const canClone = linux ? await reflinks(dataDir) : darwin ? await apfsClones(dataDir) : false;
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

/** Whether `directory` is on a volume `fclonefileat` can clone on (APFS). */
async function apfsClones(directory: string): Promise<boolean> {
  const clone = darwinDescriptorClone();
  if (!clone) return false;
  const source = path.join(directory, ".probe-source");
  await fs.writeFile(source, "probe");
  const handle = await fs.open(source, "r");
  try {
    await clone(handle.fd, `${source}-clone`);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
    await fs.rm(source, { force: true });
    await fs.rm(`${source}-clone`, { force: true });
  }
}

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

  test.skipIf(!darwin)(
    "clones from the checked descriptor, not the path, as a plain file",
    async () => {
      const root = await tempDir("ork-inputs-apfs-");
      cleanup.push(root);
      if (!(await apfsClones(root))) return;
      const clone = darwinDescriptorClone()!;
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

  test.skipIf(!darwin)("an immutable source still clones to a removable file", async () => {
    const root = await tempDir("ork-inputs-apfs-uchg-");
    cleanup.push(root);
    if (!(await apfsClones(root))) return;
    const source = path.join(root, "source");
    await fs.writeFile(source, "locked");
    execFileSync("chflags", ["uchg", source]);
    try {
      const handle = await fs.open(source, "r");
      const destination = path.join(root, "clone");
      try {
        await darwinDescriptorClone()!(handle.fd, destination);
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

  test.skipIf(!darwin)("staging on APFS clones every file staged byte for byte", async () => {
    const { dataDir, roots } = await fixture();
    if (!(await apfsClones(dataDir))) return;
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
