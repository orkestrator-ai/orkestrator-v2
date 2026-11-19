/**
 * The shared provider-replay suite (`tests/conformance/provider-replay`) over
 * the Cursor bridge.
 *
 * The real router (`startRouterHarness`), the real prompt route and the real
 * run follower; the attached `SDKAgent` is a stand-in. Each fixture frame is a
 * Cursor `InteractionUpdate`, delivered through the `onDelta` callback the
 * bridge handed to `agent.send`, which is `applyInteractionUpdate` in
 * production. The run's `wait()` settles on the fixture's `end` action (with
 * its `status`, `result` or `error`) or when the bridge cancels it.
 *
 * Actions: `prompt` (`text`), `interrupt`, `end` (`status` finished | error |
 * cancelled, `result`, `error`), `restart` (a successor process loads the
 * published state; a fresh stand-in agent is attached to the restored
 * session, as a resume would).
 */
import { join } from "node:path";
import type { SDKAgent } from "@cursor/sdk";
import { runProviderReplaySuite } from "../../../tests/conformance/provider-replay/scenarios.js";
import { mcpConnectionKey } from "./mcp.js";
import { drainPersistence, loadPersistedState, reopenPersistenceForTests } from "./persistence.js";
import { publicActivity } from "./public.js";
import { clientSessionKeys, closingTombstones, sessions, type SessionState } from "./state.js";
import { startRouterHarness, waitFor, type RouterHarness } from "./testing/router-harness.js";
import { cursorTranscriptSource } from "./transcript-source.js";

interface ReplayRun {
  deliver(update: unknown): void;
  settle(outcome: { status: string; result?: string; error?: { message: string } }): void;
}

/** An attached agent whose runs the fixture drives frame by frame. */
function replayAgent(runs: ReplayRun[]): SDKAgent {
  const agent = {
    agentId: "replay-agent",
    model: undefined,
    async send(_message: unknown, options: { onDelta?: (args: { update: unknown }) => void } = {}) {
      let settle!: ReplayRun["settle"];
      const outcome = new Promise<{ status: string; result?: string; error?: { message: string } }>(
        (resolve) => {
          settle = resolve;
        },
      );
      let settled = false;
      runs.push({
        deliver: (update) => options.onDelta?.({ update }),
        settle: (value) => {
          if (settled) return;
          settled = true;
          settle(value);
        },
      });
      const run = runs.at(-1)!;
      return {
        id: `replay-run-${runs.length}`,
        agentId: "replay-agent",
        status: "running" as const,
        supports: () => true,
        unsupportedReason: () => undefined,
        async *stream() {
          await outcome;
        },
        conversation: async () => [],
        wait: async () => ({ id: `replay-run-${runs.length}`, ...(await outcome) }),
        cancel: async () => run.settle({ status: "cancelled" }),
        onDidChangeStatus: () => () => undefined,
      };
    },
    close: () => undefined,
    reload: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.alloc(0),
    getUsage: async () => ({ runs: [] }),
  };
  return agent as unknown as SDKAgent;
}

function attach(state: SessionState, runs: ReplayRun[]): void {
  state.agent = replayAgent(runs);
  state.agentId = "replay-agent";
  // The fingerprint `ensureAgent` writes after a real attach; without it the
  // installed agent looks stale and the bridge would replace it.
  state.attachedMcpKey = mcpConnectionKey(state.agentMcp);
}

runProviderReplaySuite({
  bridge: "cursor",
  fixtureDir: join(import.meta.dir, "testing", "provider-replay"),
  async start() {
    const harness: RouterHarness = await startRouterHarness();
    const runs: ReplayRun[] = [];
    let sessionId: string | undefined;
    let requests = 0;
    let current: ReplayRun | undefined;
    const state = () => {
      const found = sessionId ? sessions.get(sessionId) : undefined;
      if (!found) throw new Error("no session yet: start with prompt");
      return found;
    };

    return {
      async frame(step) {
        if (!current) throw new Error("no run is open to receive this frame");
        current.deliver(step.frame);
      },

      async action(step) {
        switch (step.action) {
          case "prompt": {
            if (!sessionId) {
              const created = await harness.createSession();
              sessionId = created.id;
              attach(created, runs);
            }
            const before = runs.length;
            requests += 1;
            const response = await harness.call(`/session/${sessionId}/prompt`, {
              method: "POST",
              body: JSON.stringify({
                prompt: typeof step.args.text === "string" ? step.args.text : "Provider replay",
                requestId: `replay-${requests}`,
              }),
            });
            if (response.status >= 300) {
              throw new Error(`prompt answered ${response.status}: ${await response.text()}`);
            }
            await waitFor(() => runs.length > before, 10_000);
            current = runs.at(-1);
            return;
          }
          case "interrupt": {
            const response = await harness.call(`/session/${state().id}/cancel`, {
              method: "POST",
            });
            if (response.status >= 300) throw new Error(`cancel answered ${response.status}`);
            await waitFor(() => state().status !== "running", 10_000);
            current = undefined;
            return;
          }
          case "end": {
            if (!current) throw new Error("no run to settle");
            const status = typeof step.args.status === "string" ? step.args.status : "finished";
            current.settle({
              status,
              ...(typeof step.args.result === "string" ? { result: step.args.result } : {}),
              ...(typeof step.args.error === "string"
                ? { error: { message: step.args.error } }
                : {}),
            });
            current = undefined;
            await waitFor(() => state().status !== "running", 10_000);
            return;
          }
          case "restart": {
            await drainPersistence();
            sessions.clear();
            clientSessionKeys.clear();
            closingTombstones.clear();
            reopenPersistenceForTests();
            await loadPersistedState();
            attach(state(), runs);
            return;
          }
          default:
            throw new Error(`unsupported action ${step.action}`);
        }
      },

      async snapshot() {
        const current = state();
        const activity = publicActivity(current);
        return {
          transcript: cursorTranscriptSource(current, "replay"),
          activity: String(activity.activity),
          completion: {
            status: current.status,
            ...(current.error ? { error: current.error } : {}),
          },
          // Cursor parks nothing: its SDK has no approval callback.
          pending: [],
          drift: current.health.drift(),
        };
      },

      async stop() {
        for (const run of runs.splice(0)) run.settle({ status: "cancelled" });
        await harness.close();
      },
    };
  },
});
