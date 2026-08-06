import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  displayPath,
  isAgentSkillProvider,
  parseSkillFrontmatter,
  readAgentSkillFile,
  scanAgentSkills,
  setAgentSkillsHomeForTesting,
} from "./agent-skills.js";

describe("agent skill helpers", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ork-skills-helpers-"));
    setAgentSkillsHomeForTesting(home);
  });

  afterEach(async () => {
    setAgentSkillsHomeForTesting(undefined);
    await rm(home, { recursive: true, force: true });
  });

  test("recognises only supported provider names", () => {
    expect(isAgentSkillProvider("claude")).toBe(true);
    expect(isAgentSkillProvider("codex")).toBe(true);
    expect(isAgentSkillProvider("opencode")).toBe(true);
    expect(isAgentSkillProvider("Claude")).toBe(false);
    expect(isAgentSkillProvider(1)).toBe(false);
    expect(isAgentSkillProvider(null)).toBe(false);
  });

  test("displays the synthetic home and its descendants without rewriting siblings", () => {
    expect(displayPath(home)).toBe("~");
    expect(displayPath(join(home, ".claude", "skills"))).toBe("~/.claude/skills");
    expect(displayPath(`${home}-sibling`)).toBe(`${home}-sibling`);
  });
});

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

  test("ignores dangling skill-directory symlinks", async () => {
    const root = join(home, ".claude", "skills");
    await mkdir(root, { recursive: true });
    await symlink(join(home, "missing-skill"), join(root, "dangling"), "dir");

    const scan = await scanAgentSkills("claude");

    expect(scan.skills).toEqual([]);
    expect(scan.errors).toEqual([]);
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
    expect(scan.roots.every((root) => root.path.startsWith(home))).toBe(true);
  });

  test("a synthetic home ignores ambient provider homes", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const previousXdgHome = process.env.XDG_CONFIG_HOME;
    const ambient = await mkdtemp(join(tmpdir(), "ork-skills-ambient-"));
    try {
      process.env.CODEX_HOME = join(ambient, "codex");
      process.env.XDG_CONFIG_HOME = join(ambient, "xdg");
      await writeSkill(join(ambient, "codex", "skills"), "ambient-codex");
      await writeSkill(join(ambient, "xdg", "opencode", "skills"), "ambient-opencode");
      await writeSkill(join(home, ".codex", "skills"), "isolated-codex");
      await writeSkill(join(home, ".config", "opencode", "skills"), "isolated-opencode");

      expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name))
        .toEqual(["isolated-codex"]);
      expect((await scanAgentSkills("opencode")).skills.map((skill) => skill.name))
        .toEqual(["isolated-opencode"]);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgHome;
      await rm(ambient, { recursive: true, force: true });
    }
  });

  test("reports roots and skill files that cannot be traversed or read", async () => {
    const claude = join(home, ".claude");
    await mkdir(claude, { recursive: true });
    const root = join(claude, "skills");
    await symlink(root, root, "dir");

    const rootScan = await scanAgentSkills("claude");
    expect(rootScan.errors).toHaveLength(1);
    expect(rootScan.errors[0]?.path).toBe("~/.claude/skills");

    await rm(root, { force: true });
    const skillDir = join(root, "unreadable");
    await mkdir(skillDir, { recursive: true });
    const file = join(skillDir, "SKILL.md");
    await symlink(file, file);

    const fileScan = await scanAgentSkills("claude");
    expect(fileScan.skills).toEqual([]);
    expect(fileScan.errors).toHaveLength(1);
    expect(fileScan.errors[0]?.path).toBe("~/.claude/skills/unreadable/SKILL.md");
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

  test("ignores malformed Claude plugin metadata", async () => {
    await writeSkill(join(home, ".claude", "skills"), "personal");
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { bad: [{ installPath: 42 }], alsoBad: "not-an-array" } }),
    );

    const scan = await scanAgentSkills("claude");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["personal"]);
    expect(scan.roots.every((root) => root.scope !== "plugin")).toBe(true);
  });

  test("ignores invalid Claude plugin JSON", async () => {
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), "{invalid");

    expect((await scanAgentSkills("claude")).skills).toEqual([]);
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

  test("chooses a release ahead of prerelease, local, and unknown plugin caches", async () => {
    const codex = join(home, ".codex");
    const plugin = join(codex, "plugins", "cache", "market", "plugin");
    await writeSkill(join(plugin, "1.9.0", "skills"), "older-release");
    await writeSkill(join(plugin, "2.0.0-beta.1", "skills"), "prerelease");
    await writeSkill(join(plugin, "2.0.0", "skills"), "newest-release");
    await writeSkill(join(plugin, "local", "skills"), "local-cache");
    await writeSkill(join(plugin, "unknown", "skills"), "unknown-cache");
    await writeFile(
      join(codex, "config.toml"),
      '[plugins."plugin@market"]\nenabled = true\n',
    );

    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name))
      .toEqual(["newest-release"]);
  });

  test("uses a prerelease when no release exists", async () => {
    const codex = join(home, ".codex");
    const plugin = join(codex, "plugins", "cache", "market", "plugin");
    await writeSkill(join(plugin, "1.9.0-beta.1", "skills"), "older-prerelease");
    await writeSkill(join(plugin, "2.0.0-beta.1", "skills"), "newer-prerelease");
    await writeSkill(join(plugin, "unknown", "skills"), "unknown-cache");
    await writeFile(
      join(codex, "config.toml"),
      '[plugins."plugin@market"]\nenabled = true\n',
    );

    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name))
      .toEqual(["newer-prerelease"]);
  });

  test("ignores malformed Codex plugin config and enabled plugins missing cache versions", async () => {
    const codex = join(home, ".codex");
    await writeSkill(join(codex, "skills"), "user-skill");
    await mkdir(codex, { recursive: true });
    await writeFile(
      join(codex, "config.toml"),
      [
        '[plugins."missing-at-sign"]',
        "enabled = true",
        '[plugins."bad@market"] trailing',
        "enabled = true",
        '[plugins."missing-cache@market"]',
        "enabled = true",
      ].join("\n"),
    );

    const scan = await scanAgentSkills("codex");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["user-skill"]);
    expect(scan.roots.every((root) => root.scope !== "plugin")).toBe(true);
  });

  test("bounds entries per root and total skills across plugin roots", async () => {
    const roots = [
      join(home, ".claude", "skills"),
      ...Array.from({ length: 4 }, (_, index) => join(home, `plugin-${index}`, "skills")),
    ];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex]!;
      await mkdir(root, { recursive: true });
      await Promise.all(Array.from({ length: 501 }, async (_, skillIndex) => {
        const dir = join(root, `r${rootIndex}-skill-${String(skillIndex).padStart(3, "0")}`);
        await mkdir(dir);
        await writeFile(join(dir, "SKILL.md"), `# Skill ${rootIndex}-${skillIndex}\n`);
      }));
    }
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: Object.fromEntries(roots.slice(1).map((root, index) => [
          `plugin-${index}@market`,
          [{ installPath: join(root, "..") }],
        ])),
      }),
    );

    const scan = await scanAgentSkills("claude");

    expect(scan.roots).toHaveLength(5);
    expect(scan.roots.map((root) => root.skillCount)).toEqual([500, 500, 500, 500, 500]);
    expect(scan.skills).toHaveLength(2_000);
  }, 20_000);
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

  test("reads at most one MiB and reports whether content was truncated", async () => {
    const dir = join(home, ".claude", "skills", "large");
    const filePath = join(dir, "SKILL.md");
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, Buffer.alloc(1024 * 1024, "a"));

    const exact = await readAgentSkillFile("claude", filePath);
    expect(Buffer.byteLength(exact.content)).toBe(1024 * 1024);
    expect(exact.truncated).toBe(false);

    await writeFile(filePath, Buffer.alloc(1024 * 1024 + 64, "b"));
    const oversized = await readAgentSkillFile("claude", filePath);
    expect(Buffer.byteLength(oversized.content)).toBe(1024 * 1024);
    expect(oversized.content.startsWith("bbbb")).toBe(true);
    expect(oversized.truncated).toBe(true);
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

  test("honours explicit CODEX_HOME outside the synthetic-home test mode", async () => {
    const previous = process.env.CODEX_HOME;
    const codex = join(home, "custom-codex");
    const filePath = join(codex, "skills", "custom", "SKILL.md");
    await mkdir(join(codex, "skills", "custom"), { recursive: true });
    await writeFile(filePath, "# Custom Codex home\n");
    try {
      setAgentSkillsHomeForTesting(undefined);
      process.env.CODEX_HOME = codex;
      await expect(readAgentSkillFile("codex", filePath))
        .resolves.toMatchObject({ content: "# Custom Codex home\n" });
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      setAgentSkillsHomeForTesting(home);
    }
  });

  test("honours XDG_CONFIG_HOME for OpenCode outside synthetic-home test mode", async () => {
    const previous = process.env.XDG_CONFIG_HOME;
    const xdg = join(home, "custom-xdg");
    const filePath = join(xdg, "opencode", "skills", "custom", "SKILL.md");
    await mkdir(join(xdg, "opencode", "skills", "custom"), { recursive: true });
    await writeFile(filePath, "# Custom XDG home\n");
    try {
      setAgentSkillsHomeForTesting(undefined);
      process.env.XDG_CONFIG_HOME = xdg;
      await expect(readAgentSkillFile("opencode", filePath))
        .resolves.toMatchObject({ content: "# Custom XDG home\n" });
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      setAgentSkillsHomeForTesting(home);
    }
  });

  test("surfaces a missing skill file read", async () => {
    const filePath = join(home, ".claude", "skills", "missing", "SKILL.md");

    await expect(readAgentSkillFile("claude", filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
