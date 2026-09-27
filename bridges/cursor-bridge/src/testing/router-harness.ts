/**
 * Shared fixture for the lifecycle and durability suites.
 *
 * The real router on an ephemeral port, a private state directory per test, and
 * the narrow seams those suites need to hold an attach, a send or a state-file
 * write at an exact point. Everything else — serialization, the write queue,
 * the journals, the routes — is the production code.
 */
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKAgent } from "@cursor/sdk";
import { setCursorMcpFingerprintForTests, useCursorAgentForTests } from "../agent-session.js";
import { authToken } from "../config.js";
import { route } from "../http.js";
import {
  drainPersistence,
  reopenPersistenceForTests,
  usePersistenceFsForTests,
} from "../persistence.js";
import { useCursorCredentialRuntimeForTests } from "../credentials.js";
import { useCursorModelsForTests } from "../models.js";
import { resetPlanAccountWindowsForTests } from "../plan-usage.js";
import { useCursorSdkRuntimeForTests } from "../sdk-runtime.js";
import { clientSessionKeys, closingTombstones, sessions, type SessionState } from "../state.js";

export const defaultPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
} as const;

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the bridge to settle");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export interface RouterHarness {
  stateRoot: string;
  stateFile: string;
  call(path: string, init?: RequestInit): Promise<Response>;
  createSession(body?: Record<string, unknown>): Promise<SessionState>;
  /** The published state file as a fresh process would read it — no drain. */
  readPublished(): Promise<Record<string, unknown> | undefined>;
  /** Requests the router has received and not yet started answering. */
  unanswered(): number;
  close(): Promise<void>;
}

/**
 * Start a router over a private state directory.
 *
 * The previous value of every environment key it sets is restored exactly,
 * absence included, by `close()`.
 */
