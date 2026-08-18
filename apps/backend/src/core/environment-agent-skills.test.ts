import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENVIRONMENT_AGENT_SKILLS_SCRIPT } from "./environment-agent-skills.js";
import { scanAgentSkills, setAgentSkillsHomeForTesting } from "./agent-skills.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function runScanner(
  cwd: string,
  provider: string,
  operation: string,
  filePath = "",
  options: { env?: Record<string, string | undefined>; stdin?: string } = {},
) {
  return Bun.spawnSync({
    cmd: [process.execPath, "-e", ENVIRONMENT_AGENT_SKILLS_SCRIPT, provider, operation, filePath],
    cwd,
    env: {
      ...process.env,
      HOME: path.join(cwd, ".test-home"),
      CODEX_HOME: path.join(cwd, ".test-codex"),
      XDG_CONFIG_HOME: path.join(cwd, ".test-config"),
      ...options.env,
    },
    stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function createTemporaryDirectory(prefix: string) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(temporary);
  return fs.realpath(temporary);
}

async function createWorktree() {
  const worktree = await createTemporaryDirectory("ork-environment-skills-");
  await fs.mkdir(path.join(worktree, ".git"));
  return worktree;
}

describe("environment agent skills scanner", () => {
  test("lists and reads a project skill from inside the environment", async () => {
    const worktree = await createWorktree();
    const skillDirectory = path.join(worktree, ".codex", "skills", "review");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(
      skillPath,
      "---\nname: review\ndescription: Review this environment\n---\n\n# Review\n",
    );

    const listed = runScanner(worktree, "codex", "list");
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ name: string; filePath: string; scope: string }>;
    };
    expect(scan.skills).toContainEqual(
      expect.objectContaining({
        name: "review",
        filePath: skillPath,
        scope: "project",
      }),
    );

    const read = runScanner(worktree, "codex", "read", skillPath);
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout.toString())).toMatchObject({
      path: skillPath,
      content: expect.stringContaining("# Review"),
      truncated: false,
    });
  });

  test("lists Cursor Agent project skills from .cursor/skills", async () => {
    const worktree = await createWorktree();
    const skillDirectory = path.join(worktree, ".cursor", "skills", "review");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(skillPath, "---\nname: review\n---\n\n# Review\n");

    const listed = runScanner(worktree, "cursor", "list");
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ name: string; filePath: string; scope: string }>;
    };
    expect(scan.skills).toContainEqual(
      expect.objectContaining({
        name: "review",
        filePath: skillPath,
        scope: "project",
      }),
    );
  });

  test("lists Grok Build project skills from .grok/skills", async () => {
    const worktree = await createWorktree();
    const skillDirectory = path.join(worktree, ".grok", "skills", "review");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(skillPath, "---\nname: review\n---\n\n# Review\n");

    const listed = runScanner(worktree, "grok", "list");
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ name: string; filePath: string; scope: string }>;
    };
    expect(scan.skills).toContainEqual(
      expect.objectContaining({
        name: "review",
        filePath: skillPath,
        scope: "project",
      }),
    );
  });

  test("refuses reads outside the selected agent's skill roots", async () => {
    const worktree = await createWorktree();
    const outside = path.join(worktree, "outside", "SKILL.md");
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, "# Outside\n");

    const read = runScanner(worktree, "claude", "read", outside);
    expect(read.exitCode).toBe(1);
    expect(read.stderr.toString()).toContain("outside the environment's agent skill directories");
    expect(read.stdout.toString()).toBe("");
  });

  test("refuses a project SKILL.md symlink that escapes every trusted root", async () => {
    const worktree = await createWorktree();
    const outside = await createTemporaryDirectory("ork-environment-secret-");
    const skillDirectory = path.join(worktree, ".agents", "skills", "leak");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    const secretPath = path.join(outside, "secret.txt");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(secretPath, "private material\n");
    await fs.symlink(secretPath, skillPath);

    const listed = runScanner(worktree, "codex", "list");
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ filePath: string }>;
      errors: Array<{ message: string }>;
    };
    expect(scan.skills.some((skill) => skill.filePath === skillPath)).toBe(false);
    expect(scan.errors.some((error) => error.message.includes("outside trusted agent roots"))).toBe(
      true,
    );

    const read = runScanner(worktree, "codex", "read", skillPath);
    expect(read.exitCode).toBe(1);
    expect(read.stderr.toString()).toContain("outside trusted agent roots");
    expect(read.stdout.toString()).toBe("");
  });

  test("reports, rather than silently drops, a skill directory that escapes the trusted roots", async () => {
    const worktree = await createWorktree();
    const home = await createTemporaryDirectory("ork-environment-home-");
    const outside = await createTemporaryDirectory("ork-environment-dotfiles-");
    const target = path.join(outside, "skills", "from-dotfiles");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "SKILL.md"), "---\nname: from-dotfiles\n---\n# Outside\n");
    const userRoot = path.join(home, ".claude", "skills");
    await fs.mkdir(path.join(userRoot, "kept"), { recursive: true });
    await fs.writeFile(path.join(userRoot, "kept", "SKILL.md"), "---\nname: kept\n---\n# Kept\n");
    // A directory symlink out of a root takes a different branch to a symlinked
    // SKILL.md, and used to be dropped with nothing said — leaving the pane
    // claiming a confident count while omitting a skill the agent does load.
    await fs.symlink(target, path.join(userRoot, "escaping"), "dir");
    // An ordinary symlink that is not a skill must stay quiet, or the real
    // refusals drown in noise.
    await fs.mkdir(path.join(outside, "notes"), { recursive: true });
    await fs.symlink(path.join(outside, "notes"), path.join(userRoot, "notes"), "dir");

    const listed = runScanner(worktree, "claude", "list", "", { env: { HOME: home } });
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ name: string }>;
      errors: Array<{ path: string; message: string }>;
    };

    expect(scan.skills.map((skill) => skill.name)).toEqual(["kept"]);
    expect(scan.errors).toEqual([
      {
        path: path.join("~", ".claude", "skills", "escaping", "SKILL.md"),
        message: "Refusing a skill directory that resolves outside trusted agent roots",
      },
    ]);
  });

  test("bounds the error list instead of returning one entry per refused path", async () => {
    const worktree = await createWorktree();
    const home = await createTemporaryDirectory("ork-environment-home-");
    const outside = await createTemporaryDirectory("ork-environment-dotfiles-");
    const target = path.join(outside, "skill");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "SKILL.md"), "---\nname: outside\n---\n# Outside\n");
    const userRoot = path.join(home, ".claude", "skills");
    await fs.mkdir(userRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        fs.symlink(
          target,
          path.join(userRoot, `escaping-${String(index).padStart(3, "0")}`),
          "dir",
        ),
      ),
    );

    const listed = runScanner(worktree, "claude", "list", "", { env: { HOME: home } });
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      errors: Array<{ path: string; message: string }>;
    };

    // 100 refusals plus the entry that says how many more there were.
    expect(scan.errors).toHaveLength(101);
    expect(scan.errors.at(-1)).toEqual({
      path: "…",
      message: "20 further paths could not be read or were refused",
    });
  });

  test("reports a missing root as absent, which Bun's lazy opendir hid", async () => {
    const worktree = await createWorktree();
    const home = await createTemporaryDirectory("ork-environment-home-");
    const projectRoot = path.join(worktree, ".claude", "skills");
    await fs.mkdir(projectRoot, { recursive: true });

    const listed = runScanner(worktree, "claude", "list", "", { env: { HOME: home } });
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      roots: Array<{ path: string; exists: boolean }>;
    };

    // Local environments run this under Bun, whose `opendir` resolves for a
    // directory that is not there; the container runs it under Node, which does
    // not. Both must report the same thing.
    expect(
      scan.roots.find((root) => root.path === path.join(home, ".claude", "skills"))?.exists,
    ).toBe(false);
    expect(scan.roots.find((root) => root.path === projectRoot)?.exists).toBe(true);
  });

  test("names skills exactly as the host scanner does for the same home", async () => {
    const worktree = await createWorktree();
    const home = await createTemporaryDirectory("ork-environment-home-");
    const install = path.join(home, "plugin-install");
    for (const skillPath of [
      path.join(install, "skills", "review", "SKILL.md"),
      path.join(home, ".claude", "skills", "review", "SKILL.md"),
    ]) {
      await fs.mkdir(path.dirname(skillPath), { recursive: true });
      await fs.writeFile(skillPath, "---\nname: review\n---\n# Review\n");
    }
    const manifest = path.join(home, ".claude", "plugins", "installed_plugins.json");
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(
      manifest,
      JSON.stringify({
        plugins: { "@team/quality@official": [{ installPath: install }] },
      }),
    );

    const listed = runScanner(worktree, "claude", "list", "", { env: { HOME: home } });
    expect(listed.exitCode).toBe(0);
    const scanned = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ name: string; filePath: string }>;
    };

    setAgentSkillsHomeForTesting(home);
    let hostNames: string[];
    try {
      hostNames = (await scanAgentSkills("claude")).skills
        .filter((skill) => skill.filePath.startsWith(home))
        .map((skill) => skill.name);
    } finally {
      setAgentSkillsHomeForTesting(undefined);
    }

    // The two scanners are separate implementations of one catalogue — the
    // settings pane and the environment pane must not disagree about what the
    // same machine's skills are called.
    expect(
      scanned.skills.filter((skill) => skill.filePath.startsWith(home)).map((skill) => skill.name),
    ).toEqual(hostNames);
    expect(hostNames).toEqual(["@team/quality:review", "review"]);
  });

  test("allows a project skill symlink into another enumerated Codex root", async () => {
    const worktree = await createWorktree();
    const codexHome = await createTemporaryDirectory("ork-environment-codex-");
    const sharedSkill = path.join(codexHome, "skills", "shared", "SKILL.md");
    await fs.mkdir(path.dirname(sharedSkill), { recursive: true });
    await fs.writeFile(sharedSkill, "---\nname: shared\n---\n# Shared\n");
    const projectSkillDirectory = path.join(worktree, ".agents", "skills", "shared");
    await fs.mkdir(path.dirname(projectSkillDirectory), { recursive: true });
    await fs.symlink(path.dirname(sharedSkill), projectSkillDirectory, "dir");

    const listed = runScanner(worktree, "codex", "list", "", {
      env: { CODEX_HOME: codexHome },
    });
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ filePath: string }>;
    };
    expect(
      scan.skills.some((skill) => skill.filePath === path.join(projectSkillDirectory, "SKILL.md")),
    ).toBe(true);
  });

  test("recursively discovers nested Codex skills", async () => {
    const worktree = await createWorktree();
    const skillPath = path.join(worktree, ".agents", "skills", "team", "review", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, "---\nname: nested-review\n---\n# Nested\n");

    const listed = runScanner(worktree, "codex", "list");
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ name: string; filePath: string }>;
    };
    expect(scan.skills).toContainEqual(
      expect.objectContaining({
        name: "nested-review",
        filePath: skillPath,
      }),
    );
  });

  test("uses Claude managed/user/project precedence and namespaces plugin skills", async () => {
    const worktree = await createWorktree();
    const home = await createTemporaryDirectory("ork-environment-home-");
    const plugin = await createTemporaryDirectory("ork-environment-plugin-");
    const userSkill = path.join(home, ".claude", "skills", "review", "SKILL.md");
    const projectSkill = path.join(worktree, ".claude", "skills", "review", "SKILL.md");
    const pluginSkill = path.join(plugin, "skills", "review", "SKILL.md");
    for (const skillPath of [userSkill, projectSkill, pluginSkill]) {
      await fs.mkdir(path.dirname(skillPath), { recursive: true });
      await fs.writeFile(skillPath, "---\nname: review\n---\n# Review\n");
    }
    const manifest = path.join(home, ".claude", "plugins", "installed_plugins.json");
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(
      manifest,
      JSON.stringify({
        plugins: { "@team/quality@official": [{ installPath: plugin }] },
      }),
    );

    const listed = runScanner(worktree, "claude", "list", "", { env: { HOME: home } });
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ name: string; filePath: string; shadowed: boolean }>;
    };
    expect(scan.skills).toContainEqual(
      expect.objectContaining({
        name: "review",
        filePath: userSkill,
        shadowed: false,
      }),
    );
    expect(scan.skills).toContainEqual(
      expect.objectContaining({
        name: "review",
        filePath: projectSkill,
        shadowed: true,
      }),
    );
    expect(scan.skills).toContainEqual(
      expect.objectContaining({
        name: "@team/quality:review",
        filePath: pluginSkill,
        shadowed: false,
      }),
    );
  });

  test("parses inline Codex plugin config and prefers the newest stable cache", async () => {
    const worktree = await createWorktree();
    const codexHome = await createTemporaryDirectory("ork-environment-codex-");
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      '[plugins]\n"review@official" = { enabled = true }\n',
    );
    for (const version of ["unknown", "2.0.0-beta.1", "1.9.0", "2.0.0"]) {
      const skillPath = path.join(
        codexHome,
        "plugins",
        "cache",
        "official",
        "review",
        version,
        "skills",
        "review",
        "SKILL.md",
      );
      await fs.mkdir(path.dirname(skillPath), { recursive: true });
      await fs.writeFile(skillPath, `---\nname: review-${version}\n---\n# ${version}\n`);
    }

    const listed = runScanner(worktree, "codex", "list", "", {
      env: { CODEX_HOME: codexHome },
    });
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ name: string; filePath: string }>;
    };
    expect(scan.skills).toContainEqual(
      expect.objectContaining({
        name: "review-2.0.0",
        filePath: expect.stringContaining(`${path.sep}2.0.0${path.sep}`),
      }),
    );
    expect(scan.skills.some((skill) => skill.name.includes("unknown"))).toBe(false);
  });

  test("uses OpenCode's resolved catalogue for custom and URL-backed skill locations", async () => {
    const worktree = await createWorktree();
    const customRoot = await createTemporaryDirectory("ork-opencode-catalogue-");
    const skillPath = path.join(customRoot, "remote-review", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, "# Resolved remote skill\n");
    const stdin = JSON.stringify([
      {
        name: "remote-review",
        description: "Resolved by OpenCode",
        location: skillPath,
      },
    ]);

    const listed = runScanner(worktree, "opencode", "list", "", { stdin });
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout.toString()).skills).toContainEqual(
      expect.objectContaining({
        name: "remote-review",
        filePath: skillPath,
      }),
    );

    const read = runScanner(worktree, "opencode", "read", skillPath, { stdin });
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout.toString()).content).toContain("Resolved remote skill");
  });

  test("bounds root traversal and skill file reads", async () => {
    const worktree = await createWorktree();
    const root = path.join(worktree, ".codex", "skills");
    await fs.mkdir(root, { recursive: true });
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        fs.writeFile(path.join(root, `entry-${String(index).padStart(3, "0")}`), ""),
      ),
    );

    const listed = runScanner(worktree, "codex", "list");
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      roots: Array<{ path: string; truncated: boolean }>;
    };
    expect(scan.roots.find((entry) => entry.path === root)?.truncated).toBe(true);

    const largeSkill = path.join(root, "large", "SKILL.md");
    await fs.mkdir(path.dirname(largeSkill), { recursive: true });
    await fs.writeFile(largeSkill, Buffer.alloc(1024 * 1024 + 64, "x"));
    const read = runScanner(worktree, "codex", "read", largeSkill);
    expect(read.exitCode).toBe(0);
    const file = JSON.parse(read.stdout.toString()) as { content: string; truncated: boolean };
    expect(Buffer.byteLength(file.content)).toBe(1024 * 1024);
    expect(file.truncated).toBe(true);
  });
});
