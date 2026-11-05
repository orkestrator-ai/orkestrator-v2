import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeWebPlatform } from "../register-dom";

// The root preload installs Happy DOM's Response, which `Bun.serve` rejects.
const Response = nativeWebPlatform.Response;

// install.sh's first run, with real `bun install`s against a registry on
// loopback. The script must do what the standalone service's `installRelease`
// does: the dependencies come from the lockfile the release publishes.
jest.setTimeout(60_000);

const root = path.resolve(import.meta.dir, "../..");
const INSTALL_SCRIPT = path.join(root, "apps/web-public/public/install.sh");
const RUNTIME = "resources/release-runtime";
const BUN = process.execPath;

type Published = {
  version: string;
  dependencies: Record<string, string>;
  tarball: ArrayBuffer;
  integrity: string;
};

const published = new Map<string, Published[]>();
let scratch: string;
let registry: string;
let server: ReturnType<typeof Bun.serve>;
let lockedManifest: string;
let lockedLockfile: string;

async function spawnBun(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([BUN, ...args], {
    cwd,
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(scratch, "fixture-cache") },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`bun ${args.join(" ")} failed:\n${stderr}`);
}

/** Packs a real tarball, whose lifecycle script would fail the install, into the registry. */
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
      ...(name === "orkestrator" ? { bin: { orkestrator: "bin/orkestrator.js" } } : {}),
      scripts: { postinstall: `"${BUN}" -e 'throw new Error("lifecycle script ran")'` },
    }),
  );
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), contents);
  }
  await spawnBun(["pm", "pack", "--quiet"], directory);
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
          // `bun x` reads the executable from the registry's metadata.
          ...(name === "orkestrator" ? { bin: { orkestrator: "bin/orkestrator.js" } } : {}),
          dist: {
            tarball: `${registry}/${name}/-/${name}-${release.version}.tgz`,
            integrity: release.integrity,
          },
        },
      ]),
    ),
  };
}

// The CLI's stand-in reports which dependency it resolved, where it runs from
// and what it was given, then exits with a code an argument chooses.
const ENTRY = `#!/usr/bin/env bun
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (args[0] === "--wait") {
  process.on("SIGTERM", () => { console.log("stopped by SIGTERM"); process.exit(0); });
  console.log("ready");
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({
    leaf: require("leaf/package.json").version,
    entry: import.meta.path,
    args,
  }));
  process.exit(args[0] === "--exit" ? Number(args[1]) : 0);
}
`;

function publishRelease(version: string, runtime: Record<string, string>): Promise<void> {
  return publish(
    "orkestrator",
    version,
    { mid: "1.0.0" },
    {
      "bin/orkestrator.js": ENTRY,
      ...Object.fromEntries(
        Object.entries(runtime).map(([file, contents]) => [`${RUNTIME}/${file}`, contents]),
      ),
    },
  );
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "ork-install-sh-locked-"));
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
      const releases = published.get(pathname.slice(1));
      return releases
        ? Response.json(packument(pathname.slice(1), releases))
        : new Response(null, { status: 404 });
    },
  });
  registry = `http://127.0.0.1:${server.port}`;

  await publish("leaf", "1.0.0", {});
  await publish("mid", "1.0.0", { leaf: "^1.0.0" });
  await publish("extra", "1.0.0", {});

  // What the release's lock step does, while leaf 1.0.0 is the newest leaf.
  const locking = await mkdtemp(path.join(scratch, "locking-"));
  lockedManifest = JSON.stringify({
    name: "orkestrator-release-runtime",
    private: true,
    dependencies: { mid: "1.0.0" },
  });
  await writeFile(path.join(locking, "package.json"), lockedManifest);
  await spawnBun(["install", "--lockfile-only", "--no-progress", "--registry", registry], locking);
  lockedLockfile = await readFile(path.join(locking, "bun.lock"), "utf8");

  await publishRelease("3.0.0", { "package.json": lockedManifest, "bun.lock": lockedLockfile });
  // A release from before the lockfile was published.
  await publish("orkestrator", "2.9.0", { mid: "1.0.0" }, { "bin/orkestrator.js": ENTRY });
  // Out of step: the manifest asks for what the lockfile does not record.
  await publishRelease("3.0.1", {
    "package.json": JSON.stringify({
      ...JSON.parse(lockedManifest),
      dependencies: { mid: "1.0.0", extra: "1.0.0" },
    }),
    "bun.lock": lockedLockfile,
  });
  // A runtime directory that lost its lockfile must not resolve afresh.
  await publishRelease("3.0.2", { "package.json": lockedManifest });

  // Published after the lock step: a fresh resolution now picks this one.
  await publish("leaf", "1.1.0", {});
});

