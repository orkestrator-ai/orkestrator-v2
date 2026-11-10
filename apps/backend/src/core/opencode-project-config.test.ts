import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENCODE2_LAUNCH_PROJECT_CONFIG,
  OPENCODE2_LAUNCH_ROOT,
  OPENCODE_LAUNCH_PROJECT_CONFIG,
} from "./agent-credential-files.js";
import {
  OPENCODE_PROJECT_CONFIG_MAX_BYTES,
  OPENCODE_PROJECT_FILE_REFERENCE_LIMIT,
  checkoutRelativePath,
  filterProjectOpenCodeConfig,
  openCodeProjectConfigPath,
  openCodeProjectInstructionPath,
  readFilteredProjectOpenCodeConfig,
  writeProjectInstructionScript,
  writeProjectOpenCodeConfigScript,
} from "./opencode-project-config.js";

const parse = (text: string | undefined) =>
  text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);

const noFiles = async () => undefined;
const copyPath = (index: number) => `/run/test/project/instructions/${index}.md`;

describe("checkoutRelativePath", () => {
  test("admits paths inside the checkout only", () => {
    expect(checkoutRelativePath("prompts/a.md")).toBe("prompts/a.md");
    expect(checkoutRelativePath("./a.md")).toBe("a.md");
    expect(checkoutRelativePath("/workspace/docs/a.md")).toBe("docs/a.md");
    expect(checkoutRelativePath("docs/../a.md")).toBe("a.md");
    for (const outside of [
      "../a.md",
      "docs/../../a.md",
      "/proc/self/environ",
      "/workspace",
      "~/secrets",
      "/workspace-other/a",
      "",
      "a\0b",
    ]) {
      expect(checkoutRelativePath(outside)).toBeUndefined();
    }
  });
});

