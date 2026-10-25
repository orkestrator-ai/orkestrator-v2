import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKEND_PROFILE_CHANGED_EVENT,
  BACKEND_PROFILE_CONFLICT_CODE,
  defaultMachineColor,
  parseBackendProfile,
  type BackendProfile,
} from "@orkestrator/protocol/backend-profile";
import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { StorageService } from "./storage.js";
import {
  BackendProfileConflictError,
  defaultMachineDisplayName,
} from "./storage-preview-services.js";
import { readStoredValue, seedStore } from "./storage-test-support.js";

const directories: string[] = [];
const services: StorageService[] = [];

async function createDataDir(): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-backend-profile-"));
  directories.push(dataDir);
  return dataDir;
}

async function openStorage(dataDir: string): Promise<StorageService> {
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  return storage;
}

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("backend profile store", () => {
  test("creates the profile once on first read and returns it unchanged afterwards", async () => {
    const dataDir = await createDataDir();
    const storage = await openStorage(dataDir);
    const { instanceId } = await storage.getPreviewBackendIdentity();

    const [first, concurrent] = await Promise.all([
      storage.getBackendProfile(),
      storage.getBackendProfile(),
    ]);
    expect(concurrent).toEqual(first);
    expect(parseBackendProfile(first)).toEqual(first);
    expect(first.revision).toBe(1);
    expect(first.displayName).toBe(defaultMachineDisplayName());
    expect(first.colorToken).toBe(defaultMachineColor(instanceId));
    expect(Number.isNaN(Date.parse(first.updatedAt))).toBe(false);

    // Another process on the same data directory reads the persisted record.
    const other = await openStorage(dataDir);
    expect(await other.getBackendProfile()).toEqual(first);
    expect(await storage.getBackendProfile()).toEqual(first);
    expect(readStoredValue(dataDir, "backend-profile.json")).toMatchObject({
      version: 1,
      revision: 1,
      displayName: first.displayName,
      colorToken: first.colorToken,
    });
  });

  test("derives the default name from the host name, bounded and sanitized", () => {
    expect(defaultMachineDisplayName("studio.local")).toBe("studio");
    expect(defaultMachineDisplayName("Build-Box.LOCAL.")).toBe("Build-Box");
    expect(defaultMachineDisplayName("  ")).toBe("Orkestrator");
    expect(defaultMachineDisplayName(".local")).toBe("Orkestrator");
    expect(defaultMachineDisplayName("bad\u0000name‮")).toBe("bad name");
    expect(Array.from(defaultMachineDisplayName("x".repeat(300)))).toHaveLength(64);
  });

  test("compare-and-swap increments the revision and persists the edit", async () => {
    const storage = await openStorage(await createDataDir());
    const initial = await storage.getBackendProfile();

    const renamed = await storage.updateBackendProfile({
      expectedRevision: initial.revision,
      displayName: "  Build   box ",
    });
    expect(renamed).toMatchObject({
      revision: 2,
      displayName: "Build box",
      colorToken: initial.colorToken,
    });

    const recoloured = await storage.updateBackendProfile({
      expectedRevision: 2,
      colorToken: initial.colorToken === "teal" ? "rose" : "teal",
    });
    expect(recoloured.revision).toBe(3);
    expect(recoloured.displayName).toBe("Build box");
    expect(await storage.getBackendProfile()).toEqual(recoloured);
  });

  test("a stale expected revision conflicts and overwrites nothing", async () => {
    const storage = await openStorage(await createDataDir());
    const initial = await storage.getBackendProfile();
    const current = await storage.updateBackendProfile({
      expectedRevision: initial.revision,
      displayName: "First",
    });

    const error = await storage
      .updateBackendProfile({ expectedRevision: initial.revision, displayName: "Second" })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(BackendProfileConflictError);
    expect((error as Error).message.startsWith(BACKEND_PROFILE_CONFLICT_CODE)).toBe(true);
    expect((error as BackendProfileConflictError).current).toEqual(current);
    expect(await storage.getBackendProfile()).toEqual(current);
  });

  test("CL-04: concurrent edits with one expected revision admit exactly one", async () => {
    const dataDir = await createDataDir();
    const first = await openStorage(dataDir);
    const second = await openStorage(dataDir);
    const initial = await first.getBackendProfile();

    const attempts = await Promise.allSettled([
      first.updateBackendProfile({ expectedRevision: initial.revision, colorToken: "violet" }),
      second.updateBackendProfile({ expectedRevision: initial.revision, colorToken: "amber" }),
      first.updateBackendProfile({ expectedRevision: initial.revision, displayName: "Third" }),
    ]);
    const succeeded = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<BackendProfile> =>
        attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const attempt of rejected) {
      expect(String((attempt.reason as Error).message)).toStartWith(
        `${BACKEND_PROFILE_CONFLICT_CODE}:`,
      );
    }
    const winner = succeeded[0]!.value;
    expect(winner.revision).toBe(initial.revision + 1);
    expect(await second.getBackendProfile()).toEqual(winner);
  });

  test("rejects unsupported colours, bad names and unknown fields without writing", async () => {
    const storage = await openStorage(await createDataDir());
    const initial = await storage.getBackendProfile();
    const invalid: unknown[] = [
      { expectedRevision: 1, colorToken: "#ff0000" },
      { expectedRevision: 1, colorToken: "red; background: url(x)" },
      { expectedRevision: 1, colorToken: "neutral" },
      { expectedRevision: 1, displayName: "   " },
      { expectedRevision: 1, displayName: "x".repeat(65) },
      { expectedRevision: 0, displayName: "Zero" },
      { expectedRevision: 1 },
      { expectedRevision: 1, displayName: "Name", css: "color: red" },
    ];
    for (const update of invalid) {
      await expect(storage.updateBackendProfile(update as never)).rejects.toThrow();
    }
    expect(await storage.getBackendProfile()).toEqual(initial);
  });

  test("replaces an invalid stored record past its revision", async () => {
    const dataDir = await createDataDir();
    seedStore(dataDir, "backend-profile.json", {
      version: 1,
      revision: 4,
      displayName: "",
      colorToken: "NOT A TOKEN",
      updatedAt: "",
    });
    const storage = await openStorage(dataDir);
    const restored = await storage.getBackendProfile();
    expect(restored.revision).toBe(5);
    expect(restored.colorToken).toBe(
      defaultMachineColor((await storage.getPreviewBackendIdentity()).instanceId),
    );
  });

  test("keeps a newer client's palette token it does not know", async () => {
    const dataDir = await createDataDir();
    seedStore(dataDir, "backend-profile.json", {
      version: 1,
      revision: 2,
      displayName: "Future",
      colorToken: "ultraviolet",
      updatedAt: "2026-10-21T00:00:00.000Z",
    });
    const storage = await openStorage(dataDir);
    expect(await storage.getBackendProfile()).toMatchObject({
      revision: 2,
      colorToken: "ultraviolet",
    });
  });
});

