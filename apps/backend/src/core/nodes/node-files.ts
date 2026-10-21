import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { normalizeConfiguredProjectFiles, isPathInsideRoot } from "../commands-project-files.js";
import { validateRelativeFilePath } from "../path-safety.js";
import { runCommand } from "../shell.js";
import type { StorageService } from "../storage.js";

/**
 * File operations a command node uses on a node (including itself) for
 * cross-node file transfer, environment seed files and project-file
 * comparison (docs/architecture/command-nodes.md, "Projects on leaf nodes").
 *
 * Every path is relative and confined to its scope's root (realpath
 * checked); only regular files are read or written. File contents and
 * `.env` values never reach a log, an event or an error message.
 */

export const NODE_FILE_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_NODE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENV_FILE_BYTES = 1024 * 1024;
const UPLOAD_PREFIX = ".orkestrator-upload-";

/** Where a file lives on a node. */
export type NodeFileScope =
  | { environmentId: string }
  | { projectId: string }
  /** The staging area for an environment's seed files (deleted after setup). */
  | { seedEnvironmentId: string };

export function seedFilesDir(dataDir: string, environmentId: string): string {
  return path.join(dataDir, "node-seed", environmentId.replace(/[^A-Za-z0-9_.-]/g, "_"));
}

export function parseNodeFileScope(value: unknown): NodeFileScope {
  const record = value as Record<string, unknown> | null;
  if (record && typeof record.environmentId === "string" && record.environmentId) {
    return { environmentId: record.environmentId };
  }
  if (record && typeof record.projectId === "string" && record.projectId) {
    return { projectId: record.projectId };
  }
  if (record && typeof record.seedEnvironmentId === "string" && record.seedEnvironmentId) {
    return { seedEnvironmentId: record.seedEnvironmentId };
  }
  throw new Error("Expected a file scope: an environmentId, a projectId or a seedEnvironmentId.");
}

export class NodeFiles {
  private readonly uploads = new Map<
    string,
    {
      target: string;
      temp: string;
      size: number;
      written: number;
      sha256: string;
      overwrite: boolean;
    }
  >();

  constructor(private readonly storage: StorageService) {}

