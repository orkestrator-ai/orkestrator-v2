/**
 * Stage the Pi SDK runtime closure beside the built bridge without flattening
 * Bun's isolated dependency graph.
 *
 * Several providers deliberately carry two versions of the same dependency.
 * Copying one package per name into a flat `dist/node_modules` makes Node give
 * every requester whichever version happened to be visited first. Instead,
 * retain Bun's `.bun/<instance>/node_modules` stores and their relative links,
 * then expose only the bridge's direct external packages at the top level.
 */
import { cp, mkdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const destination = path.join(packageRoot, "dist", "node_modules");
const ENTRY_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
] as const;

/** Resolve a package by walking up `node_modules` from a starting directory. */
async function resolvePackage(name: string, from: string): Promise<string | undefined> {
  let directory = from;
  while (true) {
    const candidate = path.join(directory, "node_modules", name);
    const found = await stat(path.join(candidate, "package.json")).then(
      () => true,
      () => false,
    );
    if (found) return realpath(candidate);
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function readManifest(directory: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function dependencyNames(manifest: Record<string, unknown>): string[] {
  const names = new Set<string>();
  // Bun materializes satisfied peers as links in the requester's isolated
  // store. Retain those targets too; otherwise the copied graph contains broken
  // links and optional features see a different environment after packaging.
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const record = manifest[field];
    if (record && typeof record === "object") {
      for (const name of Object.keys(record)) names.add(name);
    }
  }
  return Array.from(names);
}

type BunStorePackage = {
  packageRoot: string;
  storeKey: string;
  storeRoot: string;
};

function bunStorePackage(resolvedPackage: string): BunStorePackage {
  const marker = `${path.sep}node_modules${path.sep}.bun${path.sep}`;
  const markerIndex = resolvedPackage.lastIndexOf(marker);
  if (markerIndex === -1) {
    throw new Error(
      `Pi bridge vendoring requires Bun's isolated node_modules layout: ${resolvedPackage}`,
    );
  }
  const storeKeyStart = markerIndex + marker.length;
  const storeKeyEnd = resolvedPackage.indexOf(path.sep, storeKeyStart);
  if (storeKeyEnd === -1) throw new Error(`Invalid Bun store path: ${resolvedPackage}`);
  const storeKey = resolvedPackage.slice(storeKeyStart, storeKeyEnd);
  return {
    packageRoot: resolvedPackage,
    storeKey,
    storeRoot: resolvedPackage.slice(0, storeKeyEnd),
  };
}

export async function stageRuntimeClosure(options: {
  packageRoot: string;
  destination: string;
  entryPackages: readonly string[];
}): Promise<{ packageCount: number; unavailable: string[] }> {
  await rm(options.destination, { recursive: true, force: true });
  await mkdir(path.join(options.destination, ".bun"), { recursive: true });

  const packages = new Map<string, BunStorePackage>();
  const missing = new Set<string>();
  const queue: Array<{ name: string; from: string }> = options.entryPackages.map((name) => ({
    name,
    from: options.packageRoot,
  }));

  while (queue.length > 0) {
    const { name, from } = queue.shift()!;
    const resolved = await resolvePackage(name, from);
    if (!resolved) {
      // Optional dependencies gated on os/cpu legitimately resolve to nothing.
      missing.add(name);
      continue;
    }
    if (packages.has(resolved)) continue;

    const instance = bunStorePackage(resolved);
    packages.set(resolved, instance);
    const manifest = await readManifest(resolved);
    for (const dependency of dependencyNames(manifest)) {
      queue.push({ name: dependency, from: resolved });
    }
  }

  for (const instance of packages.values()) {
    await cp(instance.storeRoot, path.join(options.destination, ".bun", instance.storeKey), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }

  for (const name of options.entryPackages) {
    const resolved = await resolvePackage(name, options.packageRoot);
    if (!resolved) throw new Error(`${name} is not installed; run \`bun install\` first`);
    const instance = packages.get(resolved)!;
    const relativeWithinStore = path.relative(
      path.join(instance.storeRoot, "node_modules"),
      resolved,
    );
    const linkPath = path.join(options.destination, name);
    await mkdir(path.dirname(linkPath), { recursive: true });
    const target = path.relative(
      path.dirname(linkPath),
      path.join(
        options.destination,
        ".bun",
        instance.storeKey,
        "node_modules",
        relativeWithinStore,
      ),
    );
    await symlink(target, linkPath, "dir");
  }

  return { packageCount: packages.size, unavailable: Array.from(missing) };
}

if (import.meta.main) {
  const result = await stageRuntimeClosure({
    packageRoot,
    destination,
    entryPackages: ENTRY_PACKAGES,
  });
  console.log(
    `[pi-bridge] Vendored ${result.packageCount} package instance(s)` +
      (result.unavailable.length > 0
        ? `; skipped unavailable: ${result.unavailable.join(", ")}`
        : ""),
  );
}
