import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  credentialVaultPreference,
  FileCredentialVault,
  KeychainCredentialVault,
  MemoryCredentialVault,
  newCredentialEntryId,
  openCredentialVault,
} from "./vault.js";

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-credential-vault-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

/** A stand-in for `Bun.secrets`: tests never reach the real keychain. */
function fakeSecrets(options: { fail?: boolean } = {}) {
  const items = new Map<string, string>();
  const key = (service: string, name: string) => `${service}\0${name}`;
  return {
    items,
    async get({ service, name }: { service: string; name: string }) {
      if (options.fail) throw new Error("no secret service");
      return items.get(key(service, name)) ?? null;
    },
    async set({ service, name, value }: { service: string; name: string; value: string }) {
      if (options.fail) throw new Error("no secret service");
      items.set(key(service, name), value);
    },
    async delete({ service, name }: { service: string; name: string }) {
      return items.delete(key(service, name));
    },
  };
}

describe("FileCredentialVault", () => {
  test("stores exact bytes in an owner-only file and removes it", async () => {
    const directory = path.join(await tempDir(), "vault");
    const vault = new FileCredentialVault(directory);
    const entryId = newCredentialEntryId();
    const value = "  spaced\nmultiline ✓ value  ";
    await vault.put(entryId, value);
    expect(await vault.get(entryId)).toBe(value);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(directory, `${entryId}.secret`))).mode & 0o777).toBe(0o600);
    await vault.delete(entryId);
    expect(await vault.get(entryId)).toBeNull();
  });

  test("refuses a file whose permissions were widened", async () => {
    const directory = path.join(await tempDir(), "vault");
    const vault = new FileCredentialVault(directory);
    const entryId = newCredentialEntryId();
    await vault.put(entryId, "value-1234");
    await fs.chmod(path.join(directory, `${entryId}.secret`), 0o644);
    await expect(vault.get(entryId)).rejects.toThrow("unexpected permissions");
  });

  test("rejects entry ids that could name another path", async () => {
    const vault = new FileCredentialVault(await tempDir());
    await expect(vault.put("../escape", "value")).rejects.toThrow("Invalid credential entry id");
  });
});

describe("KeychainCredentialVault", () => {
  test("namespaces items by data directory", async () => {
    const secrets = fakeSecrets();
    const first = new KeychainCredentialVault("/data/one", secrets);
    const second = new KeychainCredentialVault("/data/two", secrets);
    expect(first.service).not.toBe(second.service);
    const entryId = newCredentialEntryId();
    await first.put(entryId, "value-1234");
    expect(await second.get(entryId)).toBeNull();
    expect(await first.get(entryId)).toBe("value-1234");
  });

  test("probe leaves nothing behind", async () => {
    const secrets = fakeSecrets();
    expect(await new KeychainCredentialVault("/data", secrets).probe()).toBe(true);
    expect(secrets.items.size).toBe(0);
  });
});

describe("openCredentialVault", () => {
  test("uses the keychain when its probe succeeds", async () => {
    const opened = await openCredentialVault({
      dataDir: await tempDir(),
      preference: "auto",
      secrets: fakeSecrets(),
    });
    expect(opened.vault.kind).toBe("keychain");
    expect(opened.status.canSave).toBe(true);
  });

  test("falls back to owner-only files and says they are not encrypted", async () => {
    const opened = await openCredentialVault({
      dataDir: await tempDir(),
      preference: "auto",
      secrets: fakeSecrets({ fail: true }),
    });
    expect(opened.vault.kind).toBe("file");
    expect(opened.status.detail).toContain("not encrypted");
  });

  test("a keychain-only backend without a keychain cannot save", async () => {
    const opened = await openCredentialVault({
      dataDir: await tempDir(),
      preference: "keychain",
      secrets: null,
    });
    expect(opened.vault).toBeInstanceOf(MemoryCredentialVault);
    expect(opened.status.canSave).toBe(false);
  });

  test("memory preference never saves", async () => {
    const opened = await openCredentialVault({ dataDir: await tempDir(), preference: "memory" });
    expect(opened.status).toMatchObject({ durable: "memory", canSave: false });
  });
});

describe("credentialVaultPreference", () => {
  test("tests use memory and profiles use files unless told otherwise", () => {
    expect(credentialVaultPreference({ NODE_ENV: "test" }, "production")).toBe("memory");
    expect(credentialVaultPreference({}, "agent-test")).toBe("file");
    expect(credentialVaultPreference({}, "development")).toBe("file");
    expect(credentialVaultPreference({}, "production")).toBe("auto");
    expect(
      credentialVaultPreference(
        { ORKESTRATOR_CREDENTIAL_VAULT: "keychain", NODE_ENV: "test" },
        "agent-test",
      ),
    ).toBe("keychain");
  });
});
