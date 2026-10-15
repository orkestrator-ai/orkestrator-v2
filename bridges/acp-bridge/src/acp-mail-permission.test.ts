import { describe, expect, test } from "bun:test";
import { orkestratorMailPermissionOption } from "./acp-session.js";

const options = [
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
];

describe("Orkestrator mail permission requests", () => {
  test("a server-qualified mail tool is allowed without a person", () => {
    for (const name of ["orkestrator__send_message", "mcp__orkestrator__reply_message"]) {
      expect(
        orkestratorMailPermissionOption({
          toolCall: { toolCallId: "1", _meta: { "x.ai/tool": { name } } },
          options,
        }),
      ).toBe("allow");
    }
    expect(
      orkestratorMailPermissionOption({
        toolCall: { toolCallId: "2", title: "orkestrator__ack_message" },
        options,
      }),
    ).toBe("allow");
    // A bare name is enough when the metadata names the server.
    expect(
      orkestratorMailPermissionOption({
        toolCall: {
          toolCallId: "5",
          _meta: { "x.ai/tool": { name: "check_inbox", namespace: "orkestrator" } },
        },
        options,
      }),
    ).toBe("allow");
    expect(
      orkestratorMailPermissionOption({
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
        orkestratorMailPermissionOption({
          toolCall: { toolCallId: "3", _meta: { "x.ai/tool": { name } } },
          options,
        }),
      ).toBeUndefined();
    }
  });

  test("no allow option means no answer", () => {
    expect(
      orkestratorMailPermissionOption({
        toolCall: { toolCallId: "4", title: "orkestrator__send_message" },
        options: [options[0]],
      }),
    ).toBeUndefined();
  });
});
