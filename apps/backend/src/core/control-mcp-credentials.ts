import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTROL_MCP_CREDENTIAL_ID_PATTERN,
  isControlMcpProfile,
  resolveControlMcpCapabilities,
  type ControlMcpCredentialSummary,
  type ControlMcpProfile,
} from "@orkestrator/protocol/control-mcp";
import { isPublicActionName, type PublicActionName } from "@orkestrator/protocol/public-api";
import type { PublicCapability } from "@orkestrator/protocol/public-api-inputs";

/**
 * Named Control MCP operator credentials.
 *
 * Each credential has its own token, profile and capability list, and is
 * rotated or revoked on its own. They live in plaintext (mode 0600) in the
 * same descriptor that used to hold the single shared token, so Copy setup in
 * Settings → MCP works at any time. A version 1 descriptor's token becomes
 * credential `default` with the `full` profile, so existing Codex and Claude
 * Code setups keep working unchanged.
 *
 * Coordinator credentials are separate: issued per conversation, held in
 * memory only, and never listed here.
 */

export const DEFAULT_CONTROL_MCP_CREDENTIAL_ID = "default";
const MAX_CREDENTIALS = 64;
const MAX_LABEL_CHARS = 80;
/** How long a `lastUsedAt` change may wait before it is written. */
const LAST_USED_FLUSH_MS = 60_000;

export interface StoredControlMcpCredential {
  id: string;
  label: string;
  profile: ControlMcpProfile;
  capabilities: PublicCapability[];
  deniedActions: PublicActionName[];
  token: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ControlMcpDescriptorV2 {
  version: 2;
  url: string;
  pid: number;
  credentials: StoredControlMcpCredential[];
}

export interface CreateControlMcpCredentialInput {
  label: unknown;
  profile: unknown;
  capabilities?: unknown;
  deniedActions?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenMatches(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function label(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("A credential needs a label");
  }
  return value.trim().slice(0, MAX_LABEL_CHARS);
}

function deniedActions(value: unknown): PublicActionName[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isPublicActionName)) {
    throw new Error("deniedActions must list public action names");
  }
  return Array.from(new Set(value));
}

function defaultCredential(token: string, now: Date): StoredControlMcpCredential {
  return {
    id: DEFAULT_CONTROL_MCP_CREDENTIAL_ID,
    label: "Default",
    profile: "full",
    capabilities: resolveControlMcpCapabilities("full"),
    deniedActions: [],
    token,
    createdAt: now.toISOString(),
    lastUsedAt: null,
  };
}

