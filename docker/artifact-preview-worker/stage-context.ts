/**
 * Stages the artifact preview worker image build context: the worker bundle
 * (Node target; the image runs Node), the pinned browser bundles (each
 * verified against its manifest SHA-256) with their license texts, and the
 * npm manifest plus lockfile installed with `npm ci`.
 * Usage: bun stage-context.ts <dir>
 */
import { copyFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: bun stage-context.ts <context-dir>");
  process.exit(2);
}
const here = import.meta.dir;
const backend = path.resolve(here, "../../apps/backend");
const moduleDir = path.join(backend, "src/core/transcript-artifacts");
const { ALL_PINNED_BUNDLES, pinnedBundleCandidates, sha256Hex, writePinnedBundleLicenses } =
  await import(path.join(moduleDir, "dependency-manifest.ts"));

await mkdir(target, { recursive: true });
for (const bundle of ALL_PINNED_BUNDLES) {
  const source = await realpath(pinnedBundleCandidates(bundle, moduleDir).at(-1)!);
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
  if (sha256Hex(bytes) !== bundle.sha256) {
    console.error(`Pinned bundle ${bundle.id} does not match its manifest SHA-256`);
    process.exit(1);
  }
  await Bun.write(path.join(target, bundle.distName), bytes);
}
const result = await Bun.build({
  entrypoints: [path.join(moduleDir, "preview-worker-entry.ts")],
  outdir: target,
  naming: "preview-worker.mjs",
  target: "node",
  format: "esm",
  external: ["playwright-core"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
// License texts for every pinned bundle: licenses/<id>/ and THIRD_PARTY_NOTICES.txt.
await writePinnedBundleLicenses(target, moduleDir);
for (const file of ["Dockerfile", "package.json", "package-lock.json"])
  await copyFile(path.join(here, file), path.join(target, file));
console.log(target);
