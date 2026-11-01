import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createPromptTurnForTesting,
  createSession,
  mockQuery,
  nextQueryCall,
  queryControlOverrides,
  track,
} from "./session-manager-test-harness.js";
import { runTurnOnRuntime } from "./session-manager-prompt-launch.js";
import { resolveQueryPlan } from "./session-manager-prompt-query.js";
import { finalizeTurn } from "./session-manager-prompt-settle.js";
import type { TurnState } from "./session-manager-prompt-turn.js";
import { createClaudeRuntimeTurn } from "./session-manager-prompt-runtime-turn.js";

import { setClaudeLinuxSandboxStatusForTests } from "@orkestrator/protocol/node/claude-linux-sandbox";
import { claudeReportedPolicy } from "./claude-query-config.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  setClaudeLinuxSandboxStatusForTests({ available: true });
});

function preparedTurn() {
  const session = createSession("launch");
  track(session.id);
  return createPromptTurnForTesting(session);
}

async function launchedTurn() {
  const { turn, sdkTextPrompt } = preparedTurn();
  const plan = await resolveQueryPlan(turn, sdkTextPrompt, undefined);
  expect(await runTurnOnRuntime(turn, plan, undefined)).toBe(true);
  const call = await nextQueryCall();
  const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
  expect((await input.next()).done).toBe(false);
  return { turn, plan, call, input, runtime: turn.runtime! };
}

function followUp(turn: TurnState) {
  // A released foreground leaves its process open, as a background-task turn does.
  turn.session.status = "idle";
  turn.session.abortController = undefined;
  return createPromptTurnForTesting(turn.session);
}

