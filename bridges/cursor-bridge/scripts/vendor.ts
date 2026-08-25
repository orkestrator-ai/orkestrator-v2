/**
 * Stage `@cursor/sdk` and its runtime closure beside the built bundle.
 *
 * The SDK is deliberately *not* bundled into `dist/index.js`. Its ESM build
 * code-splits into numbered chunks that it loads with dynamic `import()` at
 * runtime (`./401.js` and friends); a bundler inlines the static graph but
 * cannot follow those, so a bundled copy resolves fine until the first lazy
 * path runs and then dies with "Cannot find module './401.js'". Keeping the
 * package external lets bun resolve its own `bun` export condition, which
 * points at a genuinely flat build with no chunk loading at all.
 *
 * That flat build still imports its dependencies by bare specifier, and the
 * native platform package (ripgrep, the sandbox helper, the tree-sitter
 * grammars) is found by walking up from the entry script looking for
 * `node_modules/@cursor/sdk-<platform>/`. So this stages the whole closure
 * under `dist/node_modules`, where both mechanisms find it without depending
 * on a workspace `node_modules` the packaged app does not ship.
 *
 * The closure is walked rather than hard-coded: the SDK's dependency list is
 * its own to change, and a missed transitive dependency would surface as the
 * same class of runtime failure this exists to prevent.
 */
import { cp, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const destination = path.join(packageRoot, "dist", "node_modules");

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

const sdkRoot = await resolvePackage("@cursor/sdk", packageRoot);
if (!sdkRoot) throw new Error("@cursor/sdk is not installed; run `bun install` first");

// The platform packages are optional dependencies gated on os/cpu, so only the
// host's own is installed — which is what we want. A macOS build stages the
// macOS helpers; the Docker image, built inside Linux, stages the Linux ones.
const scopeRoot = path.dirname(sdkRoot);
const platformPackages = (await readdir(scopeRoot).catch(() => []))
  .filter((name) => name.startsWith("sdk-"))
  .map((name) => `@cursor/${name}`);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

const staged = new Map<string, string>();
const missing: string[] = [];
const queue: Array<{ name: string; from: string }> = [
  { name: "@cursor/sdk", from: packageRoot },
  // Resolved from the SDK itself: an isolated store keeps the platform package
  // beside it rather than anywhere this package can see.
  ...platformPackages.map((name) => ({ name, from: sdkRoot })),
];

while (queue.length > 0) {
  const { name, from } = queue.shift()!;
  if (staged.has(name)) continue;
  const resolved = await resolvePackage(name, from);
  if (!resolved) {
    // Optional dependencies for other platforms legitimately resolve to
    // nothing. Collect them rather than failing, and report once below.
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

if (!staged.has("@cursor/sdk")) throw new Error("Failed to stage @cursor/sdk");
if (platformPackages.length === 0) {
  console.warn(
    "[cursor-bridge] No @cursor/sdk platform package found; the SDK will fall back to its" +
      " own helpers for ripgrep, sandboxing and tree-sitter.",
  );
}
// Only report what is genuinely absent: a name can fail to resolve from one
// requester and still be staged from another.
const absent = missing.filter((name) => !staged.has(name));
console.log(
  `[cursor-bridge] Vendored ${staged.size} package(s)` +
    (absent.length > 0 ? `; skipped unavailable: ${absent.join(", ")}` : ""),
);
