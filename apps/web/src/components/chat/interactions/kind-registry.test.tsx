import { afterEach, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { RICH_KIND_FIXTURES } from "@orkestrator/protocol/testing/rich-interaction-fixtures";
import {
  RICH_INTERACTION_KINDS,
  USER_ORIGINATED_KINDS,
  buildRichInteractionPrompt,
  readCreateInput,
  readSubmission,
  type RichInteractionKind,
} from "@orkestrator/protocol/rich-interactions";
import { FakeNodeClient, cleanupNodeScopes, renderInNodeScope } from "@/test/render-in-node-scope";
import { normalizeClaudePart } from "@/lib/chat/native-message-adapters";
import { resetRichInteractionCache } from "@/lib/chat/rich-interactions";
import { KIND_RENDERERS } from "./kind-registry";
import { RichInteractionCard } from "./RichInteractionCard";
import { InteractionReceiptPart } from "./InteractionReceiptPart";

afterEach(() => {
  cleanupNodeScopes();
  resetRichInteractionCache();
});

function record(kind: RichInteractionKind, answered: boolean) {
  const fixture = RICH_KIND_FIXTURES[kind];
  const origin = USER_ORIGINATED_KINDS.includes(kind) ? "user" : "agent";
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
    const part = normalizeClaudePart({
      type: "interaction-receipt",
      content: "Chose Focused list",
      interaction: {
        interactionId: "ri_abcdefgh01",
        revision: 1,
        receiptId: "rr_1",
        actionId: "submit",
        kind: "choice",
        title: "Findings layout",
      },
    } as never);
    expect(part?.type).toBe("interaction-receipt");
    expect(prompt).toContain("<orkestrator_interaction_result>");
    renderInNodeScope(<InteractionReceiptPart part={part as never} />);
    expect(screen.getByText("Findings layout")).toBeTruthy();
    expect(screen.queryByText(/orkestrator_interaction_result/)).toBeNull();
  });
});
