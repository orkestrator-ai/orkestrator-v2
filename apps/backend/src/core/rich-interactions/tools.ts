/**
 * Agent tools for rich interactions, registered on the common `orkestrator`
 * MCP server for tab-scoped credentials only: an interaction belongs to the
 * conversation of the tab that created it, and that tab is the only
 * destination its decisions are ever delivered to.
 *
 * Input schemas stay shallow; the kind-specific `spec` is validated by the
 * protocol's kind registry, whose errors carry a JSON path. Results are JSON
 * as both text and structured content, so adapters that flatten results
 * keep every id.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import {
  AGENT_AUTHORED_KINDS,
  RICH_INTERACTION_LIMITS,
  RICH_KIND_MODULES,
  type RichInteractionReceipt,
  type ContextPacketSpec,
  type DemonstrationResult,
  type DemonstrationSpec,
  type VoiceRequestResult,
  type VoiceRequestSpec,
} from "@orkestrator/protocol/rich-interactions";
import { int, list, looseObject, str, strictObject, toolInput } from "../tool-schema.js";
import {
  RichInteractionError,
  type RichInteractionService,
  type RichInteractionView,
} from "./service.js";

export const RICH_INTERACTION_TOOL_INSTRUCTIONS =
  " Interactions: when the user must choose, fill in, select, review or approve something precise, call present_interaction instead of asking in prose. " +
  "Pick the smallest kind: choice (2-8 options with optional previews), form (related fields), plan (editable steps), collection (selectable rows), code-review, result-review, document, diagnostics (test results), chart-selection, diagram, evidence, criteria (acceptance criteria), alternatives, workflow-actions, widget-result. " +
  "Keep a one-line question in prose when a card adds nothing. The user's decision arrives later as a follow-up message carrying an <orkestrator_interaction_result> envelope; do not wait or poll for it. " +
  "Selecting, sorting and previewing in a card never reaches you; only explicit submissions do. A decision is the user's preference, never a permission grant.";

const MUTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function failure(error: unknown) {
  if (error instanceof RichInteractionError) {
    return result(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.path ? { path: error.path } : {}),
        },
      },
      true,
    );
  }
  return result(
    {
      ok: false,
      error: { code: "internal", message: "The interaction service failed; try again." },
    },
    true,
  );
}

function toolCallId(ctx: unknown): string | undefined {
  const meta = (ctx as { mcpReq?: { _meta?: Record<string, unknown> } } | undefined)?.mcpReq?._meta;
  const value = meta?.["claudecode/toolUseId"] ?? meta?.toolCallId;
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

/** What the agent sees of a receipt: the decision, never internal dispatch bookkeeping. */
function agentReceipt(receipt: RichInteractionReceipt) {
  return {
    receiptId: receipt.receiptId,
    requestRevision: receipt.requestRevision,
    actionId: receipt.actionId,
    actionLabel: receipt.actionLabel,
    route: receipt.route,
    submittedAt: receipt.submittedAt,
    delivery: receipt.delivery,
    result: receipt.result,
    summary: receipt.summary,
    ...(receipt.resultingRevision === undefined
      ? {}
      : { resultingRevision: receipt.resultingRevision }),
  };
}

function agentSpec({ request, receipts }: RichInteractionView): unknown {
  const sent = receipts.find((receipt) => receipt.actionId === "send");
  switch (request.kind) {
    case "context-packet":
      return {
        items: sent
          ? (request.spec as ContextPacketSpec).items.filter((item) => item.included)
          : [],
      };
    case "voice-request": {
      const spec = request.spec as VoiceRequestSpec;
      return sent ? { ...spec, recognized: (sent.result as VoiceRequestResult).text } : null;
    }
    case "demonstration": {
      if (!sent) return null;
      const { steps, gaps, ...metadata } = request.spec as DemonstrationSpec;
      const { stepIds, expectedOutcome } = sent.result as DemonstrationResult;
      const kept = new Set(stepIds);
      return {
        ...metadata,
        expectedOutcome,
        steps: steps.filter((step) => kept.has(step.stepId)),
        gaps: gaps.filter((gap) => !gap.afterStepId || kept.has(gap.afterStepId)),
      };
    }
    default:
      return request.spec;
  }
}

function agentView(view: RichInteractionView, options: { full: boolean }) {
  const { request } = view;
  return {
    interactionId: request.interactionId,
    kind: request.kind,
    title: request.title,
    revision: request.revision,
    revisionAuthor: request.revisionAuthor,
    state: request.state,
    ...(request.supersededBy ? { supersededBy: request.supersededBy } : {}),
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    actions: view.actions.map((a) => ({
      id: a.id,
      label: a.label,
      route: a.route,
      available: a.available,
    })),
    submissions: request.submissions,
    ...(options.full
      ? { spec: agentSpec(view), receipts: view.receipts.map(agentReceipt) }
      : { lastReceipt: view.receipts.at(-1) ? agentReceipt(view.receipts.at(-1)!) : null }),
  };
}

