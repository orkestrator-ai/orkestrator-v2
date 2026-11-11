import { randomUUID } from "node:crypto";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CoordinatorResearchMcpServer } from "@orkestrator/protocol/coordinator-web-research";
import {
  describeDigestChanges,
  fixtureTreeDigest,
  type CoordinatorLivePlatformSummary,
} from "./coordinator-live.js";
import { settleCoordinatorTurn } from "./coordinator-live-observer.js";
import {
  evaluateResearchScenario,
  RESEARCH_SCENARIO_SERVER,
  researchScenarioPrompt,
} from "./coordinator-live-research.js";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type SessionIdentity = { environmentId: string; agent: AgentPlatform; logicalSessionKey: string };

/**
 * The research scenario's backend orchestration, shared by the live spec and
 * the credential-free test that scripts the command transport. See
 * `coordinator-live-research.ts` for what it qualifies.
 *
 * The caller has already applied `RESEARCH_SCENARIO_SETTINGS` before the
 * coordinator's agent started, since a bridge reads the research setting at
 * launch. One build-mode turn, settled with nothing answered on the agent's
 * behalf, then judged from the transcript rows and the checkout digest.
 */
export async function runResearchScenario(input: {
  invoke: Invoke;
  identity: SessionIdentity;
  checkout: string;
  summary: CoordinatorLivePlatformSummary;
  servers?: readonly CoordinatorResearchMcpServer[];
  timeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const { invoke, identity, checkout, summary } = input;
  const servers = input.servers ?? [RESEARCH_SCENARIO_SERVER];
  const before = await fixtureTreeDigest(checkout);
  summary.tree = { before: before.digest };
  // Build mode, as every case: plan mode is not where a coordinator's
  // research tools differ, and the composer default should not decide it.
  await invoke("dispatch_native_agent_intent", {
    ...identity,
    prompt: researchScenarioPrompt(servers[0]?.name),
    requestId: randomUUID(),
    mode: "build",
  });
  const { projection, escaped } = await settleCoordinatorTurn(invoke, identity, summary, {
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
  });
  const after = await fixtureTreeDigest(checkout);
  const changes = describeDigestChanges(before, after);
  summary.tree = { before: before.digest, after: after.digest, changes };
  summary.turn = {
    phase: projection.turn.phase,
    ...(projection.turn.error ? { error: projection.turn.error.slice(0, 500) } : {}),
  };
  if (escaped.length > 0) summary.escapedInteractions = escaped;
  const verdict = evaluateResearchScenario({
    platform: identity.agent,
    messages: projection.messages,
    servers,
    turnPhase: projection.turn.phase,
    ...(projection.turn.error ? { turnError: projection.turn.error } : {}),
    checkoutChanges: changes,
    escapedInteractions: escaped,
  });
  summary.toolCalls = verdict.calls.map(({ name, state }) => ({ name, state }));
  return { ...verdict, projection };
}
