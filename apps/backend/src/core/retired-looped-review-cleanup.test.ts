import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupRetiredLoopedReviews } from "./retired-looped-review-cleanup.js";
import { StorageDatabase } from "./storage-database.js";
import {
  LOOPED_REVIEW_CLEANUP_STORE,
  RETIRE_LOOPED_REVIEWS_VERSION,
} from "./storage-retired-features.js";
import { STORAGE_MIGRATIONS, storeLayout } from "./storage-stores.js";
import { createEnvironment, StorageService } from "./storage.js";
import { storageDatabase } from "./storage-test-support.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

for (const phase of ["preparing", "fixing", "creating-pr"]) {
  test(`upgrade aborts and confirms an HTTP container turn in ${phase}, retaining failed work across reopen`, async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-retired-turn-"));
    directories.push(directory);
    const environment = {
      ...createEnvironment("project"),
      id: "env-review",
      containerId: "owned-container",
      status: "running" as const,
    };
    const before = new StorageDatabase(directory, {
      layoutFor: (store) => (store === "looped-reviews" ? { kind: "record" } : storeLayout(store)),
      migrations: STORAGE_MIGRATIONS.filter(
        (migration) => migration.version < RETIRE_LOOPED_REVIEWS_VERSION,
      ),
    });
    before.writeStore("environments", [environment]);
    // Workflow-only sessions also need recovery: they need not have a native tab.
    before.writeStore("looped-reviews", {
      review: {
        id: "review",
        environmentId: environment.id,
        version: 1,
        revision: 1,
        updatedAt: new Date(0).toISOString(),
        snapshot: {
          agent: "codex",
          phase,
          sessions: [{ providerSessionId: "surviving-turn" }],
        },
      },
    });
    before.close();
    const target = {
      environmentId: environment.id,
      agent: "codex",
      providerSessionId: "surviving-turn",
    };
    let storage = new StorageService(directory);
    let failAbort = true;
    let confirmIdle = false;
    let running = true;
    const calls: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.headers.get("X-Orkestrator-Codex-Token")).toBe("fixture-token");
        const route = new URL(request.url).pathname;
        calls.push(`${request.method} ${route}`);
        // The identity must still be durable at both the abort and confirmation.
        expect(storageDatabase(storage).readStore(LOOPED_REVIEW_CLEANUP_STORE)?.value).toEqual([
          target,
        ]);
        if (route.endsWith("/abort")) {
          if (failAbort) return Response.json({ error: "unavailable" }, { status: 503 });
          if (confirmIdle) running = false;
          return Response.json({ ok: true });
        }
        return Response.json({ status: running ? "running" : "idle", messages: [] });
      },
    });
    const invoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
      expect(command).toBe("start_codex_server");
      expect(args).toEqual({ containerId: "owned-container" });
      return { hostPort: server.port, authToken: "fixture-token" } as T;
    };
    try {
      await storage.init();
      await cleanupRetiredLoopedReviews(storage, invoke);
      expect(running).toBe(true);
      expect(storageDatabase(storage).readStore(LOOPED_REVIEW_CLEANUP_STORE)?.value).toEqual([
        target,
      ]);
      storage.close();
      storage = new StorageService(directory);
      await storage.init();
      failAbort = false;
      await cleanupRetiredLoopedReviews(storage, invoke);
      // A 2xx abort that has not stopped the turn is not confirmation.
      expect(running).toBe(true);
      expect(storageDatabase(storage).readStore(LOOPED_REVIEW_CLEANUP_STORE)?.value).toEqual([
        target,
      ]);
      confirmIdle = true;
      await cleanupRetiredLoopedReviews(storage, invoke);
      expect(running).toBe(false);
      expect(storageDatabase(storage).hasStore(LOOPED_REVIEW_CLEANUP_STORE)).toBe(false);
      expect(calls.filter((call) => call.endsWith("/abort"))).toHaveLength(3);
      const settledCalls = calls.length;
      await cleanupRetiredLoopedReviews(storage, invoke);
      expect(calls.length).toBe(settledCalls);
    } finally {
      storage.close();
      await server.stop(true);
    }
  });
}
