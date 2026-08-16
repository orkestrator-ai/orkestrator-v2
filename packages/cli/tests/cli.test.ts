import { afterAll, describe, expect, jest, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const temporaryDirectories: string[] = [];
const processes: Bun.Subprocess[] = [];

// Generous because these run alongside the rest of the workspace suite; the
// timeout only has to be shorter than Bun's own, so a stall reports the child's
// stderr instead of failing as an anonymous hang.
const READY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 10_000;

jest.setTimeout(40_000);

// Every artifact scripts/build.ts emits, relative to the package root.
const ARTIFACTS = [
  "dist/main.js",
  "resources/claude-bridge/dist/index.js",
  "resources/codex-bridge/dist/index.js",
];

// The workspaces whose sources those artifacts are bundled from.
const SOURCE_WORKSPACES = [
  "apps/backend/package.json",
  "bridges/claude-bridge/package.json",
  "bridges/codex-bridge/package.json",
];

// Bun emits unbundled imports as line-anchored ESM statements, so anchoring
// avoids matching import-like text inside bundled string data. `require("...")`
// is deliberately not scanned: ajv and ajv-formats are inlined into dist/main.js
// and embed `require("ajv/dist/runtime/...")` in their code-generation
// templates, where it is data rather than a module reference.
const STATIC_IMPORT = /^import(?:[^"';]*?from\s*)?\s*["']([^"']+)["']\s*;?$/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

type Manifest = {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  files?: string[];
  os?: string[];
  dependencies?: Record<string, string>;
};

type ReadyMessage = { type?: string; authFile?: string };

function readManifest(relative: string): Promise<Manifest> {
  return Bun.file(path.join(repositoryRoot, relative)).json() as Promise<Manifest>;
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
}

/**
 * The packages an artifact still resolves from node_modules at runtime. These
 * are exactly the ones the published manifest has to declare — everything else
 * scripts/build.ts inlined.
 */
async function unbundledPackages(artifact: string): Promise<string[]> {
  const source = await readFile(path.join(packageRoot, artifact), "utf8");
  const names = new Set<string>();
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (specifier.startsWith("node:")) continue;
      // Bun lists the modules it implements natively in builtinModules — `ws`
      // among them — so those resolve without ever being installed.
      const name = packageNameOf(specifier);
      if (builtinModules.includes(name)) continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

/** Waits for exit, escalating to SIGKILL so a wedged child cannot hang the run. */
async function stopPackagedBackend(child: Bun.Subprocess): Promise<number> {
  child.kill("SIGTERM");
  const escalation = setTimeout(() => child.kill("SIGKILL"), EXIT_TIMEOUT_MS);
  try {
    return await child.exited;
  } finally {
    clearTimeout(escalation);
  }
}

async function startPackagedBackend(
  environmentOverrides: Record<string, string> = {},
): Promise<{ child: Bun.Subprocess; dataDir: string; ready: ReadyMessage }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-cli-test-"));
  temporaryDirectories.push(dataDir);
  const child = Bun.spawn([
    process.execPath,
    path.join(packageRoot, "bin/orkestrator.js"),
    "--host", "127.0.0.1",
    "--port", "0",
    "--allow-non-tailscale-bind",
    "--data-dir", dataDir,
  ], {
    cwd: dataDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environmentOverrides },
  });
  processes.push(child);

  // Killing the child is what unblocks the loop. A backend that starts and then
  // stalls without writing or exiting leaves `reader.read()` pending forever, so
  // a deadline re-checked between reads would never be evaluated again.
  const expiry = setTimeout(() => child.kill("SIGTERM"), READY_TIMEOUT_MS);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let ready: ReadyMessage | undefined;
  try {
    while (!ready) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as ReadyMessage;
          if (message.type === "orkestrator-backend-ready") ready = message;
        } catch {
          // Human-readable startup logs precede the readiness contract.
        }
      }
    }
  } finally {
    clearTimeout(expiry);
    reader.releaseLock();
  }

  if (!ready) {
    await stopPackagedBackend(child);
    throw new Error(`Packaged backend did not become ready: ${await new Response(child.stderr).text()}`);
  }
  return { child, dataDir, ready };
}

