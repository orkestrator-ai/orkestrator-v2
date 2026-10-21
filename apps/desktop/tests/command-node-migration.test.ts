import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SavedBackend } from "@orkestrator/protocol/device-catalogue";

import {
  COMMAND_NODE_IMPORT_MARKER,
  importSavedMachinesOnce,
} from "../electron/command-node-migration";

const saved: SavedBackend = {
  id: "saved-1",
  verifiedInstallationId: "bk_build-box" as never,
  localAlias: "Build box",
  fallbackName: "build.example.ts.net",
  routeOrder: ["tailnet" as never, "ssh" as never],
  routes: [
    {
      id: "tailnet" as never,
      kind: "https",
      enabled: true,
      encryptedToken: "ZW5jcnlwdGVk",
      origin: "https://build.example.ts.net",
    },
    {
      id: "ssh" as never,
      kind: "ssh",
      enabled: true,
      encryptedToken: "",
      destination: "build",
      remoteGatewayPort: 34122,
    },
  ],
  autoConnect: true,
  profileCache: { displayName: "Build box", colorToken: "teal", revision: 2 },
};

describe("MG-01/MG-03 desktop saved machines become leaves once", () => {
  test("sends routes and the decrypted token to the local backend, never the encrypted blobs, then marks the import", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ork-cn-migration-"));
    try {
      const invoke = mock(async () => ({ imported: 1, skipped: 0, needsCredential: 0 }));
      const result = await importSavedMachinesOnce({
        connectionsDir: dir,
        machines: async () => [
          { backend: saved, token: "plain-token" },
          {
            backend: { ...saved, id: "saved-2", verifiedInstallationId: "provisional:x" as never },
            token: null,
          },
        ],
        invoke,
      });
      expect(result).toEqual({ imported: 1, skipped: 0, needsCredential: 0 });
      const [command, args] = invoke.mock.calls[0] as unknown as [string, { entries: any[] }];
      expect(command).toBe("import_desktop_connections");
      expect(args.entries[0]).toMatchObject({
        importedFrom: "saved-1",
        fallbackName: "Build box",
        verifiedNodeId: "bk_build-box",
        token: "plain-token",
        enabled: true,
        routeOrder: ["tailnet", "ssh"],
      });
      expect(JSON.stringify(args)).not.toContain("encryptedToken");
      expect(JSON.stringify(args)).not.toContain("ZW5jcnlwdGVk");
      // A provisional identity is not sent as a verified one.
      expect(args.entries[1].verifiedNodeId).toBeUndefined();
      expect(args.entries[1].token).toBeNull();

      const marker = path.join(dir, COMMAND_NODE_IMPORT_MARKER);
      expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({ imported: 1 });
      expect((await stat(marker)).mode & 0o777).toBe(0o600);
      expect(await readFile(marker, "utf8")).not.toContain("plain-token");

      expect(
        await importSavedMachinesOnce({ connectionsDir: dir, machines: async () => [], invoke }),
      ).toBe("already-imported");
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed import leaves no marker so the next start retries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ork-cn-migration-"));
    try {
      await expect(
        importSavedMachinesOnce({
          connectionsDir: dir,
          machines: async () => [{ backend: saved, token: "t" }],
          invoke: async () => {
            throw new Error("backend not ready");
          },
        }),
      ).rejects.toThrow("backend not ready");
      await expect(readFile(path.join(dir, COMMAND_NODE_IMPORT_MARKER), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
