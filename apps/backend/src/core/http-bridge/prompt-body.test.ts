import { describe, expect, test } from "bun:test";

import { bridgePromptBody } from "./prompt-body.js";

const connection = {} as never;

describe("capabilityPlugins in the prompt body", () => {
  test("a Claude prompt carries its session's private capability plugins", () => {
    const body = bridgePromptBody(
      "claude",
      connection,
      "hi",
      { requestId: "r1", capabilityPlugins: ["/data/capability-session-plugins/abc"] },
      [],
    );
    expect(body.capabilityPlugins).toEqual(["/data/capability-session-plugins/abc"]);
  });

  test("an empty list is not sent, and no other bridge receives the field", () => {
    expect(
      bridgePromptBody("claude", connection, "hi", { requestId: "r1", capabilityPlugins: [] }, []),
    ).not.toHaveProperty("capabilityPlugins");
    for (const agent of ["codex", "cursor", "grok", "pi"] as const) {
      expect(
        bridgePromptBody(
          agent,
          connection,
          "hi",
          { requestId: "r1", capabilityPlugins: ["/x/abc"] },
          [],
        ),
      ).not.toHaveProperty("capabilityPlugins");
    }
  });
});
