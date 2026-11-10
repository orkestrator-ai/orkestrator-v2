import { describe, expect, test } from "bun:test";
import { routingBuildPrompt } from "../../apps/desktop/scripts/dev/coordinator-live-routing";
import {
  FAKE_BUILD_REPLY,
  FAKE_WAKE_REPLY,
  offeredName,
  scriptedTurn,
} from "./coordinator-routing-fake-model-script";

const tools = (...names: string[]) =>
  names.map((name) => ({ type: "function", function: { name } }));
const COORDINATOR_TOOLS = tools(
  "mcp_orkestrator_get_launch_options",
  "mcp_orkestrator_create_ticket",
  "mcp_orkestrator_start_build_pipeline",
);
const CONTEXT = "Project: fixture at /tmp/fixture (id project-123)\nRole: read-only coordinator.";
const PROMPT = routingBuildPrompt({ platform: "pi", token: "abc123" });
const COMMIT = "a".repeat(40);
const system = { role: "system", content: CONTEXT };
const user = (content: string) => ({ role: "user", content });
const call = (name: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: name, type: "function", function: { name, arguments: "{}" } }],
});
const result = (value: unknown) => ({ role: "tool", content: JSON.stringify(value, null, 2) });
const launchOptions = result({
  agents: [],
  coordinatorBase: { baseBranch: "main", baseCommit: COMMIT, available: true },
});
const ticket = result({ ticket: { id: "ticket-9", title: "Add clampPercent with tests" } });

describe("coordinator routing fake model", () => {
  test("names Orkestrator tools as the runtime offers them", () => {
    const offered = ["bash", "mcp_orkestrator_create_ticket", "mcp__orkestrator__get_build"];
    expect(offeredName(offered, "create_ticket")).toBe("mcp_orkestrator_create_ticket");
    expect(offeredName(offered, "get_build")).toBe("mcp__orkestrator__get_build");
    expect(offeredName(offered, "start_build_pipeline")).toBeUndefined();
  });

  test("the build request reads the base, creates a ticket, then builds it on the defaults", () => {
    const base = [system, user(PROMPT)];
    expect(scriptedTurn({ messages: base, tools: COORDINATOR_TOOLS }).step).toEqual({
      kind: "tool",
      name: "mcp_orkestrator_get_launch_options",
      input: { projectId: "project-123" },
    });
    const created = scriptedTurn({
      messages: [...base, call("get"), launchOptions],
      tools: COORDINATOR_TOOLS,
    }).step;
    expect(created).toMatchObject({
      kind: "tool",
      name: "mcp_orkestrator_create_ticket",
      input: { projectId: "project-123", acceptanceCriteria: expect.stringContaining("bun test") },
    });
    const started = scriptedTurn({
      messages: [...base, call("get"), launchOptions, call("create"), ticket],
      tools: COORDINATOR_TOOLS,
    }).step;
    expect(started).toMatchObject({
      kind: "tool",
      name: "mcp_orkestrator_start_build_pipeline",
      input: { taskId: "ticket-9", baseBranch: "main", baseCommit: COMMIT },
    });
    // The saved defaults: no agent, steps, reviewers or preparation.
    const input = (started as { input: Record<string, unknown> }).input;
    for (const field of ["agentType", "steps", "reviewers", "reviewPreparation"]) {
      expect(input).not.toHaveProperty(field);
    }
    expect(
      scriptedTurn({
        messages: [...base, call("get"), launchOptions, call("create"), ticket, call("s"), ticket],
        tools: COORDINATOR_TOOLS,
      }).step,
    ).toEqual({ kind: "text", text: FAKE_BUILD_REPLY });
  });

  test("a wake is answered in text and counted once, with what it said", () => {
    const wake = user(
      '<orkestrator-peer-message version="1">Build pipeline `p1` was cancelled.\n- It was stopped on purpose, not by an error. If you did not cancel it yourself, the user did: that is their decision to stop this work. Do not restart, resume or rebuild it, and do not start another build for this ticket, unless the user asks you to.\nRead more: `get_build_pipeline { "pipelineId": "p1" }`.</orkestrator-peer-message>',
    );
    const first = scriptedTurn({ messages: [system, wake], tools: COORDINATOR_TOOLS });
    expect(first).toEqual({
      step: { kind: "text", text: FAKE_WAKE_REPLY },
      wake: { cancelled: true, userDecision: true, noRebuild: true, offersRestart: false },
    });
    const old = user(
      '<orkestrator-peer-message version="1">Build pipeline `p1` failed.\n- Error: Build cancelled</orkestrator-peer-message>',
    );
    expect(scriptedTurn({ messages: [system, old], tools: COORDINATOR_TOOLS }).wake).toEqual({
      cancelled: false,
      userDecision: false,
      noRebuild: false,
      offersRestart: false,
    });
  });

  test("the build's own session is parked; an unreadable base or ticket stops in text", () => {
    expect(scriptedTurn({ messages: [user(PROMPT)], tools: tools("bash") }).step).toEqual({
      kind: "park",
    });
    const step = scriptedTurn({
      messages: [system, user(PROMPT), call("get"), result({}), call("create"), ticket],
      tools: COORDINATOR_TOOLS,
    }).step;
    expect(step).toEqual({
      kind: "text",
      text: "The launch base or the ticket could not be read.",
    });
  });
});
