import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageRuntimeClosure } from "../../bridges/pi-bridge/scripts/vendor";

type FixturePackage = {
  key: string;
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

describe("Pi bridge runtime vendoring", () => {
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
});
