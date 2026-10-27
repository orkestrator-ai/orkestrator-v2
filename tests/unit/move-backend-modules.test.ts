import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const core = "apps/backend/src/core";
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((dir) => rm(dir, { recursive: true, force: true })));
});

function run(root: string, command: string[]) {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect({ command, exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    command,
    exitCode: 0,
    stderr: "",
  });
  return result.stdout.toString();
}

async function write(root: string, file: string, source: string) {
  const destination = path.join(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, source);
}

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-move-backend-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "scripts"));
  // The CLI resolves its repository from its own location. Copy it so no test
  // invocation can move, rewrite, or stage files in the real checkout.
  await copyFile(
    path.join(repositoryRoot, "scripts/move-backend-modules.ts"),
    path.join(root, "scripts/move-backend-modules.ts"),
  );
  await copyFile(path.join(repositoryRoot, "bunfig.toml"), path.join(root, "bunfig.toml"));
  for (const [file, source] of Object.entries(files)) await write(root, file, source);
  run(root, ["git", "init", "--quiet"]);
  run(root, ["git", "add", "--", ...Object.keys(files)]);
  run(root, [
    "git",
    "-c",
    "user.name=Codemod Test",
    "-c",
    "user.email=codemod@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return root;
}

function move(root: string, args = ["--prefix", "design-", "--into", "design"]) {
  return run(root, [process.execPath, "scripts/move-backend-modules.ts", ...args]);
}

const read = (root: string, file: string) => readFile(path.join(root, file), "utf8");

describe("move-backend-modules CLI", () => {
  test("moves an unreferenced module without formatting unrelated files when no text changes", async () => {
    const source = "export const value = 1;\n";
    const unrelated = "export const unrelated={ messy:true}\n";
    const root = await fixture({
      [`${core}/design-alone.ts`]: source,
      "unrelated.ts": unrelated,
    });

    const output = move(root);

    expect(output).toContain("Moved 1 file(s); rewrote 0 file(s).");
    expect(await read(root, "unrelated.ts")).toBe(unrelated);
    expect(await read(root, `${core}/design/alone.ts`)).toBe(source);
    expect(existsSync(path.join(root, `${core}/design-alone.ts`))).toBe(false);
    expect(run(root, ["git", "diff", "--cached", "--name-status", "--find-renames"])).toBe(
      `R100\t${core}/design-alone.ts\t${core}/design/alone.ts\n`,
    );
    expect(run(root, ["git", "diff", "--name-only"])).toBe("");
  });

  test.each(["", ".ts", ".js", ".mts", ".mjs", ".cts", ".cjs", ".tsx", ".jsx"])(
    "rebases incoming, outgoing, and jointly moved imports while preserving the %j suffix",
    async (suffix) => {
      const extension = suffix.replace(/js/, "ts") || ".ts";
      const root = await fixture({
        [`${core}/design-service${extension}`]: [
          `import { helper } from "./design-helper${suffix}";`,
          `import { config } from "./config${suffix}";`,
          `import { shared } from "../../../../packages/protocol/src/shared${suffix}";`,
          'import { external } from "@vendor/package";',
          "export const service = [helper, config, shared, external];",
          "",
        ].join("\n"),
        [`${core}/design-helper${extension}`]: "export const helper = 1;\n",
        [`${core}/config${extension}`]: "export const config = 2;\n",
        [`packages/protocol/src/shared${extension}`]: "export const shared = 3;\n",
        [`${core}/consumer.ts`]: `export { service } from "./design-service${suffix}";\n`,
        "unrelated.ts": "export const untouched={ messy:true}\n",
      });

      const output = move(root);
      const service = await read(root, `${core}/design/service${extension}`);

      expect(service).toContain(`from "./helper${suffix}"`);
      expect(service).toContain(`from "../config${suffix}"`);
      expect(service).toContain(`from "../../../../../packages/protocol/src/shared${suffix}"`);
      expect(service).toContain('from "@vendor/package"');
      expect(await read(root, `${core}/consumer.ts`)).toContain(`from "./design/service${suffix}"`);
      expect(output).toContain("Moved 2 file(s); rewrote 2 file(s).");
      expect(await read(root, "unrelated.ts")).toBe("export const untouched={ messy:true}\n");
      // Move destinations must be formatted and staged after rewriting.
      expect(run(root, ["git", "diff", "--", `${core}/design`])).toBe("");
      // Rewritten callers remain unstaged; only the move paths are staged.
      expect(run(root, ["git", "diff", "--cached", "--name-only"])).not.toContain("consumer.ts");
    },
    20_000,
  );

  test("rewrites side-effect imports, dynamic imports, require, and mock.module in moved and stationary files", async () => {
    const references = (target: string) =>
      [
        `import "${target}.js";`,
        `const loaded = import("${target}");`,
        `const required = require('${target}.ts');`,
        `mock.module('${target}.js', () => ({}));`,
        "",
      ].join("\n");
    const root = await fixture({
      [`${core}/design-service.ts`]: "export {};\n",
      [`${core}/design-service.test.ts`]: references("./design-service") + references("./config"),
      [`${core}/config.ts`]: "export {};\n",
      "tests/caller.ts": references("../apps/backend/src/core/design-service"),
    });

    move(root);

    // `bun fmt` normalizes single quotes, so assert the resulting parsed spellings.
    const moved = await read(root, `${core}/design/service.test.ts`);
    for (const target of ["./service", "../config"]) {
      expect(moved).toContain(`import "${target}.js"`);
      expect(moved).toContain(`import("${target}")`);
      expect(moved).toContain(`require("${target}.ts")`);
      expect(moved).toContain(`mock.module("${target}.js",`);
    }
    const caller = await read(root, "tests/caller.ts");
    const target = "../apps/backend/src/core/design/service";
    expect(caller).toContain(`import "${target}.js"`);
    expect(caller).toContain(`import("${target}")`);
    expect(caller).toContain(`require("${target}.ts")`);
    expect(caller).toContain(`mock.module("${target}.js",`);
  }, 20_000);

  test("uses explicit maps and rewrites tracked path strings without changing bare names or lookalikes", async () => {
    const oldPath = `${core}/design-service.ts`;
    const newPath = `${core}/features/design/service.ts`;
    const root = await fixture({
      [oldPath]: "export {};\n",
      "moves.json": JSON.stringify({ [oldPath]: newPath }),
      "AGENTS.md": `See ${oldPath} and core/design-service.js.\n`,
      "docs/guide.md": [
        `[module](${oldPath})`,
        "`core/design-service.ts` and `core/design-service.js`",
        "Bare design-service.ts stays; othercore/design-service.ts stays.",
        "core/design-service.ts-backup stays; core/design-service.tsx stays.",
        "",
      ].join("\n"),
      "scripts/check.sh": `cat ${oldPath}\n`,
      "config.json": JSON.stringify({ module: oldPath.replace(/\.ts$/, ".js") }),
    });
    await write(root, "untracked.md", oldPath);

    move(root, ["--map", "moves.json"]);

    expect(await read(root, "AGENTS.md")).toBe(
      `See ${newPath} and core/features/design/service.js.\n`,
    );
    expect(await read(root, "docs/guide.md")).toBe(
      [
        `[module](${newPath})`,
        "`core/features/design/service.ts` and `core/features/design/service.js`",
        "Bare design-service.ts stays; othercore/design-service.ts stays.",
        "core/design-service.ts-backup stays; core/design-service.tsx stays.",
        "",
      ].join("\n"),
    );
    expect(await read(root, "scripts/check.sh")).toBe(`cat ${newPath}\n`);
    expect(JSON.parse(await read(root, "config.json"))).toEqual({
      module: newPath.replace(/\.ts$/, ".js"),
    });
    expect(await read(root, "untracked.md")).toBe(oldPath);
  }, 20_000);

  test("honors repository formatter exclusions while rewriting tracked references", async () => {
    const oldPath = `${core}/design-service.ts`;
    const newPath = `${core}/design/service.ts`;
    const markdown = `#   Untidy heading\n\n[module](../../${oldPath})\n`;
    const ignored = `export const modulePath='${oldPath}'\n`;
    const generated = "bridges/codex-bridge/src/app-server/generated/reference.ts";
    const root = await fixture({
      [oldPath]: 'export { value } from "./config";\n',
      [`${core}/config.ts`]: "export const value = 1;\n",
      "docs/reference.ts": ignored,
      "docs/guide.md": markdown,
      "GUIDE.md": markdown,
      [generated]: ignored,
      "caller.ts": `export const modulePath='${oldPath}'\n`,
    });

    move(root);

    for (const file of ["docs/reference.ts", generated]) {
      expect(await read(root, file)).toBe(ignored.replace(oldPath, newPath));
    }
    for (const file of ["docs/guide.md", "GUIDE.md"]) {
      expect(await read(root, file)).toBe(markdown.replace(oldPath, newPath));
    }
    expect(await read(root, "caller.ts")).toBe(`export const modulePath = "${newPath}";\n`);
    expect(await read(root, newPath)).toBe('export { value } from "../config";\n');
  }, 20_000);

  test("dry-run reports moves and rewrites while preserving file bytes and the existing git index", async () => {
    const files = {
      [`${core}/design-service.ts`]: 'export { config } from "./config";\n',
      [`${core}/config.ts`]: "export const config = 1;\n",
      [`${core}/caller.ts`]: 'import "./design-service.js";\n',
      "docs/guide.md": `${core}/design-service.ts\n`,
      "unrelated.ts": "export const unrelated={ messy:true}\n",
    };
    const root = await fixture(files);
    await write(root, "unrelated.ts", "export const staged={ messy:true}\n");
    run(root, ["git", "add", "--", "unrelated.ts"]);
    await write(root, "unrelated.ts", "export const unstaged={ messy:true}\n");
    const beforeFiles = await Promise.all(Object.keys(files).map((file) => read(root, file)));
    const beforeIndex = await readFile(path.join(root, ".git/index"));

    const output = move(root, ["--prefix", "design-", "--into", "design", "--dry-run"]);

    expect(output).toContain(`move ${core}/design-service.ts -> ${core}/design/service.ts`);
    for (const file of [`${core}/design-service.ts`, `${core}/caller.ts`, "docs/guide.md"]) {
      expect(output).toContain(`rewrite ${file}`);
    }
    expect(output).toContain("Would move 1 file(s); would rewrite 3 file(s).");
    expect(await Promise.all(Object.keys(files).map((file) => read(root, file)))).toEqual(
      beforeFiles,
    );
    expect(await readFile(path.join(root, ".git/index"))).toEqual(beforeIndex);
    expect(existsSync(path.join(root, `${core}/design`))).toBe(false);
  });
});
