import { describe, expect, test } from "bun:test";
import {
  analyzeStorageService,
  backendSources,
  rawDatabaseWrites,
  storesOverlap,
  type RawWrite,
} from "./storage-writer-guards-test-support.js";

describe("raw StorageDatabase writers outside StorageService", () => {
  let scanned: RawWrite[] | undefined;
  const writes = () =>
    (scanned ??= rawDatabaseWrites(backendSources(), new Set(analyzeStorageService().classes)));

  test("name the store they write", () => {
    expect(
      writes()
        .filter((write) => write.store === null)
        .map((write) => `${write.location} ${write.call}`),
    ).toEqual([]);
  });

  test("write no store a repository writes", () => {
    const { storeNames } = analyzeStorageService();
    const shared = writes().flatMap((write) =>
      [...storeNames]
        .filter(([, name]) => write.store !== null && storesOverlap(write.store, name))
        .map(
          ([helper, name]) =>
            `${write.location} ${write.call}(${write.store}) writes ${name} (${helper})`,
        ),
    );
    expect(shared).toEqual([]);
  });

  test("the scan reaches the engines' writes and every repository store", () => {
    const stores = new Set(writes().map((write) => write.store));
    for (const store of [
      "workflow-results",
      "environment-cleanup-ledger",
      "native-agent-display-tail-records",
      "usage-history",
      "scheduled-jobs",
      "design-canvases/dirty/*",
    ]) {
      expect(stores).toContain(store);
    }
    const { storeNames, stores: written } = analyzeStorageService();
    expect([...written.keys()].filter((store) => !storeNames.has(store))).toEqual([]);
    expect(storeNames.get("kanbanFile")).toBe("kanban");
    expect(storeNames.get("publicOperationNamespaceFile")).toBe("public-operations/*");
  });

  test("scheduled jobs write only single rows and overlap no repository store", () => {
    const scheduled = writes().filter((write) => write.store === "scheduled-jobs");
    // The conservative raw scan counts row readers too; the only store
    // mutation primitive is the engine's single-row transaction.
    expect(scheduled.filter((write) => write.call !== "rows")).toEqual([
      expect.objectContaining({
        location: expect.stringContaining("scheduled-jobs/store.ts:"),
        call: "updateStoreRow",
      }),
    ]);
    for (const name of analyzeStorageService().storeNames.values()) {
      expect(storesOverlap("scheduled-jobs", name)).toBe(false);
    }
  });

  test("detects repository overlap through imported parameterized row helpers", () => {
    const sources = [
      {
        file: "core/rows.ts",
        source: `export function writeRow(database: Db, store: string) {
          database.updateStoreRow(store, "k", () => ({ result: 1 }));
        }`,
      },
      {
        file: "core/delegate.ts",
        source: `import { writeRow as persist } from "./rows.js";
          export function writeStore(database: Db, store: string) { persist(database, store); }`,
      },
      {
        file: "core/engine.ts",
        source: `import { writeStore as commit } from "./delegate.js";
          export class Engine { run(database: Db) { commit(database, "kanban"); } }`,
      },
    ];
    const writes = rawDatabaseWrites(sources, new Set());
    expect(writes).toEqual([
      {
        location: expect.stringMatching(/rows.ts:.* via core\/delegate.ts:.* via core\/engine.ts:/),
        call: "updateStoreRow",
        store: "kanban",
      },
    ]);
    const overlaps = writes.flatMap((write) =>
      [...analyzeStorageService().storeNames].filter(
        ([, name]) => write.store !== null && storesOverlap(write.store, name),
      ),
    );
    expect(overlaps).toEqual([["kanbanFile", "kanban"]]);
  });

  test("leaves a store-name field unresolved when assigned outside its constructor", () => {
    const sources = [
      {
        file: "core/engine.ts",
        source: `
      export class Stable {
        private storeName: string;
        constructor() { this.storeName = "fixed"; }
        run(database: Db) { database.writeStore(this.storeName, 1); }
      }
      export class Reassigned {
        private storeName: string;
        constructor() { this.storeName = "kanban"; }
        change() { this.storeName = "other"; }
        run(database: Db) { database.writeStore(this.storeName, 1); }
      }
      export class AssignedLater {
        private storeName!: string;
        change() { this.storeName = "kanban"; }
        run(database: Db) { database.writeStore(this.storeName, 1); }
      }
    `,
      },
    ];
    expect(rawDatabaseWrites(sources, new Set()).map((write) => write.store)).toEqual([
      "fixed",
      null,
      null,
    ]);
  });

  test("follows store names through constants, templates, functions and imports", () => {
    const sources = [
      {
        file: "apps/backend/src/core/names.ts",
        source: `
          export const PREFIX = "family/";
          export const FIXED = "fixed";
          export function familyStore(id: string): string { return \`\${PREFIX}\${id}\`; }
        `,
      },
      {
        file: "apps/backend/src/core/engine.ts",
        source: `
          import { FIXED, familyStore } from "./names.js";
          const LOCAL = FIXED;
          export class Engine {
            run(database: Db, id: string, store: string) {
              database.writeStore(LOCAL, 1);
              database.rows(familyStore(id)).put("k", "v");
              database.updateStoreRow(\`other/\${id}\`, "k", () => ({ result: 1 }));
              database.deleteStore(store);
            }
          }
        `,
      },
    ];
    expect(rawDatabaseWrites(sources, new Set()).map((write) => write.store)).toEqual([
      "fixed",
      "family/*",
      "other/*",
      null,
    ]);
    expect(storesOverlap("family/*", "family/index")).toBe(true);
    expect(storesOverlap("public-operations/*", "family/index")).toBe(false);
  });

  test("still finds writes and helper callers that only an escape spells", () => {
    // The scan parses only files whose text can name a raw writer or a row
    // helper; an identifier written with escapes must not slip past it.
    const sources = [
      {
        file: "core/rows.ts",
        source: `export function writeRow(database: Db, store: string) {
          database.\\u0072ows(store).put("k", "v");
        }`,
      },
      {
        file: "core/engine.ts",
        source: `import { write\\u{52}ow } from "./rows.js";
          export class Engine { run(database: Db) { writeRow(database, "kanban"); } }`,
      },
      { file: "core/unrelated.ts", source: `export const banner = "\\u001b[1m";` },
    ];
    expect(rawDatabaseWrites(sources, new Set())).toEqual([
      {
        location: expect.stringMatching(/rows.ts:2 via core\/engine.ts:2$/),
        call: "rows",
        store: "kanban",
      },
    ]);
  });
});
