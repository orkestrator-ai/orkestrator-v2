import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { RICH_KIND_FIXTURES } from "@orkestrator/protocol/testing/rich-interaction-fixtures";
import {
  RICH_INTERACTION_KINDS,
  USER_ORIGINATED_KINDS,
  buildRichInteractionPrompt,
  candidateHash,
  readFormSpec,
  type WidgetResultSpec,
  type ResultReviewSpec,
  readCreateInput,
  readSubmission,
  type RichInteractionKind,
} from "@orkestrator/protocol/rich-interactions";
import { FakeNodeClient, cleanupNodeScopes, renderInNodeScope } from "@/test/render-in-node-scope";
import { normalizeNativeMessage } from "@/lib/chat/native-message-adapters";
import { resetRichInteractionCache } from "@/lib/chat/rich-interactions";
import {
  clearArtifactResultCandidates,
  publishArtifactResultCandidate,
  resetArtifactResultCandidates,
} from "@/lib/chat/artifact-result-candidates";
import { ResultReviewCard } from "./kinds/ResultReviewCard";
import { WidgetResultCard } from "./kinds/WidgetResultCard";
import { KIND_RENDERERS } from "./kind-registry";
import { RichInteractionCard } from "./RichInteractionCard";
import { InteractionReceiptPart } from "./InteractionReceiptPart";

import { RichTranscriptScopeContext } from "@/lib/chat/rich-identity";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { DeliverablesPanel } from "./composer/DeliverablesPanel";

const transcriptScope = {
  backendId: "backend",
  environmentId: "env-1",
  logicalSessionKey: "env-env-1:tab-1",
  generation: "one",
};

afterEach(() => {
  cleanupNodeScopes();
  resetRichInteractionCache();
  resetArtifactResultCandidates();
});

function record(kind: RichInteractionKind, answered: boolean) {
  const fixture = RICH_KIND_FIXTURES[kind];
  const origin: "user" | "agent" = USER_ORIGINATED_KINDS.includes(kind) ? "user" : "agent";
  const created = readCreateInput(
    { requestKey: "k", kind, title: fixture.title, spec: fixture.spec },
    { origin },
  );
  const request = {
    schemaVersion: 1 as const,
    interactionId: `ri_smoke_${kind.replace(/[^a-z]/g, "")}0001`,
    revision: 1,
    kind,
    origin,
    revisionAuthor: origin,
    title: created.title,
    spec: created.spec,
    sourceRefs: [],
    actions: created.actions,
    state: answered ? ("closed" as const) : ("open" as const),
    fallbackText: created.fallbackText,
    owner: { environmentId: "env-1", tabId: "tab-1", logicalSessionKey: "env-env-1:tab-1" },
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    submissions: answered ? 1 : 0,
  };
  const submission = readSubmission(request, {
    actionId: fixture.actionId,
    result: fixture.result,
  });
  return {
    request,
    receipts: answered
      ? [
          {
            receiptId: "rr_1",
            interactionId: request.interactionId,
            requestRevision: 1,
            actionId: fixture.actionId,
            actionLabel: submission.action.label,
            route: submission.action.route,
            idempotencyKey: "k",
            fingerprint: "f",
            result: submission.result,
            summary: "s",
            submittedAt: "t",
            delivery: "delivered" as const,
            deliveryUpdatedAt: "t",
          },
        ]
      : [],
    draft: null,
    actions: created.actions.map((a) => ({ ...a, available: true })),
    open: !answered,
  };
}

describe("kind registry", () => {
  test("every registered kind has a trusted renderer", () => {
    for (const kind of RICH_INTERACTION_KINDS) expect(KIND_RENDERERS[kind]).toBeDefined();
  });

  for (const kind of RICH_INTERACTION_KINDS) {
    for (const answered of [false, true]) {
      test(`${kind} renders ${answered ? "after a decision" : "open"} from its fixture`, async () => {
        const view = record(kind, answered);
        renderInNodeScope(
          <RichInteractionCard interactionId={view.request.interactionId} environmentId="env-1" />,
          {
            client: new FakeNodeClient({ invoke: { rich_interaction_get: () => view } }),
          },
        );
        await screen.findAllByRole("group", { name: view.request.title });
        if (answered) expect(screen.getByText("Delivered to the agent")).toBeTruthy();
      });
    }
  }
});

