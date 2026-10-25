import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
  test("stops dequeuing after copy failure and waits for active writes before rejecting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-vendor-failed-copy-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "staged", "node_modules");
    const names = Array.from({ length: 14 }, (_, i) => `entry-${i}`);
    const started = Promise.withResolvers<void>();
    const fail = Promise.withResolvers<void>();
    const active = Promise.withResolvers<void>();
    const failure = new Error("injected copy failure");
    const copies: string[] = [];
    let finishedWrites = 0;
    let settled = false;
    let staging: Promise<unknown> | undefined;
    try {
      for (const name of names) {
        const directory = path.join(
          source,
          "node_modules",
          ".bun",
          `${name}@1`,
          "node_modules",
          name,
        );
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "package.json"), JSON.stringify({ name }));
        await symlink(directory, path.join(source, "node_modules", name));
      }
      staging = stageRuntimeClosure({
        packageRoot: source,
        destination,
        entryPackages: names,
        copy: async (from, to, options) => {
          copies.push(String(from));
          if (copies.length === 12) started.resolve();
          if (String(from).endsWith("entry-0@1")) await fail.promise;
          else await active.promise;
          await cp(from, to, options);
          finishedWrites += 1;
        },
      }).then(
        () => {
          settled = true;
          return undefined;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await started.promise;
      fail.reject(failure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(copies).toHaveLength(12);
      active.resolve();
      expect(await staging).toBe(failure);
      expect(finishedWrites).toBe(11);
      expect(copies).toHaveLength(12);
      await expect(readFile(path.join(destination, "entry-1", "package.json"))).rejects.toThrow();
    } finally {
      fail.resolve();
      active.resolve();
      await staging;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loads Pi's supported SDK from the staged runtime closure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-vendor-live-test-"));
    const packageRoot = path.resolve(import.meta.dir, "../../bridges/pi-bridge");
    const stagedModules = path.join(root, "node_modules");
    const entryPackages = [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
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
    const packages: [FixturePackage, ...FixturePackage[]] = [
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

  test("stages packages linked from Bun's global store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-vendor-global-store-test-"));
    const sourceModules = path.join(root, "source", "node_modules");
    const store = path.join(sourceModules, ".bun");
    // `install.globalStore` links project entries into this directory, adding a
    // content-hash suffix to each entry name.
    const links = path.join(root, "home", ".bun", "install", "cache", "links");
    const stagedModules = path.join(root, "staged", "node_modules");
    const hash = "0123456789abcdef";

    const writePackage = async (directory: string, name: string, dependencies = {}) => {
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({ name, version: "1.0.0", dependencies }),
      );
    };
    const link = async (target: string, linkPath: string) => {
      await mkdir(path.dirname(linkPath), { recursive: true });
      await symlink(path.relative(path.dirname(linkPath), target), linkPath, "dir");
    };

    try {
      // A global entry depends on a global sibling.
      const sharedPackage = path.join(links, `shared@1.0.0-${hash}`, "node_modules", "shared");
      const globalPackage = path.join(links, `global@1.0.0-${hash}`, "node_modules", "global");
      await writePackage(sharedPackage, "shared");
      await writePackage(globalPackage, "global", { shared: "1.0.0" });
      await link(sharedPackage, path.join(links, `global@1.0.0-${hash}`, "node_modules", "shared"));
      // A local (for example patched) entry depends on that sibling through
      // the project store's unsuffixed name.
      const localPackage = path.join(store, "local@1.0.0", "node_modules", "local");
      await writePackage(localPackage, "local", { shared: "1.0.0" });
      await link(
        path.join(store, "shared@1.0.0", "node_modules", "shared"),
        path.join(store, "local@1.0.0", "node_modules", "shared"),
      );
      await symlink(path.join(links, `shared@1.0.0-${hash}`), path.join(store, "shared@1.0.0"));
      await symlink(path.join(links, `global@1.0.0-${hash}`), path.join(store, "global@1.0.0"));
      await link(
        path.join(store, "global@1.0.0", "node_modules", "global"),
        path.join(sourceModules, "global"),
      );
      await link(localPackage, path.join(sourceModules, "local"));

      const result = await stageRuntimeClosure({
        packageRoot: path.join(root, "source"),
        destination: stagedModules,
        entryPackages: ["global", "local"],
      });
      expect(result.packageCount).toBe(3);

      await rm(path.join(root, "source"), { recursive: true, force: true });
      await rm(path.join(root, "home"), { recursive: true, force: true });
      const requireFromStage = createRequire(path.join(root, "staged", "probe.cjs"));
      for (const entry of ["global", "local"]) {
        const manifest = requireFromStage.resolve(`${entry}/package.json`);
        const shared = createRequire(manifest).resolve("shared/package.json");
        expect(JSON.parse(await readFile(shared, "utf8")).name).toBe("shared");
      }
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
