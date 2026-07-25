import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PINNED_TOOLCHAIN_ARTIFACTS,
  type ToolchainArtifact,
  type ToolchainArchitecture,
  type ToolchainName,
  type ToolchainPlatform,
} from "../apps/desktop/electron/toolchain-manifest";

type Digest = {
  size: number;
  sha256: string;
};

type Filters = {
  tool?: ToolchainName;
  platform?: ToolchainPlatform;
  architecture?: ToolchainArchitecture;
};

const MAX_REDIRECTS = 10;
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;

export function parseFilters(args: string[]): Filters {
  const filters: Filters = {};
  for (const argument of args) {
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? "" : argument.slice(separator + 1);
    if (flag === "--tool" && ["claude", "codex", "opencode"].includes(value)) {
      filters.tool = value as ToolchainName;
    } else if (flag === "--platform" && ["darwin", "linux"].includes(value)) {
      filters.platform = value as ToolchainPlatform;
    } else if (flag === "--arch" && ["arm64", "x64"].includes(value)) {
      filters.architecture = value as ToolchainArchitecture;
    } else {
      throw new Error(
        `Unknown filter ${argument}. Use --tool=claude|codex|opencode, `
        + "--platform=darwin|linux, or --arch=arm64|x64.",
      );
    }
  }
  return filters;
}

export function validateDownloadUrl(url: URL, allowedHosts: readonly string[]): void {
  if (url.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS artifact URL: ${url.href}`);
  }
  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`Refusing artifact host outside allowlist: ${url.hostname}`);
  }
}

async function fetchArtifact(artifact: ToolchainArtifact): Promise<Response> {
  let current = new URL(artifact.archive.url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    validateDownloadUrl(current, artifact.archive.allowedHosts);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status < 300 || response.status >= 400) {
      if (!response.ok || !response.body) {
        throw new Error(
          `Artifact request failed with HTTP ${response.status}: ${current.href}`,
        );
      }
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Artifact redirect omitted Location: ${current.href}`);
    }
    current = new URL(location, current);
  }
  throw new Error(`Artifact exceeded ${MAX_REDIRECTS} redirects`);
}

async function hashFile(filePath: string): Promise<Digest> {
  const hash = createHash("sha256");
  const file = createReadStream(filePath);
  for await (const chunk of file) hash.update(chunk);
  const fileStat = await stat(filePath);
  return { size: fileStat.size, sha256: hash.digest("hex") };
}

async function hashStream(stream: ReadableStream<Uint8Array>): Promise<Digest> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    hash.update(value);
  }
  return { size, sha256: hash.digest("hex") };
}

export function expectDigest(
  label: string,
  actual: Digest,
  expected: Digest,
): void {
  if (actual.size !== expected.size) {
    throw new Error(
      `${label} size mismatch: expected ${expected.size}, received ${actual.size}`,
    );
  }
  if (actual.sha256 !== expected.sha256) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected.sha256}, received ${actual.sha256}`,
    );
  }
}

async function hashExecutable(
  artifact: ToolchainArtifact,
  archivePath: string,
): Promise<Digest> {
  const command = artifact.archive.format === "zip"
    ? ["unzip", "-p", archivePath, artifact.archive.entryPath]
    : ["tar", "-xOzf", archivePath, artifact.archive.entryPath];
  const extractor = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [digest, stderr, exitCode] = await Promise.all([
    hashStream(extractor.stdout),
    new Response(extractor.stderr).text(),
    extractor.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Could not extract ${artifact.archive.entryPath}: ${stderr.slice(0, 2_000)}`,
    );
  }
  return digest;
}

/** Formats a size the way the manifest writes them, with `_` separators. */
function formatManifestSize(size: number): string {
  return size.toLocaleString("en-US").replace(/,/g, "_");
}

async function verifyArtifact(
  artifact: ToolchainArtifact,
  temporaryRoot: string,
  options: { emit?: boolean } = {},
): Promise<void> {
  const target = `${artifact.name}:${artifact.platform}:${artifact.architecture}`;
  console.log(`${options.emit ? "Hashing" : "Verifying"} ${target} ${artifact.version}`);
  const response = await fetchArtifact(artifact);
  const archivePath = join(
    temporaryRoot,
    `${artifact.name}-${artifact.platform}-${artifact.architecture}.${artifact.archive.format}`,
  );
  await Bun.write(archivePath, response);

  const archiveDigest = await hashFile(archivePath);
  const executableDigest = await hashExecutable(artifact, archivePath);

  if (options.emit) {
    // A version bump changes all four digests per artifact. Printing them in
    // manifest form means one download pass instead of one per mismatch.
    console.log(
      [
        `  // ${target}`,
        `  archive.size:      ${formatManifestSize(archiveDigest.size)},`,
        `  archive.sha256:    "${archiveDigest.sha256}",`,
        `  executable.size:   ${formatManifestSize(executableDigest.size)},`,
        `  executable.sha256: "${executableDigest.sha256}",`,
      ].join("\n"),
    );
  } else {
    expectDigest(`${target} archive`, archiveDigest, {
      size: artifact.archive.size,
      sha256: artifact.archive.sha256,
    });
    expectDigest(`${target} executable`, executableDigest, {
      size: artifact.executable.size,
      sha256: artifact.executable.sha256,
    });
  }

  await rm(archivePath, { force: true });
}

async function main(): Promise<void> {
  if (process.env.RUN_LIVE_TOOLCHAIN_ARTIFACTS !== "1") {
    throw new Error(
      "This downloads every selected release artifact. Re-run with "
      + "RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 after reviewing the optional filters.",
    );
  }

  const args = process.argv.slice(2);
  // `--emit` prints the computed digests instead of asserting them, for the
  // version-bump workflow in docs/codex-upgrade-guide.md.
  const emit = args.includes("--emit");
  const filters = parseFilters(args);
  const selected = PINNED_TOOLCHAIN_ARTIFACTS.filter((artifact) =>
    (!filters.tool || artifact.name === filters.tool)
    && (!filters.platform || artifact.platform === filters.platform)
    && (!filters.architecture || artifact.architecture === filters.architecture)
  );
  if (selected.length === 0) throw new Error("No artifacts matched the filters");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "ork-toolchain-verify-"));
  try {
    for (const artifact of selected) {
      await verifyArtifact(artifact, temporaryRoot, { emit });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  console.log(
    emit
      ? `Hashed ${selected.length} artifact(s); paste the values into toolchain-manifest.ts`
      : `Verified ${selected.length} pinned toolchain artifact(s)`,
  );
}

if (import.meta.main) {
  await main();
}
