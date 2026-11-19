/**
 * The content-addressed artifact cache
 * (docs/architecture/agent-capabilities-management.md, "Package delivery").
 *
 * One immutable directory per package revision, named by its tree digest,
 * under `<dataDir>/capability-artifacts/`. A write goes to a temporary
 * directory first and is renamed into place only after its digest is
 * checked, so an entry is either complete or absent. Reference counts live in
 * SQLite (`PackageArtifactRecord.refs`); the cache holds only bytes.
 *
 * Machines receive artifacts as a JSON bundle (path, executable bit, base64
 * content) cut into bounded chunks (`stageChunk`), reassembled and verified
 * against the digest the command node named before anything is installed.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { CAPABILITY_LIMITS } from "@orkestrator/protocol/capability-resources";

import {
  CapabilityError,
  confinedPath,
  readPackageTree,
  treeDigest,
  validatePackageFiles,
  type PackageFile,
} from "./security.js";

const DIGEST = /^sha256:([0-9a-f]{64})$/;

export interface ArtifactBundleFile {
  path: string;
  executable: boolean;
  data: string;
}

export class CapabilityArtifactStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "capability-artifacts");
  }

  private directory(digest: string): string {
    const match = DIGEST.exec(digest);
    if (!match) throw new CapabilityError("invalid-request", "Not an artifact digest.");
    return path.join(this.root, match[1]!);
  }

  async has(digest: string): Promise<boolean> {
    return (await fs.stat(this.directory(digest)).catch(() => null))?.isDirectory() === true;
  }

  /** Stores `files` and returns their digest; an existing identical entry is reused. */
  async put(files: readonly PackageFile[]): Promise<string> {
    const digest = treeDigest(files);
    const target = this.directory(digest);
    if (await this.has(digest)) return digest;
    await fs.mkdir(this.root, { recursive: true });
    const staging = path.join(this.root, `.tmp-${randomBytes(8).toString("hex")}`);
    await fs.mkdir(staging);
    try {
      for (const file of files) {
        const destination = confinedPath(staging, file.path);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.content, { mode: file.executable ? 0o755 : 0o644 });
      }
      await fs.rename(staging, target).catch(async (error: NodeJS.ErrnoException) => {
        // Another writer stored the same digest first: keep theirs.
        if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
      });
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    return digest;
  }

  /** The stored files, verified against `digest`. */
  async get(digest: string): Promise<PackageFile[]> {
    const directory = this.directory(digest);
    if (!(await this.has(digest))) {
      throw new CapabilityError(
        "not-found",
        "The package artifact is not in this machine's cache.",
      );
    }
    const files = await readPackageTree(directory);
    if (treeDigest(files) !== digest) {
      throw new CapabilityError(
        "unsafe-content",
        "A cached artifact no longer matches its digest.",
      );
    }
    return files;
  }

  async remove(digest: string): Promise<void> {
    await fs.rm(this.directory(digest), { recursive: true, force: true });
  }

  /** Every digest in the cache, for garbage collection against the refcounts. */
  async list(): Promise<string[]> {
    const entries = await fs.readdir(this.root).catch(() => [] as string[]);
    return entries.filter((name) => /^[0-9a-f]{64}$/.test(name)).map((name) => `sha256:${name}`);
  }

  // --- Transfer --------------------------------------------------------------

  /** `files` as a transfer bundle, cut into chunks of at most `artifactChunkBytes`. */
  static bundleChunks(files: readonly PackageFile[]): string[] {
    const bundle: ArtifactBundleFile[] = files.map((file) => ({
      path: file.path,
      executable: file.executable,
      data: file.content.toString("base64"),
    }));
    // Escaping non-ASCII code units lets old and new receivers decode each chunk independently.
    const text = JSON.stringify(bundle).replace(/[^\x00-\x7f]/gu, (character) =>
      character
        .split("")
        .map((unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"))
        .join(""),
    );
    const chunks: string[] = [];
    for (let offset = 0; offset < text.length; offset += CAPABILITY_LIMITS.artifactChunkBytes) {
      chunks.push(text.slice(offset, offset + CAPABILITY_LIMITS.artifactChunkBytes));
    }
    return chunks.length > 0 ? chunks : ["[]"];
  }

  /**
   * Records one chunk of an incoming bundle. When every chunk is present the
   * bundle is decoded, validated, checked against `digest` and stored. A
   * digest mismatch discards the staged chunks and fails: nothing is
   * installed from bytes that are not the ones the command node named.
   */
  async stageChunk(
    digest: string,
    index: number,
    count: number,
    data: string,
  ): Promise<{ complete: boolean; missing: number[] }> {
    const match = DIGEST.exec(digest);
    if (!match) throw new CapabilityError("invalid-request", "Not an artifact digest.");
    const maxChunks =
      Math.ceil((CAPABILITY_LIMITS.maxPackageBytes * 1.4) / CAPABILITY_LIMITS.artifactChunkBytes) +
      1;
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > maxChunks ||
      index < 0 ||
      index >= count
    ) {
      throw new CapabilityError("invalid-request", "Chunk numbers are out of range.");
    }
    if (data.length > CAPABILITY_LIMITS.artifactChunkBytes) {
      throw new CapabilityError("too-large", "A chunk is larger than the transfer limit.");
    }
    if (await this.has(digest)) return { complete: true, missing: [] };
    const staging = path.join(this.root, ".staging", match[1]!);
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, `${index}-of-${count}`), data);
    const present = new Set(
      (await fs.readdir(staging))
        .map((name) => /^(\d+)-of-(\d+)$/.exec(name))
        .filter((m): m is RegExpExecArray => m !== null && Number(m[2]) === count)
        .map((m) => Number(m[1])),
    );
    const missing = Array.from({ length: count }, (_, i) => i).filter((i) => !present.has(i));
    if (missing.length > 0) return { complete: false, missing };
    let text = "";
    for (let i = 0; i < count; i += 1) {
      text += await fs.readFile(path.join(staging, `${i}-of-${count}`), "utf8");
    }
    await fs.rm(staging, { recursive: true, force: true });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CapabilityError("unsafe-content", "The received package bundle is malformed.");
    }
    if (!Array.isArray(parsed)) {
      throw new CapabilityError("unsafe-content", "The received package bundle is malformed.");
    }
    const files = validatePackageFiles(
      parsed.map((entry: unknown) => {
        const file = entry as Partial<ArtifactBundleFile>;
        if (typeof file.path !== "string" || typeof file.data !== "string") {
          throw new CapabilityError("unsafe-content", "The received package bundle is malformed.");
        }
        return {
          path: file.path,
          executable: file.executable === true,
          content: Buffer.from(file.data, "base64"),
        };
      }),
    );
    if (treeDigest(files) !== digest) {
      throw new CapabilityError(
        "unsafe-content",
        "The received package does not match the digest the command node named.",
      );
    }
    await this.put(files);
    return { complete: true, missing: [] };
  }
}
