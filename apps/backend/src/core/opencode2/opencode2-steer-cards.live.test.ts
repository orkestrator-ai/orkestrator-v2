import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2Provider } from "./provider.js";
import type { OpenCode2Message } from "./types.js";

/**
 * A steer sent while the running turn is parked on a permission or question
 * card (to-do 7905 task 3), against a real pinned 2.x server and a scripted
 * local model (no credentials, no remote calls). What 2.2.6 does, pinned so a
 * bump that changes it fails here:
 *
 * - the steer is admitted (`applied`) and waits in the session's inbox; the
 *   card stays parked, the session stays `waiting`, and the model is not
 *   called;
 * - once the card is resolved (allowed, denied or answered) the tool settles
 *   and the steer is delivered at that step boundary, in the same run, once;
 * - a stop leaves the steer in the inbox, and the next prompt's run delivers
 *   it first (follow-up to-do 8100).
 *
 * Run with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the 2.x binary,
 * or through `mise run verify:opencode2:live`.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

let fixture: OpenCode2Fixture | undefined;
let provider: OpenCode2Provider | undefined;

const client = () =>
  new OpenCode2Client({
    baseUrl: fixture!.baseUrl,
    password: fixture!.password,
    directory: fixture!.directory,
  });

beforeAll(async () => {
  if (!live) return;
  fixture = await startOpenCode2Fixture(binary!, {
    permissions: [{ action: "shell", resource: "*", effect: "ask" }],
  });
  provider = new OpenCode2Provider(client());
}, 60_000);

afterAll(async () => {
  await provider?.dispose();
  await fixture?.stop();
});

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(150);
  }
}

async function pending(sessionId: string, kind: string): Promise<AgentInteractionRequest> {
  return until(async () =>
    (await provider!.interactions.listPendingInteractions(sessionId)).requests.find(
      (request) => request.kind === kind,
    ),
  );
}

async function idle(sessionId: string) {
  await until(async () => ((await provider!.activity(sessionId)) === "idle" ? true : undefined));
}

/** The history as a timeline, oldest first: user texts, tool states and run ends. */
async function timeline(sessionId: string): Promise<string[]> {
  const page = await client().listMessages(sessionId, { limit: 50 });
  return [...page.messages].reverse().flatMap((row: OpenCode2Message) => {
    if (row.type === "user") return [`user:${(row as { text: string }).text}`];
    if (row.type === "idle") return [`idle:${(row as { outcome: string }).outcome}`];
    if (row.type !== "assistant") return [];
    const content = (row as { content?: Array<Record<string, unknown>> }).content ?? [];
    return content.flatMap((part) =>
      part.type === "tool"
        ? [`tool:${String(part.name)}:${String((part.state as { status?: string })?.status)}`]
        : part.type === "text"
          ? [`text:${String(part.text)}`]
          : [],
    );
  });
}

function resolution(
  request: AgentInteractionRequest,
  action: AgentInteractionResolution["action"],
  answers?: Array<{ questionId: string; optionIds?: string[] }>,
): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: request.id,
    sessionId: request.sessionId,
    action,
    ...(answers
      ? {
          answer: {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            interactionId: request.id,
            sessionId: request.sessionId,
            answers,
          },
        }
      : {}),
    resolvedAt: Date.now() + 1_000,
  };
}

const steerCalls = (text: string) =>
  fixture!.model.calls.filter((call) => call.userTexts.at(-1) === text).length;

/** Park a card, steer the parked run, and check the steer waits behind the card. */
async function steerWhileParked(prompt: string, kind: string, steer: string, requestId: string) {
  const p = provider!;
  const id = await p.createSession("build", "steer-card", { model: "fixture/fixture" });
  await p.send(id, prompt, { requestId: `${requestId}-turn` });
  const card = await pending(id, kind);
  expect(await p.activity(id)).toBe("waiting");
  const run = await p.activeSteerRun(id);
  expect(run.state).toBe("running");
  expect(
    await p.performSessionAction(id, {
      kind: "steer",
      text: steer,
      requestId,
      expectedRunId: (run as { runId: string }).runId,
    }),
  ).toEqual({ outcome: "applied", requestId });
  expect(await p.steerStatus(id, requestId)).toBe("dispatched");
  // Held behind the card: still parked, still waiting, not yet with the model.
  await Bun.sleep(1_500);
  expect((await client().listInbox(id)).map((item) => item.payload?.text)).toEqual([steer]);
  expect((await p.interactions.listPendingInteractions(id)).requests.map((r) => r.id)).toEqual([
    card.id,
  ]);
  expect(await p.activity(id)).toBe("waiting");
  expect(steerCalls(steer)).toBe(0);
  return { id, card };
}

