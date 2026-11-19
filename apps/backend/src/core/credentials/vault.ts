import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CredentialVaultKind,
  CredentialVaultStatus,
} from "@orkestrator/protocol/agent-credentials";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("credentials");

/**
 * Where credential values live. The only code that reads a value is the
 * credential service, at the moment an admitted operation needs it; there is
 * no command, tool or route that returns one.
 *
 * Entry ids are random (never derived from a value) and name nothing but the
 * entry, so a database row that names one reveals nothing.
 */
export interface CredentialVault {
  readonly kind: CredentialVaultKind;
  put(entryId: string, value: string): Promise<void>;
  /** The value, or null when the vault does not hold it. */
  get(entryId: string): Promise<string | null>;
  delete(entryId: string): Promise<void>;
}

export class CredentialVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultError";
  }
}

const ENTRY_ID = /^[a-f0-9-]{36}$/u;
function assertEntryId(entryId: string): void {
  if (!ENTRY_ID.test(entryId)) throw new CredentialVaultError("Invalid credential entry id");
}

export function newCredentialEntryId(): string {
  return randomUUID();
}

/** Values held by this process only: temporary grants, and every value under tests. */
export class MemoryCredentialVault implements CredentialVault {
  readonly kind = "memory" as const;
  private readonly values = new Map<string, string>();

  async put(entryId: string, value: string): Promise<void> {
    assertEntryId(entryId);
    this.values.set(entryId, value);
  }

  async get(entryId: string): Promise<string | null> {
    return this.values.get(entryId) ?? null;
  }

  async delete(entryId: string): Promise<void> {
    this.values.delete(entryId);
  }

  /** Test helper: how many values are held. */
  size(): number {
    return this.values.size;
  }
}

/**
 * Owner-only files under the data directory, one per entry. Plaintext at
 * 0600 in a 0700 directory, the same protection `config.json` gives the
 * provider keys (storage.md, "Provider secrets at rest"), and disclosed as
 * such wherever a person saves a value. Used where no keychain answers
 * (a headless Linux host) and by development profiles, which must not leave
 * items in the user's keychain.
 *
 * The directory is not a database store and not under `backups/`, so the
 * hourly snapshots never copy it.
 */
export class FileCredentialVault implements CredentialVault {
  readonly kind = "file" as const;

  constructor(private readonly directory: string) {}

  private file(entryId: string): string {
    assertEntryId(entryId);
    return path.join(this.directory, `${entryId}.secret`);
  }

