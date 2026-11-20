import {
  richDeliverableUpdateCommand,
  richDeliverablesListCommand,
  richInteractionClearDraftCommand,
  richInteractionComposeCommand,
  richInteractionDismissCommand,
  richInteractionGetCommand,
  richInteractionRetryDeliveryCommand,
  richInteractionSaveDraftCommand,
  richInteractionSubmitCommand,
  richInteractionsListCommand,
  type RichInteractionViewRecord,
} from "@orkestrator/protocol/contract/domains/rich-interactions";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { RichInteractionError, type RichInteractionService } from "./rich-interactions/service.js";

/**
 * The `rich-interactions` domain. Refusals keep their stable code in the
 * message (`rich-interaction:<code>: …`) so the renderer can show stale,
 * conflict and capacity states without parsing prose.
 */

function service(context: CommandContext): RichInteractionService {
  if (!context.richInteractions)
    throw new Error(
      "rich-interaction:unavailable: Rich interactions are unavailable on this backend.",
    );
  return context.richInteractions;
}

async function guarded<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RichInteractionError) {
      throw new Error(`rich-interaction:${error.code}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export function registerRichInteractionCommands(register: CommandRegistrar): void {
  register(richInteractionsListCommand, (args, context) =>
    guarded(
      () =>
        service(context).listForConversation(
          args.environmentId,
          args.logicalSessionKey,
        ) as RichInteractionViewRecord[],
    ),
  );
  register(richInteractionGetCommand, (args, context) =>
    guarded(
      () =>
        service(context).get(args.environmentId, args.interactionId) as RichInteractionViewRecord,
    ),
  );
  register(richInteractionSaveDraftCommand, (args, context) =>
    guarded(() => {
      const draft = service(context).saveDraft(args.environmentId, {
        interactionId: args.interactionId,
        expectedDraftRevision: args.expectedDraftRevision,
        requestRevision: args.requestRevision,
        value: args.value,
      });
      if (!draft) throw new RichInteractionError("conflict", "The draft could not be saved.");
      return draft;
    }),
  );
  register(richInteractionClearDraftCommand, (args, context) =>
    guarded(() => {
      service(context).clearDraft(args.environmentId, args.interactionId);
      return { ok: true };
    }),
  );
  register(richInteractionSubmitCommand, (args, context) =>
    guarded(() =>
      service(context).submit(args.environmentId, {
        interactionId: args.interactionId,
        expectedRevision: args.expectedRevision,
        ...(args.expectedDraftRevision === undefined
          ? {}
          : { expectedDraftRevision: args.expectedDraftRevision }),
        actionId: args.actionId,
        idempotencyKey: args.idempotencyKey,
        result: args.result,
      }),
    ),
  );
  register(richInteractionComposeCommand, (args, context) =>
    guarded(() =>
      service(context).compose(args.environmentId, {
        tabId: args.tabId,
        kind: args.kind,
        title: args.title,
        spec: args.spec,
        ...(args.sourceRefs === undefined ? {} : { sourceRefs: args.sourceRefs }),
        actionId: args.actionId,
        idempotencyKey: args.idempotencyKey,
        result: args.result,
      }),
    ),
  );
  register(richInteractionDismissCommand, (args, context) =>
    guarded(() =>
      service(context).dismiss(args.environmentId, args.interactionId, args.expectedRevision),
    ),
  );
  register(richInteractionRetryDeliveryCommand, (args, context) =>
    guarded(() => service(context).retryDelivery(args.environmentId, args.receiptId)),
  );
  register(richDeliverablesListCommand, (args, context) =>
    guarded(() => service(context).listDeliverables(args.environmentId, args.logicalSessionKey)),
  );
  register(richDeliverableUpdateCommand, (args, context) =>
    guarded(() =>
      service(context).updateDeliverable(args.environmentId, {
        logicalSessionKey: args.logicalSessionKey,
        artifactId: args.artifactId,
        expectedRevision: args.expectedRevision,
        patch: {
          ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
          ...(args.userLabel === undefined ? {} : { userLabel: args.userLabel }),
          ...(args.selectedRevision === undefined
            ? {}
            : { selectedRevision: args.selectedRevision }),
          ...(args.group === undefined ? {} : { group: args.group }),
        },
      }),
    ),
  );
}
