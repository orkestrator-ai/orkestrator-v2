import { expect, mock, test } from "bun:test";
import {
  MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { NativeAgentProviderSessionMissingError } from "./native-agent-service.js";
import {
  InvalidMultiReviewAddressStateError,
  MissingMultiReviewAddressSessionError,
  dispatchMultiReviewAddressPrompt,
} from "./multi-review-address-dispatch.js";

const workflow = {
  id: "multi-1",
  environmentId: "env-1",
  fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
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
    phase: "fix",
    sessionMode: "build",
  });
  expect(dispatchIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      logicalSessionKey: "multi-review:multi-1:interactive",
      prompt:
        "Please address all the issues and coverage gaps. Do not go into plan mode. Please implement the fixes.",
      requestId: "multi-review-address:multi-1",
      mode: "build",
    }),
  );
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
    customFixModel: { agent: "codex" as const, model: "gpt-5.4", reasoningEffort: "high" },
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
  );

  expect(adoptSession).not.toHaveBeenCalled();
  expect(ensureSession).toHaveBeenCalledWith(
    expect.objectContaining({
      logicalSessionKey: "multi-review:multi-1:interactive:launch-1",
      model: "gpt-5.4",
      sessionMode: "build",
    }),
  );
  expect(ensureNativeAgentJobTab).toHaveBeenCalledTimes(1);
  expect(ensureNativeAgentJobTab).toHaveBeenLastCalledWith(
    expect.objectContaining({
      tabId: "multi-review-fix:multi-1:launch-1",
      providerSessionId: "provider-custom",
      activate: false,
      isReviewTab: true,
    }),
  );
  expect(dispatchIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: "multi-review-address:multi-1:launch-1",
      prompt: expect.stringContaining("Fix the reported regression"),
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
