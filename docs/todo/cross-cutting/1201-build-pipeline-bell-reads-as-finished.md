# A failed build pipeline announces "completed its work"

Found on 2026-11-01 while finishing
[1060](1060-non-native-activity-bell-reads-as-finished.md) task 1.

## Task analysis

Analysed 2026-11-01 against `main` at `0658de64`, from reading the code; nothing here was reproduced. Re-checked and implemented 2026-11-02 against `main` at `38d55ee1`: nothing had changed, and the bug was reproduced by the new tests against the old code (13 of them fail there).

### Tasks

1. **Say what a pipeline's end rings**: Status: done (2026-11-02). A failure rings `agent_failed`; a cancel, a pause (asked for or taken by the supervisor), a stall and a deletion ring nothing; a completion still rings `agent_finished`. A pipeline that stalls and then ends without moving again rings its real end once. Not watched live (see Needs verification).

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

## Assumptions and decisions

Made 2026-11-02 against `main` at `38d55ee1`. `BuildPipelineActivity.syncEnvironment` still wrote the `build-pipeline` source with the storage default, `observePipeline` still kept only `working`, and a stall still read as not working.

### Task 1: what a pipeline's end rings

- **Chose:** the recommended option. `observePipeline` now keeps how each pipeline ended (`buildPipelineEnd`), and the `working -> idle` write passes `completionOutcome` from `buildPipelineCompletionOutcome`, the same option Multi Review and graph runs use since [1060](1060-non-native-activity-bell-reads-as-finished.md).
- **Why:** one rule on every workflow surface, with an option and toast copy that already exist.

### Task 1: which phases count as what

The supervisor has no `cancelled` phase, so the classification is:

| Pipeline | Counts as | Rings |
| --- | --- | --- |
| `complete` | A completion | `agent_finished` |
| `failed` with an error | A failure | `agent_failed` |
| `failed` from cancel (`Build cancelled…`, no `failureContext`) | A stop someone asked for | Nothing |
| `paused`, `pauseCause: "requested"` | A stop someone asked for | Nothing |
| `paused`, `pauseCause: "supervisor"` | Not an end | Nothing |
| Active with `stallWarning` | Not an end | Nothing |
| Deleted while working | Not an end | Nothing |

- **Cancel:** cancel ends in `failed` and is told apart by its error text, the rule the pipeline graph already used. It moved to the protocol as `isCancelledBuildPipeline` with a `BUILD_CANCELLED_ERROR` constant, which `cancel()` now writes, so the web and the backend share one rule and the text cannot drift. Alternative considered: a new `cancelled` phase or field. Pros: no string matching. Cons: a persisted schema change and a record upgrade for every reader; rejected for this task.
- **A requested pause:** nothing, as 1060 decided for Multi Review: someone asked for it, and nothing completed.
- **A supervisor pause** (an unchanged Fix): nothing as well, because the ticket asks that a paused pipeline ring nothing. Alternative considered: `agent_waiting` ("needs your input"), which would be honest, since the pause needs a decision. Cons: this source writes only `working` and `idle`, so it would need a separate attention write, and the coordinator's status wake already reports this pause as needing a decision. Left as an open question below.
- **Deletion:** nothing; someone deleted it.

### Task 1: how a stall counts

- **Chose:** a stall is not an end. The source still goes `idle` on a stall, because `isWorkingBuildPipeline` is shared with the renderer's sidebar overlay and changing what the sidebar shows is outside this task, but that edge rings nothing (`completionOutcome: "none"`).
- **The stalled pipeline's real end:** if the transcript moves again, the stall clears, the source goes back to `working`, and the later end rings on its edge as usual. If the pipeline ends while still stalled (a long silent last turn, then `complete` or `failed` in the same observation), the source is already `idle` and has no edge left. That end rings once through `recordEnvironmentSessionCompletion`, keyed `build-pipeline:<id>:<revision>`, so a repeated observation or reconcile does not ring again. A cancel or pause after a stall still rings nothing.
- **Alternatives considered:** keeping a stalled pipeline `working` in the source (pros: the edge stays; cons: the sidebar would disagree with the renderer's overlay and the deliberate stall display); ringing `agent_waiting` on a stall (cons: wrong copy, a stall needs no input); ringing nothing at the end too (cons: a stalled-then-finished pipeline would never be announced).
- **Limit:** this memory is in-process. A pipeline that stalls, the backend restarts, and it then ends while still stalled rings nothing. Two backends sharing a data directory could each ring that one end once, because they may see different record revisions.

### Task 1: which pipelines decide an edge

- **Chose:** the ends this process watched happen while the source was working (a pipeline previously seen working or stalled, now ended), plus any pipeline in the environment whose ending phase was entered since the source went `working` (`observedAt`). Any failure wins, then any completion; otherwise nothing rings.
- **Why both:** the watched ends cover a pipeline that ends between the read that saw it working and the activity write that went `working`, which the timestamps would miss. The store window is the recovery path after a restart and for a pipeline another backend drove. The window also keeps an old pipeline that ended before this working period from colouring it. A pipeline that ends while a sibling keeps the source working is held until the source's own edge, as graph runs do, so its failure is not lost.
- **Resumed after ending:** a pipeline that becomes active again drops its earlier end; someone resumed it.

### Task 1: review repairs (2026-11-02)

- **Unread failure precedence:** preserve an unread `agent_failed` when a success is recorded through `recordEnvironmentSessionCompletion`, inside the environment mutation lease. This retains durable keys and makes mixed stalled endings independent of order. An observer-side read would race other writers.
- **Recovery evidence:** persist `activityEndedAt` on entry into complete, failed or paused. Same-phase metadata saves retain it, and becoming active clears it. Existing records acquire their previous `updatedAt` on the first same-phase save; untouched legacy records still use their last saved timestamp. This avoids treating completion-comment retries as new ends even after a restart. An in-memory exclusion alone would lose that protection after restart.
- **Coverage:** real-storage regressions cover unread failures, both mixed stalled-ending orders, and old completed/failed metadata saves during a later cancellation, with and without observer restart.

### Task 1: whether pipelines already raise their own notice

- **Found:** no, as 1060 found for Multi Review. The web's pipeline toasts answer a person's own action, and `coordinator-status-wakes.ts` tells only a coordinator that owns the pipeline. The bell stays the only signal for someone away from the tab.

## Open questions

- Should a supervisor pause (an unchanged Fix, which needs a decision) ring `agent_waiting` rather than nothing? It is the one pipeline stop that nobody asked for.

## Needs verification

- A real failed, cancelled and completed pipeline in a disposable `dev:test` profile, watching the toast. The tests use the real `BuildPipelineActivity` and `StorageService` with hand-written pipeline records, not a running supervisor.

## Related

- [1060-non-native-activity-bell-reads-as-finished.md](1060-non-native-activity-bell-reads-as-finished.md)
