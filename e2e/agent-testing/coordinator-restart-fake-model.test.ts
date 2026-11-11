import { describe, expect, test } from "bun:test";
import { renderAgentMailCarrier, type AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { classifyUsageLimitError } from "@orkestrator/protocol/agent-usage-limits";
import { buildPipelineStatus } from "../../apps/backend/src/core/coordinator-build-pipeline-status";
import {
  renderCoordinatorStatusNotice,
  statusOnNode,
} from "../../apps/backend/src/core/coordinator-status-wakes";
import {
  BUILD_MARKER,
  FAKE_BUILD_REPLY,
  FAKE_RESTART_REPLY,
  FAKE_WAKE_REPLY,
  USAGE_LIMIT_MESSAGE,
  carrierPayloads,
  restartRequestId,
  scriptedTurn,
  usageLimitRefusal,
} from "./coordinator-restart-fake-model-script";

const tools = (...names: string[]) =>
  names.map((name) => ({ type: "function", function: { name } }));
const COORDINATOR_TOOLS = tools(
  "mcp_orkestrator_get_launch_options",
  "mcp_orkestrator_create_ticket",
  "mcp_orkestrator_start_build_pipeline",
  "mcp_orkestrator_restart_build_pipeline_step",
);
const CONTEXT = "Project: fixture at /tmp/fixture (id project-123)\nRole: read-only coordinator.";
const COMMIT = "a".repeat(40);
const system = { role: "system", content: CONTEXT };
const user = (content: string) => ({ role: "user", content });
const call = (name: string, input: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id: name, type: "function", function: { name, arguments: JSON.stringify(input) } },
  ],
});
const result = (value: unknown) => ({ role: "tool", content: JSON.stringify(value, null, 2) });
const launchOptions = result({
  agents: [],
  coordinatorBase: { baseBranch: "main", baseCommit: COMMIT, available: true },
});
const ticket = result({ ticket: { id: "ticket-9", title: "Add wrapIndex with tests" } });

/** The wake a failed pipeline sends, rendered by the backend's own status and carrier code. */
function failedWake(pipelineId: string, node?: { id: string; name: string }): string {
  const snapshot = {
    phase: "failed",
    taskTitle: "Add wrapIndex with tests",
    error: `The build session failed: 429 ${USAGE_LIMIT_MESSAGE}`,
    failureContext: { phase: "building", kind: "prompt-dispatch", sessionId: "s1" },
  };
  const local = buildPipelineStatus(snapshot, pipelineId)!;
  const status = node ? statusOnNode(local, node.id, node.name) : local;
  const rendered = renderCoordinatorStatusNotice(
    {
      kind: "build-pipeline",
      id: pipelineId,
      environmentId: "env-1",
      ...(node ? { nodeId: node.id } : {}),
    },
    status,
  );
  const message = {
    version: 1,
    id: `mail-${pipelineId}`,
    threadId: `thread-${pipelineId}`,
    requestId: `request-${pipelineId}`,
    createdAt: "2026-11-11T00:00:00.000Z",
    from: { kind: "system", source: "workflow" },
    toEnvironmentId: "coordinator:ws:conv",
    toTabId: "coordinator-tab",
    toIncarnationId: "incarnation",
    subject: rendered.subject,
    body: rendered.body,
    bodyBytes: rendered.body.length,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "injected",
    notice: rendered.notice,
    revision: 1,
  } as unknown as AgentMailMessage;
  return renderAgentMailCarrier(message);
}

