import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import {
  isAddressInUseError,
  listenEphemeral,
  retryOnAddressInUse,
  type EphemeralListener,
} from "./ports.js";

const held: Array<EphemeralListener<Server>> = [];
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await Promise.all(held.splice(0).map((listener) => listener.close()));
});

async function hold(): Promise<number> {
  const listener = await listenEphemeral();
  held.push(listener);
  return listener.port;
}

/** Binds a fresh node `net` server on `port`, rejecting with the real listen error. */
async function bindNet(port: number): Promise<number> {
  const listener = await new Promise<EphemeralListener<Server>>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        server,
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
  held.push(listener);
  return listener.port;
}

describe("listenEphemeral", () => {
  test("keeps the chosen port bound until closed", async () => {
    const listener = await listenEphemeral();
    held.push(listener);
    expect(listener.port).toBeGreaterThan(0);
    expect(listener.server.listening).toBe(true);
    await expect(bindNet(listener.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("retryOnAddressInUse", () => {
  test("a held port fails the first attempt and a fresh port succeeds on the retry", async () => {
    const taken = await hold();
    const tried: number[] = [];
    const port = await retryOnAddressInUse(async (attempt) => {
      const candidate = attempt === 1 ? taken : 0;
      tried.push(candidate);
      return bindNet(candidate);
    });
    expect(tried).toEqual([taken, 0]);
    expect(port).not.toBe(taken);
  });

  test("retries Bun.serve's EADDRINUSE as well", async () => {
    const taken = await hold();
    let calls = 0;
    const server = await retryOnAddressInUse(async (attempt) => {
      calls += 1;
      return Bun.serve({
        hostname: "127.0.0.1",
        port: attempt === 1 ? taken : 0,
        fetch: () => new Response("ok"),
      });
    });
    closers.push(() => server.stop(true));
    expect(calls).toBe(2);
    expect(server.port).not.toBe(taken);
  });

  test("does not retry any other error", async () => {
    let calls = 0;
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    await expect(
      retryOnAddressInUse(async () => {
        calls += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  test("rethrows the last EADDRINUSE once the attempts are spent", async () => {
    const taken = await hold();
    let calls = 0;
    await expect(
      retryOnAddressInUse(
        async () => {
          calls += 1;
          return bindNet(taken);
        },
        { attempts: 3 },
      ),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(calls).toBe(3);
  });

  test("refuses fewer than one attempt", async () => {
    await expect(retryOnAddressInUse(async () => 1, { attempts: 0 })).rejects.toThrow(RangeError);
  });
});

describe("isAddressInUseError", () => {
  test.each([
    [{ code: "EADDRINUSE" }, true],
    [new Error("listen EADDRINUSE: address already in use 127.0.0.1:4000"), true],
    [new Error("Failed to start server. Is port 4000 in use?"), true],
    [Object.assign(new Error("denied"), { code: "EACCES" }), false],
    [new Error("port 4000 is fine"), false],
    ["EADDRINUSE", false],
    [null, false],
  ])("%p -> %p", (error, expected) => {
    expect(isAddressInUseError(error)).toBe(expected);
  });
});
