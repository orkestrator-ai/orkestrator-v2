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
import { CommandFailedError } from "../shell.js";

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
 * bounded, consecutive parts (`diffChunks`). A 2.9 MB diff could only be
 * spot-checked with searches (2026-11-10); with parts, each reviewer of a
 * panel reads its share in full (`PACKAGED_REVIEW_WORKING_RULES`).
 */

/** The diff file's budget; one package file's own budget is the same 16 MiB. */
export const MAX_REVIEW_DIFF_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** The diff's options: no colour, no external diff or textconv helper, no rename detection. */
export function reviewDiffArgs(range: string): string[] {
  return [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    range,
  ];
}

/** A diff larger than this is also sealed as parts a reviewer can read in full. */
export const REVIEW_DIFF_CHUNK_THRESHOLD_BYTES = 512 * 1024;
/** The size a part aims for; the target grows when needed to respect the part count limit. */
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
  const rest = header.slice(FILE_HEADER.length);
  if (rest.startsWith('"') || rest.endsWith('"')) {
    const quoted = /"((?:[^"\\]|\\.)*)"$/.exec(rest)?.[1];
    if (quoted === undefined) return undefined;
    const escapes: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      "\\": 92,
    };
    const bytes = Buffer.from(quoted, "utf8");
    let write = 0;
    for (let read = 0; read < bytes.length; read++) {
      const byte = bytes[read]!;
      if (byte !== 92) {
        bytes[write++] = byte;
        continue;
      }
      const escape = String.fromCharCode(bytes[++read]!);
      if (escape >= "0" && escape <= "3") {
        const octal = escape + String.fromCharCode(bytes[++read]!, bytes[++read]!);
        if (!/^[0-3][0-7]{2}$/.test(octal)) return undefined;
        bytes[write++] = Number.parseInt(octal, 8);
      } else {
        const decoded = escapes[escape];
        if (decoded === undefined) return undefined;
        bytes[write++] = decoded;
      }
    }
    const path = bytes.subarray(0, write).toString("utf8");
    return path.startsWith("b/") ? path.slice(2) : undefined;
  }
  const length = (rest.length - 5) / 2;
  if (!Number.isInteger(length) || length <= 0) return undefined;
  const path = rest.slice(2, 2 + length);
  return rest === `a/${path} b/${path}` ? path : undefined;
}

/**
 * Prefer file boundaries, then hunk boundaries for oversized files. An
 * oversized hunk is sliced at a newline where possible, with a UTF-8 boundary
 * fallback for an oversized line. Concatenating the parts reconstructs the diff.
 */
export function splitReviewDiff(
  text: string,
  targetBytes = REVIEW_DIFF_CHUNK_TARGET_BYTES,
): Array<{ contents: Buffer; files: string[] }> {
  const bytes = Buffer.from(text, "utf8");
  const sections = [];
  const headers = Array.from(text.matchAll(/(?:^|(?<=\n))diff --git [^\n]*/g));
  let offset = 0;
  for (const [index, header] of headers.entries()) {
    if (index === 0 && header.index > 0) {
      offset = Buffer.byteLength(text.slice(0, header.index));
      sections.push({ contents: bytes.subarray(0, offset) });
    }
    const end = headers[index + 1]?.index ?? text.length;
    const length = Buffer.byteLength(text.slice(header.index, end));
    sections.push({
      contents: bytes.subarray(offset, offset + length),
      file: reviewDiffHeaderPath(header[0]),
    });
    offset += length;
  }
  if (headers.length === 0) sections.push({ contents: bytes });

  let target = Math.max(4, targetBytes, Math.ceil(bytes.length / REVIEW_PACKAGE_MAX_DIFF_CHUNKS));
  for (;;) {
    const parts: Array<{ contents: Buffer; files: string[] }> = [];
    let buffers: Buffer[] = [];
    let files = new Set<string>();
    let size = 0;
    const flush = () => {
      if (size === 0) return;
      parts.push({ contents: Buffer.concat(buffers, size), files: Array.from(files) });
      buffers = [];
      files = new Set();
      size = 0;
    };
    for (const { contents, file } of sections) {
      if (size + contents.length > target) flush();
      let start = 0;
      while (contents.length - start > target) {
        const limit = start + target;
        const hunk = contents.lastIndexOf("\n@@ ", limit - 1);
        const newline = contents.lastIndexOf(10, limit - 1);
        let end = hunk > start ? hunk + 1 : newline >= start ? newline + 1 : limit;
        while ((contents[end]! & 0xc0) === 0x80) end--;
        buffers.push(contents.subarray(start, end));
        if (file) files.add(file);
        size += end - start;
        flush();
        start = end;
      }
      buffers.push(contents.subarray(start));
      if (file) files.add(file);
      size += contents.length - start;
    }
    flush();
    if (parts.length <= REVIEW_PACKAGE_MAX_DIFF_CHUNKS) return parts;
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

/** Missing slot indexes leave every chunk assigned to that slot unreviewed. */
export function reviewChunkCoverageFailure(
  chunkCount: number | undefined,
  slotHasReport: readonly boolean[],
): string | undefined {
  if (!chunkCount) return undefined;
  const missing = Array.from({ length: chunkCount }, (_, index) => index + 1).filter(
    (index) => !slotHasReport[(index - 1) % slotHasReport.length],
  );
  if (missing.length === 0) return undefined;
  return `Diff review incomplete. No usable reviewer report covers parts ${missing.join(", ")}.`;
}
