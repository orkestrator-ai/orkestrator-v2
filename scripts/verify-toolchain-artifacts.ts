import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  PINNED_TOOLCHAIN_ARTIFACTS,
  type ToolchainArchive,
  type ToolchainArtifact,
  type ToolchainArchitecture,
  type ToolchainName,
  type ToolchainPlatform,
} from "../apps/desktop/electron/toolchain-manifest";

type Digest = {
  size: number;
  sha256: string;
};

export type Filters = {
  tool?: ToolchainName;
  platform?: ToolchainPlatform;
  architecture?: ToolchainArchitecture;
};

export type VerifyToolchainArguments = {
  emit: boolean;
  filters: Filters;
};

const MAX_REDIRECTS = 10;
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;

export function parseFilters(args: string[]): Filters {
  const filters: Filters = {};
  for (const argument of args) {
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? "" : argument.slice(separator + 1);
    if (
      flag === "--tool" &&
      ["claude", "codex", "cursor", "grok", "opencode", "pi"].includes(value)
    ) {
      filters.tool = value as ToolchainName;
    } else if (flag === "--platform" && ["darwin", "linux"].includes(value)) {
      filters.platform = value as ToolchainPlatform;
    } else if (flag === "--arch" && ["arm64", "x64"].includes(value)) {
      filters.architecture = value as ToolchainArchitecture;
    } else {
      throw new Error(
        `Unknown filter ${argument}. Use --tool=claude|codex|cursor|grok|opencode|pi, ` +
          "--platform=darwin|linux, or --arch=arm64|x64.",
      );
    }
  }
  return filters;
}

export function parseArguments(args: string[]): VerifyToolchainArguments {
  let emit = false;
  const filterArgs: string[] = [];
  for (const argument of args) {
    if (argument === "--emit") {
      if (emit) throw new Error("Duplicate mode --emit");
      emit = true;
    } else {
      filterArgs.push(argument);
    }
  }
  return { emit, filters: parseFilters(filterArgs) };
}

export function validateDownloadUrl(url: URL, allowedHosts: readonly string[]): void {
  if (url.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS artifact URL: ${url.href}`);
  }
  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`Refusing artifact host outside allowlist: ${url.hostname}`);
  }
}

export type FetchArtifact = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchArchive(
  archive: ToolchainArchive,
  fetchImpl: FetchArtifact = fetch,
): Promise<Response> {
  let current = new URL(archive.url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    validateDownloadUrl(current, archive.allowedHosts);
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status < 300 || response.status >= 400) {
      if (!response.ok || !response.body) {
        throw new Error(`Artifact request failed with HTTP ${response.status}: ${current.href}`);
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

export function fetchArtifact(
  artifact: ToolchainArtifact,
  fetchImpl: FetchArtifact = fetch,
): Promise<Response> {
  return fetchArchive(artifact.archive, fetchImpl);
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

export function expectDigest(label: string, actual: Digest, expected: Digest): void {
  if (actual.size !== expected.size) {
    throw new Error(`${label} size mismatch: expected ${expected.size}, received ${actual.size}`);
  }
  if (actual.sha256 !== expected.sha256) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected.sha256}, received ${actual.sha256}`,
    );
  }
}

export async function hashArchiveEntry(
  archive: ToolchainArchive,
  archivePath: string,
): Promise<Digest> {
  const command =
    archive.format === "zip"
      ? ["unzip", "-p", archivePath, archive.entryPath]
      : ["tar", "-xOzf", archivePath, archive.entryPath];
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
    throw new Error(`Could not extract ${archive.entryPath}: ${stderr.slice(0, 2_000)}`);
  }
  return digest;
}

export function hashExecutable(artifact: ToolchainArtifact, archivePath: string): Promise<Digest> {
  return hashArchiveEntry(artifact.archive, archivePath);
}

/** Formats a size the way the manifest writes them, with `_` separators. */
function formatManifestSize(size: number): string {
  return size.toLocaleString("en-US").replace(/,/g, "_");
}

export type BundleIntegrity = {
  fileCount: number;
  totalSize: number;
  sha256: string;
};

