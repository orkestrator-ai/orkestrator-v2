import {
  isTerminalPublicOperationState,
  PUBLIC_API_LIMITS,
} from "@orkestrator/protocol/public-api";
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

const CURSOR_PATTERN = /^att1-([0-9a-z]{1,12})$/;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const MAX_ENVIRONMENTS_SCANNED = 200;

export function encodeAttentionCursor(ms: number): string {
  return `att1-${Math.max(0, Math.floor(ms)).toString(36)}`;
}

export function decodeAttentionCursor(cursor: string): number | null {
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) return null;
  const ms = Number.parseInt(match[1]!, 36);
  return Number.isSafeInteger(ms) ? ms : null;
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

const attentionList: ReadActionHandler<{ since?: number; limit: number }> = {
  kind: "read",
  action: "attention.list",
  parse(input) {
    onlyActionKeys(input, "attention.list");
    const cursor = optionalString(input, "cursor", 64);
    const since = cursor === undefined ? undefined : decodeAttentionCursor(cursor);
    if (since === null) {
      throw new PublicActionError("invalid-input", "cursor is not an attention cursor");
    }
    return {
      ...(since !== undefined ? { since } : {}),
      limit:
        optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.attentionMaxItems) ??
        PUBLIC_API_LIMITS.attentionDefaultItems,
    };
  },
  async run(input, context) {
    const now = context.now();
    const since = input.since ?? now - DEFAULT_WINDOW_MS;
    const storage = context.command.storage;
    const environments = (await storage.loadEnvironments()).slice(0, MAX_ENVIRONMENTS_SCANNED);

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

    const runs: PublicAttentionItem[] = (
      await storage.listPublicOperationsChangedSince(
        context.authority,
        since,
        PUBLIC_API_LIMITS.attentionMaxItems,
      )
    )
      .filter(
        (record) => isTerminalPublicOperationState(record.state) || record.state === "unknown",
      )
      .map((record) => ({
        kind: "run" as const,
        at: record.completedAt ?? record.updatedAt,
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
      if (!Number.isFinite(completedAt) || completedAt <= since) return [];
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

    // Blocking interactions first (someone is waiting), then everything else
    // newest first.
    const ordered = [...interactions, ...runs, ...setups].sort((a, b) => {
      const blockingA = a.kind === "interaction" && a.blocking ? 1 : 0;
      const blockingB = b.kind === "interaction" && b.blocking ? 1 : 0;
      return blockingB - blockingA || Date.parse(b.at) - Date.parse(a.at);
    });
    const page: PublicAttentionPage = {
      items: ordered.slice(0, input.limit),
      more: Math.max(0, ordered.length - input.limit),
      counts: { interactions: interactions.length, runs: runs.length, setups: setups.length },
      cursor: encodeAttentionCursor(Math.max(now, input.since ?? 0)),
    };
    return { result: page };
  },
};

export const ATTENTION_HANDLERS: PublicActionHandler[] = [attentionList];
