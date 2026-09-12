import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The repository's command surface lives in `mise.toml`, not in root
 * `package.json` scripts. That move is only safe while three things stay true:
 * every command the repository used to expose still exists, every document and
 * workflow that names a task names one that is defined, and no instruction
 * survives telling a reader to run a root script that was deleted.
 *
 * `mise tasks validate` in CI checks that the task definitions are internally
 * well-formed. It cannot see the prose, the workflows, or the commands that
 * used to exist, which is what these guards cover.
 */

const root = path.resolve(import.meta.dir, "..", "..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

type MiseTask = { run?: string | string[]; env?: Record<string, string> };

const miseTasks = (): Record<string, MiseTask> =>
  (Bun.TOML.parse(read("mise.toml")) as { tasks: Record<string, MiseTask> }).tasks;

/**
 * Every script the root `package.json` exposed before the mise migration.
 *
 * This is the promise the repository made to its developers, its CI, its
 * documentation, and its own error messages. A task quietly dropped during a
 * later reshuffle would otherwise fail only when somebody ran it.
 */
const ROOT_COMMAND_SURFACE = [
  "dev",
  "dev:test",
  "dev:status",
  "dev:login",
  "dev:stop",
  "dev:reset",
  "dev:web",
  "dev:web-public",
  "dev:renderer",
  "dev:ios",
  "start:web",
  "start:web-public",
  "build",
  "build:desktop",
  "build:backend",
  "build:cli",
  "build:renderer",
  "build:web-public",
  "build:electron",
  "build:claude-bridge",
  "build:codex-bridge",
  "build:acp-bridge",
  "build:pi-bridge",
  "build:cursor-bridge",
  "build:all",
  "download:bun",
  "download:agent",
  "download:claude",
  "download:opencode",
  "download:codex",
  "download:grok",
  "download:pi",
  "download:binaries",
  "codex:protocol",
  "codex:protocol:check",
  "setup",
  "pack:cli",
  "smoke:cli",
  "publish:cli",
  "preview",
  "test",
  "test:all",
  "test:logged",
  "test:browser",
  "test:agent:browser",
  "test:agent:docker",
  "test:agent:electron",
  "test:ios",
  "test:unit",
  "typecheck",
  "format",
  "format:check",
  "lint",
  "lint:fix",
  "check",
  "verify:opencode:live",
  "verify:toolchains:live",
  "verify:packaged-backend",
  "verify:codex:protocol",
  "docker:build",
  "docker:build:dev",
  "package:mac",
  "package:linux",
  "package:release",
] as const;

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".turbo", "logos"]);

/**
 * `test-fixtures/agent-project` is a separate project copied into agent-test
 * profiles. Its `package.json` scripts are its own, so its README saying
 * `bun run dev` is correct rather than stale.
 */
const SKIPPED_TREES = ["test-fixtures"];

/**
 * Dated records of runs that already happened. They quote the commands exactly
 * as they were typed at the time, so rewriting them would falsify the record.
 */
const HISTORICAL_TREES = ["docs/development/flaky-tests.md"];

