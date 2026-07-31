import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_JOURNAL_RETENTION_MS,
  AGENT_INTERACTION_JOURNAL_VERSION,
  AGENT_INTERACTION_KINDS,
  AGENT_INTERACTION_LIMITS,
  AGENT_INTERACTION_PROVIDERS,
  AGENT_INTERACTION_STATES,
  AGENT_INTERACTION_SUMMARY_VERSION,
  agentInteractionPolicyAction,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  isAgentInteractionAnswer,
  isAgentInteractionApplyOutcome,
  isAgentInteractionPolicy,
  isAgentInteractionRequest,
  isAgentInteractionResolution,
  isAgentInteractionResolutionJournal,
  isAgentInteractionSnapshot,
  isAgentInteractionWorkflowSummary,
  pruneAgentInteractionResolutionJournal,
  serializeAgentInteractionDraft,
  serializeAgentInteractionTelemetry,
  serializeAgentInteractionTranscriptEvent,
  serializeAgentInteractionWorkflowSummary,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionAnswer,
  type AgentInteractionKind,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionResolutionJournal,
  type AgentInteractionState,
  type AgentInteractionWorkflowSummary,
} from "./agent-interactions.js";

const CREATED_AT = 1_800_000_000_000;

function request(
  kind: AgentInteractionKind = "question",
  state: AgentInteractionState = "pending",
): AgentInteractionRequest {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id: `interaction-${kind}`,
    provider: "codex",
    kind,
    origin: "interactive-native",
    sessionId: "session-1",
    state,
    revision: 3,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT + 1,
    expiresAt: CREATED_AT + 300_000,
    presentation: {
      title: "Choose a safe action",
      body: "Bounded presentation text",
      url: kind === "mcp-url" ? "https://example.invalid/elicitation" : undefined,
      questions: [{
        id: "question-1",
        prompt: "Which value?",
        required: true,
        multiple: false,
        secret: false,
        allowFreeText: true,
        options: [
          { id: "alpha", label: "Same label", providerValue: "first,value" },
          { id: "beta", label: "Same label", providerValue: "second,value" },
        ],
      }],
    },
  };
}

function answer(forRequest = request()): AgentInteractionAnswer {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: forRequest.id,
    sessionId: forRequest.sessionId,
    answers: [{ questionId: "question-1", optionIds: ["beta"] }],
  };
}

function resolution(forRequest = request()): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: forRequest.id,
    sessionId: forRequest.sessionId,
    action: "answer",
    answer: answer(forRequest),
    resolvedAt: CREATED_AT + 2,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("agent interaction request contract", () => {
  test("validates every supported provider, kind, and state", () => {
    for (const provider of AGENT_INTERACTION_PROVIDERS) {
      for (const kind of AGENT_INTERACTION_KINDS) {
        for (const state of AGENT_INTERACTION_STATES) {
          expect(isAgentInteractionRequest({
            ...request(kind, state),
            provider,
          })).toBe(true);
        }
      }
    }
  });

  test("keeps duplicate labels and comma-containing provider values valid", () => {
    expect(isAgentInteractionRequest(request())).toBe(true);
  });

  test("rejects unknown kinds, duplicate IDs, invalid deadlines, and extra fields", () => {
    expect(isAgentInteractionRequest({ ...request(), kind: "future-approval" })).toBe(false);

    const duplicateQuestions = clone(request());
    duplicateQuestions.presentation.questions.push(
      clone(duplicateQuestions.presentation.questions[0]!),
    );
    expect(isAgentInteractionRequest(duplicateQuestions)).toBe(false);

    const duplicateOptions = clone(request());
    duplicateOptions.presentation.questions[0]!.options[1]!.id = "alpha";
    expect(isAgentInteractionRequest(duplicateOptions)).toBe(false);

    expect(isAgentInteractionRequest({ ...request(), expiresAt: CREATED_AT })).toBe(false);
    expect(isAgentInteractionRequest({ ...request(), updatedAt: CREATED_AT - 1 })).toBe(false);
    expect(isAgentInteractionRequest({ ...request(), unexpected: true })).toBe(false);
  });

  test("enforces question, option, request-count, text, and serialized byte limits", () => {
    const tooManyQuestions = clone(request());
    tooManyQuestions.presentation.questions = Array.from(
      { length: AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest + 1 },
      (_, index) => ({
        id: `q-${index}`,
        prompt: "Prompt",
        required: false,
        multiple: false,
        secret: false,
        allowFreeText: true,
        options: [],
      }),
    );
    expect(isAgentInteractionRequest(tooManyQuestions)).toBe(false);

    const tooManyOptions = clone(request());
    tooManyOptions.presentation.questions[0]!.options = Array.from(
      { length: AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion + 1 },
      (_, index) => ({ id: `o-${index}`, label: "Option", providerValue: "value" }),
    );
    expect(isAgentInteractionRequest(tooManyOptions)).toBe(false);

    expect(isAgentInteractionRequest({
      ...request(),
      presentation: {
        ...request().presentation,
        title: "x".repeat(AGENT_INTERACTION_LIMITS.maxTextLength + 1),
      },
    })).toBe(false);

    const oversized = clone(request());
    oversized.presentation.questions = Array.from(
      { length: AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest },
      (_, index) => ({
        id: `question-${index}`,
        prompt: "x".repeat(AGENT_INTERACTION_LIMITS.maxTextLength),
        required: false,
        multiple: false,
        secret: false,
        allowFreeText: true,
        options: [],
      }),
    );
    expect(isAgentInteractionRequest(oversized)).toBe(false);

    const snapshot = {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      revision: 1,
      requests: Array.from(
        { length: AGENT_INTERACTION_LIMITS.maxPendingRequests + 1 },
        (_, index) => ({ ...request(), id: `interaction-${index}` }),
      ),
    };
    expect(isAgentInteractionSnapshot(snapshot)).toBe(false);
  });

  test("validates bounded snapshots and rejects duplicate request IDs", () => {
    expect(isAgentInteractionSnapshot({
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      revision: 4,
      requests: [request()],
    })).toBe(true);
    expect(isAgentInteractionSnapshot({
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      revision: 4,
      requests: [request(), request()],
    })).toBe(false);
  });
});

