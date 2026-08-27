import { expect, mock, test } from "bun:test";
import {
  MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { NativeAgentProviderSessionMissingError } from "./native-agent-service.js";
import {
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
  const dispatchIntent = mock(async () => ({
    outcome: "accepted" as const,
    requestId: "multi-review-address:multi-1",
  }));

  await dispatchMultiReviewAddressPrompt({ adoptSession, dispatchIntent }, workflow);

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
});

test("dispatchMultiReviewAddressPrompt classifies authoritative session loss", async () => {
  const adoptSession = mock(async () => {
    throw new NativeAgentProviderSessionMissingError();
  });
  const dispatchIntent = mock(async () => ({
    outcome: "accepted" as const,
    requestId: "multi-review-address:multi-1",
  }));

  await expect(
    dispatchMultiReviewAddressPrompt({ adoptSession, dispatchIntent }, workflow),
  ).rejects.toBeInstanceOf(MissingMultiReviewAddressSessionError);
  expect(dispatchIntent).not.toHaveBeenCalled();
});

test("dispatchMultiReviewAddressPrompt leaves ambiguous delivery retryable", async () => {
  const adoptSession = mock(async () => undefined as never);
  const dispatchIntent = mock(async () => ({
    outcome: "unknown" as const,
    requestId: "multi-review-address:multi-1",
    error: "delivery is ambiguous",
  }));

  await expect(
    dispatchMultiReviewAddressPrompt({ adoptSession, dispatchIntent }, workflow),
  ).rejects.toThrow("delivery is ambiguous");
});
