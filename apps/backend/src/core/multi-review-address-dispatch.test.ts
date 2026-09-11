import { expect, mock, test } from "bun:test";
import {
  MULTI_REVIEW_ADDRESS_PROMPT,
  MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION,
  MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION,
  MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
  multiReviewCustomFixPrompt,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { wrapSystemInstructions } from "@orkestrator/protocol/review-evidence-frames";
import { addressPrompt } from "./build-pipeline-prompts.js";
import { NativeAgentProviderSessionMissingError } from "./native-agent-service.js";
import {
  InvalidMultiReviewAddressStateError,
  MissingMultiReviewAddressSessionError,
  dispatchMultiReviewAddressPrompt,
  recoverMissingMultiReviewFixSession,
} from "./multi-review-address-dispatch.js";

const workflow = {
  id: "multi-1",
  environmentId: "env-1",
  fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high", fastMode: false },
  fixSession: { providerSessionId: "provider-fix" },
} as MultiReviewWorkflow;

test("dispatchMultiReviewAddressPrompt adopts and dispatches the stable production request", async () => {
  const adoptSession = mock(async () => undefined as never);
  const ensureSession = mock(async () => undefined as never);
  const dispatchIntent = mock(async () => ({
    outcome: "accepted" as const,
    requestId: "multi-review-address:multi-1",
  }));

  await dispatchMultiReviewAddressPrompt({ adoptSession, ensureSession, dispatchIntent }, workflow);

  expect(adoptSession).toHaveBeenCalledWith({
    environmentId: "env-1",
    agent: "codex",
    logicalSessionKey: "multi-review:multi-1:interactive",
    origin: "interactive-native",
    interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
    providerSessionId: "provider-fix",
    title: MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
    model: "gpt-5.6",
    reasoningEffort: "high",
    fastMode: false,
    phase: "fix",
    sessionMode: "build",
  });
  expect(dispatchIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      logicalSessionKey: "multi-review:multi-1:interactive",
      prompt: MULTI_REVIEW_ADDRESS_PROMPT,
      requestId: "multi-review-address:multi-1",
      mode: "build",
    }),
  );
  expect(ensureSession).not.toHaveBeenCalled();
});

test("dispatchMultiReviewAddressPrompt creates a fix session separate from review coordination", async () => {
  const adoptSession = mock(async () => undefined as never);
  const ensureSession = mock(async () => ({ providerSessionId: "provider-fix-new" }) as never);
  const dispatchIntent = mock(async () => ({
    outcome: "accepted" as const,
    requestId: "multi-review-address:multi-1",
  }));
  const separate = {
    ...workflow,
    reviewModel: { agent: "claude", model: "review-coordinator" },
    reviewSession: {
      agent: "claude",
      model: "review-coordinator",
      sessionKey: "multi-review:multi-1:review",
      providerSessionId: "provider-review",
      requestIds: ["prepare-1", "consolidate-1"],
      status: "idle",
      startedAt: new Date(0).toISOString(),
    },
    consolidatedReport: {
      issues: [{ title: "Separate-session finding" }],
      testCoverageGaps: [{ untestedBehavior: "Separate-session coverage" }],
    } as MultiReviewWorkflow["consolidatedReport"],
    fixSession: undefined,
  } as MultiReviewWorkflow;

  const dispatched = await dispatchMultiReviewAddressPrompt(
    { adoptSession, ensureSession, dispatchIntent },
    separate,
  );

  expect(adoptSession).not.toHaveBeenCalled();
  expect(ensureSession).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: "codex",
      model: "gpt-5.6",
      fastMode: false,
      logicalSessionKey: "multi-review:multi-1:interactive",
      sessionMode: "build",
    }),
  );
  expect(dispatched.fixSession).toMatchObject({
    providerSessionId: "provider-fix-new",
    model: "gpt-5.6",
  });
  expect(dispatchIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: expect.stringContaining("Separate-session finding"),
    }),
  );
  expect(separate.reviewSession?.providerSessionId).toBe("provider-review");
});

test("dispatchMultiReviewAddressPrompt rejects a separate fix session without a report", async () => {
  const ensureSession = mock(async () => ({ providerSessionId: "unexpected" }) as never);
  await expect(
    dispatchMultiReviewAddressPrompt(
      {
        adoptSession: mock(async () => undefined as never),
        ensureSession,
        dispatchIntent: mock(async () => ({
          outcome: "accepted" as const,
          requestId: "unexpected",
        })),
      },
      {
        ...workflow,
        reviewModel: { agent: "claude", model: "review-coordinator" },
        fixSession: undefined,
      },
    ),
  ).rejects.toBeInstanceOf(InvalidMultiReviewAddressStateError);
  expect(ensureSession).not.toHaveBeenCalled();
});

