import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_SLASH_COMMANDS,
  buildPromptInput,
  collectPromptSlashCommandsFromDir,
  expandPromptTemplate,
  extractFrontmatter,
  getAvailableSlashCommandDefinitions,
  isCodexCliNativeSlashCommand,
  normalizeSlashCommandName,
  parseCodexSteerCommand,
  parseSlashCommandPrompt,
  resolveConversationMode,
  runInlinePromptCommand,
  serializeSlashCommand,
  summarizePromptTemplate,
  wrapPromptForConversationMode,
} from "./slash-commands.js";

const temporaryDirectories: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalShell = process.env.SHELL;
const originalRuntimeEnvScript = process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT;

afterAll(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  if (originalRuntimeEnvScript === undefined) {
    delete process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT;
  } else {
    process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT = originalRuntimeEnvScript;
  }
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ork-slash-commands-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("slash command parsing and metadata", () => {
  test("normalizes names and parses only single-line slash prompts", () => {
    expect(normalizeSlashCommandName("  nested\\review  ")).toBe("/nested/review");
    expect(normalizeSlashCommandName("   ")).toBe("");
    expect(parseSlashCommandPrompt(" /review   one two ")).toEqual({
      name: "/review",
      args: "one two",
    });
    expect(parseSlashCommandPrompt("/review")).toEqual({ name: "/review", args: "" });
    expect(parseSlashCommandPrompt("review")).toBeNull();
    expect(parseSlashCommandPrompt("/review\nextra")).toBeNull();
  });

  test("parses only an exact /steer token with single-line or multiline text", () => {
    expect(parseCodexSteerCommand(" /STEER  check the tests ")).toEqual({
      args: "check the tests",
    });
    expect(parseCodexSteerCommand("/steer\ncheck the API\nthen the UI")).toEqual({
      args: "check the API\nthen the UI",
    });
    expect(parseCodexSteerCommand("/steer\tcheck the API")).toEqual({
      args: "check the API",
    });
    expect(parseCodexSteerCommand("/steer  \n ")).toEqual({ args: "" });
    for (const value of [
      "/steering elsewhere",
      "/steerx elsewhere",
      "/steer-now",
      "please /steer this",
      "first line\n/steer second line",
    ]) {
      expect(parseCodexSteerCommand(value)).toBeNull();
    }
  });

  test("recognizes only the CLI-native goal command", () => {
    expect(isCodexCliNativeSlashCommand("/GOAL")).toBe(true);
    expect(isCodexCliNativeSlashCommand("/help")).toBe(false);
    expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "/help",
      "/goal",
      "/models",
      "/steer",
    ]);
  });

  test("extracts simple frontmatter and leaves ordinary content untouched", () => {
    expect(extractFrontmatter([
      "---",
      'description: "Review this change"',
      "argument_hint: '<path:line>'",
      "ignored line",
      "---",
      "Template body",
    ].join("\n"))).toEqual({
      body: "Template body",
      fields: {
        description: "Review this change",
        argument_hint: "<path:line>",
      },
    });
    expect(extractFrontmatter("No frontmatter")).toEqual({
      body: "No frontmatter",
      fields: {},
    });
  });

  test("summarizes the task section and returns undefined for placeholder-only content", () => {
    expect(summarizePromptTemplate([
      "# Heading",
      "Preamble",
      "## Your Task",
      "- Current branch: main",
      "Review the selected change carefully.",
    ].join("\n"))).toBe("Review the selected change carefully.");
    expect(summarizePromptTemplate("# Heading\n$ARGUMENTS\n- Current branch: x"))
      .toBeUndefined();
  });

  test("serializes prompt and builtin definitions without private prompt fields", () => {
    expect(serializeSlashCommand({
      name: "/review",
      description: "Review",
      argumentHint: "<path>",
      source: "prompt",
      path: "/private/prompts/review.md",
      template: "private template",
    })).toEqual({
      name: "/review",
      description: "Review",
      argumentHint: "<path>",
      source: "prompt",
    });
    expect(serializeSlashCommand(BUILTIN_SLASH_COMMANDS[0]!)).toEqual(
      BUILTIN_SLASH_COMMANDS[0],
    );
  });
});

