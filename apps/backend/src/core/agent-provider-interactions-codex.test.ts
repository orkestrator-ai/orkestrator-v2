import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_LIMITS,
  UNATTENDED_AGENT_INTERACTION_POLICY,
} from "@orkestrator/protocol/agent-interactions";
import { createNativeAgentProvider, ProviderUnavailableError } from "./native-agent-provider.js";
import {
  codexConnection,
  httpProvider,
  waitUntil,
  deferred,
  declineResolution,
  answerResolution,
  freeTextResolution,
} from "./agent-provider-test-support.js";

describe("Codex interaction adapter", () => {
  test("Codex recovers from snapshots, rejects stale generations, and resolves once", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    let approvals: Array<Record<string, unknown>> = [
      {
        approvalId: "approval-1",
        kind: "command",
        requestedAt,
        expiresAt,
        command: "safe-command",
      },
    ];
    let interactions: Array<Record<string, unknown>> = [
      {
        interactionId: "question-1",
        kind: "question",
        requestedAt,
        expiresAt,
        generation: 1,
        questions: [
          {
            id: "language",
            header: "Language",
            question: "Choose",
            isOther: true,
            isSecret: false,
            options: [{ label: "TypeScript" }],
          },
        ],
      },
    ];
    const gate = deferred();
    let approvalResponses = 0;
    const { provider } = httpProvider(async (url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      if (url.includes("/approvals/approval-1")) {
        approvalResponses += 1;
        await gate.promise;
        approvals = [];
        return Response.json({
          status: "applied",
          decision: JSON.parse(String(init.body)).decision,
        });
      }
      if (url.includes("/interactions/question-1")) {
        interactions = [];
        return Response.json({ status: "applied" });
      }
      return Response.json({ status: "idle" });
    }, codexConnection);
    provider.registerSession?.("session-1", {
      origin: "looped-review",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "discovery",
    });
    const snapshot = await provider.interactions!.listPendingInteractions("session-1");
    expect(snapshot.requests.map((request) => request.kind)).toEqual([
      "command-approval",
      "question",
    ]);
    const approval = snapshot.requests[0]!;
    const firstResolution = provider.interactions!.resolveInteraction(
      "session-1",
      approval.id,
      declineResolution(approval),
    );
    await waitUntil(() => approvalResponses === 1);
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        approval.id,
        declineResolution(approval),
      ),
    ).resolves.toMatchObject({ result: "already-resolved" });
    gate.resolve();
    await expect(firstResolution).resolves.toMatchObject({ result: "applied" });
    expect(approvalResponses).toBe(1);

    const question = (await provider.interactions!.listPendingInteractions("session-1"))
      .requests[0]!;
    expect(question.blocking).toBe(true);
    expect(question.presentation.questions[0]?.multiple).toBe(false);
    interactions = [];
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        question.id,
        answerResolution(question),
      ),
    ).resolves.toMatchObject({ result: "stale" });
  });

  test("Codex presents actionable approval scope and round-trips every MCP variant", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    let approvals: Array<Record<string, unknown>> = [
      {
        approvalId: "command-1",
        kind: "command",
        requestedAt,
        expiresAt,
        reason: "Needs package metadata",
        command: "bun install",
        cwd: "/workspace",
        networkHost: "registry.npmjs.org",
        actionable: true,
        supportsApproveForSession: true,
      },
      {
        approvalId: "file-1",
        kind: "file-change",
        requestedAt,
        expiresAt,
        changes: [{ path: "/workspace/a.ts", kind: "update" }],
        grantRoot: "/workspace",
        actionable: true,
      },
      {
        approvalId: "permission-1",
        kind: "permissions",
        requestedAt,
        expiresAt,
        permissions: { network: true, fileSystem: false },
        actionable: true,
      },
    ];
    let interactions: Array<Record<string, unknown>> = [
      {
        interactionId: "form-1",
        kind: "mcp-form",
        requestedAt,
        expiresAt,
        isBlocking: false,
        message: "Choose a region",
        schema: {
          type: "object",
          properties: { region: { type: "string" } },
          required: ["region"],
        },
      },
      {
        interactionId: "url-1",
        kind: "mcp-url",
        requestedAt,
        expiresAt,
        isBlocking: false,
        message: "Authorize",
        url: "https://example.test/authorize",
      },
    ];
    const responses: Array<{ id: string; body: unknown }> = [];
    const { provider } = httpProvider((url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      const approvalId = approvals.find(({ approvalId }) => url.endsWith(`/${approvalId}`))
        ?.approvalId as string | undefined;
      if (approvalId) {
        responses.push({ id: approvalId, body: JSON.parse(String(init.body)) });
        approvals = approvals.filter((entry) => entry.approvalId !== approvalId);
        return Response.json({ status: "applied" });
      }
      const interactionId = interactions.find(({ interactionId }) =>
        url.endsWith(`/${interactionId}`),
      )?.interactionId as string | undefined;
      if (interactionId) {
        responses.push({ id: interactionId, body: JSON.parse(String(init.body)) });
        interactions = interactions.filter((entry) => entry.interactionId !== interactionId);
        return Response.json({ status: "applied" });
      }
      return new Response(null, { status: 404 });
    }, codexConnection);

    const first = await provider.interactions!.listPendingInteractions("session-1");
    expect(first.requests.map(({ kind }) => kind)).toEqual([
      "command-approval",
      "file-approval",
      "permission",
      "mcp-form",
      "mcp-url",
    ]);
    expect(first.requests[0]!.presentation.body).toContain("Reason: Needs package metadata");
    expect(first.requests[0]!.presentation.body).toContain("Command: bun install");
    expect(first.requests[0]!.presentation.body).toContain("Network host: registry.npmjs.org");
    expect(first.requests[0]!.presentation.approveForSessionLabel).toBe("Approve for session");
    expect(first.requests[1]!.presentation.body).toContain("Change: update: /workspace/a.ts");
    expect(first.requests[2]!.presentation.body).toContain("Permissions: network");
    expect(first.requests[3]!.presentation.questions).toHaveLength(1);
    expect(first.requests[3]!.blocking).toBe(false);
    expect(first.requests[4]!.blocking).toBe(false);
    expect(first.requests[3]!.presentation.questions[0]!.description).toContain('"region"');

    await expect(
      provider.interactions!.resolveInteraction("session-1", first.requests[0]!.id, {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: first.requests[0]!.id,
        sessionId: first.requests[0]!.sessionId,
        action: "approve-for-session",
        resolvedAt: Math.max(Date.now(), first.requests[0]!.createdAt),
      }),
    ).resolves.toMatchObject({ result: "applied" });
    for (const approval of first.requests.slice(1, 3)) {
      await expect(
        provider.interactions!.resolveInteraction(
          "session-1",
          approval!.id,
          answerResolution(approval!),
        ),
      ).resolves.toMatchObject({ result: "applied" });
    }
    const form = (await provider.interactions!.listPendingInteractions("session-1")).requests.find(
      ({ kind }) => kind === "mcp-form",
    )!;
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        form.id,
        freeTextResolution(form, JSON.stringify({ region: "eu-west-1" })),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    const urlRequest = (
      await provider.interactions!.listPendingInteractions("session-1")
    ).requests.find(({ kind }) => kind === "mcp-url")!;
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        urlRequest.id,
        answerResolution(urlRequest),
      ),
    ).resolves.toMatchObject({ result: "applied" });

    expect(responses).toEqual([
      { id: "command-1", body: { decision: "approve-for-session" } },
      { id: "file-1", body: { decision: "approve" } },
      { id: "permission-1", body: { decision: "approve" } },
      { id: "form-1", body: { action: "accept", content: { region: "eu-west-1" } } },
      { id: "url-1", body: { action: "accept" } },
    ]);
  });

  test("Codex never offers or sends an older bridge's policy amendments", async () => {
    const requestedAt = Date.now();
    let approvals: Array<Record<string, unknown>> = [
      {
        approvalId: "command-amendment",
        kind: "command",
        requestedAt,
        expiresAt: requestedAt + 60_000,
        command: "curl https://two.example",
        actionable: true,
        amendments: [
          {
            kind: "exec-policy",
            detail: "allow curl",
            decision: "approve-with-execpolicy-amendment",
          },
          {
            kind: "network-policy",
            detail: "allow two.example",
            decision: "approve-with-network-amendment",
            amendmentIndex: 1,
          },
        ],
      },
    ];
    const bodies: unknown[] = [];
    const { provider } = httpProvider((url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      if (url.endsWith("/command-amendment")) {
        bodies.push(JSON.parse(String(init.body)));
        approvals = [];
        return Response.json({ status: "applied" });
      }
      return new Response(null, { status: 404 });
    }, codexConnection);

    // A bridge from before todo 0160 still describes the amendments; the card
    // must not offer them, because the rule each saves cannot be listed or revoked.
    const request = (await provider.interactions!.listPendingInteractions("session-1"))
      .requests[0]!;
    expect(request.presentation.questions).toEqual([]);
    expect(JSON.stringify(request)).not.toContain("allow curl");
    expect(JSON.stringify(request)).not.toContain("approve-with");

    await expect(
      provider.interactions!.resolveInteraction("session-1", request.id, {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: request.id,
        sessionId: request.sessionId,
        action: "answer",
        answer: {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: request.id,
          sessionId: request.sessionId,
          answers: [],
        },
        resolvedAt: Math.max(Date.now(), request.createdAt),
      }),
    ).resolves.toMatchObject({ result: "applied" });
    expect(bodies).toEqual([{ decision: "approve" }]);
  });

  test("Codex isolates malformed siblings and degrades large file and MCP payloads", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    const approvals = [
      { approvalId: "bad", kind: "future", requestedAt, expiresAt },
      {
        approvalId: "files",
        kind: "file-change",
        requestedAt,
        expiresAt,
        changes: Array.from({ length: 64 }, (_, index) => ({
          path: `/workspace/file-${index}.ts`,
          kind: "update",
        })),
      },
    ];
    let interactions: Array<Record<string, unknown>> = [
      {
        interactionId: "form",
        kind: "mcp-form",
        requestedAt,
        expiresAt,
        message: "x".repeat(20_000),
      },
      {
        interactionId: "question",
        kind: "question",
        requestedAt,
        expiresAt,
        questions: [
          {
            id: "language",
            question: "Choose",
            options: [{ label: "TypeScript" }],
          },
        ],
      },
    ];
    let answerBody: unknown;
    const { provider } = httpProvider((url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      if (url.includes("/interactions/question")) {
        answerBody = JSON.parse(String(init.body));
        interactions = interactions.filter(({ interactionId }) => interactionId !== "question");
        return Response.json({ status: "applied" });
      }
      return Response.json({ status: "applied" });
    }, codexConnection);

    const snapshot = await provider.interactions!.listPendingInteractions("session-1");
    expect(snapshot.requests.map(({ kind }) => kind)).toEqual([
      "file-approval",
      "mcp-form",
      "question",
    ]);
    const file = snapshot.requests[0]!;
    const form = snapshot.requests[1]!;
    const question = snapshot.requests[2]!;
    expect(file.presentation.body).toContain("… and 16 more files");
    expect(form.presentation.body?.length).toBe(AGENT_INTERACTION_LIMITS.maxTextLength);
    expect(form.presentation.questions[0]!.description).toBe("{}");
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        question.id,
        answerResolution(question),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    expect(answerBody).toEqual({
      action: "accept",
      answers: { language: ["TypeScript"] },
    });
  });

  test("HTTP bridge questions remain pending without a provider write", async () => {
    const requestedAt = Date.now();
    let writes = 0;
    const provider = createNativeAgentProvider(codexConnection, {
      fetch: (async (input, init = {}) => {
        const url = String(input);
        if (init.method && init.method !== "GET") writes += 1;
        return Response.json(
          url.endsWith("/approvals")
            ? { approvals: [] }
            : {
                interactions: [
                  {
                    interactionId: "question",
                    kind: "question",
                    requestedAt,
                    expiresAt: requestedAt + 60_000,
                    questions: [{ id: "q1", question: "Continue?", options: [] }],
                  },
                ],
              },
        );
      }) as typeof fetch,
    });
    await expect(
      provider.interactions!.listPendingInteractions("session-1"),
    ).resolves.toMatchObject({
      requests: [expect.objectContaining({ kind: "question" })],
    });
    expect(writes).toBe(0);
  });

  test("Codex refuses positive approval and malformed MCP form content without actionable detail", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    const approvals = [
      {
        approvalId: "missing-detail",
        kind: "file-change",
        requestedAt,
        expiresAt,
        reason: "Change requested",
        actionable: true,
      },
    ];
    const interactions = [
      {
        interactionId: "form-1",
        kind: "mcp-form",
        requestedAt,
        expiresAt,
        schema: { type: "object", properties: {} },
      },
    ];
    let writes = 0;
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      writes += 1;
      return Response.json({ status: "applied" });
    }, codexConnection);
    const snapshot = await provider.interactions!.listPendingInteractions("session-1");
    const approval = snapshot.requests.find(({ kind }) => kind === "file-approval")!;
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        approval.id,
        answerResolution(approval),
      ),
    ).resolves.toMatchObject({ result: "rejected" });
    const form = snapshot.requests.find(({ kind }) => kind === "mcp-form")!;
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        form.id,
        freeTextResolution(form, "not json"),
      ),
    ).resolves.toMatchObject({ result: "rejected" });
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        form.id,
        freeTextResolution(form, JSON.stringify(["not", "an", "object"])),
      ),
    ).resolves.toMatchObject({ result: "rejected" });
    expect(writes).toBe(0);

    const malformedFileChange = httpProvider(
      (url) =>
        Response.json(
          url.endsWith("/approvals")
            ? {
                approvals: [
                  {
                    approvalId: "malformed-file",
                    kind: "file-change",
                    requestedAt,
                    expiresAt,
                    changes: [{}],
                    actionable: true,
                  },
                ],
              }
            : { interactions: [] },
        ),
      codexConnection,
    );
    await expect(
      malformedFileChange.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
