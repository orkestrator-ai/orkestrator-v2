/**
 * The shared bridge HTTP contract (`tests/conformance/bridge-contract`) over
 * the ACP bridge (Grok).
 *
 * A spawned bridge process per scenario — the real entrypoint, router and
 * state file — with a private state directory, port and token
 * (`spawnBridge`). The vendor is `testing/fake-agent-close.ts`, a small ACP
 * agent speaking the real stdio protocol, so the engine boundary is the only
 * thing faked. A restart is a SIGKILL and a successor over the same
 * directory: the successor reads only what was published, never a drain.
 *
 * The retained-tail transcript is seeded the same way a restart would see it,
 * by writing the published state file before the bridge starts: an eviction
 * base cannot be reached through the fake agent without megabytes of
 * transcript.
 */
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import {
  runBridgeContractSuite,
  unseenId,
  type BridgeContractHandle,
} from "../../../tests/conformance/bridge-contract/scenarios.js";
import {
  BRIDGE_TEST_TIMEOUT_MS,
  here,
  nativeFetch,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitForExit,
} from "./acp-test-harness.js";

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

runBridgeContractSuite(
  {
    bridge: "acp",
    async start(): Promise<BridgeContractHandle> {
      const directory = await temporaryDirectory();
      const stateDirectory = resolve(directory, "state");
      const stateFile = join(stateDirectory, "state.json");
      await fs.mkdir(stateDirectory, { recursive: true });
      const launch = () =>
        spawnBridge({
          stateDirectory,
          env: {
            ACP_PROVIDER: "grok",
            ACP_AGENT_PATH: resolve(here, "testing/fake-agent-close.ts"),
            FAKE_CLOSE_STORE: resolve(directory, "store.jsonl"),
          },
        });
      let bridge = await launch();

      const request: BridgeContractHandle["request"] = async (method, path, body) => {
        const response = await nativeFetch(`${bridge.base}${path}`, {
          method,
          headers: bridge.headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await parse(response) };
      };

      return {
        request,
        async createSession(options = {}) {
          const created = await request("POST", "/session/create", options);
          if (created.status !== 201) throw new Error(`create answered ${created.status}`);
          return String((created.body as { id: string }).id);
        },
        promptBody: (requestId) => ({ prompt: "conformance prompt", requestId }),
        async failCloses() {
          // A directory where the state file belongs makes the atomic rename
          // fail, so the close cannot publish the session's removal.
          await fs.rm(stateFile, { force: true });
          await fs.mkdir(stateFile);
          await fs.writeFile(join(stateFile, "occupied"), "");
          return async () => {
            await fs.rm(stateFile, { recursive: true, force: true });
          };
        },
        async seedRetainedTail() {
          await stopChild(bridge.child);
          const id = unseenId("acp-retained-tail");
          await fs.writeFile(
            stateFile,
            JSON.stringify({
              version: 3,
              provider: "grok",
              sessions: [
                {
                  id,
                  acpSessionId: `${id}-vendor`,
                  status: "idle",
                  revision: 1,
                  droppedMessages: 2,
                  structured: [],
                  promptJournal: [],
                  messages: [2, 3, 4].map((index) => ({
                    id: `m${index}`,
                    role: "user",
                    content: `message ${index}`,
                    parts: [],
                    createdAt: `2026-01-01T00:00:0${index}Z`,
                  })),
                },
              ],
            }),
          );
          bridge = await launch();
          return id;
        },
        async restartFromPublishedState() {
          // No graceful shutdown: SIGTERM would drain the persistence tail.
          bridge.child.kill("SIGKILL");
          await waitForExit(bridge.child);
          await stopChild(bridge.child);
          bridge = await launch();
        },
        async stop() {
          await stopChild(bridge.child);
        },
      };
    },
  },
  { timeoutMs: BRIDGE_TEST_TIMEOUT_MS },
);
