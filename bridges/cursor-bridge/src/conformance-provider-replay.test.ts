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
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKAgent } from "@cursor/sdk";
import { parseProviderReplayFixture } from "../../../tests/conformance/provider-replay/fixture.js";
import {
  readProviderReplayFixture,
  replayProviderFixture,
  runProviderReplaySuite,
  type ProviderReplayAdapter,
} from "../../../tests/conformance/provider-replay/scenarios.js";
import {
  PROVIDER_RECORD_CONFIRM_ENV,
  PROVIDER_RECORD_DIR_ENV,
} from "@orkestrator/protocol/node/provider-replay-recorder";
import type { SessionState } from "./state.js";
import type { RouterHarness } from "./testing/router-harness.js";

const recordings = await mkdtemp(join(tmpdir(), "cursor-replay-recordings-"));
const previousEnv = [PROVIDER_RECORD_DIR_ENV, PROVIDER_RECORD_CONFIRM_ENV].map(
  (key) => [key, process.env[key]] as const,
);
process.env[PROVIDER_RECORD_DIR_ENV] = recordings;
process.env[PROVIDER_RECORD_CONFIRM_ENV] = "1";
const { replayRecorder } = await import("./replay-recorder.js");
for (const [key, value] of previousEnv) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
const { mcpConnectionKey } = await import("./mcp.js");
const { drainPersistence, loadPersistedState, reopenPersistenceForTests } =
  await import("./persistence.js");
const { publicActivity } = await import("./public.js");
const { clientSessionKeys, closingTombstones, sessions } = await import("./state.js");
const { startRouterHarness, waitFor } = await import("./testing/router-harness.js");
const { cursorTranscriptSource } = await import("./transcript-source.js");

afterAll(async () => {
  await replayRecorder?.close();
  await rm(recordings, { recursive: true, force: true });
});

interface ReplayRun {
  awaitProvider?: boolean;
  deliver(update: unknown): void;
  settle(outcome: { status: string; result?: string; error?: { message: string } } | Error): void;
}

/** An attached agent whose runs the fixture drives frame by frame. */
function replayAgent(runs: ReplayRun[]): SDKAgent {
  const agent = {
    agentId: "replay-agent",
    model: undefined,
    async send(_message: unknown, options: { onDelta?: (args: { update: unknown }) => void } = {}) {
      let settle!: ReplayRun["settle"];
      const outcome = new Promise<Exclude<Parameters<ReplayRun["settle"]>[0], Error>>(
        (resolve, reject) => {
          settle = (value) => (value instanceof Error ? reject(value) : resolve(value));
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
        async *stream(): AsyncGenerator<never> {
          // Held open until the run settles; this agent streams no messages.
          await outcome;
          yield* [];
        },
        conversation: async () => [],
        wait: async () => ({ id: `replay-run-${runs.length}`, ...(await outcome) }),
        cancel: async () => {
          if (!run.awaitProvider) run.settle({ status: "cancelled" });
        },
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

const adapter: ProviderReplayAdapter = {
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
            if (!current) throw new Error("no run to cancel");
            current.awaitProvider = step.args.awaitProvider === true;
            const response = await harness.call(`/session/${state().id}/cancel`, {
              method: "POST",
            });
            if (response.status >= 300) throw new Error(`cancel answered ${response.status}`);
            if (!current.awaitProvider) {
              await waitFor(() => state().status !== "running", 10_000);
              current = undefined;
            }
            return;
          }
          case "cursor-terminal": {
            if (!current) throw new Error("no run to settle");
            if (typeof step.args.rejection === "string") {
              current.settle(new Error(step.args.rejection));
            } else {
              current.settle(
                step.args.result as Exclude<Parameters<ReplayRun["settle"]>[0], Error>,
              );
            }
            current = undefined;
            await waitFor(() => state().status !== "running", 10_000);
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
};

runProviderReplaySuite(adapter);

for (const rejection of [undefined, "The provider disconnected"]) {
  test(`Cursor records and replays a ${rejection ? "rejected" : "resolved"} run.wait`, async () => {
    await replayRecorder!.flush();
    const previous = new Set(await readdir(recordings));
    const fixture = readProviderReplayFixture(adapter.fixtureDir, "basic-turn.jsonl");
    if (rejection) {
      fixture.steps = fixture.steps.filter(
        (step) => step.kind !== "action" || step.action !== "end",
      );
      fixture.steps.push({
        kind: "action",
        action: "cursor-terminal",
        args: { rejection },
        line: 0,
      });
    }
    const original = await replayProviderFixture(adapter, fixture);
    await replayRecorder!.flush();
    const fresh = (await readdir(recordings)).filter((name) => !previous.has(name));
    expect(fresh).toHaveLength(1);
    const capture = parseProviderReplayFixture(
      fresh[0]!,
      await readFile(join(recordings, fresh[0]!), "utf8"),
    );
    expect(capture.steps.some((step) => step.kind === "frame")).toBe(true);
    expect(capture.steps.at(-1)).toMatchObject({
      action: "cursor-terminal",
      args: rejection ? { rejection } : { result: { status: "finished" } },
    });
    const replayed = await replayProviderFixture(adapter, capture);
    expect(replayed.at(-1)?.completion).toEqual(original.at(-1)?.completion);
    expect(replayed.at(-1)?.rows.filter((row) => row.role === "assistant")).toEqual(
      original.at(-1)?.rows.filter((row) => row.role === "assistant"),
    );
  });
}
