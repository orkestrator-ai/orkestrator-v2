import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installRelease,
  readReleaseManifest,
  RELEASE_RUNTIME_PATH,
  releaseDirectory,
  releaseEntry,
  runFile,
  standaloneLayout,
  type CommandRunner,
} from "./standalone-service.js";

// Real `bun install` runs against a registry on loopback.
jest.setTimeout(60_000);

type Published = {
  version: string;
  dependencies: Record<string, string>;
  tarball: ArrayBuffer;
  integrity: string;
};

const BUN = process.execPath;
const published = new Map<string, Published[]>();
let scratch: string;
let registry: string;
let server: ReturnType<typeof Bun.serve>;
let lockedManifest: string;
let lockedLockfile: string;

async function spawn(args: string[], cwd: string, cache: string): Promise<void> {
  const child = Bun.spawn([BUN, ...args], {
    cwd,
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: cache },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`bun ${args.join(" ")} failed:\n${stderr}`);
}

/** Packs a real tarball and adds it to the fixture registry. */
async function publish(
  name: string,
  version: string,
  dependencies: Record<string, string>,
  files: Record<string, string> = {},
): Promise<void> {
  const directory = await mkdtemp(path.join(scratch, "package-"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name,
      version,
      dependencies,
      scripts: { postinstall: `"${BUN}" -e 'throw new Error("lifecycle script ran")'` },
    }),
  );
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), contents);
  }
  await spawn(["pm", "pack", "--quiet"], directory, path.join(scratch, "pack-cache"));
  const tarball = await Bun.file(path.join(directory, `${name}-${version}.tgz`)).arrayBuffer();
  const integrity = `sha512-${createHash("sha512").update(new Uint8Array(tarball)).digest("base64")}`;
  published.set(name, [
    ...(published.get(name) ?? []),
    { version, dependencies, tarball, integrity },
  ]);
}

function packument(name: string, releases: Published[]): unknown {
  return {
    name,
    "dist-tags": { latest: releases.at(-1)!.version },
    versions: Object.fromEntries(
      releases.map((release) => [
        release.version,
        {
          name,
          version: release.version,
          dependencies: release.dependencies,
          dist: {
            tarball: `${registry}/${name}/-/${name}-${release.version}.tgz`,
            integrity: release.integrity,
          },
        },
      ]),
    ),
  };
}

const ENTRY = {
  "bin/orkestrator.js": "console.log(require('mid'));\n",
  "bin/orkestrator-launcher.js": "// launcher\n",
};

/** Publishes a release carrying this manifest and lockfile as its runtime. */
function publishRelease(version: string, manifest: string, lockfile: string): Promise<void> {
  return publish(
    "orkestrator",
    version,
    { mid: "1.0.0" },
    {
      ...ENTRY,
      [`${RELEASE_RUNTIME_PATH}/package.json`]: manifest,
      [`${RELEASE_RUNTIME_PATH}/bun.lock`]: lockfile,
    },
  );
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "ork-release-install-"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const tarball = /^\/([^/]+)\/-\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/.exec(pathname);
      if (tarball) {
        const release = published.get(tarball[1]!)?.find((item) => item.version === tarball[2]);
        return release ? new Response(release.tarball) : new Response(null, { status: 404 });
      }
      const name = pathname.slice(1);
      const releases = published.get(name);
      return releases
        ? Response.json(packument(name, releases))
        : new Response(null, { status: 404 });
    },
  });
  registry = `http://127.0.0.1:${server.port}`;

  await publish("leaf", "1.0.0", {}, { "index.js": "module.exports = '1.0.0';\n" });
  await publish(
    "mid",
    "1.0.0",
    { leaf: "^1.0.0" },
    {
      "index.js": "module.exports = require('leaf');\n",
    },
  );
  await publish("extra", "1.0.0", {});

  // What the release's lock step does, while leaf 1.0.0 is the newest leaf.
  const locking = await mkdtemp(path.join(scratch, "locking-"));
  lockedManifest = JSON.stringify({
    name: "orkestrator-release-runtime",
    private: true,
    scripts: { postinstall: `"${BUN}" -e 'throw new Error("runtime lifecycle script ran")'` },
    trustedDependencies: ["mid"],
    dependencies: { mid: "1.0.0" },
  });
  await writeFile(path.join(locking, "package.json"), lockedManifest);
  await spawn(
    ["install", "--lockfile-only", "--no-progress", "--registry", registry],
    locking,
    path.join(scratch, "lock-cache"),
  );
  lockedLockfile = await readFile(path.join(locking, "bun.lock"), "utf8");

  await publishRelease("2.0.0", lockedManifest, lockedLockfile);
  // A release from before the lockfile was published.
  await publish("orkestrator", "1.9.0", { mid: "1.0.0" }, ENTRY);
  // Out of step: the manifest asks for what the lockfile does not record.
  await publishRelease(
    "2.0.1",
    JSON.stringify({
      ...JSON.parse(lockedManifest),
      dependencies: { mid: "1.0.0", extra: "1.0.0" },
    }),
    lockedLockfile,
  );
  // A lockfile naming a hash the tarball does not have.
  const leafIntegrity = published.get("leaf")![0]!.integrity;
  expect(lockedLockfile).toContain(leafIntegrity);
  const otherHash = `sha512-${createHash("sha512").update("other").digest("base64")}`;
  await publishRelease("2.0.2", lockedManifest, lockedLockfile.replace(leafIntegrity, otherHash));
  // A runtime directory that lost its lockfile must not resolve afresh.
  await publish(
    "orkestrator",
    "2.0.3",
    { mid: "1.0.0" },
    { ...ENTRY, [`${RELEASE_RUNTIME_PATH}/package.json`]: lockedManifest },
  );

  // Published after the lock step: a fresh resolution now picks this one.
  await publish("leaf", "1.1.0", {}, { "index.js": "module.exports = '1.1.0';\n" });
});

