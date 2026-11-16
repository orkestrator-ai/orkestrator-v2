import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  isBuildPipeline,
  type BuildPhase,
  type BuildPipeline,
  type BuildPipelineAgent,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { nativeTabLogicalSessionKey } from "@orkestrator/protocol/public-api-resources";
import { createHash } from "node:crypto";
import type { CommandContext } from "./commands-context.js";
import type { NativeAgentJobTabReuse } from "./native-agent-job-tab-reuse.js";
import { nativeTabsOfLayout } from "./public-api/index.js";

const log = createLogger("native-agent");

/** The completion action that marks a tab as the environment's Resolve tab. */
const RESOLVE_COMPLETION_ACTION = "refresh-pr-after-agent-completion" as const;

/**
 * Pipeline phases in which the pipeline no longer drives its sessions. A
 * paused pipeline can resume into the session it stopped in, so it keeps it.
 */
const SETTLED_PIPELINE_PHASES: ReadonlySet<BuildPhase> = new Set<BuildPhase>([
  "complete",
  "failed",
]);

export interface PipelineResolveCandidate {
  pipelineId: string;
  agent: BuildPipelineAgent;
  session: PipelineSession;
}

/**
 * The newest conflict-resolution session a settled build pipeline ran in this
 * environment, or null. Only a session the pipeline has finished with is a
 * candidate: one still running belongs to the pipeline.
 */
export function latestPipelineResolveSession(
  pipelines: readonly BuildPipeline[],
  environmentId: string,
  accepts: (agent: BuildPipelineAgent) => boolean,
): PipelineResolveCandidate | null {
  let latest: (PipelineResolveCandidate & { at: string }) | null = null;
  for (const pipeline of pipelines) {
    if (pipeline.environmentId !== environmentId) continue;
    if (!SETTLED_PIPELINE_PHASES.has(pipeline.phase)) continue;
    for (const session of pipeline.sessions) {
      if (session.phase !== "resolve-conflicts" || session.status === "running") continue;
      if (!session.sdkSessionId?.trim()) continue;
      const agent = session.agent ?? pipeline.agentType;
      if (!accepts(agent)) continue;
      const at = session.completedAt ?? session.startedAt ?? "";
      if (!latest || at >= latest.at) latest = { pipelineId: pipeline.id, agent, session, at };
    }
  }
  if (!latest) return null;
  const { at: _at, ...candidate } = latest;
  return candidate;
}

/** A stable tab per pipeline session, so a retried adoption lands in the same tab. */
export function pipelineResolveTabId(
  environmentId: string,
  candidate: Pick<PipelineResolveCandidate, "pipelineId" | "session">,
): string {
  const digest = createHash("sha256")
    .update(environmentId)
    .update("\0")
    .update(candidate.pipelineId)
    .update("\0")
    .update(candidate.session.sessionKey)
    .digest("hex")
    .slice(0, 24);
  return `agent-job-pipeline-resolve-${digest}`;
}

export interface AdoptPipelineResolveInput {
  environmentId: string;
  agent: AgentPlatform;
  enabledAgents: readonly AgentPlatform[];
  tabReuse: NativeAgentJobTabReuse;
  title: string;
  authorized: () => Promise<boolean>;
}

/**
 * Open the conflict-resolution session a build pipeline already ran as the
 * environment's Resolve tab, when no Resolve tab is open.
 *
 * Auto-merge and the Resolve button send their prompt to the open Resolve tab
 * (`native-agent-job-tab-reuse.ts`) and open a new one only when there is
 * none. A pipeline's own Resolve Conflicts step ran in a session that never
 * had a tab, so without this the next conflict started a second conversation
 * that knew nothing of the first. Adopting the pipeline's provider session
 * under a Resolve tab keeps one conversation: the caller's reuse path then
 * finds this tab and sends the prompt to it.
 *
 * Best effort: answers whether a tab was opened, and any failure (the provider
 * no longer has the session, the environment is out of tabs) leaves the
 * caller to open a new tab as before.
 */
export async function adoptPipelineResolveSessionIntoTab(
  context: CommandContext,
  input: AdoptPipelineResolveInput,
): Promise<string | null> {
  const nativeAgents = context.nativeAgents;
  if (!nativeAgents) return null;
  const open = nativeTabsOfLayout(await context.storage.getPaneLayout(input.environmentId)).filter(
    (tab) => tab.jobCompletionAction === RESOLVE_COMPLETION_ACTION,
  );
  if (open.length > 0) return null;
  const environment = await context.storage.getEnvironment(input.environmentId);
  if (!environment) return null;
  const records = await context.storage.listBuildPipelinesForEnvironment(
    environment.projectId,
    input.environmentId,
  );
  const candidate = latestPipelineResolveSession(
    records.map((record) => record.snapshot).filter(isBuildPipeline),
    input.environmentId,
    (agent) =>
      input.enabledAgents.includes(agent) &&
      (input.tabReuse === "any-agent" || agent === input.agent),
  );
  if (!candidate) return null;
  if (!(await input.authorized())) return null;
  const tabId = pipelineResolveTabId(input.environmentId, candidate);
  const { session, agent } = candidate;
  try {
    const adopted = await nativeAgents.adoptSession({
      environmentId: input.environmentId,
      agent,
      logicalSessionKey: nativeTabLogicalSessionKey(input.environmentId, tabId),
      providerSessionId: session.sdkSessionId,
      origin: "interactive-native",
      title: input.title,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(typeof session.fastMode === "boolean" ? { fastMode: session.fastMode } : {}),
      sessionMode: "build",
    });
    await context.storage.ensureNativeAgentJobTab({
      environmentId: input.environmentId,
      tabId,
      agent,
      providerSessionId: adopted.providerSessionId,
      title: input.title,
      activate: false,
      completionAction: RESOLVE_COMPLETION_ACTION,
    });
    return tabId;
  } catch (error) {
    log.warn("job.pipeline-resolve-adoption-failed", {
      environmentId: input.environmentId,
      error: formatLogError(error, { message: false }),
    });
    return null;
  }
}
