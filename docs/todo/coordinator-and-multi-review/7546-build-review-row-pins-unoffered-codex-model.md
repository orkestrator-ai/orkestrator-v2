# A Build's saved review row pins a Codex model the login refuses

Found by the live coordinator suite's `routing` scenario
([7545](7545-coordinator-routing-live-scenario.md)) on 2026-11-08: on a
ChatGPT-backed Codex login, a Build started from saved defaults ran its
build stage and then failed its review stage.

## Task analysis

Analysed 2026-11-08 against `main` at `30bce6895`.

### Tasks

1. **Confirm where the review row's model comes from**: reproduce on a disposable profile and name the code path. Status: open.
2. **Stop pinning an inherited default into Build rows**: so Build stages get the same unoffered-default swap new sessions get. Status: open (depends on 1).

### 1. Confirm where the review row's model comes from

**Problem.** Two Builds started by a Codex coordinator with no
`agentType`, `steps` or `reviewers` failed with "The review session failed:
The 'gpt-5.4' model is not supported when using Codex with a ChatGPT
account." Their build stage on the same login succeeded. This fails every
Codex Build that uses saved defaults on a ChatGPT login, and is why the
`routing` scenario's `delivery` case cannot pass on Codex.

**Context.** The run was profile `qa-coordinator-codex-b8dab28b`
(`dev:test --fixture --credential-source codex --agent-platforms codex`),
Codex 0.167.0, with saved defaults `defaultAgent: "codex"`,
`multiReview.reviewerCount: 1` and no Codex model set by the harness. New
sessions swap a default the login does not offer for the live list's first
model, but an explicit or pinned model is never swapped
([0004](../agent-engines/0004-composer-model-parameters.md), "The shown and
the run model must be the same"). `buildPipelineInputWithDefaults`
(`apps/backend/src/core/coordinator-launch-defaults.ts`) gives the build step
only `{ agent }`, which is why that stage was swapped and ran. Review rows
come from `buildPipelineConfiguredDefaults`
(`packages/protocol/src/build-pipeline-defaults.ts`), whose `actionSelection`
pins `action.model ?? platform.model`. With the platform model at the shipped
`DEFAULT_CODEX_MODEL_ID` (`gpt-5.4`, `packages/protocol/src/codex-model-catalog.ts`),
that pins `gpt-5.4` into the review row as if the user had chosen it.

**Investigation.** Read from the code and the run's Playwright trace (the
failed pipelines' `error` and `failureContext`). Not yet reproduced on its own:
which tier held `gpt-5.4` (a persisted `agentSettings.platforms.codex.model`
or the resolver's built-in default) was not read before the profile was
reset. Steps: start
`mise run dev:test --profile build-review-model --fixture --credential-source codex --agent-platforms codex`,
read `get_config`'s `agentSettings`, start a Build from the Build button on a
fixture ticket, and read `get_build_pipeline`'s `reviewers` and `steps.review`.

**Decisions.**

- **How to confirm it?**
  - **A disposable profile and a Build from the button (recommended).**
    - Pros: the same path every user takes; one billed build stage.
    - Cons: needs a ChatGPT Codex login.
  - **A unit test of `buildPipelineConfiguredDefaults` with the shipped default.**
    - Pros: free and repeatable.
    - Cons: shows the pin, not that the stage then fails.

### 2. Stop pinning an inherited default into Build rows

**Problem.** A row pinned from an inherited setting is treated as the user's
explicit choice, so it skips the unoffered-default swap.

**Context.** [0172](0172-multi-review-defaults-ignore-pi-saved-model.md)
fixed the same class for Pi Multi Review rows, where `concreteRow` leaves a
row `default` when no saved model applies.

**Investigation.** Not started; depends on 1.

**Decisions.**

- **Where to fix it?**
  - **Carry an inherited model as a default, not a pin, so the stage's session applies the swap (recommended).**
    - Pros: one rule for every stage; the settings keep the user's choice, as 0004 requires.
    - Cons: the row shown in the Build dialog must then say the model may be substituted.
  - **Resolve rows against the login's live catalogue at launch.**
    - Pros: the pipeline record names the model that runs.
    - Cons: a launch-time catalogue read for every Build, and a second copy of the swap rule.

## Related

- [7545-coordinator-routing-live-scenario.md](7545-coordinator-routing-live-scenario.md), where it was found.
- [0004-composer-model-parameters.md](../agent-engines/0004-composer-model-parameters.md), the swap rule.
- [0172-multi-review-defaults-ignore-pi-saved-model.md](0172-multi-review-defaults-ignore-pi-saved-model.md), the same class on Pi.
