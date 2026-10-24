import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import {
  encodePublicSessionId,
  nativeTabLogicalSessionKey,
  type PublicAttentionItem,
  type PublicAttentionPage,
} from "@orkestrator/protocol/public-api-resources";
import type { Environment } from "../models.js";
import { PublicActionError } from "./errors.js";
import { onlyActionKeys, optionalInteger, optionalString } from "./input.js";
import { sessionActivity } from "./sessions.js";
import { nativeTabsOfLayout } from "./summaries.js";
import type { PublicActionContext, PublicActionHandler, ReadActionHandler } from "./types.js";

/**
 * `attention.list`: what a person (or a voice agent speaking for one) should
 * hear about now, in one bounded, metadata-only read.
 *
 * - Pending questions and approvals, always listed while they are pending,
 *   for sessions the backend has observed waiting (see below).
 * - The caller's own runs whose record changed since the cursor and that are
 *   settled or have an unknown outcome. Another authority's runs never appear,
 *   the same rule `run.get` applies.
 * - Environments whose setup finished or failed since the cursor.
 *
 * The cursor is a time position, never earlier than the one passed in, so a
 * poller that feeds each response's cursor back sees every change once.
 * Interaction titles are bounded and bodies are omitted; the tool or
 * `session.interactions` reads the detail.
 */

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

export { encodeAttentionCursor, decodeAttentionCursor } from "./attention-cursor.js";
import {
  attentionKey,
  compareAttention,
  encodeAttentionCursor,
  encodeAttentionContinuation,
  parseAttentionCursor,
  type AttentionCursor,
  type AttentionPosition,
} from "./attention-cursor.js";

function position(item: PublicAttentionItem): AttentionPosition {
  const id =
    item.kind === "run"
      ? item.operationId
      : item.kind === "setup"
        ? item.environmentId
        : `${item.sessionId}:${item.interactionId}:${item.revision}`;
  return {
    rank: item.kind === "interaction" && item.blocking ? 0 : 1,
    at: Date.parse(item.at),
    key: attentionKey(item.kind, id),
  };
}

/**
 * Pending interactions of one running environment. A session is read only
 * when its in-memory activity says it is waiting, or its cached projection
 * already shows something pending; that read is the same bounded, cached
 * pending-interactions read `session.interactions` makes, and it never
 * hydrates a transcript or re-attaches an idle provider session.
 */
async function pendingInteractions(
  context: PublicActionContext,
  environment: Environment,
  layout: unknown,
): Promise<PublicAttentionItem[]> {
  const native = context.command.nativeAgents;
  if (!native) return [];
  const items: PublicAttentionItem[] = [];
  for (const tab of nativeTabsOfLayout(layout)) {
    const logicalSessionKey = nativeTabLogicalSessionKey(environment.id, tab.tabId);
    const identity = { environmentId: environment.id, agent: tab.agent, logicalSessionKey };
    const cached = native
      .cachedProjectionSnapshot(environment.id, tab.agent, logicalSessionKey)
      ?.interactions.some(
        (request) => request.state === "pending" || request.state === "answering",
      );
    if (!cached && sessionActivity(context, identity) !== "waiting") continue;
    const requests = (await native.sessionPendingInteractions(identity).catch(() => null)) ?? [];
    for (const request of requests) {
      if (request.state !== "pending" && request.state !== "answering") continue;
      items.push({
        kind: "interaction",
        at: new Date(request.createdAt).toISOString(),
        sessionId: encodePublicSessionId(environment.id, tab.tabId),
        environmentId: environment.id,
        environmentName: environment.name.slice(0, 200),
        agent: tab.agent,
        interactionId: request.id,
        interactionKind: request.kind,
        revision: request.revision,
        blocking: request.blocking !== false,
        title: request.presentation.title.slice(0, 200),
      });
    }
  }
  return items;
}

const attentionList: ReadActionHandler<{ cursor?: AttentionCursor; limit: number }> = {
  kind: "read",
  action: "attention.list",
  parse(input) {
    onlyActionKeys(input, "attention.list");
    const cursor = optionalString(input, "cursor", 64);
    const parsed = cursor === undefined ? undefined : parseAttentionCursor(cursor);
    if (parsed === null) {
      throw new PublicActionError("invalid-input", "cursor is not an attention cursor");
    }
    return {
      ...(parsed !== undefined ? { cursor: parsed } : {}),
      limit:
        optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.attentionMaxItems) ??
        PUBLIC_API_LIMITS.attentionDefaultItems,
    };
  },
  async run(input, context) {
    const now = context.now();
    const cursor = {
      since: input.cursor?.since ?? Math.max(0, now - DEFAULT_WINDOW_MS),
      // Leave the current millisecond open for writes that race this read.
      until: input.cursor?.until ?? Math.max(now - 1, input.cursor?.since ?? 0),
      after: input.cursor?.after,
    };
    const { since, until, after } = cursor;
    const storage = context.command.storage;
    const environments = await storage.loadEnvironments();

    const interactions: PublicAttentionItem[] = [];
    for (const environment of environments) {
      if (environment.status !== "running") continue;
      interactions.push(
        ...(await pendingInteractions(
          context,
          environment,
          await storage.getPaneLayout(environment.id),
        )),
      );
    }

    const runPage = await storage.listSettledPublicOperationsChangedSince(
      context.authority,
      since,
      input.limit + 1,
      {
        until,
        after,
      },
    );
    const runs: PublicAttentionItem[] = runPage.records.map((record) => ({
      kind: "run" as const,
      at: record.updatedAt,
      operationId: record.operationId,
      action: record.action,
      state: record.state,
      sessionId: record.resources.sessionId ?? null,
      environmentId: record.resources.environmentId ?? null,
      errorCode: record.error?.code ?? null,
    }));

    const setups: PublicAttentionItem[] = environments.flatMap((environment) => {
      const completedAt = environment.setupCompletedAt
        ? Date.parse(environment.setupCompletedAt)
        : Number.NaN;
      if (!Number.isFinite(completedAt) || completedAt <= since || completedAt > until) return [];
      if (environment.setupPhase !== "ready" && environment.setupPhase !== "failed") return [];
      return [
        {
          kind: "setup" as const,
          at: environment.setupCompletedAt!,
          environmentId: environment.id,
          environmentName: environment.name.slice(0, 200),
          phase: environment.setupPhase,
        },
      ];
    });

    // A continuation skips already delivered pending interactions as well as
    // settled events. Only a fully drained window advances the polling watermark.
    const ordered = [...interactions, ...runs, ...setups]
      .filter((item) => !after || compareAttention(position(item), after) > 0)
      .sort((a, b) => compareAttention(position(a), position(b)));
    const items = ordered.slice(0, input.limit);
    const more = Math.max(0, ordered.length + runPage.total - runPage.records.length - input.limit);
    const page: PublicAttentionPage = {
      items,
      more,
      counts: { interactions: interactions.length, runs: runPage.total, setups: setups.length },
      cursor:
        more && items.length
          ? encodeAttentionContinuation(cursor, position(items.at(-1)!))
          : encodeAttentionCursor(until),
    };
    return { result: page };
  },
};

export const ATTENTION_HANDLERS: PublicActionHandler[] = [attentionList];
