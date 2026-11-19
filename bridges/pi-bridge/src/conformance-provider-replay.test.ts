/**
 * The shared provider-replay suite (`tests/conformance/provider-replay`) over
 * the Pi bridge.
 *
 * The real router on an ephemeral loopback port, the real attach path and the
 * real prompt route; only `createAgentSession` is replaced. The stand-in
 * session hands every fixture frame, a Pi `AgentSessionEvent`, to the
 * listener the bridge subscribed with, which is `applySessionEvent` in
 * production. Its `prompt()` run is settled by the fixture's `end` action,
 * as Pi settles it when the agent loop finishes.
 *
 * A frame `{"type":"tool_call","toolCallId","toolName","input"}` is Pi's
 * extension `tool_call` event: it goes where the bridge's approval extension
 * sends it (`requestToolApproval`), and whether the call was blocked is
 * pinned under `extra.decisions`.
 *
 * Actions: `prompt` (`text`, `policy`), `answer` (`decision` allow | deny),
 * `interrupt`, `end` (Pi settles the run), `restart` (a successor process
 * loads the published state, as after a bridge restart).
 */
import { afterAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
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

const ENV_KEYS = [
  "PORT",
  "HOSTNAME",
  "PI_BRIDGE_TOKEN",
  "PI_BRIDGE_LIBRARY_ONLY",
  "PI_BRIDGE_STATE_DIR",
  PROVIDER_RECORD_DIR_ENV,
  PROVIDER_RECORD_CONFIRM_ENV,
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

// `config.ts` reads its environment once, at import, so the bridge is loaded
// dynamically after the environment is in place.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "pi-replay-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;
const recordings = await mkdtemp(join(tmpdir(), "pi-replay-recordings-"));
process.env[PROVIDER_RECORD_DIR_ENV] = recordings;
process.env[PROVIDER_RECORD_CONFIRM_ENV] = "1";
const { replayRecorder } = await import("./replay-recorder.js");

const { json, route } = await import("./http.js");
const { authToken } = await import("./config.js");
const { setAgentSessionTestHooks, createPiSessionServices } = await import("./agent-session.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { publicActivity } = await import("./public.js");
const { piTranscriptSource } = await import("./transcript-source.js");
const {
  drainPersistence,
  loadPersistedState,
  reopenPersistenceForTests,
  settlePersistenceForTests,
} = await import("./persistence.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

afterAll(async () => {
  await replayRecorder?.close();
  await rm(recordings, { recursive: true, force: true });
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const ASK_POLICY = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "ask",
  projectResources: false,
  networkAccess: "full",
} as const;

/** One provider run: what `session.prompt()` returned to the bridge. */
interface Run {
  settle(): void;
}

/** The stand-in for Pi's `AgentSession`, driven by the fixture. */
function replaySession(sessionDirectory: string, runs: Run[]) {
  let listener: ((event: unknown) => void) | undefined;
  let settleOnAbort = true;
  const session = {
    sessionId: "pi-replay-session",
    sessionFile: join(sessionDirectory, "replay.jsonl"),
    model: undefined,
    thinkingLevel: "medium",
    promptTemplates: [],
    subscribe(next: (event: unknown) => void) {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    dispose: () => undefined,
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high"],
    bindExtensions: async () => undefined,
    prompt(_text: string, options: { preflightResult?: (disposition: string) => void } = {}) {
      return new Promise<void>((resolve) => {
        runs.push({ settle: resolve });
        queueMicrotask(() => options.preflightResult?.("started"));
      });
    },
    abort: async () => {
      // A real abort ends the run Pi is executing.
      if (!settleOnAbort) return;
      listener?.({ type: "agent_settled", aborted: true });
      for (const run of runs.splice(0)) run.settle();
    },
    abortCompaction: () => undefined,
    clearQueue: () => ({ steering: [], followUp: [] }),
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    getLastAssistantText: () => undefined,
    sessionManager: { getEntries: () => [], getBranch: () => [] },
  };
  return {
    session: session as unknown as AgentSession,
    deferAbortSettlement() {
      settleOnAbort = false;
    },
    emit(event: unknown) {
      if (!listener) throw new Error("the bridge has not subscribed to the Pi session");
      listener(event);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const adapter: ProviderReplayAdapter = {
  bridge: "pi",
  fixtureDir: join(import.meta.dir, "testing", "provider-replay"),
  async start() {
    sessions.clear();
    clientSessionKeys.clear();
    const stateDirectory = await mkdtemp(join(tmpdir(), "pi-replay-"));
    process.env.PI_BRIDGE_STATE_DIR = stateDirectory;
    const runs: Run[] = [];
    let provider = replaySession(stateDirectory, runs);
    let approveTool: ((frame: Record<string, unknown>) => Promise<unknown>) | undefined;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      createAgentSession: async (state) => {
        const services = await createPiSessionServices(state, {
          cwd: stateDirectory,
          agentDir: join(stateDirectory, "agent"),
        });
        const extension = services.resourceLoader
          .getExtensions()
          .extensions.find((entry) => entry.path === "<inline:orkestrator>");
        const [handler] = extension?.handlers.get("tool_call") ?? [];
        if (!handler) throw new Error("Pi did not register the tool approval extension");
        approveTool = async (frame) => handler(frame as never, undefined as never);
        return provider.session;
      },
    });

    let server: Server = createServer((request, response) => {
      void route(request, response, new AbortController().signal).catch(() => {
        if (response.headersSent) response.end();
        else json(response, 500, { error: "Internal bridge error" });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await nativeFetch(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as unknown) : undefined };
    };

    let sessionId: string | undefined;
    let requests = 0;
    const decisions: Array<{ toolName: string; blocked: boolean }> = [];
    const parked: Array<Promise<void>> = [];
    const state = () => {
      const found = sessionId ? sessions.get(sessionId) : undefined;
      if (!found) throw new Error("no session yet: start with prompt");
      return found;
    };

    return {
      async frame(step) {
        const frame = step.frame;
        if (isRecord(frame) && frame.type === "tool_call") {
          const current = state();
          const before = current.approvals.size;
          let answered = false;
          const toolName = String(frame.toolName);
          parked.push(
            approveTool!(frame).then((decision) => {
              answered = true;
              decisions.push({ toolName, blocked: isRecord(decision) && decision.block === true });
            }),
          );
          await waitUntil(() => answered || current.approvals.size > before, "the approval gate");
          return;
        }
        provider.emit(frame);
      },

      async action(step) {
        switch (step.action) {
          case "prompt": {
            if (!sessionId) {
              const created = await call("POST", "/session/create", {});
              if (created.status !== 201) throw new Error(`create answered ${created.status}`);
              sessionId = (created.body as { sessionId: string }).sessionId;
            }
            if (step.args.policy === "ask") state().policy = { ...ASK_POLICY };
            else if (step.args.policy !== undefined) throw new Error("unknown policy");
            const before = runs.length;
            requests += 1;
            const answer = await call("POST", `/session/${sessionId}/prompt`, {
              prompt: typeof step.args.text === "string" ? step.args.text : "Provider replay",
              requestId: `replay-${requests}`,
            });
            if (answer.status >= 300) {
              throw new Error(`prompt answered ${answer.status}: ${JSON.stringify(answer.body)}`);
            }
            await waitUntil(() => runs.length > before, "Pi to start the run");
            return;
          }
          case "answer": {
            const current = state();
            const [id] = [...current.approvals.keys()];
            if (!id) throw new Error("nothing pending to answer");
            const decision = step.args.decision === "allow" ? "approve" : "deny";
            const answered = await call(
              "POST",
              `/session/${current.id}/approvals/${encodeURIComponent(id)}`,
              { decision },
            );
            if (answered.status !== 200) throw new Error(`answer answered ${answered.status}`);
            await Promise.all(parked);
            return;
          }
          case "interrupt": {
            if (step.args.awaitProvider === true) provider.deferAbortSettlement();
            const cancelled = await call("POST", `/session/${state().id}/cancel`);
            if (cancelled.status >= 300) throw new Error(`cancel answered ${cancelled.status}`);
            if (step.args.awaitProvider !== true) {
              await waitUntil(() => state().status !== "running", "the cancelled turn to settle");
            }
            return;
          }
          case "end": {
            const run = runs.shift();
            if (!run) throw new Error("no run to settle");
            run.settle();
            await waitUntil(() => state().status !== "running", "the turn to settle");
            return;
          }
          case "restart": {
            // What a successor process would read, with no graceful shutdown.
            await drainPersistence();
            sessions.clear();
            clientSessionKeys.clear();
            reopenPersistenceForTests();
            provider = replaySession(stateDirectory, runs);
            await loadPersistedState();
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
          transcript: piTranscriptSource(current, "replay"),
          activity: String(activity.activity),
          completion: {
            status: current.status,
            ...(activity.turnFailed ? { turnFailed: true } : {}),
          },
          pending: [...current.approvals.values()].map((approval) => ({
            kind: "tool-approval",
            toolName: approval.toolName,
          })),
          drift: current.health.drift(),
          ...(decisions.length > 0 ? { extra: { decisions: [...decisions] } } : {}),
        };
      },

      async stop() {
        for (const run of runs.splice(0)) run.settle();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await drainPersistence().catch(() => undefined);
        reopenPersistenceForTests();
        sessions.clear();
        clientSessionKeys.clear();
        setAgentSessionTestHooks(undefined);
        delete process.env.PI_BRIDGE_STATE_DIR;
        await settlePersistenceForTests();
        await rm(stateDirectory, { recursive: true, force: true });
        server = undefined as unknown as Server;
      },
    };
  },
};

runProviderReplaySuite(adapter);

test("Pi records and replays the subscribed events and installed approval extension", async () => {
  await replayRecorder!.flush();
  const previous = new Set(await readdir(recordings));
  const fixture = readProviderReplayFixture(adapter.fixtureDir, "approval-denial.jsonl");
  const original = await replayProviderFixture(adapter, fixture);
  await replayRecorder!.flush();
  const fresh = (await readdir(recordings)).filter((name) => !previous.has(name));
  expect(fresh).toHaveLength(1);
  const capture = parseProviderReplayFixture(
    fresh[0]!,
    await readFile(join(recordings, fresh[0]!), "utf8"),
  );
  expect(
    capture.steps.some(
      (step) => step.kind === "frame" && isRecord(step.frame) && step.frame.type === "tool_call",
    ),
  ).toBe(true);
  // The recorder marks provider ingress. The operator supplies user decisions and
  // Pi's test run-settlement action when preparing a fixture.
  const promptStep = capture.steps.find(
    (step) => step.kind === "action" && step.action === "prompt",
  );
  if (promptStep?.kind !== "action") throw new Error("Missing recorded prompt");
  promptStep.args.policy = "ask";
  const approval = capture.steps.findIndex(
    (step) => step.kind === "frame" && isRecord(step.frame) && step.frame.type === "tool_call",
  );
  capture.steps.splice(approval + 1, 0, {
    kind: "action",
    action: "answer",
    args: { decision: "deny" },
    line: 0,
  });
  capture.steps.push({ kind: "action", action: "end", args: {}, line: 0 });
  const reproduced = await replayProviderFixture(adapter, capture);
  expect(reproduced.at(-1)?.extra).toEqual(original.at(-1)?.extra);
  expect(reproduced.at(-1)?.rows.filter((row) => row.role === "assistant")).toEqual(
    original.at(-1)?.rows.filter((row) => row.role === "assistant"),
  );
});