test("dispatchMultiReviewAddressPrompt classifies authoritative session loss", async () => {
  const adoptSession = mock(async () => {
    throw new NativeAgentProviderSessionMissingError();
  });
  const ensureSession = mock(async () => undefined as never);
  const dispatchIntent = mock(async () => ({
    outcome: "accepted" as const,
    requestId: "multi-review-address:multi-1",
  }));

  await expect(
    dispatchMultiReviewAddressPrompt({ adoptSession, ensureSession, dispatchIntent }, workflow),
  ).rejects.toBeInstanceOf(MissingMultiReviewAddressSessionError);
  expect(dispatchIntent).not.toHaveBeenCalled();
});

test("dispatchMultiReviewAddressPrompt leaves ambiguous delivery retryable", async () => {
  const adoptSession = mock(async () => undefined as never);
  const ensureSession = mock(async () => undefined as never);
  const dispatchIntent = mock(async () => ({
    outcome: "unknown" as const,
    requestId: "multi-review-address:multi-1",
    error: "delivery is ambiguous",
  }));

  await expect(
    dispatchMultiReviewAddressPrompt({ adoptSession, ensureSession, dispatchIntent }, workflow),
  ).rejects.toThrow("delivery is ambiguous");
});

test("dispatchMultiReviewAddressPrompt creates, publishes and dispatches a custom fix without a renderer", async () => {
  const events: string[] = [];
  const adoptSession = mock(async () => undefined as never);
  const ensureSession = mock(async () => ({ providerSessionId: "provider-custom" }) as never);
  const dispatchIntent = mock(async () => {
    events.push("dispatch");
    return {
      outcome: "accepted" as const,
      requestId: "multi-review-address:multi-1",
    };
  });
  const ensureNativeAgentJobTab = mock(async () => {
    events.push("publish");
  });
  const custom = {
    ...workflow,
    customFixModel: {
      agent: "codex" as const,
      model: "gpt-5.4",
      reasoningEffort: "high",
      fastMode: true,
    },
    customFixInstruction: "Fix the reported regression",
    addressSessionKey: "multi-review:multi-1:interactive:launch-1",
    addressRequestId: "multi-review-address:multi-1:launch-1",
    addressTabId: "multi-review-fix:multi-1:launch-1",
    consolidatedReport: {
      issues: [{ title: "Shared finding" }],
      testCoverageGaps: [{ untestedBehavior: "The failure branch" }],
    },
  } as MultiReviewWorkflow;

  const session = await dispatchMultiReviewAddressPrompt(
    { adoptSession, ensureSession, dispatchIntent },
    custom,
    { ensureNativeAgentJobTab },
    true,
  );

  expect(adoptSession).not.toHaveBeenCalled();
  expect(ensureSession).toHaveBeenCalledWith(
    expect.objectContaining({
      logicalSessionKey: "multi-review:multi-1:interactive:launch-1",
      model: "gpt-5.4",
      fastMode: true,
      sessionMode: "build",
    }),
  );
  expect(ensureNativeAgentJobTab).toHaveBeenCalledTimes(1);
  expect(ensureNativeAgentJobTab).toHaveBeenLastCalledWith(
    expect.objectContaining({
      tabId: "multi-review-fix:multi-1:launch-1",
      providerSessionId: "provider-custom",
      activate: true,
      isReviewTab: true,
    }),
  );
  expect(dispatchIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: "multi-review-address:multi-1:launch-1",
      prompt: multiReviewCustomFixPrompt(custom.consolidatedReport!, custom.customFixInstruction!),
    }),
  );
  expect(dispatchIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: expect.stringContaining(MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION),
    }),
  );
  expect(events).toEqual(["dispatch", "publish"]);
  expect(session).toMatchObject({
    tabId: "multi-review-fix:multi-1:launch-1",
    fixSession: {
      providerSessionId: "provider-custom",
      sessionKey: "multi-review:multi-1:interactive:launch-1",
      status: "idle",
    },
  });
});

test("dispatchMultiReviewAddressPrompt preserves focus without foreground activation consent", async () => {
  const ensureNativeAgentJobTab = mock(async () => undefined);
  await dispatchMultiReviewAddressPrompt(
    {
      adoptSession: mock(async () => undefined as never),
      ensureSession: mock(async () => undefined as never),
      dispatchIntent: mock(async () => ({
        outcome: "accepted" as const,
        requestId: "multi-review-address:multi-1",
      })),
    },
    workflow,
    { ensureNativeAgentJobTab },
  );
  expect(ensureNativeAgentJobTab).toHaveBeenCalledWith(
    expect.objectContaining({ activate: false }),
  );
});

