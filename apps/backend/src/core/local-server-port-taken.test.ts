import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { LOCAL_BRIDGE_READY_PREFIX } from "@orkestrator/protocol/node/local-bridge-readiness";
import { checkHttpHealth } from "./commands/server-health.js";
import { waitForLocalServerStartup } from "./commands/servers.js";
import { LocalServerPortTakenError, watchLocalServerOutput } from "./local-server-port-taken.js";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(authCheckStatus: number): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/global/auth-check"
        ? Response.json({ status: authCheckStatus }, { status: authCheckStatus })
        : Response.json({ status: "ok" }),
  });
  servers.push(server);
  return server.port!;
}

type FakeChild = ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough };

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
  }) as unknown as FakeChild;
}

function announce(child: FakeChild, port: number) {
  child.stdout.write(LOCAL_BRIDGE_READY_PREFIX);
  child.stdout.write(`${port}\n`);
}

const immediate = { delay: () => Promise.resolve() };
const headers = { Authorization: "Bearer this-start" };

describe("watchLocalServerOutput", () => {
  test("sees Bun's bind failure split across chunks, on either stream", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let calls = 0;
    const watcher = watchLocalServerOutput([stdout, stderr], () => {
      calls += 1;
    });
    stdout.write("listening soon\n");
    stderr.write("error: Failed to start server. Is port 41");
    expect(watcher.seen()).toBe(false);
    stderr.write("103 in use?\n");
    stderr.write("error: Failed to start server. Is port 41103 in use?\n");
    expect(watcher.seen()).toBe(true);
    expect(calls).toBe(1);
    watcher.stop();
  });

  test("ignores output that merely mentions a port", () => {
    const stderr = new PassThrough();
    const watcher = watchLocalServerOutput([stderr], () => undefined);
    stderr.write("listening on port 41103\n");
    expect(watcher.seen()).toBe(false);
    watcher.stop();
  });

  test("waits for both streams even when one emits end and close", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const watcher = watchLocalServerOutput([stdout, stderr], () => undefined);
    let finished = false;
    const drained = watcher.drained().then(() => {
      finished = true;
    });
    const stdoutClosed = once(stdout, "close");
    stdout.end();
    await stdoutClosed;
    expect(finished).toBe(false);
    stderr.end("EADDRINUSE");
    await drained;
    expect(watcher.seen()).toBe(true);
    watcher.stop();
  });
});

describe("waitForLocalServerStartup and a lost port", () => {
  test("a child that could not bind its port is a port-taken failure", async () => {
    const child = fakeChild();
    const waiting = waitForLocalServerStartup(child, 1, "codex");
    child.stderr.write("error: Failed to start server. Is port 1 in use?\n");
    child.emit("exit", 1, null);
    await expect(waiting).rejects.toThrow("taken before the server could bind it");
  });

  test("drains stderr after stdout has both ended and closed", async () => {
    const child = fakeChild();
    const waiting = waitForLocalServerStartup(child, 1, "codex");
    child.emit("exit", 1, null);
    const stdoutClosed = once(child.stdout, "close");
    child.stdout.end();
    await stdoutClosed;
    child.stderr.end("error: Failed to start server. Is port 1 in use?\n");
    await expect(waiting).rejects.toBeInstanceOf(LocalServerPortTakenError);
  });

  test("an exit with no bind failure keeps the ordinary startup error", async () => {
    const child = fakeChild();
    const waiting = waitForLocalServerStartup(child, 1, "codex");
    child.stderr.end("error: something else\n");
    child.stdout.end();
    child.emit("exit", 23, null);
    await expect(waiting).rejects.toThrow(
      "codex server exited before becoming healthy (code 23, signal null)",
    );
  });

  test("a healthy answer from a server that refuses this start's token is another server", async () => {
    const port = serve(401);
    const child = fakeChild();
    const waiting = waitForLocalServerStartup(child, port, "codex", undefined, {
      health: immediate,
      identityHeaders: headers,
    });
    announce(child, port);
    await expect(waiting).rejects.toThrow("answered by a different server");
  });

  test.each([200, 404])(
    "accepts HTTP %d in compatibility mode after the child binds",
    async (status) => {
      const port = serve(status);
      const child = fakeChild();
      const waiting = waitForLocalServerStartup(child, port, "codex", undefined, {
        health: immediate,
        identityHeaders: headers,
      });
      announce(child, port);
      await waiting;
    },
  );

  test.each([404, 503])(
    "waits for the child despite a foreign listener whose auth route returns %d",
    async (status) => {
      const port = serve(status);
      const child = fakeChild();
      // Hold the first polling delay so the child's failure is the next event.
      const firstPoll = Promise.withResolvers<void>();
      const continuePolling = Promise.withResolvers<void>();
      const waiting = waitForLocalServerStartup(child, port, "codex", undefined, {
        health: {
          delay: () => {
            firstPoll.resolve();
            return continuePolling.promise;
          },
        },
        identityHeaders: headers,
      });
      await Promise.race([firstPoll.promise, waiting]);
      expect(await checkHttpHealth(port)).toBe(true);
      child.stderr.end("EADDRINUSE\n");
      continuePolling.resolve();
      await expect(waiting).rejects.toBeInstanceOf(LocalServerPortTakenError);
    },
  );

  test.each([404, 503])(
    "requires successful managed auth after the child binds (HTTP %d)",
    async (status) => {
      const port = serve(status);
      const child = fakeChild();
      const waiting = waitForLocalServerStartup(child, port, "codex", undefined, {
        health: immediate,
        identityHeaders: headers,
        requireAuthenticatedReadiness: true,
      });
      announce(child, port);
      await expect(waiting).rejects.toThrow("did not become healthy");
    },
  );
});
