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
): LoopedReviewWorkflow {
  return {
    id: "workflow-1",
    environmentId: "env-1",
    agent,
    model: "default",
    sessions: [],
  } as unknown as LoopedReviewWorkflow;
}

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
