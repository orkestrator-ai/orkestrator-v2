/**
 * Rewrites published-image.json, the checked-in digest pin of the published
 * artifact preview worker, after validating every field the backend checks
 * (`readPublishedWorkerImage`). Used by publish.sh and the
 * publish-preview-worker workflow.
 * Usage: bun write-pin.ts <repository> <tag> <manifest digest> <context digest> [pin file]
 * Prints `changed` or `unchanged` (the image, digest and context digest
 * already match; the file is left alone).
 */
import path from "node:path";

const [repository, tag, digest, contextDigest, file] = process.argv.slice(2);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
if (
  !repository ||
  !REPOSITORY.test(repository) ||
  !tag ||
  !TAG.test(tag) ||
  !digest ||
  !DIGEST.test(digest) ||
  !contextDigest ||
  !DIGEST.test(contextDigest)
) {
  console.error(
    "usage: bun write-pin.ts <repository> <tag> <sha256:manifest digest> <sha256:context digest> [pin file]",
  );
  process.exit(2);
}
const pinFile = file ?? path.join(import.meta.dir, "published-image.json");
const current = JSON.parse(await Bun.file(pinFile).text()) as Record<string, unknown>;
if (
  current.image === repository &&
  current.digest === digest &&
  current.contextDigest === contextDigest
) {
  console.log("unchanged");
  process.exit(0);
}
const next = {
  $comment: current.$comment,
  image: repository,
  tag,
  digest,
  contextDigest,
  publishedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
};
await Bun.write(pinFile, `${JSON.stringify(next, null, 2)}\n`);
console.log("changed");
