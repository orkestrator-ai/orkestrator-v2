import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBackendDatabase } from "./storage-stores.js";
import {
  promptQueueMessageFingerprint,
  restoreLegacyPromptQueueClaims,
  upgradeCoordinatorStore,
  upgradeNativeAgentSessionRecords,
  upgradePromptQueueRecords,
} from "./storage-record-upgrades.js";

const directories: string[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-record-upgrades-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("record shape upgrades", () => {
  test("renames Codex-named coordinator bridge fields without overwriting newer ones", () => {
    expect(
      upgradeCoordinatorStore({
        version: 1,
        workspaces: {
          p1: {
            projectId: "p1",
            codexBridgePort: 4100,
            codexBridgePid: 77,
            conversations: [{ id: "c1", codexBridgePort: 4200 }, "not-a-record"],
          },
          p2: { projectId: "p2", bridgePort: 1, codexBridgePort: 2 },
          p3: "malformed",
        },
      }),
    ).toEqual({
      version: 1,
      workspaces: {
        p1: {
          projectId: "p1",
          bridgePort: 4100,
          bridgePid: 77,
          conversations: [{ id: "c1", bridgePort: 4200 }, "not-a-record"],
        },
        p2: { projectId: "p2", bridgePort: 1 },
        p3: "malformed",
      },
    });
    expect(upgradeCoordinatorStore("garbage")).toBe("garbage");
  });

  test("attributes a first-generation dispatch error or drops it", () => {
    const message = { id: "m1", text: "hello", attachments: [] };
    expect(
      upgradePromptQueueRecords({
        attributable: {
          messages: [message],
          dispatchError: { requestId: "m1", message: "failed" },
        },
        orphaned: { messages: [], dispatchError: { requestId: "gone", message: "failed" } },
        current: {
          messages: [message],
          dispatchError: { requestId: "m1", messageId: "m1", messageFingerprint: "kept" },
        },
      }),
    ).toEqual({
      attributable: {
        messages: [message],
        dispatchError: {
          requestId: "m1",
          message: "failed",
          messageId: "m1",
          messageFingerprint: promptQueueMessageFingerprint(message),
        },
      },
      orphaned: { messages: [] },
      current: {
        messages: [message],
        dispatchError: { requestId: "m1", messageId: "m1", messageFingerprint: "kept" },
      },
    });
  });

  test("restores a legacy prompt-queue claim to the head without touching its input", () => {
    const claim = {
      token: "t",
      message: { id: "m1", text: "claimed" },
      claimedAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
    };
    const unclaimed = { messages: [{ id: "m3" }], revision: 4 };
    const stored = {
      claimed: {
        messages: [{ id: "m2" }, { id: "m1", text: "stale copy" }],
        outstandingClaim: claim,
        revision: 2,
      },
      noMessage: { messages: [{ id: "m2" }], outstandingClaim: { token: "t" }, revision: 3 },
      unclaimed,
    };
    const before = structuredClone(stored);

    expect(restoreLegacyPromptQueueClaims(stored)).toEqual({
      claimed: { messages: [{ id: "m1", text: "claimed" }, { id: "m2" }], revision: 2 },
      noMessage: { messages: [{ id: "m2" }], revision: 3 },
      unclaimed,
    });
    expect(stored).toEqual(before);
    expect((restoreLegacyPromptQueueClaims(stored) as typeof stored).unclaimed).toBe(unclaimed);
    const clean = { unclaimed };
    expect(restoreLegacyPromptQueueClaims(clean)).toBe(clean);
    expect(restoreLegacyPromptQueueClaims("garbage")).toBe("garbage");
  });

  test("versions legacy native sessions and keeps unreadable ones verbatim", () => {
    const upgraded = upgradeNativeAgentSessionRecords({
      "env-e1:tab": {
        key: "env-e1:tab",
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab",
        providerSessionId: "provider-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      future: { version: 99, key: "future" },
    }) as Record<string, Record<string, unknown>>;
    expect(upgraded["env-e1:tab"]).toMatchObject({
      version: expect.any(Number),
      origin: "interactive-native",
      providerSessionId: "provider-1",
    });
    expect(upgraded.future).toEqual({ version: 99, key: "future" });
  });

  test("runs once, right after the legacy import", async () => {
    const directory = await dataDir();
    await fs.writeFile(
      path.join(directory, "coordinators.json"),
      JSON.stringify({
        version: 1,
        revision: 1,
        workspaces: { p1: { projectId: "p1", codexBridgePort: 4100 } },
        workflows: [],
      }),
    );
    const first = openBackendDatabase(directory);
    // Later migrations (the change ledger is 4) run in the same open.
    expect(first.schemaVersion()).toBeGreaterThanOrEqual(3);
    expect(first.readStore("coordinators")?.value).toMatchObject({
      workspaces: { p1: { projectId: "p1", bridgePort: 4100 } },
    });
    // A later write of the old field (which no current writer produces) is
    // not touched again: the migration is recorded.
    first.writeStore("coordinators", {
      version: 1,
      revision: 2,
      workspaces: { p1: { projectId: "p1", codexBridgePort: 1 } },
      workflows: [],
    });
    first.close();
    const reopened = openBackendDatabase(directory);
    expect(reopened.readStore("coordinators")?.value).toMatchObject({
      workspaces: { p1: { codexBridgePort: 1 } },
    });
    reopened.close();
  });
});
