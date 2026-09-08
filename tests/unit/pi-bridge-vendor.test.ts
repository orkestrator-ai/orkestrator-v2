import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stageRuntimeClosure } from "../../bridges/pi-bridge/scripts/vendor";
import { PI_BRIDGE_RUNTIME_EXPORTS } from "../../bridges/pi-bridge/src/pi-sdk";

const execFileAsync = promisify(execFile);

type FixturePackage = {
  key: string;
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

describe("Pi bridge runtime vendoring", () => {
  test("loads Pi's supported SDK from the staged runtime closure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-vendor-live-test-"));
    const packageRoot = path.resolve(import.meta.dir, "../../bridges/pi-bridge");
    const stagedModules = path.join(root, "node_modules");
    const entryPackages = [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-server",
    ] as const;

    try {
      await stageRuntimeClosure({ packageRoot, destination: stagedModules, entryPackages });

      const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
      for (const name of entryPackages) {
        const staged = JSON.parse(
          await readFile(path.join(stagedModules, name, "package.json"), "utf8"),
        );
        expect(staged.version).toBe(manifest.dependencies[name]);
      }

      // Pi 0.85.1 removes the accidentally published experimental worker.
      // Probe the public entrypoint the bridge uses, resolving only from the
      // staged tree, without creating a session or making a model request.
      await execFileAsync(
        process.execPath,
        [
          "--eval",
          'const sdk = await import("@earendil-works/pi-coding-agent"); ' +
            `for (const name of ${JSON.stringify(PI_BRIDGE_RUNTIME_EXPORTS)}) ` +
            'if (typeof sdk[name] !== "function") throw new Error("Missing SDK export: " + name);',
        ],
        { cwd: root, timeout: 15_000, maxBuffer: 128 * 1024 },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("preserves nested versions and remains resolvable without the source install", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-vendor-test-"));
    const sourceModules = path.join(root, "source", "node_modules");
    const store = path.join(sourceModules, ".bun");
    const stagedModules = path.join(root, "staged", "node_modules");
    const packages: FixturePackage[] = [
      {
        key: "entry@1.0.0",
        name: "entry",
        version: "1.0.0",
        dependencies: { consumer: "1.0.0", shared: "1.0.0" },
      },
      {
        key: "consumer@1.0.0",
        name: "consumer",
        version: "1.0.0",
        dependencies: { shared: "2.0.0" },
      },
      { key: "shared@1.0.0", name: "shared", version: "1.0.0" },
      { key: "shared@2.0.0", name: "shared", version: "2.0.0" },
    ];
    const packagePath = (fixture: FixturePackage) =>
      path.join(store, fixture.key, "node_modules", fixture.name);
    const byKey = new Map(packages.map((fixture) => [fixture.key, fixture]));

    try {
      for (const fixture of packages) {
        const directory = packagePath(fixture);
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({
            name: fixture.name,
            version: fixture.version,
            dependencies: fixture.dependencies,
          }),
        );
      }
      const linkDependency = async (fromKey: string, name: string, toKey: string) => {
        const from = byKey.get(fromKey)!;
        const to = byKey.get(toKey)!;
        const link = path.join(store, from.key, "node_modules", name);
        await mkdir(path.dirname(link), { recursive: true });
        await symlink(path.relative(path.dirname(link), packagePath(to)), link, "dir");
      };
      await linkDependency("entry@1.0.0", "consumer", "consumer@1.0.0");
      await linkDependency("entry@1.0.0", "shared", "shared@1.0.0");
      await linkDependency("consumer@1.0.0", "shared", "shared@2.0.0");

      await mkdir(sourceModules, { recursive: true });
      const sourceEntry = path.join(sourceModules, "entry");
      await symlink(
        path.relative(path.dirname(sourceEntry), packagePath(packages[0])),
        sourceEntry,
        "dir",
      );

      const result = await stageRuntimeClosure({
        packageRoot: path.join(root, "source"),
        destination: stagedModules,
        entryPackages: ["entry"],
      });
      expect(result.packageCount).toBe(4);

      // The staged graph must not accidentally keep absolute links back into the
      // workspace install that built it.
      await rm(sourceModules, { recursive: true, force: true });
      const requireFromStage = createRequire(path.join(root, "staged", "probe.cjs"));
      const entryManifest = requireFromStage.resolve("entry/package.json");
      const requireFromEntry = createRequire(entryManifest);
      const consumerManifest = requireFromEntry.resolve("consumer/package.json");
      const entryShared = requireFromEntry.resolve("shared/package.json");
      const consumerShared = createRequire(consumerManifest).resolve("shared/package.json");

      expect(JSON.parse(await readFile(entryShared, "utf8")).version).toBe("1.0.0");
      expect(JSON.parse(await readFile(consumerShared, "utf8")).version).toBe("2.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("links undeclared runtime roots inside every staged entry store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-vendor-cross-root-test-"));
    const sourceModules = path.join(root, "source", "node_modules");
    const store = path.join(sourceModules, ".bun");
    const stagedModules = path.join(root, "staged", "node_modules");
    const requester = {
      key: "requester@1.0.0",
      name: "requester",
      version: "1.0.0",
    } satisfies FixturePackage;
    const runtimeRoot = {
      key: "runtime-root@1.0.0",
      name: "runtime-root",
      version: "1.0.0",
    } satisfies FixturePackage;
    const packagePath = (fixture: FixturePackage) =>
      path.join(store, fixture.key, "node_modules", fixture.name);

    try {
      for (const fixture of [requester, runtimeRoot]) {
        const directory = packagePath(fixture);
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({ name: fixture.name, version: fixture.version, main: "index.cjs" }),
        );
      }
      await writeFile(
        path.join(packagePath(requester), "index.cjs"),
        'module.exports = require("runtime-root");\n',
      );
      await writeFile(
        path.join(packagePath(runtimeRoot), "index.cjs"),
        'module.exports = "linked";\n',
      );

      await mkdir(sourceModules, { recursive: true });
      for (const fixture of [requester, runtimeRoot]) {
        const sourceEntry = path.join(sourceModules, fixture.name);
        await symlink(
          path.relative(path.dirname(sourceEntry), packagePath(fixture)),
          sourceEntry,
          "dir",
        );
      }

      const result = await stageRuntimeClosure({
        packageRoot: path.join(root, "source"),
        destination: stagedModules,
        entryPackages: [requester.name, runtimeRoot.name],
      });
      expect(result.packageCount).toBe(2);

      // Remove both resolution fallbacks: the source install and the staged
      // top-level root. The requester can now load runtime-root only through
      // the cross-entry link created inside its isolated Bun store.
      await rm(sourceModules, { recursive: true, force: true });
      await unlink(path.join(stagedModules, runtimeRoot.name));
      const requireFromStage = createRequire(path.join(root, "staged", "probe.cjs"));
      const requesterManifest = requireFromStage.resolve(`${requester.name}/package.json`);
      expect(createRequire(requesterManifest)(requester.name)).toBe("linked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
