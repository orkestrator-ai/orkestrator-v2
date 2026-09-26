import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  nativeTabLogicalSessionKey,
  type PublicSessionActivity,
  type PublicSessionSummary,
} from "@orkestrator/protocol/public-api-resources";
import type { Environment, PersistedNativeAgentSession } from "../models.js";
import { nativeAgentSessionStorageKey } from "../native-agent-service-shared.js";
import { PublicActionError } from "./errors.js";
import { nativeTabsOfLayout, publicSessionSummary, type NativeTabInfo } from "./summaries.js";
import type { PublicActionContext } from "./types.js";

/**
 * Public session handles resolve to one native tab of one environment. The
 * backend resolves them from the persisted pane layout — never from whichever
 * tab a desktop happens to show — and a session whose tab no longer exists is
 * `not-found`, never silently replaced by a new conversation.
 *
 * Everything here is metadata-only: in-memory activity observations and the
 * last cached projection. Nothing hydrates a transcript, touches a bridge's
 * liveness routes, or re-attaches an idle provider session.
 */

export interface ResolvedSession {
  sessionId: string;
  environment: Environment;
  tab: NativeTabInfo;
  agent: AgentPlatform;
  logicalSessionKey: string;
  storageKey: string;
  record: PersistedNativeAgentSession | null;
}

export async function resolveSession(
  context: PublicActionContext,
  target: { sessionId: string; environmentId: string; tabId: string },
): Promise<ResolvedSession> {
  const storage = context.command.storage;
  const environment = await storage.getEnvironment(target.environmentId);
  if (!environment)
    throw new PublicActionError("not-found", "The session's environment no longer exists");
  const layout = await storage.getPaneLayout(target.environmentId);
  const tab = nativeTabsOfLayout(layout).find((candidate) => candidate.tabId === target.tabId);
  if (!tab)
    throw new PublicActionError("not-found", "The session no longer exists (its tab was closed)");
  const logicalSessionKey = nativeTabLogicalSessionKey(target.environmentId, target.tabId);
  const storageKey = nativeAgentSessionStorageKey(
    target.environmentId,
    tab.agent,
    logicalSessionKey,
  );
  const record = await storage.getNativeAgentSession(storageKey);
  return {
    sessionId: target.sessionId,
    environment,
    tab,
    agent: tab.agent,
    logicalSessionKey,
    storageKey,
    record: record && record.environmentId === target.environmentId ? record : null,
  };
}

export function sessionActivity(
  context: PublicActionContext,
  session: {
    environmentId: string;
    agent: AgentPlatform;
    logicalSessionKey: string;
  },
): PublicSessionActivity {
  const native = context.command.nativeAgents;
  if (!native) return "unknown";
  return native.sessionTurnActivitySnapshot(
    session.environmentId,
    session.agent,
    session.logicalSessionKey,
  );
}

function cachedInteractionCount(
  context: PublicActionContext,
  environmentId: string,
  agent: AgentPlatform,
  logicalSessionKey: string,
): number | null {
  const projection = context.command.nativeAgents?.cachedProjectionSnapshot(
    environmentId,
    agent,
    logicalSessionKey,
  );
  if (!projection) return null;
  return projection.interactions.filter(
    (interaction) => interaction.state === "pending" || interaction.state === "answering",
  ).length;
}

export async function loadSessionSummary(
  context: PublicActionContext,
  target: { sessionId: string; environmentId: string; tabId: string },
): Promise<PublicSessionSummary> {
  const session = await resolveSession(context, target);
  return publicSessionSummary(
    session.environment.id,
    session.tab,
    session.record,
    sessionActivity(context, {
      environmentId: session.environment.id,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
    }),
    cachedInteractionCount(
      context,
      session.environment.id,
      session.agent,
      session.logicalSessionKey,
    ),
  );
}

export async function listSessionSummaries(
  context: PublicActionContext,
  environmentId: string,
): Promise<PublicSessionSummary[]> {
  const storage = context.command.storage;
  const tabs = nativeTabsOfLayout(await storage.getPaneLayout(environmentId));
  const summaries: PublicSessionSummary[] = [];
  for (const tab of tabs) {
    const logicalSessionKey = nativeTabLogicalSessionKey(environmentId, tab.tabId);
    const record = await storage.getNativeAgentSession(
      nativeAgentSessionStorageKey(environmentId, tab.agent, logicalSessionKey),
    );
    summaries.push(
      publicSessionSummary(
        environmentId,
        tab,
        record && record.environmentId === environmentId ? record : null,
        sessionActivity(context, { environmentId, agent: tab.agent, logicalSessionKey }),
        cachedInteractionCount(context, environmentId, tab.agent, logicalSessionKey),
      ),
    );
  }
  return summaries;
}
