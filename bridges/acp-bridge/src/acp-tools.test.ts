import { afterEach, describe, expect, jest, test } from "bun:test";


import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";


import { createServer } from "node:net";


import { promises as fs } from "node:fs";


import os from "node:os";


import { dirname, resolve } from "node:path";


import { fileURLToPath, pathToFileURL } from "node:url";



const here = dirname(fileURLToPath(import.meta.url));


// The repository-wide test preload installs a browser-like fetch for UI tests.
// Use Bun's native client for loopback bridge integration requests so browser
// CORS rules cannot turn these GETs into preflight requests.
const nativeFetch = Bun.fetch;


const children = new Set<ChildProcessWithoutNullStreams>();


const temporaryDirectories = new Set<string>();


/**
 * Bun's 5 s default per-test budget is smaller than what these tests actually
 * do. `spawnBridge` alone may spend up to `DEFAULT_WAIT_TIMEOUT_MS` waiting on
 * the child's health endpoint before a test body starts, and nearly every body
 * then polls with one or more further `waitFor` calls. Under aggregate-suite
 * spawn contention the health wait consumed the whole budget, which is the
 * flake recorded in `docs/flaky-tests.md`. Raise it once for the file rather
 * than per test, so the next case to hit that contention does not need its own
 * one-off timeout to be discovered first.
 */
const BRIDGE_TEST_TIMEOUT_MS = 20_000;


jest.setTimeout(BRIDGE_TEST_TIMEOUT_MS);


/** Smallest valid PNG, so attachment tests exercise real image bytes. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);



afterEach(async () => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
  await Promise.all([...temporaryDirectories].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});



async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(resolve(os.tmpdir(), "acp-bridge-test-"));
  temporaryDirectories.add(directory);
  return directory;
}



async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve test port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}



const MAX_WAIT_DIAGNOSTIC_BYTES = 4 * 1024;



/**
 * Bounds the timeout diagnostic. Several suites deliberately drive a transcript
 * to the megabyte-scale `ACP_MAX_TRANSCRIPT_BYTES` floor, and serializing the
 * whole snapshot into a failure message writes that much agent text and tool
 * arguments into the saved test log for every timeout.
 */
function describeWaitValue(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    return "<unserializable>";
  }
  return serialized.length <= MAX_WAIT_DIAGNOSTIC_BYTES
    ? serialized
    : `${serialized.slice(0, MAX_WAIT_DIAGNOSTIC_BYTES)}… (${serialized.length} chars, truncated)`;
}



function isRetryableWaitError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ConnectionRefused" || error.code === "ECONNREFUSED";
}



/**
 * Deliberately below {@link BRIDGE_TEST_TIMEOUT_MS}. A wait that could outlast
 * the per-test budget loses the race to Bun's generic "test timed out", and the
 * bounded diagnostic below — the whole reason this helper exists — never prints.
 */
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;



async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  let lastRetryableCode: string | undefined;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (accept(latest)) return latest;
    } catch (error) {
      // The bridge child can still be binding, or Bun may already have killed it
      // after a test timeout. Retry until the deadline so a refused connection
      // becomes a bounded wait diagnostic instead of an unhandled rejection.
      if (!isRetryableWaitError(error)) throw error;
      lastRetryableCode = String((error as { code: unknown }).code);
    }
    await Bun.sleep(20);
  }
  // Report the swallowed code as well. When every read was refused `latest` was
  // never assigned, so without this the message is a bare `undefined` — which is
  // exactly the case where the retried error is the only useful evidence.
  const cause = lastRetryableCode ? ` (last error: ${lastRetryableCode})` : "";
  throw new Error(`Timed out waiting for ACP state: ${describeWaitValue(latest)}${cause}`);
}



function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}



async function spawnBridge(options: {
  port?: number;
  token?: string;
  stateDirectory?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ child: ChildProcessWithoutNullStreams; base: string; headers: Record<string, string> }> {
  const port = options.port ?? await unusedPort();
  const token = options.token ?? "integration-test-token";
  // A live Orkestrator process exports ACP_STATE_DIR. Inheriting it would
  // restore that environment's sessions into this test bridge, so a
  // MAX_SESSIONS=1 rollback test 429s before it can fail closed, and
  // /global/models merges the fixture catalogue with whatever was persisted.
  const stateDirectory = options.stateDirectory ?? await temporaryDirectory();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ACP_PROVIDER: "cursor",
    ACP_AGENT_PATH: resolve(here, "testing/fake-agent.ts"),
    ACP_BRIDGE_TOKEN: token,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    ACP_STATE_DIR: stateDirectory,
  };
  delete env.ACP_MAX_SESSIONS;
  Object.assign(env, options.env);
  // The child inherits this process's environment, so a test that pins a
  // fail-closed default has to prove the variable is genuinely absent rather
  // than merely unmentioned. An explicit `undefined` in `options.env` deletes
  // it instead of leaking whatever the developer's or CI shell exported.
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(process.execPath, [resolve(here, "index.ts")], {
    cwd: resolve(here, "../../.."),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => nativeFetch(`${base}/global/health`).then((response) => response.ok).catch(() => false),
    Boolean,
  );
  return {
    child,
    base,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}



async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  child.kill("SIGTERM");
  await exited;
  children.delete(child);
}



async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}



