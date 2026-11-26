# Finish the Rework and Address Findings rename in stored and transmitted names

## Task analysis

Analysed 2026-11-04 against `main` at `67db62362`.
Updated 2026-11-14 for the user's legacy-retirement decision.
Updated 2026-11-17 against `main` at `0265e7882`: task 1 done.
Updated 2026-11-18 against `main` at `b2c91abb9`: tasks 3, 4 and 5 done; task 6 added.
Updated 2026-11-26 against `main` at `f80c75e10`: task 6 no longer waits; 8304 (retired) settled the contract tooling.

### Tasks

1. **Flip stored and transmitted values and fields to the new names**: backend writes the new vocabulary, with a one-way storage migration. Status: done (2026-11-17; storage migration version 11, see Assumptions and decisions).
3. **Rename the public names**: coordinator tools and their fields, CLI wire fields, `submit_fix_result`, graph template names. Status: done (2026-11-18; storage migrations 13 and 14).
4. **Give package preparation its own phase**: stop storing the preparation session as phase `rework`. Status: done (2026-11-18; storage migration 12).
5. **Retire the compatibility paths**: the former names and readers, once nothing needs them. Status: done (2026-11-18; what stays reads stored user state, see Assumptions and decisions).
6. **Rename the two coordinator backend commands**: `open_coordinator_multi_review_fix` and `custom_fix_coordinator_multi_review_action`. Status: open.

### 1. Flip stored and transmitted values and fields to the new names

**Problem.** People and agents now read "Rework" and "Address Findings", and internal functions, types and files use those names, but what is stored and sent between versions still says `fix`, `fixing`, `address`, `addressing`, `fixModel`, `fixSession`, `autoFix` and so on. Code that handles those values therefore still reads in the old words.

**Context.** Stage one's `packages/protocol/src/workflow-vocabulary.ts` held the complete map of new name to current name, one map per workflow, because "fix" is Rework in a build pipeline and Address Findings in a Multi Review. Stage-one builds ran it wherever a snapshot or start request entered the build: the renderer's stores and hydration (`buildPipelineStore.ts`, `build-pipeline-persistence.ts`, `multiReviewStore.ts`, `multi-review-persistence.ts`) and the backend's start commands (`commands/registry-build.ts`, `build-pipeline/launch.ts`, `commands/registry-reviews.ts`, `commands/registry-controller-workflows.ts`). It was deleted with this task (`git show 0265e7882:packages/protocol/src/workflow-vocabulary.ts`); the same maps, read the other way, are now the storage migration `apps/backend/src/core/storage/workflow-vocabulary-upgrade.ts`. `normalizeActionDefaults` reads a saved `addressFindings` key as `fixReviewIssues`.

**Investigation.** An older renderer throws "Invalid backend build pipeline snapshot" on an unknown phase (`isBuildPipeline`, `buildPipelineStore.ts`), and `isMultiReviewWorkflow` also refuses unknown fields through `hasOnlyKeys`, so writing old and new fields side by side breaks an older Multi Review reader too. There is no version handshake (`version-compatibility.md`), so a backend cannot choose a vocabulary per client. Session keys embed the phase (`build-pipeline/service-supervisor.ts`, `review/service.ts`), transcript paths are a hash of the session key, and worker mail tab ids derive from it: rewriting a stored key would orphan its transcripts.

**Decisions.**

- **How to change what is stored?**
  - **One-way migration with a schema bump (recommended).** Add a migration in `storage/record-upgrades.ts` that rewrites `build-pipelines` and `multi-reviews`.
    - Pros: readers carry no legacy branch; a stage-one backend refuses the newer database, which is the documented downgrade fence.
    - Cons: no downgrade after it runs without restoring a backup.
  - **Keep translating at load and save.**
    - Pros: a downgrade keeps working.
    - Cons: the old names stay in the database, which is what this work removes.
- **Session keys already stored?**
  - **Leave them unchanged and use the new phase word only in new keys (recommended).**
    - Pros: existing transcripts and mail tab ids stay reachable.
    - Cons: old keys keep `fix` until those runs age out.
  - **Rewrite them in the migration.**
    - Pros: no old word left.
    - Cons: orphans transcripts unless every hashed path moves with them.