describe("interaction receipts in the transcript", () => {
  test("a delivered decision renders as a receipt, not raw envelope text", () => {
    const prompt = buildRichInteractionPrompt("Chose Focused list", {
      interactionId: "ri_abcdefgh01",
      revision: 1,
      receiptId: "rr_1",
      actionId: "submit",
      kind: "choice",
      title: "Findings layout",
    });
    const userMessage = {
      id: "user-1",
      role: "user" as const,
      content: prompt,
      createdAt: "2026-11-20T00:00:00.000Z",
      parts: [{ type: "text" as const, content: prompt }],
    };
    const normalized = normalizeNativeMessage(userMessage);
    const part = normalized.parts.find((part) => part.type === "interaction-receipt");
    expect(part?.type).toBe("interaction-receipt");
    if (part?.type !== "interaction-receipt") throw new Error("Missing receipt part");
    renderInNodeScope(<InteractionReceiptPart part={part} />);
    const quoted = `${prompt}\nCan you explain this decision?`;
    const question = normalizeNativeMessage({
      ...userMessage,
      content: quoted,
      parts: [{ type: "text", content: quoted }],
    });
    expect(question.parts.some((part) => part.type === "interaction-receipt")).toBe(false);
    expect(question.content).toContain("Can you explain this decision?");
    expect(screen.getByText("Findings layout")).toBeTruthy();
    expect(screen.queryByText(/orkestrator_interaction_result/) === null).toBe(true);
  });
});

