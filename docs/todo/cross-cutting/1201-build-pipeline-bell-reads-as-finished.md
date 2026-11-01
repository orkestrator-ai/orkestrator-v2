# A failed build pipeline announces "completed its work"

Found on 2026-11-01 while finishing
[1060](1060-non-native-activity-bell-reads-as-finished.md) task 1.

## Task analysis

Analysed 2026-11-01 against `main` at `0658de64`, from reading the code; nothing here was reproduced.

### Tasks

1. **Say what a pipeline's end rings**: Status: open.

### 1. Say what a pipeline's end rings

**Problem.** A build pipeline that fails, is cancelled or stalls can still read "The agent completed its work."

**Context.** `BuildPipelineActivity.syncEnvironment` (`build-pipeline-activity.ts`) writes the `build-pipeline` source with the storage default, so any aggregate `working -> idle` rings `agent_finished`. `observePipeline` keeps only a `working` boolean. `isWorkingBuildPipeline` is also false once `stallWarning` is set, so a pipeline that has only stalled can ring too. 1060 added `completionOutcome` to `setEnvironmentAgentActivity` for exactly this.

**Investigation.** Read only. Not checked: which pipeline phases count as a failure, a stop someone asked for, or a pause, and whether pipelines raise their own notice when they end in the background. The web's pipeline toasts found so far answer a person's own action.

**Decisions.**

- **What does a pipeline's end ring?**
  - **Keep each pipeline's phase in the observation and pass `completionOutcome`, as Multi Review does (recommended).**
    - Pros: the same rule on every workflow surface, using an option that already exists.
    - Cons: the supervisor's stall and pause phases need classifying first.
  - **Leave it.**
    - Pros: nothing to change.
    - Cons: the toast still says the work completed.

## Related

- [1060-non-native-activity-bell-reads-as-finished.md](1060-non-native-activity-bell-reads-as-finished.md)
