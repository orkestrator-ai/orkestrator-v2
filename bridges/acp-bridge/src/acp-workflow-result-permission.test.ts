import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import type { WorkflowResultTurn } from "@orkestrator/protocol/workflow-results";
import { sessions, type AcpProcess, type SessionState } from "./acp-context.js";
import { attachChild, clearApprovals, workflowResultPermissionOption } from "./acp-session.js";

const options = [
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
];

const KEY = "11111111-1111-4111-8111-111111111111";
const OTHER_KEY = "22222222-2222-4222-8222-222222222222";
const reviewerTurn: WorkflowResultTurn = { tool: "submit_review_report", resultKey: KEY };

const named = (name: string, args: unknown = { resultKey: KEY }) => ({
  toolCallId: name,
  _meta: { "x.ai/tool": { name } },
  rawInput: args,
});

const useTool = (toolName: string, toolInput: unknown) => ({
  toolCallId: `wrapped-${toolName}`,
  _meta: { "x.ai/tool": { name: "use_tool" } },
  rawInput: { variant: "UseTool", tool_name: toolName, tool_input: toolInput },
});

describe("the current turn's workflow-result attempt", () => {
  test("its own tools are granted for its own result key under every naming Grok uses", () => {
    for (const tool of [
      "submit_review_report",
      "validate_workflow_result",
      "get_workflow_result_status",
      "report_finding",
    ]) {
      for (const toolCall of [
        named(`orkestrator__${tool}`),
        { toolCallId: "2", name: `mcp__orkestrator__${tool}`, rawInput: { resultKey: KEY } },
        {
          toolCallId: "3",
          _meta: { "x.ai/tool": { name: tool, namespace: "orkestrator" } },
          rawInput: { resultKey: KEY, result: {} },
        },
        useTool(`orkestrator__${tool}`, { resultKey: KEY }),
        // Grok can pass the wrapped arguments as a JSON string.
        useTool(`orkestrator__${tool}`, JSON.stringify({ resultKey: KEY })),
      ]) {
        expect(workflowResultPermissionOption({ toolCall, options }, reviewerTurn)).toBe("allow");
      }
    }
    // Without input on the request, the call the bridge recorded decides.
    expect(
      workflowResultPermissionOption(
        { toolCall: { toolCallId: "4", name: "orkestrator__submit_review_report" }, options },
        reviewerTurn,
        { resultKey: KEY },
      ),
    ).toBe("allow");
  });

  test("another reviewer's key, another attempt's tool or no declared attempt is never granted", () => {
    // Another reviewer's result key, directly or through the wrapper.
    for (const toolCall of [
      named("orkestrator__submit_review_report", { resultKey: OTHER_KEY }),
      useTool("orkestrator__get_workflow_result_status", { resultKey: OTHER_KEY }),
      named("orkestrator__report_finding", {}),
      // No arguments to read the key from.
      {
        toolCallId: "no-input",
        _meta: { "x.ai/tool": { name: "orkestrator__validate_workflow_result" } },
      },
    ]) {
      expect(workflowResultPermissionOption({ toolCall, options }, reviewerTurn)).toBeUndefined();
    }
    // A tool this attempt does not offer.
    expect(
      workflowResultPermissionOption(
        { toolCall: named("orkestrator__submit_fix_result"), options },
        reviewerTurn,
      ),
    ).toBeUndefined();
    expect(
      workflowResultPermissionOption(
        { toolCall: named("orkestrator__report_finding"), options },
        { tool: "submit_consolidated_review", resultKey: KEY },
      ),
    ).toBeUndefined();
    // A session whose turn declared no attempt (an ordinary or coordinator turn).
    expect(
      workflowResultPermissionOption(
        { toolCall: named("orkestrator__submit_review_report"), options },
        undefined,
      ),
    ).toBeUndefined();
  });

  test("a bare name, another server, a display title or a mutating kind is never granted", () => {
    for (const toolCall of [
      named("submit_review_report"),
      named("other__submit_review_report"),
      {
        toolCallId: "3",
        _meta: { "x.ai/tool": { name: "submit_review_report", namespace: "other" } },
        rawInput: { resultKey: KEY },
      },
      { toolCallId: "5", title: "orkestrator__submit_review_report", rawInput: { resultKey: KEY } },
      { ...named("orkestrator__submit_review_report"), kind: "execute" },
      { ...named("orkestrator__submit_review_report"), kind: "edit" },
      useTool("orkestrator__send_message", { resultKey: KEY }),
      { toolCallId: "6", _meta: { "x.ai/tool": { name: "use_tool" } } },
    ]) {
      expect(workflowResultPermissionOption({ toolCall, options }, reviewerTurn)).toBeUndefined();
    }
    expect(
      workflowResultPermissionOption(
        {
          toolCall: named("orkestrator__submit_review_report"),
          options: [{ optionId: "reject", kind: "reject_once" }],
        },
        reviewerTurn,
      ),
    ).toBeUndefined();
  });

  function readOnlySession(turn?: WorkflowResultTurn, policy?: SessionState["policy"]) {
    const responses: unknown[] = [];
    const child = {
      respond: (_id: number, result: unknown) => responses.push(result),
    } as AcpProcess;
    const state = {
      id: `read-only-${crypto.randomUUID()}`,
      acpSessionId: "vendor-session",
      messages: [],
      readOnly: true,
      ...(turn ? { workflowResultTurn: turn } : {}),
      ...(policy ? { policy } : {}),
      approvals: new Map(),
      interactions: new Map(),
      revision: 0,
    } as unknown as SessionState;
    sessions.set(state.id, state);
    attachChild(state, child);
    return { state, child, responses };
  }

  const allowed = { outcome: { outcome: "selected", optionId: "allow" } };
  // A policy refusal picks the request's reject option, never `cancelled`.
  const refused = { outcome: { outcome: "selected", optionId: "reject" } };

  test("a read-only reviewer turn, which denies everything else, may submit its report", () => {
    const { state, child, responses } = readOnlySession(reviewerTurn);
    try {
      let id = 0;
      const ask = (toolCall: Record<string, unknown>) =>
        child.onPermission((id += 1), { sessionId: state.acpSessionId, toolCall, options });
      ask(named("orkestrator__validate_workflow_result", { resultKey: KEY, result: {} }));
      ask(useTool("orkestrator__submit_review_report", { resultKey: KEY, result: {} }));
      ask(named("orkestrator__get_workflow_result_status"));
      ask(named("orkestrator__report_finding", { resultKey: KEY, finding: {} }));
      // Another reviewer's key and an ordinary write are still refused.
      ask(named("orkestrator__submit_review_report", { resultKey: OTHER_KEY, result: {} }));
      ask({ ...named("write_file", { path: "a.ts" }), kind: "edit" });
      expect(responses).toEqual([allowed, allowed, allowed, allowed, refused, refused]);
      expect(state.approvals.size).toBe(0);
    } finally {
      clearApprovals(state);
      sessions.delete(state.id);
    }
  });

  test("a read-only turn that declared no attempt is refused the same tools", () => {
    const { state, child, responses } = readOnlySession();
    try {
      child.onPermission(1, {
        sessionId: state.acpSessionId,
        toolCall: named("orkestrator__submit_review_report"),
        options,
      });
      expect(responses).toEqual([refused]);
    } finally {
      clearApprovals(state);
      sessions.delete(state.id);
    }
  });

  for (const approvals of ["deny", "ask"] as const) {
    test(`a declared consolidation attempt bypasses ${approvals} without parking approval`, () => {
      const { state, child, responses } = readOnlySession(
        { tool: "submit_consolidated_review", resultKey: KEY },
        {
          id: "pipeline",
          sandbox: "none",
          approvals,
          projectResources: false,
        },
      );
      // Build Pipeline consolidation uses the environment policy, not a read-only override.
      state.readOnly = false;
      try {
        let id = 0;
        for (const tool of [
          "validate_workflow_result",
          "submit_consolidated_review",
          "get_workflow_result_status",
        ]) {
          for (const toolCall of [
            named(`orkestrator__${tool}`),
            useTool(`orkestrator__${tool}`, { resultKey: KEY }),
          ]) {
            child.onPermission((id += 1), {
              sessionId: state.acpSessionId,
              toolCall,
              options,
            });
          }
        }
        expect(responses).toEqual(Array(6).fill(allowed));
        expect(state.approvals.size).toBe(0);
        expect(state.policyDeniedRequests ?? 0).toBe(0);

        // The exemption remains attempt-scoped under the same environment policy.
        child.onPermission((id += 1), {
          sessionId: state.acpSessionId,
          toolCall: named("orkestrator__submit_consolidated_review", { resultKey: OTHER_KEY }),
          options,
        });
        if (approvals === "deny") {
          expect(responses).toEqual([...Array(6).fill(allowed), refused]);
          expect(state.approvals.size).toBe(0);
          expect(state.policyDeniedRequests).toBe(1);
        } else {
          expect(responses).toEqual(Array(6).fill(allowed));
          expect(state.approvals.size).toBe(1);
        }
      } finally {
        clearApprovals(state);
        sessions.delete(state.id);
      }
    });
  }

  test("a read-only graph activation may use each slot's own tools with that slot's key", () => {
    const activation: WorkflowResultTurn = {
      tool: "submit_a",
      resultKey: KEY,
      slots: [
        { tool: "submit_a", resultKey: KEY },
        { tool: "submit_b", resultKey: OTHER_KEY },
      ],
      extraTools: ["read_artifact"],
    };
    const { state, child, responses } = readOnlySession(activation);
    try {
      let id = 0;
      const ask = (toolCall: Record<string, unknown>) =>
        child.onPermission((id += 1), { sessionId: state.acpSessionId, toolCall, options });
      ask(named("orkestrator__submit_a", { resultKey: KEY, result: {} }));
      ask(useTool("orkestrator__validate_a", { resultKey: KEY, result: {} }));
      ask({
        toolCallId: "ns",
        _meta: { "x.ai/tool": { name: "submit_b", namespace: "orkestrator" } },
        rawInput: { resultKey: OTHER_KEY },
      });
      ask(named("orkestrator__get_workflow_result_status", { resultKey: OTHER_KEY }));
      ask(named("orkestrator__read_artifact", { id: "artifact-1" }));
      // Another slot's key, an unlisted extra tool, and a kind tool the turn
      // did not declare are refused.
      ask(named("orkestrator__submit_a", { resultKey: OTHER_KEY, result: {} }));
      ask(named("orkestrator__validate_b", { resultKey: KEY }));
      ask(named("orkestrator__ask_human", { question: "?" }));
      ask(named("orkestrator__report_progress", { resultKey: KEY }));
      ask(named("orkestrator__validate_workflow_result", { resultKey: KEY }));
      expect(responses).toEqual([...Array(5).fill(allowed), ...Array(5).fill(refused)]);
      state.workflowResultTurn = { ...activation, extraTools: ["ask_human"] };
      ask(named("orkestrator__ask_human", { question: "?" }));
      ask(named("orkestrator__read_artifact", { id: "artifact-1" }));
      expect(responses.slice(10)).toEqual([allowed, refused]);
      expect(state.approvals.size).toBe(0);
    } finally {
      clearApprovals(state);
      sessions.delete(state.id);
    }
  });

  test("an old kind-tool turn does not admit per-port or extra tools", () => {
    for (const toolCall of [
      named("orkestrator__submit_a"),
      named("orkestrator__read_artifact"),
      named("orkestrator__ask_human"),
    ]) {
      expect(workflowResultPermissionOption({ toolCall, options }, reviewerTurn)).toBeUndefined();
    }
  });

  test("an explicit tool denial still wins", () => {
    const { state, child, responses } = readOnlySession(reviewerTurn, {
      id: "pipeline",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: false,
      toolPolicy: { deny: ["orkestrator__submit_review_report"] },
    } as SessionState["policy"]);
    state.readOnly = false;
    try {
      child.onPermission(1, {
        sessionId: state.acpSessionId,
        toolCall: named("orkestrator__submit_review_report"),
        options,
      });
      expect(responses).not.toContainEqual(allowed);
    } finally {
      clearApprovals(state);
      sessions.delete(state.id);
    }
  });
});
