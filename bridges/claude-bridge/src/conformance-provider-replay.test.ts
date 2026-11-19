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
 * a different bridge id cannot carry verbatim.
 *
 * Actions: `prompt` (`text`, `options`, `policy`), `answer` (`decision`
 * allow | deny), `interrupt`, `end` (the CLI process exits), `settle` (wait
 * until the turn is over, which a turn released to background work reaches
 * before its prompt settles), `resume`.
 */
import {
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
  sendPrompt,
  track,
  waitFor,
  type QueryCall,
  type SdkSessionMessage,
} from "./services/session-manager-test-harness.js";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { runProviderReplaySuite } from "../../../tests/conformance/provider-replay/scenarios.js";
import type {
  ProviderReplayActionStep,
  ProviderReplayFrameStep,
} from "../../../tests/conformance/provider-replay/fixture.js";
import { claudeTranscriptSource } from "./routes/session-transcript.js";
import { sdkSessionIdFromBridgeId } from "./services/session-manager.js";
import { sessionHealth } from "./types/index.js";

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

function withDerivedId(frame: unknown, sessionId: string): unknown {
  const text = JSON.stringify(frame);
  if (!text.includes('"$derived"')) return frame;
  const derived = sdkSessionIdFromBridgeId(sessionId) ?? "";
  return JSON.parse(text.replaceAll('"$derived"', JSON.stringify(derived)));
}

function pendingCount(sessionId: string): number {
  return (
    getPendingInteractions(sessionId).length +
    getPendingQuestions(sessionId).length +
    getPendingPlanApprovals(sessionId).length
  );
}

runProviderReplaySuite({
  bridge: "claude",
  fixtureDir: join(import.meta.dir, "testing", "provider-replay"),
  async start() {
    const rollout: SdkSessionMessage[] = [];
    let sessionId: string | undefined;
    let call: QueryCall | undefined;
    let prompt: Promise<unknown> | undefined;
    let promptOutcome: string | undefined;
    const parked: ParkedCall[] = [];
    const decisions: Array<{ toolName: string; behavior: string }> = [];

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
        call.push(withDerivedId(step.frame, live()));
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
            watch(
              sendPrompt(
                sessionId,
                typeof step.args.text === "string" ? step.args.text : "Provider replay prompt",
                isRecord(step.args.options) ? step.args.options : undefined,
              ),
            );
            call = await nextQueryCall();
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
});