function markdownFiles(): string[] {
  const found: string[] = [];
  const walk = (relativeDirectory: string) => {
    for (const entry of readdirSync(path.join(root, relativeDirectory), { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (
        SKIPPED_TREES.some((tree) => relativePath === tree || relativePath.startsWith(`${tree}/`))
      )
        continue;
      if (
        HISTORICAL_TREES.some(
          (tree) => relativePath === tree || relativePath.startsWith(`${tree}/`),
        )
      )
        continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(relativePath);
      } else if (entry.name.endsWith(".md")) {
        found.push(relativePath);
      }
    }
  };
  walk("");
  return found;
}

/**
 * Prose wraps, so `bun run` and the command it names routinely land on
 * different lines. The stale `bun run test:all` that survived the migration
 * did exactly that and escaped a line-by-line search, so every scan here
 * tolerates a single newline between the runner and its argument.
 */
const wrappedInvocation = (runner: "bun" | "mise") =>
  new RegExp(String.raw`\b${runner} run(?:[ \t]+|[ \t]*\n[ \t]*)([\w:.-]+<?)`, "g");

const lineNumberAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

function workflowFiles(): string[] {
  return readdirSync(path.join(root, ".github/workflows"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => `.github/workflows/${name}`);
}

describe("mise task surface", () => {
  test("every command the repository used to expose as a root script is a mise task", () => {
    const tasks = miseTasks();

    for (const command of ROOT_COMMAND_SURFACE) {
      expect(tasks[command]?.run, `mise.toml is missing the \`${command}\` task`).toBeTruthy();
    }
  });

  test("the root manifest declares no scripts, so mise is the only command surface", () => {
    const manifest = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };

    // A script reintroduced here would work locally and silently diverge from
    // the task every document, workflow, and error message points at.
    expect(manifest.scripts).toBeUndefined();
  });

  test("every mise task a document names is defined", () => {
    const tasks = miseTasks();
    const files = markdownFiles();
    expect(files.length).toBeGreaterThan(0);

    let referenced = 0;
    for (const file of files) {
      const text = read(file);
      // `download:<claude|codex|opencode>` is a documented placeholder rather
      // than a task name. Capture any trailing `<` so those stay recognisable
      // and drop them — a lookahead would backtrack into the shorter prefix.
      for (const match of text.matchAll(wrappedInvocation("mise"))) {
        const task = match[1];
        if (task.includes("<")) continue;
        referenced += 1;
        expect(
          tasks[task]?.run,
          `${file}:${lineNumberAt(text, match.index)} runs \`mise run ${task}\``,
        ).toBeTruthy();
      }
    }
    expect(referenced).toBeGreaterThan(0);
  });

  test("no document tells you to run a deleted root package script", () => {
    // This is the drift that ended the root `scripts` block: prose kept naming
    // `bun run <script>` long after the script stopped existing, and a guard
    // scoped to one runbook could not see it. `bun run --cwd <workspace>`
    // still addresses a real workspace manifest and stays legal.
    const offenders: string[] = [];

    for (const file of markdownFiles()) {
      const text = read(file);
      const lines = text.split("\n");
      for (const match of text.matchAll(wrappedInvocation("bun"))) {
        const script = match[1];
        if (script === "--cwd") continue;
        const lineNumber = lineNumberAt(text, match.index);
        // The agent-test fixture is a different project with its own scripts,
        // so an instruction naming it is talking about that manifest rather
        // than this one. Prose wraps, so accept the qualifier on the line the
        // command starts on or the one before it.
        const context = lines.slice(Math.max(0, lineNumber - 2), lineNumber).join(" ");
        if (context.includes("fixture")) continue;
        offenders.push(`${file}:${lineNumber}: bun run ${script}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("every workspace script a document names is declared by that workspace", () => {
    // The counterpart to the ban above: `bun run --cwd <workspace> <script>` is
    // the one legal `bun run` form left, so it has to point at a script that
    // the named manifest actually declares.
    let referenced = 0;

    for (const file of markdownFiles()) {
      const text = read(file);
      for (const match of text.matchAll(/\bbun run --cwd (\S+) ([\w:.-]+)/g)) {
        const [, workspace, script] = match;
        referenced += 1;
        const manifest = JSON.parse(read(`${workspace}/package.json`)) as {
          scripts?: Record<string, string>;
        };
        expect(
          manifest.scripts?.[script],
          `${file}:${lineNumberAt(text, match.index)} runs \`bun run --cwd ${workspace} ${script}\``,
        ).toBeTruthy();
      }
    }

    expect(referenced).toBeGreaterThan(0);
  });

  test("every mise task the CI workflows run is defined", () => {
    const tasks = miseTasks();
    const files = workflowFiles();
    expect(files.length).toBeGreaterThan(0);

    let referenced = 0;
    for (const file of files) {
      const text = read(file);
      for (const match of text.matchAll(wrappedInvocation("mise"))) {
        referenced += 1;
        expect(
          tasks[match[1]]?.run,
          `${file}:${lineNumberAt(text, match.index)} runs \`mise run ${match[1]}\``,
        ).toBeTruthy();
      }
    }
    expect(referenced).toBeGreaterThan(0);
  });

  test("CI validates the task definitions themselves", () => {
    // Everything above checks that names resolve. Only mise can tell whether a
    // definition is well-formed, so the lint workflow has to keep asking it.
    expect(read(".github/workflows/lint.yml")).toContain("mise tasks validate");
  });
});
