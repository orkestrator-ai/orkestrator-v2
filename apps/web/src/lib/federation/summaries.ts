/**
 * Summary shapes the multi-machine views render. They are the command
 * node's node-qualified projections (`@orkestrator/protocol/node-summaries`);
 * this realm's own machine is projected into the same shapes from its
 * stores (`useBoundMachineView`).
 */

export type {
  AgentActivity,
  NodeEnvironmentSummary as FederatedEnvironment,
  NodeProjectSummary as FederatedProject,
  SummaryFreshness,
} from "@orkestrator/protocol/node-summaries";
export { boundedText, repositoryHint } from "@orkestrator/protocol/node-summaries";
