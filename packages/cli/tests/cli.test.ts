import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { RELEASE_RUNTIME_PATH } from "@orkestrator/protocol/node/standalone-service";
import {
  BRIDGE_RUNTIMES_DIRECTORY,
  BUNDLED_BRIDGES,
  ON_DEMAND_BRIDGES,
  RELEASE_RUNTIME_DIRECTORY,
  RUNTIME_DESCRIPTOR,
  RUNTIME_SUBDIRECTORY,
} from "../scripts/bridges.js";
import {
  lockedPackages,
  releaseRuntimeManifest,
  runtimeManifest,
} from "../scripts/lock-bridge-runtimes.js";

const packageRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

const bridgeArtifact = (name: string) => `resources/${name}/dist/index.js`;

// Every complete artifact scripts/build.ts emits, relative to the package root.
// On-demand bridges are checked separately: their externals are installed by
// the backend from a runtime manifest, not declared by this package.
const ARTIFACTS = [
  "dist/client.js",
  "dist/main.js",
  // Spawned by dist/main.js for every Mermaid fence and HTML artifact preview.
  "dist/artifact-runtime/preview-worker.js",
  ...BUNDLED_BRIDGES.map((bridge) => bridgeArtifact(bridge.name)),
];

// The workspaces whose sources those artifacts are bundled from.
const SOURCE_WORKSPACES = [
  "apps/backend/package.json",
  ...BUNDLED_BRIDGES.map((bridge) => `bridges/${bridge.name}/package.json`),
];

