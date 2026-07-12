import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackendProcess } from "../../../apps/backend/src/core-process";

const directories: string[] = [];
const processes: BackendProcess[] = [];
const browserFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = browserFetch;
  for (const backend of processes.splice(0)) backend.stop();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Electron backend process supervisor", () => {
  test("launches the standalone service and invokes it through HTTP", async () => {
    // The shared DOM test setup installs a browser fetch with CORS enforcement;
    // Electron's main process uses the native server-side fetch implementation.
    globalThis.fetch = Bun.fetch;
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    directories.push(dataDir);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);

    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      onEvent: () => undefined,
    });

    expect(backendProcess.getInfo()?.bindAddress).toBe("127.0.0.1");
    await expect(client.invoke("greet", { name: "Electron" })).resolves.toBe(
      "Hello, Electron! You've been greeted from the Orkestrator backend!",
    );
  });
});
