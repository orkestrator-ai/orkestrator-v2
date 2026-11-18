import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { waitForLocalServerStartup } from "./commands-servers.js";
import {
  LocalServerPortTakenError,
  refusesOwnToken,
  watchForPortInUse,
} from "./local-server-port-taken.js";

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
        ? Response.json({ error: "status" }, { status: authCheckStatus })
        : Response.json({ status: "ok" }),
  });
  servers.push(server);
  return server.port!;
}

type FakeChild = ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough };

/** A child with real stdio streams and no process behind it. */
function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
  }) as unknown as FakeChild;
}

const immediate = { delay: () => Promise.resolve() };
const headers = { Authorization: "Bearer this-start" };

describe("watchForPortInUse", () => {
  test("sees Bun's bind failure split across chunks, on either stream", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let calls = 0;
    const watcher = watchForPortInUse([stdout, stderr], () => {
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
    const watcher = watchForPortInUse([stderr], () => undefined);
    stderr.write("listening on port 41103\n");
    expect(watcher.seen()).toBe(false);
    watcher.stop();
  });
});

describe("refusesOwnToken", () => {
  test("is true only for an explicit 401", async () => {
    expect(await refusesOwnToken(serve(401), headers)).toBe(true);
    // A bridge without the route, or a fake, is not evidence of another server.
    expect(await refusesOwnToken(serve(404), headers)).toBe(false);
    expect(await refusesOwnToken(serve(200), headers)).toBe(false);
  });
});

describe("waitForLocalServerStartup and a lost port", () => {
  test("a child that could not bind its port is a port-taken failure, not a crash", async () => {
    const child = fakeChild();
    const waiting = waitForLocalServerStartup(child, 1, "codex", undefined, {
      health: { ...immediate, checkHealth: () => new Promise(() => undefined) },
    });
    child.stderr.write("error: Failed to start server. Is port 1 in use?\n");
    child.emit("exit", 1, null);
    const error = await waiting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalServerPortTakenError);
    expect((error as Error).message).toContain("taken before the server could bind it");
  });

  test("an exit after the bind failure arrives first is still a port-taken failure", async () => {
    const child = fakeChild();
    const waiting = waitForLocalServerStartup(child, 1, "codex", undefined, {
      health: { ...immediate, checkHealth: () => new Promise(() => undefined) },
    });
    child.emit("exit", 1, null);
    child.stderr.end("error: Failed to start server. Is port 1 in use?\n");
    expect(await waiting.catch((caught: unknown) => caught)).toBeInstanceOf(
      LocalServerPortTakenError,
    );
  });

  test("an exit with no bind failure keeps the ordinary startup error", async () => {
    const child = fakeChild();
    const waiting = waitForLocalServerStartup(child, 1, "codex", undefined, {
      health: { ...immediate, checkHealth: () => new Promise(() => undefined) },
    });
    child.stderr.end("error: something else\n");
    child.stdout.end();
    child.emit("exit", 23, null);
    const error = await waiting.catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(LocalServerPortTakenError);
    expect((error as Error).message).toBe(
      "codex server exited before becoming healthy (code 23, signal null)",
    );
  });

  test("a healthy answer from a server that refuses this start's token is another server", async () => {
    const port = serve(401);
    const error = await waitForLocalServerStartup(fakeChild(), port, "codex", undefined, {
      health: { ...immediate, checkHealth: () => Promise.resolve(true) },
      identityHeaders: headers,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalServerPortTakenError);
    expect((error as Error).message).toContain("answered by a different server");
  });

  test("a healthy server that accepts the token, or has no auth-check route, is this one", async () => {
    for (const status of [200, 404]) {
      const port = serve(status);
      await waitForLocalServerStartup(fakeChild(), port, "codex", undefined, {
        health: { ...immediate, checkHealth: () => Promise.resolve(true) },
        identityHeaders: headers,
      });
    }
  });
});
