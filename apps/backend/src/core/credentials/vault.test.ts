import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { CREDENTIAL_LIMITS } from "@orkestrator/protocol/agent-credentials";
import {
  createCredentialHarness,
  fakeSpawner,
  TEST_SECRET,
  type CredentialHarness,
} from "./service-test-support.js";
import type { CredentialService } from "./service.js";
import {
  credentialVaultPreference,
  FileCredentialVault,
  KeychainCredentialVault,
  MemoryCredentialVault,
  newCredentialEntryId,
  openCredentialVault,
} from "./vault.js";

const directories: string[] = [];
const harnesses: CredentialHarness[] = [];

async function tempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-credential-vault-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
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

  test("removes a private temporary file after a sync failure", async () => {
    const directory = path.join(await tempDir(), "vault");
    const vault = new FileCredentialVault(directory);
    const openFile = fs.open.bind(fs);
    const open = spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await openFile(...args);
      spyOn(file, "sync").mockRejectedValue(new Error("fixture sync failure"));
      return file;
    });
    try {
      await expect(vault.put(newCredentialEntryId(), TEST_SECRET)).rejects.toThrow(
        "fixture sync failure",
      );
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      open.mockRestore();
    }
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

async function approveSaved(h: CredentialHarness, service: CredentialService, id: string) {
  const request = await service.requestAccess(h.caller, {
    label: "Fixture service",
    purpose: "Read fixture",
    use: "command",
    bindingName: "TOKEN",
  });
  const { grant } = await service.approve({
    requestId: request.id,
    revision: request.revision,
    source: { kind: "connection", connectionId: id },
  });
  return grant;
}