/** A stored credential that still satisfies every rule; anything else is dropped on load. */
function parseStoredCredential(value: unknown): StoredControlMcpCredential | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !CONTROL_MCP_CREDENTIAL_ID_PATTERN.test(value.id)) {
    return null;
  }
  if (typeof value.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value.token)) return null;
  if (!isControlMcpProfile(value.profile)) return null;
  try {
    return {
      id: value.id,
      label: label(value.label),
      profile: value.profile,
      capabilities: resolveControlMcpCapabilities(
        value.profile,
        Array.isArray(value.capabilities) ? value.capabilities : undefined,
      ),
      deniedActions: deniedActions(value.deniedActions),
      token: value.token,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
      lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Read a descriptor of either version. Version 1 (one shared token) is
 * returned as its migrated form; `token` is the default credential's token,
 * or the first credential's when there is no default.
 */
export async function readControlMcpDescriptor(
  descriptorFile: string,
): Promise<ControlMcpDescriptorV2 & { token: string }> {
  const value = JSON.parse(await readFile(descriptorFile, "utf8")) as unknown;
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.pid !== "number") {
    throw new Error("Control MCP descriptor is invalid");
  }
  let credentials: StoredControlMcpCredential[];
  if (value.version === 1 && typeof value.token === "string") {
    credentials = [defaultCredential(value.token, new Date())];
  } else if (value.version === 2 && Array.isArray(value.credentials)) {
    credentials = value.credentials
      .map(parseStoredCredential)
      .filter((credential): credential is StoredControlMcpCredential => credential !== null);
  } else {
    throw new Error("Control MCP descriptor is invalid");
  }
  const primary =
    credentials.find((credential) => credential.id === DEFAULT_CONTROL_MCP_CREDENTIAL_ID) ??
    credentials[0];
  return { version: 2, url: value.url, pid: value.pid, credentials, token: primary?.token ?? "" };
}

export class ControlMcpCredentialStore {
  private credentials: StoredControlMcpCredential[] = [];
  private lastUsedDirty = false;
  private lastUsedFlush: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param persist writes the current list durably; the store never touches
   *   the file itself, so the descriptor's URL and PID stay owned by the server.
   */
  constructor(private readonly persist: () => Promise<void>) {}

  /**
   * Load from a descriptor file, migrating version 1. Only a missing or
   * unreadable file starts fresh with a new default credential; a readable
   * file whose credentials were all revoked stays empty.
   */
  async load(descriptorFile: string): Promise<void> {
    try {
      this.credentials = (await readControlMcpDescriptor(descriptorFile)).credentials;
    } catch {
      this.credentials = [defaultCredential(newToken(), new Date())];
    }
  }

  list(): readonly StoredControlMcpCredential[] {
    return this.credentials;
  }

  get(id: string): StoredControlMcpCredential | undefined {
    return this.credentials.find((credential) => credential.id === id);
  }

  /** Constant-time match of a presented bearer token against every credential. */
  authenticate(token: string | null): StoredControlMcpCredential | null {
    if (!token) return null;
    let matched: StoredControlMcpCredential | null = null;
    for (const credential of this.credentials) {
      if (tokenMatches(token, credential.token)) matched = credential;
    }
    return matched;
  }

  summaries(): ControlMcpCredentialSummary[] {
    return this.credentials.map((credential) => ({ ...credential }));
  }

  /** Record a use; written with the next change or within a minute. */
  markUsed(id: string, now = new Date()): void {
    const credential = this.get(id);
    if (!credential) return;
    credential.lastUsedAt = now.toISOString();
    this.lastUsedDirty = true;
    if (this.lastUsedFlush) return;
    this.lastUsedFlush = setTimeout(() => {
      this.lastUsedFlush = null;
      if (!this.lastUsedDirty) return;
      this.lastUsedDirty = false;
      void this.persist().catch(() => undefined);
    }, LAST_USED_FLUSH_MS);
    this.lastUsedFlush.unref?.();
  }

  async create(input: CreateControlMcpCredentialInput): Promise<StoredControlMcpCredential> {
    if (this.credentials.length >= MAX_CREDENTIALS) {
      throw new Error(`At most ${MAX_CREDENTIALS} MCP credentials can exist`);
    }
    if (!isControlMcpProfile(input.profile)) throw new Error("Unknown MCP credential profile");
    const capabilities = resolveControlMcpCapabilities(
      input.profile,
      input.capabilities === undefined
        ? undefined
        : Array.isArray(input.capabilities)
          ? input.capabilities
          : (() => {
              throw new Error("capabilities must be a list");
            })(),
    );
    const name = label(input.label);
    const credential: StoredControlMcpCredential = {
      id: this.uniqueId(name),
      label: name,
      profile: input.profile,
      capabilities,
      deniedActions: deniedActions(input.deniedActions),
      token: newToken(),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await this.commit([...this.credentials, credential]);
    return credential;
  }

  async rotate(id: string): Promise<StoredControlMcpCredential> {
    const existing = this.get(id);
    if (!existing) throw new Error(`MCP credential not found: ${id}`);
    const rotated = { ...existing, token: newToken() };
    await this.commit(
      this.credentials.map((credential) => (credential.id === id ? rotated : credential)),
    );
    return rotated;
  }

  async revoke(id: string): Promise<void> {
    if (!this.get(id)) throw new Error(`MCP credential not found: ${id}`);
    await this.commit(this.credentials.filter((credential) => credential.id !== id));
  }

  dispose(): void {
    if (this.lastUsedFlush) clearTimeout(this.lastUsedFlush);
    this.lastUsedFlush = null;
  }

  /** Write first and adopt the list only once it is durable. */
  private async commit(next: StoredControlMcpCredential[]): Promise<void> {
    const previous = this.credentials;
    this.credentials = next;
    try {
      await this.persist();
      this.lastUsedDirty = false;
    } catch (error) {
      this.credentials = previous;
      throw error;
    }
  }

  private uniqueId(name: string): string {
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "client";
    for (;;) {
      const id = `${slug}-${randomBytes(3).toString("hex")}`;
      if (CONTROL_MCP_CREDENTIAL_ID_PATTERN.test(id) && !this.get(id)) return id;
    }
  }
}

export async function writeControlMcpDescriptor(
  descriptorFile: string,
  descriptor: ControlMcpDescriptorV2,
): Promise<void> {
  await mkdir(path.dirname(descriptorFile), { recursive: true });
  const temporary = `${descriptorFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, descriptorFile);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
