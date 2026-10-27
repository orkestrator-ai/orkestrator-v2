/**
 * Content digest of a staged preview worker build context (what
 * docker/artifact-preview-worker/stage-context.ts writes). The published
 * image pin records the digest of the context its image was built from, and
 * the image carries it as a label, so a backend pulls a published image only
 * when it was built from exactly the context this backend ships. Any change
 * to the worker bundle, the pinned renderer bundles, the Dockerfile or the
 * npm lockfile changes the digest, and a stale pin is ignored (the worker is
 * built locally instead).
 *
 * The digest is SHA-256 over every regular file, ordered by its relative
 * POSIX path, each framed as `<path>\0<byte length>\0<bytes>`. The seccomp
 * profile the backend build copies beside the context is excluded: it is
 * passed to `docker run`, never built into the image.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Image label recording the context digest (`docker build --label`). */
export const WORKER_CONTEXT_LABEL = "orkestrator.artifact-preview-worker.context";
/** Files beside the staged context that are not part of the image build. */
export const WORKER_CONTEXT_EXCLUDED = new Set(["seccomp_profile.json"]);
export const WORKER_CONTEXT_DIGEST = /^sha256:[0-9a-f]{64}$/;

async function contextFiles(root: string, dir = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await contextFiles(root, relative)));
    else if (entry.isFile()) {
      if (!dir && WORKER_CONTEXT_EXCLUDED.has(entry.name)) continue;
      files.push(relative);
    }
    // Staging writes only regular files and directories; anything else
    // (a symlink, a socket) cannot be part of a reproducible context.
    else throw new Error(`unexpected entry in the worker build context: ${relative}`);
  }
  return files;
}

/** `sha256:<hex>` of the build context in `dir`. */
export async function workerContextDigest(dir: string): Promise<string> {
  const files = (await contextFiles(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(path.join(dir, file));
    hash.update(`${file}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}