describe("runTurnOnRuntime", () => {
  test.each([true, false])(
    "uses the planned sandbox at launch, replacement and join (initially available: %s)",
    async (available) => {
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      const reason = "Fixture host cannot start the command sandbox.";
      const probe = (works: boolean, unavailableReason = reason) =>
        setClaudeLinuxSandboxStatusForTests(
          works
            ? { available: true }
            : { available: false, failure: "missing-programs", reason: unavailableReason },
        );
      const boundary = (works: boolean) => (works ? "required" : "unavailable");
      const assertReport = (turn: TurnState, works: boolean) => {
        expect(turn.runtime!.launch.readOnlyCommandSandbox?.commandSandbox).toBe(boundary(works));
        expect(JSON.parse(turn.runtime!.launch.boundary).commandSandbox).toBe(boundary(works));
        expect(turn.session.readOnlyCommandSandboxOff).toBe(works ? undefined : reason);
        expect(claudeReportedPolicy(turn.session)?.sandbox).toBe(works ? "provider" : "none");
      };
      probe(available);
      const session = createSession("sandbox probe changes during preparation");
      track(session.id);
      const first = createPromptTurnForTesting(session, { readOnly: true });
      const turns = [first.turn];
      try {
        const firstPlan = await resolveQueryPlan(first.turn, first.sdkTextPrompt, undefined);
        probe(!available);
        await runTurnOnRuntime(first.turn, firstPlan, undefined);
        const call = await nextQueryCall();
        expect(call.options.sandbox).toMatchObject({ enabled: available });
        assertReport(first.turn, available);
        const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        await input.next();

        session.status = "idle";
        session.abortController = undefined;
        const second = createPromptTurnForTesting(session, { readOnly: true });
        turns.push(second.turn);
        const secondPlan = await resolveQueryPlan(second.turn, second.sdkTextPrompt, undefined);
        expect(session.readOnlyCommandSandboxOff).toBe(available ? undefined : reason);
        probe(available);
        const replacing = runTurnOnRuntime(second.turn, secondPlan, undefined);
        // A CLI launched with the other boundary must retire before replacement.
        expect((await input.next()).done).toBe(true);
        call.finish();
        await replacing;
        const replacement = await nextQueryCall();
        expect(replacement.options.sandbox).toMatchObject({ enabled: !available });
        expect(second.turn.runtime).not.toBe(first.turn.runtime);
        assertReport(second.turn, !available);

        // A joining turn uses its plan even if the probe changes again. Keeping
        // a continuation owed also exercises the post-plan refusal check.
        probe(!available, "A later probe reports a different missing-sandbox reason.");
        session.status = "idle";
        session.abortController = undefined;
        const third = createPromptTurnForTesting(session, { readOnly: true });
        turns.push(third.turn);
        const thirdPlan = await resolveQueryPlan(third.turn, third.sdkTextPrompt, undefined);
        second.turn.awaitingContinuation = true;
        probe(available);
        await runTurnOnRuntime(third.turn, thirdPlan, undefined);
        expect(third.turn.runtime).toBe(second.turn.runtime);
        expect(mockQuery).toHaveBeenCalledTimes(2);
        assertReport(third.turn, !available);
      } finally {
        session.claudeRuntime?.abortController.abort();
        await session.claudeRuntime?.ended;
        for (const turn of turns) finalizeTurn(turn);
      }
    },
  );

  test("launches one process, registers its turn and cleans it up on stream exhaustion", async () => {
    const started = mock(() => {});
    const { turn, sdkTextPrompt } = preparedTurn();
    const plan = await resolveQueryPlan(turn, sdkTextPrompt, undefined);
    try {
      expect(await runTurnOnRuntime(turn, plan, { onQueryStarted: started })).toBe(true);
      const runtime = turn.runtime!;
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(turn.queryStarted).toBe(true);
      expect(started).toHaveBeenCalledTimes(1);
      expect(turn.session.claudeRuntime).toBe(runtime);
      expect(turn.session.queryControl).toBe(runtime.control);
      expect(runtime.latestTurn).toBe(turn.thisTurn);
      expect(runtime.waitingTurns.has(turn.thisTurn!)).toBe(true);
      const call = await nextQueryCall();
      call.finish();
      await runtime.ended;
      await turn.turnEnded;
      expect(runtime.state).toBe("ended");
      expect(runtime.waitingTurns.size).toBe(0);
      expect(turn.session.claudeRuntime).toBeUndefined();
      expect(turn.session.queryControl).toBeUndefined();
      expect(call.isClosed()).toBe(true);
    } finally {
      turn.abortController.abort();
      await turn.runtime?.ended;
      finalizeTurn(turn);
    }
  });

  test("joins an open runtime and transfers ownership without launching another process", async () => {
    const { turn: first, runtime, call, input } = await launchedTurn();
    const { turn: second, sdkTextPrompt } = followUp(first);
    const plan = await resolveQueryPlan(second, sdkTextPrompt, undefined);
    try {
      expect(await runTurnOnRuntime(second, plan, undefined)).toBe(true);
      const message = (await input.next()).value as SDKUserMessage;
      expect(message.uuid).toBe(second.promptUuid);
      expect(message.message.content).toEqual([{ type: "text", text: sdkTextPrompt }]);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(second.runtime).toBe(runtime);
      expect(second.queryStarted).toBe(true);
      expect(first.superseded).toBe(true);
      await first.turnEnded;
      expect(runtime.latestTurn).toBe(second.thisTurn);
      expect(Array.from(runtime.waitingTurns)).toEqual([second.thisTurn!]);
      // Abort follows the new turn even though the first one launched the CLI.
      second.abortController.abort();
      await runtime.ended;
      await second.turnEnded;
      expect(runtime.abortController.signal.aborted).toBe(true);
      expect(call.isClosed()).toBe(true);
    } finally {
      runtime.abortController.abort();
      await runtime.ended;
      finalizeTurn(second);
      finalizeTurn(first);
    }
  });

  test("a warm join records layer movement even when inline configuration is unchanged", async () => {
    const { turn: first, runtime, input } = await launchedTurn();
    const { turn: second, sdkTextPrompt } = followUp(first);
    const plan = await resolveQueryPlan(second, sdkTextPrompt, undefined);
    first.session.mcpServerLayers = new Map([["db", "local"]]);
    plan.mcpServerLayers = new Map([["db", "project"]]);
    expect(plan.mcpServersKey).toBe(runtime.mcpServers);
    try {
      await runTurnOnRuntime(second, plan, undefined);
      expect((await input.next()).value?.uuid).toBe(second.promptUuid);
      expect(second.runtime).toBe(runtime);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(first.session.mcpServerLayers?.get("db")).toBe("project");
    } finally {
      runtime.abortController.abort();
      await runtime.ended;
      finalizeTurn(second);
      finalizeTurn(first);
    }
  });

  test.each(["settings", "MCP", "input"])(
    "a failed %s join abandons claims and keeps the old runtime",
    async (failure) => {
      const setModel = mock(async () => {});
      const setMcpServers = mock(async () => ({ errors: {} }));
      queryControlOverrides.setModel = setModel;
      queryControlOverrides.setMcpServers = setMcpServers;
      const { turn: first, runtime, call } = await launchedTurn();
      const { turn: second, sdkTextPrompt } = followUp(first);
      const plan = await resolveQueryPlan(second, sdkTextPrompt, undefined);
      const oldLayers = new Map([["db", "local"]] as const);
      first.session.mcpServerLayers = oldLayers;
      plan.mcpServerLayers = new Map([["db", "project"]]);
      const push = mock(runtime.input.push);
      runtime.input.push = push;
      // The continuation the old turn waits for must survive a failed setup.
      first.awaitingContinuation = true;
      let expected: string;
      if (failure === "settings") {
        setModel.mockImplementation(async () => {
          throw new Error("Setting failed");
        });
        expected = "Setting failed";
      } else if (failure === "MCP") {
        plan.mcpServersKey = "changed-config";
        setMcpServers.mockImplementation(async () => {
          throw new Error("MCP unavailable");
        });
        expected = "MCP configuration could not be applied";
      } else {
        push.mockReturnValue(false);
        expected = "could not accept prompt input";
      }
      try {
        await expect(runTurnOnRuntime(second, plan, undefined)).rejects.toThrow(expected);
        expect(second.runtime).toBeUndefined();
        expect(second.queryIteratorControl).toBeUndefined();
        expect(second.queryStarted).toBe(false);
        expect(first.session.queryControl).toBeUndefined();
        expect(first.session.claudeRuntime).toBe(runtime);
        expect(first.awaitingContinuation).toBe(true);
        expect(runtime.latestTurn).toBe(first.thisTurn);
        expect(Array.from(runtime.waitingTurns)).toEqual([first.thisTurn!]);
        expect(first.superseded).toBe(false);
        expect(runtime.state).toBe("open");
        expect(runtime.abortController.signal.aborted).toBe(false);
        expect(call.isClosed()).toBe(false);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        if (failure !== "input") {
          expect(push).not.toHaveBeenCalled();
          expect(first.session.mcpServerLayers).toBe(oldLayers);
        }
        if (failure === "MCP") expect(runtime.mcpServers).toBe("");
      } finally {
        call.finish();
        await runtime.ended;
        await first.turnEnded;
        finalizeTurn(second);
        finalizeTurn(first);
      }
    },
  );

  test("a stopped turn never launches a process", async () => {
    const { turn, sdkTextPrompt } = preparedTurn();
    const plan = await resolveQueryPlan(turn, sdkTextPrompt, undefined);
    turn.abortController.abort();
    try {
      expect(await runTurnOnRuntime(turn, plan, undefined)).toBe(false);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(turn.queryStarted).toBe(false);
      expect(turn.runtime).toBeUndefined();
    } finally {
      finalizeTurn(turn);
    }
  });

  test("a handler exception rejects its waiting turn and resolves other waiters", async () => {
    const { turn, runtime, call } = await launchedTurn();
    const other = preparedTurn().turn;
    other.thisTurn = createClaudeRuntimeTurn(other);
    runtime.waitingTurns.add(other.thisTurn);
    const error = new Error("Frame handler failed");
    turn.thisTurn!.handleMessage = mock(async () => {
      throw error;
    });
    try {
      call.push({ type: "assistant", parent_tool_use_id: null });
      await expect(turn.turnEnded).rejects.toBe(error);
      await other.turnEnded;
      await runtime.ended;
      expect(runtime.state).toBe("ended");
      expect(runtime.waitingTurns.size).toBe(0);
      expect(turn.session.claudeRuntime).toBeUndefined();
      expect(turn.session.queryControl).toBeUndefined();
      expect(call.isClosed()).toBe(true);
    } finally {
      runtime.abortController.abort();
      await runtime.ended;
      finalizeTurn(other);
      finalizeTurn(turn);
    }
  });

  test("a superseded turn's handler failure rejects the newest waiting turn", async () => {
    const { turn: first, runtime, call } = await launchedTurn();
    const { turn: second, sdkTextPrompt } = followUp(first);
    const plan = await resolveQueryPlan(second, sdkTextPrompt, undefined);
    const error = new Error("Old subagent handler failed");
    first.thisTurn!.handleMessage = mock(async () => {
      throw error;
    });
    runtime.toolOwners.set("old-agent-call", first.thisTurn!);
    try {
      await runTurnOnRuntime(second, plan, undefined);
      await first.turnEnded;
      call.push({ type: "assistant", parent_tool_use_id: "old-agent-call" });
      await expect(second.turnEnded).rejects.toBe(error);
      await runtime.ended;
      expect(runtime.waitingTurns.size).toBe(0);
      expect(second.session.claudeRuntime).toBeUndefined();
      expect(call.isClosed()).toBe(true);
    } finally {
      runtime.abortController.abort();
      await runtime.ended;
      finalizeTurn(second);
      finalizeTurn(first);
    }
  });
});
