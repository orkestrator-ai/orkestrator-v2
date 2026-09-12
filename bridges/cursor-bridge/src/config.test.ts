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
import { applyWorkingDirectory, cursorSdkStateDirectoryPath, workingDirectory } from "./config.js";

describe("Cursor SDK state", () => {
  test("nests the SDK store below CURSOR_BRIDGE_STATE_DIR", () => {
    const previous = process.env.CURSOR_BRIDGE_STATE_DIR;
    const root = join(tmpdir(), "cursor-bridge-configured-state");
    try {
      process.env.CURSOR_BRIDGE_STATE_DIR = root;
      expect(cursorSdkStateDirectoryPath()).toBe(join(root, "cursor-sdk"));
      delete process.env.CURSOR_BRIDGE_STATE_DIR;
      expect(cursorSdkStateDirectoryPath()).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CURSOR_BRIDGE_STATE_DIR;
      else process.env.CURSOR_BRIDGE_STATE_DIR = previous;
    }
  });
});

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
  env?: NodeJS.ProcessEnv;
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
      ...options.env,
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
  const sdkRuntimeModule = pathToFileURL(join(import.meta.dir, "sdk-runtime.ts")).href;
  const cursorSdkModule = import.meta.resolve("@cursor/sdk");
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

  test("configures the SDK with the production store rooted below bridge state", () => {
    const { packageRoot, workspace } = fixture();
    const stateRoot = join(packageRoot, "state");
    const output = runBridgeScript({
      from: packageRoot,
      workspace,
      env: { CURSOR_BRIDGE_STATE_DIR: stateRoot },
      body: `const sdk = await import(${JSON.stringify(cursorSdkModule)});
        const configured = [];
        const original = sdk.Cursor.configure;
        sdk.Cursor.configure = (options) => {
          configured.push(options.local?.store);
          return original.call(sdk.Cursor, options);
        };
        const runtime = await import(${JSON.stringify(sdkRuntimeModule)});
        process.stdout.write(JSON.stringify({
          configuredOnce: configured.length === 1,
          configuredProductionStore: configured[0] === runtime.cursorLocalAgentStore,
          storeRoot: runtime.cursorLocalAgentStoreRoot,
        }));`,
    });

    expect(JSON.parse(output)).toEqual({
      configuredOnce: true,
      configuredProductionStore: true,
      storeRoot: join(stateRoot, "cursor-sdk"),
    });
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

/**
 * The host-run execution posture, pinned so it cannot drift silently.
 *
 * `sandboxEnabled` being false means a Cursor host tab runs `shell`, `write`
 * and `delete` against the user's machine with no approval surface — the SDK
 * offers no approval hook this bridge could park a call on. That is the same
 * answer every platform here gives locally (Grok's `--always-approve`, Pi's
 * default-off approval gate, Claude's local allow), and it is stated in
 * `docs/architecture/agent-engines.md` rather than left implicit.
 * Plan 12 replaces it with a uniform backend-owned policy; until then, changing
 * this default is a documentation change too.
 */
describe("the host execution posture", () => {
  function readSandboxDefault(env: NodeJS.ProcessEnv): string {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `const c = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "config.ts")).href)});
         process.stdout.write(String(c.sandboxEnabled));`,
      ],
      { env: { ...process.env, ...env }, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    return result.stdout.trim();
  }

  test("is ungated unless a launcher explicitly opts in", () => {
    expect(readSandboxDefault({ CURSOR_BRIDGE_SANDBOX: "" })).toBe("false");
  });

  test("only the exact opt-in value turns the SDK sandbox on", () => {
    expect(readSandboxDefault({ CURSOR_BRIDGE_SANDBOX: "1" })).toBe("true");
    // Anything else fails closed towards the documented default rather than
    // half-enabling a sandbox on a typo.
    expect(readSandboxDefault({ CURSOR_BRIDGE_SANDBOX: "true" })).toBe("false");
    expect(readSandboxDefault({ CURSOR_BRIDGE_SANDBOX: "0" })).toBe("false");
  });
});
