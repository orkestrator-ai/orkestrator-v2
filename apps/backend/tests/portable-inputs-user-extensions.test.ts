/**
 * Claude's user skills (`~/.claude/skills`) and Grok's user commands
 * (`~/.grok/commands`) reach a container: staged from a fixture home, then
 * imported by the entrypoint's own copy loops into a fixture container home.
 * Never reads the real `~/.claude` or `~/.grok`.
 *
 * With GROK_CLI_PATH pointing at the pinned Grok CLI (`mise run download:grok`
 * or `bun scripts/download-agent.ts grok --dir <dir>`), the last test also
 * runs `grok inspect` in the imported home, which lists both without a login.
 * CLAUDE_CLI_PATH also exercises the SDK catalogue without a model turn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { INPUT_LIMITS, portableInputSpec, stagePortableInputs } from "../src/core/portable-inputs";
import { tempDir } from "./container-lifecycle-fixtures";

const ENTRYPOINT = path.join(import.meta.dir, "../../../docker/entrypoint.sh");

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function write(file: string, content = "x") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function listFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relative: string) => {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk("");
  return out.sort();
}

/** A fixture host home with user skills and commands, links and state that must stay out. */
async function extensionsFixture() {
  const root = await fs.realpath(await tempDir("ork-inputs-ext-"));
  cleanup.push(root);
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  await write(path.join(root, "outside", "secret.txt"), "SENTINEL-OUTSIDE");

  const claude = path.join(home, ".claude");
  await write(
    path.join(claude, "skills", "fixture-review", "SKILL.md"),
    "---\nname: fixture-review\ndescription: Fixture Claude skill\n---\nReview.\n",
  );
  await write(path.join(claude, "skills", "fixture-review", "scripts", "run.sh"), "echo run\n");
  // A link inside a skill is dropped; the rest of the skill still lands.
  await fs.symlink(
    path.join(root, "outside", "secret.txt"),
    path.join(claude, "skills", "fixture-review", "escape.txt"),
  );
  // A skill linked in from ~/.agents/skills (an `npx skills` install) is a
  // link, staged as a real directory (portable-inputs-shared-skills.test.ts).
  await write(
    path.join(home, ".agents", "skills", "fixture-shared", "SKILL.md"),
    "---\nname: fixture-shared\ndescription: Shared\n---\nShared.\n",
  );
  await fs.symlink(
    path.join(home, ".agents", "skills", "fixture-shared"),
    path.join(claude, "skills", "fixture-shared"),
  );
  await write(path.join(claude, "history.jsonl"), "SENTINEL-HISTORY");
  await write(path.join(claude, "projects", "p", "s.jsonl"), "SENTINEL-TRANSCRIPT");

  const grok = path.join(home, ".grok");
  await write(
    path.join(grok, "commands", "fixture-user-cmd.md"),
    "---\ndescription: Fixture Grok command\n---\nSay hi.\n",
  );
  await write(path.join(grok, "commands", "nested", "deeper.md"), "Nested.\n");
  await fs.symlink(
    path.join(root, "outside", "secret.txt"),
    path.join(grok, "commands", "escape.md"),
  );
  await write(
    path.join(grok, "skills", "fixture-grok-skill", "SKILL.md"),
    "---\nname: fixture-grok-skill\ndescription: Fixture Grok skill\n---\nBody.\n",
  );
  await write(path.join(grok, "sessions", "s", "session.json"), "SENTINEL-GROK-SESSION");
  await write(path.join(grok, "active_sessions.json"), "SENTINEL-GROK-ACTIVE");
  await write(path.join(grok, "logs", "grok.log"), "SENTINEL-GROK-LOG");

  return { root, home, dataDir };
}

