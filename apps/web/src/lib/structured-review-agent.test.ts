import { describe, expect, mock, test } from "bun:test";
import type { LoopedReviewWorkflow } from "@/stores/loopedReviewStore";
import {
  claudeAdapter,
  codexAdapter,
  getStructuredReviewPhasePolicy,
  openCodeAdapter,
} from "./structured-review-agent";

function workflow(
  agent: LoopedReviewWorkflow["agent"],
  model = "default",
): LoopedReviewWorkflow {
  return {
    id: "workflow-1",
    environmentId: "env-1",
    agent,
    model,
    sessions: [],
  } as unknown as LoopedReviewWorkflow;
}

/** One admitted backend session record, as `ensureNativeAgentSession` returns. */
function admitted(agent: LoopedReviewWorkflow["agent"]) {
  return {
    id: "record-1",
    key: "key-1",
    environmentId: "env-1",
    agent,
    logicalSessionKey: "key-1",
    providerSessionId: `${agent}-provider-session`,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

type AdmissionInput = {
  logicalSessionKey: string;
  model?: string;
  phase?: string;
  sessionMode?: string;
};

/**
 * Builds each provider's adapter over one recording `ensureSession`, so the
 * admission arguments can be compared across providers rather than per suite.
 */
function admissionAdapter(
  agent: LoopedReviewWorkflow["agent"],
  calls: AdmissionInput[],
  model = "default",
) {
  const ensureSession = mock(async (input: AdmissionInput) => {
    calls.push(input);
    return admitted(agent);
  });
  const reject = mock(async () => {
    throw new Error("direct creation must not run once admission is available");
  });
  const current = workflow(agent, model);
  if (agent === "claude") {
    return claudeAdapter({ baseUrl: "http://claude.test" }, current, {
      ensureSession: ensureSession as unknown as never,
      createSession: reject as unknown as never,
      sendStructuredPrompt: mock(async () => null) as unknown as never,
      getStructuredOutput: mock(async () => null) as unknown as never,
      lookupSession: mock(async () => ({ kind: "missing" as const })),
      abortSession: mock(async () => true),
    });
  }
  if (agent === "codex") {
    return codexAdapter({ baseUrl: "http://codex.test" }, current, {
      ensureSession: ensureSession as unknown as never,
      createSession: reject as unknown as never,
      sendPrompt: mock(async () => ({
        outcome: "accepted" as const,
        status: "processing" as const,
      })) as unknown as never,
      getStructuredOutput: mock(async () => null) as unknown as never,
      lookupSessionStatus: mock(async () => ({ kind: "missing" as const })),
      abortSession: mock(async () => ({ status: "accepted" as const })),
    });
  }
  return openCodeAdapter(
    {} as Parameters<typeof openCodeAdapter>[0],
    current,
    {
      ensureSession: ensureSession as unknown as never,
      createSession: reject as unknown as never,
      sendStructuredPrompt: mock(async () => ({
        success: true,
        requestId: "request-1",
      })) as unknown as never,
      getStructuredOutput: mock(async () => null) as unknown as never,
      lookupSessionStatus: mock(async () => ({ kind: "missing" as const })),
      abortSession: mock(async () => true),
    },
  );
}

const ALL_AGENTS = ["claude", "codex", "opencode"] as const;
/** `test.each` needs a mutable table, so the agents are wrapped as cases. */
const AGENT_CASES = ALL_AGENTS.map((agent) => ({ agent }));
const ALL_SESSION_PHASES = ["discovery", "preparation", "fix", "pr"] as const;

describe("structured review phase permissions", () => {
  test("discovery is read-only while preparation, fix, and PR phases may mutate", () => {
    expect(getStructuredReviewPhasePolicy("discovery")).toEqual({
      readOnly: true,
      claudePermissionMode: "plan",
      codexMode: "plan",
      openCodeMode: "plan",
    });
    for (const phase of ["preparation", "fix", "pr"] as const) {
      expect(getStructuredReviewPhasePolicy(phase)).toEqual({
        readOnly: false,
        claudePermissionMode: "bypassPermissions",
        codexMode: "build",
        openCodeMode: "build",
      });
    }
  });

  test("Claude sends discovery and reconciliation turns in plan mode", async () => {
    const permissionModes: string[] = [];
    let nextId = 0;
    const adapter = claudeAdapter(
      { baseUrl: "http://claude.test" },
      workflow("claude"),
      {
        createSession: mock(async () => ({ sessionId: `claude-${++nextId}` })),
        sendStructuredPrompt: mock(async (
          _client,
          _sessionId,
          _prompt,
          _schema,
          options,
        ) => {
          permissionModes.push(options.permissionMode ?? "");
          return {
            status: "processing" as const,
            requestId: options.requestId ?? "",
          };
        }),
        getStructuredOutput: mock(async () => null),
        lookupSession: mock(async () => ({ kind: "missing" as const })),
        abortSession: mock(async () => true),
      },
    );

    for (const phase of ["discovery", "preparation", "fix", "pr"] as const) {
      const sessionId = await adapter.createSession(phase, phase);
      await adapter.send(sessionId, "prompt", {}, `${phase}-request`);
    }
    expect(permissionModes).toEqual([
      "plan",
      "bypassPermissions",
      "bypassPermissions",
      "bypassPermissions",
    ]);
  });

  test("Codex creates only discovery sessions in plan mode", async () => {
    const modes: string[] = [];
    let nextId = 0;
    const adapter = codexAdapter(
      { baseUrl: "http://codex.test" },
      workflow("codex"),
      {
        createSession: mock(async (_client, options) => {
          modes.push(options.mode ?? "");
          return { sessionId: `codex-${++nextId}` };
        }),
        sendPrompt: mock(async () => ({
          outcome: "accepted" as const,
          status: "processing" as const,
        })),
        getStructuredOutput: mock(async () => null),
        lookupSessionStatus: mock(async () => ({ kind: "missing" as const })),
        abortSession: mock(async () => ({ status: "accepted" as const })),
      },
    );

    for (const phase of ["discovery", "preparation", "fix", "pr"] as const) {
      await adapter.createSession(phase, phase);
    }
    expect(modes).toEqual(["plan", "build", "build", "build"]);
  });

  test("routes looped-review session creation through backend logical admission", async () => {
    const ensureSession = mock(async () => ({
      id: "record-1",
      key: "key-1",
      environmentId: "env-1",
      agent: "codex" as const,
      logicalSessionKey: "looped-review:workflow-1:discovery:round-1:pass-1",
      providerSessionId: "provider-session",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }));
    const adapter = codexAdapter(
      { baseUrl: "http://codex.test" },
      workflow("codex"),
      {
        ensureSession,
        createSession: mock(async () => {
          throw new Error("direct creation must not run");
        }),
        sendPrompt: mock(async () => ({
          outcome: "accepted" as const,
          status: "processing" as const,
        })),
        getStructuredOutput: mock(async () => null),
        lookupSessionStatus: mock(async () => ({ kind: "missing" as const })),
        abortSession: mock(async () => ({ status: "accepted" as const })),
      },
    );

    await expect(
      adapter.createSession(
        "discovery",
        "Discovery",
        "looped-review:workflow-1:discovery:round-1:pass-1",
      ),
    ).resolves.toBe("provider-session");
    expect(ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey:
        "looped-review:workflow-1:discovery:round-1:pass-1",
      phase: "review",
    }));
  });

  test.each([
    {
      agent: "claude" as const,
      createAdapter: (ensureSession: ReturnType<typeof mock>) =>
        claudeAdapter(
          { baseUrl: "http://claude.test" },
          workflow("claude"),
          {
            ensureSession,
            createSession: mock(async () => {
              throw new Error("direct creation must not run");
            }),
            sendStructuredPrompt: mock(async () => null),
            getStructuredOutput: mock(async () => null),
            lookupSession: mock(async () => ({ kind: "missing" as const })),
            abortSession: mock(async () => true),
          },
        ),
    },
    {
      agent: "opencode" as const,
      createAdapter: (ensureSession: ReturnType<typeof mock>) =>
        openCodeAdapter(
          {} as Parameters<typeof openCodeAdapter>[0],
          workflow("opencode"),
          {
            ensureSession,
            createSession: mock(async () => {
              throw new Error("direct creation must not run");
            }),
            sendStructuredPrompt: mock(async () => ({
              success: true,
              requestId: "request-1",
            })),
            getStructuredOutput: mock(async () => null),
            lookupSessionStatus: mock(async () => ({ kind: "missing" as const })),
            abortSession: mock(async () => true),
          },
        ),
    },
  ])(
    "routes $agent looped-review sessions through backend logical admission",
    async ({ agent, createAdapter }) => {
      const ensureSession = mock(async () => ({
        id: "record-1",
        key: "key-1",
        environmentId: "env-1",
        agent,
        logicalSessionKey: "looped-review:workflow-1:discovery:round-1:pass-1",
        providerSessionId: `${agent}-provider-session`,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }));
      const adapter = createAdapter(ensureSession);

      await expect(
        adapter.createSession(
          "discovery",
          "Discovery",
          "looped-review:workflow-1:discovery:round-1:pass-1",
        ),
      ).resolves.toBe(`${agent}-provider-session`);
      expect(ensureSession).toHaveBeenCalledWith(expect.objectContaining({
        environmentId: "env-1",
        agent,
        logicalSessionKey:
          "looped-review:workflow-1:discovery:round-1:pass-1",
        phase: "review",
      }));
    },
  );

  test("OpenCode sends only discovery sessions in plan mode", async () => {
    const modes: string[] = [];
    let nextId = 0;
    const adapter = openCodeAdapter(
      {} as Parameters<typeof openCodeAdapter>[0],
      workflow("opencode"),
      {
        createSession: mock(async () => ({
          id: `opencode-${++nextId}`,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        })),
        sendStructuredPrompt: mock(async (
          _client,
          _sessionId,
          _prompt,
          _schema,
          options,
        ) => {
          modes.push(options.mode ?? "");
          return {
            success: true,
            requestId: options.requestId,
          };
        }),
        getStructuredOutput: mock(async () => null),
        lookupSessionStatus: mock(async () => ({ kind: "missing" as const })),
        abortSession: mock(async () => true),
      },
    );

    for (const phase of ["discovery", "preparation", "fix", "pr"] as const) {
      const sessionId = await adapter.createSession(phase, phase);
      await adapter.send(sessionId, "prompt", {}, `${phase}-request`);
    }
    expect(modes).toEqual(["plan", "build", "build", "build"]);
  });

  test.each(AGENT_CASES)(
    "$agent maps every session phase onto its backend pipeline phase",
    async ({ agent }) => {
      const calls: AdmissionInput[] = [];
      const adapter = admissionAdapter(agent, calls);

      for (const phase of ALL_SESSION_PHASES) {
        await adapter.createSession(phase, phase, `key-${phase}`);
      }

      // `fix` and `pr` are distinct backend pipeline phases; everything else
      // collapses onto `review`, which is what the backend uses to decide the
      // provider's execution mode.
      expect(calls.map((call) => call.phase))
        .toEqual(["review", "review", "fix", "pr"]);
    },
  );

  test.each(AGENT_CASES)(
    "$agent derives a logical session key when the caller supplies none",
    async ({ agent }) => {
      const calls: AdmissionInput[] = [];
      const adapter = admissionAdapter(agent, calls);

      await adapter.createSession("fix", "Fix round 2");

      // Admission is keyed on this string, so the fallback has to stay
      // deterministic per workflow/phase/label or a remount would admit a
      // second session for work that is already running.
      expect(calls.map((call) => call.logicalSessionKey))
        .toEqual(["looped-review:workflow-1:fix:Fix round 2"]);
    },
  );

  test("only Codex receives the default-model sentinel verbatim", async () => {
    // Claude and OpenCode treat "default" as "no explicit model" and must send
    // nothing, letting each provider apply its own configured default. Codex's
    // bridge accepts the sentinel as a real value, so forwarding it is correct.
    const calls: Record<string, AdmissionInput[]> = {};
    for (const agent of ALL_AGENTS) {
      calls[agent] = [];
      await admissionAdapter(agent, calls[agent]!).createSession(
        "discovery",
        "Discovery",
        "key-1",
      );
    }

    expect(calls.claude?.[0]?.model).toBeUndefined();
    expect(calls.opencode?.[0]?.model).toBeUndefined();
    expect(calls.codex?.[0]?.model).toBe("default");
  });

  test.each(AGENT_CASES)(
    "$agent forwards an explicitly chosen model unchanged",
    async ({ agent }) => {
      const calls: AdmissionInput[] = [];
      const adapter = admissionAdapter(agent, calls, "gpt-5.1-codex-max");

      await adapter.createSession("discovery", "Discovery", "key-1");

      expect(calls[0]?.model).toBe("gpt-5.1-codex-max");
    },
  );

  test("Claude drops the default-model sentinel from a structured prompt", async () => {
    const models: Array<string | undefined> = [];
    const adapter = claudeAdapter(
      { baseUrl: "http://claude.test" },
      workflow("claude"),
      {
        createSession: mock(async () => ({ sessionId: "claude-1" })),
        sendStructuredPrompt: mock(async (
          _client,
          _sessionId,
          _prompt,
          _schema,
          options,
        ) => {
          models.push(options.model);
          return { status: "processing" as const, requestId: "request-1" };
        }),
        getStructuredOutput: mock(async () => null),
        lookupSession: mock(async () => ({ kind: "missing" as const })),
        abortSession: mock(async () => true),
      },
    );

    const sessionId = await adapter.createSession("discovery", "Discovery");
    await adapter.send(sessionId, "prompt", {}, "request-1");

    expect(models).toEqual([undefined]);
  });

  test("OpenCode drops the default-model sentinel from a structured prompt", async () => {
    const models: Array<string | undefined> = [];
    const adapter = openCodeAdapter(
      {} as Parameters<typeof openCodeAdapter>[0],
      workflow("opencode"),
      {
        createSession: mock(async () => ({
          id: "opencode-1",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        })),
        sendStructuredPrompt: mock(async (
          _client,
          _sessionId,
          _prompt,
          _schema,
          options,
        ) => {
          models.push(options.model);
          return { success: true, requestId: options.requestId };
        }),
        getStructuredOutput: mock(async () => null),
        lookupSessionStatus: mock(async () => ({ kind: "missing" as const })),
        abortSession: mock(async () => true),
      },
    );

    const sessionId = await adapter.createSession("discovery", "Discovery");
    await adapter.send(sessionId, "prompt", {}, "request-1");

    expect(models).toEqual([undefined]);
  });

  /**
   * Documents current production behaviour, which is not the same as endorsing
   * it. `codexAdapter` computes `policy.codexMode` for every phase but only the
   * legacy direct-creation branch consumes it; the admission branch — the one
   * that runs, since `ensureSession` defaults to the real backend wrapper —
   * forwards `phase` and no mode at all. Read-only discovery survives only
   * because the backend independently derives `mode: "plan"` from the `review`
   * pipeline phase. `preparation` maps to `review` as well, so it inherits that
   * same read-only mode even though the policy asks for `build`.
   */
  test("Codex admission carries the policy mode, not just the pipeline phase", async () => {
    const calls: AdmissionInput[] = [];
    const adapter = admissionAdapter("codex", calls);

    for (const phase of ALL_SESSION_PHASES) {
      await adapter.createSession(phase, phase, `key-${phase}`);
    }

    // `discovery` and `preparation` both collapse onto the `review` pipeline
    // phase, which the bridge would create read-only. Only discovery is
    // read-only: preparation has to commit changes and write its validation
    // output, so the mode has to travel separately from the phase.
    expect(calls.map((call) => call.phase))
      .toEqual(["review", "review", "fix", "pr"]);
    expect(calls.map((call) => call.sessionMode))
      .toEqual(["plan", "build", "build", "build"]);
    expect(getStructuredReviewPhasePolicy("preparation").codexMode).toBe("build");
    expect(getStructuredReviewPhasePolicy("discovery").codexMode).toBe("plan");
  });

  test("status adapters distinguish missing sessions from unavailable transports", async () => {
    const unavailable = new Error("bridge unavailable");
    const missing = claudeAdapter(
      { baseUrl: "http://claude.test" },
      workflow("claude"),
      {
        createSession: mock(async () => ({ sessionId: "claude-1" })),
        sendStructuredPrompt: mock(async () => ({
          status: "processing" as const,
          requestId: "request-1",
        })),
        getStructuredOutput: mock(async () => null),
        lookupSession: mock(async () => ({ kind: "missing" as const })),
        abortSession: mock(async () => true),
      },
    );
    const down = codexAdapter(
      { baseUrl: "http://codex.test" },
      workflow("codex"),
      {
        createSession: mock(async () => ({ sessionId: "codex-1" })),
        sendPrompt: mock(async () => ({
          outcome: "accepted" as const,
          status: "processing" as const,
        })),
        getStructuredOutput: mock(async () => null),
        lookupSessionStatus: mock(async () => ({
          kind: "unavailable" as const,
          error: unavailable,
        })),
        abortSession: mock(async () => ({ status: "accepted" as const })),
      },
    );

    await expect(missing.getStatus("missing")).resolves.toBe("missing");
    await expect(down.getStatus("codex-1")).rejects.toBe(unavailable);
  });
});