describe("waitFor", () => {
  test("retries ConnectionRefused until the read succeeds", async () => {
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts < 3) throw codedError("ConnectionRefused");
      return { ready: true };
    }, (current) => current.ready);
    expect(value).toEqual({ ready: true });
    expect(attempts).toBe(3);
  });

  test("retries ECONNREFUSED until the read succeeds", async () => {
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts < 2) throw codedError("ECONNREFUSED");
      return "up";
    }, (current) => current === "up");
    expect(value).toBe("up");
    expect(attempts).toBe(2);
  });

  test("retries a real Bun fetch connection failure until the read succeeds", async () => {
    const port = await unusedPort();
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts >= 3) return "recovered";
      // `unusedPort` releases the port before returning, so a parallel worker
      // could in principle bind it between then and now. Convert that into an
      // explicit non-retryable error, which `waitFor` rethrows on the spot and
      // names, instead of letting it surface as a bare `expect(1).toBe(3)`.
      // Reaching attempt 3 therefore also proves Bun's own error shape is what
      // `isRetryableWaitError` classifies as retryable.
      throw await nativeFetch(`http://127.0.0.1:${port}/health`).then(
        () => new Error(`Expected 127.0.0.1:${port} to refuse the connection, but it answered`),
        (reason: unknown) => reason,
      );
    }, (current) => current === "recovered");
    expect(value).toBe("recovered");
    expect(attempts).toBe(3);
  });

  test("polls until accept is satisfied and returns the accepted value", async () => {
    let reads = 0;
    const value = await waitFor(async () => {
      reads += 1;
      return { status: reads < 3 ? "running" : "idle" };
    }, (current) => current.status === "idle");
    expect(value).toEqual({ status: "idle" });
    expect(reads).toBe(3);
  });

  test("rethrows a non-retryable coded error on the first attempt", async () => {
    const error = codedError("EPERM");
    let attempts = 0;
    await expect(waitFor(async () => {
      attempts += 1;
      throw error;
    }, () => true)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("rethrows errors that have no code on the first attempt", async () => {
    const error = new Error("parse failed");
    let attempts = 0;
    await expect(waitFor(async () => {
      attempts += 1;
      throw error;
    }, () => true)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("rethrows non-object rejections on the first attempt", async () => {
    // `isRetryableWaitError` reads `error.code`, so a bare string that merely
    // *names* a retryable code — and a nullish rejection — must fail fast
    // rather than spin until the deadline.
    for (const rejection of ["ConnectionRefused", null]) {
      let attempts = 0;
      await expect(waitFor(async () => {
        attempts += 1;
        throw rejection;
      }, () => true)).rejects.toBe(rejection);
      expect(attempts).toBe(1);
    }
  });

  test("times out when ConnectionRefused never recovers and names the code", async () => {
    let attempts = 0;
    // 400 ms rather than a value just above the 20 ms poll interval: the
    // assertion below is about retrying, and one scheduler stall on a loaded
    // parallel run must not be able to consume the budget before attempt two.
    await expect(waitFor(async () => {
      attempts += 1;
      throw codedError("ConnectionRefused");
    }, () => true, 400)).rejects.toThrow(
      "Timed out waiting for ACP state: undefined (last error: ConnectionRefused)",
    );
    expect(attempts).toBeGreaterThan(1);
  });

  test("reports the last read value when accept is never satisfied", async () => {
    await expect(waitFor(
      async () => ({ status: "running" }),
      (current) => current.status === "idle",
      200,
    )).rejects.toThrow('Timed out waiting for ACP state: {"status":"running"}');
  });

  test("truncates an oversized diagnostic instead of logging the whole snapshot", async () => {
    const oversized = "x".repeat(MAX_WAIT_DIAGNOSTIC_BYTES * 2);
    const rejection = await waitFor(async () => oversized, () => false, 200)
      .then(() => null, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    const { message } = rejection as Error;
    expect(message).toContain("chars, truncated)");
    expect(message.length).toBeLessThan(oversized.length);
  });
});
