import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import {
  claudeDeniedTools,
  claudeDisallowedTools,
  claudeReadOnlyAllowedTools,
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
} from "./read-only-policy.js";
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
  test("adds WebFetch, WebSearch and RemoteTrigger to the override's own deny list", () => {
    expect(claudeDisallowedTools(NETWORK_DENIED)).toEqual([
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "RemoteTrigger",
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

describe("a coordinator allowed to research", () => {
  const research = coordinatorProcessPolicy({ ORKESTRATOR_COORDINATOR_WEB_RESEARCH: "search" });

  async function decide(toolName: string, servers: readonly string[] = ["context7"]) {
    const hook = createCoordinatorReadOnlyHook(research, servers);
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {} } as never,
      undefined as never,
      { signal: new AbortController().signal } as never,
    );
    return (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision;
  }

  test("keeps WebSearch and loses WebFetch", () => {
    expect(research.capabilityPolicy?.allow).toEqual(["web.search"]);
    expect(claudeDeniedTools(research)).toContain("WebFetch");
    expect(claudeDeniedTools(research)).not.toContain("WebSearch");
    const allowed = claudeReadOnlyAllowedTools({
      agentMcpServerNames: ["orkestrator"],
      policy: research,
      researchMcpServerNames: ["context7"],
    });
    expect(allowed).toContain("WebSearch");
    expect(allowed).not.toContain("WebFetch");
    expect(allowed).toContain("mcp__context7__*");
    // Without the setting, neither is on the allowlist.
    const off = claudeReadOnlyAllowedTools({
      agentMcpServerNames: ["orkestrator"],
      policy: coordinatorProcessPolicy({}),
    });
    expect(off).not.toContain("WebSearch");
    expect(off.some((tool) => tool.startsWith("mcp__context7"))).toBe(false);
  });

  test("an ordinary read-only review cannot inherit a session's research exception", async () => {
    const session = createSession("strict-read-only-review");
    track(session.id);
    session.executionPolicy = research;
    const prompt = sendPrompt(session.id, "Review this", { readOnly: true });
    const call = await nextQueryCall();
    expect(call.options.allowedTools).not.toContain("WebSearch");
    expect(call.options.disallowedTools).toContain("WebSearch");
    expect(call.options.disallowedTools).toContain("WebFetch");
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("a read-only prompt retains the coordinator process's research authority", async () => {
    const previousPolicy = process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
    const previousResearch = process.env.ORKESTRATOR_COORDINATOR_WEB_RESEARCH;
    process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = "coordinator-read-only";
    process.env.ORKESTRATOR_COORDINATOR_WEB_RESEARCH = "search";
    try {
      const session = createSession("read-only-research-coordinator");
      track(session.id);
      // A persisted pre-research policy must not override launch authority.
      session.executionPolicy = coordinatorProcessPolicy({});
      const prompt = sendPrompt(session.id, "Look this up", { readOnly: true });
      const call = await nextQueryCall();
      expect(call.options.allowedTools).toContain("WebSearch");
      expect(call.options.disallowedTools).not.toContain("WebSearch");
      expect(call.options.disallowedTools).toContain("WebFetch");
      expect(call.options.settingSources).toEqual([]);
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await prompt;
    } finally {
      if (previousPolicy === undefined) delete process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
      else process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = previousPolicy;
      if (previousResearch === undefined) delete process.env.ORKESTRATOR_COORDINATOR_WEB_RESEARCH;
      else process.env.ORKESTRATOR_COORDINATOR_WEB_RESEARCH = previousResearch;
    }
  });

  test("the hook admits search and the named research server, nothing else", async () => {
    expect(await decide("WebSearch")).toBeUndefined();
    expect(await decide("mcp__context7__query-docs")).toBeUndefined();
    expect(await decide("WebFetch")).toBe("deny");
    // A server the launcher did not name, even one whose name starts the same.
    expect(await decide("mcp__context7x__query-docs")).toBe("deny");
    expect(await decide("mcp__context7__query-docs", [])).toBe("deny");
  });
});
