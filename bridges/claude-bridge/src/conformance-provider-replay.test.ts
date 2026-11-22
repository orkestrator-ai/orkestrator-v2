/**
 * The shared provider-replay suite (`tests/conformance/provider-replay`) over
 * the Claude bridge.
 *
 * Frames are Claude Agent SDK messages, the shape `query()` yields and the
 * CLI writes as stream-json. They go through the session manager's real turn:
 * the controllable `query()` double hands each one to the bridge's own
 * `for await`, and the adapter waits until the bridge has taken it before the
 * next step. Nothing between the SDK boundary and the transcript is faked.
 *
 * Frame routing, by position in the fixture:
 *
 *  - Before the first `prompt` or `resume` action, a frame is a record of the
 *    session's persisted rollout (`getSessionMessages`), which a `resume`
 *    action materializes and hydrates as a successor process would.
 *  - Afterwards it is live traffic for the current query. The CLI's
 *    permission request, `{"type":"control_request","request":{"subtype":
 *    "can_use_tool",…}}`, is delivered the way the SDK delivers it: as a
 *    `canUseTool` call, whose answer the adapter pins under `extra.decisions`.
 *
 * The string `"$derived"` anywhere in a live frame stands for the SDK session
 * id the bridge derives from its own session id, which a recording made under
 * a different bridge id cannot carry verbatim. `"$prompt"` stands for the
 * client uuid of the latest prompt the bridge wrote to the SDK input: a real
 * CLI's `result` names the prompt it answers (`user_message_uuid`, with
 * `result_index`), and the bridge ignores a success that names other input.
 *
 * Actions: `prompt` (`text`, `options`, `policy`), `answer` (`decision`
 * allow | deny), `interrupt`, `end` (the CLI process exits), `settle` (wait
 * until the turn is over, which a turn released to background work reaches
 * before its prompt settles), `resume`.
 *
 * `interrupt` stops the turn the way `/hard-abort` does (`abortSession`), so
 * nothing the CLI sends afterwards reaches the bridge. With `"graceful": true`
 * it takes the user's stop instead, `/abort` (`gracefulInterruptClaudeSession`):
 * the query double answers the SDK's `interrupt()` control, and the frames that
 * follow in the fixture are what the CLI sent after it (a recorded stop ends
 * with the CLI's interruption marker and an `error_during_execution` result).
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_RECORD_CONFIRM_ENV,
  PROVIDER_RECORD_DIR_ENV,
} from "@orkestrator/protocol/node/provider-replay-recorder";
import type { QueryCall, SdkSessionMessage } from "./services/session-manager-test-harness.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  readProviderReplayFixture,
  replayProviderFixture,
  runProviderReplaySuite,
  type ProviderReplayAdapter,
} from "../../../tests/conformance/provider-replay/scenarios.js";
import {
  parseProviderReplayFixture,
  type ProviderReplayActionStep,
  type ProviderReplayFrameStep,
} from "../../../tests/conformance/provider-replay/fixture.js";

const recordings = await mkdtemp(join(tmpdir(), "claude-replay-recordings-"));
const previousEnv = [PROVIDER_RECORD_DIR_ENV, PROVIDER_RECORD_CONFIRM_ENV].map(
  (key) => [key, process.env[key]] as const,
);
process.env[PROVIDER_RECORD_DIR_ENV] = recordings;
process.env[PROVIDER_RECORD_CONFIRM_ENV] = "1";
const { replayRecorder } = await import("./services/replay-recorder.js");
for (const [key, value] of previousEnv) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const {
  PERSISTED_SDK_ID,
  abortSession,
  createSession,
  getPendingInteractions,
  getPendingPlanApprovals,
  getPendingQuestions,
  getSession,
  getSessionActivity,
  hydratePersistedSessionMessages,
  materializePersistedSession,
  mockSdkGetSessionMessages,
  nextQueryCall,
  respondToInteraction,
  respondToPlanApproval,
  dismissQuestion,
  queryControlOverrides,
  sendPrompt,
  track,
  waitFor,
} = await import("./services/session-manager-test-harness.js");
const { claudeTranscriptSource } = await import("./routes/session-transcript.js");
const { backgroundTasksForSnapshot } = await import("./services/background-task-snapshot.js");
const { gracefulInterruptClaudeSession, sdkSessionIdFromBridgeId } =
  await import("./services/session-manager.js");
const { sessionHealth } = await import("./types/index.js");

afterAll(async () => {
  await replayRecorder?.close();
  await rm(recordings, { recursive: true, force: true });
});

/** Policies a fixture may name in `prompt`: `ask` parks every tool for a person. */
const POLICIES: Record<string, NativeAgentExecutionPolicy> = {
  ask: {
    id: "interactive-host",
    sandbox: "provider",
    approvals: "ask",
    projectResources: true,
    networkAccess: "full",
  },
};