/** Workspace bridges with a build script, the same enumeration as tests/unit/bridge-packaging.test.ts. */
function buildableBridges(): string[] {
  const bridgesRoot = path.join(repositoryRoot, "bridges");
  return readdirSync(bridgesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(bridgesRoot, name, "package.json"), "utf8"),
        ) as { scripts?: Record<string, string> };
        return typeof manifest.scripts?.build === "string";
      } catch {
        return false;
      }
    })
    .sort();
}

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

  test("stages a self-contained backend and every bridge entrypoint", async () => {
    await expect(Bun.file(path.join(packageRoot, "dist/main.js")).exists()).resolves.toBe(true);
    await expect(Bun.file(path.join(packageRoot, "dist/client.js")).exists()).resolves.toBe(true);
    for (const bridge of [...BUNDLED_BRIDGES, ...ON_DEMAND_BRIDGES]) {
      await expect(
        Bun.file(path.join(packageRoot, bridgeArtifact(bridge.name))).exists(),
      ).resolves.toBe(true);
    }
  });

  test("carries every buildable bridge, bundled or on demand", () => {
    // `bridges/cursor-bridge` once shipped only in the desktop app, and a
    // standalone backend failed the first Cursor session with "bridge
    // directory not found". Enumerating the workspace stops the next one.
    const carried = [...BUNDLED_BRIDGES, ...ON_DEMAND_BRIDGES].map((bridge) => bridge.name);
    expect(carried.sort()).toEqual(buildableBridges());
    expect(new Set(carried).size).toBe(carried.length);
  });

  test("keeps external exactly what each on-demand bridge's own build does", async () => {
    for (const bridge of ON_DEMAND_BRIDGES) {
      const manifest = await readManifest(`bridges/${bridge.name}/package.json`);
      const build = (manifest as { scripts?: Record<string, string> }).scripts?.build ?? "";
      const external = [...build.matchAll(/--external[ =](\S+)/g)].map((match) => match[1]!);
      expect({ [bridge.name]: [...bridge.external].sort() }).toEqual({
        [bridge.name]: external.sort(),
      });
      // And the bundle resolves nothing else at runtime. (An external that is
      // only ever imported for types leaves no import behind.)
      const unexpected = (await unbundledPackages(bridgeArtifact(bridge.name))).filter(
        (name) => !bridge.external.includes(name),
      );
      expect({ [bridge.name]: unexpected }).toEqual({ [bridge.name]: [] });
    }
  });

  test("commits each on-demand runtime manifest and lockfile in step with the bridge", async () => {
    const rootPatches =
      ((await readManifest("package.json")) as { patchedDependencies?: Record<string, string> })
        .patchedDependencies ?? {};
    for (const bridge of ON_DEMAND_BRIDGES) {
      const directory = path.join(packageRoot, BRIDGE_RUNTIMES_DIRECTORY, bridge.name);
      const committed = (await Bun.file(path.join(directory, "package.json")).json()) as {
        dependencies?: Record<string, string>;
        patchedDependencies?: Record<string, string>;
      };
      const lockfile = await readFile(path.join(directory, "bun.lock"), "utf8");

      // Every repository patch for a package the closure resolves applies here
      // too, or the standalone bridge would run code the repository never does.
      const locked = lockedPackages(lockfile);
      const patches = Object.fromEntries(
        Object.entries(rootPatches).filter(([key]) =>
          locked.has(key.slice(0, key.lastIndexOf("@"))),
        ),
      );
      // Regenerate with `bun packages/cli/scripts/lock-bridge-runtimes.ts`.
      expect(committed).toEqual(await runtimeManifest(bridge, patches));

      // `--frozen-lockfile` refuses a lockfile whose root does not match.
      for (const [name, version] of Object.entries(committed.dependencies ?? {})) {
        expect(lockfile).toContain(`"${name}": "${version}"`);
        expect(lockfile).toContain(`"${name}": ["${name}@${version}"`);
      }
      for (const [key, file] of Object.entries(committed.patchedDependencies ?? {})) {
        expect(lockfile).toContain(`"${key}": "${file}"`);
      }
    }
  });

  test("commits the release runtime's manifest and lockfile in step with the package", async () => {
    const directory = path.join(packageRoot, RELEASE_RUNTIME_DIRECTORY);
    const committed = (await Bun.file(path.join(directory, "package.json")).json()) as {
      dependencies?: Record<string, string>;
    };
    const lockfile = await readFile(path.join(directory, "bun.lock"), "utf8");

    // Regenerate with `bun packages/cli/scripts/lock-bridge-runtimes.ts`.
    expect(committed).toEqual(
      releaseRuntimeManifest(await readManifest("packages/cli/package.json")) as typeof committed,
    );
    expect(Object.keys(committed.dependencies ?? {}).length).toBeGreaterThan(0);
    for (const [name, version] of Object.entries(committed.dependencies ?? {})) {
      expect(lockfile).toContain(`"${name}": "${version}"`);
      expect(lockfile).toContain(`"${name}": ["${name}@${version}"`);
    }
    // The tarball carries this lockfile, so it cannot name the tarball's hash.
    expect(lockedPackages(lockfile).has("orkestrator")).toBe(false);

    // The build copies them where the standalone updater reads them.
    const staged = path.join(packageRoot, RELEASE_RUNTIME_PATH);
    expect(await readFile(path.join(staged, "bun.lock"), "utf8")).toBe(lockfile);
    expect(await Bun.file(path.join(staged, "package.json")).json()).toEqual(committed);
  });

  test("stages each on-demand bridge's install inputs and digest", async () => {
    for (const bridge of ON_DEMAND_BRIDGES) {
      const runtime = path.join(packageRoot, "resources", bridge.name, RUNTIME_SUBDIRECTORY);
      const descriptor = (await Bun.file(path.join(runtime, RUNTIME_DESCRIPTOR)).json()) as {
        bridge?: string;
        digest?: string;
      };
      expect(descriptor.bridge).toBe(bridge.name);
      // The backend accepts nothing else as a path segment.
      expect(descriptor.digest).toMatch(/^[0-9a-f]{16}$/);
      const manifest = (await Bun.file(path.join(runtime, "package.json")).json()) as {
        patchedDependencies?: Record<string, string>;
      };
      await expect(Bun.file(path.join(runtime, "bun.lock")).exists()).resolves.toBe(true);
      for (const file of Object.values(manifest.patchedDependencies ?? {})) {
        await expect(Bun.file(path.join(runtime, file)).exists()).resolves.toBe(true);
      }
    }
  });

  test("declares exactly the packages its bundles resolve at runtime", async () => {
    const required = new Set<string>();
    for (const artifact of ARTIFACTS) {
      for (const name of await unbundledPackages(artifact)) required.add(name);
    }

    // Anything else scripts/build.ts leaves external must be added deliberately:
    // an undeclared one crashes the published package, and a declared-but-inlined
    // one is dead weight every `bunx orkestrator` user downloads.
    expect([...required].sort()).toEqual([
      "@anthropic-ai/claude-agent-sdk",
      "playwright-core",
      "sharp",
    ]);

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
    const packed = Bun.spawn([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(packed.stdout).text(),
      packed.exited,
    ]);
    expect(exitCode).toBe(0);

    // The `files` allowlist has to win over the repo's `dist/` gitignore rule,
    // and sources must never reach the registry.
    const files = [...stdout.matchAll(/^packed\s+\S+\s+(.+)$/gm)].map((match) => match[1]!.trim());

    // The preview runtime the backend resolves beside dist/main.js. Its license
    // directories are named by bundle version, so only the files the backend
    // looks up by name are listed; the rest must be built output, not sources.
    const runtime = files.filter((file) => file.startsWith("dist/artifact-runtime/"));
    expect(runtime).toEqual(
      expect.arrayContaining([
        "dist/artifact-runtime/preview-worker.js",
        "dist/artifact-runtime/mermaid.min.js",
        "dist/artifact-runtime/seccomp_profile.json",
        "dist/artifact-runtime/THIRD_PARTY_NOTICES.txt",
        "dist/artifact-runtime/worker-context/Dockerfile",
        "dist/artifact-runtime/worker-context/package-lock.json",
        "dist/artifact-runtime/worker-context/package.json",
        "dist/artifact-runtime/worker-context/preview-worker.mjs",
      ]),
    );
    expect(runtime.filter((file) => /\.tsx?$/.test(file))).toEqual([]);

    expect(files.filter((file) => !runtime.includes(file)).sort()).toEqual([
      "README.md",
      "bin/orkestrator-launcher.js",
      "bin/orkestrator.js",
      "dist/client.js",
      "dist/main.js",
      "package.json",
      "resources/acp-bridge/dist/index.js",
      "resources/claude-bridge/dist/index.js",
      "resources/codex-bridge/dist/index.js",
      "resources/cursor-bridge/dist/index.js",
      "resources/cursor-bridge/runtime/bun.lock",
      "resources/cursor-bridge/runtime/install.json",
      "resources/cursor-bridge/runtime/package.json",
      "resources/cursor-bridge/runtime/patches/@cursor%2Fsdk@1.3.1.patch",
      "resources/pi-bridge/dist/index.js",
      "resources/pi-bridge/runtime/bun.lock",
      "resources/pi-bridge/runtime/install.json",
      "resources/pi-bridge/runtime/package.json",
      "resources/release-runtime/bun.lock",
      "resources/release-runtime/package.json",
    ]);
  });
});
