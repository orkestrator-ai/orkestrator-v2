import { describe, expect, test } from "bun:test";
import {
  gapLongTask,
  gapShellCommand,
  gapSteps,
  gapTurnPrompt,
  gapWorkerTask,
  type GapToolsProbe,
} from "../../apps/desktop/scripts/dev/coordinator-live-gap-tools";
import {
  FAKE_REPLY,
  FAKE_WAKE_REPLY,
  FAKE_WORKER_REPLY,
  scriptedTurn,
} from "./coordinator-gap-tools-fake-model-script";

const tools = (...names: string[]) =>
  names.map((name) => ({ type: "function", function: { name } }));
const COORDINATOR_TOOLS = tools(
  "mcp_orkestrator_get_launch_options",
  "mcp_orkestrator_launch_environment",
  "mcp_orkestrator_fork_worker",
  "mcp_orkestrator_create_schedule",
  "mcp_orkestrator_pause_schedule",
  "mcp_orkestrator_update_schedule",
  "mcp_orkestrator_resume_schedule",
  "mcp_orkestrator_cancel_schedule",
);
const WORKER_TOOLS = tools("bash", "read", "write", "mcp_orkestrator_send_message");
const probe: GapToolsProbe = { platform: "pi", token: "abc123", projectId: "project-1" };
const COMMIT = "b".repeat(40);
const user = (content: string) => ({ role: "user", content });
const call = (name: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: name, type: "function", function: { name, arguments: "{}" } }],
});
const result = (value: unknown) => ({ role: "tool", content: JSON.stringify(value, null, 2) });

describe("coordinator gap-tools fake model", () => {
  test("a coordinator turn replays its numbered steps in order, filling placeholders", () => {
    const base = [
      { role: "system", content: "context" },
      user(gapTurnPrompt(gapSteps.launch(probe))),
    ];
    expect(scriptedTurn({ messages: base, tools: COORDINATOR_TOOLS })).toEqual({
      speaker: "coordinator",
      step: {
        kind: "tool",
        name: "mcp_orkestrator_get_launch_options",
        input: { projectId: "project-1" },
      },
    });
    const launched = scriptedTurn({
      messages: [
        ...base,
        call("get"),
        result({ coordinatorBase: { baseBranch: "main", baseCommit: COMMIT } }),
      ],
      tools: COORDINATOR_TOOLS,
    }).step;
    expect(launched).toMatchObject({
      kind: "tool",
      name: "mcp_orkestrator_launch_environment",
      input: {
        projectId: "project-1",
        baseBranch: "main",
        baseCommit: COMMIT,
        agent: "pi",
        prompt: gapWorkerTask(probe),
      },
    });
    const done = scriptedTurn({
      messages: [...base, call("get"), result({}), call("launch"), result({})],
      tools: COORDINATOR_TOOLS,
    }).step;
    // The base could not be filled from an empty result, so nothing is launched.
    expect(
      scriptedTurn({ messages: [...base, call("get"), result({})], tools: COORDINATOR_TOOLS }).step,
    ).toMatchObject({ kind: "text" });
    expect(done).toEqual({ kind: "text", text: FAKE_REPLY });
  });

  test("schedule edits carry the created schedule's id", () => {
    const base = [user(gapTurnPrompt(gapSteps.schedules(probe)))];
    const created = result({ scheduleId: "job-7", state: "active" });
    const steps = [1, 2, 3, 4].map(
      (index) =>
        scriptedTurn({
          messages: [
            ...base,
            call("create"),
            created,
            ...Array.from({ length: index - 1 }, () => [call("edit"), result({})]).flat(),
          ],
          tools: COORDINATOR_TOOLS,
        }).step,
    );
    expect(steps).toEqual([
      { kind: "tool", name: "mcp_orkestrator_pause_schedule", input: { scheduleId: "job-7" } },
      {
        kind: "tool",
        name: "mcp_orkestrator_update_schedule",
        input: { scheduleId: "job-7", at: "+7h" },
      },
      { kind: "tool", name: "mcp_orkestrator_resume_schedule", input: { scheduleId: "job-7" } },
      { kind: "tool", name: "mcp_orkestrator_cancel_schedule", input: { scheduleId: "job-7" } },
    ]);
  });

  test("a step whose tool is not offered is answered in text, not called", () => {
    const step = scriptedTurn({
      messages: [user(gapTurnPrompt(gapSteps.refusals(probe, "env-w")))],
      tools: COORDINATOR_TOOLS,
    }).step;
    expect(step).toEqual({ kind: "text", text: "The resolve_conflicts tool is not offered." });
  });

  test("a wake gets one line, and says whether the coordinator stopped the turn", () => {
    const wake = (body: string) =>
      scriptedTurn({
        messages: [
          user(`<orkestrator-peer-message from="system">${body}</orkestrator-peer-message>`),
        ],
        tools: COORDINATOR_TOOLS,
      });
    expect(
      wake(
        "Worker gap stopped because you stopped its turn with stop_worker_turn, before it sent a report.",
      ),
    ).toEqual({
      speaker: "coordinator",
      step: { kind: "text", text: FAKE_WAKE_REPLY },
      wake: { stoppedByCoordinator: true },
    });
    expect(wake("Worker gap finished without sending a report.").wake).toEqual({
      stoppedByCoordinator: false,
    });
  });

  test("the worker runs its one command, then says ready", () => {
    const base = [user(`From your coordinator:\n${gapWorkerTask(probe)}`)];
    expect(scriptedTurn({ messages: base, tools: WORKER_TOOLS })).toEqual({
      speaker: "worker",
      step: { kind: "tool", name: "bash", input: { command: gapShellCommand(probe) } },
    });
    expect(
      scriptedTurn({ messages: [...base, call("bash"), result("ok")], tools: WORKER_TOOLS }).step,
    ).toEqual({ kind: "text", text: FAKE_WORKER_REPLY });
  });

  test("the worker's long turn parks; a request offered no tools gets one line", () => {
    expect(scriptedTurn({ messages: [user(gapLongTask())], tools: WORKER_TOOLS }).step).toEqual({
      kind: "park",
    });
    // A compaction summary sees the whole conversation, long turn included, with no tools.
    expect(
      scriptedTurn({ messages: [user(`${gapWorkerTask(probe)}\n${gapLongTask()}`)], tools: [] }),
    ).toEqual({ speaker: "other", step: { kind: "text", text: FAKE_REPLY } });
  });
});
