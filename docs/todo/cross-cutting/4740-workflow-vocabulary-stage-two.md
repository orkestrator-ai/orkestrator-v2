# Finish the Rework and Address Findings rename in stored and transmitted names

## Task analysis

Analysed 2026-11-04 against `main` at `67db62362`.

### Tasks

1. **Flip stored and transmitted values and fields to the new names**: backend writes the new vocabulary, with a one-way storage migration. Status: blocked (waits on 7568: 4740 task 2).
3. **Rename the public names**: coordinator tools and their fields, CLI wire fields, `submit_fix_result`, graph template names. Status: open (depends on 1).
4. **Give package preparation its own phase**: stop storing the preparation session as phase `fix`. Status: open (depends on 1).
5. **Retire the compatibility paths**: the former names and readers, once nothing needs them. Status: open (depends on 1 and 3).

### 1. Flip stored and transmitted values and fields to the new names

**Problem.** People and agents now read "Rework" and "Address Findings", and internal functions, types and files use those names, but what is stored and sent between versions still says `fix`, `fixing`, `address`, `addressing`, `fixModel`, `fixSession`, `autoFix` and so on. Code that handles those values therefore still reads in the old words.

**Context.** `packages/protocol/src/workflow-vocabulary.ts` holds the complete map of new name to current name, one map per workflow, because "fix" is Rework in a build pipeline and Address Findings in a Multi Review. Stage-one builds run it wherever a snapshot or start request enters the build: the renderer's stores and hydration (`buildPipelineStore.ts`, `build-pipeline-persistence.ts`, `multiReviewStore.ts`, `multi-review-persistence.ts`) and the backend's start commands (`commands-registry-build.ts`, `build-pipeline-launch.ts`, `commands-registry-reviews.ts`, `commands-registry-controller-workflows.ts`). `normalizeActionDefaults` reads a saved `addressFindings` key as `fixReviewIssues`.

**Investigation.** An older renderer throws "Invalid backend build pipeline snapshot" on an unknown phase (`isBuildPipeline`, `buildPipelineStore.ts`), and `isMultiReviewWorkflow` also refuses unknown fields through `hasOnlyKeys`, so writing old and new fields side by side breaks an older Multi Review reader too. There is no version handshake (`version-compatibility.md`), so a backend cannot choose a vocabulary per client. Session keys embed the phase (`build-pipeline-service-supervisor.ts`, `multi-review-service.ts`), transcript paths are a hash of the session key, and worker mail tab ids derive from it: rewriting a stored key would orphan its transcripts.

**Decisions.**

- **How to change what is stored?**
  - **One-way migration with a schema bump (recommended).** Add a migration in `storage-record-upgrades.ts` that rewrites `build-pipelines` and `multi-reviews`.
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
  - **Send only the new names once task 2 is confirmed (recommended).**
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
  - **Accept both for one support window, documenting only the new ones (recommended).**
    - Pros: scripts and saved templates keep working; running agents are not stranded.
    - Cons: two names to carry for a while.
  - **Replace them outright.**
    - Pros: nothing left to retire.
    - Cons: breaks saved templates, scripts and in-flight sessions.

### 4. Give package preparation its own phase

**Problem.** The review-package preparation session is stored as `phase: "fix"` and the pipeline as `"fixing"` while it runs (`build-pipeline-stages.ts`, `startReviewPackagePreparation` in `build-pipeline-service-supervisor.ts`), though it is not Rework. A plain rename would mislabel it.

**Context.** The vocabulary map already reserves `package-preparation` and `preparing-package` so stage-one builds read them. Code that tells it apart today uses `REVIEW_PACKAGE_SESSION_LABEL`.

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

**Problem.** Stage one's readers, the CLI's former flags and `MULTI_REVIEW_FORMER_FIX_TAB_TITLE` exist only for the transition.

**Context.** The register in `docs/architecture/version-compatibility.md` carries the row and its condition.

**Investigation.** Stored transcripts keep old prompt text. `MULTI_REVIEW_CONSOLIDATION_PROMPT_PREFIX` ("You are the consolidation and fix model…") and the custom instructions prefix are matched against stored prompts, so they were deliberately left unchanged; changing them needs the old text kept as a second match. Tabs in restored layouts can hold the former title indefinitely.

**Decisions.**

- **When do the readers go?**
  - **When the floor is at or above the first Stable with the flip (recommended).**
    - Pros: follows the standing rule in `version-compatibility.md`.
    - Cons: dead-looking code in the meantime.
  - **With the flip itself.**
    - Pros: removes it at once.
    - Cons: a stage-two client talking to a stage-one backend has no path, which breaks the hosted client's rule.

## Current state

Stage one is in: visible text, agent prompts, internal functions, types and files, and readers for the new vocabulary. No build writes the new stored names yet.

## Constraints and rationale

- `version-compatibility.md`: a persisted format changes additively with a recorded downgrade behaviour. The user approved an exception to the window's timing for task 1; the downgrade fence still applies.
- `apps/backend/src/core/storage-record-upgrades.ts`: an older shape is upgraded once by a migration.
- "fix" must not be replaced globally. It means Rework in a pipeline and Address Findings in a Multi Review, and `fix-result`, `fixModel` and `fixer` all mean Address Findings.

## Needs verification

- Whether stored graph runs reference node ids (task 3).
- Whether round 1 package preparation reports `fixing` in a real run (task 4).

## Related

- [`docs/architecture/version-compatibility.md`](../../architecture/version-compatibility.md)
- [`docs/architecture/build-pipeline-view.md`](../../architecture/build-pipeline-view.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 2, confirming every machine and client runs a stage-one build) moved there on 2026-11-10.