afterAll(async () => {
  await server.stop(true);
  await rm(scratch, { recursive: true, force: true });
});

type Sandbox = { home: string; tmp: string; env: Record<string, string> };

async function sandbox(): Promise<Sandbox> {
  const directory = await mkdtemp(path.join(scratch, "host-"));
  const home = path.join(directory, "home");
  const tmp = path.join(directory, "tmp");
  const bin = path.join(directory, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(tmp, { recursive: true });
  await mkdir(bin, { recursive: true });
  // The host's Bun is the one on PATH; nothing is downloaded.
  await symlink(BUN, path.join(bin, "bun"));
  return {
    home,
    tmp,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: tmp,
      NPM_CONFIG_REGISTRY: registry,
      BUN_INSTALL_CACHE_DIR: path.join(directory, "host-cache"),
      ORKESTRATOR_INSTALL_VERSION: "3.0.0",
    },
  };
}

async function runInstaller(host: Sandbox, version: string, args: string[] = []) {
  const child = Bun.spawn(["/bin/bash", INSTALL_SCRIPT, ...args], {
    cwd: host.home,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...host.env, ORKESTRATOR_INSTALL_VERSION: version },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr };
}

/** The temporary directory is removed once the CLI has exited. */
async function eventuallyEmpty(directory: string): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const left = await readdir(directory);
    if (left.length === 0) return left;
    await Bun.sleep(100);
  }
  return readdir(directory);
}

describe("install.sh first run with real bun installs", () => {
  test("runs the release from its published lockfile, with no lifecycle scripts", async () => {
    const host = await sandbox();
    const result = await runInstaller(host, "3.0.0", ["--tailscale-serve", "a b"]);

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as { leaf: string; entry: string; args: string[] };
    // leaf 1.1.0 is newer and in range; only the lockfile keeps 1.0.0.
    expect(report.leaf).toBe("1.0.0");
    expect(report.args).toEqual(["--tailscale-serve", "a b"]);
    expect(report.entry.startsWith(host.tmp)).toBe(true);
    expect(report.entry).toEndWith("/release/node_modules/orkestrator/bin/orkestrator.js");
    expect(result.stderr).not.toContain("lifecycle script ran");
    expect(await eventuallyEmpty(host.tmp)).toEqual([]);
    // Nothing went into the host's own Bun cache.
    expect(existsSync(host.env.BUN_INSTALL_CACHE_DIR!)).toBe(false);
  });

  test("passes the CLI's exit status through", async () => {
    const host = await sandbox();
    const result = await runInstaller(host, "3.0.0", ["--exit", "7"]);

    expect(result.exitCode).toBe(7);
    expect(await eventuallyEmpty(host.tmp)).toEqual([]);
  });

  test("the CLI takes over the script's process, so a signal to it reaches the CLI", async () => {
    const host = await sandbox();
    const child = Bun.spawn(["/bin/bash", INSTALL_SCRIPT, "--wait"], {
      cwd: host.home,
      stdout: "pipe",
      stderr: "pipe",
      env: host.env,
    });
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("ready")) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    expect(output).toContain("ready");
    child.kill("SIGTERM");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    expect(await child.exited).toBe(0);
    expect(output).toContain("stopped by SIGTERM");
    expect(await eventuallyEmpty(host.tmp)).toEqual([]);
  });

  test("a release without a published lockfile still runs, resolving afresh", async () => {
    const host = await sandbox();
    const result = await runInstaller(host, "2.9.0");

    expect(result.exitCode).toBe(0);
    // What the lockfile prevents: this is why 3.0.0 above is not a coincidence.
    expect((JSON.parse(result.stdout) as { leaf: string }).leaf).toBe("1.1.0");
    expect(
      await readdir(host.tmp).then((left) =>
        left.filter((name) => name.startsWith("orkestrator-install.")),
      ),
    ).toEqual([]);
  });

  test("refuses a lockfile out of step with its manifest and runs nothing", async () => {
    const host = await sandbox();
    const result = await runInstaller(host, "3.0.1");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Could not install the locked dependencies of orkestrator@3.0.1",
    );
    expect(await readdir(host.tmp)).toEqual([]);
  });

  test("refuses a runtime with no lockfile rather than resolving afresh", async () => {
    const host = await sandbox();
    const result = await runInstaller(host, "3.0.2");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("publishes no bun.lock");
    expect(await readdir(host.tmp)).toEqual([]);
  });
});
