/**
 * The shared bridge HTTP contract (`tests/conformance/bridge-contract`) over
 * the Codex bridge.
 *
 * The production Hono `app` from `index.ts`, behind its real authentication
 * middleware, with the app-server engine disabled (`CODEX_BRIDGE_NO_ENGINE`):
 * nothing here needs a Codex thread, and no scenario may reach one. Sessions
 * are created through the real route; a close that cannot publish its removal
 * is injected at the bridge-session store. `CODEX_HOME` is a private
 * directory, so a close tombstone never lands in the developer's `~/.codex`.
 */
import { afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompressionStream as NodeCompressionStream } from "node:stream/web";
import {
  runBridgeContractSuite,
  type BridgeContractHandle,
} from "../../../tests/conformance/bridge-contract/scenarios.js";
import { BridgeSessionStore } from "./sessions/persistence.js";

const AUTH_TOKEN = "codex-conformance-token";
const codexHome = mkdtempSync(join(tmpdir(), "ork-codex-conformance-"));
const previousEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_BRIDGE_TOKEN: process.env.CODEX_BRIDGE_TOKEN,
  CODEX_BRIDGE_NO_ENGINE: process.env.CODEX_BRIDGE_NO_ENGINE,
  CODEX_BRIDGE_NO_SERVER: process.env.CODEX_BRIDGE_NO_SERVER,
  CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING: process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING,
};
process.env.CODEX_HOME = codexHome;
process.env.CODEX_BRIDGE_TOKEN = AUTH_TOKEN;
process.env.CODEX_BRIDGE_NO_ENGINE = "1";
process.env.CODEX_BRIDGE_NO_SERVER = "1";
delete process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING;

// The UI-test preload replaces browser globals before the bridge module is
// evaluated. Hono captures this constructor while installing its middleware.
const originalCompressionStream = globalThis.CompressionStream;
globalThis.CompressionStream = NodeCompressionStream as typeof CompressionStream;
const { app } = await import("./index.js");

afterAll(() => {
  globalThis.CompressionStream = originalCompressionStream;
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(codexHome, { recursive: true, force: true });
});

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const request: BridgeContractHandle["request"] = async (method, path, body) => {
  const response = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await parse(response) };
};

runBridgeContractSuite({
  bridge: "codex",
  async start(): Promise<BridgeContractHandle> {
    const restores: Array<() => void> = [];
    return {
      request,
      async createSession(options = {}) {
        const created = await request("POST", "/session/create", { mode: "build", ...options });
        if (created.status !== 201) throw new Error(`create answered ${created.status}`);
        return (created.body as { sessionId: string }).sessionId;
      },
      promptBody: (requestId) => ({ prompt: "conformance prompt", requestId }),
      async failCloses() {
        const publish = spyOn(BridgeSessionStore.prototype, "publishRemoval").mockImplementation(
          () => Promise.reject(new Error("conformance: publication refused")),
        );
        const restore = () => publish.mockRestore();
        restores.push(restore);
        return async () => restore();
      },
      async stop() {
        for (const restore of restores.splice(0)) restore();
      },
    };
  },
});
