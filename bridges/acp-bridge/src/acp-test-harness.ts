/**
 * Shared fixture harness for the `acp-*.test.ts` suites,
 * split out of `index.test.ts` on 2026-08-16.
 *
 * All 9 suites in the group need this same preamble. Duplicating it per file
 * left 9 copies to keep in sync, which is what CLAUDE.md > "Bun
 * `mock.module()` Rules" warns against, so it lives here and the suites import
 * what they use.
 *
 * Importing this module also registers the group's shared hooks, so it must be
 * imported before anything that depends on them. It is named `.ts`, not
 * `.test.ts`, so the runner does not collect it as a suite.
 *
 * This assumes `bun test --parallel` (which implies `--isolate`), the mode
 * AGENTS.md mandates: each test file gets a fresh module registry, so this
 * module is evaluated once per file exactly as the duplicated preambles were.
 */
import { afterEach, describe, expect, jest, test } from "bun:test";


import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";


import { createServer } from "node:net";


import { promises as fs } from "node:fs";


import os from "node:os";


import { dirname, resolve } from "node:path";


import { fileURLToPath, pathToFileURL } from "node:url";



export const here = dirname(fileURLToPath(import.meta.url));


// The repository-wide test preload installs a browser-like fetch for UI tests.
// Use Bun's native client for loopback bridge integration requests so browser
// CORS rules cannot turn these GETs into preflight requests.
export const nativeFetch = Bun.fetch;


export const children = new Set<ChildProcessWithoutNullStreams>();


export const temporaryDirectories = new Set<string>();


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
export const BRIDGE_TEST_TIMEOUT_MS = 30_000;


jest.setTimeout(BRIDGE_TEST_TIMEOUT_MS);


/** Smallest valid PNG, so attachment tests exercise real image bytes. */
export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);



afterEach(async () => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
  await Promise.all([...temporaryDirectories].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});



export async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(resolve(os.tmpdir(), "acp-bridge-test-"));
  temporaryDirectories.add(directory);
  return directory;
}



export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve test port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}



export const MAX_WAIT_DIAGNOSTIC_BYTES = 4 * 1024;



/**
 * Bounds the timeout diagnostic. Several suites deliberately drive a transcript
 * to the megabyte-scale `ACP_MAX_TRANSCRIPT_BYTES` floor, and serializing the
 * whole snapshot into a failure message writes that much agent text and tool
 * arguments into the saved test log for every timeout.
 */
export function describeWaitValue(value: unknown): string {
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



export function isRetryableWaitError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ConnectionRefused" || error.code === "ECONNREFUSED";
}



/**
 * Deliberately below {@link BRIDGE_TEST_TIMEOUT_MS}. A wait that could outlast
 * the per-test budget loses the race to Bun's generic "test timed out", and the
 * bounded diagnostic below — the whole reason this helper exists — never prints.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

/**
 * Starting a fresh bridge is a process-readiness boundary, not an ordinary
 * state poll. Aggregate runs start many Bun children at once, so keep startup's
 * contention budget separate from the tighter product-state diagnostic above.
 */
export const BRIDGE_STARTUP_TIMEOUT_MS = 15_000;



export async function waitFor<T>(
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



export function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}



export async function spawnBridge(options: {
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
    BRIDGE_STARTUP_TIMEOUT_MS,
  );
  return {
    child,
    base,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}



export async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  child.kill("SIGTERM");
  await exited;
  children.delete(child);
}



export async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}