describe("answers and resolutions", () => {
  test("validates option identity independently from labels and provider values", () => {
    const value = request();
    expect(isAgentInteractionAnswer(answer(value), value)).toBe(true);
    expect(isAgentInteractionResolution(resolution(value), value)).toBe(true);
  });

  test("rejects cross-session answers, invalid option references, and missing required answers", () => {
    const value = request();
    expect(isAgentInteractionAnswer({
      ...answer(value),
      sessionId: "different-session",
    }, value)).toBe(false);
    expect(isAgentInteractionAnswer({
      ...answer(value),
      answers: [{ questionId: "question-1", optionIds: ["Same label"] }],
    }, value)).toBe(false);
    expect(isAgentInteractionAnswer({ ...answer(value), answers: [] }, value)).toBe(false);
    expect(isAgentInteractionAnswer({
      ...answer(value),
      answers: [
        { questionId: "question-1", optionIds: ["alpha"] },
        { questionId: "question-1", optionIds: ["beta"] },
      ],
    }, value)).toBe(false);
  });

  test("enforces free-text and answer count bounds", () => {
    const value = request();
    expect(isAgentInteractionAnswer({
      ...answer(value),
      answers: [{
        questionId: "question-1",
        freeText: "🙂".repeat(AGENT_INTERACTION_LIMITS.maxFreeTextBytes),
      }],
    }, value)).toBe(false);

    const manyQuestions = clone(value);
    manyQuestions.presentation.questions = Array.from(
      { length: AGENT_INTERACTION_LIMITS.maxAnswerCount },
      (_, index) => ({
        id: `q-${index}`,
        prompt: "Prompt",
        required: false,
        multiple: false,
        secret: false,
        allowFreeText: true,
        options: [],
      }),
    );
    const tooManyAnswers = Array.from(
      { length: AGENT_INTERACTION_LIMITS.maxAnswerCount + 1 },
      (_, index) => ({ questionId: `q-${index}`, freeText: "value" }),
    );
    expect(isAgentInteractionAnswer({
      ...answer(manyQuestions),
      answers: tooManyAnswers,
    }, manyQuestions)).toBe(false);
  });

  test("validates apply results exhaustively", () => {
    for (const result of [
      "applied",
      "stale",
      "already-resolved",
      "rejected",
      "provider-unavailable",
    ]) {
      expect(isAgentInteractionApplyOutcome({
        result,
        interactionId: "interaction-1",
        sessionId: "session-1",
        revision: 1,
      })).toBe(true);
    }
    expect(isAgentInteractionApplyOutcome({
      result: "retried",
      interactionId: "interaction-1",
      sessionId: "session-1",
      revision: 1,
    })).toBe(false);
  });
});

describe("interaction policy", () => {
  test("pins interactive and unattended semantics and fails unknown kinds closed", () => {
    expect(isAgentInteractionPolicy(INTERACTIVE_AGENT_INTERACTION_POLICY)).toBe(true);
    expect(isAgentInteractionPolicy(UNATTENDED_AGENT_INTERACTION_POLICY)).toBe(true);
    expect(agentInteractionPolicyAction(
      UNATTENDED_AGENT_INTERACTION_POLICY,
      "question",
    )).toBe("decline-and-continue");
    expect(agentInteractionPolicyAction(
      UNATTENDED_AGENT_INTERACTION_POLICY,
      "permission",
    )).toBe("deny-and-fail");
    expect(agentInteractionPolicyAction(
      UNATTENDED_AGENT_INTERACTION_POLICY,
      "future-kind",
    )).toBe("deny-and-fail");
  });

  test("rejects policy combinations that weaken the selected mode", () => {
    expect(isAgentInteractionPolicy({
      ...UNATTENDED_AGENT_INTERACTION_POLICY,
      authorization: "await-user",
    })).toBe(false);
    expect(isAgentInteractionPolicy({
      ...INTERACTIVE_AGENT_INTERACTION_POLICY,
      unknown: "await-user",
    })).toBe(false);
  });
});

