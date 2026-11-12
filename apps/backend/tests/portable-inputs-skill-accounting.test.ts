/**
 * How a directory unit's skips are counted when part of it is left out
 * (portable input spec 7): a skill's oversized optional file is skipped on
 * its own, a skill or other unit refused whole is one skip and nothing else,
 * and a non-skill unit stays all-or-nothing. Sources change between listing
 * and copying through the `afterListing` test seam, so growth and a swapped
 * linked skill are deterministic. Never reads the real home.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  INPUT_LIMITS,
  stagePortableInputs,
  type InputLimits,
  type StagingOptions,
} from "../src/core/portable-inputs";
import { tempDir } from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  );
}

/** An empty fixture home holding only what each test writes. */
async function emptyHome() {
  const root = await fs.realpath(await tempDir("ork-inputs-accounting-"));
  cleanup.push(root);
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  await fs.mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  return { home, dataDir, skills: path.join(home, ".claude", "skills") };
}

/** A skill with a short SKILL.md, two notes and a binary over a 100-byte file bound. */
async function skillWithBinary(directory: string, notes = 60) {
  await write(path.join(directory, "SKILL.md"), "---\nname: s\n---\n");
  await write(path.join(directory, "a.md"), "a".repeat(notes));
  await write(path.join(directory, "b.md"), "b".repeat(notes));
  await write(path.join(directory, "bin", "tool"), "x".repeat(200));
}

async function stageClaude(
  dataDir: string,
  home: string,
  limits: Partial<InputLimits>,
  options: StagingOptions = {},
) {
  const staged = await stagePortableInputs(
    dataDir,
    "env-skill-accounting",
    new Set(["claude"] as const),
    { home, agentTest: false },
    new Date(),
    { ...INPUT_LIMITS, fileBytes: 100, ...limits },
    options,
  );
  const claude = staged.providers.find((entry) => entry.provider === "claude")!;
  return { staged, skipped: claude.skipped, config: path.join(staged.directory, "claude-config") };
}

describe("skip accounting for skills staged without part of their files", () => {
  test("a skill refused by its directory bound counts once, not its left-out binary", async () => {
    const { home, dataDir, skills } = await emptyHome();
    await skillWithBinary(path.join(skills, "big"), 90);
    const { skipped, config } = await stageClaude(dataDir, home, { directoryBytes: 150 });
    expect(await exists(path.join(config, "skills", "big"))).toBe(false);
    expect(skipped).toEqual({ "too-large": 1 });
  });

  test("a skill refused by the aggregate budget counts once, not its left-out binary", async () => {
    const { home, dataDir, skills } = await emptyHome();
    await skillWithBinary(path.join(skills, "big"));
    const { skipped, config } = await stageClaude(dataDir, home, { totalBytes: 100 });
    expect(await exists(path.join(config, "skills", "big"))).toBe(false);
    expect(skipped).toEqual({ "aggregate-budget": 1 });
  });

  test("files that grow past the directory bound after listing refuse the skill once", async () => {
    const { home, dataDir, skills } = await emptyHome();
    const skill = path.join(skills, "growing");
    await skillWithBinary(skill);
    const { skipped, config } = await stageClaude(
      dataDir,
      home,
      { directoryBytes: 150 },
      {
        afterListing: async (source) => {
          if (path.basename(source) !== "growing") return;
          await fs.writeFile(path.join(skill, "a.md"), "a".repeat(90));
          await fs.writeFile(path.join(skill, "b.md"), "b".repeat(90));
        },
      },
    );
    expect(await exists(path.join(config, "skills", "growing"))).toBe(false);
    expect(skipped).toEqual({ "too-large": 1 });
  });

  test("a SKILL.md that grows past the file bound after listing refuses the skill once", async () => {
    const { home, dataDir, skills } = await emptyHome();
    const skill = path.join(skills, "growing-definition");
    await skillWithBinary(skill);
    const { skipped, config } = await stageClaude(
      dataDir,
      home,
      {},
      {
        afterListing: async (source) => {
          if (path.basename(source) !== "growing-definition") return;
          await fs.writeFile(path.join(skill, "SKILL.md"), "x".repeat(200));
        },
      },
    );
    expect(await exists(path.join(config, "skills", "growing-definition"))).toBe(false);
    expect(skipped).toEqual({ "too-large": 1 });
  });

  test("an optional file that grows past the file bound after listing is left out alone", async () => {
    const { home, dataDir, skills } = await emptyHome();
    const skill = path.join(skills, "growing-note");
    await skillWithBinary(skill);
    const { skipped, config } = await stageClaude(
      dataDir,
      home,
      {},
      {
        afterListing: async (source) => {
          if (path.basename(source) !== "growing-note") return;
          await fs.writeFile(path.join(skill, "a.md"), "a".repeat(200));
        },
      },
    );
    const staged = path.join(config, "skills", "growing-note");
    expect(await exists(path.join(staged, "SKILL.md"))).toBe(true);
    expect(await exists(path.join(staged, "b.md"))).toBe(true);
    expect(await exists(path.join(staged, "a.md"))).toBe(false);
    expect(await exists(path.join(staged, "bin", "tool"))).toBe(false);
    // The binary left out at listing and the note that grew.
    expect(skipped).toEqual({ "too-large": 2 });
  });

  test("a linked skill swapped while it is copied is refused once, not its left-out binary", async () => {
    const { home, dataDir, skills } = await emptyHome();
    const shared = path.join(home, ".agents", "skills");
    await skillWithBinary(path.join(shared, "linked"));
    await write(path.join(shared, "other", "SKILL.md"), "---\nname: other\n---\n");
    const link = path.join(skills, "linked");
    await fs.symlink(path.join(shared, "linked"), link);
    const { skipped, config } = await stageClaude(
      dataDir,
      home,
      {},
      {
        afterListing: async (source) => {
          if (path.basename(source) !== "linked") return;
          await fs.rm(link);
          await fs.symlink(path.join(shared, "other"), link);
        },
      },
    );
    expect(await exists(path.join(config, "skills", "linked"))).toBe(false);
    expect(skipped).toEqual({ "changed-while-reading": 1 });
  });
});

describe("non-skill units stay all-or-nothing", () => {
  test("a plugin directory holding an oversized file is refused whole", async () => {
    const { home, dataDir, skills } = await emptyHome();
    const plugin = path.join(home, ".claude", "plugins", "with-binary");
    await write(path.join(plugin, "plugin.json"), '{"name":"with-binary"}');
    await write(path.join(plugin, "bin", "tool"), "x".repeat(200));
    // The same layout as a skill is staged without its binary.
    await write(path.join(skills, "with-binary", "SKILL.md"), "---\nname: s\n---\n");
    await write(path.join(skills, "with-binary", "bin", "tool"), "x".repeat(200));
    const { skipped, config } = await stageClaude(dataDir, home, {});
    expect(await exists(path.join(config, "plugins", "with-binary"))).toBe(false);
    expect(await exists(path.join(config, "skills", "with-binary", "SKILL.md"))).toBe(true);
    expect(await exists(path.join(config, "skills", "with-binary", "bin", "tool"))).toBe(false);
    // One for the refused plugin, one for the skill's left-out binary.
    expect(skipped).toEqual({ "too-large": 2 });
  });
});
