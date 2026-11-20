// The workflows domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// The domain is the machinery the backend-owned workflows (build pipelines,
// Multi Review, graph runs, feature planning, goals and suborks) share: keyed
// supervision (`supervisor.ts`), elapsed-time poll deadlines (`poll-gate.ts`),
// transcript-artifact authority for dispatched turns (`artifact-turns.ts`,
// `transcript-artifacts.ts`), and structured workflow results: the result
// service and its tools (`result-service.ts`, `result-tools.ts`), contracts,
// registry and validators (`result-contracts.ts`, `result-registry.ts`,
// `result-environment-validator.ts`, `result-graph-*.ts`,
// `result-json-text.ts`, `result-final-text.ts`), missing-result prompts
// (`result-missing.ts`), the rollout and its metrics (`result-rollout.ts`,
// `result-metrics.ts`). The review files that use it are in `review/`, and
// the build-pipeline files stay with their own prefix group.
//
// One module is a named exception in `.oxlintrc.json`, not part of this
// surface: `result-final-text.ts`, which `review/consolidation-scope.ts`
// imports directly. `result-contracts.ts` (and with it `result-service.ts`,
// `result-tools.ts` and `result-missing.ts`) reaches
// `review/consolidation-scope.ts`, so routing that file through this one
// would close a runtime import cycle.
export {
  beginArtifactDispatchTurn,
  beginWorkflowArtifactTurn,
  settleArtifactDispatchTurn,
  type ArtifactTurnDispatch,
  type WorkflowArtifactTurnOptions,
} from "./artifact-turns.js";
export { ElapsedPollGate, type PollTrigger } from "./poll-gate.js";
export { gitEnvironmentValidator } from "./result-environment-validator.js";
export {
  graphOutputCombinedSchema,
  graphOutputPortIssues,
  graphOutputSlotInput,
  splitGraphOutputCombined,
  type GraphOutputStructuredPort,
} from "./result-graph-output.js";
export { describeJsonTextFault } from "./result-json-text.js";
export {
  LAST_ASSISTANT_TEXT_READ_LIMIT,
  lastAssistantText,
  missingWorkflowResultMessage,
  workflowRestartContinuationPrompt,
  workflowResultRefusals,
  workflowResultReminderPrompt,
  workflowResumeContinuationPrompt,
  workflowUsageLimitContinuationPrompt,
} from "./result-missing.js";
export { validateRegisteredWorkflowResult } from "./result-registry.js";
export { WorkflowResultRollout } from "./result-rollout.js";
export {
  WorkflowResultService,
  type WorkflowResultAcceptance,
  type WorkflowResultAcceptanceCheck,
  type WorkflowResultAttempt,
  type WorkflowResultReader,
  type WorkflowResultRefusals,
} from "./result-service.js";
export {
  registerWorkflowResultBrokerTools,
  registerWorkflowResultSlotTools,
  registerWorkflowResultTools,
} from "./result-tools.js";
export {
  DEFAULT_WORKFLOW_DISCOVERY_MS,
  KeyedWorkflowSupervisor,
  keyedSchedulingEnabled,
  stableSpreadMs,
  type KeyedWorkflowOwner,
  type KeyedWorkflowServiceOptions,
  type WorkflowDiscoveryResult,
  type WorkflowPass,
  type WorkflowReconcileReport,
  type WorkflowSupervisorStatus,
  type WorkflowWakeReason,
} from "./supervisor.js";
export { WorkflowTranscriptArtifacts, type ArtifactLedgerSource } from "./transcript-artifacts.js";
