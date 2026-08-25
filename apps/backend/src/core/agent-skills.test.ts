import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
    expect(isAgentSkillProvider("cursor")).toBe(true);
    expect(isAgentSkillProvider("grok")).toBe(true);
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
    expect(
      parseSkillFrontmatter("---\nname: alpha\ndescription: Does a thing\n---\n# Alpha"),
    ).toEqual({ name: "alpha", description: "Does a thing" });
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
    expect(parseSkillFrontmatter("---\nname: \"a: b\"\ndescription: 'x'\n---\n").name).toBe("a: b");
  });

  test("stops at the closing delimiter so the body cannot spoof a key", () => {
    expect(parseSkillFrontmatter("---\nname: real\n---\ndescription: from the body\n")).toEqual({
      name: "real",
    });
  });

  test("returns nothing when there is no frontmatter", () => {
    expect(parseSkillFrontmatter("# Just a heading\n")).toEqual({});
  });

  test("stops at a closing delimiter carrying trailing whitespace", () => {
    // Editors emit a trailing space and YAML allows it; an exact `=== "---"`
    // check walked past it and let the body overwrite the real keys.
    expect(parseSkillFrontmatter("---\nname: real\n--- \ndescription: from the body\n")).toEqual({
      name: "real",
    });
  });

  test("accepts a closing delimiter of ...", () => {
    expect(parseSkillFrontmatter("---\nname: real\n...\ndescription: from the body\n")).toEqual({
      name: "real",
    });
  });

  test("accepts an opening delimiter carrying trailing whitespace", () => {
    expect(parseSkillFrontmatter("--- \nname: real\n---\n")).toEqual({ name: "real" });
  });

  test("reports nothing when the frontmatter is never closed", () => {
    // With no boundary there is nothing to distinguish metadata from prose, so
    // the caller should fall back to the directory name instead.
    expect(parseSkillFrontmatter("---\nname: real\ndescription: also real\n")).toEqual({});
  });

  test("treats an empty frontmatter block as present but empty", () => {
    expect(parseSkillFrontmatter("---\n---\n# Body\n")).toEqual({});
  });

  test("reads CRLF files", () => {
    expect(parseSkillFrontmatter("---\r\nname: alpha\r\ndescription: d\r\n---\r\n# A\r\n")).toEqual(
      { name: "alpha", description: "d" },
    );
  });

  test("skips a byte-order mark", () => {
    expect(parseSkillFrontmatter("﻿---\nname: alpha\n---\n")).toEqual({ name: "alpha" });
  });

  test("handles every block scalar indicator", () => {
    for (const indicator of ["|", "|-", "|+", ">", ">-", "|2"]) {
      expect(
        parseSkillFrontmatter(`---\nname: a\ndescription: ${indicator}\n  one\n  two\n---\n`),
      ).toEqual({ name: "a", description: "one two" });
    }
  });

  test("ignores a key with no value", () => {
    expect(parseSkillFrontmatter("---\nname:\ndescription: d\n---\n")).toEqual({
      description: "d",
    });
  });

  test("ignores keys it does not care about", () => {
    expect(parseSkillFrontmatter("---\nlicense: MIT\nname: a\n---\n")).toEqual({ name: "a" });
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

  test("Cursor Agent reads personal, built-in, and compatibility skill roots", async () => {
    await writeSkill(join(home, ".cursor", "skills"), "from-cursor");
    await writeSkill(join(home, ".cursor", "skills-cursor"), "built-in");
    await writeSkill(join(home, ".agents", "skills"), "from-agents");
    await writeSkill(join(home, ".claude", "skills"), "from-claude");
    await writeSkill(join(home, ".codex", "skills"), "from-codex");

    const scan = await scanAgentSkills("cursor");

    expect(scan.skills.map((skill) => [skill.name, skill.scope])).toEqual([
      ["built-in", "system"],
      ["from-agents", "shared"],
      ["from-claude", "shared"],
      ["from-codex", "shared"],
      ["from-cursor", "user"],
    ]);
    expect(scan.roots.some((root) => root.label === "~/.cursor/skills")).toBe(true);
    expect(scan.roots.some((root) => root.label === "~/.cursor/skills-cursor")).toBe(true);
  });

  test("Grok Build reads ~/.grok/skills plus shared Claude and agent roots", async () => {
    await writeSkill(join(home, ".grok", "skills"), "from-grok");
    await writeSkill(join(home, ".agents", "skills"), "from-agents");
    await writeSkill(join(home, ".claude", "skills"), "from-claude");

    const scan = await scanAgentSkills("grok");

    expect(scan.skills.map((skill) => [skill.name, skill.scope])).toEqual([
      ["from-agents", "shared"],
      ["from-claude", "shared"],
      ["from-grok", "user"],
    ]);
    expect(scan.roots.some((root) => root.label === "~/.grok/skills")).toBe(true);
  });

  test("Pi reads its agent-directory skills plus the shared roots", async () => {
    await writeSkill(join(home, ".pi", "agent", "skills"), "from-pi");
    await writeSkill(join(home, ".pi", "skills"), "wrong-pi-root");
    await writeSkill(join(home, ".agents", "skills"), "from-agents");
    await writeSkill(join(home, ".claude", "skills"), "from-claude");

    const scan = await scanAgentSkills("pi");

    expect(scan.skills.map((skill) => [skill.name, skill.scope])).toEqual([
      ["from-agents", "shared"],
      ["from-claude", "shared"],
      ["from-pi", "user"],
    ]);
    expect(scan.roots.some((root) => root.label === "~/.pi/agent/skills")).toBe(true);
    expect(scan.roots.some((root) => root.label === "~/.pi/skills")).toBe(false);
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

  test("finds nested Codex skills, which Codex loads at any depth", async () => {
    await writeSkill(join(home, ".agents", "skills", "team"), "review");

    const scan = await scanAgentSkills("codex");

    expect(scan.skills.map((skill) => [skill.name, skill.location])).toEqual([
      ["review", "~/.agents/skills/team/review"],
    ]);
  });

  test("does not descend beneath a Claude root, which Claude reads flat", async () => {
    await writeSkill(join(home, ".claude", "skills", "team"), "review");

    expect((await scanAgentSkills("claude")).skills).toEqual([]);
  });

  test("does not report a nested skill twice when its parent is also a skill", async () => {
    const parent = join(home, ".agents", "skills", "outer");
    await writeSkill(join(home, ".agents", "skills"), "outer");
    await writeSkill(parent, "inner");

    const scan = await scanAgentSkills("codex");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["inner", "outer"]);
    expect(scan.roots.find((root) => root.label === "~/.agents/skills")?.skillCount).toBe(2);
  });

  test("terminates on a symlink cycle inside a recursive root", async () => {
    const shared = join(home, ".agents", "skills");
    await writeSkill(shared, "looping");
    await symlink(shared, join(shared, "looping", "back"), "dir");

    const scan = await scanAgentSkills("codex");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["looping"]);
    expect(scan.errors).toEqual([]);
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

      expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name)).toEqual([
        "isolated-codex",
      ]);
      expect((await scanAgentSkills("opencode")).skills.map((skill) => skill.name)).toEqual([
        "isolated-opencode",
      ]);
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
      name: "my-plugin:plugin-skill",
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
    await writeFile(join(codex, "config.toml"), '[plugins."plugin@market"]\nenabled = true\n');

    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name)).toEqual([
      "newest-release",
    ]);
  });

  test("uses a prerelease when no release exists", async () => {
    const codex = join(home, ".codex");
    const plugin = join(codex, "plugins", "cache", "market", "plugin");
    await writeSkill(join(plugin, "1.9.0-beta.1", "skills"), "older-prerelease");
    await writeSkill(join(plugin, "2.0.0-beta.1", "skills"), "newer-prerelease");
    await writeSkill(join(plugin, "unknown", "skills"), "unknown-cache");
    await writeFile(join(codex, "config.toml"), '[plugins."plugin@market"]\nenabled = true\n');

    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name)).toEqual([
      "newer-prerelease",
    ]);
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
      await Promise.all(
        Array.from({ length: 501 }, async (_, skillIndex) => {
          const dir = join(root, `r${rootIndex}-skill-${String(skillIndex).padStart(3, "0")}`);
          await mkdir(dir);
          await writeFile(join(dir, "SKILL.md"), `# Skill ${rootIndex}-${skillIndex}\n`);
        }),
      );
    }
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: Object.fromEntries(
          roots
            .slice(1)
            .map((root, index) => [`plugin-${index}@market`, [{ installPath: join(root, "..") }]]),
        ),
      }),
    );

    const scan = await scanAgentSkills("claude");

    expect(scan.roots).toHaveLength(5);
    // `skillCount` reports what was actually listed, so the four roots that fill
    // the 2,000 cap show 500 each and the fifth — entirely dropped — shows none.
    expect(scan.roots.map((root) => root.skillCount)).toEqual([500, 500, 500, 500, 0]);
    expect(scan.skills).toHaveLength(2_000);
    // Every root held 501 entries and the last was cut off by the cap, so none
    // of them is reported as complete.
    expect(scan.roots.every((root) => root.truncated)).toBe(true);
  }, 20_000);

  test("a complete root is not reported as truncated", async () => {
    await writeSkill(join(home, ".claude", "skills"), "only-one");

    const scan = await scanAgentSkills("claude");

    expect(scan.roots.find((root) => root.exists)).toMatchObject({
      skillCount: 1,
      truncated: false,
    });
  });

  test("skill counts sum to the number of skills listed", async () => {
    const shared = join(home, ".agents", "skills");
    await writeSkill(shared, "dual");
    const claudeSkills = join(home, ".claude", "skills");
    await mkdir(claudeSkills, { recursive: true });
    await symlink(join(shared, "dual"), join(claudeSkills, "dual"), "dir");
    await writeSkill(claudeSkills, "solo");

    const scan = await scanAgentSkills("opencode");

    // The symlinked copy is deduped away, so the shared root must not still
    // claim it — a count that disagrees with the list beside it is a lie.
    expect(scan.roots.reduce((total, root) => total + root.skillCount, 0)).toBe(scan.skills.length);
  });

  test("caps a runaway description rather than returning the whole frontmatter", async () => {
    const dir = join(home, ".claude", "skills", "verbose");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: verbose\ndescription: ${"x".repeat(4_000)}\n---\n\n# Verbose\n`,
    );

    const scan = await scanAgentSkills("claude");

    expect(scan.skills[0]?.description).toHaveLength(512);
  });

  test("clamps a description without splitting an emoji", async () => {
    const dir = join(home, ".claude", "skills", "emoji");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: emoji\ndescription: ${"🚀".repeat(600)}\n---\n`,
    );

    const description = (await scanAgentSkills("claude")).skills[0]!.description;

    // 512 code points, each two UTF-16 units — and no lone surrogate at the end.
    expect(Array.from(description)).toHaveLength(512);
    expect(description.endsWith("🚀")).toBe(true);
  });

  test("a file where a skill root should be is absent, not an error", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "skills"), "not a directory");

    const scan = await scanAgentSkills("claude");

    expect(scan.skills).toEqual([]);
    expect(scan.errors).toEqual([]);
    expect(scan.roots.every((root) => !root.exists)).toBe(true);
  });

  test("shadowing is case-insensitive, matching how the agents resolve names", async () => {
    await writeSkill(join(home, ".claude", "skills"), "Dup");
    await writeSkill(join(home, ".agents", "skills"), "dup");

    const scan = await scanAgentSkills("opencode");

    expect(scan.skills.map((skill) => [skill.name, skill.shadowed])).toEqual([
      ["Dup", false],
      ["dup", true],
    ]);
  });

  test("a FIFO named SKILL.md is reported, not waited on", async () => {
    const dir = join(home, ".claude", "skills", "trap");
    await mkdir(dir, { recursive: true });
    if (spawnSync("mkfifo", [join(dir, "SKILL.md")]).status !== 0) return;
    await writeSkill(join(home, ".claude", "skills"), "real");

    // Opening a FIFO blocks until a writer appears; before this was guarded the
    // scan never resolved at all, so the assertion that matters is that we get
    // here with a result.
    const scan = await scanAgentSkills("claude");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["real"]);
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0]?.path).toBe("~/.claude/skills/trap/SKILL.md");
  });
});

describe("Codex plugin discovery", () => {
  let home: string;

  const writeSkill = async (dir: string, name: string) => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
  };

  const writeConfig = async (body: string) => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), body);
  };

  const cachedPlugin = (marketplace: string, plugin: string, version = "1.0.0") =>
    join(home, ".codex", "plugins", "cache", marketplace, plugin, version, "skills");

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ork-skills-codex-"));
    setAgentSkillsHomeForTesting(home);
  });

  afterEach(async () => {
    setAgentSkillsHomeForTesting(undefined);
    await rm(home, { recursive: true, force: true });
  });

  test("an enabled plugin is found despite TOML comments", async () => {
    await writeSkill(cachedPlugin("market", "noted"), "noted-skill");
    await writeConfig(
      [
        "# plugins the user has turned on",
        '[plugins."noted@market"] # from the marketplace',
        "enabled = true # keep this on",
        "",
      ].join("\n"),
    );

    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name)).toEqual([
      "noted-skill",
    ]);
  });

  test("reads the inline-table form of an enabled plugin", async () => {
    await writeSkill(cachedPlugin("market", "inline"), "inline-skill");
    await writeConfig('[plugins]\n"inline@market" = { enabled = true }\n');

    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name)).toEqual([
      "inline-skill",
    ]);
  });

  test("an inline table that is not enabled stays off", async () => {
    await writeSkill(cachedPlugin("market", "inline"), "inline-skill");
    await writeConfig('[plugins]\n"inline@market" = { enabled = false }\n');

    expect((await scanAgentSkills("codex")).skills).toEqual([]);
  });

  test("lists every enabled plugin, not just the first", async () => {
    await writeSkill(cachedPlugin("market", "one"), "one-skill");
    await writeSkill(cachedPlugin("market", "two"), "two-skill");
    await writeConfig(
      [
        '[plugins."one@market"]',
        "enabled = true",
        '[plugins."two@market"]',
        "enabled = true",
        "",
      ].join("\n"),
    );

    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name)).toEqual([
      "one-skill",
      "two-skill",
    ]);
  });

  test("enabled survives other keys between it and its table header", async () => {
    await writeSkill(cachedPlugin("market", "late"), "late-skill");
    await writeConfig('[plugins."late@market"]\nversion = "1.2.3"\nenabled = true\n');

    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name)).toEqual([
      "late-skill",
    ]);
  });

  test("a nested subtable does not enable its parent plugin", async () => {
    await writeSkill(cachedPlugin("market", "nested"), "nested-skill");
    await writeConfig('[plugins."nested@market".env]\nenabled = true\n');

    expect((await scanAgentSkills("codex")).skills).toEqual([]);
  });

  test("a plugin id that escapes the cache root is refused", async () => {
    // The id becomes a path segment, so `..` would not merely point the scan
    // elsewhere — it would add that directory to the roots `readAgentSkillFile`
    // accepts, widening this module's read allowlist from a config file.
    const outside = join(home, "outside", "x", "1.0.0", "skills");
    await writeSkill(outside, "loot");
    await writeConfig('[plugins."x@../../../outside"]\nenabled = true\n');

    const scan = await scanAgentSkills("codex");

    expect(scan.skills).toEqual([]);
    expect(scan.roots.every((root) => root.scope !== "plugin")).toBe(true);
    await expect(readAgentSkillFile("codex", join(outside, "loot", "SKILL.md"))).rejects.toThrow(
      /outside the agent skill directories/,
    );
  });

  test("a plugin id containing a separator is refused", async () => {
    await writeConfig('[plugins."x@market/nested"]\nenabled = true\n');

    const scan = await scanAgentSkills("codex");

    expect(scan.roots.every((root) => root.scope !== "plugin")).toBe(true);
  });

  test("prefers the numerically newer prerelease, not the lexically larger one", async () => {
    const plugin = join(home, ".codex", "plugins", "cache", "market", "plugin");
    await writeSkill(join(plugin, "2.0.0-beta.2", "skills"), "older-beta");
    await writeSkill(join(plugin, "2.0.0-beta.10", "skills"), "newer-beta");
    await writeConfig('[plugins."plugin@market"]\nenabled = true\n');

    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name)).toEqual([
      "newer-beta",
    ]);
  });

  test("understands v-prefixed and build-metadata cache directories", async () => {
    const plugin = join(home, ".codex", "plugins", "cache", "market", "plugin");
    await writeSkill(join(plugin, "v1.10.0+build.5", "skills"), "newest");
    await writeSkill(join(plugin, "v1.9.0", "skills"), "older");
    await writeConfig('[plugins."plugin@market"]\nenabled = true\n');

    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name)).toEqual(["newest"]);
  });

  test("picks deterministically between non-version cache markers", async () => {
    const plugin = join(home, ".codex", "plugins", "cache", "market", "plugin");
    await writeSkill(join(plugin, "local", "skills"), "local-cache");
    await writeSkill(join(plugin, "unknown", "skills"), "unknown-cache");
    await writeConfig('[plugins."plugin@market"]\nenabled = true\n');

    // Neither marker is a version, so the order is arbitrary — but it must be
    // stable, or the listed skill would change between scans.
    expect((await scanAgentSkills("codex")).skills.map((skill) => skill.name)).toEqual([
      "unknown-cache",
    ]);
  });

  test("an enabled plugin whose cache holds no directories is skipped", async () => {
    const plugin = join(home, ".codex", "plugins", "cache", "market", "plugin");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "notes.txt"), "only a file here");
    await writeConfig('[plugins."plugin@market"]\nenabled = true\n');

    const scan = await scanAgentSkills("codex");

    expect(scan.roots.every((root) => root.scope !== "plugin")).toBe(true);
  });
});

describe("Claude plugin discovery", () => {
  let home: string;

  const writeManifest = async (manifest: unknown) => {
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  };

  const writeSkill = async (dir: string, name: string) => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ork-skills-claude-plugins-"));
    setAgentSkillsHomeForTesting(home);
  });

  afterEach(async () => {
    setAgentSkillsHomeForTesting(undefined);
    await rm(home, { recursive: true, force: true });
  });

  test("uses only the first install of a plugin id", async () => {
    const first = join(home, "install-a");
    const second = join(home, "install-b");
    await writeSkill(join(first, "skills"), "from-first");
    await writeSkill(join(second, "skills"), "from-second");
    await writeManifest({
      plugins: { "dup@market": [{ installPath: first }, { installPath: second }] },
    });

    // Later entries are other scopes of the same plugin, not other plugins.
    expect((await scanAgentSkills("claude")).skills.map((skill) => skill.name)).toEqual([
      "dup:from-first",
    ]);
  });

  test("falls back to the whole key when it carries no marketplace", async () => {
    const installPath = join(home, "plain");
    await writeSkill(join(installPath, "skills"), "plain-skill");
    await writeManifest({ plugins: { "no-marketplace": [{ installPath }] } });

    expect((await scanAgentSkills("claude")).skills[0]).toMatchObject({
      plugin: "no-marketplace",
      scope: "plugin",
    });
  });

  test("splits a scoped plugin id at its marketplace, not at its scope", async () => {
    const installPath = join(home, "scoped");
    await writeSkill(join(installPath, "skills"), "review");
    await writeManifest({ plugins: { "@team/quality@official": [{ installPath }] } });

    // Splitting at the first `@` names every scoped plugin the empty string,
    // which then falls back to the whole id — marketplace suffix and all.
    expect((await scanAgentSkills("claude")).skills[0]).toMatchObject({
      name: "@team/quality:review",
      plugin: "@team/quality",
    });
  });

  test("namespaces a plugin skill so it does not shadow the personal one", async () => {
    const installPath = join(home, "install");
    await writeSkill(join(installPath, "skills"), "review");
    await writeSkill(join(home, ".claude", "skills"), "review");
    await writeManifest({ plugins: { "quality@market": [{ installPath }] } });

    // Claude addresses these as `review` and `quality:review`; both load, so
    // neither may be reported as shadowed by the other.
    expect(
      (await scanAgentSkills("claude")).skills.map((skill) => [skill.name, skill.shadowed]),
    ).toEqual([
      ["quality:review", false],
      ["review", false],
    ]);
  });

  test("refuses a relative installPath rather than resolving it against the cwd", async () => {
    await writeManifest({ plugins: { "rel@market": [{ installPath: "../../etc" }] } });

    const scan = await scanAgentSkills("claude");

    expect(scan.roots.every((root) => root.scope !== "plugin")).toBe(true);
  });

  test("ignores a manifest whose shape is wrong", async () => {
    await writeManifest([{ installPath: join(home, "nope") }]);

    expect((await scanAgentSkills("claude")).roots.every((root) => root.scope !== "plugin")).toBe(
      true,
    );
  });

  test("ignores invalid JSON without listing a plugin root", async () => {
    await writeSkill(join(home, ".claude", "skills"), "personal");
    await writeManifest("{invalid");

    const scan = await scanAgentSkills("claude");

    expect(scan.skills.map((skill) => skill.name)).toEqual(["personal"]);
    expect(scan.roots.every((root) => root.scope !== "plugin")).toBe(true);
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

    await expect(readAgentSkillFile("claude", join(home, "SKILL.md"))).rejects.toThrow(
      /outside the agent skill directories/,
    );
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

    await expect(readAgentSkillFile("claude", join(dir, "notes.md"))).rejects.toThrow(/SKILL\.md/);
  });

  test("refuses a relative path", async () => {
    await expect(readAgentSkillFile("claude", ".claude/skills/a/SKILL.md")).rejects.toThrow(
      /absolute/,
    );
  });

  test("a Codex-only root is not readable through the Claude provider", async () => {
    const dir = join(home, ".codex", "skills", "codex-only");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# Codex only\n");

    await expect(readAgentSkillFile("claude", join(dir, "SKILL.md"))).rejects.toThrow(
      /outside the agent skill directories/,
    );
    await expect(readAgentSkillFile("codex", join(dir, "SKILL.md"))).resolves.toMatchObject({
      content: "# Codex only\n",
    });
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
      await expect(readAgentSkillFile("codex", filePath)).resolves.toMatchObject({
        content: "# Custom Codex home\n",
      });
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
      await expect(readAgentSkillFile("opencode", filePath)).resolves.toMatchObject({
        content: "# Custom XDG home\n",
      });
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

  test("refuses a sibling directory that merely shares the root's prefix", async () => {
    const dir = join(home, ".claude", "skills-evil", "alpha");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "secret");

    // `~/.claude/skills-evil` starts with `~/.claude/skills`; only the trailing
    // separator in the prefix test keeps it out.
    await expect(readAgentSkillFile("claude", join(dir, "SKILL.md"))).rejects.toThrow(
      /outside the agent skill directories/,
    );
  });

  test("refuses a FIFO rather than blocking on it", async () => {
    const dir = join(home, ".claude", "skills", "trap");
    await mkdir(dir, { recursive: true });
    if (spawnSync("mkfifo", [join(dir, "SKILL.md")]).status !== 0) return;

    await expect(readAgentSkillFile("claude", join(dir, "SKILL.md"))).rejects.toThrow(
      /regular file/,
    );
  });

  test("refuses a directory named SKILL.md", async () => {
    const dir = join(home, ".claude", "skills", "odd", "SKILL.md");
    await mkdir(dir, { recursive: true });

    await expect(readAgentSkillFile("claude", dir)).rejects.toThrow(/regular file/);
  });

  test("returns the normalised path it actually read", async () => {
    const dir = join(home, ".claude", "skills", "alpha");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# Alpha\n");

    const file = await readAgentSkillFile("claude", join(dir, ".", "SKILL.md"));

    expect(file.path).toBe(join(dir, "SKILL.md"));
  });

  test("reads an empty skill file", async () => {
    const dir = join(home, ".claude", "skills", "empty");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "");

    await expect(readAgentSkillFile("claude", join(dir, "SKILL.md"))).resolves.toMatchObject({
      content: "",
      truncated: false,
    });
  });
});
