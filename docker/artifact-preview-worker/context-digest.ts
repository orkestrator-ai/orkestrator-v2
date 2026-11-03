/**
 * Prints the content digest (`sha256:<hex>`) of a staged preview worker build
 * context. Locally built images carry this digest as a label for startup
 * comparison against the shipped context (see
 * apps/backend/src/core/transcript-artifacts/preview-worker-context-digest.ts).
 * Usage: bun context-digest.ts <context-dir>
 */
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: bun context-digest.ts <context-dir>");
  process.exit(2);
}
const { workerContextDigest } = await import(
  path.resolve(
    import.meta.dir,
    "../../apps/backend/src/core/transcript-artifacts/preview-worker-context-digest.ts",
  )
);
console.log(await workerContextDigest(target));