- **What the backend sends to clients still on an older build?**
  - **Send only the new names once task 2 is confirmed (recommended).** Task 2 is answered since 2026-11-14: every machine and client updates together under the user's legacy-retirement decision, so this applies now.
    - Pros: simple; stage-one clients already read them.
    - Cons: a client older than stage one fails to load these snapshots until it updates, which is the accepted cost of flipping before the 60-day window ends.
  - **Wait for the support window (the first Stable with stage one, plus 60 days).**
    - Pros: follows the policy with no exception.
    - Cons: the old names remain for longer. The user chose not to wait.

### 3. Rename the public names

**Problem.** Some names outside stored data still say Fix: coordinator tools (`open_multi_review_fix`, `custom_fix_multi_review`, the fields `fixModel` and `autoFix`), the CLI's wire fields and `surface: "fix"`, the agent tool `submit_fix_result`, the prompt frame `<address-fix-result-json>`, and graph names (role `fixer`, node ids `fix` and `address`, prompts `pipeline-fix`, `fix-review-issues` and `address-review`, the type `fix-result@1`, `defaultsFrom: fixReviewIssues`).

**Context.** Stage one added CLI flags `--address-findings-model`, `--auto-address-findings` and `--address-findings`, which still send the old fields so the CLI keeps working against older backends. `PUBLIC_API_SCHEMA_VERSION` is 1. User-saved graph templates can hold every graph name above.

**Investigation.** A live agent may hold the old tool name from earlier in its conversation. Whether stored graph runs reference node ids was not established and needs checking first.

**Decisions.**