describe("prompt command discovery", () => {
  test("walks nested Markdown prompts, applies metadata fallbacks, and skips unreadable roots", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested", "review.md"), [
      "---",
      "short_description: Review a change",
      "arguments: <path>",
      "---",
      "Review $ARGUMENTS.",
    ].join("\n"));
    await writeFile(join(root, "summary.MD"), "## Your Task\nSummarize this repository.");
    await writeFile(join(root, "fallback.md"), "# Heading\n$ARGUMENTS");
    await writeFile(join(root, "empty.md"), "");
    await writeFile(join(root, "ignored.txt"), "ignored");

    const commands = await collectPromptSlashCommandsFromDir(root);
    expect(commands.map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      template: command.template,
    })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      {
        name: "/fallback",
        description: "Run fallback prompt",
        argumentHint: undefined,
        template: "# Heading\n$ARGUMENTS",
      },
      {
        name: "/nested/review",
        description: "Review a change",
        argumentHint: "<path>",
        template: "Review $ARGUMENTS.",
      },
      {
        name: "/summary",
        description: "Summarize this repository.",
        argumentHint: undefined,
        template: "## Your Task\nSummarize this repository.",
      },
    ]);
    expect(await collectPromptSlashCommandsFromDir(join(root, "missing"))).toEqual([]);
  });

  test("prefers repository prompts while keeping /steer reserved for the builtin", async () => {
    const cwd = await temporaryDirectory();
    const codexHome = await temporaryDirectory();
    process.env.CODEX_HOME = codexHome;
    const localPrompts = join(cwd, ".codex", "prompts");
    const homePrompts = join(codexHome, "prompts");
    await mkdir(localPrompts, { recursive: true });
    await mkdir(homePrompts, { recursive: true });
    await writeFile(join(localPrompts, "shared.md"), "Local shared prompt");
    await writeFile(join(localPrompts, "help.md"), "Local help prompt");
    await writeFile(join(localPrompts, "steer.md"), "Unreachable steer prompt");
    await writeFile(join(homePrompts, "shared.md"), "Home shared prompt");
    await writeFile(join(homePrompts, "home-only.md"), "Home-only prompt");

    const definitions = await getAvailableSlashCommandDefinitions(cwd);
    expect(definitions.map((definition) => definition.name)).toEqual([
      "/goal",
      "/help",
      "/home-only",
      "/models",
      "/shared",
      "/steer",
    ]);
    expect(definitions.find((definition) => definition.name === "/help")?.source)
      .toBe("prompt");
    expect(definitions.find((definition) => definition.name === "/steer"))
      .toMatchObject({ source: "builtin", argumentHint: "<instructions>" });
    expect(definitions.find((definition) => definition.name === "/shared"))
      .toMatchObject({ source: "prompt", template: "Local shared prompt" });
  });
});

describe("prompt expansion and shaping", () => {
  test("runs inline commands and preserves useful output on empty and failed commands", async () => {
    const cwd = await temporaryDirectory();
    process.env.SHELL = "/bin/sh";
    process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT = join(cwd, "missing-runtime-env.sh");

    expect(await runInlinePromptCommand("printf stdout", cwd)).toBe("stdout");
    expect(await runInlinePromptCommand("printf stderr >&2", cwd)).toBe("stderr");
    expect(await runInlinePromptCommand(":", cwd)).toBe("(no output)");
    expect(
      await runInlinePromptCommand(
        "printf preferred-stdout; printf ignored-stderr >&2; exit 3",
        cwd,
      ),
    ).toBe("preferred-stdout");
  });

  test("expands arguments and every inline command in template order", async () => {
    const cwd = await temporaryDirectory();
    process.env.SHELL = "/bin/sh";
    process.env.ORKESTRATOR_RUNTIME_ENV_SCRIPT = join(cwd, "missing-runtime-env.sh");

    expect(await expandPromptTemplate(
      "Task: $ARGUMENTS\nFirst !`printf one`, second !`printf two`.",
      "review",
      cwd,
    )).toBe("Task: review\nFirst one, second two.");
    expect(await expandPromptTemplate("No substitutions", "unused", cwd))
      .toBe("No substitutions");
  });

  test("resolves build and plan modes and wraps only plan prompts", () => {
    expect(resolveConversationMode({ mode: "plan" })).toBe("plan");
    expect(resolveConversationMode({ mode: "build" })).toBe("build");
    expect(resolveConversationMode({ mode: "PLAN" })).toBe("build");
    expect(resolveConversationMode({})).toBe("build");

    expect(wrapPromptForConversationMode("Do it", "build")).toBe("Do it");
    const planned = wrapPromptForConversationMode("Plan it", "plan");
    expect(planned).toContain("<system-reminder>");
    expect(planned).toEndWith("\n\nPlan it");
  });

  test("builds bare text or ordered text-and-image user input", () => {
    expect(buildPromptInput("hello", [])).toBe("hello");
    expect(buildPromptInput("hello", [
      { type: "image", path: "/tmp/one.png", filename: "one.png" },
      { type: "image", path: "/tmp/two.png", dataUrl: "data:image/png;base64,x" },
    ])).toEqual([
      { type: "text", text: "hello" },
      { type: "local_image", path: "/tmp/one.png" },
      { type: "local_image", path: "/tmp/two.png" },
    ]);
    expect(buildPromptInput("", [{ type: "image", path: "/tmp/only.png" }]))
      .toEqual([{ type: "local_image", path: "/tmp/only.png" }]);
  });
});
