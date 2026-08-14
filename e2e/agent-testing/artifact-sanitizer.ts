import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GATEWAY_COOKIE = "orkestrator_gateway_auth";

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

async function sanitizeTraceArchive(archivePath: string, secrets: readonly string[]): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ork-agent-trace-"));
  const unpacked = path.join(temporaryRoot, "trace");
  const replacement = path.join(temporaryRoot, "trace.zip");
  try {
    const unzip = spawnSync("unzip", ["-qq", archivePath, "-d", unpacked], { encoding: "utf8" });
    if (unzip.status !== 0) throw new Error("Unable to unpack an agent-test trace for redaction");
    await sanitizeAgentTestingArtifacts(unpacked, secrets, false);
    const zip = spawnSync("zip", ["-q", "-r", replacement, "."], {
      cwd: unpacked,
      encoding: "utf8",
    });
    if (zip.status !== 0) throw new Error("Unable to repack a redacted agent-test trace");
    await rename(replacement, archivePath);
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
  if (rootStat.isFile()) {
    if (includeArchives && root.endsWith(".zip")) await sanitizeTraceArchive(root, secrets);
    else await sanitizeRegularFile(root, secrets);
    return;
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await sanitizeAgentTestingArtifacts(target, secrets, includeArchives);
    else if (entry.isFile()) {
      if (includeArchives && entry.name.endsWith(".zip")) await sanitizeTraceArchive(target, secrets);
      else await sanitizeRegularFile(target, secrets);
    }
  }
}
