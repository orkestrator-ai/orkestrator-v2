import { useState } from "react";
import {
  readCreateInput,
  type ResultReviewSpec,
  type RichInteractionKind,
  type WorkflowActionsSpec,
} from "@orkestrator/protocol/rich-interactions";
import { RICH_KIND_FIXTURES } from "@orkestrator/protocol/testing/rich-interaction-fixtures";
import type { RichInteractionViewRecord } from "@orkestrator/protocol/contract/domains/rich-interactions";
import { WorkflowActionsCard } from "../../apps/web/src/components/chat/interactions/kinds/WorkflowActionsCard";
import { ResultReviewCard } from "../../apps/web/src/components/chat/interactions/kinds/ResultReviewCard";

function view(kind: RichInteractionKind): RichInteractionViewRecord {
  const fixture = RICH_KIND_FIXTURES[kind];
  const { actions, ...spec } = readCreateInput(
    { requestKey: kind, kind, title: fixture.title, spec: fixture.spec },
    { origin: "agent" },
  );
  return {
    request: {
      ...spec,
      actions,
      schemaVersion: 1,
      interactionId: "ri_fixture-card",
      revision: 1,
      origin: "agent",
      revisionAuthor: "agent",
      state: "open",
      submissions: 0,
      owner: {
        environmentId: "fixture-env",
        tabId: "fixture-tab",
        logicalSessionKey: "env-fixture-env:fixture-tab",
      },
      createdAt: "2026-11-20T00:00:00Z",
      updatedAt: "2026-11-20T00:00:00Z",
    },
    actions: actions.map((action) => ({ ...action, available: true })),
    draft: null,
    receipts: [],
    open: true,
  };
}

const workflow = view("workflow-actions");
const workflowSpec = workflow.request.spec as WorkflowActionsSpec;
const review = view("result-review");
const reviewSpec = review.request.spec as ResultReviewSpec;

export function RichInteractionReviewFixture() {
  const [node, setNode] = useState<unknown>({ nodeId: "validation" });
  const [reviewDraft, setReviewDraft] = useState<unknown>(null);
  const [intent, setIntent] = useState<string>("");
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-3 p-3">
      <section aria-label="Workflow controls" className="rounded border border-border p-3">
        <h2 className="mb-2 text-sm font-medium">Workflow controls</h2>
        <WorkflowActionsCard
          view={workflow}
          spec={{
            ...workflowSpec,
            workflowId: "graph",
            nodes: workflowSpec.nodes.map((node) => ({ ...node, state: "running" })),
          }}
          draft={node}
          setDraft={setNode}
          act={(action, result) => setIntent(JSON.stringify({ action, result }))}
          disabled={false}
          actions={workflow.actions}
        />
        {intent ? <output data-testid="workflow-intent">{intent}</output> : null}
      </section>
      <section aria-label="Result review" className="rounded border border-border p-3">
        <h2 className="mb-2 text-sm font-medium">Result review</h2>
        <ResultReviewCard
          view={review}
          spec={reviewSpec}
          draft={reviewDraft}
          setDraft={setReviewDraft}
          act={() => undefined}
          disabled={false}
          actions={review.actions}
        />
      </section>
    </main>
  );
}
