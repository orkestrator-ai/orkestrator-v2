import { afterEach, describe, expect, test } from "bun:test";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import {
  INPUT_LIMITS,
  readInputsManifest,
  stagePortableInputs,
  type InputSourceRoots,
  type StagingOptions,
} from "../src/core/portable-inputs";
import { tempDir } from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const linux = process.platform === "linux";

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

  test("a staged file stays independent of its source in both directions", async () => {
    const { dataDir, roots, home } = await fixture();
    const canClone = linux && (await reflinks(dataDir));
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