test("dispatchMultiReviewAddressPrompt does not let tab presentation block execution", async () => {
  const adoptSession = mock(async () => undefined as never);
  const ensureSession = mock(async () => undefined as never);
  const dispatchIntent = mock(async () => ({
    outcome: "accepted" as const,
    requestId: "multi-review-address:multi-1",
  }));
  const ensureNativeAgentJobTab = mock(async () => {
    throw new Error("environment is at its tab limit");
  });

  await expect(
    dispatchMultiReviewAddressPrompt({ adoptSession, ensureSession, dispatchIntent }, workflow, {
      ensureNativeAgentJobTab,
    }),
  ).resolves.toMatchObject({
    fixSession: { providerSessionId: "provider-fix" },
    presentationError: expect.stringContaining("tab could not be opened"),
  });
  expect(dispatchIntent).toHaveBeenCalledTimes(1);
});

test("dispatchMultiReviewAddressPrompt does not publish while prompt delivery is pending", async () => {
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const ensureNativeAgentJobTab = mock(async () => undefined);
  const dispatch = dispatchMultiReviewAddressPrompt(
    {
      adoptSession: mock(async () => undefined as never),
      ensureSession: mock(async () => undefined as never),
      dispatchIntent: mock(async () => {
        await accepted;
        return { outcome: "accepted" as const, requestId: "multi-review-address:multi-1" };
      }),
    },
    workflow,
    { ensureNativeAgentJobTab },
  );

  await Promise.resolve();
  expect(ensureNativeAgentJobTab).not.toHaveBeenCalled();
  accept();
  await dispatch;
  expect(ensureNativeAgentJobTab).toHaveBeenCalledTimes(1);
});

test("dispatchMultiReviewAddressPrompt rejects a corrupt custom fix before provider I/O", async () => {
  const ensureSession = mock(async () => ({ providerSessionId: "unexpected" }) as never);
  await expect(
    dispatchMultiReviewAddressPrompt(
      {
        adoptSession: mock(async () => undefined as never),
        ensureSession,
        dispatchIntent: mock(async () => ({
          outcome: "accepted" as const,
          requestId: "unexpected",
        })),
      },
      {
        ...workflow,
        customFixInstruction: "Fix it",
        customFixModel: workflow.fixModel,
      },
    ),
  ).rejects.toBeInstanceOf(InvalidMultiReviewAddressStateError);
  expect(ensureSession).not.toHaveBeenCalled();
});

test("recoverMissingMultiReviewFixSession adopts and seeds the replacement before returning it", async () => {
  const adoptSession = mock(async () => undefined as never);
  const ensureSession = mock(async () => undefined as never);
  const dispatchIntent = mock(async (input: { prompt: string; requestId: string }) => ({
    outcome: "accepted" as const,
    requestId: input.requestId,
  }));
  const recoverable = {
    ...workflow,
    phase: "interactive",
    fixTabId: "multi-review-fix:multi-1:launch-1",
    addressSessionKey: "multi-review:multi-1:interactive:launch-1",
    consolidatedReport: {
      issues: [{ title: "Lost-session regression" }],
      testCoverageGaps: [{ untestedBehavior: "Replacement recovery" }],
    },
    fixSession: {
      agent: "codex",
      model: "gpt-5.6",
      reasoningEffort: "high",
      fastMode: false,
      sessionKey: "multi-review:multi-1:interactive:launch-1",
      providerSessionId: "provider-fix",
      requestIds: ["multi-review-address:multi-1"],
      status: "idle",
      startedAt: "2026-09-07T00:00:00.000Z",
    },
  } as MultiReviewWorkflow;

  const result = await recoverMissingMultiReviewFixSession(
    { adoptSession, ensureSession, dispatchIntent },
    recoverable,
    {
      tabId: "multi-review-fix:multi-1:launch-1",
      expectedProviderSessionId: "provider-fix",
      replacementProviderSessionId: "provider-replacement",
    },
  );

  expect(adoptSession).toHaveBeenCalledWith(
    expect.objectContaining({
      logicalSessionKey: "multi-review:multi-1:interactive:launch-1",
      providerSessionId: "provider-replacement",
      expectedProviderSessionId: "provider-fix",
      fastMode: false,
      sessionMode: "build",
    }),
  );
  expect(dispatchIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      logicalSessionKey: "multi-review:multi-1:interactive:launch-1",
      prompt: `${addressPrompt(recoverable.consolidatedReport!)}\n\n${wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION)}`,
      mode: "build",
    }),
  );
  expect(dispatchIntent.mock.calls[0]?.[0].prompt).toContain(
    wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION),
  );
  expect(ensureSession).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    tabId: "multi-review-fix:multi-1:launch-1",
    fixSession: {
      providerSessionId: "provider-replacement",
      sessionKey: "multi-review:multi-1:interactive:launch-1",
      status: "idle",
    },
  });
  expect(result.fixSession.requestIds).toHaveLength(2);
});
