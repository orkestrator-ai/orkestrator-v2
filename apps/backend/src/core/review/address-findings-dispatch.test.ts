import { expect, mock, test } from "bun:test";
import {
  MULTI_REVIEW_ADDRESS_USER_INSTRUCTION,
  MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION,
  MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION,
  MULTI_REVIEW_LEGACY_FIX_TAB_TITLE,
  multiReviewAddressFindingsPrompt,
  multiReviewCustomAddressFindingsPrompt,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { wrapSystemInstructions } from "@orkestrator/protocol/review-evidence-frames";
import { addressFindingsReportPrompt } from "../build-pipeline/prompts.js";
import { NativeAgentProviderSessionMissingError } from "../native-agent/service.js";
import {
  InvalidMultiReviewAddressFindingsStateError,
  MissingMultiReviewAddressFindingsSessionError,
  dispatchMultiReviewAddressFindingsPrompt,
  recoverMissingMultiReviewAddressFindingsSession,
} from "./address-findings-dispatch.js";

const workflow = {
  id: "multi-1",
  environmentId: "env-1",
  addressFindingsModel: {
    agent: "codex",
    model: "gpt-5.6",
    reasoningEffort: "high",
    fastMode: false,
  },
  addressFindingsSession: { providerSessionId: "provider-fix" },
} as MultiReviewWorkflow;

test("dispatchMultiReviewAddressFindingsPrompt adopts and dispatches the stable production request", async () => {
  const adoptSession = mock(async () => undefined as never);
  const ensureSession = mock(async () => undefined as never);
  const dispatchIntent = mock(async () => ({
    outcome: "accepted" as const,
    requestId: "multi-review-address:multi-1",
  }));

  await dispatchMultiReviewAddressFindingsPrompt(
    { adoptSession, ensureSession, dispatchIntent },
    workflow,
  );

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
    phase: "address-findings",
    sessionMode: "build",
  });
  expect(dispatchIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      logicalSessionKey: "multi-review:multi-1:interactive",
      prompt: multiReviewAddressFindingsPrompt(""),
      requestId: "multi-review-address:multi-1",
      mode: "build",
    }),
  );
  expect(ensureSession).not.toHaveBeenCalled();
});

