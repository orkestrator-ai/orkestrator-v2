import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { STORAGE_DATABASE_FILE } from "./storage-database.js";
import type { Project, Session } from "./models.js";
import { StorageService } from "./storage.js";
import { seedStore } from "./storage-test-support.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-session-project-rows-"));
  directories.push(directory);
  return directory;
}

async function service(directory: string): Promise<StorageService> {
  const storage = new StorageService(directory);
  services.push(storage);
  await storage.init();
  return storage;
}

function session(id: string, environmentId: string, order: number): Session {
  return {
    id,
    environmentId,
    containerId: "container",
    tabId: `tab-${id}`,
    sessionType: "plain",
    status: "connected",
    createdAt: `2026-11-01T00:00:${String(order).padStart(2, "0")}.000Z`,
    lastActivityAt: "2026-11-01T00:00:00.000Z",
    order,
  };
}

function project(index: number): Project {
  return {
    id: `project-${index}`,
    name: `project-${index}`,
    gitUrl: `https://example.com/project-${index}.git`,
    localPath: `/checkouts/project-${index}`,
    addedAt: "2026-11-01T00:00:00.000Z",
    order: index,
  };
}

function seedSessions(directory: string, count = 4): void {
  seedStore(
    directory,
    "sessions.json",
    Array.from({ length: count * 2 }, (_, index) =>
      session(`session-${index}`, `environment-${index % 2}`, Math.floor(index / 2)),
    ),
  );
}

const storageModule = path.join(import.meta.dir, "storage.ts");
const supportModule = path.join(import.meta.dir, "storage-test-support.ts");

/** Runs `body` with a `StorageService` named `storage` in another process. */
function inProcess(directory: string, body: string): ReturnType<typeof Bun.spawn> {
  const script = `
    import { StorageService } from ${JSON.stringify(storageModule)};
    import { storageInternals } from ${JSON.stringify(supportModule)};
    const storage = new StorageService(${JSON.stringify(directory)});
    await storage.init();
    ${body}
    await storage.close();
    process.exit(0);
  `;
  return Bun.spawn([process.execPath, "-e", script], {
    cwd: path.join(import.meta.dir, "..", ".."),
    env: { ...process.env, NODE_ENV: "test" },
    stdout: "ignore",
    stderr: "inherit",
  });
}

describe("cross-process writers", () => {
  test("two processes writing the same rows lose no update", async () => {
    const directory = await dataDir();
    seedSessions(directory, 2);
    seedStore(directory, "projects.json", [project(0), project(1)]);
    const seeded = await service(directory);
    await seeded.close();

    const writer = (name: string, field: "lastActivityAt" | "containerId") =>
      inProcess(
        directory,
        `for (let index = 0; index < 40; index += 1) {
           await storage.updateSession("session-0", { ${field}: "${name}-" + index });
           await storage.updateProject("project-${name === "one" ? 0 : 1}", { name: "${name}-" + index });
           await storage.createSession("environment-1", "container", "${name}-" + index, "plain");
           await storage.removeSession(
             (await storage.getSessionsByEnvironment("environment-1")).find(
               (row) => row.tabId === "${name}-" + index,
             ).id,
           );
         }`,
      );
    const children = [writer("one", "lastActivityAt"), writer("two", "containerId")];
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);

    const storage = await service(directory);
    expect(await storage.getSession("session-0")).toMatchObject({
      lastActivityAt: "one-39",
      containerId: "two-39",
    });
    expect((await storage.getProject("project-0"))?.name).toBe("one-39");
    expect((await storage.getProject("project-1"))?.name).toBe("two-39");
    expect(await storage.getSessionsByEnvironment("environment-1")).toHaveLength(2);
  }, 60_000);
});

describe("an interrupted write", () => {
  async function assertReadable(directory: string): Promise<void> {
    const db = new Database(path.join(directory, STORAGE_DATABASE_FILE));
    try {
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      // As a crashed holder would look, so the next writer need not wait it out.
      db.query("UPDATE leases SET heartbeat_at = 0").run();
    } finally {
      db.close();
    }
  }

  test("a process killed inside a session reorder commits none of it", async () => {
    const directory = await dataDir();
    seedSessions(directory);
    const seeded = await service(directory);
    await seeded.close();

    const child = inProcess(
      directory,
      `const repository = storageInternals(storage).repos.drafts;
       const write = repository.writeSessionRow.bind(repository);
       let writes = 0;
       repository.writeSessionRow = (session) => {
         write(session);
         writes += 1;
         if (writes === 2) process.kill(process.pid, "SIGKILL");
       };
       await storage.reorderSessions("environment-0", ["session-6", "session-4", "session-2", "session-0"]);`,
    );
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    await assertReadable(directory);

    const storage = await service(directory);
    expect((await storage.getSessionsByEnvironment("environment-0")).map((row) => row.id)).toEqual([
      "session-0",
      "session-2",
      "session-4",
      "session-6",
    ]);
    await storage.updateSession("session-0", { name: "after the crash" });
    expect((await storage.getSession("session-0"))?.name).toBe("after the crash");
  }, 30_000);

  test("a process killed inside a project arrangement commits none of it", async () => {
    const directory = await dataDir();
    seedStore(directory, "projects.json", [project(0), project(1), project(2)]);
    const seeded = await service(directory);
    await seeded.close();

    const child = inProcess(
      directory,
      `const repository = storageInternals(storage).repos.projects;
       const save = repository.saveProject.bind(repository);
       let writes = 0;
       repository.saveProject = (item) => {
         save(item);
         writes += 1;
         if (writes === 2) process.kill(process.pid, "SIGKILL");
       };
       await storage.reorderProjects(["project-2", "project-1", "project-0"]);`,
    );
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    await assertReadable(directory);

    const storage = await service(directory);
    expect((await storage.loadProjects()).map((item) => item.id)).toEqual([
      "project-0",
      "project-1",
      "project-2",
    ]);
    await storage.updateProject("project-0", { name: "after the crash" });
    expect((await storage.getProject("project-0"))?.name).toBe("after the crash");
  }, 30_000);
});