describe("coordinator restart fake model", () => {
  test("a build worker gets a usage limit that Orkestrator classifies and Pi will not retry", () => {
    const worker = scriptedTurn({ messages: [user("Build it")], tools: tools("bash", "read") });
    expect(worker.step).toEqual({ kind: "usage-limit" });
    const refusal = usageLimitRefusal();
    expect(refusal.status).toBe(429);
    expect(classifyUsageLimitError(`429 ${USAGE_LIMIT_MESSAGE}`)).toEqual({ resetHint: "3pm" });
    // Pi's SDK treats `insufficient_quota` as a plan limit, not a transient throttle.
    expect(USAGE_LIMIT_MESSAGE).toContain("insufficient_quota");
  });

  test("the build request reads the base, creates a ticket and builds it, on a node when named", () => {
    for (const nodeId of [undefined, "node-7"]) {
      const prompt = `Please add ${BUILD_MARKER} with tests.${nodeId ? ` nodeId: ${nodeId}` : ""}`;
      const onNode = nodeId ? { nodeId } : {};
      const base = [system, user(prompt)];
      expect(scriptedTurn({ messages: base, tools: COORDINATOR_TOOLS }).step).toEqual({
        kind: "tool",
        name: "mcp_orkestrator_get_launch_options",
        input: { projectId: "project-123", ...onNode },
      });
      expect(
        scriptedTurn({ messages: [...base, call("get"), launchOptions], tools: COORDINATOR_TOOLS })
          .step,
      ).toMatchObject({ kind: "tool", name: "mcp_orkestrator_create_ticket" });
      expect(
        scriptedTurn({
          messages: [...base, call("get"), launchOptions, call("create"), ticket],
          tools: COORDINATOR_TOOLS,
        }).step,
      ).toMatchObject({
        kind: "tool",
        name: "mcp_orkestrator_start_build_pipeline",
        input: { taskId: "ticket-9", baseBranch: "main", baseCommit: COMMIT, ...onNode },
      });
      expect(
        scriptedTurn({
          messages: [
            ...base,
            call("get"),
            launchOptions,
            call("create"),
            ticket,
            call("start"),
            result({ workflow: { id: "p1" } }),
          ],
          tools: COORDINATOR_TOOLS,
        }).step,
      ).toEqual({ kind: "text", text: FAKE_BUILD_REPLY });
    }
  });

  test("reads the pipeline and the offer from the real failed notice", () => {
    const payloads = carrierPayloads(failedWake("pipe-1"));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.notice).toMatchObject({
      resource: { kind: "build-pipeline", id: "pipe-1" },
      state: "failed",
    });
    expect(payloads[0]!.body).toContain(
      'restart_build_pipeline_step { "pipelineId": "pipe-1", "requestId": "…" }',
    );
  });

  test("a failed wake restarts the failed step once, then retries the same key once", () => {
    const wake = user(failedWake("pipe-1"));
    const first = scriptedTurn({ messages: [system, wake], tools: COORDINATOR_TOOLS });
    expect(first.wake).toEqual({
      failedPipelines: ["pipe-1"],
      usageLimit: true,
      offersRestart: true,
      restartNamesNode: false,
      restartedBefore: false,
    });
    const restart = {
      requestId: restartRequestId("pipe-1"),
      pipelineId: "pipe-1",
    };
    expect(first.step).toEqual({
      kind: "tool",
      name: "mcp_orkestrator_restart_build_pipeline_step",
      input: restart,
    });
    const answered = scriptedTurn({
      messages: [
        system,
        wake,
        call("mcp_orkestrator_restart_build_pipeline_step", restart),
        result({
          pipelineId: "pipe-1",
          restarted: true,
          phase: "building",
          followed: true,
          step: { phase: "build", round: 1 },
          nextStep: "The step restarted. Finish your turn now. Do not poll.",
        }),
      ],
      tools: COORDINATOR_TOOLS,
    });
    expect(answered.step).toEqual({ kind: "text", text: FAKE_RESTART_REPLY });
    expect(answered.wake).toBeUndefined();
    expect(answered.restart).toEqual({
      pipelineId: "pipe-1",
      replay: false,
      restarted: true,
      phase: "building",
      followed: true,
      failedAgain: false,
      error: false,
    });

    // The reopened follow's next wake: the same key once more, as a retry would.
    const history = [
      system,
      wake,
      call("mcp_orkestrator_restart_build_pipeline_step", restart),
      result({ pipelineId: "pipe-1", restarted: true }),
      { role: "assistant", content: FAKE_RESTART_REPLY },
    ];
    const second = user(failedWake("pipe-1"));
    const again = scriptedTurn({ messages: [...history, second], tools: COORDINATOR_TOOLS });
    expect(again.wake).toMatchObject({ failedPipelines: ["pipe-1"], restartedBefore: true });
    expect(again.step).toEqual({
      kind: "tool",
      name: "mcp_orkestrator_restart_build_pipeline_step",
      input: restart,
    });
    const replayed = scriptedTurn({
      messages: [
        ...history,
        second,
        call("mcp_orkestrator_restart_build_pipeline_step", restart),
        result({ pipelineId: "pipe-1", restarted: true, phase: "building", replayed: true }),
      ],
      tools: COORDINATOR_TOOLS,
    });
    expect(replayed.step).toEqual({ kind: "text", text: FAKE_WAKE_REPLY });
    expect(replayed.restart).toMatchObject({ pipelineId: "pipe-1", replay: true, replayed: true });

    // A third failed wake for it calls nothing.
    const third = scriptedTurn({
      messages: [
        ...history,
        second,
        call("mcp_orkestrator_restart_build_pipeline_step", restart),
        result({ pipelineId: "pipe-1", restarted: true }),
        { role: "assistant", content: FAKE_WAKE_REPLY },
        user(failedWake("pipe-1")),
      ],
      tools: COORDINATOR_TOOLS,
    });
    expect(third.step).toEqual({ kind: "text", text: FAKE_WAKE_REPLY });
  });

  test("a failed pipeline on another node is restarted there", () => {
    const wake = user(failedWake("pipe-2", { id: "node-7", name: "Leaf" }));
    const turn = scriptedTurn({ messages: [system, wake], tools: COORDINATOR_TOOLS });
    expect(turn.wake).toMatchObject({ restartNamesNode: true, failedPipelines: ["pipe-2"] });
    expect(turn.step).toEqual({
      kind: "tool",
      name: "mcp_orkestrator_restart_build_pipeline_step",
      input: { requestId: restartRequestId("pipe-2"), pipelineId: "pipe-2", nodeId: "node-7" },
    });
  });

  test("a wake that reports no failed build calls nothing", () => {
    const payload = JSON.stringify({
      subject: "Usage limit",
      body: "A usage limit stopped a turn.",
    });
    const wake = user(
      `<orkestrator-peer-message version="1">\n<orkestrator-peer-payload-json>\n${payload}\n</orkestrator-peer-payload-json>\nnote\n</orkestrator-peer-message>`,
    );
    const turn = scriptedTurn({ messages: [system, wake], tools: COORDINATOR_TOOLS });
    expect(turn.step).toEqual({ kind: "text", text: FAKE_WAKE_REPLY });
    expect(turn.wake).toEqual({
      failedPipelines: [],
      usageLimit: true,
      offersRestart: false,
      restartNamesNode: false,
      restartedBefore: false,
    });
  });
});
