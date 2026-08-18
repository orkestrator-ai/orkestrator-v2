import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_LIMITS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import {
  createNativeAgentProvider,
  ProviderUnavailableError,
  type ProviderSessionRegistration,
} from "./native-agent-provider.js";
import {
  codexConnection,
  httpProvider,
  waitUntil,
  deferred,
  declineResolution,
  answerResolution,
  freeTextResolution,
  openCodeFake,
  openCodeActivityProvider,
} from "./agent-provider-test-support.js";

describe("provider-neutral interaction adapters", () => {
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
      },
    ];
    const upstream: Array<{ url: string; body: unknown }> = [];
    const { provider } = httpProvider(async (url, init) => {
      if (url.endsWith("/questions")) return Response.json({ questions });
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

  test("lets the first real registration replace an implicit placeholder", async () => {
    const expiresAt = Date.now() + 60_000;
    const { provider } = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions")
          ? {
              questions: [
                {
                  id: "question-1",
                  expiresAt,
                  questions: [{ question: "Choose", options: [] }],
                },
              ],
            }
          : { approvals: [] },
      ),
    );

    // Reading a snapshot for an unknown session registers it implicitly with
    // DEFAULT_SESSION_REGISTRATION. That placeholder is not a decision, so it
    // must not out-rank the authoritative registration that follows — first
    // -write-wins protects a real policy from being flipped, not a default from
    // being filled in. Locking here would silently leave an unattended build
    // session on the interactive policy, where it stops auto-resolving.
    const implicit = await provider.interactions!.listPendingInteractions("session-1");
    expect(implicit.requests[0]!.origin).toBe("interactive-native");

    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "workflow-1",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    const afterRegistration = await provider.interactions!.listPendingInteractions("session-1");
    expect(afterRegistration.requests[0]!.origin).toBe("build-pipeline");
    const internal = provider as unknown as {
      interactionAdapter: {
        interactionTracker: {
          registration(sessionId: string): ProviderSessionRegistration;
        };
      };
    };
    expect(internal.interactionAdapter.interactionTracker.registration("session-1")).toEqual({
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "workflow-1",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    // A second registration still cannot flip the live session back.
    provider.registerSession?.("session-1", {
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
    });
    expect(internal.interactionAdapter.interactionTracker.registration("session-1")).toMatchObject({
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
    });
  });

  test("fills in registration metadata a first caller did not know", async () => {
    const { provider } = httpProvider(() =>
      Response.json({
        questions: [],
        approvals: [],
      }),
    );
    const internal = provider as unknown as {
      interactionAdapter: {
        interactionTracker: {
          registration(sessionId: string): ProviderSessionRegistration;
        };
      };
    };

    // The activity sweep registers without a phase; the interaction reconciler
    // registers with one. Whichever lands first must not cost the other its
    // fields, so long as origin and policy agree.
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      workflowId: "workflow-1",
    });
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    expect(internal.interactionAdapter.interactionTracker.registration("session-1")).toEqual({
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      workflowId: "workflow-1",
      phase: "build",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    // A recorded fence is never replaced: it identifies the generation that
    // owns any request already in flight.
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      workflowId: "workflow-2",
      fence: "pipeline:build:2",
    });
    expect(internal.interactionAdapter.interactionTracker.registration("session-1")).toMatchObject({
      workflowId: "workflow-1",
      fence: "pipeline:build:1",
    });
  });

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

  test("HTTP bridge questions remain pending without using the OpenCode observation hook", async () => {
    const requestedAt = Date.now();
    let observations = 0;
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
      onInteractionObservation: () => {
        observations += 1;
      },
    });
    await expect(
      provider.interactions!.listPendingInteractions("session-1"),
    ).resolves.toMatchObject({
      requests: [expect.objectContaining({ kind: "question" })],
    });
    expect(observations).toBe(0);
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

  test("OpenCode lists input and authorization without auto-answering and preserves values", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [
        {
          id: "permission-1",
          sessionID: "owned-session",
          permission: "edit",
          patterns: [],
          metadata: {},
          always: [],
        },
      ],
      [
        {
          id: "question-1",
          sessionID: "owned-session",
          questions: [
            {
              question: "Choose",
              header: "Choice",
              options: [{ label: "comma,value", description: "kept intact" }],
              multiple: false,
              custom: true,
            },
          ],
        },
      ],
    );
    const provider = openCodeActivityProvider(fake);
    provider.registerSession?.("owned-session", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "review",
    });
    const snapshot = await provider.interactions!.listPendingInteractions("owned-session");
    expect(snapshot.requests.map((request) => request.kind)).toEqual(["question", "permission"]);
    expect(fake.permissionReplies).toEqual([]);
    expect(fake.questionRejections).toEqual([]);

    const question = snapshot.requests[0]!;
    await expect(
      provider.interactions!.resolveInteraction(
        "owned-session",
        question.id,
        answerResolution(question),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    expect(fake.questionReplies[0]).toMatchObject({
      requestID: "question-1",
      answers: [["comma,value"]],
    });
    const permission = (await provider.interactions!.listPendingInteractions("owned-session"))
      .requests[0]!;
    await expect(
      provider.interactions!.resolveInteraction(
        "owned-session",
        permission.id,
        declineResolution(permission),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    expect(fake.permissionReplies[0]).toMatchObject({
      requestID: "permission-1",
      reply: "reject",
    });
    await provider.dispose?.();
  });

  test("OpenCode preserves multi-select and free text, presents permission scope, and resolves once", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [
        {
          id: "permission-1",
          sessionID: "owned-session",
          permission: "edit",
          patterns: ["src/**", "package.json"],
          metadata: {},
          always: ["src/**"],
        },
      ],
      [
        {
          id: "question-1",
          sessionID: "owned-session",
          questions: [
            {
              question: "Choose targets",
              header: "Targets",
              options: [{ label: "one" }, { label: "two" }],
              multiple: true,
              custom: true,
            },
          ],
        },
      ],
    );
    const provider = openCodeActivityProvider(fake);
    try {
      const first = await provider.interactions!.listPendingInteractions("owned-session");
      const question = first.requests.find(({ kind }) => kind === "question")!;
      const q = question.presentation.questions[0]!;
      const answer: AgentInteractionResolution = {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: question.id,
        sessionId: question.sessionId,
        action: "answer",
        resolvedAt: Math.max(Date.now(), question.createdAt),
        answer: {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: question.id,
          sessionId: question.sessionId,
          answers: [
            {
              questionId: q.id,
              optionIds: q.options.map(({ id }) => id),
              freeText: "custom, value",
            },
          ],
        },
      };
      await expect(
        provider.interactions!.resolveInteraction("owned-session", question.id, answer),
      ).resolves.toMatchObject({ result: "applied" });
      await expect(
        provider.interactions!.resolveInteraction("owned-session", question.id, answer),
      ).resolves.toMatchObject({ result: "stale" });
      expect(fake.questionReplies).toHaveLength(1);
      expect(fake.questionReplies[0]).toMatchObject({
        requestID: "question-1",
        answers: [["one", "two", "custom, value"]],
      });

      const permission = (await provider.interactions!.listPendingInteractions("owned-session"))
        .requests[0]!;
      expect(permission.presentation.body).toContain("Permission: edit");
      expect(permission.presentation.body).toContain("Resource: src/**");
      expect(permission.presentation.body).toContain("Resource: package.json");
      expect(permission.presentation.approveForSessionLabel).toBe("Always allow");
      await expect(
        provider.interactions!.resolveInteraction("owned-session", permission.id, {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: permission.id,
          sessionId: permission.sessionId,
          action: "approve-for-session",
          resolvedAt: Math.max(Date.now(), permission.createdAt),
        }),
      ).resolves.toMatchObject({ result: "applied" });
      expect(fake.permissionReplies[0]).toMatchObject({
        requestID: "permission-1",
        reply: "always",
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("OpenCode serializes concurrent resolution of the same interaction", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [],
      [
        {
          id: "question-1",
          sessionID: "owned-session",
          questions: [{ question: "Choose", options: [] }],
        },
      ],
    );
    const provider = openCodeActivityProvider(fake);
    const gate = deferred();
    fake.setQuestionReplyGate(gate.promise);
    try {
      const request = (await provider.interactions!.listPendingInteractions("owned-session"))
        .requests[0]!;
      const first = provider.interactions!.resolveInteraction(
        "owned-session",
        request.id,
        answerResolution(request),
      );
      await waitUntil(() => fake.questionReplies.length === 1);
      await expect(
        provider.interactions!.resolveInteraction(
          "owned-session",
          request.id,
          answerResolution(request),
        ),
      ).resolves.toMatchObject({ result: "already-resolved" });
      gate.resolve();
      await expect(first).resolves.toMatchObject({ result: "applied" });
      expect(fake.questionReplies).toHaveLength(1);
    } finally {
      gate.resolve();
      await provider.dispose?.();
    }
  });

  test("OpenCode reconciles ambiguous interaction writes without guessing", async () => {
    for (const [applied, expected] of [
      [true, "applied"],
      [false, "provider-unavailable"],
    ] as const) {
      const fake = openCodeFake();
      fake.setPending(
        [],
        [
          {
            id: "question-1",
            sessionID: "owned-session",
            questions: [{ question: "Choose", options: [] }],
          },
        ],
      );
      const provider = openCodeActivityProvider(fake);
      try {
        const request = (await provider.interactions!.listPendingInteractions("owned-session"))
          .requests[0]!;
        fake.setQuestionReplyFailure(new TypeError("connection reset"), applied);
        await expect(
          provider.interactions!.resolveInteraction(
            "owned-session",
            request.id,
            answerResolution(request),
          ),
        ).resolves.toMatchObject({ result: expected });
        expect(fake.questionReplies).toHaveLength(1);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("OpenCode rejects unscoped positive permissions and maps question cancel to reject", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [
        {
          id: "permission-1",
          sessionID: "owned-session",
          permission: "edit",
          patterns: [],
          metadata: {},
          always: [],
        },
      ],
      [
        {
          id: "question-1",
          sessionID: "owned-session",
          questions: [{ question: "Continue?", options: [], custom: true }],
        },
      ],
    );
    const provider = openCodeActivityProvider(fake);
    try {
      const snapshot = await provider.interactions!.listPendingInteractions("owned-session");
      const permission = snapshot.requests.find(({ kind }) => kind === "permission")!;
      await expect(
        provider.interactions!.resolveInteraction(
          "owned-session",
          permission.id,
          answerResolution(permission),
        ),
      ).resolves.toMatchObject({ result: "rejected" });
      expect(fake.permissionReplies).toHaveLength(0);

      const question = snapshot.requests.find(({ kind }) => kind === "question")!;
      await expect(
        provider.interactions!.resolveInteraction("owned-session", question.id, {
          ...declineResolution(question),
          action: "cancel",
        }),
      ).resolves.toMatchObject({ result: "applied" });
      expect(fake.questionRejections).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("OpenCode fails closed on malformed, globally oversized, and overlong-id list payloads", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ data: {} }, { data: [] }],
      [
        {
          data: [
            {
              id: "permission-1",
              sessionID: "owned-session",
              permission: "edit",
              patterns: [123],
              metadata: {},
              always: [],
            },
          ],
        },
        { data: [] },
      ],
      [
        {
          data: [
            {
              id: "permission-1",
              sessionID: "owned-session",
              permission: "edit",
              patterns: ["x".repeat(300_000)],
              metadata: {},
              always: [],
            },
          ],
        },
        { data: [] },
      ],
      [
        { data: [] },
        {
          data: [
            {
              id: "x".repeat(513),
              sessionID: "owned-session",
              questions: [{ question: "Choose", options: [] }],
            },
          ],
        },
      ],
    ];
    for (const [permissions, questions] of cases) {
      const fake = openCodeFake();
      fake.setPendingReadResponses(permissions, questions);
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(
          provider.interactions!.listPendingInteractions("owned-session"),
        ).rejects.toBeInstanceOf(ProviderUnavailableError);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("OpenCode ignores malformed foreign entries and tolerates an absent list payload", async () => {
    const fake = openCodeFake();
    fake.setPendingReadResponses(
      {
        data: [
          {
            id: "permission-foreign",
            sessionID: "x".repeat(513),
            permission: "edit",
            patterns: ["x".repeat(300_000)],
          },
        ],
      },
      { data: null },
    );
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(
        provider.interactions!.listPendingInteractions("owned-session"),
      ).resolves.toMatchObject({ requests: [] });
      fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
      await expect(provider.activity?.("owned-session")).resolves.toBe("working");
    } finally {
      await provider.dispose?.();
    }
  });

  test("all adapters fail closed on malformed or oversized authoritative snapshots", async () => {
    const oversized = "x".repeat(300_000);
    const claude = httpProvider(() => new Response(oversized));
    await expect(
      claude.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const codex = httpProvider(
      (url) =>
        url.endsWith("/approvals")
          ? Response.json({ approvals: [{ approvalId: "bad", kind: "future" }] })
          : Response.json({ interactions: [] }),
      codexConnection,
    );
    await expect(
      codex.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const fake = openCodeFake();
    fake.setPending([], [{ id: "bad", sessionID: "session-1", questions: [] }]);
    const opencode = openCodeActivityProvider(fake);
    await expect(
      opencode.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await opencode.dispose?.();

    const malformedClaudeQuestion = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions")
          ? {
              questions: [
                {
                  id: "bad-question",
                  questions: [{ question: "Choose", options: [{}] }],
                },
              ],
            }
          : { approvals: [] },
      ),
    );
    await expect(
      malformedClaudeQuestion.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const now = Date.now();
    const malformedCodexQuestion = httpProvider(
      (url) =>
        Response.json(
          url.endsWith("/approvals")
            ? { approvals: [] }
            : {
                interactions: [
                  {
                    interactionId: "bad-question",
                    kind: "question",
                    requestedAt: now,
                    expiresAt: now + 60_000,
                    questions: [{ id: "q1", options: [] }],
                  },
                ],
              },
        ),
      codexConnection,
    );
    await expect(
      malformedCodexQuestion.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const malformedOpenCodeQuestion = openCodeFake();
    malformedOpenCodeQuestion.setPending(
      [],
      [
        {
          id: "bad-option",
          sessionID: "session-1",
          questions: [{ question: "Choose", options: [{}] }],
        },
      ],
    );
    const malformedOpenCodeProvider = openCodeActivityProvider(malformedOpenCodeQuestion);
    await expect(
      malformedOpenCodeProvider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await malformedOpenCodeProvider.dispose?.();

    for (const body of ["{", null] as const) {
      const malformed = httpProvider(() => new Response(body, { status: 200 }));
      await expect(
        malformed.provider.interactions!.listPendingInteractions("session-1"),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  test("HTTP adapters bound the combined snapshot and scope opaque IDs to a session", async () => {
    const combinedOversized = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions")
          ? { questions: [], padding: "x".repeat(140_000) }
          : { approvals: [], padding: "x".repeat(140_000) },
      ),
    );
    await expect(
      combinedOversized.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const expiresAt = Date.now() + 60_000;
    const responses: string[] = [];
    const scoped = httpProvider((url) => {
      const sessionId = url.includes("session-a") ? "session-a" : "session-b";
      if (url.endsWith("/questions")) {
        return Response.json({
          questions: [
            {
              id: "same-provider-id",
              expiresAt,
              questions: [{ question: sessionId, options: [] }],
            },
          ],
        });
      }
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      responses.push(url);
      return Response.json({ status: "answered" });
    });
    const requestA = (await scoped.provider.interactions!.listPendingInteractions("session-a"))
      .requests[0]!;
    const requestB = (await scoped.provider.interactions!.listPendingInteractions("session-b"))
      .requests[0]!;
    expect(requestA.id).not.toBe(requestB.id);
    await expect(
      scoped.provider.interactions!.resolveInteraction(
        "session-a",
        requestB.id,
        answerResolution(requestB),
      ),
    ).resolves.toMatchObject({ result: "rejected" });
    expect(responses).toEqual([]);
  });

  test("HTTP interaction snapshots keep stable revisions and advance on every authoritative reset", async () => {
    const expiresAt = Date.now() + 60_000;
    let questions: Array<Record<string, unknown>> = [];
    const { provider } = httpProvider((url) =>
      Response.json(url.endsWith("/questions") ? { questions } : { approvals: [] }),
    );
    const empty = await provider.interactions!.listPendingInteractions("session-1");
    const sameEmpty = await provider.interactions!.listPendingInteractions("session-1");
    expect(sameEmpty.revision).toBe(empty.revision);

    questions = [
      {
        id: "question-1",
        expiresAt,
        questions: [{ question: "Choose", options: [] }],
      },
    ];
    const pending = await provider.interactions!.listPendingInteractions("session-1");
    const samePending = await provider.interactions!.listPendingInteractions("session-1");
    expect(pending.revision).toBe(empty.revision + 1);
    expect(samePending.revision).toBe(pending.revision);
    expect(samePending.requests[0]!.revision).toBe(pending.revision);

    questions = [];
    const reset = await provider.interactions!.listPendingInteractions("session-1");
    expect(reset.revision).toBe(pending.revision + 1);
    expect(reset.requests).toEqual([]);
  });

  test("bounds tracker sessions, interaction identities, and pending snapshots", async () => {
    const expiresAt = Date.now() + 60_000;
    const { provider } = httpProvider(() => Response.json({ questions: [], approvals: [] }));
    const internal = provider as unknown as {
      interactionAdapter: {
        interactionTracker: {
          registrations: Map<string, ProviderSessionRegistration>;
          firstSeenAt: Map<string, number>;
          interactionSessions: Map<string, string>;
          registration(sessionId: string): ProviderSessionRegistration;
          firstSeen(interactionId: string, fallback?: number): number;
          sessionFor(interactionId: string): string | undefined;
          snapshot(sessionId: string, requests: AgentInteractionRequest[]): unknown;
        };
        providerInteractionIds: Map<string, unknown>;
        mapClaudeQuestion(sessionId: string, raw: unknown): AgentInteractionRequest;
      };
    };
    const adapter = internal.interactionAdapter;
    for (let index = 0; index < 1_025; index += 1) {
      provider.registerSession?.(`session-${index}`, {
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: `phase-${index}`,
      });
    }
    expect(adapter.interactionTracker.registrations.size).toBe(1_024);
    expect(adapter.interactionTracker.registration("session-0").origin).toBe("interactive-native");
    expect(adapter.interactionTracker.registration("session-1024").phase).toBe("phase-1024");

    let oldestInteractionId = "";
    let newestInteractionId = "";
    let newestSessionId = "";
    for (let offset = 0; offset < 4_097; offset += 64) {
      const trackerSessionId = `tracker-session-${Math.floor(offset / 64)}`;
      const batch = Array.from({ length: Math.min(64, 4_097 - offset) }, (_, batchIndex) => {
        const index = offset + batchIndex;
        const mapped = adapter.mapClaudeQuestion(trackerSessionId, {
          id: `question-${index}`,
          expiresAt,
          questions: [{ question: `Question ${index}`, options: [] }],
        });
        adapter.interactionTracker.firstSeen(mapped.id, index);
        oldestInteractionId ||= mapped.id;
        newestInteractionId = mapped.id;
        newestSessionId = trackerSessionId;
        return mapped;
      });
      adapter.interactionTracker.snapshot(trackerSessionId, batch);
    }
    expect(adapter.providerInteractionIds.size).toBe(4_096);
    expect(adapter.interactionTracker.firstSeenAt.size).toBe(4_096);
    expect(adapter.interactionTracker.interactionSessions.size).toBe(4_096);
    expect(adapter.providerInteractionIds.has(oldestInteractionId)).toBe(false);
    expect(adapter.interactionTracker.firstSeenAt.has(oldestInteractionId)).toBe(false);
    expect(adapter.interactionTracker.sessionFor(oldestInteractionId)).toBeUndefined();
    expect(adapter.providerInteractionIds.has(newestInteractionId)).toBe(true);
    expect(adapter.interactionTracker.firstSeenAt.has(newestInteractionId)).toBe(true);
    expect(adapter.interactionTracker.sessionFor(newestInteractionId)).toBe(newestSessionId);

    const tooMany = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions")
          ? {
              questions: Array.from({ length: 65 }, (_, index) => ({
                id: `question-${index}`,
                expiresAt,
                questions: [{ question: `Question ${index}`, options: [] }],
              })),
            }
          : { approvals: [] },
      ),
    );
    await expect(
      tooMany.provider.interactions!.listPendingInteractions("session-1"),
    ).resolves.toMatchObject({ requests: expect.any(Array) });
  });

  test("accepts a new policy only after a tracked session is evicted", async () => {
    const { provider } = httpProvider(() => Response.json({ questions: [], approvals: [] }));
    const internal = provider as unknown as {
      interactionAdapter: {
        interactionTracker: {
          registrations: Map<string, ProviderSessionRegistration>;
          registration(sessionId: string): ProviderSessionRegistration;
        };
      };
    };
    const tracker = internal.interactionAdapter.interactionTracker;
    const unattended: ProviderSessionRegistration = {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "workflow-1",
      provider: "claude",
      fence: "pipeline:build:1",
    };
    provider.registerSession?.("session-0", unattended);
    // The whole registration round-trips, not just origin/policy: unattended
    // adoption is decided from the workflow ownership fence.
    expect(tracker.registration("session-0")).toEqual(unattended);

    // One insert past MAX_TRACKED_INTERACTION_SESSIONS drops the oldest entry,
    // which is the session registered first.
    for (let index = 1; index <= 1_024; index += 1) {
      provider.registerSession?.(`filler-${index}`, {
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
    }
    expect(tracker.registrations.size).toBe(1_024);
    expect(tracker.registrations.has("session-0")).toBe(false);

    // First-write-wins protects a *live* entry. Once evicted there is no policy
    // left to preserve, so the next registration is accepted outright.
    const interactive: ProviderSessionRegistration = {
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      phase: "chat",
      workflowId: "workflow-2",
      provider: "claude",
      fence: 2,
    };
    provider.registerSession?.("session-0", interactive);
    expect(tracker.registration("session-0")).toEqual(interactive);
  });

  test("rejects oversized HTTP identities before retaining tracker state", async () => {
    const oversizedId = "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1);
    const { provider } = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions")
          ? {
              questions: [
                {
                  id: oversizedId,
                  questions: [{ question: "Choose", options: [] }],
                },
              ],
            }
          : { approvals: [] },
      ),
    );
    const internal = provider as unknown as {
      interactionAdapter: {
        providerInteractionIds: Map<string, unknown>;
        interactionTracker: {
          fingerprints: Map<string, string>;
          revisions: Map<string, number>;
          interactionSessions: Map<string, string>;
        };
      };
    };
    const adapter = internal.interactionAdapter;

    await expect(
      provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(adapter.providerInteractionIds.size).toBe(0);
    expect(adapter.interactionTracker.fingerprints.size).toBe(0);
    expect(adapter.interactionTracker.revisions.size).toBe(0);
    expect(adapter.interactionTracker.interactionSessions.size).toBe(0);
  });

  test.each([
    [404, "stale"],
    [409, "stale"],
    [503, "provider-unavailable"],
    [400, "rejected"],
    [204, "provider-unavailable"],
  ] as const)(
    "classifies an HTTP %s interaction response as %s",
    async (responseStatus, expected) => {
      const expiresAt = Date.now() + 60_000;
      const questions = [
        {
          id: "question-1",
          expiresAt,
          questions: [{ question: "Choose", options: [] }],
        },
      ];
      let writes = 0;
      const { provider } = httpProvider((url) => {
        if (url.endsWith("/questions")) return Response.json({ questions });
        if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
        writes += 1;
        return new Response(null, { status: responseStatus });
      });
      const request = (await provider.interactions!.listPendingInteractions("session-1"))
        .requests[0]!;
      await expect(
        provider.interactions!.resolveInteraction(
          "session-1",
          request.id,
          answerResolution(request),
        ),
      ).resolves.toMatchObject({ result: expected });
      expect(writes).toBe(1);
    },
  );

  test("reconciles ambiguous HTTP interaction writes and rejects expired resolutions", async () => {
    const createdAt = Date.now() - 120_000;
    let questions: Array<Record<string, unknown>> = [
      {
        id: "question-1",
        expiresAt: Date.now() + 60_000,
        questions: [{ question: "Choose", options: [] }],
      },
    ];
    let writes = 0;
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/questions")) return Response.json({ questions });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      writes += 1;
      questions = [];
      throw new TypeError("connection reset");
    });
    const request = (await provider.interactions!.listPendingInteractions("session-1"))
      .requests[0]!;
    await expect(
      provider.interactions!.resolveInteraction("session-1", request.id, answerResolution(request)),
    ).resolves.toMatchObject({ result: "applied" });
    expect(writes).toBe(1);

    const expiredQuestions = [
      {
        id: "expired",
        expiresAt: createdAt + 1,
        questions: [{ question: "Too late", options: [] }],
      },
    ];
    const expiredProvider = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions") ? { questions: expiredQuestions } : { approvals: [] },
      ),
    ).provider;
    const expired = (await expiredProvider.interactions!.listPendingInteractions("session-1"))
      .requests[0]!;
    await expect(
      expiredProvider.interactions!.resolveInteraction(
        "session-1",
        expired.id,
        answerResolution(expired),
      ),
    ).resolves.toMatchObject({ result: "stale" });
  });

  test("fails closed when HTTP interaction write reconciliation cannot prove application", async () => {
    const expiresAt = Date.now() + 60_000;
    const question = {
      id: "question-1",
      expiresAt,
      questions: [{ question: "Choose", options: [] }],
    };
    for (const successfulWrite of [false, true]) {
      let wrote = false;
      const { provider } = httpProvider((url) => {
        if (url.endsWith("/questions")) {
          if (wrote) throw new Error("reconciliation unavailable");
          return Response.json({ questions: [question] });
        }
        if (url.endsWith("/plan-approvals")) {
          if (wrote) throw new Error("reconciliation unavailable");
          return Response.json({ approvals: [] });
        }
        wrote = true;
        if (!successfulWrite) throw new TypeError("connection reset");
        return Response.json({ status: "answered" });
      });
      const request = (await provider.interactions!.listPendingInteractions("session-1"))
        .requests[0]!;
      await expect(
        provider.interactions!.resolveInteraction(
          "session-1",
          request.id,
          answerResolution(request),
        ),
      ).resolves.toMatchObject({ result: "provider-unavailable" });
    }
  });
});