test("widget review freezes values within one viewer and clears on rebind or disposal", async () => {
  const view = record("widget-result", false);
  const spec = {
    ...(view.request.spec as WidgetResultSpec),
    output: readFormSpec(
      {
        fields: [
          {
            id: "group",
            type: "group",
            label: "Settings",
            fields: [{ id: "workers", type: "number", label: "Workers", required: true }],
          },
        ],
      },
      "$",
    ),
  };
  const submit = mock(() => undefined);
  const proposal = { artifactId: spec.artifactId, revision: spec.revision, generation: "viewer-1" };
  publishArtifactResultCandidate({
    ...proposal,
    candidateId: "first",
    value: { group: { workers: 2 } },
  });
  const card = (binding: WidgetResultSpec) => (
    <WidgetResultCard
      view={view}
      spec={binding}
      draft={null}
      setDraft={() => undefined}
      act={submit}
      disabled={false}
      actions={view.actions}
    />
  );
  const rendered = renderInNodeScope(card(spec));
  fireEvent.click(await screen.findByRole("button", { name: "Review these values" }));
  act(() =>
    publishArtifactResultCandidate({
      ...proposal,
      candidateId: "second",
      value: { group: { workers: 3 } },
    }),
  );
  expect(screen.getByText(/explorer proposed newer values/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send result" }));
  expect(submit).toHaveBeenCalledWith(
    "send-result",
    expect.objectContaining({
      candidateId: "first",
      candidateHash: candidateHash({ group: { workers: 2 } }),
      value: { group: { workers: 2 } },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review these values" }));
  rendered.rerender(card({ ...spec, revision: spec.revision + 1 }));
  expect(screen.queryByRole("group", { name: "Review result" }) === null).toBe(true);
  expect(screen.queryByRole("button", { name: "Send result" }) === null).toBe(true);
  rendered.rerender(card(spec));
  fireEvent.click(screen.getByRole("button", { name: "Review these values" }));
  act(() =>
    clearArtifactResultCandidates(proposal.artifactId, proposal.revision, proposal.generation),
  );
  expect(screen.getByText(/No result proposed yet/)).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Review result" }) === null).toBe(true);
});

test("a normalized assistant tool result loads its interaction in the transcript", async () => {
  const view = record("choice", false);
  const invoke = new FakeNodeClient({ invoke: { rich_interaction_get: () => view } });
  const message = normalizeNativeMessage({
    id: "assistant-1",
    role: "assistant",
    content: "",
    createdAt: "2026-11-20T00:00:00Z",
    parts: [
      {
        type: "tool-invocation",
        content: "present_interaction",
        toolName: "present_interaction",
        mcpServerName: "orkestrator",
        toolUseId: "tool-1",
        toolState: "success",
        toolOutput: JSON.stringify({ interactionId: view.request.interactionId, revision: 1 }),
      },
    ],
  });
  renderInNodeScope(
    <RichTranscriptScopeContext.Provider value={transcriptScope}>
      <NativeMessage message={message} />
    </RichTranscriptScopeContext.Provider>,
    { client: invoke },
  );
  expect(await screen.findByText("Which findings layout should I implement?")).toBeTruthy();
  expect(
    invoke.invocations.find((call) => call.command === "rich_interaction_get")?.args.interactionId,
  ).toBe(view.request.interactionId);
});

test("deliverables show newest outputs with continuation and retry a first interaction-list failure", async () => {
  const newest = {
    ref: { artifactId: "art-latest", revision: 1, title: "Newest delivery", kind: "chart" },
    conversationSequence: 532,
    availability: "available",
  };
  const older = {
    ref: { artifactId: "art-older", revision: 1, title: "Older delivery", kind: "chart" },
    conversationSequence: 431,
    availability: "available",
  };
  let attempts = 0;
  const client = new FakeNodeClient({
    invoke: {
      rich_interactions_list: () => {
        if (++attempts === 1) throw new Error("Read failed");
        return [];
      },
      rich_deliverables_list: [],
      transcript_artifact_list_publications: (args: Record<string, unknown>) =>
        args.beforeSequence === 500
          ? { publications: [older], nextSequence: null }
          : { publications: [newest], nextSequence: 500 },
    },
  });
  renderInNodeScope(
    <RichTranscriptScopeContext.Provider value={transcriptScope}>
      <DeliverablesPanel
        environmentId={transcriptScope.environmentId}
        logicalSessionKey={transcriptScope.logicalSessionKey}
      />
    </RichTranscriptScopeContext.Provider>,
    { client },
  );
  await screen.findByText("Could not load conversation interactions.");
  await screen.findByRole("button", { name: "Newest delivery" });
  expect(
    client.invocations.find((call) => call.command === "transcript_artifact_list_publications")
      ?.args.newestFirst,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert") === null).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Older outputs" }));
  await screen.findByRole("button", { name: "Older delivery" });
  expect(
    client.invocations
      .filter((call) => call.command === "transcript_artifact_list_publications")
      .at(-1)?.args.beforeSequence,
  ).toBe(500);
});

test("a result revision keeps earlier decisions labelled with their original revision", async () => {
  const current = record("result-review", true);
  const spec = current.request.spec as ResultReviewSpec;
  const base = current.receipts[0]!;
  const prior = {
    ...base,
    actionId: "request-changes",
    actionLabel: "Request changes",
    result: { expectedResultRevision: spec.resultRevision - 1 },
    receiptId: "rr_old",
  };
  const first = {
    ...base,
    actionId: "request-changes",
    actionLabel: "Earlier request",
    result: { expectedResultRevision: spec.resultRevision },
    receiptId: "rr_first",
  };
  const latest = {
    ...base,
    actionId: "request-changes",
    actionLabel: "Latest request",
    result: { expectedResultRevision: spec.resultRevision },
    receiptId: "rr_latest",
  };
  renderInNodeScope(
    <ResultReviewCard
      view={{ ...current, receipts: [prior, first, latest] }}
      spec={spec}
      draft={null}
      setDraft={() => undefined}
      act={() => undefined}
      disabled={false}
      actions={current.actions}
    />,
  );
  expect(
    screen.getByText(
      `Your decision: Request changes (result revision ${spec.resultRevision - 1}).`,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(`Your decision: Latest request (result revision ${spec.resultRevision}).`),
  ).toBeTruthy();
  expect(screen.queryByText(/Your decision: Earlier request/) === null).toBe(true);
});
