/**
 * The shared user skills root (`~/.agents/skills`) and skills linked into a
 * provider's skill root reach a container (to-do 2170): staged from a fixture
 * home, then imported by the entrypoint's own copy into a fixture container
 * home. Never reads the real `~/.agents`, `~/.claude`, `~/.grok` or `~/.pi`.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_CAPABILITIES,
  SHARED_SKILLS_STAGED_INPUTS_VERSION,
  imageCopiesSharedSkills,
} from "@orkestrator/protocol/image-manifest";
import * as dockerImage from "../src/core/docker-image";
import { environmentInputStatus } from "../src/core/portable-input-status";
import {
  INPUT_LIMITS,
  SHARED_SKILLS_INPUT,
  SHARED_SKILL_READERS,
  portableInputSpec,
  stagePortableInputs,
  withSharedSkillsInput,
  type ProviderInputSpec,
} from "../src/core/portable-inputs";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const ENTRYPOINT = path.join(import.meta.dir, "../../../docker/entrypoint.sh");

const cleanup: string[] = [];
afterEach(async () => {
  dockerImage.resetDockerTopologyCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function write(file: string, content = "x") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function listFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relative: string) => {
    const entries = await fs
      .readdir(path.join(directory, relative), { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk("");
  return out.sort();
}

const skill = (name: string) => `---\nname: ${name}\ndescription: Fixture ${name}\n---\nBody.\n`;

/**
 * A throwaway host home: shared skills, skills linked into provider roots
 * from allowed and disallowed places, and credentials that must stay out.
 */
async function sharedSkillsFixture() {
  const root = await fs.realpath(await tempDir("ork-inputs-shared-"));
  cleanup.push(root);
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const agents = path.join(home, ".agents", "skills");
  const claude = path.join(home, ".claude", "skills");
  const grok = path.join(home, ".grok", "skills");
  const pi = path.join(home, ".pi", "agent", "skills");

  // ~/.agents/skills itself: real skills, a nested skill group, a credential
  // inside a skill, and a link out of the root.
  await write(path.join(agents, "fixture-shared", "SKILL.md"), skill("fixture-shared"));
  await write(path.join(agents, "fixture-shared", "scripts", "run.sh"), "echo run\n");
  await write(path.join(agents, "fixture-shared", ".env"), "TOKEN=SENTINEL-SHARED-ENV");
  await write(path.join(agents, "group", "fixture-nested", "SKILL.md"), skill("fixture-nested"));
  await write(path.join(agents, "not-a-skill", "notes.md"), "No SKILL.md here.\n");
  await write(path.join(root, "outside", "fixture-outside", "SKILL.md"), "SENTINEL-OUTSIDE");
  await fs.symlink(path.join(root, "outside", "fixture-outside"), path.join(agents, "outside"));
  // A link inside the shared skill: never followed, whoever stages it.
  await write(path.join(root, "outside", "secret.txt"), "SENTINEL-OUTSIDE-FILE");
  await fs.symlink(
    path.join(root, "outside", "secret.txt"),
    path.join(agents, "fixture-shared", "escape.txt"),
  );

  // Claude: an `npx skills` link into ~/.agents/skills, one into a nested
  // skill, and links that must be refused.
  await write(path.join(claude, "fixture-claude", "SKILL.md"), skill("fixture-claude"));
  await fs.mkdir(claude, { recursive: true });
  await fs.symlink(path.join(agents, "fixture-shared"), path.join(claude, "fixture-shared"));
  await fs.symlink(
    path.join(agents, "group", "fixture-nested"),
    path.join(claude, "fixture-nested"),
  );
  // Outside every skill root, though it holds a SKILL.md.
  await write(path.join(home, "dev", "fixture-dev", "SKILL.md"), skill("fixture-dev"));
  await fs.symlink(path.join(home, "dev", "fixture-dev"), path.join(claude, "fixture-dev"));
  // Inside an allowed root, but not a skill.
  await fs.symlink(path.join(agents, "not-a-skill"), path.join(claude, "not-a-skill"));
  // A link to the SKILL.md file rather than a skill directory.
  await fs.symlink(
    path.join(agents, "fixture-shared", "SKILL.md"),
    path.join(claude, "fixture-file.md"),
  );
  // The allowed root itself, and the whole home.
  await fs.symlink(agents, path.join(claude, "all-shared"));
  await fs.symlink(home, path.join(claude, "home"));
  // Dangling.
  await fs.symlink(path.join(agents, "gone"), path.join(claude, "dangling"));
  // Provider credentials and state beside the skills.
  await write(path.join(home, ".claude", ".credentials.json"), "SENTINEL-CLAUDE-LOGIN");
  await write(path.join(home, ".claude", "history.jsonl"), "SENTINEL-HISTORY");
  await write(path.join(home, ".agents", "auth.json"), "SENTINEL-AGENTS-AUTH");

  // Grok links a skill that only Claude's root holds, and a shared skill
  // whose credentials must be withheld although Grok's own skills are not
  // credential-checked.
  await write(path.join(claude, "fixture-claude-only", "SKILL.md"), skill("fixture-claude-only"));
  await fs.mkdir(grok, { recursive: true });
  await fs.symlink(
    path.join(claude, "fixture-claude-only"),
    path.join(grok, "fixture-claude-only"),
  );
  await write(path.join(agents, "fixture-keyed", "SKILL.md"), skill("fixture-keyed"));
  await write(
    path.join(agents, "fixture-keyed", "config.json"),
    '{"api_key":"SENTINEL-KEY-5b0e9d3a7c12"}',
  );
  await fs.symlink(path.join(agents, "fixture-keyed"), path.join(grok, "fixture-keyed"));

  // Pi links a shared skill the same way.
  await fs.mkdir(pi, { recursive: true });
  await fs.symlink(path.join(agents, "fixture-shared"), path.join(pi, "fixture-shared"));

  return { root, home, dataDir, agents, claude, grok, pi };
}

