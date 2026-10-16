import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import { claudeDisallowedTools, coordinatorProcessPolicy } from "./read-only-policy.js";
import { createSession, nextQueryCall, sendPrompt, track } from "./session-manager-test-harness.js";

/**
 * WebSearch runs on Anthropic's servers and WebFetch from the CLI process, so
 * the command sandbox's empty network allowlist reaches neither. A policy that
 * denies `network` has to take both tools away in the query options.
 */
const NETWORK_DENIED: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: true,
  toolPolicy: { deny: ["NotebookEdit"] },
  capabilityPolicy: { deny: ["network"] },
  networkAccess: "restricted",
};

describe("a policy that denies the network", () => {
  test("adds WebFetch and WebSearch to the override's own deny list", () => {
    expect(claudeDisallowedTools(NETWORK_DENIED)).toEqual([
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
    ]);
    // Without a capability denial the override passes through untouched,
    // `undefined` included, so ordinary sessions launch exactly as before.
    const { capabilityPolicy: _omitted, ...plain } = NETWORK_DENIED;
    expect(claudeDisallowedTools(plain)).toEqual(["NotebookEdit"]);
    expect(claudeDisallowedTools({ ...plain, toolPolicy: undefined })).toBeUndefined();
    expect(claudeDisallowedTools(undefined)).toBeUndefined();
  });

  test("an ordinary turn under it cannot use WebFetch or WebSearch", async () => {
    const session = createSession("network-denied");
    track(session.id);
    session.executionPolicy = NETWORK_DENIED;
    const promptPromise = sendPrompt(session.id, "go");
    const call = await nextQueryCall();

    // Deny rules win over the default allow list, which still names both.
    expect(call.options.disallowedTools).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch", "NotebookEdit"]),
    );

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });

  test("a coordinator turn neither allows nor permits either tool", async () => {
    const session = createSession("network-coordinator");
    track(session.id);
    session.executionPolicy = coordinatorProcessPolicy();
    const promptPromise = sendPrompt(session.id, "delegate");
    const call = await nextQueryCall();

    for (const tool of ["WebFetch", "WebSearch"]) {
      expect(call.options.allowedTools).not.toContain(tool);
      expect(call.options.disallowedTools).toContain(tool);
    }

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });
});
