/**
 * Transcript artifact tool calls through the live ACP update path
 * (`applySessionUpdate` → `renderAcpToolSource`), in the shapes Grok sends.
 *
 * The web client anchors a published artifact on the successful
 * `publish_artifact` call naming it, by the call's name and arguments
 * (`artifactId`, `expectedRevision`), never by its output.
 */
import { describe, expect, test } from "bun:test";
// Must precede every bridge import below: `acp-context.js` resolves
// `ACP_PROVIDER` at module scope and throws without it.
import "./testing/unit-test-env.js";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { ARTIFACT_TOOL_NAMES } from "@orkestrator/protocol/transcript-artifacts";
import {
  RECORDED_ARTIFACT_ERROR_CODE,
  RECORDED_PUBLICATION_ID,
  RECORDED_PUBLISH_ARTIFACT_ARGS,
  RECORDED_PUBLISH_ARTIFACT_ERROR_TEXT,
  RECORDED_PUBLISH_ARTIFACT_RESULT_TEXT,
  SUCCESSFUL_PUBLISH_CONTRACT,
  publishArtifactCallContract,
} from "@orkestrator/protocol/testing/artifact-tool-fixtures";
import {
  sessions,
  type AcpProcess,
  type BridgeToolPart,
  type SessionState,
} from "./acp-context.js";
import { emptySessionConfig } from "./acp-persistence.js";
import {
  applySessionUpdate as applySessionNotification,
  attachChild,
  clearApprovals,
  orkestratorToolPermissionOption,
} from "./acp-session.js";

let nextId = 0;

/** One `session/update` notification, as the agent sends it. */
function applySessionUpdate(state: SessionState, update: Record<string, unknown>): void {
  applySessionNotification(state, { sessionId: state.acpSessionId, update });
}

function runningState(): SessionState {
  nextId += 1;
  const id = `artifact-${nextId}`;
  return {
    id,
    acpSessionId: `vendor-${id}`,
    status: "running",
    messages: [{ id: `${id}-user`, role: "user", content: "go", parts: [], createdAt: "" }],
    activeSubagentToolIds: new Set(),
    activeSubagentDescriptors: new Map(),
    settledCursorAgentIds: new Set(),
    subagentLimitExceeded: false,
    subagentToolIds: new Map(),
    cursorTodos: [],
    historyMessageIds: new Map(),
    child: null,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
    grokInterjectionJournal: new Map(),
    approvals: new Map(),
    interactions: new Map(),
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    promptSequence: 1,
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    sessionConfig: emptySessionConfig(),
    dispatching: false,
    historyReplay: false,
    health: new RuntimeHealthRecorder(),
  };
}

function toolPart(state: SessionState, toolCallId: string): BridgeToolPart {
  const part = state.messages
    .flatMap((message) => message.parts)
    .find(
      (candidate): candidate is BridgeToolPart =>
        candidate.type === "tool-invocation" && candidate.toolUseId === toolCallId,
    );
  if (!part) throw new Error(`missing tool part ${toolCallId}`);
  return part;
}

const USE_TOOL_META = { "x.ai/tool": { name: "use_tool" } };

/** Grok 1.0.52: every MCP tool runs through the deferred `use_tool` wrapper. */
function grokUseToolCall(toolCallId: string, toolInput: unknown) {
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: "orkestrator__publish_artifact",
    kind: "other",
    status: "pending",
    rawInput: {
      variant: "UseTool",
      tool_name: "orkestrator__publish_artifact",
      tool_input: toolInput,
    },
    _meta: USE_TOOL_META,
  };
}

function settle(toolCallId: string, isError: boolean) {
  const text = isError
    ? RECORDED_PUBLISH_ARTIFACT_ERROR_TEXT
    : RECORDED_PUBLISH_ARTIFACT_RESULT_TEXT;
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: isError ? "failed" : "completed",
    content: [{ type: "content", content: { type: "text", text } }],
  };
}

