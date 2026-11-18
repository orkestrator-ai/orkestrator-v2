import { describe, expect, mock, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  captureEvents,
  getPendingInteractions,
  getPendingPlanApprovals,
  getPendingQuestions,
  getSession,
  answerQuestion,
  nextQueryCall,
  queryControlOverrides,
  releaseWithBackgroundWork,
  respondToInteraction,
  respondToPlanApproval,
  sendPrompt,
  waitFor,
} from "./session-manager-test-harness.js";

// A prompt written into a CLI that outlived its turn (a rejoin) re-reads what
// that CLI still waits on: the SDK redelivers each permission request the
// CLI's initialize answer lists, and each becomes one card. A tab that remounts
// only reads the cards the bridge already holds. The real CLI's side of this
// is proved by `claude-rejoin-requests.live.test.ts`.

type QueryCall = Awaited<ReturnType<typeof nextQueryCall>>;
type Decision = Awaited<ReturnType<NonNullable<QueryCall["options"]["canUseTool"]>>>;

const ASK: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "ask",
  projectResources: true,
  networkAccess: "full",
};

const WRITE = { file_path: "/workspace/notes.txt", content: "notes" };

/** What the SDK hands `canUseTool` for a request the CLI sent or listed. */
function cliRequest(requestId: string, signal = new AbortController().signal) {
  return { signal, requestId, toolUseID: `tool-${requestId}` } as never;
}

/**
 * Launch a session whose CLI stays open after its first turn, with
 * `reinitialize` answered by `onReinitialize` (or absent when it is undefined).
 */
async function survivingCli(name: string, onReinitialize?: (call: QueryCall) => Promise<unknown>) {
  let current: QueryCall | undefined;
  const reinitialize = mock(() => onReinitialize!(current!));
  if (onReinitialize) queryControlOverrides.reinitialize = reinitialize;
  const launched = await releaseWithBackgroundWork(name, "agent-bg", undefined, ASK);
  current = launched.call;
  launched.firstPrompt.catch(() => undefined);
  return { ...launched, reinitialize };
}

/**
 * Write a follow-up into the surviving CLI and wait until it is submitted. The
 * prompt itself stays open while the CLI's background agent runs; the
 * harness's teardown settles it.
 */
async function rejoin(
  session: { id: string },
  input: AsyncIterator<SDKUserMessage>,
  text = "carry on",
): Promise<void> {
  sendPrompt(session.id, text).catch(() => undefined);
  const written = await input.next();
  expect(written.done).toBe(false);
}

