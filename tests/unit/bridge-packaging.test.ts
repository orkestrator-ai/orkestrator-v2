/**
 * Every bridge this repository builds has to reach every place that runs one.
 *
 * A bridge is resolved at runtime by `getBridgePath`, which falls back to
 * `resourceRoot/<name>` outside development, and inside a container by an
 * absolute `/opt/<name>` path. Neither lookup fails loudly at build time: a
 * bridge missing from electron-builder's `extraResources` builds, ships, and
 * then reports "bridge directory not found" the first time a user selects it,
 * while container environments carry on working — which reads as an arbitrary
 * failure rather than a missing file.
 *
 * `bridges/cursor-bridge` shipped exactly that way. This enumerates the
 * bridges rather than listing them, so the next one cannot.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");
const miseTasks = (
  Bun.TOML.parse(read("mise.toml")) as {
    tasks: Record<string, { run?: string | string[] }>;
  }
).tasks;
const taskCommands = (name: string) => {
  const run = miseTasks[name]?.run;
  return Array.isArray(run) ? run.join("\n") : (run ?? "");
};

/**
 * Workspace packages under `bridges/`, excluding agent-harness directories and
 * anything that is not a package with a build script. Discovery and review
 * agents create `bridges/.claude/` (and similar) in this workspace; those are
 * not bridges and must not be read as `package.json`.
 */
function listBuildableBridges(bridgesRoot: string): string[] {
  return readdirSync(bridgesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => {
      const manifestPath = path.join(bridgesRoot, name, "package.json");
      if (!existsSync(manifestPath)) return false;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          scripts?: Record<string, string>;
        };
        return typeof manifest.scripts?.build === "string";
      } catch {
        return false;
      }
    })
    .sort();
}

/** Every workspace bridge that produces a `dist/index.js` a runtime can start. */
const buildableBridges = listBuildableBridges(path.join(root, "bridges"));

describe("bridge packaging", () => {
  test("there is at least one buildable bridge to check", () => {
    // Guards the enumeration itself: a discovery bug that found nothing would
    // otherwise make every assertion below vacuously pass.
    expect(buildableBridges.length).toBeGreaterThanOrEqual(4);
    expect(buildableBridges).toContain("cursor-bridge");
  });

  test("every buildable bridge is packaged into the desktop app's resources", () => {
    const manifest = JSON.parse(read("package.json")) as {
      build?: { extraResources?: Array<{ from?: string; to?: string; filter?: string[] }> };
    };
    const resources = manifest.build?.extraResources ?? [];

    for (const bridge of buildableBridges) {
      const entry = resources.find((resource) => resource.from === `bridges/${bridge}`);
      // `getBridgePath` resolves `resourceRoot/<name>` in a packaged app, so
      // the `to` has to be the bare bridge name.
      expect(entry, `bridges/${bridge} is missing from build.extraResources`).toBeDefined();
      expect(entry!.to).toBe(bridge);
      // The built bundle and its manifest are what a runtime needs; the SDK
      // closure a bridge vendors lives under `dist/` and travels with it.
      expect(entry!.filter).toContain("dist/**");
      expect(entry!.filter).toContain("package.json");
    }
  });

  test("every buildable bridge is built by `setup` and by the container image", () => {
    const dockerfile = read("docker/Dockerfile");

    for (const bridge of buildableBridges) {
      // A bridge nobody builds is a bridge nobody can start, whichever lookup
      // finds its directory.
      expect(taskCommands("setup"), `setup does not build ${bridge}`).toContain(`build:${bridge}`);
      expect(taskCommands(`build:${bridge}`)).toContain(`--filter=${bridge}`);
      expect(dockerfile, `the image does not install ${bridge}`).toContain(`--filter ${bridge}`);
      expect(dockerfile, `the image does not stage /opt/${bridge}`).toContain(`/opt/${bridge}`);
    }
  });

  test("ignores hidden agent directories and folders without a package manifest", async () => {
    const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "ork-bridge-enum-")));
    try {
      mkdirSync(path.join(fixture, ".claude"), { recursive: true });
      writeFileSync(path.join(fixture, ".claude", "settings.json"), "{}\n");
      mkdirSync(path.join(fixture, "not-a-package"), { recursive: true });
      writeFileSync(path.join(fixture, "not-a-package", "README.md"), "no manifest\n");
      mkdirSync(path.join(fixture, "broken-json"), { recursive: true });
      writeFileSync(path.join(fixture, "broken-json", "package.json"), "{not json");
      mkdirSync(path.join(fixture, "real-bridge"), { recursive: true });
      writeFileSync(
        path.join(fixture, "real-bridge", "package.json"),
        `${JSON.stringify({ scripts: { build: "bun build" } })}\n`,
      );

      expect(listBuildableBridges(fixture)).toEqual(["real-bridge"]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