describe("backend profile commands", () => {
  test("reads, updates and emits the changed profile", async () => {
    const storage = await openStorage(await createDataDir());
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = {
      storage,
      emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const invoke = (name: string, args: Record<string, unknown> = {}) =>
      Promise.resolve(commands.get(name)!(args, context));

    const initial = (await invoke("get_backend_profile")) as BackendProfile;
    expect(initial.revision).toBe(1);
    await expect(invoke("get_backend_profile", { extra: true })).rejects.toThrow();
    expect(emitted).toEqual([]);

    const updated = (await invoke("update_backend_profile", {
      expectedRevision: 1,
      displayName: "Workstation",
      colorToken: "teal",
    })) as BackendProfile;
    expect(updated).toMatchObject({ revision: 2, displayName: "Workstation", colorToken: "teal" });
    expect(emitted).toEqual([{ event: BACKEND_PROFILE_CHANGED_EVENT, payload: updated }]);

    const conflict = await invoke("update_backend_profile", {
      expectedRevision: 1,
      colorToken: "rose",
    }).catch((error: unknown) => error);
    expect((conflict as Error).message).toStartWith(`${BACKEND_PROFILE_CONFLICT_CODE}:`);
    await expect(
      invoke("update_backend_profile", { expectedRevision: 2, colorToken: "#000" }),
    ).rejects.toThrow("supported machine colours");
    expect(emitted).toHaveLength(1);
    expect(await invoke("get_backend_profile")).toEqual(updated);
  });
});