describe("rejoining a live Claude CLI", () => {
  test("a request only the CLI still holds becomes one card, even when the replay overlaps", async () => {
    const decisions: Array<Promise<Decision>> = [];
    const { session, call, input, reinitialize } = await survivingCli(
      "rejoin-recover",
      async (call) => {
        // The SDK redelivers what the answer listed, and the same request id
        // can also arrive live: both deliveries land while the card is open.
        decisions.push(call.options.canUseTool!("Write", WRITE, cliRequest("cli-only")));
        decisions.push(call.options.canUseTool!("Write", WRITE, cliRequest("cli-only")));
        return {};
      },
    );
    const capture = captureEvents();
    try {
      expect(getPendingInteractions(session.id)).toEqual([]);
      await rejoin(session, input);
      expect(reinitialize).toHaveBeenCalledTimes(1);
      expect(session.claudeRuntime?.rejoins).toBe(1);
      await waitFor(() => getPendingInteractions(session.id).length === 1);
      expect(getPendingInteractions(session.id)[0]).toMatchObject({
        id: "cli-only",
        kind: "file-approval",
        toolUseId: "tool-cli-only",
      });
      const requested = capture.events.filter((event) => event.type === "interaction.requested");
      expect(requested).toHaveLength(1);

      expect(respondToInteraction("cli-only", { action: "accept" }, session.id)).toBe(true);
      for (const decision of await Promise.all(decisions)) {
        expect(decision).toEqual({ behavior: "allow", updatedInput: WRITE });
      }
      // A replay that crossed the answer is refused rather than shown again.
      const late = await call.options.canUseTool!("Write", WRITE, cliRequest("cli-only"));
      expect(late).toEqual({
        behavior: "deny",
        message: "This permission request was already answered.",
      });
      expect(getPendingInteractions(session.id)).toEqual([]);
    } finally {
      capture.stop();
    }
  });

  test.each([
    ["answers without any inventory", async () => ({})],
    ["cannot re-read it", undefined],
    ["fails the re-read", async () => Promise.reject(new Error("Query closed"))],
  ] as const)(
    "a CLI that %s leaves the inventory unknown: the cards held stand",
    async (_label, onReinitialize) => {
      const { session, call, input } = await survivingCli(
        `rejoin-unknown-${_label.length}`,
        onReinitialize,
      );
      // A background agent asked before the rejoin; the bridge holds its card.
      const decision = call.options.canUseTool!("Write", WRITE, cliRequest("held"));
      await waitFor(() => getPendingInteractions(session.id).length === 1);
      await rejoin(session, input);
      expect(session.claudeRuntime?.rejoins).toBe(1);
      expect(getPendingInteractions(session.id).map((card) => card.id)).toEqual(["held"]);
      expect(respondToInteraction("held", { action: "accept" }, session.id)).toBe(true);
      expect(await decision).toEqual({ behavior: "allow", updatedInput: WRITE });
    },
  );

  test("a request the CLI withdrew cannot be approved, whatever its card", async () => {
    const { session, call } = await survivingCli("rejoin-withdrawn");
    const cli = new AbortController();
    const approval = call.options.canUseTool!("Write", WRITE, cliRequest("tool", cli.signal));
    const question = call.options.canUseTool!(
      "AskUserQuestion",
      { questions: [{ question: "Which file?", options: [] }] },
      cliRequest("question", cli.signal),
    );
    const plan = call.options.canUseTool!(
      "ExitPlanMode",
      { plan: "# Plan" },
      cliRequest("plan", cli.signal),
    );
    await waitFor(
      () =>
        getPendingInteractions(session.id).length === 1 &&
        getPendingQuestions(session.id).length === 1 &&
        getPendingPlanApprovals(session.id).length === 1,
    );
    cli.abort();
    // Taken down in the same tick: no answer can land on them.
    expect(getPendingInteractions(session.id)).toEqual([]);
    expect(getPendingQuestions(session.id)).toEqual([]);
    expect(getPendingPlanApprovals(session.id)).toEqual([]);
    expect(respondToInteraction("tool", { action: "accept" }, session.id)).toBe(false);
    expect(answerQuestion("question", { "Which file?": "notes" })).toBe(false);
    expect(respondToPlanApproval("plan", true)).toBe(false);
    expect((await approval).behavior).toBe("deny");
    expect(await question).toEqual({ behavior: "deny", message: "The question was withdrawn" });
    expect(await plan).toEqual({ behavior: "deny", message: "The plan approval was withdrawn" });
  });

  test("a request from a CLI that has ended cannot be approved", async () => {
    const { session, call } = await survivingCli("rejoin-dead");
    // The SDK's own signal never fires here: only the process ending can.
    const approval = call.options.canUseTool!("Write", WRITE, cliRequest("dead-tool"));
    const question = call.options.canUseTool!(
      "AskUserQuestion",
      { questions: [{ question: "Still there?", options: [] }] },
      cliRequest("dead-question"),
    );
    await waitFor(
      () =>
        getPendingInteractions(session.id).length === 1 &&
        getPendingQuestions(session.id).length === 1,
    );
    const runtime = session.claudeRuntime!;
    call.finish();
    await waitFor(() => runtime.state === "ended");
    expect(runtime.requests.ended).toBe(true);
    expect(getPendingInteractions(session.id)).toEqual([]);
    expect(getPendingQuestions(session.id)).toEqual([]);
    expect(respondToInteraction("dead-tool", { action: "accept" }, session.id)).toBe(false);
    expect(answerQuestion("dead-question", { "Still there?": "yes" })).toBe(false);
    expect((await approval).behavior).toBe("deny");
    expect((await question).behavior).toBe("deny");
    // A delivery after the end never becomes a card.
    expect(await call.options.canUseTool!("Write", WRITE, cliRequest("after-end"))).toEqual({
      behavior: "deny",
      message: "The Claude process that asked for this permission has ended.",
    });
    expect(getPendingInteractions(session.id)).toEqual([]);
  });

  test("a tab remount reads the bridge's cards and is not a rejoin", async () => {
    const { session, call, input, reinitialize } = await survivingCli(
      "rejoin-remount",
      async () => ({}),
    );
    const decision = call.options.canUseTool!("Write", WRITE, cliRequest("remount"));
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    // What a remounting tab reads: the session and its cards, never the CLI.
    for (let read = 0; read < 3; read += 1) {
      getSession(session.id);
      getPendingInteractions(session.id);
      getPendingQuestions(session.id);
      getPendingPlanApprovals(session.id);
    }
    // A first launch is not a rejoin either.
    expect(reinitialize).not.toHaveBeenCalled();
    expect(session.claudeRuntime?.rejoins).toBe(0);
    expect(getPendingInteractions(session.id).map((card) => card.id)).toEqual(["remount"]);

    await rejoin(session, input);
    expect(reinitialize).toHaveBeenCalledTimes(1);
    expect(session.claudeRuntime?.rejoins).toBe(1);
    expect(respondToInteraction("remount", { action: "decline" }, session.id)).toBe(true);
    expect((await decision).behavior).toBe("deny");
  });
});
