# A Build's saved review row pins a Codex model the login refuses

Found by the live coordinator suite's `routing` scenario
([7545](7545-coordinator-routing-live-scenario.md)) on 2026-11-08: on a
ChatGPT-backed Codex login, a Build started from saved defaults ran its
build stage and then failed its review stage.

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b` (first analysed 2026-11-08
at `30bce6895`).

### Tasks

1. **Confirm where the review row's model comes from**: reproduce on a disposable profile and name the code path. Status: open. The code path and the tier are confirmed and the failure is reproduced in a service test against a ChatGPT-shaped catalogue (2026-11-10); what remains is one live Build on a real ChatGPT Codex login, which this node may not use.
2. **Stop pinning an inherited default into Build rows**: so Build stages get the same unoffered-default swap new sessions get. Status: done (2026-11-10).

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
failed pipelines' `error` and `failureContext`), then confirmed in code and a
service test on 2026-11-10.

- **The tier.** A persisted `agentSettings.platforms.codex.model`. The
  resolver has no built-in model default: `resolveAgentPlatformSettings`
  (`packages/protocol/src/agent-settings.ts`) reads only the environment,
  repository and global tiers. A new profile persists
  `createDefaultAppConfig()` (`packages/protocol/src/app-config-defaults.ts`),
  whose global tier stores `codex.model: DEFAULT_CODEX_MODEL_ID`. At the run's
  commit (`30bce6895`, 2026-11-08) that constant was `gpt-5.4`; `dc5103629`
  (2026-11-09) moved it to `gpt-6.1-sol`. The routing harness
  (`routingAgentSettings` → `statusReviewAgentSettings` in
  `apps/desktop/scripts/dev/`) keeps the stored `platforms` and sets only
  `defaultAgent` and `multiReview.reviewerCount`. So the stored global tier
  held `gpt-5.4`. Installs created before `dc5103629` still store it, and any
  stored default a login later stops offering hits the same path.
- **The code path.** `start_build_pipeline` with no rows →
  `buildPipelineInputWithDefaults`
  (`apps/backend/src/core/coordinator-launch-defaults.ts`) →
  `buildPipelineConfiguredDefaults`
  (`packages/protocol/src/build-pipeline-defaults.ts`), whose `actionSelection`
  set `model: action.model ?? platform.model` on review, address, verify, PR
  and resolve rows (and `configuredReviewer` did the same for additional
  reviewers). The build step got only `{ agent }`. At stage start
  `BuildPipelineAgents.resolveSelection`
  (`apps/backend/src/core/build-pipeline-service-agents.ts`) applies the
  unoffered-default swap only when the step has no model, so the build stage
  swapped and the review stage ran the pinned `gpt-5.4`.
- **Reproduced without a login.**
  `apps/backend/src/core/build-pipeline-service-saved-defaults-model.test.ts`
  saves the run's defaults (Codex, one reviewer, `codex.model: gpt-5.4`),
  launches through `buildPipelineInputWithDefaults` and answers
  `resolveDefaultModel` from a ChatGPT-shaped `model/list` that lacks
  `gpt-5.4`. Against the old resolver it fails with the review session on
  `gpt-5.4` while the build session runs `gpt-6.1-sol`, the live run's
  pattern.
- **Still open.** One live Build on a real ChatGPT Codex login. Steps: start
  `mise run dev:test --profile build-review-model --fixture --credential-source codex --agent-platforms codex`,
  set the global `codex.model` to `gpt-5.4` (what pre-`dc5103629` installs
  store), start a Build from saved defaults (a coordinator
  `start_build_pipeline` with no rows, or `orkestrator build launch` without
  `--reviewer`), and read `get_build_pipeline`: `steps.review` should carry no
  model and the review session should run the live list's first model with a
  `modelSubstitution`. Not run on 2026-11-10: the node this was built on may
  not use real provider logins or billed turns. The `routing` scenario's
  `delivery` case on Codex ([7545](7545-coordinator-routing-live-scenario.md))
  exercises the same path and would also serve as evidence.

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

**Investigation.** Done 2026-11-10 with the recommended option.
`buildPipelineConfiguredDefaults` now pins only a model the action (or saved
additional reviewer) names itself (`ownModel`); a model inherited from the
platform setting is left out, so the stage resolves it from the same tiers and
`resolveSelection` applies the swap, as it already did for the build step.
Effort and speed still travel with the row: the stage resolves the same values
when they are absent, so pinning them changes nothing at run time. Every
saved-defaults launcher goes through this one resolver: the coordinator,
`build.launch`, `launch_build_pipeline` and the older-backend compatibility
path in the renderer.

The renderer panels that read these rows were checked:

- The Build dialog (`BuildLaunchDialog.tsx`) opens a row without a model on the
  platform's preferred model through `firstModelFor`, the way it already
  opened the build row. A stored model the renderer catalogue does not list now
  resolves to that catalogue's session default instead of being submitted raw.
  The dialog still submits every row explicitly, so a model the user leaves
  selected there is a pick and is never swapped (0004).
- `configuredOpenCodeModelIds` takes the inherited OpenCode model, so the Build
  dialog keeps it visible while the project catalogue loads.
- The New Environment dialog's feature panel resolves rows with no preferred
  fallback, so it reads `buildPipelineLauncherDefaults`, which fills the
  inherited platform model back in for display only.

The con named under Decisions (the dialog must say the model may be
substituted) did not apply: the dialog shows a concrete catalogue row and
submits it as a pick, and the substitution notice is already shown on the
stage session (`modelSubstitution`) for launches that leave rows out.

Tests: `build-pipeline-service-saved-defaults-model.test.ts` (the review,
verify and PR stages run the offered model with a substitution and settings
keep `gpt-5.4`; a model the review action names stays pinned and unswapped),
and `apps/web/src/lib/build-launch-options.test.ts` (inherited models stay
unpinned on every row; own models kept; launcher panels fill the platform
model; OpenCode ids keep the inherited model). `public-api-builds.test.ts`
now expects the saved preparation row to carry no inherited model.

**Decisions.**

- **Where to fix it?**
  - **Carry an inherited model as a default, not a pin, so the stage's session applies the swap (recommended).**
    - Pros: one rule for every stage; the settings keep the user's choice, as 0004 requires.
    - Cons: the row shown in the Build dialog must then say the model may be substituted.
  - **Resolve rows against the login's live catalogue at launch.**
    - Pros: the pipeline record names the model that runs.
    - Cons: a launch-time catalogue read for every Build, and a second copy of the swap rule.

## Assumptions and decisions

### Task 1: confirming without a ChatGPT login

The recommended confirmation needs a ChatGPT Codex login and a billed build
stage, which the node this ran on may not use. Chosen instead: name the tier and
the path from the code and the run's commit, and reproduce the failure in a
service test that runs the shared launch path against a ChatGPT-shaped
`model/list`. That shows the stage running the pinned model, which the unit
test the Decisions list offered would not. The live Build stays open in task 1
rather than being claimed.

### Task 2: which values stop being pinned

Only the model. Effort and speed inherited from the platform still travel with
the row, because the stage resolves the same values when they are absent and
leaving them keeps the pipeline record and the dialogs unchanged. A model an
action or additional reviewer names itself stays pinned, so a wrong explicit
choice still fails loudly as 0004 requires. The rule applies to every platform,
not only Codex: for Claude, Cursor, Grok and Pi the stage resolves the same
inherited model from its connection defaults, so nothing changes at run time,
and one rule keeps the launch shape the same for all of them.

### Task 2: renderer display

The shared resolver now returns rows without an inherited model, and the one
panel that could not fall back on its own (the New Environment feature panel)
reads `buildPipelineLauncherDefaults`, which fills the model in for display. A
second resolver shape for the renderer was not added: the Build dialog already
opens rows on the platform's preferred model, as it does the build row.

## Related

- [7545-coordinator-routing-live-scenario.md](7545-coordinator-routing-live-scenario.md), where it was found.
- [0004-composer-model-parameters.md](../agent-engines/0004-composer-model-parameters.md), the swap rule.
- [0172-multi-review-defaults-ignore-pi-saved-model.md](0172-multi-review-defaults-ignore-pi-saved-model.md), the same class on Pi.
