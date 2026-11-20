import {
  reviewDiffArtifactPath,
  reviewDiffChunkArtifactPath,
} from "@orkestrator/protocol/review-artifacts";
import {
  REVIEW_PACKAGE_MAX_DIFF_CHUNKS,
  type ReviewPackageDiffArtifact,
  type ReviewPackageDiffChunk,
} from "@orkestrator/protocol/review-workflow";
import { createHash } from "node:crypto";
import { CommandFailedError } from "./shell.js";

/**
 * The reviewed diff as a sealed file beside the review package (to-do 0190 (retired)).
 *
 * A package names its range and the `diffCommand` that reproduces it, and a
 * reviewer normally runs that command. A read-only review turn without the
 * Claude CLI's command sandbox (every container, where the image ships no
 * bubblewrap, and Linux hosts whose bubblewrap cannot run) on a Claude bridge
 * older than hardened reviewer Git, or another agent's read-only session that
 * refuses Git, cannot. The backend already runs Git in the environment to build the
 * package, so it writes the same UTF-8 bytes once here and the reviewer reads them.
 * Output containing a replacement character is omitted with a limitation: the
 * text runner may have replaced invalid UTF-8 before this helper received it.
 *
 * Never fatal. A diff that is too large, or that Git or the write could not
 * produce, leaves the package without the file and adds a limitation saying
 * so: a reviewer that can run Git loses nothing, and one that cannot is told.
 *
 * A diff above {@link REVIEW_DIFF_CHUNK_THRESHOLD_BYTES} is also written as
 * parts cut between file diffs (`diffChunks`). A 2.9 MB diff could only be
 * spot-checked with searches (2026-11-10); with parts, each reviewer of a
 * panel reads its share in full (`PACKAGED_REVIEW_WORKING_RULES`).
 */

/** The diff file's budget; one package file's own budget is the same 16 MiB. */
export const MAX_REVIEW_DIFF_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** The diff's options: no colour, no external diff or textconv helper, no rename detection. */
export function reviewDiffArgs(range: string): string[] {
  return ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", range];
}

/** A diff larger than this is also sealed as parts a reviewer can read in full. */
export const REVIEW_DIFF_CHUNK_THRESHOLD_BYTES = 512 * 1024;
/** The size a part aims for; one file's diff larger than this is a part of its own. */
export const REVIEW_DIFF_CHUNK_TARGET_BYTES = 256 * 1024;

export type SealedReviewDiff =
  | {
      artifact: ReviewPackageDiffArtifact;
      /** Present only for a diff above the chunk threshold whose parts were all written. */
      chunks?: ReviewPackageDiffChunk[];
      /** Why a large diff has no parts. */
      limitation?: string;
    }
  | { artifact?: undefined; chunks?: undefined; limitation: string };

const FILE_HEADER = "diff --git ";

/**
 * The path a `diff --git a/<path> b/<path>` header names. The review diff runs
 * without rename detection, so both sides are the same path, which is what
 * makes an unquoted header with spaces unambiguous. A quoted header (Git
 * quotes unusual characters) yields its `b/` side unescaped where JSON can.
 */
export function reviewDiffHeaderPath(header: string): string | undefined {
  const rest = header.slice(FILE_HEADER.length).replace(/\r?$/, "");
  if (rest.startsWith('"') || rest.endsWith('"')) {
    const quoted = /"((?:[^"\\]|\\.)*)"$/.exec(rest)?.[1];
    if (quoted === undefined) return undefined;
    let path = quoted;
    try {
      path = JSON.parse(`"${quoted}"`) as string;
    } catch {
      // Octal escapes are not JSON; the raw spelling still names the file.
    }
    return path.startsWith("b/") ? path.slice(2) : path;
  }
  const length = (rest.length - 5) / 2;
  if (!Number.isInteger(length) || length <= 0) return undefined;
  const path = rest.slice(2, 2 + length);
  return rest === `a/${path} b/${path}` ? path : undefined;
}

