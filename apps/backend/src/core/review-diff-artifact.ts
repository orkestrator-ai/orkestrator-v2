import { reviewDiffArtifactPath } from "@orkestrator/protocol/review-artifacts";
import type { ReviewPackageDiffArtifact } from "@orkestrator/protocol/review-workflow";
import { createHash } from "node:crypto";
import { CommandFailedError } from "./shell.js";

/**
 * The reviewed diff as a sealed file beside the review package (to-do 0190 (retired)).
 *
 * A package names its range and the `diffCommand` that reproduces it, and a
 * reviewer normally runs that command. A read-only review turn without the
 * Claude CLI's command sandbox (every container, where the image ships no
 * bubblewrap, and Linux hosts whose bubblewrap cannot run) cannot: its command
 * hook refuses every Git command, because a repository's Git configuration can
 * run helpers. The backend already runs Git in the environment to build the
 * package, so it writes the same UTF-8 bytes once here and the reviewer reads them.
 * Output containing a replacement character is omitted with a limitation: the
 * text runner may have replaced invalid UTF-8 before this helper received it.
 *
 * Never fatal. A diff that is too large, or that Git or the write could not
 * produce, leaves the package without the file and adds a limitation saying
 * so: a reviewer that can run Git loses nothing, and one that cannot is told.
 */

/** The diff file's budget; one package file's own budget is the same 16 MiB. */
export const MAX_REVIEW_DIFF_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** The diff's options: no colour, no external diff or textconv helper, no rename detection. */
export function reviewDiffArgs(range: string): string[] {
  return ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", range];
}

export type SealedReviewDiff =
  | { artifact: ReviewPackageDiffArtifact; limitation?: undefined }
  | { artifact?: undefined; limitation: string };

const UNREADABLE = "a reviewer whose session refuses Git commands cannot read the diff";

/**
 * Runs the diff, then writes it under its digest. `diff` is the environment's
 * `git diff` output; `write` creates the workspace-relative file read-only.
 */
export async function sealReviewDiff(input: {
  packageId: string;
  diff: () => Promise<string>;
  write: (relativePath: string, contents: Buffer) => Promise<void>;
  maxBytes?: number;
}): Promise<SealedReviewDiff> {
  const maxBytes = input.maxBytes ?? MAX_REVIEW_DIFF_ARTIFACT_BYTES;
  let contents: Buffer;
  try {
    const text = await input.diff();
    if (text.includes("\uFFFD")) {
      return {
        limitation: `The reviewed diff contains a UTF-8 replacement character and cannot be sealed faithfully, so ${UNREADABLE}`,
      };
    }
    contents = Buffer.from(text, "utf8");
  } catch (error) {
    if (error instanceof CommandFailedError && error.outputLimitExceeded) {
      return { limitation: tooLarge(maxBytes) };
    }
    return { limitation: `The reviewed diff could not be produced as a file, so ${UNREADABLE}` };
  }
  if (contents.byteLength > maxBytes) return { limitation: tooLarge(maxBytes) };
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const filePath = reviewDiffArtifactPath(input.packageId, sha256);
  try {
    await input.write(filePath, contents);
  } catch {
    return { limitation: `The reviewed diff could not be saved as a file, so ${UNREADABLE}` };
  }
  return { artifact: { path: filePath, bytes: contents.byteLength, sha256 } };
}

function tooLarge(maxBytes: number): string {
  return `The reviewed diff is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB and was not saved as a file, so ${UNREADABLE}`;
}

/**
 * Why a sealed diff no longer matches its package, or undefined when it does.
 * `read` returns the workspace file's bytes and throws when it cannot.
 */
export async function verifyReviewDiffArtifact(
  artifact: ReviewPackageDiffArtifact,
  read: (relativePath: string) => Promise<Buffer>,
): Promise<string | undefined> {
  let contents: Buffer;
  try {
    contents = await read(artifact.path);
  } catch (error) {
    return error instanceof Error ? error.message : "The reviewed diff file could not be read";
  }
  if (contents.byteLength !== artifact.bytes) {
    return `Review diff byte count changed: expected ${artifact.bytes}, received ${contents.byteLength}`;
  }
  if (createHash("sha256").update(contents).digest("hex") !== artifact.sha256) {
    return "Review diff SHA-256 changed";
  }
  return undefined;
}
