import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Environment } from "./models.js";
import type { EnvironmentCommandRunner } from "./commands-review.js";

/** Per-stream size bound, the validation worker's own `MAX_STREAM_BYTES`. */
const MAX_VALIDATION_ARTIFACT_BYTES = 32 * 1024 * 1024;

/** What one verification read: hashed artifacts and their bytes. */
export interface ValidationArtifactVerification {
  artifacts: number;
  bytes: number;
}

/**
 * Why a workspace file could not be hashed: it is absent, it is reached
 * through a symbolic link or leaves the workspace, it is over its bound, or
 * the environment could not be asked (a container that cannot be exec'd).
 */
export type WorkspaceFileHashFailure = "missing" | "not-confined" | "too-large" | "unavailable";

export class WorkspaceFileHashError extends Error {
  constructor(
    readonly failure: WorkspaceFileHashFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorkspaceFileHashError";
  }
}

/**
 * Hashes one workspace file at its source: on the host for a local worktree,
 * inside the container (`realpath`, `stat`, `sha256sum`) otherwise, so no file
 * content crosses the backend/container boundary. The path must resolve to
 * itself (no symbolic link on the way) inside the workspace and name a
 * regular file within `maxBytes`. `label` starts every message.
 */
export async function hashEnvironmentWorkspaceFile(
  environment: Environment,
  runner: EnvironmentCommandRunner,
  relative: string,
  options: { maxBytes: number; label: string },
): Promise<{ sha256: string; bytes: number }> {
  const { label, maxBytes } = options;
  if (environment.environmentType === "local") {
    const root = await realpath(environment.worktreePath!);
    const target = path.join(root, relative);
    let resolved: string;
    try {
      resolved = await realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new WorkspaceFileHashError("missing", `${label} is missing`, { cause: error });
      }
      throw error;
    }
    const info = await lstat(target);
    if (resolved !== target || !resolved.startsWith(root + path.sep) || !info.isFile()) {
      throw new WorkspaceFileHashError(
        "not-confined",
        `${label} is not confined or exceeds its limit`,
      );
    }
    if (info.size > maxBytes) {
      throw new WorkspaceFileHashError(
        "too-large",
        `${label} is not confined or exceeds its limit`,
      );
    }
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(target)) {
      bytes += (chunk as Buffer).byteLength;
      // The file grew after the stat: stop at the bound rather than read on.
      if (bytes > maxBytes) {
        throw new WorkspaceFileHashError(
          "too-large",
          `${label} is not confined or exceeds its limit`,
        );
      }
      hash.update(chunk);
    }
    return { sha256: hash.digest("hex"), bytes };
  }
  const target = `/workspace/${relative}`;
  let resolved: string;
  try {
    resolved = (await runner("realpath", ["--", target], 10_000)).trim();
  } catch (error) {
    // A missing file and a container that cannot be reached fail the same
    // way here; both refuse, and neither is reported as the other.
    throw new WorkspaceFileHashError("unavailable", `${label} could not be read`, {
      cause: error,
    });
  }
  if (resolved !== target)
    throw new WorkspaceFileHashError("not-confined", `${label} is not confined`);
  const size = Number((await runner("stat", ["-c", "%s", "--", target], 10_000)).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw new WorkspaceFileHashError("too-large", `${label} is not confined or exceeds its limit`);
  }
  const sha256 = (await runner("sha256sum", ["--", target], 30_000)).trim().split(/\s+/)[0]!;
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new WorkspaceFileHashError("unavailable", `${label} could not be hashed`);
  }
  return { sha256, bytes: size };
}

/**
 * Hash at the source; no raw output crosses a backend/container boundary.
 * Returns the artifact count and bytes it hashed, so a verification's cost can
 * be measured beyond the package's own declared size.
 */
export async function verifyValidationArtifacts(
  environment: Environment,
  runner: EnvironmentCommandRunner,
  entries: Array<{
    stdoutPath: string | null;
    stderrPath: string | null;
    stdoutSha256?: string;
    stderrSha256?: string;
  }>,
): Promise<ValidationArtifactVerification> {
  const verified: ValidationArtifactVerification = { artifacts: 0, bytes: 0 };
  for (const entry of entries) {
    for (const stream of ["stdout", "stderr"] as const) {
      const digest = entry[`${stream}Sha256`];
      if (digest === undefined) continue; // Legacy packages did not hash logs.
      const relative = entry[`${stream}Path`];
      if (
        !relative ||
        !/^[a-f0-9]{64}$/.test(digest) ||
        relative.split("/").includes("..") ||
        path.isAbsolute(relative)
      )
        throw new Error("Invalid validation artifact identity");
      const actual = await hashEnvironmentWorkspaceFile(environment, runner, relative, {
        maxBytes: MAX_VALIDATION_ARTIFACT_BYTES,
        label: "Validation artifact",
      });
      if (actual.sha256 !== digest) throw new Error("Validation artifact SHA-256 changed");
      verified.artifacts += 1;
      verified.bytes += actual.bytes;
    }
  }
  return verified;
}