- **How to retire the old public names?**
  - **Accept both for one support window, documenting only the new ones (recommended until 2026-11-14).**
    - Pros: scripts and saved templates keep working; running agents are not stranded.
    - Cons: two names to carry for a while.
  - **Replace them outright (recommended since 2026-11-14, the user's legacy-retirement decision), upgrading saved graph templates once.**
    - Pros: nothing left to retire.
    - Cons: breaks saved templates, scripts and in-flight sessions, unless the stored templates are upgraded (see Assumptions and decisions).

### 4. Give package preparation its own phase

**Problem.** The review-package preparation session is stored as `phase: "rework"` and the pipeline as `"reworking"` while it runs (`build-pipeline/stages.ts`, `startReviewPackagePreparation` in `build-pipeline/service-supervisor.ts`), though it is not Rework. Task 1 kept it there (it was `fix`/`fixing` before), so the label is still the only distinction.

**Context.** Stage one's vocabulary map reserved `package-preparation` and `preparing-package`; that map is gone, so the new values only need adding to `PipelineSessionPhase` and `BuildPhase`, a case in every switch on them, and a second storage migration that moves sessions labelled `REVIEW_PACKAGE_SESSION_LABEL` (and the pipeline phase while one runs) to them. Code that tells it apart today uses `REVIEW_PACKAGE_SESSION_LABEL`.

**Investigation.** Whether round 1 preparation also reports `fixing` was seen in the code path but not traced through a run.

**Decisions.**

- **Which name does preparation use after the flip?**
  - **Its own values, `package-preparation` and `preparing-package` (recommended).**
    - Pros: the label check can go; status text can say what is really happening.
    - Cons: every switch on the phase gains a case.
  - **Keep it under `rework`.**
    - Pros: smaller change.
    - Cons: keeps the same mislabel this work exists to remove.

### 5. Retire the compatibility paths

**Problem.** The CLI's former flags, the saved `addressFindings` action-default read and `MULTI_REVIEW_FORMER_FIX_TAB_TITLE` exist only for the transition. Stage one's snapshot and start-request readers (`workflow-vocabulary.ts`) went with task 1.

**Context.** The register in `docs/architecture/version-compatibility.md` carries the row and its condition.

**Investigation.** Stored transcripts keep old prompt text. `MULTI_REVIEW_CONSOLIDATION_PROMPT_PREFIX` ("You are the consolidation and fix model…") and the custom instructions prefix are matched against stored prompts, so they were deliberately left unchanged; changing them needs the old text kept as a second match. Tabs in restored layouts can hold the former title indefinitely.

**Decisions.**

- **When do the readers go?**
  - **When the floor is at or above the first Stable with the flip (recommended until 2026-11-14).**
    - Pros: follows the standing rule in `version-compatibility.md`.
    - Cons: dead-looking code in the meantime.
  - **With the flip itself (recommended since 2026-11-14, the user's legacy-retirement decision).**
    - Pros: removes it at once.
    - Cons: a stage-two client talking to a stage-one backend has no path, which breaks the hosted client's rule. Under the 2026-11-14 decision no stage-one backend or client stays in use, so this no longer applies.

### 6. Rename the two coordinator backend commands

**Problem.** The coordinator tools are now `open_multi_review_address_findings` and `custom_address_multi_review`, but the backend registry commands behind them keep their former names, `open_coordinator_multi_review_fix` and `custom_fix_coordinator_multi_review_action` (`packages/protocol/src/contract/domains/coordinator/commands-project.ts`). Their arguments already use the new field names (`addressFindingsModel`).

**Context.** Only Orkestrator itself calls these commands: the Control MCP tools in `apps/backend/src/core/control-mcp/review-actions.ts` and node routing in `nodes/node-routing.ts`. A rename is a removal to the contract CI job (`mise run contract:ci`), which fails until the coordinator domain is bumped and a register or Retired row in `docs/architecture/version-compatibility.md` names the removed command.

**Investigation.** Task 3 renamed them first, and `contract:ci` refused both as removed commands in releases v2.21.0 to v2.39.5-beta, asking for a coordinator domain bump (coordinator is version 1). The names were restored, with a comment on each definition. 8304 (retired 2026-11-26) settled it: the contract CI job applies a one-time support floor at v2.39.1-beta, the first release built from the 2026-11-14 sweep, and keeps the 60-day window above it ([version-compatibility.md](../../architecture/version-compatibility.md#the-support-window)). Every release from v2.39.1-beta still registers both names, so a rename still needs the coordinator domain bump, a version-1 adapter and a register row, until the floor passes the last release that registers them.

**Decisions.**

- **How to rename them?**
  - **Wait until the support floor passes the last release that registers the old names, then rename without a bump (recommended).**
    - Pros: no throwaway adapter or register row for two commands no user or script calls by name.
    - Cons: the old word stays in two internal command names until a Stable release past them is 60 days old.
  - **Bump the coordinator domain now, with a version-1 adapter and a register row.**
    - Pros: the names flip at once.
    - Cons: an adapter and a row for two commands no user or script calls by name; the 60-day window still requires them (8304 (retired)'s forward policy).

## Assumptions and decisions

### Task 1: task 2's confirmation is answered by the policy (user decision, 2026-11-14)

The user decided on 2026-11-14 that legacy support retires now across the
repository (one sweep; all machines and clients update together), so the wait
on task 2 (confirming every machine and client runs a stage-one build) no
longer blocks task 1. Task 2 closes: all of the user's machines and clients
update together, which is what the confirmation was to establish. Task 1, the
stored-name flip with its one-way migration, can happen now, and through it
tasks 3 to 5 are agent work. The downgrade fence the migration's schema bump
gives is unchanged.

### Task 1: what the flip covers (2026-11-17)

The flip covers everything the stage-one maps covered: build pipeline and
Multi Review snapshots and their start requests, plus what is sent with them
(step controls, step transcript requests, `get_multi_review_launch_defaults`,
key information authors, which are session phases). It leaves the task 3
names alone, so a coordinator tool's `fixModel`, `autoFix` and `steps.address`
and the CLI's `fixModel`/`autoFix` wire fields are translated to the new
fields where they enter, the coordinator answers (`workflowSummary`,
`reviewSelection`) keep their `fixTabId`/`autoFix`/`fixModel` output names,
and the graph template keeps its `autoFix` parameter and node ids. The saved
`multiReview.autoFix` setting and the `fixReviewIssues` action default are
settings rather than workflow records and keep their names. The CLI's
`review.launch` intent stays in the public names, so a retried request key
still replays rather than conflicting.

### Task 1: one migration, session keys kept (2026-11-17)

Chosen: a one-way migration with a schema bump (version 11,
`storage/workflow-vocabulary-upgrade.ts`), as recommended. It walks
`build-pipelines` and `multi-reviews` snapshots with the stage-one maps read
the other way, renames values only in the fields that hold them (with `step`
and `author` added to stage one's list, for `pendingCodeRewind.step` and key
information), never walks free text or reports, and leaves `sessionKey` and
`addressFindingsSessionKey` as written, so existing transcripts and worker
mail tab ids stay reachable; new build pipeline session keys carry `rework`
because they embed the phase. Multi Review's deterministic key
`multi-review:<id>:fix` and tab id `multi-review-fix:<id>` are unchanged,
because records without a stored key are looked up by them. A record already
holding both names keeps the current one. Tested on a seeded store opened at
version 10 (`storage/workflow-vocabulary-upgrade.test.ts`), never on the real
data directory.

### Task 1: package preparation stays under Rework (2026-11-17)

Task 4 did not fall out of the flip: separating preparation changes how the
supervisor drives the phase, not just its name, so the migration maps every
`fix` session to `rework` and the label still marks preparation. Task 4 now
needs its own values and a second migration keyed on the label.

### Task 3: no support window for the old public names (user decision, 2026-11-14)

The user decided on 2026-11-14 that legacy support retires now across the
repository (one sweep; all machines and clients update together), so the
recommended "accept both for one support window" no longer applies to task 3:
no older CLI, backend or client needs the old coordinator tool names, CLI
wire fields or graph names, and no older-version adapter is kept for them.
User-saved graph templates are stored data, not version skew, so they keep
working through a one-time upgrade of the saved templates (as task 1 does for
stored records) rather than through a dual reader. Whether an agent
conversation already running when the names change needs anything is the
task 3 worker's call; it is not an older-version peer.

### Task 5: the readers go with the flip (user decision, 2026-11-14)

The user decided on 2026-11-14 that legacy support retires now across the
repository (one sweep; all machines and clients update together), so the wait
on the floor reaching the first Stable release with the flip no longer blocks
task 5. Once tasks 1 and 3 land, stage one's peer-facing readers and the
CLI's former flags can go in the same sweep; no older-version adapter is kept.
What stays is what serves stored data rather than older peers: the old
prompt text matched against stored transcripts
(`MULTI_REVIEW_CONSOLIDATION_PROMPT_PREFIX` and the custom instructions
prefix) and the former tab title held by restored layouts
(`MULTI_REVIEW_FORMER_FIX_TAB_TITLE`), unless the worker upgrades that stored
state once instead.

### Task 3: the new public names (2026-11-18)

Chosen names, applied with no dual names or translators: the coordinator tools `open_multi_review_address_findings` (was `open_multi_review_fix`) and `custom_address_multi_review` (was `custom_fix_multi_review`, to pair with `address_multi_review`); the fields `addressFindingsModel` and `autoAddressFindings` (were `fixModel`, `autoFix`) in coordinator tools, the controller and coordinator-node surface commands, the public CLI inputs and the CLI; coordinator answers `addressFindingsTabId`, `automation.autoAddressFindings` and the same names in `reviewSelection`; the Multi Review surface `address-findings` (was `fix`) and controller surface `custom-address` (was `custom-fix`); the build step `address-findings` (was `address`) in `start_build_pipeline`, `build.launch`, `build.get` and the CLI. `launchActionInputFromPublicFields`, `buildStepKeyForPublicStep` and the older-node surface fallback are gone. Graphs and results: the result kind and graph type `address-findings-result` (was `fix-result`), the tool `submit_address_findings_result`, the Verify frame `<address-findings-result-json>`, the role `addresser` (was `fixer`), the prompts `pipeline-rework`, `address-findings` and `pipeline-address-findings` (were `pipeline-fix`, `fix-review-issues`, `address-review`), the parameter `autoAddressFindings`, the action default `addressFindings` (was `fixReviewIssues`), and node ids `rework` and `address-findings` in the built-in Build Pipeline (were `fix`, `address`) and `address-findings` in the built-in Multi Review (was `fix`). Verify's input port is `addressFindings`, because port names cannot hold a hyphen. The saved setting `multiReview.autoFix` keeps its name: it is a settings key, not a workflow name.

### Task 3: stored data is migrated, not read twice (2026-11-18)

Storage migration 13 (`storage/graph-vocabulary-upgrade.ts`) rewrites user graph templates, "Describe a graph" drafts, saved launch defaults, scheduled graph launches, workflow result entries and slots, and graph runs with their artifacts. Graph runs (the to-do's open question): a run freezes its plan behind `plan.digest` and its artifact ids hash type and producer, so a run is rewritten consistently, digests and ids recomputed and every reference following, with each session key pinned to the key it had so transcripts and provider sessions stay attached; a run that would not validate after the rewrite is left as it was. Project templates live in their repositories and are not rewritten. Migration 14 (`storage/coordinator-receipt-vocabulary-upgrade.ts`) renames stored coordinator receipts from `custom-fix` to `custom-address`; without it the coordinators store would drop them on read and a retried pre-rename request would run again. Launch receipts hashed with the former field names now refuse a retry as a different payload, which is the accepted cost of a request key from before the rename. A running agent that still holds `submit_fix_result` from earlier in its conversation is refused once, and the reminder names the new tool.

### Task 3: two backend command names kept (2026-11-18)

The backend commands behind the renamed coordinator tools were renamed too, but `contract:ci` treats a rename as a removal needing a coordinator domain bump. Chosen: keep `open_coordinator_multi_review_fix` and `custom_fix_coordinator_multi_review_action` as registered names (their arguments use the new fields) and leave the rename to task 6, rather than add a version-1 adapter for two commands only Orkestrator calls.

### Task 4: preparation has its own phases (2026-11-18)

The dedicated preparation session is stored as `package-preparation` and the pipeline as `preparing-package` while it or the validation run it planned is in progress, in every round; `REVIEW_PACKAGE_SESSION_LABEL` is display text only and every label check became a phase check. Round 1 did run as `reworking` before (the "Needs verification" item, answered from the code path, not a live run), and a validation restart in round 1 could leave `building`. Restarts of preparation stay `review-package` requests and skips cannot name it; `implementationPhase` now comes from the round. Without a configured preparation step, preparation keeps running under the Address Findings step's settings (`stepKeyForSessionPhase`). Migration 12 (`storage/package-preparation-phase-upgrade.ts`) moves stored sessions and pipeline phase fields, keyed on the label older builds wrote, and leaves session keys, restart and skip requests, rewinds and key information authors as written. Multi Review already had its own `preparing` phase and needed nothing.

### Task 5: what retired and what stays (2026-11-18)

Retired with task 3: the CLI's former flags (`--fix-model`, `--auto-fix`/`--no-auto-fix`, `review open --fix`) and the translators named above. The saved `addressFindings` action-default read is replaced by its reverse: `normalizeActionDefaults` reads a saved `fixReviewIssues` once as `addressFindings` and writes only the new key, and `normalizeWorkflowResultToolsSettings` does the same for a saved `fix-result`. These are config.json's one-way upgrade, because settings have no migration framework. Stays, because it reads stored user state rather than an older peer: those two settings reads, `MULTI_REVIEW_FORMER_FIX_TAB_TITLE` for restored layouts, and the prompt prefixes matched against stored transcripts.

## Current state

Stage one is in: visible text, agent prompts, internal functions, types and files. Since 2026-11-17 (task 1) every build stores and sends only the new names in build pipeline and Multi Review records; since 2026-11-18 (tasks 3 to 5) the coordinator tools and answers, CLI wire fields and flags, graph templates and runs, workflow result kinds and Multi Review tab surfaces use them too, and build pipeline package preparation has its own phases. Storage migrations 11 to 14 rewrote what older builds stored. What still says Fix: the two coordinator backend command names (task 6), the `multiReview.autoFix` setting key, renderer-internal identifiers, and the readers of stored user state listed under task 5.

## Constraints and rationale

- `version-compatibility.md`: a persisted format changes additively with a recorded downgrade behaviour. The user approved an exception to the window's timing for task 1; the downgrade fence still applies. On 2026-11-14 the user's legacy-retirement decision (one sweep; all machines and clients update together) removed the window waits for tasks 1, 3 and 5 as well; see Assumptions and decisions.
- `apps/backend/src/core/storage/record-upgrades.ts`: an older shape is upgraded once by a migration.
- "fix" must not be replaced globally. It means Rework in a pipeline and Address Findings in a Multi Review, and `fix-result`, `fixModel` and `fixer` all mean Address Findings.

## Needs verification

- A live pipeline run showing package preparation as its own phase in rounds 1 and 2 (task 4; checked in code and tests only).
- A real data directory with saved graph templates and in-flight graph runs opening after migration 13 (task 3; checked on seeded stores only).

## Related

- [`docs/architecture/version-compatibility.md`](../../architecture/version-compatibility.md)
- [`docs/architecture/build-pipeline-view.md`](../../architecture/build-pipeline-view.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 2, confirming every machine and client runs a stage-one build) moved there on 2026-11-10; task 2 was answered on 2026-11-14 by the user's legacy-retirement decision, so that item goes.
- 8108 (retired): the 2026-11-14 legacy-retirement sweep.
- 8304 (retired 2026-11-26): the one-time support floor and the forward policy task 6 follows ([version-compatibility.md](../../architecture/version-compatibility.md#the-support-window)).
