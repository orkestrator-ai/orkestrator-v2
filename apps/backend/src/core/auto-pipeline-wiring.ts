/**
 * Builds the {@link AutoPipelineService} and the agent-tool host that reaches it.
 *
 * Two places need the service: the command registry (the Auto-pipeline tab's
 * reads, edits and confirmation) and the agent tools server (the draft an
 * agent submits). They build their own instances over the same persisted
 * records and the same process-local outcomes, which are keyed by storage.
 */
import { AutoPipelineService } from "./auto-pipeline.js";
import type { AutoPipelineToolHost } from "./agent-tools-auto-pipeline.js";
import type { CommandContext } from "./commands-context.js";
import { createPipelineEnvironmentGit } from "./commands-review.js";
import {
  GraphAgentProviders,
  graphAgentBridgeConnection,
  type GraphAgentCommandInvoker,
} from "./graph-agent-providers.js";

export function createAutoPipelineService(
  context: CommandContext,
  invoke: GraphAgentCommandInvoker,
): AutoPipelineService {
  return new AutoPipelineService(context, () => {
    const providers = new GraphAgentProviders({
      connection: (environment, agent) => graphAgentBridgeConnection(invoke, agent, environment),
    });
    return {
      provider: (environment, agent) => providers.get(environment, agent, "auto-pipeline"),
      release: () => providers.shutdown(),
      git: createPipelineEnvironmentGit(context.storage, context.runtime.environments.fence),
    };
  });
}

/** What `convert_to_pipeline` calls: the tab's own agent submits its draft. */
export function autoPipelineToolHost(service: AutoPipelineService): AutoPipelineToolHost {
  return {
    offered: (scope) => service.offered(scope.environmentId, scope.tabId),
    submit: (scope, result) => service.submitDraft(scope.environmentId, scope.tabId, result),
  };
}
