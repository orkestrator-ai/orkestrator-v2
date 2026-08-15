import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const GATEWAY_COOKIE = "orkestrator_gateway_auth";
export const MAX_SANITIZABLE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACT_TREE_BYTES = 256 * 1024 * 1024;
export const MAX_ARTIFACT_FILES = 5_000;

class ArtifactBoundError extends Error {
  constructor(message: string, readonly artifactPath: string) {
    super(message);
    this.name = "ArtifactBoundError";
  }
}

type ArtifactBudget = {
  files: number;
  bytes: number;
};

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  // Playwright records cookies in both HTTP-header and structured JSON forms.
  redacted = redacted.replace(
    new RegExp(`(${GATEWAY_COOKIE}(?:=|%3D))[^;\\s"'\\\\]+`, "gi"),
    "$1[REDACTED]",
  );
  redacted = redacted.replace(
    new RegExp(`("name"\\s*:\\s*"${GATEWAY_COOKIE}"[^}]*?"value"\\s*:\\s*")[^"]*`, "gi"),
    "$1[REDACTED]",
  );
  return redacted;
}

async function sanitizeRegularFile(filePath: string, secrets: readonly string[]): Promise<void> {
  const source = await readFile(filePath);
  const text = source.toString("utf8");
  // Do not reinterpret screenshots or other binary evidence as UTF-8.
  if (!Buffer.from(text, "utf8").equals(source)) return;
  const redacted = redactText(text, secrets);
  if (redacted !== text) await writeFile(filePath, redacted, { mode: 0o600 });
}

async function sanitizeArtifactTree(
  root: string,
  secrets: readonly string[],
  includeArchives: boolean,
  budget: ArtifactBudget = { files: 0, bytes: 0 },
  errors: Error[] = [],
): Promise<Error[]> {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat) return errors;
  if (rootStat.isFile()) {
    const nextFiles = budget.files + 1;
    const nextBytes = budget.bytes + rootStat.size;
    let boundError: ArtifactBoundError | undefined;
    if (rootStat.size > MAX_SANITIZABLE_FILE_BYTES) {
      boundError = new ArtifactBoundError(
        `Agent-test artifact exceeds the ${MAX_SANITIZABLE_FILE_BYTES}-byte sanitization limit: ${root}`,
        root,
      );
    } else if (nextFiles > MAX_ARTIFACT_FILES || nextBytes > MAX_ARTIFACT_TREE_BYTES) {
      boundError = new ArtifactBoundError(
        `Agent-test artifacts exceed their safety bound (${nextFiles} files, ${nextBytes} bytes): ${root}`,
        root,
      );
    }
    if (boundError) {
      await rm(boundError.artifactPath, { force: true }).catch(() => undefined);
      errors.push(boundError);
      return errors;
    }

    budget.files = nextFiles;
    budget.bytes = nextBytes;
    try {
      if (includeArchives && root.endsWith(".zip")) await sanitizeTraceArchive(root, secrets);
      else await sanitizeRegularFile(root, secrets);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    return errors;
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() || entry.isFile()) {
      await sanitizeArtifactTree(target, secrets, includeArchives, budget, errors);
    }
  }
  return errors;
}

async function sanitizeTraceArchive(archivePath: string, secrets: readonly string[]): Promise<void> {
  // Staged beside the archive rather than under os.tmpdir(): `rename` cannot
  // cross a filesystem boundary, and on Linux the temp directory is routinely a
  // separate tmpfs mount from the checkout. An EXDEV there would leave the
  // original, unredacted trace exactly where a developer would pick it up.
  const temporaryRoot = await mkdtemp(`${archivePath}.redact-`);
  const unpacked = path.join(temporaryRoot, "trace");
  const replacement = path.join(temporaryRoot, "trace.zip");
  try {
    const unzip = spawnSync("unzip", ["-qq", archivePath, "-d", unpacked], { encoding: "utf8" });
    if (unzip.status !== 0) throw new Error("Unable to unpack an agent-test trace for redaction");
    const errors = await sanitizeArtifactTree(unpacked, secrets, false);
    if (errors[0]) throw errors[0];
    const zip = spawnSync("zip", ["-q", "-r", replacement, "."], {
      cwd: unpacked,
      encoding: "utf8",
    });
    if (zip.status !== 0) throw new Error("Unable to repack a redacted agent-test trace");
    await rename(replacement, archivePath);
  } catch (error) {
    // The redacted replacement could not be installed, so the archive still on
    // disk is the unredacted one. Destroying evidence is the lesser harm: the
    // teardown rethrows, so the run fails loudly rather than silently shipping
    // a trace containing the gateway session cookie.
    await rm(archivePath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function sanitizeAgentTestingArtifacts(
  root: string,
  secrets: readonly string[],
  includeArchives = true,
): Promise<void> {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat) return;
  const errors = await sanitizeArtifactTree(root, secrets, includeArchives);
  if (errors[0]) throw errors[0];
}