  /** The scope's root directory on this node. */
  async root(scope: NodeFileScope, options: { create?: boolean } = {}): Promise<string> {
    if ("seedEnvironmentId" in scope) {
      const dir = seedFilesDir(this.storage.getDataDir(), scope.seedEnvironmentId);
      if (options.create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    }
    if ("projectId" in scope) {
      const project = await this.storage.getProject(scope.projectId);
      if (!project?.localPath) throw new Error("That project has no local checkout on this node.");
      return project.localPath;
    }
    const environment = await this.storage.getEnvironment(scope.environmentId);
    if (!environment) throw new Error("That environment does not exist on this node.");
    if (environment.environmentType === "containerized") {
      throw new Error("File transfer into containerized environments is not supported yet.");
    }
    if (!environment.worktreePath)
      throw new Error("That environment has no workspace yet; start it first.");
    return environment.worktreePath;
  }

  private async resolve(
    scope: NodeFileScope,
    relativePath: string,
    forWrite: boolean,
  ): Promise<string> {
    const safe = validateRelativeFilePath(relativePath, "file path");
    const root = await fs.realpath(await this.root(scope, { create: forWrite }));
    const target = path.join(root, safe);
    if (forWrite) {
      const parent = path.dirname(target);
      await fs.mkdir(parent, { recursive: true });
      const realParent = await fs.realpath(parent);
      if (!isPathInsideRoot(realParent, root)) throw new Error("The file path leaves its scope.");
      return path.join(realParent, path.basename(target));
    }
    let real: string;
    try {
      real = await fs.realpath(target);
    } catch {
      throw Object.assign(new Error(`File not found: ${safe}`), { code: "not-found" });
    }
    if (!isPathInsideRoot(real, root)) throw new Error("The file path leaves its scope.");
    return real;
  }

  async stat(
    scope: NodeFileScope,
    relativePath: string,
  ): Promise<{ exists: boolean; size?: number; sha256?: string }> {
    let file: string;
    try {
      file = await this.resolve(scope, relativePath, false);
    } catch (error) {
      if ((error as { code?: unknown }).code === "not-found") return { exists: false };
      throw error;
    }
    const stats = await fs.stat(file);
    if (!stats.isFile()) return { exists: false };
    return { exists: true, size: stats.size, sha256: await sha256File(file) };
  }

  /** One chunk of a file, base64. */
  async read(
    scope: NodeFileScope,
    relativePath: string,
    offset: number,
    length: number,
  ): Promise<{ contentBase64: string; size: number; eof: boolean }> {
    const file = await this.resolve(scope, relativePath, false);
    const stats = await fs.stat(file);
    if (!stats.isFile()) throw new Error("Only regular files can be transferred.");
    if (stats.size > MAX_NODE_FILE_BYTES) throw new Error("The file is larger than 64 MiB.");
    const bounded = Math.max(0, Math.min(length, NODE_FILE_CHUNK_BYTES));
    const handle = await fs.open(file, fsConstants.O_RDONLY);
    try {
      const buffer = Buffer.alloc(Math.max(0, Math.min(bounded, stats.size - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return {
        contentBase64: buffer.subarray(0, bytesRead).toString("base64"),
        size: stats.size,
        eof: offset + bytesRead >= stats.size,
      };
    } finally {
      await handle.close();
    }
  }

  /** Start an upload; the file appears only when `commit` verifies size and hash. */
  async beginWrite(input: {
    scope: NodeFileScope;
    path: string;
    size: number;
    sha256: string;
    overwrite: boolean;
  }): Promise<{ uploadId: string }> {
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_NODE_FILE_BYTES) {
      throw new Error("The file is larger than 64 MiB.");
    }
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("Expected a sha256 hash.");
    const target = await this.resolve(input.scope, input.path, true);
    if (!input.overwrite) {
      const exists = await fs.stat(target).then(
        () => true,
        () => false,
      );
      if (exists)
        throw Object.assign(new Error(`${input.path} already exists there.`), { code: "exists" });
    }
    const uploadId = randomUUID();
    const temp = path.join(path.dirname(target), `${UPLOAD_PREFIX}${uploadId}`);
    await fs.writeFile(temp, Buffer.alloc(0), { mode: 0o600, flag: "wx" });
    this.uploads.set(uploadId, {
      target,
      temp,
      size: input.size,
      written: 0,
      sha256: input.sha256,
      overwrite: input.overwrite,
    });
    return { uploadId };
  }

  async appendWrite(uploadId: string, contentBase64: string): Promise<{ written: number }> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error("That upload is not open.");
    const chunk = Buffer.from(contentBase64, "base64");
    if (chunk.length > NODE_FILE_CHUNK_BYTES) throw new Error("A chunk is at most 4 MiB.");
    if (upload.written + chunk.length > upload.size) {
      await this.abortWrite(uploadId);
      throw new Error("The upload is larger than announced.");
    }
    await fs.appendFile(upload.temp, chunk);
    upload.written += chunk.length;
    return { written: upload.written };
  }

  async commitWrite(uploadId: string): Promise<{ bytes: number; sha256: string }> {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error("That upload is not open.");
    this.uploads.delete(uploadId);
    const actual = await sha256File(upload.temp);
    if (upload.written !== upload.size || actual !== upload.sha256) {
      await fs.rm(upload.temp, { force: true });
      throw new Error("The transferred file did not match its size or hash; nothing was written.");
    }
    if (!upload.overwrite) {
      await fs.link(upload.temp, upload.target).catch(async (error: unknown) => {
        await fs.rm(upload.temp, { force: true });
        throw Object.assign(new Error("The destination appeared during the transfer."), {
          code: (error as { code?: unknown }).code === "EEXIST" ? "exists" : "failed",
        });
      });
      await fs.rm(upload.temp, { force: true });
    } else {
      await fs.rename(upload.temp, upload.target);
    }
    return { bytes: upload.written, sha256: actual };
  }

  async abortWrite(uploadId: string): Promise<{ aborted: boolean }> {
    const upload = this.uploads.get(uploadId);
    if (!upload) return { aborted: false };
    this.uploads.delete(uploadId);
    await fs.rm(upload.temp, { force: true });
    return { aborted: true };
  }

  /**
   * Read-only details a coordinator interrogates on an environment: its Git
   * status and diff against HEAD (bounded), one text file (bounded), and its
   * build pipelines' state (where tests run). Nothing here writes.
   */
  async environmentDetails(input: {
    environmentId: string;
    include: Array<"diff" | "file" | "tests">;
    path?: string;
  }): Promise<Record<string, unknown>> {
    const environment = await this.storage.getEnvironment(input.environmentId);
    if (!environment) throw new Error("That environment does not exist on this node.");
    const details: Record<string, unknown> = { environmentId: input.environmentId };
    if (input.include.includes("diff")) {
      const root = await this.root({ environmentId: input.environmentId });
      const git = async (args: string[], limit: number) => {
        const { stdout: text } = await runCommand("git", ["-C", root, ...args], {
          timeoutMs: 20_000,
        });
        return { text: text.slice(0, limit), truncated: text.length > limit };
      };
      const [status, stat, diff] = await Promise.all([
        git(["status", "--porcelain=v1"], 16 * 1024),
        git(["diff", "HEAD", "--stat"], 16 * 1024),
        git(["diff", "HEAD"], 64 * 1024),
      ]);
      details.diff = {
        status: status.text,
        stat: stat.text,
        patch: diff.text,
        truncated: diff.truncated || status.truncated,
      };
    }
    if (input.include.includes("file")) {
      if (!input.path) throw new Error("Name the file to read.");
      const file = await this.resolve({ environmentId: input.environmentId }, input.path, false);
      const stats = await fs.stat(file);
      const limit = 256 * 1024;
      const handle = await fs.open(file, fsConstants.O_RDONLY);
      try {
        const buffer = Buffer.alloc(Math.min(limit, stats.size));
        await handle.read(buffer, 0, buffer.length, 0);
        details.file = {
          path: input.path,
          size: stats.size,
          content: buffer.toString("utf8"),
          truncated: stats.size > limit,
        };
      } finally {
        await handle.close();
      }
    }
    if (input.include.includes("tests")) {
      const pipelines = await this.storage
        .listBuildPipelines(environment.projectId)
        .catch(() => []);
      details.tests = (pipelines as Array<Record<string, unknown>>)
        .filter((pipeline) => pipeline.environmentId === input.environmentId)
        .slice(-5)
        .map((pipeline) => ({
          id: pipeline.id,
          status: pipeline.status,
          ...(typeof pipeline.currentStage === "string"
            ? { currentStage: pipeline.currentStage }
            : {}),
          ...(Array.isArray(pipeline.stages)
            ? {
                stages: (pipeline.stages as Array<Record<string, unknown>>).map((stage) => ({
                  name: stage.name ?? stage.id,
                  status: stage.status,
                })),
              }
            : {}),
          updatedAt: pipeline.updatedAt,
        }));
    }
    return details;
  }

  /** Which of a project's seed files (`.env`, `.env.local`, selected files) its root has. */
  async seedFiles(projectId: string): Promise<Array<{ path: string; exists: boolean }>> {
    const config = await this.storage.getRepositoryConfig(projectId);
    const paths = [".env", ".env.local", ...normalizeConfiguredProjectFiles(config.filesToCopy)];
    const unique = [...new Set(paths)];
    return Promise.all(
      unique.map(async (entry) => ({
        path: entry,
        exists: (await this.stat({ projectId }, entry)).exists,
      })),
    );
  }

  /**
   * Fingerprints of a project's files under a one-time key: whole files,
   * and for `.env`-style files each key's value separately. Values never
   * leave the node; a fingerprint with a random key cannot be compared with
   * anything except the same comparison's other fingerprints.
   */
  async fingerprints(
    projectId: string,
    files: string[],
    key: Buffer,
  ): Promise<
    Array<{ path: string; exists: boolean; file?: string; envKeys?: Record<string, string> }>
  > {
    return Promise.all(
      files.map(async (relativePath) => {
        let file: string;
        try {
          file = await this.resolve({ projectId }, relativePath, false);
        } catch (error) {
          if ((error as { code?: unknown }).code === "not-found")
            return { path: relativePath, exists: false };
          throw error;
        }
        const content = await fs.readFile(file);
        const entry: {
          path: string;
          exists: boolean;
          file?: string;
          envKeys?: Record<string, string>;
        } = {
          path: relativePath,
          exists: true,
          file: createHmac("sha256", key).update(content).digest("hex"),
        };
        if (isEnvFile(relativePath) && content.length <= MAX_ENV_FILE_BYTES) {
          const envKeys: Record<string, string> = {};
          for (const [name, value] of parseEnv(content.toString("utf8"))) {
            envKeys[name] = createHmac("sha256", key).update(`${name}\0${value}`).digest("hex");
          }
          entry.envKeys = envKeys;
        }
        return entry;
      }),
    );
  }

  /** The plain value of one key, for an approved reveal or update only. */
  async envValues(
    projectId: string,
    relativePath: string,
    keys: string[],
  ): Promise<Record<string, string>> {
    if (!isEnvFile(relativePath)) throw new Error("Only .env files have keys.");
    const file = await this.resolve({ projectId }, relativePath, false);
    const values = new Map(parseEnv(await fs.readFile(file, "utf8")));
    const result: Record<string, string> = {};
    for (const name of keys) {
      const value = values.get(name);
      if (value !== undefined) result[name] = value;
    }
    return result;
  }

  /**
   * Set or remove keys in a project's `.env` file, keeping every other line
   * (comments, order, unrelated keys) as it is. Written atomically, 0600.
   */
  async applyEnvKeys(
    projectId: string,
    relativePath: string,
    set: Record<string, string>,
    remove: string[],
  ): Promise<{ set: number; removed: number }> {
    if (!isEnvFile(relativePath)) throw new Error("Only .env files have keys.");
    for (const name of [...Object.keys(set), ...remove]) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error("A key name is not valid.");
    }
    for (const value of Object.values(set)) {
      if (/[\r\n]/.test(value)) throw new Error("A value cannot span lines.");
    }
    const file = await this.resolve({ projectId }, relativePath, true);
    const current = await fs.readFile(file, "utf8").catch(() => "");
    const lines = current.length ? current.split(/\r?\n/) : [];
    if (lines.at(-1) === "") lines.pop();
    const pending = new Map(Object.entries(set));
    const removing = new Set(remove);
    let removed = 0;
    const next: string[] = [];
    for (const line of lines) {
      const name = envLineKey(line);
      if (name && removing.has(name)) {
        removed += 1;
        continue;
      }
      if (name && pending.has(name)) {
        next.push(`${name}=${quoteEnv(pending.get(name)!)}`);
        pending.delete(name);
        continue;
      }
      next.push(line);
    }
    for (const [name, value] of pending) next.push(`${name}=${quoteEnv(value)}`);
    const temp = `${file}${UPLOAD_PREFIX}${randomUUID()}`;
    await fs.writeFile(temp, `${next.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temp, file);
    return { set: Object.keys(set).length, removed };
  }
}

export function isEnvFile(relativePath: string): boolean {
  const name = path.basename(relativePath);
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
}

function envLineKey(line: string): string | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line);
  return match ? match[1]! : null;
}

/** `KEY=value` pairs of a dotenv file (last one wins); comments and blank lines skipped. */
export function parseEnv(text: string): Array<[string, string]> {
  const pairs = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const name = envLineKey(line);
    if (!name) continue;
    let value = line.slice(line.indexOf("=") + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    pairs.set(name, value);
  }
  return [...pairs];
}

function quoteEnv(value: string): string {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(file, fsConstants.O_RDONLY);
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest("hex");
}
