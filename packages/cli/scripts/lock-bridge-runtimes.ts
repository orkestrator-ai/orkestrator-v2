/**
 * Regenerate `bridge-runtimes/<bridge>/{package.json,bun.lock}` for every
 * on-demand bridge.
 *
 * Run after bumping an SDK an on-demand bridge keeps external, or after
 * changing a patch in `patches/` that targets one of its packages:
 *
 *   bun packages/cli/scripts/lock-bridge-runtimes.ts
 *
 * The manifest pins exactly the versions the bridge's own `package.json` builds
 * against, plus the repository's patches for any package in the closure. The
 * lockfile is what makes the backend's install reproducible: it runs
 * `bun install --frozen-lockfile`, so every transitive version and integrity
 * hash is the one committed here. `tests/cli.test.ts` fails when either file
 * drifts from what this script would write.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BRIDGE_RUNTIMES_DIRECTORY, ON_DEMAND_BRIDGES, type OnDemandBridge } from "./bridges.js";

const packageRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

type Manifest = {
  dependencies?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
};

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** `name@version` keys, the way bun records patches, split into their parts. */
function patchTarget(key: string): { name: string; version: string } {
  const at = key.lastIndexOf("@");
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/** Package names a text `bun.lock` resolves, from its `packages` table values. */
export function lockedPackages(lockfile: string): Set<string> {
  const names = new Set<string>();
  for (const match of lockfile.matchAll(/^\s+"[^"]+": \["((?:@[^/"]+\/)?[^@"]+)@[^"]*"/gm)) {
    names.add(match[1]!);
  }
  return names;
}

/** The runtime manifest for a bridge, with the given repository patches. */
export async function runtimeManifest(
  bridge: OnDemandBridge,
  patches: Record<string, string>,
): Promise<Record<string, unknown>> {
  const source = await readJson<Manifest>(
    path.join(repositoryRoot, "bridges", bridge.name, "package.json"),
  );
  const dependencies: Record<string, string> = {};
  for (const name of bridge.external) {
    const version = source.dependencies?.[name];
    if (!version) throw new Error(`bridges/${bridge.name} does not depend on ${name}`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`bridges/${bridge.name} must pin ${name} exactly, found "${version}"`);
    }
    dependencies[name] = version;
  }
  return {
    name: `orkestrator-${bridge.name}-runtime`,
    private: true,
    type: "module",
    dependencies,
    ...(Object.keys(patches).length > 0 ? { patchedDependencies: patches } : {}),
  };
}

/** Root patches whose target package is in `names`, keyed the way bun keys them. */
async function patchesFor(names: Set<string>): Promise<Record<string, string>> {
  const root = await readJson<Manifest>(path.join(repositoryRoot, "package.json"));
  const selected: Record<string, string> = {};
  for (const [key, file] of Object.entries(root.patchedDependencies ?? {})) {
    if (names.has(patchTarget(key).name)) selected[key] = file;
  }
  return selected;
}

async function lock(manifest: Record<string, unknown>): Promise<string> {
  const staging = await mkdtemp(path.join(tmpdir(), "orkestrator-bridge-runtime-"));
  try {
    await writeFile(path.join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const patches = (manifest.patchedDependencies ?? {}) as Record<string, string>;
    for (const file of Object.values(patches)) {
      await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
      await cp(path.join(repositoryRoot, file), path.join(staging, file));
    }
    const child = Bun.spawn([process.execPath, "install", "--lockfile-only", "--no-progress"], {
      cwd: staging,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (exitCode !== 0) throw new Error(`bun install --lockfile-only failed:\n${stderr}`);
    return await readFile(path.join(staging, "bun.lock"), "utf8");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function lockBridgeRuntime(bridge: OnDemandBridge): Promise<void> {
  // Patches are chosen by what the closure contains, which is only known once
  // it has been resolved: lock without them first, then again with any match.
  const unpatched = await runtimeManifest(bridge, {});
  const patches = await patchesFor(lockedPackages(await lock(unpatched)));
  const manifest = await runtimeManifest(bridge, patches);
  const lockfile = await lock(manifest);

  const destination = path.join(packageRoot, BRIDGE_RUNTIMES_DIRECTORY, bridge.name);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(destination, "bun.lock"), lockfile);
  console.log(
    `${path.relative(repositoryRoot, destination)}: ${Object.keys(patches).length} patch(es)`,
  );
}

if (import.meta.main) {
  for (const bridge of ON_DEMAND_BRIDGES) await lockBridgeRuntime(bridge);
}
