/**
 * The shared provider-replay suite (`tests/conformance/provider-replay`) over
 * the ACP bridge (Grok).
 *
 * The whole bridge runs as a process per fixture, as in the shared contract
 * suite: the real entrypoint, router, state file and the real `AcpProcess`
 * reading an agent's stdout. The agent is `testing/fake-agent-replay-relay.ts`:
 * it answers the session handshake like the ordinary fake agent and relays
 * the turn to this test, which writes each fixture frame — one JSON-RPC line,
 * byte for byte as Grok would — to the agent's stdout. Nothing between the
 * wire and the transcript is faked.
 *
 * Frames are JSON-RPC messages from the agent: `session/update`
 * notifications, `session/request_permission` requests, vendor notifications
 * and the agent's answers to the bridge's requests. Ids the agent cannot know
 * in advance are placeholders: `"$prompt"` is the id of the bridge's latest
 * `session/prompt`, `"$load"` of its latest `session/load`. An explicit rawLine preserves the wire representation. After every frame the test sends
 * the agent a request the bridge does not implement and waits for its
 * refusal, so everything written before it has been read.
 *
 * Actions: `prompt` (`text`, `policy`), `await-prompt` (after answering a
 * restored session's `session/load`, wait for the prompt it was holding),
 * `answer` (`decision` allow | deny), `interrupt`, `settle` (the prompt request has returned and the session is
 * idle), `restart` (SIGKILL, then a successor bridge over the same state
 * directory; the next prompt attaches a new agent with `session/load`).
 */
import { promises as fs } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  PROVIDER_RECORD_CONFIRM_ENV,
  PROVIDER_RECORD_DIR_ENV,
} from "@orkestrator/protocol/node/provider-replay-recorder";
import { parseProviderReplayFixture } from "../../../tests/conformance/provider-replay/fixture.js";
import {
  readProviderReplayFixture,
  replayProviderFixture,
  runProviderReplaySuite,
  type ProviderReplayAdapter,
} from "../../../tests/conformance/provider-replay/scenarios.js";
import {
  BRIDGE_TEST_TIMEOUT_MS,
  here,
  nativeFetch,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitForExit,
} from "./acp-test-harness.js";

type Json = Record<string, unknown>;

const ASK_POLICY = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "ask",
  projectResources: false,
  networkAccess: "full",
} as const;

/** Ids for the barrier requests, far above anything a fixture uses. */
const BARRIER_ID_BASE = 9_000_000;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Extra bridge environment; only the recorder round trip below sets it. */
let bridgeEnv: Record<string, string> = {};