/**
 * Cuts a diff between file diffs into consecutive parts of about
 * `targetBytes`, at most {@link REVIEW_PACKAGE_MAX_DIFF_CHUNKS} of them (the
 * target grows when it would make more). The parts' bytes concatenate to the
 * input exactly; text before the first file header stays in the first part.
 */
export function splitReviewDiff(
  text: string,
  targetBytes = REVIEW_DIFF_CHUNK_TARGET_BYTES,
): Array<{ contents: Buffer; files: string[] }> {
  const sections: Array<{ text: string; bytes: number; file?: string }> = [];
  let start = 0;
  const pushSection = (end: number) => {
    if (end <= start) return;
    const section = text.slice(start, end);
    const headerEnd = section.indexOf("\n");
    const header = section.startsWith(FILE_HEADER)
      ? section.slice(0, headerEnd === -1 ? undefined : headerEnd)
      : undefined;
    const file = header ? reviewDiffHeaderPath(header) : undefined;
    sections.push({
      text: section,
      bytes: Buffer.byteLength(section, "utf8"),
      ...(file ? { file } : {}),
    });
    start = end;
  };
  let cursor = text.startsWith(FILE_HEADER) ? 1 : 0;
  for (;;) {
    const next = text.indexOf(`\n${FILE_HEADER}`, cursor);
    if (next === -1) break;
    pushSection(next + 1);
    cursor = next + 1;
  }
  pushSection(text.length);
  const total = sections.reduce((sum, section) => sum + section.bytes, 0);
  let target = Math.max(targetBytes, Math.ceil(total / REVIEW_PACKAGE_MAX_DIFF_CHUNKS));
  for (;;) {
    const parts: Array<{ sections: typeof sections; bytes: number }> = [];
    for (const section of sections) {
      const last = parts.at(-1);
      if (last && last.bytes + section.bytes <= target) {
        last.sections.push(section);
        last.bytes += section.bytes;
      } else {
        parts.push({ sections: [section], bytes: section.bytes });
      }
    }
    if (parts.length <= REVIEW_PACKAGE_MAX_DIFF_CHUNKS) {
      return parts.map((part) => ({
        contents: Buffer.from(part.sections.map((section) => section.text).join(""), "utf8"),
        files: part.sections.flatMap((section) => (section.file ? [section.file] : [])),
      }));
    }
    target *= 2;
  }
}

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
  /** Overrides {@link REVIEW_DIFF_CHUNK_THRESHOLD_BYTES} (tests). */
  chunkThresholdBytes?: number;
  /** Overrides {@link REVIEW_DIFF_CHUNK_TARGET_BYTES} (tests). */
  chunkTargetBytes?: number;
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
  const artifact = { path: filePath, bytes: contents.byteLength, sha256 };
  const chunkThreshold = input.chunkThresholdBytes ?? REVIEW_DIFF_CHUNK_THRESHOLD_BYTES;
  if (contents.byteLength <= chunkThreshold) return { artifact };
  const chunks: ReviewPackageDiffChunk[] = [];
  try {
    const parts = splitReviewDiff(
      contents.toString("utf8"),
      input.chunkTargetBytes ?? REVIEW_DIFF_CHUNK_TARGET_BYTES,
    );
    // One part would add nothing the whole file does not already give.
    if (parts.length < 2) return { artifact };
    for (const [position, part] of parts.entries()) {
      const partSha256 = createHash("sha256").update(part.contents).digest("hex");
      const path = reviewDiffChunkArtifactPath(input.packageId, position + 1, partSha256);
      await input.write(path, part.contents);
      chunks.push({
        index: position + 1,
        path,
        bytes: part.contents.byteLength,
        sha256: partSha256,
        files: part.files,
      });
    }
  } catch {
    return {
      artifact,
      limitation: `The reviewed diff is ${Math.round(contents.byteLength / 1024)} KiB and could not be split into parts, so each reviewer must read it in its own passes`,
    };
  }
  return { artifact, chunks };
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