export async function startRouterHarness(
  options: { stateless?: boolean } = {},
): Promise<RouterHarness> {
  sessions.clear();
  clientSessionKeys.clear();
  closingTombstones.clear();
  reopenPersistenceForTests();
  // No account, catalogue or credential read may leave the process.
  resetPlanAccountWindowsForTests();
  const restoreModels = useCursorModelsForTests({
    list: async () => [],
  } as unknown as typeof import("@cursor/sdk").Cursor.models);
  const restoreCredentials = useCursorCredentialRuntimeForTests({
    store: {
      load: async () => undefined,
      save: async () => undefined,
      clear: async () => undefined,
    },
    auth: { login: async () => undefined, logout: async () => undefined } as never,
  });
  const previousStateDir = process.env.CURSOR_BRIDGE_STATE_DIR;
  const stateRoot = await mkdtemp(join(tmpdir(), "cursor-bridge-lifecycle-"));
  if (options.stateless) delete process.env.CURSOR_BRIDGE_STATE_DIR;
  else process.env.CURSOR_BRIDGE_STATE_DIR = stateRoot;
  const stateFile = join(stateRoot, "state.json");

  const inFlight = new Set<import("node:http").ServerResponse>();
  const server: Server = createServer((request, response) => {
    inFlight.add(response);
    response.once("close", () => inFlight.delete(response));
    void route(request, response, new AbortController().signal);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  // The repository preload installs a browser-like fetch that applies CORS to
  // loopback requests; Bun's native client is the escape hatch.
  const call = (path: string, init: RequestInit = {}) =>
    Bun.fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  return {
    stateRoot,
    stateFile,
    call,
    async createSession(body = {}) {
      const response = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({ policy: defaultPolicy, ...body }),
      });
      if (response.status !== 201) throw new Error(`create answered ${response.status}`);
      const payload = (await response.json()) as { sessionId: string };
      return sessions.get(payload.sessionId)!;
    },
    unanswered() {
      let count = 0;
      for (const response of inFlight) if (!response.headersSent) count += 1;
      return count;
    },
    async readPublished() {
      const raw = await readFile(stateFile, "utf8").catch(() => undefined);
      return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Let any queued write finish before the directory goes, then re-open
      // admission for the next test in this file.
      await drainPersistence();
      reopenPersistenceForTests();
      sessions.clear();
      clientSessionKeys.clear();
      closingTombstones.clear();
      restoreModels();
      restoreCredentials();
      if (previousStateDir === undefined) delete process.env.CURSOR_BRIDGE_STATE_DIR;
      else process.env.CURSOR_BRIDGE_STATE_DIR = previousStateDir;
      await rm(stateRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Hold the next state-file publication just before its rename.
 *
 * `renames` counts publications that completed. `release` lets the held one
 * through; `fail` makes it (and later ones, until restored) reject.
 */
export function holdPublication(): {
  held: Promise<void>;
  release: () => void;
  failWith: (error: Error | undefined) => void;
  /** Let the temporary write succeed and fail only the rename after it. */
  failRenameWith: (error: Error | undefined) => void;
  renames: () => number;
  /** Rename calls that were reached, successful or not. */
  renameAttempts: () => number;
  writes: () => number;
  maxConcurrentWrites: () => number;
  restore: () => void;
} {
  const reached = deferred();
  let gate: Deferred | undefined = deferred();
  let failure: Error | undefined;
  let renameFailure: Error | undefined;
  let renames = 0;
  let renameAttempts = 0;
  let writes = 0;
  let active = 0;
  let maxActive = 0;
  const restore = usePersistenceFsForTests({
    writeFile: (async (...args: Parameters<typeof import("node:fs/promises").writeFile>) => {
      writes += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(...args);
        if (gate) {
          reached.resolve();
          await gate.promise;
        }
        if (failure) throw failure;
      } finally {
        active -= 1;
      }
    }) as typeof import("node:fs/promises").writeFile,
    rename: (async (...args: Parameters<typeof import("node:fs/promises").rename>) => {
      renameAttempts += 1;
      if (failure) throw failure;
      if (renameFailure) throw renameFailure;
      const { rename } = await import("node:fs/promises");
      await rename(...args);
      renames += 1;
    }) as typeof import("node:fs/promises").rename,
  });
  return {
    held: reached.promise,
    release() {
      const current = gate;
      gate = undefined;
      current?.resolve();
    },
    failWith(error) {
      failure = error;
    },
    failRenameWith(error) {
      renameFailure = error;
    },
    renames: () => renames,
    renameAttempts: () => renameAttempts,
    writes: () => writes,
    maxConcurrentWrites: () => maxActive,
    restore() {
      const current = gate;
      gate = undefined;
      current?.resolve();
      restore();
    },
  };
}

/**
 * Route `ensureAgent` through fake SDK create/resume calls a test can hold.
 *
 * Each call waits on the returned gate (when set) and resolves to the agent
 * the test supplied, so a close can be made to race the exact moment an
 * attach completes.
 */
export function stubAttach(options: {
  create?: () => Promise<SDKAgent>;
  resume?: (agentId: string) => Promise<SDKAgent>;
}): () => void {
  const previousApiKey = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "lifecycle-test-key";
  resetPlanAccountWindowsForTests();
  setCursorMcpFingerprintForTests(async () => "fixed");
  const restoreRuntime = useCursorSdkRuntimeForTests({
    configureStore: () => undefined,
    createPlatform: (async () => ({
      prewarmLocalWorkspace: async () => async () => undefined,
    })) as unknown as typeof import("@cursor/sdk").createAgentPlatform,
  });
  const restoreAgent = useCursorAgentForTests({
    create: async () => {
      if (!options.create) throw new Error("this test does not create agents");
      return options.create();
    },
    resume: async (agentId: string) => {
      if (!options.resume) throw new Error("this test does not resume agents");
      return options.resume(agentId);
    },
    listRuns: async () => ({ items: [] }),
  } as unknown as Parameters<typeof useCursorAgentForTests>[0]);
  return () => {
    restoreAgent();
    restoreRuntime();
    setCursorMcpFingerprintForTests();
    if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousApiKey;
  };
}
