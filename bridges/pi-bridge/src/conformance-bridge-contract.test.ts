/**
 * The shared bridge HTTP contract (`tests/conformance/bridge-contract`) over
 * the Pi bridge.
 *
 * The real router on an ephemeral loopback port, with a private state
 * directory per scenario. The Pi SDK is never reached: create is lazy (no
 * AgentSession is attached), composer hydration is the identity through the
 * bridge's own test hook, and storage failures are injected at the
 * persistence write gate. Environment is snapshotted and restored exactly,
 * absence included.
 */
import { afterAll } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBridgeContractSuite,
  type BridgeContractHandle,
} from "../../../tests/conformance/bridge-contract/scenarios.js";

const ENV_KEYS = [
  "PORT",
  "HOSTNAME",
  "PI_BRIDGE_TOKEN",
  "PI_BRIDGE_LIBRARY_ONLY",
  "PI_BRIDGE_STATE_DIR",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

// `config.ts` reads its environment once, at import, so the bridge is loaded
// dynamically after the environment is in place.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "pi-conformance-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { json, route } = await import("./http.js");
const { authToken } = await import("./config.js");
const { newSessionState, setAgentSessionTestHooks } = await import("./agent-session.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { drainPersistence, loadPersistedState, setPersistWriteGateForTests } =
  await import("./persistence.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

afterAll(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

runBridgeContractSuite({
  bridge: "pi",
  async start(): Promise<BridgeContractHandle> {
    sessions.clear();
    clientSessionKeys.clear();
    const stateDirectory = await mkdtemp(join(tmpdir(), "pi-conformance-"));
    process.env.PI_BRIDGE_STATE_DIR = stateDirectory;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });

    // The same wrapper `server.ts` puts around `route`, without its sweeps,
    // parent watchdog or signal handlers.
    const server = createServer((request, response) => {
      void route(request, response, new AbortController().signal).catch(() => {
        if (response.headersSent) response.end();
        else json(response, 500, { error: "Internal bridge error" });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const request: BridgeContractHandle["request"] = async (method, path, body) => {
      const response = await nativeFetch(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await parse(response) };
    };

    return {
      request,
      async createSession(options = {}) {
        const created = await request("POST", "/session/create", options);
        if (created.status !== 201) throw new Error(`create answered ${created.status}`);
        return (created.body as { sessionId: string }).sessionId;
      },
      promptBody: (requestId) => ({ prompt: "conformance prompt", requestId }),
      async failCloses() {
        setPersistWriteGateForTests(async () => {
          throw new Error("conformance: publication refused");
        });
        return async () => setPersistWriteGateForTests();
      },
      async seedRetainedTail() {
        const state = newSessionState();
        state.droppedMessages = 2;
        state.messages = [2, 3, 4].map((index) => ({
          id: `m${index}`,
          role: "user" as const,
          content: `message ${index}`,
          parts: [],
          createdAt: `2026-01-01T00:00:0${index}Z`,
        }));
        sessions.set(state.id, state);
        return state.id;
      },
      async restartFromPublishedState() {
        sessions.clear();
        clientSessionKeys.clear();
        await loadPersistedState();
      },
      async stop() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        setPersistWriteGateForTests();
        await drainPersistence().catch(() => undefined);
        sessions.clear();
        clientSessionKeys.clear();
        setAgentSessionTestHooks(undefined);
        delete process.env.PI_BRIDGE_STATE_DIR;
        await rm(stateDirectory, { recursive: true, force: true });
      },
    };
  },
});