/**
 * Reproduce the bundle digest `toolchain-manager.ts` checks on every startup.
 *
 * It has to agree byte for byte with `bundleTreeEntries` and `bundleTreeDigest`
 * there, including the two details that are easy to lose: the primary
 * executable is excluded, and a file counts as executable when the *archive*
 * header carries any exec bit — which is precisely what the extractor turns
 * into `0o500` on disk. Reading it from the archive rather than from an
 * extracted copy keeps this independent of the umask of whoever runs it.
 */
export async function hashBundleIntegrity(
  archive: ToolchainArchive,
  archivePath: string,
): Promise<BundleIntegrity> {
  const root = archive.bundleRoot!;
  const executableRelativePath = archive.entryPath.slice(root.length);
  const extractionRoot = await mkdtemp(join(tmpdir(), "orkestrator-bundle-"));
  try {
    // Extracted and walked rather than parsed out of `tar -tv`, whose column
    // layout differs between BSD and GNU tar. Walking the tree is also what
    // `toolchain-manager.ts` does, so the two cannot drift on how a file is
    // measured — only on where the bytes came from.
    const extractor = Bun.spawn(
      ["tar", "-xzf", archivePath, "-C", extractionRoot, "--strip-components=1", root.slice(0, -1)],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(extractor.stderr).text(),
      extractor.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Could not extract ${archive.url}: ${stderr.slice(0, 2_000)}`);
    }

    const entries: Array<{ path: string; size: number; executable: boolean; sha256: string }> = [];
    const visit = async (directory: string, prefix = ""): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const filePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(filePath, relativePath);
          continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error(`${archive.url} contains an unsupported entry: ${relativePath}`);
        }
        // The manager excludes the primary executable from the tree digest and
        // pins it separately, so it must be skipped here too.
        if (relativePath === executableRelativePath) continue;
        const info = await lstat(filePath);
        entries.push({
          path: relativePath,
          size: info.size,
          executable: (info.mode & 0o111) !== 0,
          sha256: (await hashFile(filePath)).sha256,
        });
      }
    };
    await visit(extractionRoot);

    entries.sort((left, right) => left.path.localeCompare(right.path));
    const hash = createHash("sha256");
    let totalSize = 0;
    for (const entry of entries) {
      totalSize += entry.size;
      hash.update(entry.path);
      hash.update("\0");
      hash.update(String(entry.size));
      hash.update("\0");
      hash.update(entry.executable ? "x" : "-");
      hash.update("\0");
      hash.update(entry.sha256);
      hash.update("\n");
    }
    return { fileCount: entries.length, totalSize, sha256: hash.digest("hex") };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

/**
 * Downloads one archive, hashes it and its pinned entry, then either prints the
 * digests in manifest form or asserts them. Used for an artifact's primary
 * executable and for each of its companions.
 */
async function verifyArchive(
  label: string,
  archive: ToolchainArchive,
  executable: { size: number; sha256: string },
  archivePath: string,
  options: { emit?: boolean; fetchImpl?: FetchArtifact },
): Promise<void> {
  const response = await fetchArchive(archive, options.fetchImpl);
  if (!response.body) throw new Error(`Artifact response omitted a body: ${archive.url}`);
  await pipeline(
    Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>),
    createWriteStream(archivePath),
  );

  const archiveDigest = await hashFile(archivePath);
  const executableDigest = await hashArchiveEntry(archive, archivePath);
  // Only bundle artifacts have one, and computing it costs a hash of every file
  // in the tree — so it is skipped entirely for the single-file archives.
  const bundleIntegrity = archive.bundleIntegrity
    ? await hashBundleIntegrity(archive, archivePath)
    : undefined;

  if (options.emit) {
    // A version bump changes all four digests per archive. Printing them in
    // manifest form means one download pass instead of one per mismatch.
    console.log(
      [
        `  // ${label}`,
        `  archive.size:      ${formatManifestSize(archiveDigest.size)},`,
        `  archive.sha256:    "${archiveDigest.sha256}",`,
        `  executable.size:   ${formatManifestSize(executableDigest.size)},`,
        `  executable.sha256: "${executableDigest.sha256}",`,
        ...(bundleIntegrity
          ? [
              `  bundleIntegrity.fileCount: ${formatManifestSize(bundleIntegrity.fileCount)},`,
              `  bundleIntegrity.totalSize: ${formatManifestSize(bundleIntegrity.totalSize)},`,
              `  bundleIntegrity.sha256:    "${bundleIntegrity.sha256}",`,
            ]
          : []),
      ].join("\n"),
    );
  } else {
    expectDigest(`${label} archive`, archiveDigest, {
      size: archive.size,
      sha256: archive.sha256,
    });
    expectDigest(`${label} executable`, executableDigest, executable);
    if (bundleIntegrity && archive.bundleIntegrity) {
      const expected = archive.bundleIntegrity;
      if (
        bundleIntegrity.fileCount !== expected.fileCount ||
        bundleIntegrity.totalSize !== expected.totalSize ||
        bundleIntegrity.sha256 !== expected.sha256
      ) {
        throw new Error(
          `${label} bundle integrity mismatch: expected ${expected.fileCount} files / ` +
            `${expected.totalSize} bytes / ${expected.sha256}, got ${bundleIntegrity.fileCount} / ` +
            `${bundleIntegrity.totalSize} / ${bundleIntegrity.sha256}`,
        );
      }
    }
  }

  await rm(archivePath, { force: true });
}

