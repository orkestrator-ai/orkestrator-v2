import { describe, expect, mock, test } from "bun:test";
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
      const push = mock(runtime.input.push);
      runtime.input.push = push;
      // Retention belongs to the old turn and must survive a failed setup.
      first.session.retainedQueryControls = new Set([runtime.control]);
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
        expect(first.session.retainedQueryControls.has(runtime.control)).toBe(true);
        expect(runtime.latestTurn).toBe(first.thisTurn);
        expect(Array.from(runtime.waitingTurns)).toEqual([first.thisTurn!]);
        expect(first.superseded).toBe(false);
        expect(runtime.state).toBe("open");
        expect(runtime.abortController.signal.aborted).toBe(false);
        expect(call.isClosed()).toBe(false);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        if (failure !== "input") expect(push).not.toHaveBeenCalled();
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
