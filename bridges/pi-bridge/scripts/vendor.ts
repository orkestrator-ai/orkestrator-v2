/**
 * Stage `@earendil-works/pi-coding-agent` and its runtime closure beside the
 * built bundle.
 *
 * The SDK is deliberately *not* bundled into `dist/index.js`. It loads several
 * things at runtime that a bundler cannot follow: `jiti` compiles extension
 * TypeScript on demand, the themes and the HTML export template are read from
 * files inside the package, and the image pipeline loads a WASM module beside
 * its own entry point. A bundled copy resolves fine until the first of those
 * paths runs and then dies looking for a file that was never emitted.
 *
 * Keeping the package external and staging its closure under
 * `dist/node_modules` is what makes both mechanisms work without depending on
 * a workspace `node_modules` the packaged app does not ship.
 *
 * The closure is walked rather than hard-coded: the SDK's dependency list is
 * its own to change, and a missed transitive dependency would surface as the
 * same class of runtime failure this exists to prevent.
 */
import { cp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const destination = path.join(packageRoot, "dist", "node_modules");
const ENTRY_PACKAGE = "@earendil-works/pi-coding-agent";

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
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    const record = manifest[field];
    if (record && typeof record === "object") {
      for (const name of Object.keys(record)) names.add(name);
    }
  }
  return [...names];
}

const sdkRoot = await resolvePackage(ENTRY_PACKAGE, packageRoot);
if (!sdkRoot) throw new Error(`${ENTRY_PACKAGE} is not installed; run \`bun install\` first`);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

const staged = new Map<string, string>();
const missing: string[] = [];
const queue: Array<{ name: string; from: string }> = [{ name: ENTRY_PACKAGE, from: packageRoot }];

while (queue.length > 0) {
  const { name, from } = queue.shift()!;
  if (staged.has(name)) continue;
  const resolved = await resolvePackage(name, from);
  if (!resolved) {
    // Optional dependencies gated on os/cpu legitimately resolve to nothing on
    // this host. Collect them rather than failing, and report once below.
    missing.push(name);
    continue;
  }
  staged.set(name, resolved);
  await cp(resolved, path.join(destination, name), { recursive: true, dereference: true });

  const manifest = await readManifest(resolved).catch(() => ({}));
  for (const dependency of dependencyNames(manifest)) {
    if (!staged.has(dependency)) queue.push({ name: dependency, from: resolved });
  }
}

if (!staged.has(ENTRY_PACKAGE)) throw new Error(`Failed to stage ${ENTRY_PACKAGE}`);
// Only report what is genuinely absent: a name can fail to resolve from one
// requester and still be staged from another.
const absent = missing.filter((name) => !staged.has(name));
console.log(
  `[pi-bridge] Vendored ${staged.size} package(s)` +
    (absent.length > 0 ? `; skipped unavailable: ${absent.join(", ")}` : ""),
);