async function stage(
  fixture: { dataDir: string; home: string },
  providers: ProviderInputSpec["provider"][],
  environmentId = "env-shared-skills",
) {
  return stagePortableInputs(fixture.dataDir, environmentId, new Set(providers), {
    home: fixture.home,
    agentTest: false,
  });
}

async function expectNoSentinels(directory: string) {
  for (const file of await listFiles(directory)) {
    const contents = (await fs.readFile(path.join(directory, file))).toString();
    expect(contents).not.toContain("SENTINEL");
  }
}

function entrypointHelpers(entrypoint: string): string {
  return [
    "log_progress",
    "agent_copy_warn",
    "report_agent_copy_skips",
    "agent_source_path_has_symlink",
    "agent_destination_path_has_symlink",
    "agent_input_stamp",
    "agent_input_source_readable",
    "agent_input_manifest",
    "agent_input_home_matches",
    "agent_input_forget_removed",
    "import_agent_input",
    "forget_unchanged_agent_login",
    "remember_agent_login",
    "copy_agent_file",
    "agent_input_directory_walk",
    "copy_agent_directory",
    "copy_agent_directory_entries",
  ]
    .map((name) => {
      const body = entrypoint.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
      if (!body) throw new Error(`Missing entrypoint helper: ${name}`);
      return body;
    })
    .join("\n");
}

/** The entrypoint's self-contained shared-skills block. */
function sharedSkillsBlock(entrypoint: string): string {
  const block = entrypoint.match(/^if \[ -d \/agents-skills \][^\n]*\n[\s\S]*?^fi$/m)?.[0];
  if (!block) throw new Error("Missing shared skills block in entrypoint.sh");
  return block;
}

/** Runs entrypoint fragments against staged mounts, as the container would. */
function runEntrypoint(
  script: string,
  options: { containerHome: string; root: string; relayDir?: string; env?: Record<string, string> },
) {
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", ["set -e", 'AGENT_COPY_SKIPPED=""', script].join("\n")],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: options.containerHome,
      PROGRESS_FILE: path.join(options.root, "progress"),
      STAGED_INPUT_RELAY_DIR: options.relayDir ?? path.join(options.root, "no-relay"),
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result;
}

