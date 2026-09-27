/**
 * The shared bridge HTTP contract (`tests/conformance/bridge-contract`) over
 * the Claude bridge.
 *
 * The bridge's real composition root (`index.ts` → `app.route("/session",
 * session)`) and the real session manager, with only the Claude SDK and
 * filesystem edges mocked by the shared session-manager harness, which also
 * gives this file a private Claude home. No scenario starts a turn. A close
 * that cannot confirm stop is injected at the session's query control — the
 * engine boundary a real close has to prove stopped.
 */
import { afterAll } from "bun:test";
import {
  runBridgeContractSuite,
  type BridgeContractHandle,
} from "../../../tests/conformance/bridge-contract/scenarios.js";
import { getSession, track } from "./services/session-manager-test-harness.js";

const envKeys = ["CLAUDE_BRIDGE_NO_SERVER", "CLAUDE_BRIDGE_AUTH_DISABLED_FOR_TESTING"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
// The bridge skips `serve()` and its token check only under both flags.
for (const key of envKeys) process.env[key] = "1";
const { app } = await import("./index.js");

afterAll(() => {
  for (const key of envKeys) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
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

const request: BridgeContractHandle["request"] = async (method, path, body) => {
  const response = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await parse(response) };
};

runBridgeContractSuite({
  bridge: "claude",
  async start(): Promise<BridgeContractHandle> {
    return {
      request,
      async createSession(options = {}) {
        const created = await request("POST", "/session/create", options);
        if (created.status !== 201) throw new Error(`create answered ${created.status}`);
        // The harness's `afterEach` releases whatever a scenario left behind.
        return track((created.body as { sessionId: string }).sessionId);
      },
      promptBody: (requestId) => ({ prompt: "conformance prompt", requestId }),
      async failCloses(sessionId) {
        const state = getSession(sessionId);
        if (!state) throw new Error("failCloses: the session is not registered");
        let refuse = true;
        state.queryControl = {
          close: () => {
            if (refuse) throw new Error("conformance: query close refused");
          },
        };
        return async () => {
          refuse = false;
        };
      },
      async stop() {},
    };
  },
});