afterAll(async () => {
  for (const child of processes) child.kill("SIGKILL");
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("orkestrator CLI package", () => {
  test("publishes a Bun executable with the application release version", async () => {
    const manifest = await readManifest("packages/cli/package.json");
    const rootManifest = await readManifest("package.json");
    const executable = await readFile(path.join(packageRoot, "bin/orkestrator.js"), "utf8");

    expect(manifest.name).toBe("orkestrator");
    expect(manifest.version).toBe(rootManifest.version);
    expect(manifest.bin).toEqual({ orkestrator: "bin/orkestrator.js" });
    expect(manifest.files).toContain("dist/");
    expect(manifest.files).toContain("resources/");
    expect(manifest.os).toEqual(["darwin", "linux"]);
    expect(executable.startsWith("#!/usr/bin/env bun\n")).toBe(true);

    // The shim must set every root main.ts derives its path defaults from, and
    // must defer to anything the caller already exported.
    for (const variable of [
      "NODE_ENV",
      "ORKESTRATOR_APP_ROOT",
      "ORKESTRATOR_RESOURCE_ROOT",
      "ORKESTRATOR_VERSION",
    ]) {
      expect(executable).toContain(`process.env.${variable} ??=`);
    }
  });

  test("stages a self-contained backend and both bridge entrypoints", async () => {
    await expect(Bun.file(path.join(packageRoot, "dist/main.js")).exists()).resolves.toBe(true);
    await expect(
      Bun.file(path.join(packageRoot, "resources/claude-bridge/dist/index.js")).exists(),
    ).resolves.toBe(true);
    await expect(
      Bun.file(path.join(packageRoot, "resources/codex-bridge/dist/index.js")).exists(),
    ).resolves.toBe(true);
  });

  test("declares exactly the packages its bundles resolve at runtime", async () => {
    const required = new Set<string>();
    for (const artifact of ARTIFACTS) {
      for (const name of await unbundledPackages(artifact)) required.add(name);
    }

    // Anything else scripts/build.ts leaves external must be added deliberately:
    // an undeclared one crashes the published package, and a declared-but-inlined
    // one is dead weight every `bunx orkestrator` user downloads.
    expect([...required].sort()).toEqual(["@anthropic-ai/claude-agent-sdk", "sharp"]);

    const manifest = await readManifest("packages/cli/package.json");
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([...required].sort());
  });

  test("pins each runtime dependency to a version its source workspace builds against", async () => {
    const dependencies = (await readManifest("packages/cli/package.json")).dependencies ?? {};
    const traced = new Set<string>();

    for (const relative of SOURCE_WORKSPACES) {
      const source = await readManifest(relative);
      for (const [name, range] of Object.entries(source.dependencies ?? {})) {
        const pin = dependencies[name];
        if (pin === undefined) continue;
        // Bundled against `range` but installed as `pin`: a bump in the source
        // workspace that is not mirrored here ships a mismatched published package.
        const label = `${name} (${relative})`;
        expect({ [label]: Bun.semver.satisfies(pin, range) }).toEqual({ [label]: true });
        traced.add(name);
      }
    }

    // A dependency no source workspace declares could never be checked above.
    expect([...traced].sort()).toEqual(Object.keys(dependencies).sort());
  });

  test("resolves every unbundled import from the directory its bundle ships in", async () => {
    for (const artifact of ARTIFACTS) {
      const directory = path.join(packageRoot, path.dirname(artifact));
      for (const name of await unbundledPackages(artifact)) {
        expect(() => Bun.resolveSync(name, directory)).not.toThrow();
      }
    }
  });

  test("packs the runtime payload and nothing else", async () => {
    // --ignore-scripts skips the prepack rebuild; the build task this suite
    // depends on has already produced the artifacts.
    const packed = Bun.spawn(
      [process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"],
      { cwd: packageRoot, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(packed.stdout).text(),
      packed.exited,
    ]);
    expect(exitCode).toBe(0);

    // The `files` allowlist has to win over the repo's `dist/` gitignore rule,
    // and sources must never reach the registry.
    const files = [...stdout.matchAll(/^packed\s+\S+\s+(.+)$/gm)].map((match) => match[1]!.trim());
    expect(files.sort()).toEqual([
      "README.md",
      "bin/orkestrator.js",
      "dist/main.js",
      "package.json",
      "resources/claude-bridge/dist/index.js",
      "resources/codex-bridge/dist/index.js",
    ]);
  });

  test("starts and gracefully stops the packaged backend", async () => {
    const { child, dataDir, ready } = await startPackagedBackend();
    expect(ready.authFile).toBe(path.join(dataDir, "gateway-auth.json"));
    await expect(stopPackagedBackend(child)).resolves.toBe(0);
  });

  test("starts when the caller's environment already sets NODE_ENV", async () => {
    // The shim only defaults NODE_ENV, so an inherited value survives. getBridgePath
    // consults the packaged resources root only outside development, and the package
    // has no `bridges/` directory to fall back to.
    const { child, dataDir, ready } = await startPackagedBackend({ NODE_ENV: "development" });
    expect(ready.authFile).toBe(path.join(dataDir, "gateway-auth.json"));
    await expect(stopPackagedBackend(child)).resolves.toBe(0);
  });
});
