/**
 * The provider-neutral markers on a shared interaction request: `humanRequired`
 * (a person must answer it) and `toolHints` (what an MCP server declares about
 * its tool). Each bridge forwards them in the shared shape; the adapter keeps
 * only well-formed values, and a malformed one is absent, never an error.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  isAgentInteractionRequest,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import { codexConnection, httpProvider, piConnection } from "./agent-provider-test-support.js";

function byId(requests: AgentInteractionRequest[], suffix: string): AgentInteractionRequest {
  const request = requests.find((candidate) => candidate.id.endsWith(`:${suffix}`));
  if (!request) throw new Error(`no request ${suffix}`);
  return request;
}

describe("human-required marker", () => {
  test("Claude: an ask the CLI keeps for a person is marked and has no rule detail", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    // What `requestClaudeToolApproval` parks for `suppressAlwaysAllowRule` or
    // `matchedAskRule`: no `ruleEligible`, and the marker beside it.
    const interactions = [
      {
        id: "human",
        kind: "command-approval",
        toolName: "Bash",
        command: "npm test",
        humanRequired: true,
        requestedAt,
        expiresAt,
      },
      {
        id: "eligible",
        kind: "command-approval",
        toolName: "Bash",
        command: "npm test",
        ruleEligible: true,
        requestedAt,
        expiresAt,
      },
      // A broken bridge sending both: the marker wins.
      {
        id: "both",
        kind: "command-approval",
        toolName: "Bash",
        command: "npm test",
        ruleEligible: true,
        humanRequired: true,
        requestedAt,
        expiresAt,
      },
      {
        id: "malformed",
        kind: "command-approval",
        toolName: "Bash",
        command: "npm test",
        humanRequired: "yes",
        requestedAt,
        expiresAt,
      },
    ];
    const { provider } = httpProvider(async (url) => {
      if (url.endsWith("/questions")) return Response.json({ questions: [] });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      return Response.json({ interactions });
    });
    const { requests } = await provider.interactions!.listPendingInteractions("session-1");
    expect(requests).toHaveLength(4);
    for (const request of requests) expect(isAgentInteractionRequest(request)).toBe(true);
    const human = byId(requests, "human");
    expect(human.humanRequired).toBe(true);
    expect(human.presentation.approveForSessionLabel).toBeUndefined();
    expect(byId(requests, "both").humanRequired).toBe(true);
    expect(byId(requests, "eligible")).not.toHaveProperty("humanRequired");
    expect(byId(requests, "malformed")).not.toHaveProperty("humanRequired");
    const detail = (id: string) =>
      provider.interactions!.permissionRuleDetail!("session-1", byId(requests, id).id);
    expect(detail("human")).toBeNull();
    expect(detail("both")).toBeNull();
    expect(detail("eligible")?.subject).toEqual({ kind: "command", command: "npm test" });
  });

  test("Codex: a humanCommand offers one-time answers only and never a rule", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    let approvals: Array<Record<string, unknown>> = [
      // What `describeApproval` builds for `kind: "humanCommand"` (synthetic:
      // app-server sends it only under experimentalApi).
      {
        approvalId: "human",
        kind: "command",
        requestedAt,
        expiresAt,
        command: "git push --force",
        cwd: "/workspace",
        actionable: true,
        humanRequired: true,
        supportsApproveForSession: false,
      },
      // A bridge that still advertised a session grant: the adapter drops it.
      {
        approvalId: "stale-session-grant",
        kind: "command",
        requestedAt,
        expiresAt,
        command: "git push --force",
        actionable: true,
        humanRequired: true,
        supportsApproveForSession: true,
      },
      {
        approvalId: "plain",
        kind: "command",
        requestedAt,
        expiresAt,
        command: "npm test",
        actionable: true,
        ruleEligible: true,
        supportsApproveForSession: true,
      },
    ];
    const writes: Array<{ url: string; body: unknown }> = [];
    const { provider } = httpProvider((url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      writes.push({ url, body: JSON.parse(String(init.body)) });
      approvals = approvals.filter((entry) => !url.endsWith(`/${String(entry.approvalId)}`));
      return Response.json({ status: "applied" });
    }, codexConnection);

    const { requests } = await provider.interactions!.listPendingInteractions("session-1");
    const human = byId(requests, "human");
    const stale = byId(requests, "stale-session-grant");
    const plain = byId(requests, "plain");
    expect(human.humanRequired).toBe(true);
    expect(human.presentation.approveForSessionLabel).toBeUndefined();
    expect(stale.humanRequired).toBe(true);
    expect(stale.presentation.approveForSessionLabel).toBeUndefined();
    expect(plain).not.toHaveProperty("humanRequired");
    expect(plain.presentation.approveForSessionLabel).toBe("Approve for session");
    expect(provider.interactions!.permissionRuleDetail!("session-1", human.id)).toBeNull();

    // A session-wide answer is refused before anything reaches the bridge.
    const refused = await provider.interactions!.resolveInteraction("session-1", stale.id, {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      interactionId: stale.id,
      sessionId: stale.sessionId,
      action: "approve-for-session",
      resolvedAt: Math.max(Date.now(), stale.createdAt),
    });
    expect(refused.result).toBe("rejected");
    expect(writes).toHaveLength(0);
  });
});

describe("tool hints", () => {
  test("Codex: an MCP tool approval carries the hints its bridge read from _meta", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    const interactions = [
      {
        interactionId: "destructive",
        kind: "mcp-form",
        requestedAt,
        expiresAt,
        isBlocking: true,
        serverName: "linear",
        message: 'Allow the linear MCP server to run tool "delete_issue"?',
        schema: { type: "object", properties: {} },
        toolHints: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
      },
      {
        interactionId: "malformed",
        kind: "mcp-form",
        requestedAt,
        expiresAt,
        isBlocking: true,
        message: "Allow?",
        schema: { type: "object", properties: {} },
        toolHints: { readOnly: "yes", destructive: 1, readOnlyHint: true },
      },
      {
        interactionId: "none",
        kind: "mcp-form",
        requestedAt,
        expiresAt,
        isBlocking: true,
        message: "Choose a region",
        schema: { type: "object", properties: { region: { type: "string" } } },
      },
    ];
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals: [] });
      return Response.json({ interactions });
    }, codexConnection);
    const { requests } = await provider.interactions!.listPendingInteractions("session-1");
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(isAgentInteractionRequest(request)).toBe(true);
    expect(byId(requests, "destructive").toolHints).toEqual({
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
    });
    expect(byId(requests, "malformed")).not.toHaveProperty("toolHints");
    expect(byId(requests, "none")).not.toHaveProperty("toolHints");
  });

  test("Claude: an MCP tool approval carries the hints its bridge read from the CLI's status", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    // What `requestClaudeToolApproval` parks for an `mcp__*` call whose server
    // the CLI's status describes (pinned CLI 2.1.319 reports only `true` hints).
    const interactions = [
      {
        id: "destructive",
        kind: "permission",
        toolName: "mcp__linear__delete_issue",
        mcpServer: "linear",
        mcpServerSource: "user",
        input: '{"id":"ENG-1"}',
        ruleEligible: true,
        toolHints: { destructive: true },
        requestedAt,
        expiresAt,
      },
      {
        id: "malformed",
        kind: "permission",
        toolName: "mcp__linear__list_issues",
        mcpServer: "linear",
        toolHints: { readOnly: "true", readOnlyHint: true },
        requestedAt,
        expiresAt,
      },
    ];
    const { provider } = httpProvider(async (url) => {
      if (url.endsWith("/questions")) return Response.json({ questions: [] });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      return Response.json({ interactions });
    });
    const { requests } = await provider.interactions!.listPendingInteractions("session-1");
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(isAgentInteractionRequest(request)).toBe(true);
    const destructive = byId(requests, "destructive");
    expect(destructive.toolHints).toEqual({ destructive: true });
    expect(destructive.source).toMatchObject({ kind: "mcp-server", name: "linear" });
    // The hint is a label: the rule detail is the server's, as without it.
    expect(
      provider.interactions!.permissionRuleDetail!("session-1", destructive.id)?.subject,
    ).toEqual({ kind: "mcp-tool", server: "linear", tool: "delete_issue" });
    expect(byId(requests, "malformed")).not.toHaveProperty("toolHints");
  });

  test("Pi: an MCP tool's approval carries its hints, which never make it rule-eligible", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    // What `publicApprovals` in the Pi bridge serves for an MCP tool.
    const approvals = [
      {
        approvalId: "pi-mcp",
        requestedAt,
        expiresAt,
        hold: { available: true },
        reason: "Pi requested to run the mcp_linear_list_issues tool.",
        kind: "command",
        command: "mcp_linear_list_issues {}",
        cwd: "/workspace",
        toolHints: { readOnly: true },
      },
    ];
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals, revision: 1 });
      return Response.json({ interactions: [], revision: 1 });
    }, piConnection);
    const { requests } = await provider.interactions!.listPendingInteractions("session-1");
    const [request] = requests as [AgentInteractionRequest];
    expect(isAgentInteractionRequest(request)).toBe(true);
    expect(request.toolHints).toEqual({ readOnly: true });
    expect(request).not.toHaveProperty("humanRequired");
    expect(provider.interactions!.permissionRuleDetail!("session-1", request.id)).toBeNull();
  });
});