describe("Grok use_tool artifact calls", () => {
  test("surface the wrapped tool's name and arguments", () => {
    const state = runningState();
    applySessionUpdate(state, grokUseToolCall("publish-1", { ...RECORDED_PUBLISH_ARTIFACT_ARGS }));
    applySessionUpdate(state, settle("publish-1", false));
    const part = toolPart(state, "publish-1");

    expect(publishArtifactCallContract(part)).toEqual({ ...SUCCESSFUL_PUBLISH_CONTRACT });
    expect(part.toolName).toBe("orkestrator__publish_artifact");
    expect(part.toolArgs).toEqual({ ...RECORDED_PUBLISH_ARTIFACT_ARGS });
    expect(part.toolOutput).toContain(RECORDED_PUBLICATION_ID);
  });

  test("read arguments Grok sent as a JSON string", () => {
    const state = runningState();
    applySessionUpdate(
      state,
      grokUseToolCall("publish-2", JSON.stringify(RECORDED_PUBLISH_ARTIFACT_ARGS)),
    );
    applySessionUpdate(state, settle("publish-2", false));

    expect(publishArtifactCallContract(toolPart(state, "publish-2"))).toEqual({
      ...SUCCESSFUL_PUBLISH_CONTRACT,
    });
  });

  test("a refused publish is not a success and keeps its error code", () => {
    const state = runningState();
    applySessionUpdate(state, grokUseToolCall("publish-3", { ...RECORDED_PUBLISH_ARTIFACT_ARGS }));
    applySessionUpdate(state, settle("publish-3", true));
    const part = toolPart(state, "publish-3");
    const contract = publishArtifactCallContract(part);

    expect(contract.tool).toBe("publish_artifact");
    expect(contract.toolState).not.toBe("success");
    expect(part.toolError).toContain(RECORDED_ARTIFACT_ERROR_CODE);
  });

  test("a wrapper that names no tool still renders as the wrapper", () => {
    const state = runningState();
    applySessionUpdate(state, {
      ...grokUseToolCall("wrapper-1", {}),
      rawInput: { variant: "UseTool" },
    });
    expect(toolPart(state, "wrapper-1").toolName).toBe("use_tool");
  });

  test("a permission request naming only the wrapper is allowed from the recorded call", () => {
    for (const tool of ARTIFACT_TOOL_NAMES) {
      const responses: unknown[] = [];
      const child = {
        respond: (_id: number, result: unknown) => responses.push(result),
      } as unknown as AcpProcess;
      const state = runningState();
      state.policy = {
        id: "interactive-host",
        sandbox: "none",
        approvals: "ask",
        projectResources: false,
        networkAccess: "full",
      };
      sessions.set(state.id, state);
      try {
        attachChild(state, child);
        applySessionUpdate(state, {
          ...grokUseToolCall("permission-1", {}),
          title: `orkestrator__${tool}`,
          rawInput: { variant: "UseTool", tool_name: `orkestrator__${tool}`, tool_input: {} },
        });
        // The rendered part now carries the wrapped tool's own arguments; the
        // wrapper input that identifies the tool is kept on its source state.
        expect(toolPart(state, "permission-1").toolName).toBe(`orkestrator__${tool}`);
        child.onPermission(1, {
          sessionId: state.acpSessionId,
          toolCall: {
            toolCallId: "permission-1",
            title: `orkestrator__${tool}`,
            _meta: USE_TOOL_META,
          },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "deny", kind: "reject_once" },
          ],
        });
        expect(responses).toEqual([{ outcome: { outcome: "selected", optionId: "allow" } }]);
        expect(state.approvals.size).toBe(0);
      } finally {
        clearApprovals(state);
        sessions.delete(state.id);
      }
    }
  });
});

describe("other ACP artifact call shapes", () => {
  test("Grok's namespaced tool metadata keeps a recognisable bare name", () => {
    const state = runningState();
    applySessionUpdate(state, {
      sessionUpdate: "tool_call",
      toolCallId: "namespaced-1",
      title: "publish_artifact",
      kind: "other",
      status: "pending",
      rawInput: { ...RECORDED_PUBLISH_ARTIFACT_ARGS },
      _meta: { "x.ai/tool": { name: "publish_artifact", namespace: "orkestrator" } },
    });
    applySessionUpdate(state, settle("namespaced-1", false));

    expect(publishArtifactCallContract(toolPart(state, "namespaced-1"))).toEqual({
      ...SUCCESSFUL_PUBLISH_CONTRACT,
    });
  });

  test("a server-qualified tool name is recognised with its arguments", () => {
    const state = runningState();
    applySessionUpdate(state, {
      sessionUpdate: "tool_call",
      toolCallId: "qualified-1",
      title: "orkestrator__publish_artifact",
      kind: "other",
      status: "pending",
      rawInput: { ...RECORDED_PUBLISH_ARTIFACT_ARGS },
      _meta: { "x.ai/tool": { name: "orkestrator__publish_artifact" } },
    });
    applySessionUpdate(state, settle("qualified-1", false));

    expect(publishArtifactCallContract(toolPart(state, "qualified-1"))).toEqual({
      ...SUCCESSFUL_PUBLISH_CONTRACT,
    });
  });

  test("every artifact tool is auto-allowed in each Grok naming form", () => {
    const options = [
      { optionId: "allow", kind: "allow_once" },
      { optionId: "deny", kind: "reject_once" },
    ];
    for (const tool of ARTIFACT_TOOL_NAMES) {
      const forms = [
        { toolCallId: "a", _meta: { "x.ai/tool": { name: `orkestrator__${tool}` } } },
        { toolCallId: "b", _meta: { "x.ai/tool": { name: tool, namespace: "orkestrator" } } },
        {
          toolCallId: "c",
          _meta: USE_TOOL_META,
          rawInput: { variant: "UseTool", tool_name: `orkestrator__${tool}`, tool_input: {} },
        },
      ];
      for (const toolCall of forms) {
        expect(orkestratorToolPermissionOption({ toolCall, options }, "ask")).toBe("allow");
      }
      // Never by bare name, and never under a deny policy.
      expect(
        orkestratorToolPermissionOption(
          { toolCall: { toolCallId: "d", _meta: { "x.ai/tool": { name: tool } } }, options },
          "ask",
        ),
      ).toBeUndefined();
      expect(
        orkestratorToolPermissionOption({ toolCall: forms[0], options }, "deny"),
      ).toBeUndefined();
    }
  });
});
