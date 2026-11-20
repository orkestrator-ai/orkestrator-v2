import type {
  RichDeliverableRecord,
  RichInteractionViewRecord,
} from "@orkestrator/protocol/contract/domains/rich-interactions";
import type {
  RichInteractionKind,
  RichInteractionReceipt,
  RichInteractionRequest,
} from "@orkestrator/protocol/rich-interactions";
import { richInteractions } from "@/lib/node-scope/domains/rich-interactions";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * App-owned rich interactions (docs/architecture/rich-interactions.md). Every
 * call names its environment; the backend checks each request belongs to it
 * and delivers a decision only to the session stored on the request.
 */
export function createRichInteractionsApi(client: BackendClient) {
  const api = richInteractions(client);

  function listRichInteractions(input: {
    environmentId: string;
    logicalSessionKey?: string;
  }): Promise<RichInteractionViewRecord[]> {
    return api().rich_interactions_list(input) as Promise<RichInteractionViewRecord[]>;
  }

  function getRichInteraction(input: {
    environmentId: string;
    interactionId: string;
  }): Promise<RichInteractionViewRecord> {
    return api().rich_interaction_get(input) as Promise<RichInteractionViewRecord>;
  }

  function saveRichInteractionDraft(input: {
    environmentId: string;
    interactionId: string;
    expectedDraftRevision: number;
    requestRevision: number;
    value: unknown;
  }): Promise<NonNullable<RichInteractionViewRecord["draft"]>> {
    return api().rich_interaction_save_draft(input) as Promise<
      NonNullable<RichInteractionViewRecord["draft"]>
    >;
  }

  function clearRichInteractionDraft(input: {
    environmentId: string;
    interactionId: string;
  }): Promise<{ ok: boolean }> {
    return api().rich_interaction_clear_draft(input) as Promise<{ ok: boolean }>;
  }

  function submitRichInteraction(input: {
    environmentId: string;
    interactionId: string;
    expectedRevision: number;
    expectedDraftRevision?: number;
    actionId: string;
    idempotencyKey: string;
    result: unknown;
  }): Promise<RichInteractionReceipt> {
    return api().rich_interaction_submit(input) as Promise<RichInteractionReceipt>;
  }

  function composeRichInteraction(input: {
    environmentId: string;
    tabId: string;
    kind: RichInteractionKind;
    title: string;
    spec: unknown;
    sourceRefs?: unknown;
    actionId: string;
    idempotencyKey: string;
    result: unknown;
  }): Promise<{ request: RichInteractionRequest; receipt: RichInteractionReceipt }> {
    return api().rich_interaction_compose(input) as Promise<{
      request: RichInteractionRequest;
      receipt: RichInteractionReceipt;
    }>;
  }

  function dismissRichInteraction(input: {
    environmentId: string;
    interactionId: string;
    expectedRevision: number;
  }): Promise<RichInteractionRequest> {
    return api().rich_interaction_dismiss(input) as Promise<RichInteractionRequest>;
  }

  function retryRichInteractionDelivery(input: {
    environmentId: string;
    receiptId: string;
  }): Promise<RichInteractionReceipt> {
    return api().rich_interaction_retry_delivery(input) as Promise<RichInteractionReceipt>;
  }

  function listRichDeliverables(input: {
    environmentId: string;
    logicalSessionKey: string;
  }): Promise<RichDeliverableRecord[]> {
    return api().rich_deliverables_list(input) as Promise<RichDeliverableRecord[]>;
  }

  function updateRichDeliverable(input: {
    environmentId: string;
    logicalSessionKey: string;
    artifactId: string;
    expectedRevision: number;
    pinned?: boolean;
    userLabel?: string | null;
    selectedRevision?: number | null;
    group?: string | null;
  }): Promise<RichDeliverableRecord> {
    return api().rich_deliverable_update(input) as Promise<RichDeliverableRecord>;
  }

  return {
    listRichInteractions,
    getRichInteraction,
    saveRichInteractionDraft,
    clearRichInteractionDraft,
    submitRichInteraction,
    composeRichInteraction,
    dismissRichInteraction,
    retryRichInteractionDelivery,
    listRichDeliverables,
    updateRichDeliverable,
  };
}

export type RichInteractionsBackendApi = ReturnType<typeof createRichInteractionsApi>;

/** The window's command-scope binding. */
export const {
  listRichInteractions,
  getRichInteraction,
  saveRichInteractionDraft,
  clearRichInteractionDraft,
  submitRichInteraction,
  composeRichInteraction,
  dismissRichInteraction,
  retryRichInteractionDelivery,
  listRichDeliverables,
  updateRichDeliverable,
} = createRichInteractionsApi(commandBackendClient);