describe("filterProjectOpenCodeConfig", () => {
  test("keeps agents, commands, MCP servers and permissions; drops plugins", async () => {
    const result = await filterProjectOpenCodeConfig(
      [
        {
          name: "opencode.json",
          text: JSON.stringify({
            model: "a/b",
            plugin: ["opencode-planted"],
            agent: { review: { prompt: "Review it" } },
            command: { ship: { template: "ship" } },
            mcp: { local: { type: "local", command: ["bun", "x"] } },
            permission: { bash: "ask" },
          }),
        },
        { name: "opencode.jsonc", text: '// later wins\n{"model":"c/d","plugins":["x"]}' },
      ],
      noFiles,
      copyPath,
    );
    expect(result.dropped.plugins).toBe(true);
    expect(parse(result.text)).toEqual({
      model: "c/d",
      agent: { review: { prompt: "Review it" } },
      command: { ship: { template: "ship" } },
      mcp: { local: { type: "local", command: ["bun", "x"] } },
      permission: { bash: "ask" },
    });
  });

  test("drops every {env:} reference: the server's environment holds the password", async () => {
    const result = await filterProjectOpenCodeConfig(
      [
        {
          name: "opencode.json",
          text: JSON.stringify({
            mcp: {
              remote: {
                type: "remote",
                url: "https://example.test/?p={env:OPENCODE_SERVER_PASSWORD}",
                enabled: true,
              },
            },
            provider: { x: { options: { apiKey: "{env:OPENCODE_PASSWORD}" } } },
            tags: ["{env:HOME}", "kept"],
          }),
        },
      ],
      noFiles,
      copyPath,
    );
    expect(result.dropped.env).toBe(3);
    expect(parse(result.text)).toEqual({
      mcp: { remote: { type: "remote", enabled: true } },
      provider: { x: { options: {} } },
      tags: ["kept"],
    });
    expect(result.text).not.toContain("{env:");
  });

  test("inlines {file:} inside the checkout and drops anything outside or self-referencing", async () => {
    const read: string[] = [];
    const files: Record<string, string> = {
      "prompts/review.md": "Review carefully.",
      "prompts/nested.md": "see {file:/proc/self/environ}",
    };
    const result = await filterProjectOpenCodeConfig(
      [
        {
          name: "opencode.json",
          text: JSON.stringify({
            agent: {
              inside: { prompt: "{file:./prompts/review.md}" },
              absoluteInside: { prompt: "{file:/workspace/prompts/review.md}" },
              environ: { prompt: "{file:/proc/self/environ}" },
              climbing: { prompt: "{file:../outside.md}" },
              home: { prompt: "{file:~/.ssh/id_ed25519}" },
              nested: { prompt: "{file:prompts/nested.md}" },
              missing: { prompt: "{file:prompts/missing.md}" },
            },
          }),
        },
      ],
      async (relative) => {
        read.push(relative);
        return files[relative];
      },
      copyPath,
    );
    expect(parse(result.text)).toEqual({
      agent: {
        inside: { prompt: "Review carefully." },
        absoluteInside: { prompt: "Review carefully." },
        environ: {},
        climbing: {},
        home: {},
        nested: {},
        missing: {},
      },
    });
    // Nothing outside the checkout was ever read.
    expect(read.sort()).toEqual(
      [
        "AGENTS.md",
        "prompts/missing.md",
        "prompts/nested.md",
        "prompts/review.md",
        "prompts/review.md",
      ].sort(),
    );
    expect(result.dropped.file).toBe(5);
  });

  test("inlines at most the reference limit", async () => {
    const agent = Object.fromEntries(
      Array.from({ length: OPENCODE_PROJECT_FILE_REFERENCE_LIMIT + 2 }, (_, index) => [
        `a${index}`,
        { prompt: `{file:p${index}.md}` },
      ]),
    );
    const result = await filterProjectOpenCodeConfig(
      [{ name: "opencode.json", text: JSON.stringify({ agent }) }],
      async (relative) => (relative === "AGENTS.md" ? undefined : "text"),
      copyPath,
    );
    const kept = Object.values(parse(result.text)!.agent as Record<string, object>).filter(
      (value) => "prompt" in value,
    );
    expect(kept).toHaveLength(OPENCODE_PROJECT_FILE_REFERENCE_LIMIT);
    expect(result.dropped.file).toBe(2);
  });

  test("copies AGENTS.md and the instructions inside the checkout; drops any outside it", async () => {
    const read: string[] = [];
    const contents: Record<string, string> = {
      "AGENTS.md": "project rules",
      "docs/rules.md": "more rules",
    };
    const result = await filterProjectOpenCodeConfig(
      [
        {
          name: "opencode.json",
          text: JSON.stringify({
            instructions: [
              "docs/rules.md",
              "./AGENTS.md",
              "/proc/self/environ",
              "../x.md",
              "~/.notes",
              "docs/missing.md",
              7,
            ],
          }),
        },
      ],
      async (relative) => {
        read.push(relative);
        return contents[relative];
      },
      copyPath,
    );
    expect(parse(result.text)).toEqual({ instructions: [copyPath(0), copyPath(1)] });
    expect(result.instructions).toEqual(["project rules", "more rules"]);
    expect(result.dropped.instructions).toBe(5);
    // Nothing outside the checkout was read, and AGENTS.md only once.
    expect(read).toEqual(["AGENTS.md", "docs/rules.md", "docs/missing.md"]);
  });

  test("a checkout with only AGENTS.md still gets it as an instruction copy", async () => {
    const result = await filterProjectOpenCodeConfig(
      [],
      async (relative) => (relative === "AGENTS.md" ? "rules" : undefined),
      copyPath,
    );
    expect(parse(result.text)).toEqual({ instructions: [copyPath(0)] });
    expect(result.instructions).toEqual(["rules"]);
  });

  test("a reference in a key drops that entry", async () => {
    const result = await filterProjectOpenCodeConfig(
      [{ name: "opencode.json", text: '{"agent":{"{env:X}":{"prompt":"p"},"ok":{"prompt":"q"}}}' }],
      noFiles,
      copyPath,
    );
    expect(parse(result.text)).toEqual({ agent: { ok: { prompt: "q" } } });
  });

  test("no project files, unparseable ones, or nothing left: no document", async () => {
    expect((await filterProjectOpenCodeConfig([], noFiles, copyPath)).text).toBeUndefined();
    const broken = await filterProjectOpenCodeConfig(
      [{ name: "opencode.json", text: "{ not json" }],
      noFiles,
      copyPath,
    );
    expect(broken.text).toBeUndefined();
    expect(broken.rejected).toEqual(["opencode.json"]);
    const onlyPlugins = await filterProjectOpenCodeConfig(
      [{ name: "opencode.json", text: '{"plugin":["x"]}' }],
      noFiles,
      copyPath,
    );
    expect(onlyPlugins.text).toBeUndefined();
  });
});