export async function verifyArtifact(
  artifact: ToolchainArtifact,
  temporaryRoot: string,
  options: { emit?: boolean; fetchImpl?: FetchArtifact } = {},
): Promise<void> {
  const target = `${artifact.name}:${artifact.platform}:${artifact.architecture}`;
  console.log(`${options.emit ? "Hashing" : "Verifying"} ${target} ${artifact.version}`);
  await verifyArchive(
    target,
    artifact.archive,
    { size: artifact.executable.size, sha256: artifact.executable.sha256 },
    join(
      temporaryRoot,
      `${artifact.name}-${artifact.platform}-${artifact.architecture}.${artifact.archive.format}`,
    ),
    options,
  );

  // A companion is shipped from its own release asset, so a version bump moves
  // its digests independently of the primary executable's.
  for (const companion of artifact.companions ?? []) {
    await verifyArchive(
      `${target} ${companion.fileName}`,
      companion.archive,
      companion.executable,
      join(
        temporaryRoot,
        `${companion.fileName}-${artifact.platform}-${artifact.architecture}.${companion.archive.format}`,
      ),
      options,
    );
  }
}

export function selectArtifacts(
  filters: Filters,
  artifacts: readonly ToolchainArtifact[] = PINNED_TOOLCHAIN_ARTIFACTS,
): ToolchainArtifact[] {
  return artifacts.filter(
    (artifact) =>
      (!filters.tool || artifact.name === filters.tool) &&
      (!filters.platform || artifact.platform === filters.platform) &&
      (!filters.architecture || artifact.architecture === filters.architecture),
  );
}

export interface RunOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  artifacts?: readonly ToolchainArtifact[];
  /** Injected so the run/selection/cleanup logic is testable without downloads. */
  verify?: (
    artifact: ToolchainArtifact,
    temporaryRoot: string,
    options: { emit: boolean },
  ) => Promise<void>;
  log?: (message: string) => void;
}

export async function run(options: RunOptions = {}): Promise<void> {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    artifacts = PINNED_TOOLCHAIN_ARTIFACTS,
    verify = verifyArtifact,
    log = console.log,
  } = options;

  if (env.RUN_LIVE_TOOLCHAIN_ARTIFACTS !== "1") {
    throw new Error(
      "This downloads every selected release artifact. Re-run with " +
        "RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 after reviewing the optional filters.",
    );
  }

  // `--emit` prints the computed digests instead of asserting them, for the
  // version-bump workflow in docs/upgrade-agents.md.
  const { emit, filters } = parseArguments(argv);
  const selected = selectArtifacts(filters, artifacts);
  if (selected.length === 0) throw new Error("No artifacts matched the filters");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "ork-toolchain-verify-"));
  try {
    for (const artifact of selected) {
      await verify(artifact, temporaryRoot, { emit });
    }
  } finally {
    // The scratch root holds full release archives, so it has to go even when a
    // digest mismatch aborts the loop part-way through.
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  log(
    emit
      ? `Hashed ${selected.length} artifact(s); paste the values into toolchain-manifest.ts`
      : `Verified ${selected.length} pinned toolchain artifact(s)`,
  );
}

if (import.meta.main) {
  await run();
}
