import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { autoApprovedPermissionOption, orkestratorToolPermissionOption } from "./acp-session.js";

const options = [
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
];

describe("Orkestrator tool permission requests", () => {
  test("a server-qualified mail tool is allowed without a person", () => {
    for (const name of ["orkestrator__send_message", "mcp__orkestrator__reply_message"]) {
      expect(
        orkestratorToolPermissionOption({
          toolCall: { toolCallId: "1", _meta: { "x.ai/tool": { name } } },
          options,
        }),
      ).toBe("allow");
    }
    expect(
      orkestratorToolPermissionOption({
        toolCall: { toolCallId: "2", name: "orkestrator__ack_message" },
        options,
      }),
    ).toBe("allow");
    // A bare name is enough when the metadata names the server.
    expect(
      orkestratorToolPermissionOption({
        toolCall: {
          toolCallId: "5",
          _meta: { "x.ai/tool": { name: "check_inbox", namespace: "orkestrator" } },
        },
        options,
      }),
    ).toBe("allow");
    expect(
      orkestratorToolPermissionOption({
        toolCall: {
          toolCallId: "6",
          _meta: { "x.ai/tool": { name: "check_inbox", namespace: "other" } },
        },
        options,
      }),
    ).toBeUndefined();
  });

  test("a bare name, another server, or another Orkestrator tool still asks", () => {
    for (const name of ["send_message", "other__send_message", "orkestrator__create_ticket"]) {
      expect(
        orkestratorToolPermissionOption({
          toolCall: { toolCallId: "3", _meta: { "x.ai/tool": { name } } },
          options,
        }),
      ).toBeUndefined();
    }
  });

  test("display titles, conflicting vendor identities, execute kinds and deny never grant mail permission", () => {
    for (const toolCall of [
      { title: "orkestrator__send_message" },
      { name: "shell", title: "orkestrator__send_message" },
      { name: "orkestrator__send_message", _meta: { "x.ai/tool": { name: "shell" } } },
      { name: "orkestrator__send_message", kind: "execute" },
      { title: "orkestrator__send_message", kind: "edit" },
    ]) {
      for (const policy of ["ask", "deny"])
        expect(orkestratorToolPermissionOption({ toolCall, options }, policy)).toBeUndefined();
    }
    expect(
      orkestratorToolPermissionOption(
        { toolCall: { name: "orkestrator__send_message" }, options },
        "deny",
      ),
    ).toBeUndefined();
  });

  test("no allow option means no answer", () => {
    expect(
      orkestratorToolPermissionOption({
        toolCall: { toolCallId: "4", title: "orkestrator__send_message" },
        options: [options[0]],
      }),
    ).toBeUndefined();
  });

  test("annotation result tools are allowed like the mail tools", () => {
    for (const name of [
      "orkestrator__get_annotation_request",
      "orkestrator__get_annotation_evidence",
      "mcp__orkestrator__report_annotation_result",
    ]) {
      expect(
        orkestratorToolPermissionOption({
          toolCall: { toolCallId: "7", _meta: { "x.ai/tool": { name } } },
          options,
        }),
      ).toBe("allow");
    }
    expect(
      orkestratorToolPermissionOption({
        toolCall: {
          toolCallId: "8",
          _meta: { "x.ai/tool": { name: "report_annotation_result", namespace: "orkestrator" } },
        },
        options,
      }),
    ).toBe("allow");
  });

  // Grok 1.0.52 asks for its `use_tool` wrapper, not for the MCP tool it runs.
  const useTool = (rawInput?: unknown) => ({
    toolCallId: "9",
    title: "orkestrator__check_inbox",
    _meta: { "x.ai/tool": { name: "use_tool" } },
    ...(rawInput === undefined ? {} : { rawInput }),
  });

  test("Grok's use_tool is matched by the tool it wraps", () => {
    const wrapped = { variant: "UseTool", tool_name: "orkestrator__check_inbox", tool_input: {} };
    expect(orkestratorToolPermissionOption({ toolCall: useTool(wrapped), options })).toBe("allow");
    // Without input on the request, the call the bridge already recorded decides.
    expect(orkestratorToolPermissionOption({ toolCall: useTool(), options }, "ask", wrapped)).toBe(
      "allow",
    );
    expect(
      orkestratorToolPermissionOption(
        {
          toolCall: useTool({ tool_name: "orkestrator__get_annotation_request" }),
          options,
        },
        "auto-approve",
      ),
    ).toBe("allow");
  });

  test("use_tool wrapping anything else, or nothing, still asks", () => {
    for (const toolName of ["orkestrator__create_ticket", "other__check_inbox", "check_inbox"]) {
      expect(
        orkestratorToolPermissionOption({ toolCall: useTool({ tool_name: toolName }), options }),
      ).toBeUndefined();
    }
    // The display title never stands in for the wrapped name.
    expect(orkestratorToolPermissionOption({ toolCall: useTool(), options })).toBeUndefined();
    expect(
      orkestratorToolPermissionOption(
        { toolCall: useTool({ tool_name: "orkestrator__check_inbox" }), options },
        "deny",
      ),
    ).toBeUndefined();
    expect(
      orkestratorToolPermissionOption({
        toolCall: { ...useTool({ tool_name: "orkestrator__check_inbox" }), kind: "execute" },
        options,
      }),
    ).toBeUndefined();
  });
});

describe("auto-approve policy permission requests", () => {
  const policy = (
    fields: Partial<NativeAgentExecutionPolicy> = {},
  ): NativeAgentExecutionPolicy => ({
    id: "interactive-host",
    sandbox: "none",
    approvals: "auto-approve",
    projectResources: false,
    networkAccess: "full",
    ...fields,
  });
  const request = (kind?: string) => ({
    toolCall: { toolCallId: "1", title: "Run safe command", ...(kind ? { kind } : {}) },
    options,
  });

  test("Grok's own asks are answered with the allow option", () => {
    for (const kind of ["edit", "execute", "fetch", "other", undefined]) {
      expect(autoApprovedPermissionOption(request(kind), policy())).toBe("allow");
    }
  });

  test("only the auto-approve setting answers, and only with an allow option", () => {
    for (const approvals of ["ask", "deny"] as const) {
      expect(autoApprovedPermissionOption(request("edit"), policy({ approvals }))).toBeUndefined();
    }
    expect(autoApprovedPermissionOption(request("edit"), undefined)).toBeUndefined();
    expect(
      autoApprovedPermissionOption({ ...request("edit"), options: [options[0]] }, policy()),
    ).toBeUndefined();
  });

  test("a kind the policy denies is left for a person", () => {
    const noWrites = policy({ capabilityPolicy: { deny: ["file.write"] } });
    expect(autoApprovedPermissionOption(request("edit"), noWrites)).toBeUndefined();
    expect(autoApprovedPermissionOption(request("delete"), noWrites)).toBeUndefined();
    expect(autoApprovedPermissionOption(request("execute"), noWrites)).toBe("allow");
    const noShell = policy({ toolPolicy: { deny: ["shell"] } });
    // The kind recorded for the same call counts when the request has none.
    expect(autoApprovedPermissionOption(request(), noShell, "execute")).toBeUndefined();
    expect(autoApprovedPermissionOption(request(), noShell, "read")).toBe("allow");
    expect(
      autoApprovedPermissionOption(
        request("fetch"),
        policy({ capabilityPolicy: { deny: ["network"] } }),
      ),
    ).toBeUndefined();
    // With no kind known at all, any relevant denial keeps it for a person.
    expect(autoApprovedPermissionOption(request(), noShell)).toBeUndefined();
  });
});