afterAll(async () => {
  await server.stop(true);
  await rm(scratch, { recursive: true, force: true });
});

describe("installRelease with real bun installs", () => {
  let dataDir: string;
  let run: CommandRunner;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(scratch, "data-"));
    // Use a caller cache that can be removed independently of the release.
    const cache = path.join(dataDir, "bun-cache");
    run = async (file, args, options) => {
      // A caller's isolated global store must not make a published release
      // depend on install-cache links outside its directory.
      await writeFile(
        path.join(options.cwd!, "bunfig.toml"),
        '[install]\nlinker = "isolated"\nglobalStore = true\n',
      );
      return runFile(file, args, {
        ...options,
        env: {
          ...process.env,
          BUN_INSTALL_CACHE_DIR: cache,
          ...options?.env,
          HOME: dataDir,
          BUN_INSTALL: path.join(dataDir, ".bun"),
        },
      });
    };
  });

  async function installedVersion(releaseDir: string, name: string): Promise<string> {
    const manifest = path.join(releaseDir, "node_modules", name, "package.json");
    return (JSON.parse(await readFile(manifest, "utf8")) as { version: string }).version;
  }

  async function executedVersion(releaseDir: string): Promise<string> {
    // Exercise resolution from the published entry, after its staging directory
    // was renamed and the caller's package store is gone. A manifest check alone
    // can pass while an isolated-store symlink still points outside the release.
    await rm(path.join(dataDir, "bun-cache"), { recursive: true, force: true });
    const executed = await runFile(BUN, [releaseEntry(releaseDir)], {
      cwd: dataDir,
      timeoutMs: 5_000,
      env: {
        ...process.env,
        HOME: dataDir,
        BUN_INSTALL: path.join(dataDir, ".bun"),
        BUN_INSTALL_CACHE_DIR: path.join(dataDir, "bun-cache"),
      },
    });
    return executed.stdout.trim();
  }

  function leftInReleases(): string[] {
    const releases = standaloneLayout(dataDir).releases;
    return existsSync(releases) ? readdirSync(releases) : [];
  }

  test("installs locked versions without executing root or trusted dependency lifecycle scripts", async () => {
    const layout = standaloneLayout(dataDir);
    const releaseDir = await installRelease(layout, "2.0.0", { bun: BUN, run, registry });

    expect(releaseDir).toBe(releaseDirectory(layout, "2.0.0"));
    expect(readReleaseManifest(releaseDir)?.version).toBe("2.0.0");
    expect(await installedVersion(releaseDir, "mid")).toBe("1.0.0");
    expect(await installedVersion(releaseDir, "leaf")).toBe("1.0.0");
    expect(await executedVersion(releaseDir)).toBe("1.0.0");
    expect(await readFile(path.join(releaseDir, "bun.lock"), "utf8")).toBe(lockedLockfile);
    // The fetch install's resolution left nothing behind.
    expect(leftInReleases()).toEqual(["2.0.0"]);
    expect(existsSync(path.join(releaseDir, ".cache"))).toBe(false);
  });

  test("a release without a published lockfile still installs, resolving afresh", async () => {
    const releaseDir = await installRelease(standaloneLayout(dataDir), "1.9.0", {
      bun: BUN,
      run,
      registry,
    });

    expect(readReleaseManifest(releaseDir)?.version).toBe("1.9.0");
    expect(await executedVersion(releaseDir)).toBe("1.1.0");
    // What the lockfile prevents: this is why 2.0.0 above is not a coincidence.
    expect(await installedVersion(releaseDir, "leaf")).toBe("1.1.0");
  });

  test("refuses a lockfile out of step with its manifest and leaves no release", async () => {
    await expect(
      installRelease(standaloneLayout(dataDir), "2.0.1", { bun: BUN, run, registry }),
    ).rejects.toThrow("lockfile is frozen");
    expect(leftInReleases()).toEqual([]);
  });

  test("refuses a tarball whose hash the lockfile does not name and leaves no release", async () => {
    await expect(
      installRelease(standaloneLayout(dataDir), "2.0.2", { bun: BUN, run, registry }),
    ).rejects.toThrow();
    expect(leftInReleases()).toEqual([]);
  });

  test("rejects a wrong hash even when fetch caches the locked version", async () => {
    const releases = published.get("leaf")!;
    published.set(
      "leaf",
      releases.filter((release) => release.version === "1.0.0"),
    );
    try {
      await expect(
        installRelease(standaloneLayout(dataDir), "2.0.2", { bun: BUN, run, registry }),
      ).rejects.toThrow(/integrity/i);
      expect(leftInReleases()).toEqual([]);
    } finally {
      published.set("leaf", releases);
    }
  });

  test("refuses a runtime with no lockfile rather than resolving afresh", async () => {
    await expect(
      installRelease(standaloneLayout(dataDir), "2.0.3", { bun: BUN, run, registry }),
    ).rejects.toThrow("bun.lock");
    expect(leftInReleases()).toEqual([]);
  });
});