for (const decision of ["allowed", "denied"] as const) {
  liveTest(
    `a steer sent while a shell permission is parked is delivered in the same run once the card is ${decision}`,
    async () => {
      const p = provider!;
      const steer = `STEER_BEHIND_PERMISSION_${decision.toUpperCase()}`;
      const { id, card } = await steerWhileParked(
        `RUN_BASH:echo parked-${decision}`,
        "permission",
        steer,
        `steer-permission-${decision}`,
      );
      expect(
        (
          await p.interactions.resolveInteraction(
            id,
            card.id,
            decision === "allowed" ? resolution(card, "answer", []) : resolution(card, "deny"),
          )
        ).result,
      ).toBe("applied");
      await idle(id);
      expect(await timeline(id)).toEqual([
        `user:RUN_BASH:echo parked-${decision}`,
        `tool:shell:${decision === "allowed" ? "completed" : "error"}`,
        `user:${steer}`,
        `text:ack:${steer}`,
        "idle:succeeded",
      ]);
      expect(steerCalls(steer)).toBe(1);
      expect(await client().listInbox(id)).toEqual([]);
    },
    90_000,
  );
}

liveTest(
  "a steer sent while a question card is parked is delivered in the same run once it is answered",
  async () => {
    const p = provider!;
    const questions = {
      questions: [
        {
          question: "Which one?",
          header: "Pick",
          options: [
            { label: "First", description: "the first" },
            { label: "Second", description: "the second" },
          ],
        },
      ],
    };
    const prompt = `CALL_TOOL:question ${JSON.stringify(questions)}`;
    const steer = "STEER_BEHIND_QUESTION";
    const { id, card } = await steerWhileParked(prompt, "question", steer, "steer-question");
    const question = card.presentation.questions[0]!;
    expect(
      (
        await p.interactions.resolveInteraction(
          id,
          card.id,
          resolution(card, "answer", [
            { questionId: question.id, optionIds: [question.options[0]!.id] },
          ]),
        )
      ).result,
    ).toBe("applied");
    await idle(id);
    expect(await timeline(id)).toEqual([
      `user:${prompt}`,
      "tool:question:completed",
      `user:${steer}`,
      `text:ack:${steer}`,
      "idle:succeeded",
    ]);
    expect(steerCalls(steer)).toBe(1);
  },
  90_000,
);

liveTest(
  "a stop leaves a parked run's steer in the inbox, and the next run delivers it first (to-do 8100)",
  async () => {
    const p = provider!;
    const steer = "STEER_BEHIND_STOPPED_PERMISSION";
    const { id } = await steerWhileParked(
      "RUN_BASH:echo parked-stop",
      "permission",
      steer,
      "steer-stop",
    );
    await p.abort(id);
    await idle(id);
    expect((await p.interactions.listPendingInteractions(id)).requests).toEqual([]);
    expect((await client().listInbox(id)).map((item) => item.payload?.text)).toEqual([steer]);
    expect(steerCalls(steer)).toBe(0);

    await p.send(id, "the next prompt", { requestId: "after-stop" });
    await idle(id);
    expect(await timeline(id)).toEqual([
      "user:RUN_BASH:echo parked-stop",
      "tool:shell:error",
      "idle:interrupted",
      `user:${steer}`,
      `text:ack:${steer}`,
      "user:the next prompt",
      "text:ack:the next prompt",
      "idle:succeeded",
    ]);
  },
  90_000,
);
