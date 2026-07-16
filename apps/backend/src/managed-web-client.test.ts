import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFileOwnershipStore,
  createManagedWebClient,
  ManagedWebClient,
  type ManagedWebClientOwnership,
} from "./managed-web-client.js";
import { TailscaleServeConflictError } from "./tailscale-serve.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function memoryOwnershipStore(initial: ManagedWebClientOwnership | null = null) {
  let ownership = initial;
  return {
    load: mock(async () => ownership),
    save: mock(async (next: ManagedWebClientOwnership) => { ownership = next; }),
    clear: mock(async () => { ownership = null; }),
    current: () => ownership,
  };
}

describe("managed Electron web client", () => {
  test("publishes and removes the loopback browser listener through Tailscale Serve", async () => {
    const start = mock(async () => "https://workstation.example.ts.net/");
    const stop = mock(async () => undefined);
    const client = new ManagedWebClient({ start, stop });
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");

    await expect(client.setEnabled(true)).resolves.toEqual({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
      error: null,
      resetAvailable: false,
    });
    expect(start).toHaveBeenCalledWith(34121, 443, { adoptExisting: false });

    await expect(client.setEnabled(false)).resolves.toEqual({
      enabled: false,
      running: false,
      url: null,
      error: null,
      resetAvailable: false,
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("keeps the backend available and supports retry when Serve setup fails", async () => {
    const start = mock(async (): Promise<string> => {
      throw new Error("Tailscale is not connected");
    });
    const stop = mock(async () => undefined);
    const logger = { error: mock(() => undefined) };
    const client = new ManagedWebClient({ start, stop }, 8443, logger);
    client.setBrowserListenerUrl("http://127.0.0.1:41234/");

    await expect(client.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: false,
      error: "Tailscale is not connected",
    });
    expect(stop).toHaveBeenCalledTimes(1);

    start.mockImplementationOnce(async () => "https://workstation.example.ts.net:8443/");
    await expect(client.setEnabled(true)).resolves.toMatchObject({ running: true, error: null });
    expect(start).toHaveBeenLastCalledWith(41234, 8443, { adoptExisting: false });
  });

  test("clears a conflicting HTTPS listener and republishes web access", async () => {
    const ownership = memoryOwnershipStore();
    const start = mock(async () => "https://workstation.example.ts.net/");
    start.mockImplementationOnce(async () => {
      throw new TailscaleServeConflictError(443, true);
    });
    const clearHttpsPort = mock(async () => undefined);
    const client = new ManagedWebClient(
      { start, stop: mock(async () => undefined), clearHttpsPort },
      443,
      { error: mock(() => undefined) },
      ownership,
    );
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");
    await expect(client.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: false,
      error: "Refusing to replace the existing Tailscale Serve configuration on HTTPS port 443",
      resetAvailable: true,
    });

    await expect(client.resetServe()).resolves.toEqual({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
      error: null,
      resetAvailable: false,
    });
    expect(clearHttpsPort).toHaveBeenCalledWith(443);
    expect(start).toHaveBeenCalledWith(34121, 443, { adoptExisting: false });
    expect(ownership.current()).toEqual({ version: 1, targetPort: 34121, httpsPort: 443 });
  });

  test("reports a targeted reset failure without pretending web access stopped", async () => {
    const client = new ManagedWebClient({
      start: mock(async () => "https://workstation.example.ts.net/"),
      stop: mock(async () => undefined),
      clearHttpsPort: mock(async () => { throw new Error("permission denied"); }),
    }, 443, { error: mock(() => undefined) });
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");
    await client.setEnabled(true);

    await expect(client.resetServe()).resolves.toMatchObject({
      enabled: true,
      running: true,
      error: "permission denied",
      resetAvailable: false,
    });
  });

  test("keeps a conflicting listener resettable after a transient reset failure", async () => {
    const start = mock(async () => "https://workstation.example.ts.net/");
    start.mockImplementationOnce(async () => {
      throw new TailscaleServeConflictError(443, true);
    });
    const clearHttpsPort = mock(async () => undefined);
    clearHttpsPort.mockImplementationOnce(async () => { throw new Error("daemon unavailable"); });
    const client = new ManagedWebClient(
      { start, stop: mock(async () => undefined), clearHttpsPort },
      443,
      { error: mock(() => undefined) },
    );
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");
    await expect(client.setEnabled(true)).resolves.toMatchObject({ resetAvailable: true });

    await expect(client.resetServe()).resolves.toMatchObject({
      running: false,
      error: "daemon unavailable",
      resetAvailable: true,
    });
    await expect(client.resetServe()).resolves.toMatchObject({
      running: true,
      error: null,
      resetAvailable: false,
    });
    expect(clearHttpsPort).toHaveBeenCalledTimes(2);
  });

  test("reports reset capability and persistence failures without corrupting state", async () => {
    const unsupported = new ManagedWebClient({
      start: mock(async () => "https://unused.example/"),
      stop: mock(async () => undefined),
    });
    await expect(unsupported.resetServe()).resolves.toMatchObject({
      error: "Tailscale Serve reset is unavailable.",
      resetAvailable: false,
    });

    let clearCalls = 0;
    const ownership = memoryOwnershipStore();
    ownership.clear.mockImplementation(async () => {
      clearCalls += 1;
      if (clearCalls === 2) throw new Error("ownership disk full");
    });
    const start = mock(async () => "https://workstation.example.ts.net/");
    start.mockImplementationOnce(async () => { throw new TailscaleServeConflictError(443, true); });
    const client = new ManagedWebClient(
      {
        start,
        stop: mock(async () => undefined),
        clearHttpsPort: mock(async () => undefined),
      },
      443,
      { error: mock(() => undefined) },
      ownership,
    );
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");
    await client.setEnabled(true);

    await expect(client.resetServe()).resolves.toMatchObject({
      running: false,
      error: "ownership disk full",
      resetAvailable: true,
    });
    await expect(client.resetServe()).resolves.toMatchObject({ running: true, error: null });
  });

  test("reports a republish failure after clearing the conflicting listener", async () => {
    const start = mock(async (): Promise<string> => {
      throw new TailscaleServeConflictError(443, true);
    });
    start.mockImplementationOnce(async () => { throw new TailscaleServeConflictError(443, true); });
    start.mockImplementationOnce(async () => { throw new Error("republish failed"); });
    const client = new ManagedWebClient({
      start,
      stop: mock(async () => undefined),
      clearHttpsPort: mock(async () => undefined),
    }, 443, { error: mock(() => undefined) });
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");
    await client.setEnabled(true);

    await expect(client.resetServe()).resolves.toMatchObject({
      running: false,
      error: "republish failed",
      resetAvailable: false,
    });
  });

  test("serializes reset operations with following lifecycle transitions", async () => {
    const order: string[] = [];
    let releaseReset: (() => void) | undefined;
    const start = mock(async () => {
      order.push("start");
      return "https://workstation.example.ts.net/";
    });
    start.mockImplementationOnce(async () => {
      throw new TailscaleServeConflictError(443, true);
    });
    const client = new ManagedWebClient({
      start,
      stop: mock(async () => { order.push("stop"); }),
      clearHttpsPort: mock(() => new Promise<void>((resolve) => {
        order.push("reset-start");
        releaseReset = () => {
          order.push("reset-end");
          resolve();
        };
      })),
    }, 443, { error: mock(() => undefined) });
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");
    await client.setEnabled(true);
    order.length = 0;

    const resetting = client.resetServe();
    const disabling = client.setEnabled(false);
    await Bun.sleep(0);
    expect(order).toEqual(["reset-start"]);
    releaseReset?.();

    await expect(resetting).resolves.toMatchObject({ enabled: true, running: true });
    await expect(disabling).resolves.toMatchObject({ enabled: false, running: false });
    expect(order).toEqual(["reset-start", "reset-end", "start", "stop"]);
  });

  test("reports an unavailable browser listener without invoking Serve", async () => {
    const start = mock(async () => "https://unused.example/");
    const client = new ManagedWebClient({ start, stop: mock(async () => undefined) });

    await expect(client.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: false,
      error: "The backend browser listener is unavailable.",
    });
    expect(start).not.toHaveBeenCalled();
  });

  test("serializes rapid transitions and shuts down after pending work", async () => {
    let releaseStart: (() => void) | undefined;
    const start = mock(() => new Promise<string>((resolve) => {
      releaseStart = () => resolve("https://workstation.example.ts.net/");
    }));
    const stop = mock(async () => undefined);
    const client = new ManagedWebClient({ start, stop });
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");

    const enabling = client.setEnabled(true);
    const disabling = client.setEnabled(false);
    await Bun.sleep(0);
    expect(stop).not.toHaveBeenCalled();
    releaseStart?.();

    await expect(enabling).resolves.toMatchObject({ enabled: true, running: true });
    await expect(disabling).resolves.toMatchObject({ enabled: false, running: false });
    await expect(client.shutdown()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  test("retains running state and ownership when disabling fails", async () => {
    const ownership = memoryOwnershipStore();
    const stop = mock(async () => { throw new Error("permission denied"); });
    const client = new ManagedWebClient(
      { start: mock(async () => "https://workstation.example.ts.net/"), stop },
      443,
      { error: mock(() => undefined) },
      ownership,
    );
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");
    await client.setEnabled(true);

    await expect(client.setEnabled(false)).resolves.toMatchObject({
      enabled: false,
      running: true,
      error: "permission denied",
    });
    expect(ownership.current()).toEqual({ version: 1, targetPort: 34121, httpsPort: 443 });
    await expect(client.shutdown()).rejects.toThrow("permission denied");
  });

  test("retains ownership for a later retry when failed setup cleanup also fails", async () => {
    const ownership = memoryOwnershipStore();
    const client = new ManagedWebClient(
      {
        start: mock(async () => { throw new Error("URL discovery failed"); }),
        stop: mock(async () => { throw new Error("cleanup failed"); }),
      },
      443,
      { error: mock(() => undefined) },
      ownership,
    );
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");

    await expect(client.setEnabled(true)).resolves.toMatchObject({
      running: false,
      error: "URL discovery failed",
    });
    expect(ownership.current()).toEqual({ version: 1, targetPort: 34121, httpsPort: 443 });
  });

  test("adopts a matching route after restart and removes it when disabled", async () => {
    const ownership = memoryOwnershipStore({ version: 1, targetPort: 34121, httpsPort: 443 });
    const start = mock(async () => "https://workstation.example.ts.net/");
    const stopOwned = mock(async () => true);
    const client = new ManagedWebClient(
      { start, stop: mock(async () => undefined), stopOwned },
      443,
      console,
      ownership,
    );
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");

    await expect(client.setEnabled(true)).resolves.toMatchObject({ running: true, error: null });
    expect(start).toHaveBeenCalledWith(34121, 443, { adoptExisting: true });
    await expect(client.setEnabled(false)).resolves.toMatchObject({ enabled: false, running: false });
    expect(stopOwned).toHaveBeenCalledWith(34121, 443);
    expect(ownership.current()).toBeNull();
  });

  test("persists ownership atomically for the factory-backed managed client", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-managed-web-client-"));
    temporaryDirectories.push(dataDir);
    const ownershipPath = path.join(dataDir, "managed-web-client.json");
    const store = createFileOwnershipStore(ownershipPath);
    const ownership = { version: 1, targetPort: 34121, httpsPort: 8443 } as const;

    await store.save(ownership);
    expect(await store.load()).toEqual(ownership);
    expect((await stat(ownershipPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(ownershipPath, "utf8"))).toEqual(ownership);
    await store.clear();
    expect(await store.load()).toBeNull();
    expect(createManagedWebClient("tailscale", dataDir)).toBeInstanceOf(ManagedWebClient);
  });

  test("rejects malformed and out-of-range file-backed ownership records", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-managed-web-client-invalid-"));
    temporaryDirectories.push(dataDir);
    const ownershipPath = path.join(dataDir, "managed-web-client.json");
    const store = createFileOwnershipStore(ownershipPath);

    await writeFile(ownershipPath, "not json\n", { mode: 0o600 });
    await expect(store.load()).rejects.toThrow();

    await writeFile(ownershipPath, JSON.stringify({ version: 1, targetPort: 0, httpsPort: 443 }));
    await expect(store.load()).rejects.toThrow("Managed web client ownership file is invalid");
  });

  test("rejects malformed persisted ownership without touching Serve", async () => {
    const store = {
      load: mock(async () => { throw new Error("Managed web client ownership file is invalid"); }),
      save: mock(async () => undefined),
      clear: mock(async () => undefined),
    };
    const start = mock(async () => "https://unused.example/");
    const client = new ManagedWebClient(
      { start, stop: mock(async () => undefined) },
      443,
      { error: mock(() => undefined) },
      store,
    );
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");

    await expect(client.setEnabled(true)).resolves.toMatchObject({
      running: false,
      error: "Managed web client ownership file is invalid",
    });
    expect(start).not.toHaveBeenCalled();
  });
});