describe("saved connections across vault selection", () => {
  test("reads and deletes from each recorded vault after the default changes", async () => {
    const spawner = fakeSpawner();
    const h = await createCredentialHarness({ spawnProcess: spawner.spawnProcess });
    harnesses.push(h);
    const outage = { fail: false };
    const secrets = fakeSecrets(outage);
    const initial = await openCredentialVault({ dataDir: h.dataDir, preference: "auto", secrets });
    const keychain = h.restart({
      vault: initial.vault,
      vaults: initial.vaults,
      vaultStatus: initial.status,
    });
    const inKeychain = await keychain.createConnection({
      name: "Keychain fixture",
      value: TEST_SECRET,
    });
    const grant = await approveSaved(h, keychain, inKeychain.id);
    outage.fail = true;
    const fallback = await openCredentialVault({ dataDir: h.dataDir, preference: "auto", secrets });
    const file = h.restart({
      vault: fallback.vault,
      vaults: fallback.vaults,
      vaultStatus: fallback.status,
    });
    const inFile = await file.createConnection({ name: "File fixture", value: TEST_SECRET });
    expect([inKeychain.storage, inFile.storage]).toEqual(["keychain", "file"]);
    expect(await file.runCommand(h.caller, { grantId: grant.id, command: "true" })).toMatchObject({
      state: "cancelled_before_start",
    });
    expect(file.overview().connections.find(({ id }) => id === inKeychain.id)?.status).toBe(
      "ready",
    );
    outage.fail = false;
    expect((await file.runCommand(h.caller, { grantId: grant.id, command: "true" })).state).toBe(
      "succeeded",
    );
    expect(await file.deleteConnection(inKeychain.id)).toEqual({ deleted: true });
    expect(secrets.items.size).toBe(0);

    const reopened = await openCredentialVault({ dataDir: h.dataDir, preference: "auto", secrets });
    const after = h.restart({
      vault: reopened.vault,
      vaults: reopened.vaults,
      vaultStatus: reopened.status,
    });
    const fileGrant = await approveSaved(h, after, inFile.id);
    expect(
      (await after.runCommand(h.caller, { grantId: fileGrant.id, command: "true" })).state,
    ).toBe("succeeded");
    expect(await after.deleteConnection(inFile.id)).toEqual({ deleted: true });
    expect(await fs.readdir(path.join(h.dataDir, "credentials", "vault"))).toEqual([]);
  });

  test("replacement and deletion retain and retry physical cleanup across restart", async () => {
    const h = await createCredentialHarness();
    harnesses.push(h);
    const connection = await h.service.createConnection({ name: "Fixture", value: TEST_SECRET });
    const grant = await approveSaved(h, h.service, connection.id);
    const remove = spyOn(h.vault, "delete").mockRejectedValue(
      new Error("fixture vault unavailable"),
    );
    const records = h.storage.credentialRecordStore();
    try {
      expect(
        await h.service.replaceConnectionValue({ id: connection.id, value: "replacement value" }),
      ).toMatchObject({
        cleanupPending: true,
        valueVersion: 2,
      });
      expect(records.getGrant(grant.id)?.state).toBe("invalidated");
      expect(await h.service.deleteConnection(connection.id)).toEqual({
        deleted: false,
        cleanupPending: true,
      });
      expect(h.service.overview().connections).toEqual([]);
      expect(records.listRetiredEntries(connection.id)).toHaveLength(2);
      expect(h.vault.size()).toBe(2);
    } finally {
      remove.mockRestore();
    }
    const restarted = h.restart();
    await restarted.connections.cleanRetiredEntries();
    expect(records.listRetiredEntries(connection.id)).toEqual([]);
    expect(h.vault.size()).toBe(0);
    expect(await restarted.deleteConnection(connection.id)).toEqual({ deleted: false });
  });

  test("concurrent inserts cannot exceed capacity and losing writes are cleaned up", async () => {
    const h = await createCredentialHarness();
    harnesses.push(h);
    for (let index = 0; index < CREDENTIAL_LIMITS.maxConnections - 1; index++) {
      await h.service.createConnection({ name: `Fixture ${index}`, value: TEST_SECRET });
    }
    const both = Promise.withResolvers<void>();
    let writes = 0;
    const put = h.vault.put.bind(h.vault);
    h.vault.put = async (id, value) => {
      await put(id, value);
      writes++;
      if (writes === 2) both.resolve();
      await both.promise;
    };
    const outcomes = await Promise.allSettled([
      h.service.createConnection({ name: "Last 1", value: TEST_SECRET }),
      h.service.createConnection({ name: "Last 2", value: TEST_SECRET }),
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(h.vault.size()).toBe(CREDENTIAL_LIMITS.maxConnections);
    expect(h.service.overview().connections).toHaveLength(CREDENTIAL_LIMITS.maxConnections);
  });
});

test("an interrupted fresh vault write stays recoverable across startup", async () => {
  const directory = await tempDir();
  const vault = new FileCredentialVault(directory);
  const h = await createCredentialHarness({ vault });
  harnesses.push(h);
  const id = newCredentialEntryId();
  const records = h.storage.credentialRecordStore();
  records.transaction((rows) =>
    rows.putVaultCleanup({
      id,
      connectionId: crypto.randomUUID(),
      storage: "file",
      staging: { bootId: "prior-boot", owner: { pid: fakePid(20), start: "exited-fixture" } },
    }),
  );
  await vault.put(id, TEST_SECRET);
  await fs.writeFile(path.join(directory, `.${id}.earlier.tmp`), TEST_SECRET, { mode: 0o600 });
  expect(records.listConnections()).toEqual([]);
  await h.restart().reconcileStartup();
  expect(await vault.get(id)).toBeNull();
  expect(await fs.readdir(directory)).toEqual([]);
  expect(records.listRetiredEntries()).toEqual([]);
});

test("failed compensation keeps a staged vault entry tracked until deletion succeeds", async () => {
  const h = await createCredentialHarness();
  harnesses.push(h);
  await h.service.createConnection({ name: "Duplicate", value: TEST_SECRET });
  const records = h.storage.credentialRecordStore();
  const remove = spyOn(h.vault, "delete").mockRejectedValue(new Error("fixture vault unavailable"));
  try {
    await expect(
      h.service.createConnection({ name: "Duplicate", value: "other-fixture-value" }),
    ).rejects.toThrow("already exists");
    expect(records.listConnections()).toHaveLength(1);
    const [orphan] = records.listRetiredEntries();
    expect(orphan?.staging?.abandoned).toBe(true);
    expect(await h.vault.get(orphan!.id)).toBe("other-fixture-value");
    // A second backend must leave a live owner's uncertain vault write alone.
    await h.restart().reconcileStartup();
    expect(records.listRetiredEntries()).toHaveLength(1);
    records.transaction((rows) =>
      rows.putVaultCleanup({
        ...orphan!,
        staging: { ...orphan!.staging!, owner: { pid: fakePid(21), start: "exited-fixture" } },
      }),
    );
    remove.mockRestore();
    await h.restart().reconcileStartup();
    expect(records.listRetiredEntries()).toEqual([]);
    expect(await h.vault.get(orphan!.id)).toBeNull();
  } finally {
    remove.mockRestore();
  }
});

test("timed-out keychain writes cannot race a delete and orphan a late value", async () => {
  const secrets = fakeSecrets();
  const pending = Promise.withResolvers<void>();
  const writeCompleted = Promise.withResolvers<void>();
  const vault = new KeychainCredentialVault(
    "/data",
    {
      ...secrets,
      async set(args) {
        await pending.promise;
        await secrets.set(args);
        writeCompleted.resolve();
      },
    },
    15,
  );
  const entryId = newCredentialEntryId();
  await expect(vault.put(entryId, TEST_SECRET)).rejects.toThrow("keychain did not answer (write)");
  await expect(vault.delete(entryId)).rejects.toThrow("keychain write is still pending");
  pending.resolve();
  await writeCompleted.promise;
  await Promise.resolve();
  await vault.delete(entryId);
  expect(secrets.items.size).toBe(0);
});

test("a replacement that loses a deletion race journals the fresh value for retry", async () => {
  const h = await createCredentialHarness();
  harnesses.push(h);
  const saved = await h.service.createConnection({ name: "Before race", value: TEST_SECRET });
  const records = h.storage.credentialRecordStore();
  const hold = Promise.withResolvers<void>();
  const written = Promise.withResolvers<string>();
  const put = h.vault.put.bind(h.vault);
  const write = spyOn(h.vault, "put").mockImplementation(async (id, value) => {
    await put(id, value);
    written.resolve(id);
    await hold.promise;
  });
  const replacing = h.service.replaceConnectionValue({ id: saved.id, value: "fixture-new-value" });
  const newEntryId = await written.promise;
  expect(records.listRetiredEntries(saved.id).map((entry) => entry.id)).toEqual([newEntryId]);
  await h.service.deleteConnection(saved.id);
  const remove = spyOn(h.vault, "delete").mockRejectedValue(new Error("fixture vault unavailable"));
  try {
    hold.resolve();
    await expect(replacing).rejects.toThrow("REQUEST_NOT_FOUND");
    expect(records.listRetiredEntries(saved.id)).toMatchObject([
      { id: newEntryId, staging: { abandoned: true } },
    ]);
  } finally {
    remove.mockRestore();
    write.mockRestore();
  }
  await h.service.connections.cleanRetiredEntries();
  expect(records.listRetiredEntries(saved.id)).toEqual([]);
  expect(await h.vault.get(newEntryId)).toBeNull();
});
