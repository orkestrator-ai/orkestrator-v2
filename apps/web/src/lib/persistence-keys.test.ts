import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { readLocalDraft, writeLocalDraft } from "./web-annotations/local-drafts";
import {
  COMMAND_STORAGE_NODE,
  LOCAL_DRAFTS_STORAGE_KEY,
  migratePersistenceKey,
  nodeStorageKey,
  PERSISTENCE_KEY_MIGRATIONS,
  type StorageNode,
} from "./persistence-keys";

const LEGACY_DRAFTS_KEY = "orkestrator.web-annotations.local-drafts.v1";
const leafB: StorageNode = { nodeId: "bk_leaf-b" as BackendId, role: "leaf" };

function legacyDraft(text: string) {
  return JSON.stringify({
    "env-1\u0000editor-1": { text, baseRevision: 2, updatedAt: Date.now() },
  });
}

afterEach(() => {
  localStorage.clear();
  delete window.orkestrator;
  delete window.orkestratorDesktopIdentity;
});

describe("local annotation drafts are kept per node", () => {
  test("the un-namespaced copy moves to the command node once", () => {
    window.orkestrator = undefined;
    localStorage.setItem(LEGACY_DRAFTS_KEY, legacyDraft("typed offline"));

    expect(readLocalDraft("env-1", "editor-1")?.text).toBe("typed offline");
    expect(localStorage.getItem(LEGACY_DRAFTS_KEY)).toBeNull();
    expect(localStorage.getItem(LOCAL_DRAFTS_STORAGE_KEY)).toContain("typed offline");

    // An older client writing the v1 key again is not re-imported over newer text.
    writeLocalDraft("env-1", "editor-1", "newer", 3);
    // One payload: building it twice reads the clock twice, and the copies
    // differ whenever a millisecond boundary falls between the two reads.
    const staleLegacy = legacyDraft("stale");
    localStorage.setItem(LEGACY_DRAFTS_KEY, staleLegacy);
    expect(readLocalDraft("env-1", "editor-1")?.text).toBe("newer");
    expect(localStorage.getItem(LEGACY_DRAFTS_KEY)).toBe(staleLegacy);
  });

  test("a leaf has its own drafts and never receives the command node's", () => {
    window.orkestrator = undefined;
    localStorage.setItem(LEGACY_DRAFTS_KEY, legacyDraft("command text"));

    expect(readLocalDraft("env-1", "editor-1", leafB)).toBeNull();
    writeLocalDraft("env-1", "editor-1", "leaf text", 1, leafB);
    expect(readLocalDraft("env-1", "editor-1", leafB)?.text).toBe("leaf text");
    expect(readLocalDraft("env-1", "editor-1")?.text).toBe("command text");
  });

  test("a desktop window moves the copy into its own command key", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    window.orkestratorDesktopIdentity = {
      connectionId: "local",
      backendId: null,
      legacyOrigin: null,
    };
    localStorage.setItem(LEGACY_DRAFTS_KEY, legacyDraft("desk text"));

    const key = nodeStorageKey(LOCAL_DRAFTS_STORAGE_KEY, COMMAND_STORAGE_NODE);
    expect(key).toStartWith(`${LOCAL_DRAFTS_STORAGE_KEY}:desktop:`);
    expect(readLocalDraft("env-1", "editor-1")?.text).toBe("desk text");
  });
});

describe("the per-key migration table", () => {
  const table = {
    "orkestrator.example.v2": { legacyKeys: ["example.v1", "example.v0"], removeLegacy: false },
  };

  test("takes the newest legacy key, keeps legacy keys when asked, and runs once", () => {
    localStorage.setItem("example.v0", "oldest");
    localStorage.setItem("example.v1", "newer");

    migratePersistenceKey("orkestrator.example.v2", "target", localStorage, table);
    expect(localStorage.getItem("target")).toBe("newer");
    expect(localStorage.getItem("example.v1")).toBe("newer");

    localStorage.removeItem("target");
    migratePersistenceKey("orkestrator.example.v2", "target", localStorage, table);
    expect(localStorage.getItem("target")).toBeNull();
  });

  test("a target that already holds data wins", () => {
    localStorage.setItem("example.v1", "legacy");
    localStorage.setItem("target", "current");
    migratePersistenceKey("orkestrator.example.v2", "target", localStorage, table);
    expect(localStorage.getItem("target")).toBe("current");
  });

  test("keys with no entry are returned unchanged and nothing is written", () => {
    window.orkestrator = undefined;
    expect(PERSISTENCE_KEY_MIGRATIONS["files-panel-storage"]).toBeUndefined();
    expect(nodeStorageKey("files-panel-storage", COMMAND_STORAGE_NODE)).toBe("files-panel-storage");
    expect(localStorage.length).toBe(0);
  });
});
