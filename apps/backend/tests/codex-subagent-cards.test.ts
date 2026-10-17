/**
 * Codex sub-agent cards through the real bridge and backend projection.
 *
 * The qualification in docs/todo/live-provider-and-platform-qualification.md
 * ("Codex sub-agent cards"), automated: the scenario of the duplicate-card
 * incident (#602, #972) — three path-only spawns that succeed, one rejected at
 * capacity, child ids known only from live activity — driven by a fake
 * app-server into a real codex-bridge process and read back the way a tab reads
 * it. Each successful child must keep exactly one card with its own identity,
 * nested transcript and current status through every way a reader can come
 * back to it: a backend that never saw the turn run, and a cold restart of
 * bridge and backend whose only evidence is on disk.
 *
 * The browser half (pinning, grouping, reload, expanding the nested
 * transcript) is `e2e/CodexSubagentCards.spec.ts`, over the same stack.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";

import { startSubagentStack, type SubagentStack } from "./codex-subagent-stack.js";

/** Spawns three processes and replays a cold start; never the default 5 s. */
const STACK_TEST_TIMEOUT_MS = 120_000;

interface Card {
  id: string | undefined;
  name: string | undefined;
  state: string | undefined;
  actions: string[];
}

function cards(projection: NativeAgentSessionProjection): Card[] {
  return (projection.messages as Array<{ parts?: Array<Record<string, unknown>> }>)
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "subagent")
    .map((part) => ({
      id: part.subagentId as string | undefined,
      name: (part.subagentName ?? part.subagentRole) as string | undefined,
      state: part.toolState as string | undefined,
      actions: ((part.subagentActions ?? []) as Array<Record<string, unknown>>).map((action) =>
        action.type === "tool-invocation"
          ? `tool:${String(action.toolName)}`
          : String(action.content),
      ),
    }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

const childCards = (projection: NativeAgentSessionProjection) =>
  cards(projection).filter((card) => card.id !== undefined);

const rejectedCard = {
  id: undefined,
  name: "extra_check",
  state: "failure",
  actions: ["Agent could not start: agent limit reached."],
};

function runningChildren(ids: readonly string[]) {
  return [
    { id: ids[0], name: "Ada", state: "pending", actions: ["tool:exec_command"] },
    { id: ids[1], name: "Grace", state: "pending", actions: ["tool:exec_command"] },
    { id: ids[2], name: "Linus", state: "pending", actions: ["tool:exec_command"] },
  ];
}

function finishedChildren(ids: readonly string[]) {
  return [
    {
      id: ids[0],
      name: "Ada",
      state: "success",
      actions: ["tool:exec_command", "lint_check passed."],
    },
    {
      id: ids[1],
      name: "Grace",
      state: "success",
      actions: ["tool:exec_command", "type_check passed."],
    },
    {
      id: ids[2],
      name: "Linus",
      state: "success",
      actions: ["tool:exec_command", "unit_check passed."],
    },
  ];
}

/** The whole card set: three children by name, then the rejected spawn. */
const allCards = (children: Card[]) =>
  [...children, rejectedCard].sort((left, right) =>
    String(left.name).localeCompare(String(right.name)),
  );

let stack: SubagentStack | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

describe("Codex sub-agent cards through the bridge and backend projection", () => {
  test(
    "each child keeps one card, its transcript and status across a fresh backend and a cold restart",
    async () => {
      stack = await startSubagentStack();
      await stack.prompt();

      // Running: three identified children and the rejected spawn, once each.
      const running = await stack.waitForProjection(
        (projection) =>
          childCards(projection).length >= 3 &&
          cards(projection).some((card) => card.name === "extra_check"),
        "three child cards and the rejected spawn",
      );
      const ids = childCards(running).map((card) => card.id!);
      expect(new Set(ids).size).toBe(3);
      expect(cards(running)).toEqual(allCards(runningChildren(ids)));
      expect(running.turn.phase).toBe("running");

      // A backend that never saw the spawns, over the live bridge (a reload).
      await stack.reopenBackend();
      expect(cards(await stack.projection())).toEqual(allCards(runningChildren(ids)));

      // The children finish while nobody reads: the backend is replaced before
      // the first read after the fact, as for a tab in an inactive environment.
      await stack.finishChildren();
      await stack.reopenBackend();
      const finished = await stack.waitForProjection(
        (projection) =>
          projection.turn.phase === "idle" &&
          childCards(projection).every((card) => card.state === "success"),
        "every child to finish and the turn to end",
      );
      expect(cards(finished)).toEqual(allCards(finishedChildren(ids)));

      // Cold: new bridge, new app-server, new backend. Identity now comes from
      // the child rollouts' session_meta headers alone.
      await stack.restart();
      expect(stack.bridgeGeneration).toBe(2);
      const cold = await stack.projection();
      expect(cold.turn.phase).toBe("idle");
      expect(cards(cold)).toEqual(allCards(finishedChildren(ids)));
    },
    STACK_TEST_TIMEOUT_MS,
  );
});