describe("readFilteredProjectOpenCodeConfig", () => {
  test("reads the checkout's files as node, bounded, and refuses an oversized one", async () => {
    const commands: string[] = [];
    const exec = async (_container: string, command: string) => {
      commands.push(command);
      if (command.includes("'/workspace/opencode.json'")) {
        return `F${JSON.stringify({ agent: { a: { prompt: "{file:p.md}" } } })}`;
      }
      if (command.includes("/workspace/opencode.jsonc' ] && echo present")) return "present\n";
      if (command.includes("'/workspace/opencode.jsonc'")) {
        return `F${"x".repeat(OPENCODE_PROJECT_CONFIG_MAX_BYTES + 1)}`;
      }
      if (command.includes("'/workspace/p.md'")) return "Fprompt text";
      // AGENTS.md is absent: the read prints nothing.
      return "";
    };
    const result = await readFilteredProjectOpenCodeConfig(
      "container-1",
      "opencode2",
      exec as never,
    );
    expect(parse(result.text)).toEqual({ agent: { a: { prompt: "prompt text" } } });
    expect(commands.some((command) => command.includes("'/workspace/AGENTS.md'"))).toBe(true);
    expect(commands[0]).toContain(`head -c ${OPENCODE_PROJECT_CONFIG_MAX_BYTES + 1} --`);
    expect(result.instructions).toEqual([]);
    expect(commands.some((command) => command.includes("'/workspace/p.md'"))).toBe(true);
  });
});

describe("writing the filtered configuration as root", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  test("each server has its own file under its root directory", () => {
    expect(openCodeProjectInstructionPath("opencode2", 3)).toBe(
      `${OPENCODE2_LAUNCH_ROOT}/project/instructions/3.md`,
    );
    expect(openCodeProjectConfigPath("opencode")).toBe(OPENCODE_LAUNCH_PROJECT_CONFIG);
    expect(openCodeProjectConfigPath("opencode2")).toBe(OPENCODE2_LAUNCH_PROJECT_CONFIG);
    expect(OPENCODE2_LAUNCH_PROJECT_CONFIG.startsWith(`${OPENCODE2_LAUNCH_ROOT}/`)).toBe(true);
  });

  test.skipIf(process.platform !== "linux")(
    "replaces the file (readable, never a link) and removes it for an empty document",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "ork-opencode-project-"));
      directories.push(root);
      const script = writeProjectOpenCodeConfigScript("opencode2").replaceAll(
        OPENCODE2_LAUNCH_ROOT,
        root,
      );
      // A planted link where the file goes is replaced with the directory.
      await writeFile(path.join(root, "target"), "planted");
      await Bun.spawn(["mkdir", path.join(root, "project")]).exited;
      await symlink(path.join(root, "target"), path.join(root, "project", "opencode.json"));
      const write = (stdin: string) =>
        Bun.spawnSync(["sh", "-c", script], { stdin: Buffer.from(stdin) }).exitCode;
      expect(write('{"model":"a/b"}\n')).toBe(0);
      const file = path.join(root, "project", "opencode.json");
      expect(await readFile(file, "utf8")).toBe('{"model":"a/b"}\n');
      expect((await stat(file)).mode & 0o777).toBe(0o644);
      expect(await readFile(path.join(root, "target"), "utf8")).toBe("planted");
      const instruction = writeProjectInstructionScript("opencode2", 0).replaceAll(
        OPENCODE2_LAUNCH_ROOT,
        root,
      );
      expect(
        Bun.spawnSync(["sh", "-c", instruction], { stdin: Buffer.from("rules") }).exitCode,
      ).toBe(0);
      const copy = path.join(root, "project", "instructions", "0.md");
      expect(await readFile(copy, "utf8")).toBe("rules");
      expect((await stat(copy)).mode & 0o777).toBe(0o644);
      // The next start's write replaces the directory, copies included.
      expect(write("")).toBe(0);
      expect(await readdir(path.join(root, "project"))).toEqual([]);
    },
  );
});