test("dispatchMultiReviewAddressFindingsPrompt creates an Address Findings session separate from review coordination", async () => {
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
    addressFindingsSession: undefined,
  } as MultiReviewWorkflow;

  const dispatched = await dispatchMultiReviewAddressFindingsPrompt(
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
  expect(dispatched.addressFindingsSession).toMatchObject({
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

test("dispatchMultiReviewAddressFindingsPrompt rejects a separate Address Findings session without a report", async () => {
  const ensureSession = mock(async () => ({ providerSessionId: "unexpected" }) as never);
  await expect(
    dispatchMultiReviewAddressFindingsPrompt(
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
        addressFindingsSession: undefined,
      },
    ),
  ).rejects.toBeInstanceOf(InvalidMultiReviewAddressFindingsStateError);
  expect(ensureSession).not.toHaveBeenCalled();
});

test("dispatchMultiReviewAddressFindingsPrompt classifies authoritative session loss", async () => {
  const adoptSession = mock(async () => {
    throw new NativeAgentProviderSessionMissingError();
  });
  const ensureSession = mock(async () => undefined as never);
  const dispatchIntent = mock(async () => ({
    outcome: "accepted" as const,
    requestId: "multi-review-address:multi-1",
  }));

  await expect(
    dispatchMultiReviewAddressFindingsPrompt(
      { adoptSession, ensureSession, dispatchIntent },
      workflow,
    ),
  ).rejects.toBeInstanceOf(MissingMultiReviewAddressFindingsSessionError);
  expect(dispatchIntent).not.toHaveBeenCalled();
});

test("dispatchMultiReviewAddressFindingsPrompt leaves ambiguous delivery retryable", async () => {
  const adoptSession = mock(async () => undefined as never);
  const ensureSession = mock(async () => undefined as never);
  const dispatchIntent = mock(async () => ({
    outcome: "unknown" as const,
    requestId: "multi-review-address:multi-1",
    error: "delivery is ambiguous",
  }));

  await expect(
    dispatchMultiReviewAddressFindingsPrompt(
      { adoptSession, ensureSession, dispatchIntent },
      workflow,
    ),
  ).rejects.toThrow("delivery is ambiguous");
});

test("dispatchMultiReviewAddressFindingsPrompt creates, publishes and dispatches a custom Address Findings without a renderer", async () => {
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
    customAddressFindingsModel: {
      agent: "codex" as const,
      model: "gpt-5.4",
      reasoningEffort: "high",
      fastMode: true,
    },
    customAddressFindingsInstruction: "Fix the reported regression",
    addressSessionKey: "multi-review:multi-1:interactive:launch-1",
    addressRequestId: "multi-review-address:multi-1:launch-1",
    addressTabId: "multi-review-fix:multi-1:launch-1",
    consolidatedReport: {
      issues: [{ title: "Shared finding" }],
      testCoverageGaps: [{ untestedBehavior: "The failure branch" }],
    },
  } as MultiReviewWorkflow;

  const session = await dispatchMultiReviewAddressFindingsPrompt(
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
      prompt: multiReviewCustomAddressFindingsPrompt(
        custom.consolidatedReport!,
        custom.customAddressFindingsInstruction!,
        "",
      ),
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
    addressFindingsSession: {
      providerSessionId: "provider-custom",
      sessionKey: "multi-review:multi-1:interactive:launch-1",
      status: "idle",
    },
  });
});

test("dispatchMultiReviewAddressFindingsPrompt preserves focus without foreground activation consent", async () => {
  const ensureNativeAgentJobTab = mock(async () => undefined);
  await dispatchMultiReviewAddressFindingsPrompt(
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

test("dispatchMultiReviewAddressFindingsPrompt does not let tab presentation block execution", async () => {
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
    dispatchMultiReviewAddressFindingsPrompt(
      { adoptSession, ensureSession, dispatchIntent },
      workflow,
      {
        ensureNativeAgentJobTab,
      },
    ),
  ).resolves.toMatchObject({
    addressFindingsSession: { providerSessionId: "provider-fix" },
    presentationError: expect.stringContaining("tab could not be opened"),
  });
  expect(dispatchIntent).toHaveBeenCalledTimes(1);
});

test("dispatchMultiReviewAddressFindingsPrompt does not publish while prompt delivery is pending", async () => {
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const ensureNativeAgentJobTab = mock(async () => undefined);
  const dispatch = dispatchMultiReviewAddressFindingsPrompt(
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

test("dispatchMultiReviewAddressFindingsPrompt rejects a corrupt custom Address Findings before provider I/O", async () => {
  const ensureSession = mock(async () => ({ providerSessionId: "unexpected" }) as never);
  await expect(
    dispatchMultiReviewAddressFindingsPrompt(
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
        customAddressFindingsInstruction: "Fix it",
        customAddressFindingsModel: workflow.addressFindingsModel,
      },
    ),
  ).rejects.toBeInstanceOf(InvalidMultiReviewAddressFindingsStateError);
  expect(ensureSession).not.toHaveBeenCalled();
});

test("recoverMissingMultiReviewAddressFindingsSession adopts and seeds the replacement before returning it", async () => {
  const adoptSession = mock(async () => undefined as never);
  const ensureSession = mock(async () => undefined as never);
  const dispatchIntent = mock(async (input: { prompt: string; requestId: string }) => ({
    outcome: "accepted" as const,
    requestId: input.requestId,
  }));
  const recoverable = {
    ...workflow,
    phase: "interactive",
    addressFindingsTabId: "multi-review-fix:multi-1:launch-1",
    addressSessionKey: "multi-review:multi-1:interactive:launch-1",
    consolidatedReport: {
      issues: [{ title: "Lost-session regression" }],
      testCoverageGaps: [{ untestedBehavior: "Replacement recovery" }],
    },
    addressFindingsSession: {
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

  const result = await recoverMissingMultiReviewAddressFindingsSession(
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
      prompt: `${addressFindingsReportPrompt(recoverable.consolidatedReport!)}\n\n${wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION)}`,
      mode: "build",
    }),
  );
  expect(dispatchIntent.mock.calls[0]?.[0].prompt).toContain(
    wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION),
  );
  expect(ensureSession).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    tabId: "multi-review-fix:multi-1:launch-1",
    addressFindingsSession: {
      providerSessionId: "provider-replacement",
      sessionKey: "multi-review:multi-1:interactive:launch-1",
      status: "idle",
    },
  });
  expect(result.addressFindingsSession.requestIds).toHaveLength(2);
});

const RERUN_RULE =
  "do not redundantly rerun passing full-suite, typecheck, lint, or build commands";
const BRANCH_REPAIR_RULE =
  "Fix every recorded failure that relates to this branch's changes, then rerun only that check.";

const packagedReport = {
  issues: [{ title: "Packaged finding" }],
  testCoverageGaps: [{ untestedBehavior: "Packaged coverage" }],
} as MultiReviewWorkflow["consolidatedReport"];

const packagedWorkflow = {
  ...workflow,
  phase: "interactive",
  targetBranch: "develop",
  consolidatedReport: packagedReport,
  reviewPackage: {
    kind: "file",
    id: "review-package-1",
    round: 1,
    preparedAt: "2026-11-23T00:00:00.000Z",
    targetBranch: "develop",
    baseRef: "1".repeat(40),
    headRef: "2".repeat(40),
    filePath: ".orkestrator/review-packages/review-package-1.json",
    sha256: "a".repeat(64),
    bytes: 1024,
    changedFileCount: 1,
    limitations: [],
  },
} as MultiReviewWorkflow;

function acceptingAgents(providerSessionId = "provider-fix") {
  return {
    adoptSession: mock(async () => undefined as never),
    ensureSession: mock(async () => ({ providerSessionId }) as never),
    dispatchIntent: mock(async (input: { prompt: string; requestId: string }) => ({
      outcome: "accepted" as const,
      requestId: input.requestId,
    })),
  };
}

function expectBranchValidationInstruction(prompt: string): void {
  // The round's recorded evidence, read from the sealed package.
  expect(prompt).toContain("**Recorded validation**");
  expect(prompt).toContain(`\`${"2".repeat(40)}\``);
  expect(prompt).toContain(".orkestrator/review-packages/review-package-1.json");
  expect(prompt).toContain("**Validation report**");
  expect(prompt).toContain("**Failure triage**");
  // The pipeline's repair and excuse rules, judged against the branch.
  expect(prompt).toContain(BRANCH_REPAIR_RULE);
  expect(prompt).toContain(
    "Only failures unrelated to this branch's changes may be excused as pre-existing, flaky or environmental, and only with evidence",
  );
  expect(prompt).toContain("Do not change unrelated code or tests to hide a failure.");
  expect(prompt).toContain("git diff origin/develop...HEAD");
  expect(prompt).toContain("rerun that exact command");
  expect(prompt.split(RERUN_RULE)).toHaveLength(2);
  expect(prompt).toContain(
    "name each recorded failure you left as pre-existing, flaky, unrelated or environmental with its failure triage or validation report evidence",
  );
  // Multi Review has no ticket, no verifier and no submitted result.
  expect(prompt).not.toContain("acceptance criteria");
  expect(prompt).not.toContain("for the verifier");
  expect(prompt).not.toContain("Address Findings result you submit");
  expect(prompt).not.toContain("Keep the validated commit");
}

test("dispatchMultiReviewAddressFindingsPrompt gives the reused consolidation session the recorded validation", async () => {
  const agents = acceptingAgents();
  await dispatchMultiReviewAddressFindingsPrompt(agents, packagedWorkflow);
  const sent = agents.dispatchIntent.mock.calls[0]![0];
  expect(sent.requestId).toBe("multi-review-address:multi-1");
  expectBranchValidationInstruction(sent.prompt);
  expect(sent.prompt.startsWith(MULTI_REVIEW_ADDRESS_USER_INSTRUCTION)).toBe(true);
  expect(sent.prompt).toContain(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION);
});

test("dispatchMultiReviewAddressFindingsPrompt gives a fresh Address Findings session the recorded validation", async () => {
  const agents = acceptingAgents("provider-fix-new");
  await dispatchMultiReviewAddressFindingsPrompt(agents, {
    ...packagedWorkflow,
    reviewModel: { agent: "claude", model: "review-coordinator" },
    addressFindingsSession: undefined,
  } as MultiReviewWorkflow);
  const sent = agents.dispatchIntent.mock.calls[0]![0];
  expect(sent.requestId).toBe("multi-review-address:multi-1");
  expectBranchValidationInstruction(sent.prompt);
  expect(sent.prompt).toContain("Packaged finding");
});

test("dispatchMultiReviewAddressFindingsPrompt gives a custom Address Findings the recorded validation", async () => {
  const agents = acceptingAgents("provider-custom");
  await dispatchMultiReviewAddressFindingsPrompt(agents, {
    ...packagedWorkflow,
    customAddressFindingsModel: packagedWorkflow.addressFindingsModel,
    customAddressFindingsInstruction: "Only fix the regression",
    addressRequestId: "multi-review-address:multi-1:launch-2",
  } as MultiReviewWorkflow);
  const sent = agents.dispatchIntent.mock.calls[0]![0];
  expect(sent.requestId).toBe("multi-review-address:multi-1:launch-2");
  expectBranchValidationInstruction(sent.prompt);
  expect(sent.prompt).toContain("Only fix the regression");
});

test("recoverMissingMultiReviewAddressFindingsSession seeds the replacement with the recorded validation", async () => {
  const agents = acceptingAgents();
  await recoverMissingMultiReviewAddressFindingsSession(
    agents,
    {
      ...packagedWorkflow,
      addressFindingsSession: {
        ...packagedWorkflow.addressFindingsModel,
        sessionKey: "multi-review:multi-1:interactive",
        providerSessionId: "provider-fix",
        requestIds: ["multi-review-address:multi-1"],
        status: "idle",
        startedAt: "2026-11-23T00:00:00.000Z",
      },
    } as MultiReviewWorkflow,
    {
      tabId: "multi-review-fix:multi-1",
      expectedProviderSessionId: "provider-fix",
      replacementProviderSessionId: "provider-replacement",
    },
  );
  const sent = agents.dispatchIntent.mock.calls[0]![0];
  expect(sent.requestId).toMatch(/^multi-review-address-replacement:multi-1:/);
  expectBranchValidationInstruction(sent.prompt);
  expect(sent.prompt).toContain("Packaged finding");
});

test("dispatchMultiReviewAddressFindingsPrompt still dispatches a review persisted with an inline legacy package", async () => {
  const agents = acceptingAgents();
  await dispatchMultiReviewAddressFindingsPrompt(agents, {
    ...packagedWorkflow,
    reviewPackage: {
      id: "legacy-package",
      round: 1,
      preparedAt: "2026-01-01T00:00:00.000Z",
      targetBranch: "develop",
      baseRef: "1".repeat(40),
      headRef: "3".repeat(40),
      commit: null,
      completeDiff: "",
      changedFiles: [],
      validation: [
        { command: "bun test", status: "failed", exitCode: 1, stdout: "1 fail", stderr: "" },
      ],
      skippedFiles: [],
      uncommittedFiles: [],
      limitations: [],
    },
  } as unknown as MultiReviewWorkflow);
  const sent = agents.dispatchIntent.mock.calls[0]![0];
  expect(sent.prompt).toContain("<recorded-validation-json>");
  expect(sent.prompt).toContain("1 fail");
  expect(sent.prompt).toContain(BRANCH_REPAIR_RULE);
});

test("dispatchMultiReviewAddressFindingsPrompt sends no validation instruction for a review without a package", async () => {
  const agents = acceptingAgents();
  await dispatchMultiReviewAddressFindingsPrompt(agents, workflow);
  const sent = agents.dispatchIntent.mock.calls[0]![0];
  expect(sent.prompt).toBe(multiReviewAddressFindingsPrompt(""));
  expect(sent.prompt).not.toContain("**Recorded validation**");
  expect(sent.prompt).not.toContain(BRANCH_REPAIR_RULE);
});