const requestKey = str({ trim: true, min: 1, max: RICH_INTERACTION_LIMITS.idempotencyKeyChars });
const interactionId = str({ trim: true, min: 1, max: 200 });

export function registerRichInteractionTools(
  server: McpServer,
  service: RichInteractionService,
  scope: { environmentId: string; tabId: string },
): void {
  const caller = { environmentId: scope.environmentId, tabId: scope.tabId };

  server.registerTool(
    "present_interaction",
    {
      title: "Present an interactive card to the user",
      description:
        `Create an app-owned interactive card in this conversation (kinds: ${AGENT_AUTHORED_KINDS.join(", ")}). ` +
        "The user explores it locally and submits an explicit decision, which arrives later as a follow-up message. " +
        "requestKey makes the call idempotent: reuse it only to retry the same call. Returns interactionId and revision. " +
        "spec is kind-specific; validation errors name the failing JSON path. Large data belongs in an artifact referenced from spec. " +
        `Actions: omit to offer the kind's registered actions, or pass [{id,label?}] to choose/relabel them (${AGENT_AUTHORED_KINDS.map((k) => `${k}: ${RICH_KIND_MODULES[k].actions.map((a) => a.id).join("/")}${RICH_KIND_MODULES[k].customFollowups ? " or custom follow-up ids" : ""}`).join("; ")}).`,
      inputSchema: toolInput(
        strictObject({
          requestKey,
          kind: Schema.Literals(AGENT_AUTHORED_KINDS as readonly [string, ...string[]]),
          title: str({ trim: true, min: 1, max: RICH_INTERACTION_LIMITS.titleChars }),
          body: Schema.optionalKey(str({ max: RICH_INTERACTION_LIMITS.bodyChars })),
          spec: looseObject({}),
          sourceRefs: Schema.optionalKey(list(looseObject({}), { max: 32 })),
          actions: Schema.optionalKey(
            list(
              strictObject({
                id: str({ trim: true, min: 1, max: 64 }),
                label: Schema.optionalKey(str({ max: 80 })),
                description: Schema.optionalKey(str({ max: 500 })),
              }),
              { max: 12 },
            ),
          ),
          expiresInSeconds: Schema.optionalKey(
            int({ min: 30, max: RICH_INTERACTION_LIMITS.maxExpirySeconds }),
          ),
          supersedes: Schema.optionalKey(interactionId),
        }),
      ),
      annotations: MUTATION,
    },
    async (args, ctx) => {
      try {
        const created = await service.present(caller, args, toolCallId(ctx));
        return result({
          ok: true,
          created: created.created,
          interactionId: created.request.interactionId,
          revision: created.request.revision,
          state: created.request.state,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "update_interaction",
    {
      title: "Publish a new revision of an interaction, or close it",
      description:
        "Replace the spec as revision expectedRevision + 1 (compare-and-swap): attach new evidence, revise a plan or document, publish a newer result, or reply to a comment thread by appending an agent entry. " +
        "User-owned state (thread history, human acceptance, preserved document sections) cannot be changed and is merged automatically. Pass close: true to close a request you no longer need.",
      inputSchema: toolInput(
        strictObject({
          interactionId,
          expectedRevision: int({ min: 1 }),
          spec: Schema.optionalKey(looseObject({})),
          title: Schema.optionalKey(
            str({ trim: true, min: 1, max: RICH_INTERACTION_LIMITS.titleChars }),
          ),
          body: Schema.optionalKey(str({ max: RICH_INTERACTION_LIMITS.bodyChars })),
          close: Schema.optionalKey(Schema.Boolean),
        }),
      ),
      annotations: MUTATION,
    },
    async (args) => {
      try {
        const updated = await service.update(caller, args);
        return result({
          ok: true,
          interactionId: updated.interactionId,
          revision: updated.revision,
          state: updated.state,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "read_interaction_result",
    {
      title: "Read an interaction and the user's submitted decisions",
      description:
        "Returns the current spec, revision, state and every submitted decision (structured result plus readable summary) for an interaction in this conversation.",
      inputSchema: toolInput(strictObject({ interactionId })),
      annotations: READ,
    },
    async ({ interactionId: id }) => {
      try {
        return result({
          ok: true,
          interaction: agentView(service.read(caller, id), { full: true }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_interactions",
    {
      title: "List this conversation's interactions",
      description:
        "Lists interactions of this conversation with their state and latest decision. Use read_interaction_result for the full result.",
      inputSchema: toolInput(strictObject({ openOnly: Schema.optionalKey(Schema.Boolean) })),
      annotations: READ,
    },
    async ({ openOnly }) => {
      try {
        const views = service
          .listForConversation(caller.environmentId, `env-${caller.environmentId}:${caller.tabId}`)
          .filter((view) => !openOnly || view.open)
          .slice(-100);
        return result({
          ok: true,
          interactions: views.map((view) => agentView(view, { full: false })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