describe("shared skills root (task 1)", () => {
  test("stages ~/.agents/skills once, per entry, for a provider that reads it", async () => {
    const fixture = await sharedSkillsFixture();
    const staged = await stage(fixture, ["codex", SHARED_SKILLS_INPUT]);
    const mount = staged.mounts.find((entry) => entry.target === "/agents-skills");
    expect(mount?.source).toBe(path.join(staged.directory, "agents-skills"));
    expect(await listFiles(mount!.source)).toEqual([
      "fixture-keyed/SKILL.md",
      "fixture-shared/SKILL.md",
      "fixture-shared/scripts/run.sh",
      "group/fixture-nested/SKILL.md",
      "not-a-skill/notes.md",
    ]);
    // The link out of the root and the link inside a skill are refused; the
    // skill's `.env` and the keyed skill's config are withheld.
    expect(staged.providers.find((entry) => entry.provider === SHARED_SKILLS_INPUT)).toEqual({
      provider: SHARED_SKILLS_INPUT,
      files: 5,
      bytes: expect.any(Number),
      skipped: { symlink: 2, "credential-withheld": 2 },
    });
    await expectNoSentinels(staged.directory);
    // Nothing beside the skills root (`~/.agents/auth.json`) is read.
    expect(
      (await listFiles(staged.directory)).filter((file) => file.includes("auth.json")),
    ).toEqual([]);
  });

  test("is added only for a reading provider on an image whose entrypoint copies it", () => {
    expect(SHARED_SKILL_READERS).not.toContain("claude");
    for (const reader of SHARED_SKILL_READERS) {
      expect(withSharedSkillsInput(new Set([reader, "git"] as const), true)).toEqual(
        new Set([reader, "git", SHARED_SKILLS_INPUT]),
      );
      expect(withSharedSkillsInput(new Set([reader]), false)).toEqual(new Set([reader]));
    }
    expect(withSharedSkillsInput(new Set(["claude", "git"] as const), true)).toEqual(
      new Set(["claude", "git"]),
    );
    expect(IMAGE_CAPABILITIES["staged-inputs"]).toBeGreaterThanOrEqual(
      SHARED_SKILLS_STAGED_INPUTS_VERSION,
    );
    expect(imageCopiesSharedSkills({ "staged-inputs": 3 })).toBe(false);
    expect(imageCopiesSharedSkills({ "staged-inputs": SHARED_SKILLS_STAGED_INPUTS_VERSION })).toBe(
      true,
    );
    expect(imageCopiesSharedSkills(null)).toBe(false);
  });

  test("the spec reads the shared root beside the home other platforms read", () => {
    const spec = portableInputSpec({ home: "/h", agentTest: false });
    const shared = spec.find((entry) => entry.provider === SHARED_SKILLS_INPUT)!;
    expect(shared.files).toEqual([]);
    expect(shared.directories).toEqual([
      {
        stage: "agents-skills",
        target: "/agents-skills",
        root: "/h/.agents/skills",
        directories: [{ path: ".", mode: "entries", withholdCredentials: true, skills: true }],
      },
    ]);
    // Agent-test profiles read user resources from the host home, like Pi's.
    const agentTest = portableInputSpec({
      home: "/profile",
      agentTest: true,
      agentTestHostHome: "/host",
    }).find((entry) => entry.provider === SHARED_SKILLS_INPUT)!;
    expect(agentTest.directories[0]?.root).toBe("/host/.agents/skills");
  });

  test("the entrypoint imports it into ~/.agents/skills, from the relay when node cannot read the mount", async () => {
    const fixture = await sharedSkillsFixture();
    const staged = await stage(fixture, ["opencode", SHARED_SKILLS_INPUT]);
    const entrypoint = await fs.readFile(ENTRYPOINT, "utf8");
    const block = sharedSkillsBlock(entrypoint);
    expect(entrypoint).toContain(
      `ORKESTRATOR_CAPABILITY staged-inputs=${IMAGE_CAPABILITIES["staged-inputs"]}`,
    );
    const source = staged.mounts.find((entry) => entry.target === "/agents-skills")!.source;

    // The block names the absolute mount; a relay directory standing in for
    // `/` lets the fixture play the relayed copy without touching `/`.
    const relayDir = path.join(fixture.root, "relay");
    await fs.mkdir(relayDir);
    await fs.cp(source, path.join(relayDir, "agents-skills"), { recursive: true });
    const containerHome = path.join(fixture.root, "container-home");
    const result = runEntrypoint([entrypointHelpers(entrypoint), block].join("\n"), {
      containerHome,
      root: fixture.root,
      relayDir,
    });
    expect(await listFiles(path.join(containerHome, ".agents", "skills"))).toEqual([
      "fixture-keyed/SKILL.md",
      "fixture-shared/SKILL.md",
      "fixture-shared/scripts/run.sh",
      "group/fixture-nested/SKILL.md",
      "not-a-skill/notes.md",
    ]);
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain("SENTINEL");
    await expectNoSentinels(containerHome);

    // Without the mount (an environment with no reader) nothing is created.
    const emptyHome = path.join(fixture.root, "empty-home");
    runEntrypoint([entrypointHelpers(entrypoint), block].join("\n"), {
      containerHome: emptyHome,
      root: fixture.root,
    });
    expect(
      await fs.lstat(path.join(emptyHome, ".agents")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("the entrypoint still skips a link that reaches the mount", async () => {
    const fixture = await sharedSkillsFixture();
    const entrypoint = await fs.readFile(ENTRYPOINT, "utf8");
    const relayDir = path.join(fixture.root, "relay");
    await write(path.join(relayDir, "agents-skills", "fixture-real", "SKILL.md"), skill("real"));
    await fs.symlink(
      path.join(fixture.root, "outside", "fixture-outside"),
      path.join(relayDir, "agents-skills", "planted"),
    );
    const containerHome = path.join(fixture.root, "container-home");
    runEntrypoint([entrypointHelpers(entrypoint), sharedSkillsBlock(entrypoint)].join("\n"), {
      containerHome,
      root: fixture.root,
      relayDir,
    });
    expect(await listFiles(path.join(containerHome, ".agents", "skills"))).toEqual([
      "fixture-real/SKILL.md",
    ]);
  });

  test("status never reports the shared skills as a disabled provider", async () => {
    const fixture = await sharedSkillsFixture();
    const environment = lifecycleEnvironment({ containerId: "existing" });
    const staged = await stagePortableInputs(
      fixture.dataDir,
      environment.id,
      new Set(["codex", SHARED_SKILLS_INPUT] as const),
      { home: fixture.home, agentTest: false },
    );
    const { context } = memoryLifecycleContext([environment], fixture.dataDir);
    Object.assign(context.storage, {
      loadConfig: async () => ({ global: { enabledAgentPlatforms: [] } }),
    });
    const capabilities = spyOn(dockerImage, "imageCapabilities").mockResolvedValue({
      "staged-inputs": IMAGE_CAPABILITIES["staged-inputs"],
    });
    try {
      await withDockerScript(
        `#!/bin/sh
case "$1" in
  info) echo '{"OSType":"linux","SecurityOptions":[]}' ;;
  inspect) echo '${staged.revision}' ;;
  *) exit 1 ;;
esac
`,
        async () => {
          const status = await environmentInputStatus(environment.id, context);
          expect(status.providers.map((entry) => entry.provider)).toContain(SHARED_SKILLS_INPUT);
          expect(status.disabledProviders).toEqual(["codex"]);
        },
      );
    } finally {
      capabilities.mockRestore();
    }
  });
});

describe("linked skill entries (task 2)", () => {
  test("stages a linked skill inside an allowed root as a real directory, and refuses every other link", async () => {
    const fixture = await sharedSkillsFixture();
    const staged = await stage(fixture, ["claude"]);
    const skills = path.join(staged.directory, "claude-config", "skills");
    expect(await listFiles(skills)).toEqual([
      "fixture-claude-only/SKILL.md",
      "fixture-claude/SKILL.md",
      "fixture-nested/SKILL.md",
      "fixture-shared/SKILL.md",
      "fixture-shared/scripts/run.sh",
    ]);
    for (const name of ["fixture-shared", "fixture-nested"]) {
      const info = await fs.lstat(path.join(skills, name));
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.isDirectory()).toBe(true);
    }
    expect(await fs.readFile(path.join(skills, "fixture-shared", "SKILL.md"), "utf8")).toBe(
      skill("fixture-shared"),
    );
    // Refused: outside every skill root (fixture-dev), no SKILL.md
    // (not-a-skill), a file (fixture-file.md), the root itself (all-shared),
    // the home, a dangling link, and the link inside the linked skill. The
    // linked skill's `.env` is withheld, though it sits in ~/.agents/skills.
    expect(staged.providers.find((entry) => entry.provider === "claude")?.skipped).toEqual({
      symlink: 7,
      "credential-withheld": 1,
    });
    // The fixture's Claude login holds no usable login, so it is withheld too.
    await expectNoSentinels(staged.directory);
    expect(
      (await listFiles(staged.directory)).filter(
        (file) => file.includes(".credentials") || file.includes("history"),
      ),
    ).toEqual([]);
  });

  test("a link into another provider's root is followed only when that provider is staged", async () => {
    const fixture = await sharedSkillsFixture();
    const grokOnly = await stage(fixture, ["grok"], "env-grok-only");
    expect(await listFiles(path.join(grokOnly.directory, "grok-home", "skills"))).toEqual([
      "fixture-keyed/SKILL.md",
    ]);
    // Grok's own skills are not credential-checked, but a linked skill is.
    expect(grokOnly.providers.find((entry) => entry.provider === "grok")?.skipped).toEqual({
      symlink: 1,
      "credential-withheld": 1,
    });

    const withClaude = await stage(fixture, ["grok", "claude"], "env-grok-claude");
    expect(await listFiles(path.join(withClaude.directory, "grok-home", "skills"))).toEqual([
      "fixture-claude-only/SKILL.md",
      "fixture-keyed/SKILL.md",
    ]);
    await expectNoSentinels(withClaude.directory);
  });

  test("Pi's linked shared skill is staged too", async () => {
    const fixture = await sharedSkillsFixture();
    const staged = await stage(fixture, ["pi"]);
    expect(await listFiles(path.join(staged.directory, "pi-config", "agent", "skills"))).toEqual([
      "fixture-shared/SKILL.md",
      "fixture-shared/scripts/run.sh",
    ]);
  });

  test("a skill root linked to the home is never an allowed target", async () => {
    const fixture = await sharedSkillsFixture();
    // A dotfiles mistake: ~/.agents/skills points at the home itself.
    await fs.rm(path.join(fixture.home, ".agents", "skills"), { recursive: true });
    await fs.symlink(fixture.home, path.join(fixture.home, ".agents", "skills"));
    await write(path.join(fixture.home, "fixture-home-skill", "SKILL.md"), "SENTINEL-HOME-SKILL");
    await fs.symlink(
      path.join(fixture.home, "fixture-home-skill"),
      path.join(fixture.claude, "fixture-home-skill"),
    );
    const staged = await stage(fixture, ["claude"]);
    expect(await listFiles(path.join(staged.directory, "claude-config", "skills"))).toEqual([
      "fixture-claude-only/SKILL.md",
      "fixture-claude/SKILL.md",
    ]);
    await expectNoSentinels(staged.directory);
  });

  test("a link inside the shared root to another place in it is staged as a skill", async () => {
    const fixture = await sharedSkillsFixture();
    await fs.symlink(
      path.join(fixture.agents, "group", "fixture-nested"),
      path.join(fixture.agents, "fixture-alias"),
    );
    const staged = await stage(fixture, ["codex", SHARED_SKILLS_INPUT]);
    expect(await listFiles(path.join(staged.directory, "agents-skills"))).toContain(
      "fixture-alias/SKILL.md",
    );
  });

  test("the entrypoint imports a linked skill where Claude reads user skills", async () => {
    const fixture = await sharedSkillsFixture();
    const staged = await stage(fixture, ["claude"]);
    const entrypoint = await fs.readFile(ENTRYPOINT, "utf8");
    const loop = entrypoint.match(
      /^ {4}for dir in \\\n(?: {8}[\w./-]+(?: \\)?\n)+ {4}do\n {8}import_agent_input copy_agent_directory_entries \/claude-config "\$HOME\/\.claude" "\$dir" Claude\n {4}done$/m,
    )?.[0];
    if (!loop) throw new Error("Missing Claude directory loop in entrypoint.sh");
    const containerHome = path.join(fixture.root, "container-home");
    runEntrypoint(
      [entrypointHelpers(entrypoint), loop.replaceAll("/claude-config", '"$CLAUDE_SOURCE"')].join(
        "\n",
      ),
      {
        containerHome,
        root: fixture.root,
        env: { CLAUDE_SOURCE: path.join(staged.directory, "claude-config") },
      },
    );
    expect(await listFiles(path.join(containerHome, ".claude", "skills"))).toEqual([
      "fixture-claude-only/SKILL.md",
      "fixture-claude/SKILL.md",
      "fixture-nested/SKILL.md",
      "fixture-shared/SKILL.md",
      "fixture-shared/scripts/run.sh",
    ]);
    await expectNoSentinels(containerHome);
  });
});

describe("review security regressions", () => {
  for (const unsafe of ["home", "root", "ancestor", "profile"]) {
    test(`shared source refuses ${unsafe}`, async () => {
      const f = await sharedSkillsFixture();
      const profile = path.join(f.root, "profile");
      await fs.mkdir(profile);
      await fs.rm(f.agents, { recursive: true });
      const target =
        unsafe === "home"
          ? f.home
          : unsafe === "root"
            ? path.parse(f.home).root
            : unsafe === "profile"
              ? profile
              : f.root;
      await fs.symlink(target, f.agents);
      const staged = await stagePortableInputs(
        f.dataDir,
        "unsafe",
        new Set([SHARED_SKILLS_INPUT]),
        {
          home: profile,
          agentTest: true,
          agentTestHostHome: f.home,
        },
      );
      expect(staged.mounts).toEqual([]);
      expect(staged.providers[0]?.files).toBe(0);
      expect(staged.providers[0]?.skipped.symlink).toBe(1);
    });
  }

  test("safe relocated shared roots still stage", async () => {
    const f = await sharedSkillsFixture();
    const relocated = path.join(f.root, "dotfiles-skills");
    await fs.rename(f.agents, relocated);
    await fs.symlink(relocated, f.agents);
    const staged = await stage(f, [SHARED_SKILLS_INPUT]);
    expect(await listFiles(path.join(staged.directory, "agents-skills"))).toContain(
      "fixture-shared/SKILL.md",
    );
  });

  test("a benign alias cannot hide sensitive source ancestry", async () => {
    const f = await sharedSkillsFixture();
    for (const sensitive of ["credentials", "secrets", "tokens", ".ssh"]) {
      const target = path.join(f.agents, sensitive, "skill");
      await write(path.join(target, "SKILL.md"), skill("sensitive"));
      await write(path.join(target, "data.txt"), "SENTINEL-OPAQUE");
      await fs.symlink(target, path.join(f.claude, `helper-${sensitive}`));
    }
    const staged = await stage(f, ["claude"]);
    expect(staged.providers[0]?.skipped["credential-withheld"]).toBe(5);
    expect((await listFiles(staged.directory)).some((file) => file.includes("helper-"))).toBe(
      false,
    );
    await expectNoSentinels(staged.directory);
  });

  for (const swap of ["inode", "ancestry"]) {
    test(`mid-copy ${swap} swap discards the skill without consuming sibling budget`, async () => {
      const f = await sharedSkillsFixture();
      const parent = path.join(f.agents, "race-parent");
      const target = path.join(parent, "race");
      await write(path.join(target, "SKILL.md"), "race");
      const codex = path.join(f.home, ".codex", "skills");
      await fs.mkdir(codex, { recursive: true });
      await fs.symlink(target, path.join(codex, "a-race"));
      await write(path.join(codex, "z-sibling", "SKILL.md"), "ok");
      const original = fsPromises.lstat;
      let targetReads = 0;
      let swapped = false;
      const hook = spyOn(fsPromises, "lstat").mockImplementation((async (
        ...args: Parameters<typeof original>
      ) => {
        if (args[0] === target && ++targetReads === 3) {
          // before, initial ancestry, then post-copy identity check.
          const moved = `${swap === "inode" ? target : parent}-old`;
          await fs.rename(swap === "inode" ? target : parent, moved);
          if (swap === "inode") await write(path.join(target, "SKILL.md"), "replacement");
          else await fs.symlink(moved, parent);
          swapped = true;
        }
        return original(...args);
      }) as typeof original);
      let staged;
      try {
        staged = await stagePortableInputs(
          f.dataDir,
          "race",
          new Set(["codex"]),
          { home: f.home, agentTest: false },
          new Date(),
          {
            ...INPUT_LIMITS,
            totalEntries: 1,
            totalBytes: 4,
          },
        );
      } finally {
        hook.mockRestore();
      }
      expect(swapped).toBe(true);
      await expect(
        fs.lstat(path.join(staged.directory, "codex-home", "skills", "a-race")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await listFiles(path.join(staged.directory, "codex-home", "skills"))).toEqual([
        "z-sibling/SKILL.md",
      ]);
      expect(staged.providers[0]).toMatchObject({
        files: 1,
        bytes: 2,
        skipped: { "changed-while-reading": 1 },
      });
    });
  }

  test("Codex materializes cross-provider links and imports siblings per entry", async () => {
    const f = await sharedSkillsFixture();
    const codex = path.join(f.home, ".codex", "skills");
    await fs.mkdir(codex, { recursive: true });
    await write(path.join(f.grok, "grok-only", "SKILL.md"), "grok");
    await fs.symlink(path.join(f.grok, "grok-only"), path.join(codex, "alias"));
    await fs.symlink(f.home, path.join(codex, "rejected"));
    await write(path.join(codex, "oversized", "SKILL.md"), "x".repeat(200));
    await write(path.join(codex, "sibling", "SKILL.md"), "ok");
    const staged = await stagePortableInputs(
      f.dataDir,
      "codex-links",
      new Set(["codex", "grok"]),
      { home: f.home, agentTest: false },
      new Date(),
      { ...INPUT_LIMITS, fileBytes: 100 },
    );
    const entrypoint = await fs.readFile(ENTRYPOINT, "utf8");
    const copy = entrypoint
      .split("\n")
      .find((line) => line.includes("copy_agent_directory_entries /codex-home"))!;
    expect(copy).toBeDefined();
    // Exercise the entrypoint boundary independently of backend rejection.
    await write(
      path.join(staged.directory, "codex-home", "skills", "too-big.txt"),
      "x".repeat(200),
    );
    await fs.symlink(f.home, path.join(staged.directory, "codex-home", "skills", "planted"));
    const containerHome = path.join(f.root, "container-home");
    runEntrypoint(
      [entrypointHelpers(entrypoint), copy.replaceAll("/codex-home", '"$CODEX_SOURCE"')].join("\n"),
      {
        containerHome,
        root: f.root,
        env: {
          CODEX_SOURCE: path.join(staged.directory, "codex-home"),
          AGENT_COPY_MAX_FILE_BYTES: "100",
        },
      },
    );
    expect(await listFiles(path.join(containerHome, ".codex", "skills"))).toEqual([
      "alias/SKILL.md",
      "sibling/SKILL.md",
    ]);
    expect(staged.providers.find((p) => p.provider === "codex")?.skipped).toMatchObject({
      symlink: 1,
      "too-large": 1,
    });
  });
});
