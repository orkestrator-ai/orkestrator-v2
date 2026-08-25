/**
 * The process cwd is the Shell tool's default working directory.
 *
 * `local.cwd` is the SDK workspace, but a Shell call that omits
 * `workingDirectory` runs from `process.cwd()` instead. These tests pin that
 * we actually enter the workspace, so a launcher that started us in the
 * bridge package cannot leave git and other relative commands outside the repo.
 *
 * They also pin the half that is easy to lose while fixing the first: the
 * bridge must *arrive* in the workspace rather than be started there. `bun`
 * reads `bunfig.toml` — `preload` included — from its working directory before
 * this bridge's own code runs, so a launcher that spawned us in the worktree
 * would let a cloned repository execute code in a host process holding the
 * Cursor credential path and the bridge token.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyWorkingDirectory, workingDirectory } from "./config.js";

describe("applyWorkingDirectory", () => {
  const original = process.cwd();

  afterEach(() => {
    process.chdir(original);
  });

  test("moves the process into the given workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "cursor-bridge-cwd-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "cursor-bridge-elsewhere-"));
    try {
      process.chdir(elsewhere);
      applyWorkingDirectory(workspace);
      expect(process.cwd()).toBe(realpathSync(workspace));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("defaults to the configured working directory", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "cursor-bridge-default-cwd-"));
    try {
      process.chdir(elsewhere);
      applyWorkingDirectory();
      expect(process.cwd()).toBe(realpathSync(workingDirectory));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("names the workspace when the directory is missing", () => {
    const missing = join(tmpdir(), `cursor-bridge-missing-${Date.now()}`);
    expect(() => applyWorkingDirectory(missing)).toThrow(/could not enter the workspace directory/);
    expect(() => applyWorkingDirectory(missing)).toThrow(missing);
  });
});

/**
 * `index.ts` is what orders the real process, not the import list of whichever
 * module happens to pull the SDK in. Exporting this file first is the whole
 * guarantee that `@cursor/sdk` is evaluated with the process already in the
 * workspace, so it is worth failing loudly if an import sort moves it.
 */
describe("the bridge entrypoint", () => {
  test("evaluates config before any module that can load the SDK", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const specifiers = Array.from(
      source.matchAll(/^(?:import|export)\b[^\n]*?["']([^"']+)["'];?$/gm),
      (match) => match[1],
    );
    expect(specifiers[0]).toBe("./config.js");
  });
});

/**
 * Spawned rather than asserted in process, because the property under test is
 * what `bun` itself does on the way in — which a same-process test has already
 * missed by the time it runs.
 */
function runBridgeScript(options: {
  /** The child's spawn cwd: stands in for the bridge package directory. */
  from: string;
  /** The child's `CWD`: stands in for the environment worktree. */
  workspace: string;
  body: string;
}): string {
  const result = spawnSync(process.execPath, ["-e", options.body], {
    cwd: options.from,
    env: {
      ...process.env,
      CWD: options.workspace,
      // Pinned so an ambient value cannot point `start()` at a real port or a
      // routable interface.
      PORT: "0",
      HOSTNAME: "127.0.0.1",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`bridge script exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe("the bridge process", () => {
  const roots: string[] = [];
  const configModule = pathToFileURL(join(import.meta.dir, "config.ts")).href;
  const serverModule = pathToFileURL(join(import.meta.dir, "server.ts")).href;

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A package directory to start in, a workspace to end up in, and a detour. */
  function fixture(): { packageRoot: string; workspace: string; elsewhere: string } {
    const root = mkdtempSync(join(tmpdir(), "cursor-bridge-process-"));
    roots.push(root);
    const directories = {
      packageRoot: join(root, "package"),
      workspace: join(root, "workspace"),
      elsewhere: join(root, "elsewhere"),
    };
    for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
    return directories;
  }

  test("enters the workspace at module load without bootstrapping from it", () => {
    const { packageRoot, workspace } = fixture();
    const preloadMarker = join(workspace, "preload-ran");
    // A repository-controlled bunfig, which `bun` would honour on the way in if
    // the launcher started this process in the worktree.
    writeFileSync(join(workspace, "bunfig.toml"), 'preload = ["./repo-preload.js"]\n');
    writeFileSync(
      join(workspace, "repo-preload.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "ran");\n`,
    );

    const cwd = runBridgeScript({
      from: packageRoot,
      workspace,
      body: `await import(${JSON.stringify(configModule)});
        process.stdout.write(process.cwd());`,
    });

    expect(cwd).toBe(realpathSync(workspace));
    expect(existsSync(preloadMarker)).toBe(false);
  });

  test("re-enters the workspace when start() runs after a later cwd change", () => {
    const { packageRoot, workspace, elsewhere } = fixture();

    const cwd = runBridgeScript({
      from: packageRoot,
      workspace,
      body: `await import(${JSON.stringify(configModule)});
        process.chdir(${JSON.stringify(elsewhere)});
        const server = await import(${JSON.stringify(serverModule)});
        await server.start();
        process.stdout.write(process.cwd());
        process.exit(0);`,
    });

    expect(cwd).toBe(realpathSync(workspace));
  });
});
