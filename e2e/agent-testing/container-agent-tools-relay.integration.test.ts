import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";

const relayPath = join(import.meta.dir, "container-agent-tools-relay.ts");
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function eventually<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("relay process did not reach expected state");
    await Bun.sleep(10);
  }
}

function unusedPort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function dial(port: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("error", () => {
      socket.destroy();
      resolve(null);
    });
    socket.once("connect", () => resolve(socket));
  });
}

function launch(args: string[], env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, relayPath, ...args], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Consume output immediately so a broken process cannot block on a full pipe.
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await Promise.all([stdout, stderr]);
  });
  return { child, stdout, stderr };
}

async function dockerStandIn(failCopy = false) {
  const dir = await mkdtemp(join(tmpdir(), "relay-process-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const copy = join(dir, "copy.ts");
  const calls = join(dir, "calls");
  const pid = join(dir, "container.pid");
  // Only this test's child sees the stand-in. It records docker argv, consumes
  // the real file on stdin, then execs the copied container entry point locally.
  const shim = join(dir, "docker");
  await Bun.write(
    shim,
    `#!/bin/sh
printf '%s\\n' "$@" >> "$RELAY_CALLS"
[ "$1" = exec ] && [ "$2" = -i ] && [ "$3" = --user ] && [ "$4" = node ] && [ "$5" = fixture-only ] || exit 91
shift 5
if [ "$1" = sh ]; then
  [ "$2" = -c ] && [ "$3" = 'cat > /tmp/orkestrator-qa-agent-tools-relay.ts' ] || exit 92
  ${failCopy ? "exit 23" : 'cat > "$RELAY_COPY"'}
else
  [ "$1" = bun ] && [ "$2" = /tmp/orkestrator-qa-agent-tools-relay.ts ] && [ "$3" = container ] && [ "$4" = --port ] && [ "$6" = --listen ] && [ "$7" = 127.0.0.1 ] || exit 93
  if [ -n "$RELAY_EXIT" ]; then exit "$RELAY_EXIT"; fi
  echo $$ > "$RELAY_PID"
  exec "$RELAY_BUN" "$RELAY_COPY" container --port "$RELAY_PORT" --listen "$7"
fi
`,
  );
  await chmod(shim, 0o700);
  return {
    copy,
    calls,
    pid,
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      RELAY_COPY: copy,
      RELAY_CALLS: calls,
      RELAY_PID: pid,
      RELAY_BUN: process.execPath,
      RELAY_PORT: String(unusedPort()),
    },
  };
}

describe("relay process entry points", () => {
  test("host copies and launches the container half, multiplexes binary streams, and stops its child", async () => {
    const backend = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          socket.write(data);
        },
        end(socket) {
          socket.end();
        },
      },
    });
    cleanups.push(() => backend.stop(true));
    const fixture = await dockerStandIn();
    const run = launch(
      ["host", "--container", "fixture-only", "--port", String(backend.port)],
      fixture.env,
    );
    const first = await eventually(
      () => dial(Number(fixture.env.RELAY_PORT)),
      (socket) => socket !== null,
    );
    if (!first) throw new Error("listener missing");
    cleanups.push(() => {
      first.destroy();
    });
    const second = await dial(Number(fixture.env.RELAY_PORT));
    if (!second) throw new Error("second connection failed");
    cleanups.push(() => {
      second.destroy();
    });
    expect(await readFile(fixture.copy, "utf8")).toBe(await readFile(relayPath, "utf8"));
    const calls = (await readFile(fixture.calls, "utf8")).trim().split("\n");
    expect(calls).toEqual([
      "exec",
      "-i",
      "--user",
      "node",
      "fixture-only",
      "sh",
      "-c",
      "cat > /tmp/orkestrator-qa-agent-tools-relay.ts",
      "exec",
      "-i",
      "--user",
      "node",
      "fixture-only",
      "bun",
      "/tmp/orkestrator-qa-agent-tools-relay.ts",
      "container",
      "--port",
      String(backend.port),
      "--listen",
      "127.0.0.1",
    ]);
    async function exchange(socket: Socket, payload: Buffer) {
      const chunks: Buffer[] = [];
      let length = 0;
      const received = new Promise<Buffer>((resolve, reject) => {
        socket.on("error", reject);
        socket.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          length += chunk.length;
          if (length >= payload.length) resolve(Buffer.concat(chunks));
        });
        socket.once("close", () => {
          if (length < payload.length) reject(new Error("early close"));
        });
      });
      socket.write(payload);
      expect(await received).toEqual(payload);
    }
    await Promise.all([
      exchange(first, Buffer.from(Array.from({ length: 150_000 }, (_, i) => i % 251))),
      exchange(second, Buffer.from("independent connection")),
    ]);
    const closed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.end();
    await closed;
    const containerPid = Number(await readFile(fixture.pid, "utf8"));
    run.child.kill("SIGTERM");
    expect(await run.child.exited).toBe(0);
    await eventually(() => {
      try {
        process.kill(containerPid, 0);
        return false;
      } catch {
        return true;
      }
    }, Boolean);
    expect(await run.stdout).toBe("");
    expect(await run.stderr).toBe("");
  }, 15_000);

  test("a failed docker copy refuses launch", async () => {
    const fixture = await dockerStandIn(true);
    const run = launch(["host", "--container", "fixture-only", "--port", "12345"], fixture.env);
    expect(await run.child.exited).not.toBe(0);
    expect(await run.stderr).toContain("could not copy the relay into the container");
    expect((await readFile(fixture.calls, "utf8")).match(/^exec$/gm)).toHaveLength(1);
  });

  test("container exits on stdin EOF and releases its listener", async () => {
    const port = unusedPort();
    const run = launch(["container", "--port", String(port), "--listen", "127.0.0.1"]);
    const socket = await eventually(
      () => dial(port),
      (value) => value !== null,
    );
    if (!socket) throw new Error("listener missing");
    cleanups.push(() => {
      socket.destroy();
    });
    run.child.stdin.end();
    expect(await run.child.exited).toBe(0);
    expect(await dial(port)).toBeNull();
    expect(await run.stderr).toBe("");
  });

  test("host propagates a container process failure after stdout EOF", async () => {
    const fixture = await dockerStandIn();
    const run = launch(["host", "--container", "fixture-only", "--port", "12345"], {
      ...fixture.env,
      RELAY_EXIT: "37",
    });
    expect(await run.child.exited).toBe(37);
    expect(await run.stdout).toBe("");
    expect(await run.stderr).toBe("");
  });
});