describe("resolution journal and summaries", () => {
  const journal: AgentInteractionResolutionJournal = {
    version: AGENT_INTERACTION_JOURNAL_VERSION,
    entries: [{
      id: "journal-1",
      interactionId: "interaction-1",
      provider: "claude",
      kind: "permission",
      sessionId: "session-1",
      state: "workflow-recorded",
      claim: {
        workflowType: "build-pipeline",
        workflowId: "pipeline-1",
        phase: "building",
        fence: 7,
        claimedAt: CREATED_AT,
      },
      outcome: "denied",
      providerResolvedAt: CREATED_AT + 1,
      workflowRecordedAt: CREATED_AT + 2,
    }],
  };

  const summary: AgentInteractionWorkflowSummary = {
    version: AGENT_INTERACTION_SUMMARY_VERSION,
    entries: [{
      provider: "claude",
      kind: "permission",
      phase: "building",
      sessionId: "session-1",
      firstSeenAt: CREATED_AT,
      lastResolvedAt: CREATED_AT + 2,
      outcome: "denied",
      count: 1,
    }],
  };

  test("round-trips bounded versioned journals and summaries", () => {
    expect(isAgentInteractionResolutionJournal(
      JSON.parse(JSON.stringify(journal)),
    )).toBe(true);
    expect(isAgentInteractionWorkflowSummary(
      JSON.parse(serializeAgentInteractionWorkflowSummary(summary)),
    )).toBe(true);
  });

  test("requires ordered exact-once journal states and unique interaction claims", () => {
    expect(isAgentInteractionResolutionJournal({
      ...journal,
      entries: [{ ...journal.entries[0]!, workflowRecordedAt: undefined }],
    })).toBe(false);
    expect(isAgentInteractionResolutionJournal({
      ...journal,
      entries: [journal.entries[0], { ...journal.entries[0]!, id: "journal-2" }],
    })).toBe(false);
  });

  test("cleanup preserves unfinished claims and removes expired terminal records", () => {
    const unfinished = {
      ...journal.entries[0]!,
      id: "journal-pending",
      interactionId: "interaction-pending",
      state: "claimed" as const,
      outcome: undefined,
      providerResolvedAt: undefined,
      workflowRecordedAt: undefined,
    };
    const cleaned = pruneAgentInteractionResolutionJournal({
      version: AGENT_INTERACTION_JOURNAL_VERSION,
      entries: [journal.entries[0]!, unfinished],
    }, CREATED_AT + AGENT_INTERACTION_JOURNAL_RETENTION_MS + 3);
    expect(cleaned.entries).toEqual([unfinished]);
  });
});

describe("privacy-safe serializers", () => {
  test("rejects secret values from app-owned drafts", () => {
    const secret = request();
    secret.presentation.questions[0]!.secret = true;
    const secretAnswer = {
      ...answer(secret),
      answers: [{ questionId: "question-1", freeText: "top-secret-value" }],
    };
    expect(isAgentInteractionAnswer(secretAnswer, secret)).toBe(true);
    expect(() => serializeAgentInteractionDraft(secret, secretAnswer)).toThrow(
      "Secret interaction answers cannot be persisted",
    );
  });

  test("omits request, answer, URL, and provider-value content from durable events and telemetry", () => {
    const secret = request("mcp-url");
    secret.presentation.body = "private prompt content";
    secret.presentation.questions[0]!.secret = true;
    const secretAnswer: AgentInteractionAnswer = {
      ...answer(secret),
      answers: [{ questionId: "question-1", freeText: "top-secret-value" }],
    };
    const resolved: AgentInteractionResolution = {
      ...resolution(secret),
      answer: secretAnswer,
    };
    const serialized = [
      serializeAgentInteractionTranscriptEvent(secret, resolved),
      serializeAgentInteractionTelemetry(secret, "answered"),
      serializeAgentInteractionWorkflowSummary({
        version: AGENT_INTERACTION_SUMMARY_VERSION,
        entries: [{
          provider: secret.provider,
          kind: secret.kind,
          phase: "reviewing",
          sessionId: secret.sessionId,
          firstSeenAt: secret.createdAt,
          outcome: "answered",
          count: 1,
        }],
      }),
    ].join("\n");
    expect(serialized).not.toContain("top-secret-value");
    expect(serialized).not.toContain("private prompt content");
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("first,value");
  });
});
