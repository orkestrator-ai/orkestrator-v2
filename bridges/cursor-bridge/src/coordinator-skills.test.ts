import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COORDINATOR_SKILLS_TOOL,
  discoverCoordinatorSkills,
  hostSkillCustomTools,
  readSkillFile,
} from "./coordinator-skills.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function skill(dir: string, name: string, description = `${name} skill`): string {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`,
  );
  return join(dir, name);
}

function fixture() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-coordinator-skills-")));
  const cwd = join(root, "checkout");
  const home = join(root, "home");
  skill(join(cwd, ".claude", "skills"), "release", "Project release");
  skill(join(cwd, ".cursor", "skills"), "lint");
  skill(join(home, ".cursor", "skills"), "notes");
  // A user skill with the project's name is shadowed by the project's.
  skill(join(home, ".agents", "skills"), "release", "User release");
  // Codex's bundled skills are not the user's.
  skill(join(home, ".codex", "skills"), "skill-creator");
  return { root, cwd, home };
}

describe("discoverCoordinatorSkills", () => {
  test("lists Cursor's skill directories, project first, without duplicates", () => {
    const { cwd, home } = fixture();
    const skills = discoverCoordinatorSkills(cwd, home);
    expect(skills.map((s) => `${s.scope}:${s.name}:${s.description}`)).toEqual([
      "project:lint:lint skill",
      "project:release:Project release",
      "user:notes:notes skill",
    ]);
  });

  test("a link to HOME, the root or a directory without SKILL.md is not a skill", () => {
    const { root, cwd, home } = fixture();
    writeFileSync(join(home, "SKILL.md"), "not a skill root\n");
    symlinkSync(home, join(cwd, ".claude", "skills", "home"));
    symlinkSync("/", join(cwd, ".claude", "skills", "slash"));
    mkdirSync(join(root, "secrets"));
    symlinkSync(join(root, "secrets"), join(cwd, ".claude", "skills", "secrets"));
    const names = discoverCoordinatorSkills(cwd, home).map((s) => s.name);
    expect(names).not.toContain("home");
    expect(names).not.toContain("slash");
    expect(names).not.toContain("secrets");
  });
});

describe("readSkillFile", () => {
  test("serves files inside the skill and nothing outside it", () => {
    const { root, cwd, home } = fixture();
    const release = discoverCoordinatorSkills(cwd, home).find((s) => s.name === "release")!;
    mkdirSync(join(release.dir, "references"));
    writeFileSync(join(release.dir, "references", "checklist.md"), "1. Tag\n");
    writeFileSync(join(root, "outside.txt"), "secret\n");
    symlinkSync(join(root, "outside.txt"), join(release.dir, "escape.txt"));

    expect(readSkillFile(release, undefined)).toMatchObject({ ok: true });
    expect(readSkillFile(release, "references/checklist.md")).toEqual({
      ok: true,
      text: "1. Tag\n",
    });
    expect(readSkillFile(release, "../../../outside.txt").ok).toBe(false);
    expect(readSkillFile(release, "escape.txt").ok).toBe(false);
    expect(readSkillFile(release, join(root, "outside.txt")).ok).toBe(false);
  });
});

describe("hostSkillCustomTools", () => {
  test("only a coordinator process hosts the tool", async () => {
    const { cwd, home } = fixture();
    expect(hostSkillCustomTools({}, cwd, home)).toBeUndefined();
    const hosted = hostSkillCustomTools(
      { ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only" },
      cwd,
      home,
    )!;
    const tool = hosted.customTools[COORDINATOR_SKILLS_TOOL]!;
    expect(tool.description).toContain("- release: Project release");
    const run = (args: unknown) =>
      tool.execute(args as never, {} as never) as Promise<{
        content: { text: string }[];
        isError?: true;
      }>;
    expect((await run({ name: "release" })).content[0]!.text).toContain("Body of release.");
    expect((await run({ name: "missing" })).isError).toBe(true);
    expect((await run({ name: "release", file: "../lint/SKILL.md" })).isError).toBe(true);
  });
});
