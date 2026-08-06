import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillFrontmatter,
  readAgentSkillFile,
  scanAgentSkills,
  setAgentSkillsHomeForTesting,
} from "./agent-skills.js";

describe("parseSkillFrontmatter", () => {
  test("reads plain scalars", () => {
    expect(parseSkillFrontmatter("---\nname: alpha\ndescription: Does a thing\n---\n# Alpha"))
      .toEqual({ name: "alpha", description: "Does a thing" });
  });

  test("joins block scalars, which real skills use for multi-line trigger lists", () => {
    const head = [
      "---",
      "name: turborepo",
      "description: |",
      "  Build system guidance. Triggers on: turbo.json,",
      "  caching, remote cache.",
      "",
      "  Use when the user configures pipelines.",
      "metadata:",
      "  version: 2.10.1",
      "---",
      "",
      "# Turborepo",
    ].join("\n");

    expect(parseSkillFrontmatter(head)).toEqual({
      name: "turborepo",
      description:
        "Build system guidance. Triggers on: turbo.json, caching, remote cache. Use when the user configures pipelines.",
    });
  });

  test("strips surrounding quotes", () => {
    expect(parseSkillFrontmatter('---\nname: "a: b"\ndescription: \'x\'\n---\n').name).toBe("a: b");
  });

  test("stops at the closing delimiter so the body cannot spoof a key", () => {
    expect(parseSkillFrontmatter("---\nname: real\n---\ndescription: from the body\n"))
      .toEqual({ name: "real" });
  });

  test("returns nothing when there is no frontmatter", () => {
    expect(parseSkillFrontmatter("# Just a heading\n")).toEqual({});
  });
});

describe("scanAgentSkills", () => {
  let home: string;

  const writeSkill = async (dir: string, name: string, description = "d") => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    );
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ork-skills-"));
    setAgentSkillsHomeForTesting(home);
  });

  afterEach(async () => {
    setAgentSkillsHomeForTesting(undefined);
    await rm(home, { recursive: true, force: true });
  });

  test("lists Claude personal skills alphabetically with their location", async () => {
    const claudeSkills = join(home, ".claude", "skills");
    await writeSkill(claudeSkills, "zeta");
    await writeSkill(claudeSkills, "alpha", "First one");

    const scan = await scanAgentSkills("claude");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
    expect(scan.skills[0]).toMatchObject({
      name: "alpha",
      description: "First one",
      scope: "user",
      shadowed: false,
      location: "~/.claude/skills/alpha",
    });
    expect(scan.errors).toEqual([]);
  });

  test("follows symlinked skills, which is how shared ~/.agents skills reach Claude", async () => {
    const shared = join(home, ".agents", "skills");
    await writeSkill(shared, "shared-one");
    const claudeSkills = join(home, ".claude", "skills");
    await mkdir(claudeSkills, { recursive: true });
    await symlink(join(shared, "shared-one"), join(claudeSkills, "shared-one"), "dir");

    const scan = await scanAgentSkills("claude");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["shared-one"]);
    expect(scan.skills[0]?.location).toBe("~/.claude/skills/shared-one");
  });

  test("Codex reads ~/.agents/skills and its own system cache", async () => {
    await writeSkill(join(home, ".agents", "skills"), "from-agents");
    await writeSkill(join(home, ".codex", "skills", ".system"), "built-in");
    await writeSkill(join(home, ".codex", "skills"), "from-codex");

    const scan = await scanAgentSkills("codex");

    expect(scan.skills.map((skill) => [skill.name, skill.scope])).toEqual([
      ["built-in", "system"],
      ["from-agents", "shared"],
      ["from-codex", "user"],
    ]);
  });

  test("the Codex system cache is not also listed as a user skill named .system", async () => {
    await writeSkill(join(home, ".codex", "skills", ".system"), "built-in");

    const scan = await scanAgentSkills("codex");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["built-in"]);
  });

  test("collapses one file reachable through two OpenCode roots", async () => {
    const shared = join(home, ".agents", "skills");
    await writeSkill(shared, "dual");
    const claudeSkills = join(home, ".claude", "skills");
    await mkdir(claudeSkills, { recursive: true });
    await symlink(join(shared, "dual"), join(claudeSkills, "dual"), "dir");

    const scan = await scanAgentSkills("opencode");

    // OpenCode reads both roots, but they are the same SKILL.md.
    expect(scan.skills).toHaveLength(1);
    expect(scan.skills[0]?.location).toBe("~/.claude/skills/dual");
  });

  test("marks the lower-precedence copy of a duplicated name as shadowed", async () => {
    await writeSkill(join(home, ".claude", "skills"), "dup", "claude copy");
    await writeSkill(join(home, ".agents", "skills"), "dup", "agents copy");

    const scan = await scanAgentSkills("opencode");

    // `~/.claude/skills` outranks `~/.agents/skills` for OpenCode, and the copy
    // that actually loads is listed above the shadowed one.
    expect(scan.skills.map((skill) => [skill.location, skill.shadowed])).toEqual([
      ["~/.claude/skills/dup", false],
      ["~/.agents/skills/dup", true],
    ]);
  });

  test("ignores directories without a SKILL.md", async () => {
    await mkdir(join(home, ".claude", "skills", "not-a-skill"), { recursive: true });
    await writeSkill(join(home, ".claude", "skills"), "real");

    const scan = await scanAgentSkills("claude");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["real"]);
  });

  test("falls back to the directory name when frontmatter has no name", async () => {
    const dir = join(home, ".claude", "skills", "unnamed");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# No frontmatter here\n");

    const scan = await scanAgentSkills("claude");

    expect(scan.skills[0]).toMatchObject({ name: "unnamed", description: "" });
  });

  test("a missing root is reported as absent, not as an error", async () => {
    const scan = await scanAgentSkills("claude");

    expect(scan.skills).toEqual([]);
    expect(scan.errors).toEqual([]);
    expect(scan.roots.every((root) => !root.exists)).toBe(true);
    expect(scan.roots.some((root) => root.label === "~/.claude/skills")).toBe(true);
  });

  test("resolves Claude plugin roots from installed_plugins.json", async () => {
    const installPath = join(home, "plugin-install");
    await writeSkill(join(installPath, "skills"), "plugin-skill");
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "my-plugin@some-market": [{ installPath }] } }),
    );

    const scan = await scanAgentSkills("claude");

    expect(scan.skills[0]).toMatchObject({
      name: "plugin-skill",
      scope: "plugin",
      plugin: "my-plugin",
    });
  });

  test("only lists Codex plugins that config.toml marks enabled", async () => {
    const codex = join(home, ".codex");
    const cache = join(codex, "plugins", "cache", "market");
    await writeSkill(join(cache, "on-plugin", "1.0.0", "skills"), "enabled-skill");
    await writeSkill(join(cache, "off-plugin", "1.0.0", "skills"), "disabled-skill");
    await mkdir(codex, { recursive: true });
    await writeFile(
      join(codex, "config.toml"),
      [
        '[plugins."on-plugin@market"]',
        "enabled = true",
        "",
        '[plugins."off-plugin@market"]',
        "enabled = false",
        "",
      ].join("\n"),
    );

    const scan = await scanAgentSkills("codex");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["enabled-skill"]);
  });
});

