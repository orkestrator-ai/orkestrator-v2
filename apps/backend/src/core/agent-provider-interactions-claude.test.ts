import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_LIMITS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import {
  httpProvider,
  declineResolution,
  answerResolution,
  freeTextResolution,
} from "./agent-provider-test-support.js";

describe("Claude interaction adapter", () => {
  test("Claude question previews are carried within their budget", async () => {
    const expiresAt = Date.now() + 60_000;
    const questionWith = (previews: Array<string | undefined>) => ({
      id: "question-1",
      sessionId: "session-1",
      expiresAt,
      questions: [
        {
          question: "Choose",
          header: "Choice",
          options: previews.map((preview, index) => ({
            label: `option ${index}`,
            ...(preview === undefined ? {} : { preview }),
          })),
        },
      ],
    });
    let questions = [questionWith(["a\n  b", undefined, "x".repeat(5_000)])];
    const { provider } = httpProvider(async (url) => {
      if (url.endsWith("/questions")) return Response.json({ questions });
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      return Response.json({ status: "idle" });
    });
    const options = async () =>
      (await provider.interactions!.listPendingInteractions("session-1")).requests[0]!.presentation
        .questions[0]!.options;

    const first = await options();
    expect(first[0]!.preview).toBe("a\n  b");
    expect(first[1]!.preview).toBeUndefined();
    expect(first[2]!.preview).toHaveLength(4_096);
    expect(first[2]!.preview!.endsWith("…")).toBe(true);

    // Together over the budget: the question still arrives, with no previews.
    questions = [questionWith(Array.from({ length: 10 }, () => "y".repeat(4_000)))];
    const second = await options();
    expect(second).toHaveLength(10);
    expect(second.every((option) => option.preview === undefined)).toBe(true);
  });

  test("Claude snapshots and exact response mapping satisfy the shared contract", async () => {
    const expiresAt = Date.now() + 60_000;
    let questions: Array<Record<string, unknown>> = [
      {
        id: "question-1",
        sessionId: "session-1",
        expiresAt,
        questions: [
          {
            question: "Choose",
            header: "Choice",
            options: [
              { label: "same", value: "exact-provider-value", description: "first" },
              { label: "same", description: "second" },
              { label: "comma,value" },
            ],
            multiSelect: true,
          },
        ],
      },
    ];
    let approvals: Array<Record<string, unknown>> = [
      {
        id: "approval-1",
        sessionId: "session-1",
        expiresAt,
        plan: "# Plan\n\n1. Make the change.\n2. Run the tests.",
      },
    ];
    const upstream: Array<{ url: string; body: unknown }> = [];
    const { provider } = httpProvider(async (url, init) => {
      if (url.endsWith("/questions")) return Response.json({ questions });
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals });
      if (url.includes("/questions/question-1/answer")) {
        upstream.push({ url, body: JSON.parse(String(init.body)) });
        questions = [];
        return Response.json({ status: "answered" });
      }
      if (url.includes("/plan-approvals/approval-1/respond")) {
        upstream.push({ url, body: JSON.parse(String(init.body)) });
        approvals = [];
        return Response.json({ status: "rejected" });
      }
      return Response.json({ status: "idle" });
    });
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
    });
    const first = await provider.interactions!.listPendingInteractions("session-1");
    expect(first.requests.map((request) => request.kind)).toEqual(["question", "plan-approval"]);
    expect(first.requests[1]!.presentation).toMatchObject({
      body: "# Plan\n\n1. Make the change.\n2. Run the tests.",
      confirmDisabled: false,
      planAvailable: true,
    });
    expect(first.requests[0]!.origin).toBe("build-pipeline");
    expect(
      first.requests[0]!.presentation.questions[0]!.options.map((option) => option.id),
    ).toEqual(["q0:o0", "q0:o1", "q0:o2"]);

    // A cached/adopted provider may be registered again, but a live request
    // keeps the policy it was presented under instead of switching owners.
    provider.registerSession?.("session-1", {
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      phase: "chat",
    });
    expect(
      (await provider.interactions!.listPendingInteractions("session-1")).requests[0]!.origin,
    ).toBe("build-pipeline");

    const question = first.requests[0]!;
    await expect(
      provider.interactions!.resolveInteraction(
        "other-session",
        question.id,
        answerResolution(question),
      ),
    ).resolves.toMatchObject({ result: "rejected" });
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        question.id,
        answerResolution(question),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    expect(upstream[0]!.body).toEqual({ answers: [["exact-provider-value"]] });

    const approval = (await provider.interactions!.listPendingInteractions("session-1"))
      .requests[0]!;
    await expect(
      provider.interactions!.resolveInteraction("session-1", approval.id, {
        ...declineResolution(approval),
        feedback: "Add rollback steps",
      }),
    ).resolves.toMatchObject({ result: "applied" });
    expect(upstream[1]!.body).toEqual({
      approved: false,
      feedback: "Add rollback steps",
    });
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        approval.id,
        declineResolution(approval),
      ),
    ).resolves.toMatchObject({ result: "stale" });
  });

  test("Claude rejects positive resolution for missing, provider-truncated, and oversized plans", async () => {
    const expiresAt = Date.now() + 60_000;
    const oversizedPlan = "x".repeat(AGENT_INTERACTION_LIMITS.maxTextLength + 1);
    let approvals: Array<Record<string, unknown>> = [
      { id: "missing-plan", expiresAt },
      { id: "provider-truncated", expiresAt, plan: "# Partial plan…", planTruncated: true },
      { id: "oversized-plan", expiresAt, plan: oversizedPlan },
    ];
    const upstream: Array<{ url: string; body: unknown }> = [];
    const { provider } = httpProvider(async (url, init) => {
      if (url.endsWith("/questions")) {
        return Response.json({
          questions: [
            {
              id: "question-1",
              expiresAt,
              questions: [{ question: "Continue reviewing?", options: [] }],
            },
          ],
        });
      }
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals });
      if (url.includes("/plan-approvals/")) {
        upstream.push({ url, body: JSON.parse(String(init.body)) });
        approvals = approvals.filter((approval) => !url.includes(String(approval.id)));
        return Response.json({ status: "rejected" });
      }
      return Response.json({ status: "idle" });
    });

    const snapshot = await provider.interactions!.listPendingInteractions("session-1");
    expect(snapshot.requests.map((request) => request.kind)).toEqual([
      "question",
      "plan-approval",
      "plan-approval",
      "plan-approval",
    ]);
    const plans = snapshot.requests.filter((request) => request.kind === "plan-approval");
    expect(plans[0]!.presentation).toMatchObject({
      confirmDisabled: true,
      planAvailable: false,
    });
    expect(plans[1]!.presentation).toMatchObject({
      body: "# Partial plan…",
      confirmDisabled: true,
      planAvailable: true,
    });
    expect(plans[2]!.presentation.body).toHaveLength(AGENT_INTERACTION_LIMITS.maxTextLength);
    expect(plans[2]!.presentation).toMatchObject({
      confirmDisabled: true,
      planAvailable: true,
    });

    for (const request of plans) {
      await expect(
        provider.interactions!.resolveInteraction(
          "session-1",
          request.id,
          answerResolution(request),
        ),
      ).resolves.toMatchObject({ result: "rejected" });
    }
    expect(upstream).toEqual([]);

    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        plans[0]!.id,
        declineResolution(plans[0]!),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body).toEqual({ approved: false });
  });

  test("Claude parks MCP elicitations and tool approvals and answers each exactly", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    let interactions: Array<Record<string, unknown>> = [
      {
        id: "form-1",
        kind: "mcp-form",
        serverName: "linear",
        message: "Which team?",
        schema: { type: "object", properties: { team: { type: "string" } } },
        requestedAt,
        expiresAt,
      },
      {
        id: "url-1",
        kind: "mcp-url",
        serverName: "linear",
        message: "Authorize Linear",
        url: "https://linear.app/oauth",
        requestedAt,
        expiresAt,
      },
      {
        id: "command-1",
        kind: "command-approval",
        toolName: "Bash",
        title: "Claude wants to run git push",
        command: "git push",
        requestedAt,
        expiresAt,
      },
      {
        id: "permission-1",
        kind: "permission",
        toolName: "mcp__linear__create_issue",
        mcpServer: "linear",
        input: '{"title":"Bug"}',
        requestedAt,
        expiresAt,
      },
    ];
    const upstream: Array<{ url: string; body: unknown }> = [];
    const { provider } = httpProvider(async (url, init) => {
      if (url.endsWith("/questions")) return Response.json({ questions: [] });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      const id = decodeURIComponent(url.split("/interactions/")[1] ?? "");
      upstream.push({ url, body: JSON.parse(String(init.body)) });
      interactions = interactions.filter((interaction) => interaction.id !== id);
      return Response.json({ status: "resolved" });
    });

    const snapshot = await provider.interactions!.listPendingInteractions("session-1");
    expect(snapshot.requests.map((request) => request.kind)).toEqual([
      "mcp-form",
      "mcp-url",
      "command-approval",
      "permission",
    ]);
    const [form, link, command, permission] = snapshot.requests as [
      AgentInteractionRequest,
      AgentInteractionRequest,
      AgentInteractionRequest,
      AgentInteractionRequest,
    ];
    expect(form.presentation).toMatchObject({ title: "linear needs input", body: "Which team?" });
    expect(JSON.parse(form.presentation.questions[0]!.description!)).toEqual({
      type: "object",
      properties: { team: { type: "string" } },
    });
    expect(link.presentation).toMatchObject({
      title: "Sign in to linear",
      url: "https://linear.app/oauth",
    });
    expect(command.presentation).toMatchObject({
      title: "Claude wants to run git push",
      body: "Command: git push",
      confirmLabel: "Approve",
    });
    expect(permission.presentation.title).toBe("Allow mcp__linear__create_issue");
    expect(permission.presentation.body).toContain('Input: {"title":"Bug"}');
    expect(snapshot.requests.every((request) => request.blocking === true)).toBe(true);

    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        form.id,
        freeTextResolution(form, JSON.stringify({ team: "core" })),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    await expect(
      provider.interactions!.resolveInteraction("session-1", link.id, answerResolution(link)),
    ).resolves.toMatchObject({ result: "applied" });
    // Allow-once only: nothing could honour "for the session".
    await expect(
      provider.interactions!.resolveInteraction("session-1", command.id, {
        ...answerResolution(command),
        action: "approve-for-session",
        answer: undefined,
      }),
    ).resolves.toMatchObject({ result: "rejected" });
    await expect(
      provider.interactions!.resolveInteraction("session-1", command.id, answerResolution(command)),
    ).resolves.toMatchObject({ result: "applied" });
    await expect(
      provider.interactions!.resolveInteraction("session-1", permission.id, {
        ...declineResolution(permission),
        action: "cancel",
      }),
    ).resolves.toMatchObject({ result: "applied" });

    expect(upstream).toEqual([
      {
        url: expect.stringContaining("/session/session-1/interactions/form-1"),
        body: { action: "accept", content: { team: "core" } },
      },
      {
        url: expect.stringContaining("/interactions/url-1"),
        body: { action: "accept" },
      },
      {
        url: expect.stringContaining("/interactions/command-1"),
        body: { action: "accept" },
      },
      {
        url: expect.stringContaining("/interactions/permission-1"),
        body: { action: "cancel" },
      },
    ]);
  });

  test("Claude maps a file approval with its paths and answers it exactly", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    let interactions: Array<Record<string, unknown>> = [
      {
        id: "file-1",
        kind: "file-approval",
        toolName: "Edit",
        toolUseId: "tu-1",
        paths: ["/repo/a.ts", "/repo/b.ts"],
        requestedAt,
        expiresAt,
      },
      {
        id: "file-2",
        kind: "file-approval",
        toolName: "Write",
        title: "Claude wants to create notes.md",
        paths: ["/repo/notes.md"],
        requestedAt,
        expiresAt,
      },
    ];
    const upstream: Array<{ url: string; body: unknown }> = [];
    const { provider } = httpProvider(async (url, init) => {
      if (url.endsWith("/questions")) return Response.json({ questions: [] });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      const id = decodeURIComponent(url.split("/interactions/")[1] ?? "");
      upstream.push({ url, body: JSON.parse(String(init.body)) });
      interactions = interactions.filter((interaction) => interaction.id !== id);
      return Response.json({ status: "resolved" });
    });

    const { requests } = await provider.interactions!.listPendingInteractions("session-1");
    expect(requests.map(({ kind }) => kind)).toEqual(["file-approval", "file-approval"]);
    const [edit, write] = requests as [AgentInteractionRequest, AgentInteractionRequest];
    expect(edit.presentation).toMatchObject({
      title: "Approve file changes",
      body: "File: /repo/a.ts\nFile: /repo/b.ts",
      questions: [],
      confirmLabel: "Approve",
      declineLabel: "Deny",
    });
    expect(edit.blocking).toBe(true);
    expect(edit.expiresAt).toBe(expiresAt);
    expect(write.presentation.title).toBe("Claude wants to create notes.md");

    await expect(
      provider.interactions!.resolveInteraction("session-1", edit.id, answerResolution(edit)),
    ).resolves.toMatchObject({ result: "applied" });
    await expect(
      provider.interactions!.resolveInteraction("session-1", write.id, declineResolution(write)),
    ).resolves.toMatchObject({ result: "applied" });
    expect(upstream).toEqual([
      { url: expect.stringContaining("/interactions/file-1"), body: { action: "accept" } },
      { url: expect.stringContaining("/interactions/file-2"), body: { action: "decline" } },
    ]);
  });

  test("a Claude bridge without the interactions route still serves its questions", async () => {
    const expiresAt = Date.now() + 60_000;
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/interactions")) return new Response(null, { status: 404 });
      return Response.json(
        url.endsWith("/questions")
          ? {
              questions: [
                { id: "question-1", expiresAt, questions: [{ question: "Go?", options: [] }] },
              ],
            }
          : { approvals: [] },
      );
    });
    const snapshot = await provider.interactions!.listPendingInteractions("session-1");
    expect(snapshot.requests.map((request) => request.kind)).toEqual(["question"]);
  });
});