/** The entrypoint's `for dir in …` loop that copies one agent's extension directories. */
function entrypointDirectoryLoop(entrypoint: string, mount: string, home: string, label: string) {
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(
    `^    for dir in \\\\\\n((?: {8}[\\w./-]+(?: \\\\)?\\n)+)    do\\n        import_agent_input copy_agent_directory_entries ${escaped(mount)} "\\$HOME/${escaped(home)}" "\\$dir" ${label}\\n    done$`,
    "m",
  );
  const match = pattern.exec(entrypoint);
  if (!match) throw new Error(`Missing ${label} directory loop in entrypoint.sh`);
  const names = match[1]!
    .split("\n")
    .map((line) => line.replace(/\\$/, "").trim())
    .filter(Boolean);
  return { names, loop: match[0] };
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

/** Stages Claude and Grok from the fixture and imports them as the entrypoint does. */
async function stageAndImport(prepare?: (home: string) => Promise<void>) {
  const fixture = await extensionsFixture();
  await prepare?.(fixture.home);
  const staged = await stagePortableInputs(
    fixture.dataDir,
    "env-user-extensions",
    new Set(["claude", "grok"] as const),
    { home: fixture.home, agentTest: false },
  );
  const entrypoint = await fs.readFile(ENTRYPOINT, "utf8");
  const claudeLoop = entrypointDirectoryLoop(entrypoint, "/claude-config", ".claude", "Claude");
  const grokLoop = entrypointDirectoryLoop(entrypoint, "/grok-home", ".grok", "Grok");
  const source = (target: string) => staged.mounts.find((mount) => mount.target === target)!.source;
  const containerHome = path.join(fixture.root, "container-home");
  const progress = path.join(fixture.root, "progress");
  const script = [
    "set -e",
    'AGENT_COPY_SKIPPED=""',
    entrypointHelpers(entrypoint),
    claudeLoop.loop.replaceAll("/claude-config", '"$CLAUDE_SOURCE"'),
    "report_agent_copy_skips Claude",
    grokLoop.loop.replaceAll("/grok-home", '"$GROK_SOURCE"'),
    "report_agent_copy_skips Grok",
  ].join("\n");
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", script],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: containerHome,
      PROGRESS_FILE: progress,
      STAGED_INPUT_RELAY_DIR: path.join(fixture.root, "no-relay"),
      CLAUDE_SOURCE: source("/claude-config"),
      GROK_SOURCE: source("/grok-home"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return { ...fixture, staged, containerHome, claudeLoop, grokLoop };
}

describe("user skills and commands in containers", () => {
  test("stages Claude's skills and Grok's commands, never other links or provider state", async () => {
    const { dataDir, home } = await extensionsFixture();
    const staged = await stagePortableInputs(
      dataDir,
      "env-user-extensions",
      new Set(["claude", "grok"] as const),
      { home, agentTest: false },
    );
    const files = await listFiles(staged.directory);
    expect(
      files.filter((file) => file.includes("/skills/") || file.includes("/commands/")),
    ).toEqual([
      "claude-config/skills/fixture-review/SKILL.md",
      "claude-config/skills/fixture-review/scripts/run.sh",
      "claude-config/skills/fixture-shared/SKILL.md",
      "grok-home/commands/fixture-user-cmd.md",
      "grok-home/commands/nested/deeper.md",
      "grok-home/skills/fixture-grok-skill/SKILL.md",
    ]);
    for (const file of files) {
      const content = await fs.readFile(path.join(staged.directory, file), "utf8");
      expect(content).not.toContain("SENTINEL");
    }
    // The link inside a skill (Claude) and the linked command (Grok) are
    // counted, never followed.
    expect(staged.providers.find((entry) => entry.provider === "claude")?.skipped).toEqual({
      symlink: 1,
    });
    expect(staged.providers.find((entry) => entry.provider === "grok")?.skipped).toEqual({
      symlink: 1,
    });

    // Neither is staged for an environment without the provider.
    const codexOnly = await stagePortableInputs(
      dataDir,
      "env-codex-only",
      new Set(["codex"] as const),
      { home, agentTest: false },
    );
    expect(
      (await listFiles(codexOnly.directory)).filter((file) => file !== "manifest.json"),
    ).toEqual([]);
  });

  test("withholds nested credentials before staging and import while preserving safe resources", async () => {
    const { staged, containerHome } = await stageAndImport(async (home) => {
      for (const bundle of [".claude/skills/fixture-review", ".grok/commands/nested"]) {
        for (const [name, contents] of [
          [".env", "DEPLOY_TOKEN=SENTINEL-ENV"],
          ["resources/.env.production", "SENTINEL-ENV-PROD"],
          ["resources/deploy.key", "SENTINEL-KEY"],
          ["resources/key-disguised.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nSENTINEL-PRIVATE"],
          ["resources/config.json", '{"api_key":"SENTINEL-API-7f3a9c21e0b4"}'],
          // A real key after an example in the same file is still found.
          ["resources/setup.md", "export API_KEY=your_key\n\nAPI_KEY=sk-SENTINEL-4f8e2a91c7d3\n"],
          ["resources/.aws/config", "SENTINEL-AWS"],
        ])
          await write(path.join(home, bundle, name!), contents);
        await write(path.join(home, bundle, "resources", "guide.txt"), "Safe guide.");
        await fs.writeFile(
          path.join(home, bundle, "resources", "icon.bin"),
          Buffer.from([0, 255, 128]),
        );
      }
      await write(path.join(home, ".grok/commands/.env"), "TOKEN=SENTINEL-FLAT");
    });
    for (const directory of [staged.directory, containerHome]) {
      const files = await listFiles(directory);
      for (const file of files) {
        expect((await fs.readFile(path.join(directory, file))).toString()).not.toContain(
          "SENTINEL",
        );
        expect(file).not.toMatch(/(?:\.env|deploy\.key|key-disguised|config\.json|\.aws)/);
      }
      expect(files.some((file) => file.endsWith("fixture-review/SKILL.md"))).toBe(true);
      expect(files.some((file) => file.endsWith("nested/deeper.md"))).toBe(true);
      for (const file of files.filter((file) => file.endsWith("icon.bin"))) {
        expect(await fs.readFile(path.join(directory, file))).toEqual(Buffer.from([0, 255, 128]));
      }
      expect(files.filter((file) => file.endsWith("guide.txt"))).toHaveLength(2);
    }
    expect(
      staged.providers.find((entry) => entry.provider === "claude")?.skipped["credential-withheld"],
    ).toBe(7);
    expect(
      staged.providers.find((entry) => entry.provider === "grok")?.skipped["credential-withheld"],
    ).toBe(8);
  });

  test("keeps skill files whose credential-named values are examples, references or counts", async () => {
    // Shapes taken from real skills whose SKILL.md the guard used to withhold.
    const examples: Record<string, string> = {
      "SKILL.md": "Set it:\n\n```sh\nexport CONTEXT7_API_KEY=your_key\n```\n",
      "reference/pdf.md":
        "qpdf --password=mypassword --decrypt in.pdf out.pdf\nqpdf --password=secret123 in.pdf\n",
      "reference/schema.md": '{ "total_tokens": 84213, "output_tokens": 912 }\n',
      "reference/polish.md": "- **missing token:** the system needs a reusable value;\n",
      "reference/live.md": "design tokens: - colour\n",
      "scripts/launch.cmd": 'for /f "usebackq tokens=1-3" %%a in ("x") do echo %%a\n',
      "scripts/live.js":
        "const TOKEN = window.__APP_TOKEN__;\nconst token = getToken();\nlet token = tokens[0];\n",
      "examples/mcp.json": '{ "env": { "API_KEY": "${API_KEY}", "TOKEN": "<your-token>" } }\n',
    };
    const { dataDir, home } = await extensionsFixture();
    for (const [name, contents] of Object.entries(examples)) {
      await write(path.join(home, ".claude", "skills", "docs-skill", name), contents);
    }
    const staged = await stagePortableInputs(
      dataDir,
      "env-examples",
      new Set(["claude"] as const),
      {
        home,
        agentTest: false,
      },
    );
    const skill = path.join(staged.directory, "claude-config", "skills", "docs-skill");
    expect(await listFiles(skill)).toEqual(Object.keys(examples).sort());
    expect(
      staged.providers.find((entry) => entry.provider === "claude")?.skipped["credential-withheld"],
    ).toBeUndefined();
  });

  test("an empty credential assignment never hides the key on the next line", async () => {
    const withheld: Record<string, string> = {
      "config.txt": "API_KEY=\nCLIENT_SECRET=sk-SENTINEL-4f8e2a91c7d3\n",
      "setup.md": "API_KEY=\r\nCLIENT_SECRET=sk-SENTINEL-4f8e2a91c7d3\r\n",
      "db.md": "TOKEN=\nDB_PASSWORD=Hk3vR9qL2x-SENTINEL\n",
      "admin.yaml": "api_key:\r\nadmin_password: Hk3vR9qL2x-SENTINEL\r\n",
      // On one line, the second assignment is still read as its own.
      "inline.md": "API_KEY= CLIENT_SECRET=sk-SENTINEL-4f8e2a91c7d3\n",
      "chained.md": "API_KEY=CLIENT_SECRET=sk-SENTINEL-4f8e2a91c7d3\n",
    };
    const { dataDir, home } = await extensionsFixture();
    const skill = path.join(home, ".claude", "skills", "blank-then-key");
    await write(path.join(skill, "SKILL.md"), "---\nname: blank-then-key\n---\nUse.\n");
    for (const [name, contents] of Object.entries(withheld)) {
      await write(path.join(skill, name), contents);
    }
    const staged = await stagePortableInputs(
      dataDir,
      "env-blank-assignment",
      new Set(["claude"] as const),
      { home, agentTest: false },
    );
    const directory = path.join(staged.directory, "claude-config", "skills", "blank-then-key");
    expect(await listFiles(directory)).toEqual(["SKILL.md"]);
    expect(
      staged.providers.find((entry) => entry.provider === "claude")?.skipped["credential-withheld"],
    ).toBe(Object.keys(withheld).length);
  });

  test("a template prefix or a placeholder word is what lets a key-shaped value through", async () => {
    // Each kept value passes every other rule; its control differs only by
    // the prefix or the placeholder word, and is withheld.
    const kept: Record<string, [string, string]> = {
      "dollar.md": ["API_KEY=$ENV_KEY_12345", "API_KEY=ENV_KEY_12345"],
      "percent.md": ["TOKEN=%APPDATA_TOKEN_9%", "TOKEN=APPDATA_TOKEN_9%"],
      "angle.md": ["PASSWORD=<pass12345>", "PASSWORD=pass12345>"],
    };
    for (const word of [
      "your",
      "example",
      "sample",
      "placeholder",
      "changeme",
      "dummy",
      "redacted",
      "secret",
      "password",
      "xxxx",
    ]) {
      kept[`word-${word}.md`] = [`ACCESS_KEY=${word}9k2q7z`, "ACCESS_KEY=k4m9k2q7z"];
    }
    const { dataDir, home } = await extensionsFixture();
    const skills = path.join(home, ".claude", "skills");
    for (const name of ["shapes", "shapes-control"]) {
      await write(path.join(skills, name, "SKILL.md"), `---\nname: ${name}\n---\nUse.\n`);
    }
    for (const [name, [example, control]] of Object.entries(kept)) {
      await write(path.join(skills, "shapes", name), `${example}\n`);
      await write(path.join(skills, "shapes-control", name), `${control}\n`);
    }
    const staged = await stagePortableInputs(
      dataDir,
      "env-value-shapes",
      new Set(["claude"] as const),
      { home, agentTest: false },
    );
    const stagedSkills = path.join(staged.directory, "claude-config", "skills");
    expect(await listFiles(path.join(stagedSkills, "shapes"))).toEqual(
      ["SKILL.md", ...Object.keys(kept)].sort(),
    );
    expect(await listFiles(path.join(stagedSkills, "shapes-control"))).toEqual(["SKILL.md"]);
    expect(
      staged.providers.find((entry) => entry.provider === "claude")?.skipped["credential-withheld"],
    ).toBe(Object.keys(kept).length);
  });

  test("leaves a skill's oversized file out, never the rest of the skill", async () => {
    const { dataDir, home } = await extensionsFixture();
    const skills = path.join(home, ".claude", "skills");
    // A platform binary over the per-file bound beside the launcher that uses it.
    await write(
      path.join(skills, "with-binary", "SKILL.md"),
      "---\nname: with-binary\n---\nRun.\n",
    );
    await write(path.join(skills, "with-binary", "scripts", "launch"), "#!/bin/sh\n");
    await write(
      path.join(skills, "with-binary", "scripts", "bin", "darwin-arm64", "tool"),
      "x".repeat(200),
    );
    // The same layout reached through a link from ~/.agents/skills.
    const shared = path.join(home, ".agents", "skills", "linked-binary");
    await write(path.join(shared, "SKILL.md"), "---\nname: linked-binary\n---\nRun.\n");
    await write(path.join(shared, "bin", "tool"), "x".repeat(200));
    await fs.symlink(shared, path.join(skills, "linked-binary"));
    // A skill whose own SKILL.md is over the bound is not a skill without it.
    await write(path.join(skills, "huge-definition", "SKILL.md"), "x".repeat(200));
    await write(path.join(skills, "huge-definition", "notes.md"), "notes\n");
    const staged = await stagePortableInputs(
      dataDir,
      "env-oversized-skill",
      new Set(["claude"] as const),
      { home, agentTest: false },
      new Date(),
      { ...INPUT_LIMITS, fileBytes: 100 },
    );
    const files = await listFiles(path.join(staged.directory, "claude-config", "skills"));
    expect(
      files.filter((file) => /^(with-binary|linked-binary|huge-definition)\//.test(file)),
    ).toEqual(["linked-binary/SKILL.md", "with-binary/SKILL.md", "with-binary/scripts/launch"]);
    // One per left-out binary, one for the skill refused whole.
    expect(
      staged.providers.find((entry) => entry.provider === "claude")?.skipped["too-large"],
    ).toBe(3);
  });

  test("the entrypoint copies exactly the extension directories the backend stages", async () => {
    const entrypoint = await fs.readFile(ENTRYPOINT, "utf8");
    const spec = portableInputSpec({ home: "/h", agentTest: false });
    const staged = (stage: string) =>
      spec
        .flatMap((provider) => provider.directories)
        .filter((source) => source.stage === stage)
        .flatMap((source) => source.directories ?? [])
        .filter((directory) => directory.mode === "entries")
        .map((directory) => directory.path)
        .sort();
    expect(staged("claude-config")).toContain("skills");
    expect(staged("grok-home")).toContain("commands");
    expect(
      entrypointDirectoryLoop(entrypoint, "/claude-config", ".claude", "Claude").names.sort(),
    ).toEqual(staged("claude-config"));
    expect(entrypointDirectoryLoop(entrypoint, "/grok-home", ".grok", "Grok").names.sort()).toEqual(
      staged("grok-home"),
    );
  });

  test("the entrypoint imports them where Claude and Grok read user resources", async () => {
    const { containerHome } = await stageAndImport();
    expect(await listFiles(path.join(containerHome, ".claude"))).toEqual([
      "skills/fixture-review/SKILL.md",
      "skills/fixture-review/scripts/run.sh",
      "skills/fixture-shared/SKILL.md",
    ]);
    expect(await listFiles(path.join(containerHome, ".grok"))).toEqual([
      "commands/fixture-user-cmd.md",
      "commands/nested/deeper.md",
      "skills/fixture-grok-skill/SKILL.md",
    ]);
  });

  test.skipIf(!process.env.CLAUDE_CLI_PATH)(
    "the Claude SDK lists the imported user skill without sending a model turn",
    async () => {
      const { root, containerHome } = await stageAndImport();
      const cwd = path.join(root, "workspace");
      await fs.mkdir(cwd);
      const sdk = path.join(
        import.meta.dir,
        "../../../bridges/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
      );
      const script = `
        import { query } from ${JSON.stringify(sdk)};
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        const stream = query({
          prompt: (async function* () { await new Promise(resolve => controller.signal.addEventListener("abort", resolve, { once: true })); })(),
          options: { cwd: process.cwd(), settingSources: ["user"],
            pathToClaudeCodeExecutable: process.env.CLAUDE_CLI_PATH,
            abortController: controller, persistSession: false }
        });
        try { console.log(JSON.stringify((await stream.supportedCommands()).map(command => command.name))); }
        finally { clearTimeout(timer); controller.abort(); stream.close(); }
      `;
      const result = Bun.spawnSync({
        cmd: [process.execPath, "--eval", script],
        cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: containerHome,
          CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH!,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 35_000,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toContain("fixture-review");
    },
    // Starting the real Claude CLI takes several seconds; the spawn above
    // has its own 35 s bound, which Bun's 5 s default never let it reach.
    40_000,
  );

  test.skipIf(!process.env.GROK_CLI_PATH)(
    "the pinned Grok CLI lists the imported command and both user skills",
    async () => {
      const { root, containerHome } = await stageAndImport();
      const cwd = path.join(root, "workspace");
      await fs.mkdir(cwd);
      const result = Bun.spawnSync({
        cmd: [process.env.GROK_CLI_PATH!, "inspect"],
        cwd,
        // Only the fixture home: no GROK_HOME, as in a container.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: containerHome },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      });
      expect(result.exitCode).toBe(0);
      const skills = /^ {2}Skills \(\d+\)\n((?: {2}└ .*\n)*)/m.exec(result.stdout.toString())?.[1];
      // Grok lists legacy flat commands as user skills, and reads Claude's
      // user skills through its Claude compatibility.
      expect(skills).toMatch(/└ fixture-user-cmd +user/);
      expect(skills).toMatch(/└ fixture-grok-skill +user/);
      expect(skills).toMatch(/└ fixture-review +user \[claude\]/);
    },
  );
});