describe("readAgentSkillFile", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ork-skills-read-"));
    setAgentSkillsHomeForTesting(home);
  });

  afterEach(async () => {
    setAgentSkillsHomeForTesting(undefined);
    await rm(home, { recursive: true, force: true });
  });

  test("returns the file contents verbatim", async () => {
    const dir = join(home, ".claude", "skills", "alpha");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: alpha\n---\n\n# Alpha\n");

    const file = await readAgentSkillFile("claude", join(dir, "SKILL.md"));

    expect(file.content).toContain("# Alpha");
    expect(file.truncated).toBe(false);
  });

  test("reads a skill that is a symlink out to ~/.agents", async () => {
    const shared = join(home, ".agents", "skills", "shared-one");
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, "SKILL.md"), "# Shared\n");
    const claudeSkills = join(home, ".claude", "skills");
    await mkdir(claudeSkills, { recursive: true });
    await symlink(shared, join(claudeSkills, "shared-one"), "dir");

    const file = await readAgentSkillFile("claude", join(claudeSkills, "shared-one", "SKILL.md"));

    expect(file.content).toContain("# Shared");
  });

  test("refuses a path outside the agent's skill roots", async () => {
    await writeFile(join(home, "SKILL.md"), "secret");

    await expect(readAgentSkillFile("claude", join(home, "SKILL.md")))
      .rejects.toThrow(/outside the agent skill directories/);
  });

  test("refuses to escape a skill root with ..", async () => {
    await writeFile(join(home, "SKILL.md"), "secret");

    await expect(
      readAgentSkillFile("claude", join(home, ".claude", "skills", "..", "..", "SKILL.md")),
    ).rejects.toThrow(/outside the agent skill directories/);
  });

  test("refuses a file that is not a SKILL.md", async () => {
    const dir = join(home, ".claude", "skills", "alpha");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes.md"), "hi");

    await expect(readAgentSkillFile("claude", join(dir, "notes.md")))
      .rejects.toThrow(/SKILL\.md/);
  });

  test("refuses a relative path", async () => {
    await expect(readAgentSkillFile("claude", ".claude/skills/a/SKILL.md"))
      .rejects.toThrow(/absolute/);
  });

  test("a Codex-only root is not readable through the Claude provider", async () => {
    const dir = join(home, ".codex", "skills", "codex-only");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# Codex only\n");

    await expect(readAgentSkillFile("claude", join(dir, "SKILL.md")))
      .rejects.toThrow(/outside the agent skill directories/);
    await expect(readAgentSkillFile("codex", join(dir, "SKILL.md")))
      .resolves.toMatchObject({ content: "# Codex only\n" });
  });
});
