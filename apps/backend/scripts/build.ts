import { cp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const output = path.join(packageRoot, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(packageRoot, "src/main.ts")],
  outdir: output,
  target: "bun",
  sourcemap: "external",
  // Sharp resolves its platform-native @img package at runtime. Keeping the
  // package external preserves its own module location, so it resolves the
  // matching vendored binary instead of whichever version happens to be in
  // Bun's global install cache.
  external: ["sharp"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

async function copyResolvedPackage(source: string, destination: string): Promise<void> {
  await cp(await realpath(source), destination, { recursive: true, dereference: true });
}

// Sharp and its runtime dependency closure travel beside the standalone bundle.
// Electron preserves this `backend/node_modules` layout explicitly; that local
// package boundary must win before Bun considers anything in its global cache.
const sharpRoot = await realpath(path.join(packageRoot, "node_modules/sharp"));
const sharpDependenciesRoot = path.dirname(sharpRoot);
for (const packageName of ["sharp", "detect-libc", "semver"]) {
  await copyResolvedPackage(
    path.join(sharpDependenciesRoot, packageName),
    path.join(output, "node_modules", packageName),
  );
}
await copyResolvedPackage(
  path.join(sharpDependenciesRoot, "@img"),
  path.join(output, "node_modules/@img"),
);

for (const artifact of result.outputs) {
  console.log(`${path.relative(packageRoot, artifact.path)} ${artifact.size} bytes`);
}