  async put(entryId: string, value: string): Promise<void> {
    const target = this.file(entryId);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const temporary = path.join(this.directory, `.${entryId}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(value, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  async get(entryId: string): Promise<string | null> {
    try {
      const stat = await fs.lstat(this.file(entryId));
      // A link or a widened file is not ours to trust.
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
        throw new CredentialVaultError("A credential file has unexpected permissions");
      }
      return await fs.readFile(this.file(entryId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(entryId: string): Promise<void> {
    await fs.rm(this.file(entryId), { force: true });
  }

  /** Startup: tighten the directory and remove interrupted writes. */
  async prepare(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    for (const entry of await fs.readdir(this.directory).catch(() => [] as string[])) {
      if (entry.startsWith(".") && entry.endsWith(".tmp")) {
        const candidate = path.join(this.directory, entry);
        const stat = await fs.lstat(candidate).catch(() => null);
        // A second backend may be preparing the same vault while a write is live.
        if (stat && Date.now() - stat.mtimeMs > 60 * 60_000) {
          await fs.rm(candidate, { force: true }).catch(() => undefined);
        }
      }
    }
  }
}

type BunSecrets = {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
};

function bunSecrets(): BunSecrets | null {
  const secrets = (globalThis as { Bun?: { secrets?: BunSecrets } }).Bun?.secrets;
  return secrets && typeof secrets.get === "function" ? secrets : null;
}

const KEYCHAIN_TIMEOUT_MS = 10_000;

async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CredentialVaultError(`The keychain did not answer (${what})`)),
          KEYCHAIN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The OS credential store through `Bun.secrets`: Keychain on macOS, the
 * Secret Service (libsecret) on Linux, Credential Manager on Windows. The
 * service name carries a digest of the data directory, so a development
 * profile, a test and production never share an item.
 */
export class KeychainCredentialVault implements CredentialVault {
  readonly kind = "keychain" as const;
  readonly service: string;

  constructor(
    dataDir: string,
    private readonly secrets: BunSecrets,
  ) {
    const digest = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
    this.service = `orkestrator-credentials-${digest}`;
  }

  async put(entryId: string, value: string): Promise<void> {
    assertEntryId(entryId);
    await withTimeout(this.secrets.set({ service: this.service, name: entryId, value }), "write");
  }

  async get(entryId: string): Promise<string | null> {
    assertEntryId(entryId);
    return withTimeout(this.secrets.get({ service: this.service, name: entryId }), "read");
  }

  async delete(entryId: string): Promise<void> {
    assertEntryId(entryId);
    const deleted = await withTimeout(
      this.secrets.delete({ service: this.service, name: entryId }),
      "delete",
    );
    if (!deleted && (await this.get(entryId)) !== null) {
      throw new CredentialVaultError("The keychain did not remove the credential.");
    }
  }

  /** Writes, reads back and removes a probe entry; false when the keychain cannot be used. */
  async probe(): Promise<boolean> {
    const entryId = newCredentialEntryId();
    const value = `probe-${randomUUID()}`;
    try {
      await this.put(entryId, value);
      const read = await this.get(entryId);
      await this.delete(entryId);
      return read === value;
    } catch (error) {
      log.info("vault.keychain-unavailable", { error: formatLogError(error) });
      await this.delete(entryId).catch(() => undefined);
      return false;
    }
  }
}

export type CredentialVaultPreference = "auto" | "keychain" | "file" | "memory";

export function credentialVaultPreference(
  env: NodeJS.ProcessEnv,
  runtimeFlavor: "production" | "development" | "agent-test",
): CredentialVaultPreference {
  const explicit = env.ORKESTRATOR_CREDENTIAL_VAULT;
  if (explicit === "keychain" || explicit === "file" || explicit === "memory") return explicit;
  // Tests never reach the user's keychain or write vault files they did not ask for.
  if (env.NODE_ENV === "test") return "memory";
  // Development and agent-test profiles keep values beside their own data, so
  // `dev:reset` removes them and no keychain item outlives the profile.
  if (runtimeFlavor !== "production") return "file";
  return "auto";
}

/** The vault saved connections use, and what Settings says about it. */
export async function openCredentialVault(options: {
  dataDir: string;
  preference: CredentialVaultPreference;
  secrets?: BunSecrets | null;
}): Promise<{
  vault: CredentialVault;
  status: CredentialVaultStatus;
  vaults?: Partial<Record<CredentialVaultKind, CredentialVault>>;
}> {
  if (options.preference === "memory") {
    return {
      vault: new MemoryCredentialVault(),
      status: {
        durable: "memory",
        canSave: false,
        detail: "This backend keeps credentials in memory only; values cannot be saved.",
      },
    };
  }
  const file = new FileCredentialVault(path.join(options.dataDir, "credentials", "vault"));
  const secrets = options.secrets === undefined ? bunSecrets() : options.secrets;
  const keychain = secrets ? new KeychainCredentialVault(options.dataDir, secrets) : undefined;
  const vaults = { file, ...(keychain ? { keychain } : {}) };
  const fileStatus = (detail: string): CredentialVaultStatus => ({
    durable: "file",
    canSave: true,
    detail,
  });
  if (options.preference === "file") {
    await file.prepare();
    return {
      vault: file,
      vaults,
      status: fileStatus(
        "Saved values are kept in owner-only files in this machine's data directory. They are not encrypted.",
      ),
    };
  }
  if (keychain && (await keychain.probe())) {
    return {
      vault: keychain,
      vaults,
      status: {
        durable: "keychain",
        canSave: true,
        detail: "Saved values are kept in this machine's system keychain.",
      },
    };
  }
  if (options.preference === "keychain") {
    return {
      vault: new MemoryCredentialVault(),
      vaults,
      status: {
        durable: "memory",
        canSave: false,
        detail:
          "The system keychain is unavailable, and this backend is set to use only the keychain. Values can be used for one task but not saved.",
      },
    };
  }
  await file.prepare();
  return {
    vault: file,
    vaults,
    status: fileStatus(
      "No system keychain is available, so saved values are kept in owner-only files in this machine's data directory. They are not encrypted.",
    ),
  };
}
