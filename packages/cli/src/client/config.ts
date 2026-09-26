import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";

/**
 * The operator client's private configuration: saved connections and an
 * explicitly chosen default. It lives in the caller's home directory, never in
 * a project or workspace, so cloning a repository cannot select a backend or
 * hand a worker an operator credential.
 */

export const CLI_CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 64;
const CONNECTION_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export type SavedConnection =
  | {
      kind: "descriptor";
      /** Absolute path of a backend's `backend-instance.json`. */
      descriptorPath: string;
      installationId?: string;
      addedAt: string;
    }
  | {
      kind: "endpoint";
      url: string;
      /** Absolute path of a private file holding the gateway token. */
      credentialFile: string;
      installationId?: string;
      addedAt: string;
    };

export interface CliConfig {
  version: typeof CLI_CONFIG_VERSION;
  defaultConnection?: string;
  connections: Record<string, SavedConnection>;
}

export function defaultCliConfigDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (env.ORKESTRATOR_CLI_CONFIG_DIR) return path.resolve(env.ORKESTRATOR_CLI_CONFIG_DIR);
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "orkestrator-cli");
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "orkestrator-cli");
}

export function isConnectionName(value: string): boolean {
  return CONNECTION_NAME.test(value);
}

export function assertConnectionName(value: string): void {
  if (!isConnectionName(value)) {
    throw new CliError(
      "invalid-input",
      "Connection names use 1–48 lowercase letters, digits, '.', '_' or '-'",
    );
  }
}

/** Throws unless `file` is a regular file with no group/other permissions. */
export async function assertPrivateFile(file: string, label: string): Promise<void> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(file);
  } catch {
    throw new CliError("connection-not-configured", `${label} does not exist`);
  }
  if (!stat.isFile()) throw new CliError("connection-not-configured", `${label} is not a file`);
  if ((stat.mode & 0o077) !== 0) {
    throw new CliError(
      "connection-not-configured",
      `${label} is accessible to other users; restrict it with chmod 600`,
    );
  }
}

function parseSaved(value: unknown): SavedConnection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const addedAt = typeof record.addedAt === "string" ? record.addedAt : new Date(0).toISOString();
  const installationId =
    typeof record.installationId === "string" && record.installationId.length <= 200
      ? record.installationId
      : undefined;
  if (
    record.kind === "descriptor" &&
    typeof record.descriptorPath === "string" &&
    path.isAbsolute(record.descriptorPath)
  ) {
    return {
      kind: "descriptor",
      descriptorPath: record.descriptorPath,
      ...(installationId ? { installationId } : {}),
      addedAt,
    };
  }
  if (
    record.kind === "endpoint" &&
    typeof record.url === "string" &&
    typeof record.credentialFile === "string" &&
    path.isAbsolute(record.credentialFile)
  ) {
    return {
      kind: "endpoint",
      url: record.url,
      credentialFile: record.credentialFile,
      ...(installationId ? { installationId } : {}),
      addedAt,
    };
  }
  return null;
}

export class CliConfigStore {
  constructor(readonly directory: string) {}

  get file(): string {
    return path.join(this.directory, "connections.json");
  }

  get credentialsDirectory(): string {
    return path.join(this.directory, "credentials");
  }

  get receiptsDirectory(): string {
    return path.join(this.directory, "receipts");
  }

  async read(): Promise<CliConfig> {
    let text: string;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile()) throw new Error("not a file");
      if ((stat.mode & 0o022) !== 0) {
        throw new CliError(
          "connection-not-configured",
          `${this.file} is writable by other users; restrict it with chmod 600`,
        );
      }
      if (stat.size > MAX_CONFIG_BYTES) throw new Error("too large");
      text = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: CLI_CONFIG_VERSION, connections: {} };
      }
      throw new CliError(
        "connection-not-configured",
        `Client configuration is unreadable: ${this.file}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Never echo the file: it may hold paths the caller considers private.
      throw new CliError(
        "connection-not-configured",
        `Client configuration is malformed: ${this.file}`,
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).version !== CLI_CONFIG_VERSION
    ) {
      throw new CliError(
        "connection-not-configured",
        `Client configuration has an unsupported format: ${this.file}`,
      );
    }
    const record = parsed as Record<string, unknown>;
    const connections: Record<string, SavedConnection> = {};
    const rawConnections =
      record.connections && typeof record.connections === "object" ? record.connections : {};
    for (const [name, value] of Object.entries(rawConnections as Record<string, unknown>)) {
      if (!isConnectionName(name)) continue;
      const saved = parseSaved(value);
      if (saved) connections[name] = saved;
    }
    const defaultConnection =
      typeof record.defaultConnection === "string" && connections[record.defaultConnection]
        ? record.defaultConnection
        : undefined;
    return {
      version: CLI_CONFIG_VERSION,
      ...(defaultConnection ? { defaultConnection } : {}),
      connections,
    };
  }

  async write(config: CliConfig): Promise<void> {
    if (Object.keys(config.connections).length > MAX_CONNECTIONS) {
      throw new CliError("invalid-input", `At most ${MAX_CONNECTIONS} connections can be saved`);
    }
    await writePrivateFile(this.file, `${JSON.stringify(config, null, 2)}\n`);
  }

  /** Stores a token in a private credential file owned by this client. */
  async storeCredential(name: string, token: string): Promise<string> {
    const file = path.join(this.credentialsDirectory, `${name}.json`);
    await writePrivateFile(file, `${JSON.stringify({ token })}\n`);
    return file;
  }
}

/** Atomic mode-0600 write inside a mode-0700 directory. */
export async function writePrivateFile(file: string, contents: string): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