const adapter: ProviderReplayAdapter = {
  bridge: "acp",
  fixtureDir: join(import.meta.dir, "testing", "provider-replay"),
  async start(fixture) {
    const directory = await temporaryDirectory();
    const stateDirectory = resolve(directory, "state");
    const workspace = resolve(directory, "workspace");
    await fs.mkdir(stateDirectory, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const socketPath = join(directory, "replay.sock");

    // The relay agent currently attached, and what the bridge has sent it.
    let agent: Socket | undefined;
    const promptIds: number[] = [];
    const loadIds: number[] = [];
    let cancels = 0;
    const answers = new Map<number, Json>();
    const decisions: unknown[] = [];
    const server: Server = createServer((socket) => {
      agent?.destroy();
      agent = socket;
      let buffered = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          if (!line.trim()) continue;
          const message = (JSON.parse(line) as { in: Json }).in;
          const method = typeof message.method === "string" ? message.method : undefined;
          if (method === "session/prompt") promptIds.push(Number(message.id));
          else if (method === "session/load") loadIds.push(Number(message.id));
          else if (method === "session/cancel") cancels += 1;
          else if (method && typeof message.id === "number") {
            // A request outside the turn (a close, say): acknowledge it.
            socket.write(
              `${JSON.stringify({ out: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) })}\n`,
            );
          } else if (!method && typeof message.id === "number") {
            answers.set(message.id, message);
          }
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const launch = () =>
      spawnBridge({
        stateDirectory,
        env: {
          ACP_PROVIDER: "grok",
          ACP_AGENT_PATH: resolve(here, "testing/fake-agent-replay-relay.ts"),
          FAKE_ACP_REPLAY_SOCKET: socketPath,
          CWD: workspace,
          ACP_CLOSE_CANCEL_WAIT_MS: "200",
          [PROVIDER_RECORD_DIR_ENV]: undefined,
          [PROVIDER_RECORD_CONFIRM_ENV]: undefined,
          ...bridgeEnv,
        },
      });
    let bridge = await launch();
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await nativeFetch(`${bridge.base}${path}`, {
        method,
        headers: bridge.headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      return { status: response.status, body: parsed };
    };

    let sessionId: string | undefined;
    let recordedSessionId: string | undefined;
    let recordedPromptId: number | undefined;
    let requests = 0;
    let barriers = 0;
    let promptsAwaited = 0;
    let prompt: Promise<{ status: number; body: unknown }> | undefined;
    let promptAnswer: { status: number; body: unknown } | undefined;
    const live = () => {
      if (!sessionId) throw new Error("no session yet: start with prompt");
      return sessionId;
    };
    const write = (line: string) => {
      if (!agent) throw new Error("no agent is attached to receive this frame");
      agent.write(`${JSON.stringify({ out: line })}\n`);
    };
    const barrier = async () => {
      barriers += 1;
      const id = BARRIER_ID_BASE + barriers;
      write(JSON.stringify({ jsonrpc: "2.0", id, method: "_replay/barrier", params: {} }));
      await until(() => answers.has(id), Boolean, "the bridge to read the replayed frames");
      answers.delete(id);
    };
    const pendingApprovals = async (): Promise<Json[]> => {
      const response = await call("GET", `/session/${live()}/approvals`);
      return ((response.body as { approvals?: Json[] } | undefined)?.approvals ?? []).filter(
        isRecord,
      );
    };

    const readDispatch = async (id: string) => {
      if (requests === 0) return undefined;
      const response = await call("GET", `/session/${id}/dispatch?requestId=replay-${requests}`);
      if (response.status !== 200 || !isRecord(response.body)) {
        throw new Error("Could not read ACP dispatch state");
      }
      return response.body;
    };

    return {
      async frame(step) {
        // Inspect the same single line that the production parser will see.
        // Permit only the request exercised by the replay corpus. Barriers
        // are generated by the harness itself, never sent from a fixture.
        const rawLine = step.rawLine;
        if (rawLine !== undefined && /[\r\n]/.test(rawLine)) {
          throw new Error("ACP replay expects a single wire line");
        }
        let value = step.frame;
        if (rawLine !== undefined) {
          try {
            value = JSON.parse(rawLine);
          } catch {
            write(rawLine);
            return; // Malformed JSON closes the agent; no barrier can answer.
          }
        }
        const frame = isRecord(value) ? { ...value } : {};
        if (fixture.header.source === "recorded" && frame.method === "_replay/barrier") return;
        if (
          typeof frame.method === "string" &&
          "id" in frame &&
          frame.method !== "session/request_permission"
        ) {
          throw new Error("ACP replay refuses fixture-supplied client requests");
        }
        // The relay handles initialization and session creation. The capture
        // supplies the live turn and identifies the provider session to remap.
        if (!sessionId && fixture.header.source === "recorded") {
          if (isRecord(frame.result) && typeof frame.result.sessionId === "string") {
            recordedSessionId = frame.result.sessionId;
          }
          return;
        }
        let remapped = false;
        if (
          recordedSessionId &&
          isRecord(frame.params) &&
          frame.params.sessionId === recordedSessionId
        ) {
          frame.params = { ...frame.params, sessionId: "fake-session" };
          remapped = true;
        }
        if (
          frame.id === "$prompt" ||
          (recordedPromptId !== undefined &&
            frame.id === recordedPromptId &&
            ("result" in frame || "error" in frame) &&
            !("method" in frame))
        ) {
          frame.id = promptIds.at(-1);
          remapped = true;
        } else if (frame.id === "$load") {
          frame.id = loadIds.at(-1);
          remapped = true;
        }
        write(
          rawLine !== undefined && !remapped
            ? rawLine
            : JSON.stringify(isRecord(value) ? frame : value),
        );
        await barrier();
        if (frame.method === "session/request_permission" && typeof frame.id === "number") {
          const requestId = frame.id;
          // Parked for a person, or answered by policy straight away.
          await until(
            async () => answers.has(requestId) || (await pendingApprovals()).length > 0,
            Boolean,
            "the permission request to park or be answered",
          );
          const answer = answers.get(requestId);
          if (answer) decisions.push(answer.result ?? answer.error);
        }
      },

      async action(step) {
        switch (step.action) {
          case "prompt": {
            if (!sessionId) {
              const created = await call(
                "POST",
                "/session/create",
                step.args.policy === "ask" ? { policy: ASK_POLICY } : {},
              );
              if (created.status !== 201) {
                throw new Error(
                  `create answered ${created.status}: ${JSON.stringify(created.body)}`,
                );
              }
              sessionId = String((created.body as { id: string }).id);
            } else if (step.args.policy !== undefined) {
              throw new Error("a policy can only be set on the first prompt");
            }
            const before = promptIds.length;
            const loadsBefore = loadIds.length;
            promptsAwaited = before;
            recordedPromptId = typeof step.args.rpcId === "number" ? step.args.rpcId : undefined;
            requests += 1;
            promptAnswer = undefined;
            prompt = call("POST", `/session/${sessionId}/prompt`, {
              prompt: typeof step.args.text === "string" ? step.args.text : "Provider replay",
              requestId: `replay-${requests}`,
            });
            void prompt.then((answer) => {
              promptAnswer = answer;
            });
            // A restored session reattaches first: its `session/load` is
            // answered by the fixture, which then awaits the prompt.
            await until(
              () =>
                promptIds.length > before ||
                loadIds.length > loadsBefore ||
                (promptAnswer !== undefined && promptAnswer.status >= 300),
              Boolean,
              "the bridge to send session/prompt or session/load",
            );
            if (promptIds.length === before && loadIds.length === loadsBefore) {
              throw new Error(`prompt answered ${promptAnswer?.status} before dispatch`);
            }
            return;
          }
          case "await-prompt": {
            await until(
              () => promptIds.length > promptsAwaited,
              Boolean,
              "the bridge to send session/prompt",
            );
            promptsAwaited = promptIds.length;
            return;
          }
          case "answer": {
            const [approval] = await pendingApprovals();
            if (!approval) throw new Error("nothing pending to answer");
            const known = new Set(answers.keys());
            const decision = step.args.decision === "allow" ? "approve" : "deny";
            const answered = await call(
              "POST",
              `/session/${live()}/approvals/${encodeURIComponent(String(approval.id))}`,
              { decision },
            );
            if (answered.status !== 200) throw new Error(`answer answered ${answered.status}`);
            const id = await until(
              () => [...answers.keys()].find((key) => !known.has(key) && key < BARRIER_ID_BASE),
              (key) => key !== undefined,
              "the bridge to answer the agent",
            );
            decisions.push(answers.get(id!)?.result);
            return;
          }
          case "interrupt": {
            const before = cancels;
            const cancelled = await call("POST", `/session/${live()}/cancel`);
            if (cancelled.status >= 300) throw new Error(`cancel answered ${cancelled.status}`);
            await until(() => cancels > before, Boolean, "the bridge to send session/cancel");
            return;
          }
          case "settle": {
            await prompt;
            await until(
              () => readDispatch(live()),
              (outcome) => outcome?.turn !== undefined,
              "the dispatched turn to reach its terminal journal state",
            );
            return;
          }
          case "restart": {
            // The successor reads only what was published, so wait until the
            // state file holds the revision the live session reports. A kill
            // inside the publication window is a crash, not a resume.
            const id = live();
            const status = await call("GET", `/session/${id}/status`);
            const revision = (status.body as { revision?: number } | undefined)?.revision;
            await until(
              async () => {
                const text = await fs
                  .readFile(join(stateDirectory, "state.json"), "utf8")
                  .catch(() => "");
                if (!text) return undefined;
                const published = (JSON.parse(text) as { sessions?: Json[] }).sessions ?? [];
                return published.find((session) => session.id === id)?.revision;
              },
              (published) => typeof published === "number" && published >= (revision ?? 0),
              "the session's state to be published",
            );
            // No graceful shutdown: SIGTERM would drain the persistence tail.
            bridge.child.kill("SIGKILL");
            await waitForExit(bridge.child);
            await stopChild(bridge.child);
            agent?.destroy();
            agent = undefined;
            bridge = await launch();
            return;
          }
          default:
            throw new Error(`unsupported action ${step.action}`);
        }
      },

      async snapshot() {
        const id = live();
        const [messages, summary, activity, status, interactions, health, dispatch] =
          await Promise.all([
            call("GET", `/session/${id}/messages?fromIndex=0`),
            call("GET", `/session/${id}/transcript?version=2&limit=2`),
            call("GET", `/session/${id}/activity`),
            call("GET", `/session/${id}/status`),
            call("GET", `/session/${id}/interactions`),
            call("GET", `/session/${id}/runtime-health`),
            readDispatch(id),
          ]);
        const approvals = await pendingApprovals();
        const statusBody = (status.body ?? {}) as Json;
        return {
          served: {
            messages: ((messages.body as { messages?: unknown[] }).messages ?? []) as Array<{
              id: string;
              content: string;
              parts: unknown[];
            }>,
            summary: summary.body,
          },
          activity: String((activity.body as { activity?: unknown }).activity),
          completion: {
            status: statusBody.status,
            ...(statusBody.error ? { error: statusBody.error } : {}),
            ...(dispatch ? { dispatch: dispatch.dispatch } : {}),
            ...(dispatch?.turn ? { turn: dispatch.turn } : {}),
          },
          pending: [
            ...approvals.map((approval) => ({ kind: String(approval.kind ?? "permission") })),
            ...((interactions.body as { interactions?: Json[] }).interactions ?? []).map(
              (interaction) => ({ kind: String(interaction.kind ?? "interaction") }),
            ),
          ],
          drift: (health.body as { drift?: { unknownEvents: number; unknownKinds: string[] } })
            .drift,
          extra: {
            ...(decisions.length > 0 ? { decisions: [...decisions] } : {}),
            ...(cancels > 0 ? { cancelsSent: cancels } : {}),
            ...(loadIds.length > 0 ? { loadsSent: loadIds.length } : {}),
          },
        };
      },

      async stop() {
        await stopChild(bridge.child);
        agent?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  },
};

runProviderReplaySuite(adapter, { timeoutMs: BRIDGE_TEST_TIMEOUT_MS });

describe("provider-traffic recorder", () => {
  test(
    "a recording of a replayed turn is itself a replayable fixture",
    async () => {
      const recordings = await temporaryDirectory();
      bridgeEnv = {
        [PROVIDER_RECORD_DIR_ENV]: recordings,
        [PROVIDER_RECORD_CONFIRM_ENV]: "1",
      };
      const fixture = readProviderReplayFixture(adapter.fixtureDir, "basic-turn.jsonl");
      try {
        await replayProviderFixture(adapter, fixture);
      } finally {
        bridgeEnv = {};
      }
      const [file, ...others] = (await fs.readdir(recordings)).filter((name) =>
        name.endsWith(".jsonl"),
      );
      expect(others).toEqual([]);
      const recorded = parseProviderReplayFixture(
        file!,
        await fs.readFile(join(recordings, file!), "utf8"),
      );
      expect(recorded.header).toMatchObject({
        bridge: "acp",
        source: "recorded",
        provider: "grok",
        // The fake agent's own `initialize` reports this build.
        providerVersion: "9.9.9",
      });
      // Replay the production capture, including its handshake and numeric
      // RPC ids, through a fresh bridge, then compare the visible turn.
      const original = await replayProviderFixture(adapter, fixture);
      // Stand in for a provider-issued session id different from the relay's.
      for (const step of recorded.steps) {
        if (step.kind !== "frame" || !step.rawLine) continue;
        step.rawLine = step.rawLine.replaceAll('"fake-session"', '"captured-provider-session"');
      }
      recorded.steps.push({ kind: "action", action: "settle", args: {}, line: 0 });
      const replayed = await replayProviderFixture(adapter, recorded);
      expect(replayed.at(-1)?.rows.filter((row) => row.role === "assistant")).toEqual(
        original.at(-1)?.rows.filter((row) => row.role === "assistant"),
      );
      expect(replayed.at(-1)?.completion).toEqual(original.at(-1)?.completion);
    },
    BRIDGE_TEST_TIMEOUT_MS,
  );
});

test("ACP replay rejects client methods before writing object or raw frames", async () => {
  const fixture = readProviderReplayFixture(adapter.fixtureDir, "basic-turn.jsonl");
  const replay = await adapter.start(fixture);
  try {
    const prompt = fixture.steps[0]!;
    if (prompt.kind !== "action") throw new Error("Missing prompt");
    await replay.action(prompt);
    // The request has no executable to run even if the replay guard regresses.
    const frame = { jsonrpc: "2.0", id: 810, method: "terminal/create", params: {} };
    await expect(replay.frame({ kind: "frame", frame, line: 3 })).rejects.toThrow("refuses");
    await expect(
      replay.frame({ kind: "frame", frame, rawLine: JSON.stringify(frame), line: 4 }),
    ).rejects.toThrow("refuses");
  } finally {
    await replay.stop();
  }
});

test("ACP replay keeps valid JSON strings distinct from malformed wire lines", async () => {
  const fixture = readProviderReplayFixture(adapter.fixtureDir, "basic-turn.jsonl");
  const prompt = fixture.steps[0]!;
  if (prompt.kind !== "action") throw new Error("Missing prompt");
  fixture.steps = [
    prompt,
    { kind: "frame", frame: "opaque", rawLine: '"opaque"', line: 2 },
    { kind: "frame", frame: undefined, rawLine: "{", line: 3 },
    { kind: "action", action: "settle", args: {}, line: 4 },
  ];
  const observations = await replayProviderFixture(adapter, fixture);
  expect(observations.at(-1)?.completion).toMatchObject({
    dispatch: "dispatched",
    turn: { state: "failed" },
    error: expect.stringContaining("malformed JSON"),
  });
});

test("ACP replay observes the terminal journal error when the provider stops early", async () => {
  const fixture = readProviderReplayFixture(adapter.fixtureDir, "basic-turn.jsonl");
  for (const step of fixture.steps) {
    if (step.kind !== "frame" || !isRecord(step.frame) || step.frame.id !== "$prompt") continue;
    step.frame.result = { stopReason: "max_tokens" };
  }
  const observations = await replayProviderFixture(adapter, fixture);
  expect(observations.at(-1)?.completion).toMatchObject({
    dispatch: "dispatched",
    turn: { state: "completed", error: expect.stringContaining("max_tokens") },
  });
});
