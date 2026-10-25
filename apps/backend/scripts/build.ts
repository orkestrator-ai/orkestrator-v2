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
  external: ["sharp", "playwright-core"],
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

await copyResolvedPackage(
  path.join(packageRoot, "node_modules/playwright-core"),
  path.join(output, "node_modules/playwright-core"),
);

// Transcript-artifact preview runtime: the out-of-process preview worker and
// the pinned browser bundles it (and the interactive preparer) load. Every
// bundle is verified against its pinned SHA-256 here, so a packaged backend
// can never ship bytes its manifest does not name.
const { ALL_PINNED_BUNDLES, pinnedBundleCandidates, sha256Hex, writePinnedBundleLicenses } =
  await import("../src/core/transcript-artifacts/dependency-manifest.ts");
const artifactRuntime = path.join(output, "artifact-runtime");
await mkdir(artifactRuntime, { recursive: true });
for (const bundle of ALL_PINNED_BUNDLES) {
  const source = pinnedBundleCandidates(
    bundle,
    path.join(packageRoot, "src/core/transcript-artifacts"),
  ).at(-1)!;
  const bytes = new Uint8Array(await Bun.file(await realpath(source)).arrayBuffer());
  if (sha256Hex(bytes) !== bundle.sha256) {
    console.error(`Pinned bundle ${bundle.id} does not match its manifest SHA-256`);
    process.exit(1);
  }
  await Bun.write(path.join(artifactRuntime, bundle.distName), bytes);
}
const worker = await Bun.build({
  entrypoints: [path.join(packageRoot, "src/core/transcript-artifacts/preview-worker-entry.ts")],
  outdir: artifactRuntime,
  naming: "preview-worker.js",
  target: "bun",
  external: ["playwright-core"],
});
if (!worker.success) {
  for (const log of worker.logs) console.error(log);
  process.exit(1);
}
await cp(
  path.join(packageRoot, "../../docker/artifact-preview-worker/seccomp_profile.json"),
  path.join(artifactRuntime, "seccomp_profile.json"),
);
// License texts ship beside the bundles: artifact-runtime/licenses/<id>/ and
// artifact-runtime/THIRD_PARTY_NOTICES.txt.
await writePinnedBundleLicenses(
  artifactRuntime,
  path.join(packageRoot, "src/core/transcript-artifacts"),
);

// Container preview worker build context, so a packaged backend can build the
// worker image on demand (`transcript_artifact_prepare_worker`) with no
// repository checkout: exactly what docker/artifact-preview-worker/build.sh
// stages (Dockerfile, npm manifest and lockfile, Node worker bundle,
// hash-verified pinned bundles, licenses), plus the seccomp profile the
// supervisor passes to `docker run`, and the published-image digest pin.
const workerDocker = path.join(packageRoot, "../../docker/artifact-preview-worker");
const workerContext = path.join(artifactRuntime, "worker-context");
const staged = Bun.spawnSync(
  [process.execPath, path.join(workerDocker, "stage-context.ts"), workerContext],
  { stdout: "ignore", stderr: "inherit" },
);
if (staged.exitCode !== 0) {
  console.error("Staging the preview worker build context failed");
  process.exit(1);
}
for (const file of ["Dockerfile", "package.json", "package-lock.json", "preview-worker.mjs"]) {
  if (!(await Bun.file(path.join(workerContext, file)).exists())) {
    console.error(`Preview worker build context is missing ${file}`);
    process.exit(1);
  }
}
await cp(
  path.join(workerDocker, "seccomp_profile.json"),
  path.join(workerContext, "seccomp_profile.json"),
);
await cp(
  path.join(workerDocker, "published-image.json"),
  path.join(artifactRuntime, "published-image.json"),
);
