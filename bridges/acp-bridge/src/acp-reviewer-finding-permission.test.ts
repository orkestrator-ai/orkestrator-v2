import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import { sessions, type AcpProcess, type SessionState } from "./acp-context.js";
import { attachChild, clearApprovals, reviewerFindingPermissionOption } from "./acp-session.js";

const options = [
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
];

const useTool = (rawInput?: unknown) => ({
  toolCallId: "wrapped",
  _meta: { "x.ai/tool": { name: "use_tool" } },
  ...(rawInput === undefined ? {} : { rawInput }),
});

describe("a reviewer's report_finding permission", () => {
  test("is granted for the Orkestrator server's tool under every naming Grok uses", () => {
    for (const toolCall of [
      { toolCallId: "1", _meta: { "x.ai/tool": { name: "orkestrator__report_finding" } } },
      { toolCallId: "2", name: "mcp__orkestrator__report_finding" },
      {
        toolCallId: "3",
        _meta: { "x.ai/tool": { name: "report_finding", namespace: "orkestrator" } },
      },
      useTool({ tool_name: "orkestrator__report_finding", tool_input: {} }),
    ]) {
      expect(reviewerFindingPermissionOption({ toolCall, options })).toBe("allow");
    }
    // Without input on the request, the call the bridge recorded decides.
    expect(
      reviewerFindingPermissionOption(
        { toolCall: useTool(), options },
        {
          tool_name: "orkestrator__report_finding",
        },
      ),
    ).toBe("allow");
  });

  test("is never granted for a bare name, another server, another tool or a mutating kind", () => {
    for (const toolCall of [
      { toolCallId: "1", _meta: { "x.ai/tool": { name: "report_finding" } } },
      { toolCallId: "2", _meta: { "x.ai/tool": { name: "other__report_finding" } } },
      {
        toolCallId: "3",
        _meta: { "x.ai/tool": { name: "report_finding", namespace: "other" } },
      },
      { toolCallId: "4", _meta: { "x.ai/tool": { name: "orkestrator__submit_review_report" } } },
      { toolCallId: "5", title: "orkestrator__report_finding" },
      { toolCallId: "6", name: "orkestrator__report_finding", kind: "execute" },
      { toolCallId: "7", name: "orkestrator__report_finding", kind: "edit" },
      useTool({ tool_name: "orkestrator__send_message" }),
      useTool(),
    ]) {
      expect(reviewerFindingPermissionOption({ toolCall, options })).toBeUndefined();
    }
    expect(
      reviewerFindingPermissionOption({
        toolCall: { toolCallId: "8", name: "orkestrator__report_finding" },
        options: [{ optionId: "reject", kind: "reject_once" }],
      }),
    ).toBeUndefined();
  });

  function readOnlyReviewer(policy?: SessionState["policy"]) {
    const responses: unknown[] = [];
    const child = {
      respond: (_id: number, result: unknown) => responses.push(result),
    } as AcpProcess;
    const state = {
      id: `read-only-reviewer-${Math.random()}`,
      acpSessionId: "vendor-session",
      messages: [],
      readOnly: true,
      ...(policy ? { policy } : {}),
      approvals: new Map(),
      interactions: new Map(),
      revision: 0,
    } as unknown as SessionState;
    sessions.set(state.id, state);
    attachChild(state, child);
    return { state, child, responses };
  }

  test("a read-only review turn, which denies every other request, may call it", () => {
    const { state, child, responses } = readOnlyReviewer();
    try {
      child.onPermission(1, {
        sessionId: state.acpSessionId,
        toolCall: { _meta: { "x.ai/tool": { name: "orkestrator__report_finding" } } },
        options,
      });
      child.onPermission(2, {
        sessionId: state.acpSessionId,
        toolCall: { _meta: { "x.ai/tool": { name: "write_file" } }, kind: "edit" },
        options,
      });
      expect(responses).toEqual([
        { outcome: { outcome: "selected", optionId: "allow" } },
        { outcome: { outcome: "cancelled" } },
      ]);
      expect(state.approvals.size).toBe(0);
    } finally {
      clearApprovals(state);
      sessions.delete(state.id);
    }
  });

  test("an explicit tool denial still wins", () => {
    const { state, child, responses } = readOnlyReviewer({
      id: "pipeline",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: false,
      toolPolicy: { deny: ["orkestrator__report_finding"] },
    } as SessionState["policy"]);
    state.readOnly = false;
    try {
      child.onPermission(1, {
        sessionId: state.acpSessionId,
        toolCall: { _meta: { "x.ai/tool": { name: "orkestrator__report_finding" } } },
        options,
      });
      expect(responses).not.toContainEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    } finally {
      clearApprovals(state);
      sessions.delete(state.id);
    }
  });
});
