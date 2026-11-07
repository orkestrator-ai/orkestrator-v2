import { cp, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const transcriptArtifacts = path.join(packageRoot, "src/core/transcript-artifacts");
const workerDocker = path.join(packageRoot, "../../docker/artifact-preview-worker");

/**
 * Stage the transcript-artifact preview runtime into `<outputDir>/artifact-runtime/`:
 * the out-of-process preview worker and the pinned browser bundles it (and the
 * interactive preparer) load. The backend resolves all of it beside its own
 * bundle (`defaultWorkerCommand`, `pinnedBundleCandidates`), so every package
 * that ships a backend bundle (the desktop backend and the `orkestrator` CLI)
 * stages it next to that bundle. Without it Mermaid and HTML previews report
 * the renderer unavailable.
 *
 * Every bundle is verified against its pinned SHA-256 here, so a packaged
 * backend can never ship bytes its manifest does not name. Throws on failure.
 */
export async function stageArtifactRuntime(outputDir: string): Promise<void> {
  const { ALL_PINNED_BUNDLES, pinnedBundleCandidates, sha256Hex, writePinnedBundleLicenses } =
    await import("../src/core/transcript-artifacts/dependency-manifest.js");
  const artifactRuntime = path.join(outputDir, "artifact-runtime");
  await mkdir(artifactRuntime, { recursive: true });
  for (const bundle of ALL_PINNED_BUNDLES) {
    const source = pinnedBundleCandidates(bundle, transcriptArtifacts).at(-1)!;
    const bytes = new Uint8Array(await Bun.file(await realpath(source)).arrayBuffer());
    if (sha256Hex(bytes) !== bundle.sha256) {
      throw new Error(`Pinned bundle ${bundle.id} does not match its manifest SHA-256`);
    }
    await Bun.write(path.join(artifactRuntime, bundle.distName), bytes);
  }
  const worker = await Bun.build({
    entrypoints: [path.join(transcriptArtifacts, "preview-worker-entry.ts")],
    outdir: artifactRuntime,
    naming: "preview-worker.js",
    target: "bun",
    external: ["playwright-core"],
  });
  if (!worker.success) {
    for (const log of worker.logs) console.error(log);
    throw new Error("Building the preview worker failed");
  }
  await cp(
    path.join(workerDocker, "seccomp_profile.json"),
    path.join(artifactRuntime, "seccomp_profile.json"),
  );
  // License texts ship beside the bundles: artifact-runtime/licenses/<id>/ and
  // artifact-runtime/THIRD_PARTY_NOTICES.txt.
  await writePinnedBundleLicenses(artifactRuntime, transcriptArtifacts);

  // Container preview worker build context, so a packaged backend can build the
  // worker image on demand (`transcript_artifact_prepare_worker`) with no
  // repository checkout: exactly what docker/artifact-preview-worker/build.sh
  // stages (Dockerfile, npm manifest and lockfile, Node worker bundle,
  // hash-verified pinned bundles, licenses), plus the seccomp profile the
  // supervisor passes to `docker run`.
  const workerContext = path.join(artifactRuntime, "worker-context");
  const staged = Bun.spawnSync(
    [process.execPath, path.join(workerDocker, "stage-context.ts"), workerContext],
    { stdout: "ignore", stderr: "inherit" },
  );
  if (staged.exitCode !== 0) throw new Error("Staging the preview worker build context failed");
  for (const file of ["Dockerfile", "package.json", "package-lock.json", "preview-worker.mjs"]) {
    if (!(await Bun.file(path.join(workerContext, file)).exists())) {
      throw new Error(`Preview worker build context is missing ${file}`);
    }
  }
  await cp(
    path.join(workerDocker, "seccomp_profile.json"),
    path.join(workerContext, "seccomp_profile.json"),
  );
}
