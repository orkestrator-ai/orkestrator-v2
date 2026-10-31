import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CODEX_BACKGROUND_TASK_MODEL } from "@orkestrator/protocol/codex-background-task";
import { runCommand } from "./shell.js";
import {
  buildClaudeTitleCommandArgs,
  buildCodexTitleCommandArgs,
  buildCodexTitleModelCatalog,
  buildCodexTitleOutputSchema,
  generateClaudeSessionTitle,
  generateCodexSessionTitle,
} from "./session-title-runners.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "orkestrator-title-runner-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(body: string): string {
  const file = path.join(temporaryDirectory(), "cli");
  writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** The Codex CLI pinned by `config/codex-version.json`, as the app ships it. */
function pinnedCodexCli(): string | undefined {
  const repoRoot = path.join(import.meta.dir, "../../../..");
  const { version } = JSON.parse(
    readFileSync(path.join(repoRoot, "config", "codex-version.json"), "utf8"),
  ) as { version?: string };
  if (!version) throw new Error("config/codex-version.json must pin a codex version");
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const toolchainRoot =
    process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "orkestrator-v2", "toolchains")
      : path.join(
          process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
          "orkestrator-v2",
          "toolchains",
        );
  const candidates = [
    process.env.CODEX_PROTOCOL_BINARY?.trim(),
    path.join(toolchainRoot, "codex", version, `${platform}-${architecture}`, "codex"),
    path.join(repoRoot, "binaries", "codex"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex title runner", () => {
  test("builds a tool-free model catalog and strict output schema", () => {
    const [model] = (buildCodexTitleModelCatalog().models as Array<Record<string, unknown>>) ?? [];
    expect(model).toMatchObject({
      slug: CODEX_BACKGROUND_TASK_MODEL,
      shell_type: "disabled",
      apply_patch_tool_type: null,
      experimental_supported_tools: [],
      supports_search_tool: false,
      multi_agent_version: "disabled",
    });
    expect(buildCodexTitleOutputSchema()).toMatchObject({
      additionalProperties: false,
      required: ["title"],
    });
  });

  test("runs ephemeral, read-only and without user config, reading the prompt from stdin", () => {
    const args = buildCodexTitleCommandArgs("/tmp/dir", "/tmp/out", "/tmp/catalog", "/tmp/schema");
    const execIndex = args.indexOf("exec");
    expect(execIndex).toBeGreaterThan(0);
    // Global flags precede the subcommand; exec-only flags follow it.
    expect(args.slice(0, execIndex)).toEqual(
      expect.arrayContaining(["--sandbox", "read-only", "--ask-for-approval", "never"]),
    );
    for (const feature of ["shell_tool", "hooks", "plugins", "apps", "multi_agent", "view_image"]) {
      expect(args.slice(0, execIndex).join(" ")).toContain(`--disable ${feature}`);
    }
    for (const override of [
      "skills.include_instructions=false",
      "tools.experimental_request_user_input.enabled=false",
    ]) {
      expect(args.slice(0, execIndex).join(" ")).toContain(`--config ${override}`);
    }
    expect(args.slice(execIndex)).toEqual(
      expect.arrayContaining([
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "--skip-git-repo-check",
      ]),
    );
    expect(args.at(-1)).toBe("-");
  });

  const codexPath = pinnedCodexCli();
  test.skipIf(!codexPath)(
    "the pinned Codex parser accepts the production argument shape and secured catalog",
    () => {
      if (!codexPath) throw new Error("Pinned Codex CLI is unavailable");
      const directory = temporaryDirectory();
      // A throwaway home: neither probe may read this machine's Codex login or config.
      const env = { ...process.env, CODEX_HOME: temporaryDirectory() };
      const catalogPath = path.join(directory, "catalog.json");
      const schemaPath = path.join(directory, "schema.json");
      writeFileSync(catalogPath, JSON.stringify(buildCodexTitleModelCatalog()));
      writeFileSync(schemaPath, JSON.stringify(buildCodexTitleOutputSchema()));

      const args = buildCodexTitleCommandArgs(
        directory,
        path.join(directory, "title.txt"),
        catalogPath,
        schemaPath,
      );
      args[args.length - 1] = "--help";
      expect(spawnSync(codexPath, args, { encoding: "utf8", env }).status).toBe(0);

      const models = spawnSync(
        codexPath,
        ["--config", `model_catalog_json=${JSON.stringify(catalogPath)}`, "debug", "models"],
        { encoding: "utf8", env },
      );
      expect(models.status).toBe(0);
      const parsed = JSON.parse(models.stdout) as { models: Array<Record<string, unknown>> };
      expect(parsed.models[0]).toMatchObject({
        slug: CODEX_BACKGROUND_TASK_MODEL,
        shell_type: "disabled",
        apply_patch_tool_type: null,
        input_modalities: ["text"],
      });
      // macOS scans a newly installed binary on first exec, which alone took 4.75 s.
    },
    30_000,
  );

  test("hands the source to stdin, reads the output file and cleans up", async () => {
    const root = temporaryDirectory();
    const record = path.join(root, "record");
    const cli = executable(`
printf '%s\\n' "$@" > "${record}.args"
cat > "${record}.stdin"
pwd > "${record}.cwd"
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then out="$2"; fi
  shift
done
printf '{"title":"Fix the OAuth race."}' > "$out"
`);
    const scratch = temporaryDirectory();
    const title = await generateCodexSessionTitle({
      executable: cli,
      env: process.env,
      source: "SECRET-SOURCE please fix the OAuth race",
      run: runCommand,
      temporaryRoot: scratch,
    });

    expect(title).toBe("Fix the OAuth race");
    expect(readFileSync(`${record}.args`, "utf8")).not.toContain("SECRET-SOURCE");
    expect(readFileSync(`${record}.stdin`, "utf8")).toContain(
      JSON.stringify("SECRET-SOURCE please fix the OAuth race"),
    );
    // The run's own directory is gone afterwards: nothing resumable is left.
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("falls back to stdout when no output file was written", async () => {
    const cli = executable(`cat > /dev/null\nprintf 'Plain title line\\n'`);
    await expect(
      generateCodexSessionTitle({
        executable: cli,
        env: process.env,
        source: "prompt",
        run: runCommand,
      }),
    ).resolves.toBe("Plain title line");
  });

  test("rejects a failing run and an empty answer", async () => {
    await expect(
      generateCodexSessionTitle({
        executable: executable("cat > /dev/null\nexit 3"),
        env: process.env,
        source: "prompt",
        run: runCommand,
      }),
    ).rejects.toThrow();
    await expect(
      generateCodexSessionTitle({
        executable: executable("cat > /dev/null\nprintf '   '"),
        env: process.env,
        source: "prompt",
        run: runCommand,
      }),
    ).rejects.toThrow("empty or invalid");
  });
});

describe("Claude title runner", () => {
  test("disables tools, MCP, slash commands, settings and session persistence", () => {
    const args = buildClaudeTitleCommandArgs();
    expect(args).toEqual(
      expect.arrayContaining([
        "--print",
        "--safe-mode",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
      ]),
    );
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    // `--bare` would also disable OAuth/Keychain authentication.
    expect(args).not.toContain("--bare");
    expect(args.join(" ")).not.toContain("Ignore previous instructions");
  });

  test("sanitizes the printed title and runs in an empty directory", async () => {
    const root = temporaryDirectory();
    const cli = executable(
      `printf '%s\\n' "$@" > "${root}/args"\ncat > "${root}/stdin"\npwd > "${root}/cwd"\nprintf '"Fix the login flow."\\n'`,
    );
    await expect(
      generateClaudeSessionTitle({
        executable: cli,
        env: process.env,
        source: "PRIVATE-TITLE-SOURCE the login flow is broken",
        run: runCommand,
      }),
    ).resolves.toBe("Fix the login flow");
    const cwd = readFileSync(path.join(root, "cwd"), "utf8").trim();
    expect(cwd).toContain("orkestrator-session-title-");
    expect(existsSync(cwd)).toBe(false);
    expect(readFileSync(path.join(root, "args"), "utf8")).not.toContain("PRIVATE-TITLE-SOURCE");
    expect(readFileSync(path.join(root, "stdin"), "utf8")).toContain(
      JSON.stringify("PRIVATE-TITLE-SOURCE the login flow is broken"),
    );
  });

  test("a CLI failure is a rejection, never a title made of its error text", async () => {
    // How `claude -p` 2.1.314 reports a failure: exit 1, the error on stdout.
    await expect(
      generateClaudeSessionTitle({
        executable: executable(
          "cat > /dev/null\nprintf 'Not logged in \\302\\267 Please run /login\\n'\nexit 1",
        ),
        env: process.env,
        source: "prompt",
        run: runCommand,
      }),
    ).rejects.toThrow("Not logged in");
  });

  test("rejects an empty answer", async () => {
    await expect(
      generateClaudeSessionTitle({
        executable: executable("printf '...'"),
        env: process.env,
        source: "prompt",
        run: runCommand,
      }),
    ).rejects.toThrow("empty session title");
  });
});
