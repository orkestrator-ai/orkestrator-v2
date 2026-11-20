import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { RICH_KIND_FIXTURES } from "@orkestrator/protocol/testing/rich-interaction-fixtures";
import { readCreateInput, type RichInteractionKind } from "@orkestrator/protocol/rich-interactions";
import type { RichInteractionViewRecord } from "@orkestrator/protocol/contract/domains/rich-interactions";
import { FakeNodeClient, cleanupNodeScopes, renderInNodeScope } from "@/test/render-in-node-scope";
import { resetRichInteractionCache } from "@/lib/chat/rich-interactions";
import { RichInteractionCard } from "./RichInteractionCard";

afterEach(() => {
  cleanupNodeScopes();
  resetRichInteractionCache();
});

function view(
  kind: RichInteractionKind,
  overrides: Partial<RichInteractionViewRecord["request"]> = {},
): RichInteractionViewRecord {
  const fixture = RICH_KIND_FIXTURES[kind];
  const created = readCreateInput(
    { requestKey: "k", kind, title: fixture.title, spec: fixture.spec },
    { origin: "agent" },
  );
  return {
    request: {
      schemaVersion: 1,
      interactionId: "ri_testcard0001",
      revision: 1,
      kind,
      origin: "agent",
      revisionAuthor: "agent",
      title: created.title,
      spec: created.spec,
      sourceRefs: [],
      actions: created.actions,
      state: "open",
      fallbackText: created.fallbackText,
      owner: { environmentId: "env-1", tabId: "tab-1", logicalSessionKey: "env-env-1:tab-1" },
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
      submissions: 0,
      ...overrides,
    },
    receipts: [],
    draft: null,
    actions: created.actions.map((a) => ({ ...a, available: true })),
    open: true,
  };
}

const receipt = {
  receiptId: "rr_1",
  interactionId: "ri_testcard0001",
  requestRevision: 1,
  actionId: "submit",
  actionLabel: "Use this direction",
  route: "agent-followup",
  idempotencyKey: "k",
  fingerprint: "f",
  result: {},
  summary: "",
  submittedAt: "t",
  delivery: "queued",
  deliveryUpdatedAt: "t",
};

describe("RichInteractionCard", () => {
  test("a visual choice submits option ids once and shows the receipt state", async () => {
    let current = view("choice");
    const submits: Array<Record<string, unknown>> = [];
    const client = new FakeNodeClient({
      invoke: {
        rich_interaction_get: () => current,
        rich_interaction_submit: (args) => {
          submits.push(args);
          current = {
            ...current,
            open: false,
            request: { ...current.request, state: "closed", submissions: 1 },
            receipts: [receipt as never],
          };
          return receipt;
        },
      },
    });
    renderInNodeScope(
      <RichInteractionCard interactionId="ri_testcard0001" environmentId="env-1" />,
      { client },
    );
    await screen.findByText("Which findings layout should I implement?");
    const submit = screen.getByRole("button", { name: "Use this direction" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("radio", { name: /Focused list/ }));
    expect(submit).toHaveProperty("disabled", false);
    await act(async () => {
      fireEvent.click(submit);
    });
    await waitFor(() => expect(submits).toHaveLength(1));
    expect(submits[0]).toMatchObject({
      environmentId: "env-1",
      interactionId: "ri_testcard0001",
      expectedRevision: 1,
      actionId: "submit",
      result: { answers: [{ questionId: "findings-layout", optionIds: ["focused-list"] }] },
    });
    expect(String(submits[0]!.idempotencyKey)).toMatch(/^ui-/);
    await screen.findByText("Queued for the agent");
    expect(screen.getByText("Answered")).toBeTruthy();
  });

  test("an ambiguous failure keeps the same idempotency key for the retry; a stale refusal says so", async () => {
    const keys: string[] = [];
    let attempt = 0;
    const client = new FakeNodeClient({
      invoke: {
        rich_interaction_get: () => view("choice"),
        rich_interaction_submit: (args) => {
          keys.push(String(args.idempotencyKey));
          attempt += 1;
          if (attempt === 1) throw new Error("connection reset");
          throw new Error(
            "rich-interaction:stale: This request changed (now revision 2). Review the update; your draft is kept.",
          );
        },
      },
    });
    renderInNodeScope(
      <RichInteractionCard interactionId="ri_testcard0001" environmentId="env-1" />,
      { client },
    );
    await screen.findByText("Which findings layout should I implement?");
    fireEvent.click(screen.getByRole("radio", { name: /Visual board/ }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Use this direction" })),
    );
    await waitFor(() => expect(screen.getAllByText(/safe to retry/).length).toBeGreaterThan(0));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Use this direction" })),
    );
    await waitFor(() =>
      expect(screen.getAllByText(/This request changed/).length).toBeGreaterThan(0),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test("a form validates locally and reviews exactly what will be sent", async () => {
    const client = new FakeNodeClient({
      invoke: {
        rich_interaction_get: () => view("form"),
        rich_interaction_save_draft: (args) => ({
          interactionId: args.interactionId,
          requestRevision: 1,
          revision: 1,
          value: args.value,
          updatedAt: "t",
        }),
      },
    });
    renderInNodeScope(
      <RichInteractionCard interactionId="ri_testcard0001" environmentId="env-1" />,
      { client },
    );
    await screen.findByText("Configure the background job");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByText(/Fix:/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Include browser checks/ }));
    // Choosing browser checks reveals the conditional browser field, which is required.
    expect(screen.getByLabelText(/Browser/, { selector: "select" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Include browser checks/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByText("Review what will be sent to this session");
    expect(screen.getByText(/Concurrency \(concurrency\): 4 workers/)).toBeTruthy();
  });

  test("an unavailable product command stays visible with its reason", async () => {
    const base = view("diagnostics");
    const record = {
      ...base,
      actions: base.actions.map((a) =>
        a.id === "rerun-selection"
          ? {
              ...a,
              available: false,
              unavailableReason: "No operation is registered for this action on this backend.",
            }
          : a,
      ),
    };
    renderInNodeScope(
      <RichInteractionCard interactionId="ri_testcard0001" environmentId="env-1" />,
      { client: new FakeNodeClient({ invoke: { rich_interaction_get: () => record } }) },
    );
    await screen.findByText(/No operation is registered/);
    expect(screen.getByRole("button", { name: "Rerun selection" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  test("a missing interaction shows an explicit unavailable state", async () => {
    renderInNodeScope(
      <RichInteractionCard interactionId="ri_testcard0001" environmentId="env-1" />,
      {
        client: new FakeNodeClient({
          invoke: {
            rich_interaction_get: () => {
              throw new Error("rich-interaction:not-found: gone");
            },
          },
        }),
      },
    );
    await screen.findByText("This interaction is no longer available.");
  });
});