interface ParkedCall {
  toolName: string;
  promise: Promise<{ behavior: string; message?: string }>;
  settled?: { behavior: string; message?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function permissionRequest(frame: unknown): Record<string, unknown> | undefined {
  if (!isRecord(frame) || frame.type !== "control_request" || !isRecord(frame.request)) return;
  return frame.request.subtype === "can_use_tool"
    ? { ...frame.request, id: frame.request_id }
    : undefined;
}

function withPlaceholders(frame: unknown, sessionId: string, promptUuid?: string): unknown {
  let text = JSON.stringify(frame);
  if (!text.includes('"$derived"') && !text.includes('"$prompt"')) return frame;
  const derived = sdkSessionIdFromBridgeId(sessionId) ?? "";
  text = text.replaceAll('"$derived"', JSON.stringify(derived));
  if (text.includes('"$prompt"')) {
    if (!promptUuid) throw new Error('"$prompt" used before a prompt with a client uuid');
    text = text.replaceAll('"$prompt"', JSON.stringify(promptUuid));
  }
  return JSON.parse(text);
}

function pendingCount(sessionId: string): number {
  return (
    getPendingInteractions(sessionId).length +
    getPendingQuestions(sessionId).length +
    getPendingPlanApprovals(sessionId).length
  );
}

const adapter: ProviderReplayAdapter = {
  bridge: "claude",
  fixtureDir: join(import.meta.dir, "testing", "provider-replay"),
  async start(fixture) {
    const rollout: SdkSessionMessage[] = [];
    let sessionId: string | undefined;
    let call: QueryCall | undefined;
    let input: AsyncIterator<unknown> | undefined;
    let promptUuid: string | undefined;
    let queryCount = 0;
    let expectedRekey: string | undefined;
    let prompt: Promise<unknown> | undefined;
    let promptOutcome: string | undefined;
    const parked: ParkedCall[] = [];
    const decisions: Array<{ toolName: string; behavior: string }> = [];
    let interruptRequests = 0;
    // The control is read when the query is created, so a fixture that stops
    // its turn gracefully installs it before its first prompt.
    const graceful = fixture.steps.some(
      (step) =>
        step.kind === "action" && step.action === "interrupt" && step.args.graceful === true,
    );

    const live = (): string => {
      if (!sessionId) throw new Error("no session yet: start with prompt or resume");
      return sessionId;
    };
    const watch = (promise: Promise<unknown>) => {
      promptOutcome = undefined;
      prompt = promise.then(
        () => {
          promptOutcome = "resolved";
        },
        (error: unknown) => {
          promptOutcome = `rejected: ${error instanceof Error ? error.message : String(error)}`;
        },
      );
    };
    const settleDecisions = async () => {
      for (const entry of parked) {
        if (entry.settled) continue;
        entry.settled = await entry.promise;
        decisions.push({ toolName: entry.toolName, behavior: entry.settled.behavior });
      }
    };

    return {
      async frame(step: ProviderReplayFrameStep) {
        if (!call) {
          rollout.push(step.frame as SdkSessionMessage);
          return;
        }
        const request = permissionRequest(step.frame);
        if (request) {
          const id = live();
          const before = pendingCount(id);
          const entry: ParkedCall = {
            toolName: String(request.tool_name),
            promise: call.options.canUseTool!(String(request.tool_name), request.input, {
              signal: new AbortController().signal,
              requestId: String(request.id),
              toolUseID: String(request.tool_use_id),
            }),
          };
          let answered = false;
          void entry.promise.then(() => {
            answered = true;
          });
          parked.push(entry);
          // The bridge either parks it for a person or answers it by policy.
          await waitFor(() => answered || pendingCount(id) > before);
          return;
        }
        if (
          fixture.header.scenario === "session-rekey" &&
          isRecord(step.frame) &&
          step.frame.type === "system" &&
          step.frame.subtype === "init" &&
          typeof step.frame.session_id === "string" &&
          step.frame.session_id !== "$derived"
        ) {
          expectedRekey = step.frame.session_id;
        }
        call.push(withPlaceholders(step.frame, live(), promptUuid));
        await call.consumed();
      },

      async action(step: ProviderReplayActionStep) {
        switch (step.action) {
          case "prompt": {
            if (!sessionId) {
              const session = createSession("Provider replay");
              sessionId = track(session.id);
            }
            const policy =
              typeof step.args.policy === "string" ? POLICIES[step.args.policy] : undefined;
            if (step.args.policy !== undefined && !policy) throw new Error("unknown policy");
            if (policy) getSession(sessionId)!.executionPolicy = policy;
            if (graceful) {
              queryControlOverrides.interrupt = async () => {
                interruptRequests += 1;
                return { still_queued: [] };
              };
            }
            const previousRuntime = getSession(sessionId)?.claudeRuntime;
            let submitted = false;
            watch(
              sendPrompt(
                sessionId,
                typeof step.args.text === "string" ? step.args.text : "Provider replay prompt",
                isRecord(step.args.options) ? step.args.options : undefined,
                {
                  onQueryStarted: () => {
                    submitted = true;
                  },
                },
              ),
            );
            await waitFor(() => submitted || promptOutcome !== undefined, 5_000);
            if (!submitted) throw new Error(promptOutcome ?? "prompt was not submitted");
            if (!call || previousRuntime !== getSession(sessionId)?.claudeRuntime) {
              call = await nextQueryCall();
              queryCount += 1;
              input =
                typeof call.prompt === "string"
                  ? undefined
                  : (call.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
            }
            if (step.args.reuseQuery === true && queryCount !== 1) {
              throw new Error("the second prompt launched another SDK query");
            }
            if (input) {
              const written = await input.next();
              if (written.done) throw new Error("SDK input ended before the prompt");
              const uuid = isRecord(written.value) ? written.value.uuid : undefined;
              promptUuid = typeof uuid === "string" ? uuid : undefined;
            }
            return;
          }
          case "answer": {
            const id = live();
            const allow = step.args.decision === "allow";
            const [interaction] = getPendingInteractions(id);
            const [question] = getPendingQuestions(id);
            const [plan] = getPendingPlanApprovals(id);
            if (interaction) {
              respondToInteraction(interaction.id, { action: allow ? "accept" : "decline" }, id);
            } else if (plan) {
              respondToPlanApproval(plan.id, allow);
            } else if (question && !allow) {
              dismissQuestion(question.id);
            } else {
              throw new Error("nothing pending to answer");
            }
            await settleDecisions();
            return;
          }
          case "interrupt":
            if (step.args.graceful === true) {
              const answered = await gracefulInterruptClaudeSession(live());
              if (!answered.interrupted || interruptRequests === 0) {
                throw new Error("the graceful interrupt did not reach the SDK control");
              }
              return;
            }
            abortSession(live());
            await prompt;
            return;
          case "end":
            call?.finish();
            await prompt;
            await waitFor(() => getSession(live())?.claudeRuntime === undefined, 5_000);
            return;
          case "settle": {
            // A turn that released to background work keeps its prompt open
            // until that work settles; the turn itself is over once idle.
            const id = live();
            await waitFor(
              () => promptOutcome !== undefined || getSession(id)?.status === "idle",
              5_000,
            );
            return;
          }
          case "resume": {
            mockSdkGetSessionMessages.mockImplementation(async () => rollout);
            const session = await materializePersistedSession();
            sessionId = session.id;
            await hydratePersistedSessionMessages(session.id);
            return;
          }
          default:
            throw new Error(`unsupported action ${step.action}`);
        }
      },

      async snapshot() {
        const id = live();
        const session = getSession(id)!;
        const source = claudeTranscriptSource(id, "replay")?.source;
        if (!source) throw new Error("session has no transcript source");
        const derived = sdkSessionIdFromBridgeId(id);
        const providerSessionId =
          session.sdkSessionId === undefined
            ? "none"
            : session.sdkSessionId === derived
              ? "derived from the bridge id"
              : session.sdkSessionId === PERSISTED_SDK_ID
                ? "the persisted rollout's"
                : session.sdkSessionId;
        return {
          transcript: source,
          activity: await getSessionActivity(id),
          completion: {
            status: session.status,
            ...(promptOutcome ? { prompt: promptOutcome } : {}),
          },
          pending: [
            ...getPendingInteractions(id).map((entry) => ({
              kind: entry.kind,
              ...("toolName" in entry ? { toolName: entry.toolName } : {}),
            })),
            ...getPendingQuestions(id).map(() => ({ kind: "question" })),
            ...getPendingPlanApprovals(id).map(() => ({ kind: "plan-approval" })),
          ],
          drift: sessionHealth(session).drift(),
          extra: {
            providerSessionId,
            ...(fixture.header.scenario === "late-background-output"
              ? {
                  taskStatuses: Object.values(
                    backgroundTasksForSnapshot(session.backgroundTasks) ?? {},
                  )
                    .map((task) => task.status)
                    .sort(),
                }
              : {}),
            ...(expectedRekey
              ? { adoptedProviderSessionId: providerSessionId === expectedRekey }
              : {}),
            ...(decisions.length > 0 ? { decisions: [...decisions] } : {}),
          },
        };
      },

      async stop() {
        if (sessionId && getSession(sessionId)?.status === "running") abortSession(sessionId);
        call?.finish();
        await prompt;
      },
    };
  },
};

runProviderReplaySuite(adapter);

test("Claude records and replays prompt, SDK frames, and canUseTool", async () => {
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
  const first = capture.steps[0];
  expect(first).toMatchObject({ kind: "action", action: "prompt", args: {} });
  if (first?.kind !== "action") throw new Error("Missing recorded prompt");
  first.args.policy = "ask";
  const approval = capture.steps.findIndex(
    (step) => step.kind === "frame" && permissionRequest(step.frame),
  );
  expect(approval).toBeGreaterThan(0);
  capture.steps.splice(approval + 1, 0, {
    kind: "action",
    action: "answer",
    args: { decision: "deny" },
    line: 0,
  });
  capture.steps.push({ kind: "action", action: "settle", args: {}, line: 0 });
  const replayed = await replayProviderFixture(adapter, capture);
  expect(replayed.at(-1)?.extra?.decisions).toEqual(original.at(-1)?.extra?.decisions);
  expect(replayed.at(-1)?.rows.filter((row) => row.role === "assistant")).toEqual(
    original.at(-1)?.rows.filter((row) => row.role === "assistant"),
  );
});
