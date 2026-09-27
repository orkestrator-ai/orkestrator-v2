/**
 * The shared bridge HTTP contract (`tests/conformance/bridge-contract`) over
 * the Cursor bridge.
 *
 * The real router on an ephemeral port with a private state directory per
 * scenario (`testing/router-harness.ts`). The Cursor SDK is never reached:
 * sessions are created lazily and nothing here prompts a live agent. Storage
 * failures are injected at the persistence fs seam, and the bounded steer
 * journal is driven through the real steer route against a stand-in run.
 */
import {
  runBridgeContractSuite,
  type BoundedOccupancy,
  type BridgeContractHandle,
} from "../../../tests/conformance/bridge-contract/scenarios.js";
import { newSessionState } from "./agent-session.js";
import { loadPersistedState } from "./persistence.js";
import { clientSessionKeys, closingTombstones, sessions, type SessionState } from "./state.js";
import { DEFAULT_STEER_JOURNAL_LIMITS } from "./steer-journal.js";
import { holdPublication, startRouterHarness } from "./testing/router-harness.js";

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

runBridgeContractSuite({
  bridge: "cursor",
  async start(): Promise<BridgeContractHandle> {
    const harness = await startRouterHarness();
    return {
      async request(method, path, body) {
        const response = await harness.call(path, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await parse(response) };
      },
      async createSession(options = {}) {
        return (await harness.createSession(options)).id;
      },
      promptBody: (requestId) => ({ prompt: "conformance prompt", requestId }),
      async failCloses() {
        const hold = holdPublication();
        hold.failWith(new Error("conformance: publication refused"));
        hold.release();
        return async () => {
          hold.failWith(undefined);
          hold.restore();
        };
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
        closingTombstones.clear();
        await loadPersistedState();
      },
      async saturateBoundedState(sessionId) {
        const state = sessions.get(sessionId)!;
        // A stand-in for an attached run that accepts every steer: the journal,
        // its admission and the route are the production code.
        state.status = "running";
        state.activeRun = {
          id: "conformance-run",
          supports: (feature: string) => feature === "stream",
          steer: async () => "complete_delivered",
        } as unknown as SessionState["activeRun"];
        const steer = (requestId: string) =>
          harness.call(`/session/${sessionId}/steer`, {
            method: "POST",
            body: JSON.stringify({
              input: "conformance steer",
              requestId,
              expectedRunId: "conformance-run",
            }),
          });
        for (let index = 0; index < DEFAULT_STEER_JOURNAL_LIMITS.entries; index += 1) {
          const accepted = await steer(`steer-${index}`);
          if (accepted.status !== 202) throw new Error(`steer answered ${accepted.status}`);
        }
        const refused = await steer("steer-over-limit");
        if (refused.status !== 429) throw new Error(`over-limit steer answered ${refused.status}`);
        // Left running: saturation is about records the live run still
        // protects. `stop()` discards the registry, so nothing outlives this.
      },
      boundedOccupancy(runtimeHealth) {
        const steer = (runtimeHealth as { summary?: { steer?: BoundedOccupancy } }).summary?.steer;
        return steer ? [steer] : [];
      },
      stop: () => harness.close(),
    };
  },
});
