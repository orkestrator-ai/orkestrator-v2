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
      let actual: string;
      let size: number;
      if (environment.environmentType === "local") {
        const root = await realpath(environment.worktreePath!);
        const target = path.join(root, relative);
        const resolved = await realpath(target);
        const info = await lstat(target);
        if (
          resolved !== target ||
          !resolved.startsWith(root + path.sep) ||
          !info.isFile() ||
          info.size > MAX_VALIDATION_ARTIFACT_BYTES
        )
          throw new Error("Validation artifact is not confined or exceeds its limit");
        size = info.size;
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(target)) hash.update(chunk);
        actual = hash.digest("hex");
      } else {
        const target = `/workspace/${relative}`;
        const resolved = (await runner("realpath", ["--", target], 10_000)).trim();
        if (resolved !== target) throw new Error("Validation artifact is not confined");
        size = Number((await runner("stat", ["-c", "%s", "--", target], 10_000)).trim());
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_VALIDATION_ARTIFACT_BYTES)
          throw new Error("Validation artifact is not confined or exceeds its limit");
        actual = (await runner("sha256sum", ["--", target], 30_000)).trim().split(/\s+/)[0]!;
      }
      if (actual !== digest) throw new Error("Validation artifact SHA-256 changed");
      verified.artifacts += 1;
      verified.bytes += size;
    }
  }
  return verified;
}
