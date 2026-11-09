# Complete the Auto-pipeline launch flow

## Task analysis

Analysed 2026-11-09 against main at `c6de4733c5beb87a578f82a8548725305e1ff254`.

### Tasks

1. Implement durable read-only drafting and typed commands. Status: done.
2. Implement the manual launch and draft-review dialogs. Status: done.
3. Implement confirmed ticket creation and promotion. Status: done.
4. Qualify the complete fake-model flow and document the shipped UI. Status: done.

### 1. Implement durable read-only drafting and typed commands

**Problem.** Before implementation there was no model session that converted finished prompt work into a reviewed ticket and Build handoff.

**Context.** `BuildPipelineService.startFromCompletedBuild` now accepts a backend-owned completed attempt. The manual confirmation command now calls it. Ordinary launch commands do not accept this attempt. The new entry point does not validate native-tab ownership or activity; its future caller must do so authoritatively.

**Investigation.** Reuse saved launch defaults, the native transcript APIs, environment Git and the structured workflow-result transport. Persist the selected tab, branch identity, diff fingerprint, model selection and request identity before dispatch. Bound transcript, diff and result sizes and fail explicitly when input cannot fit. Deny unattended interactions and close owned drafting sessions on cancellation. Use fake providers only.

**Decisions.** A durable drafting workflow (recommended) survives navigation and backend restart, at the cost of an additional persisted record. Renderer-owned async work is smaller but cannot recover a missed result or an ambiguous dispatch. The ticket requires a backend-owned workflow and one separate read-only session.

### 2. Implement the manual launch and draft-review dialogs

**Problem.** The Multi Review button needed an Auto-pipeline option and draft editor.

**Context.** The manual launch dialog and ActionBar now offer the promotion entry point. Coordinator review tools must remain unchanged.

**Investigation.** Offer promotion only on an unlinked prompt environment. Select the active agent tab or present a picker, disable running tabs with a reason, and revalidate on the backend. Provide editable title, structured description and criteria with add/remove/reorder controls; show generated notes read-only and list pending uncommitted paths. Cancel creates nothing. Failure offers retry and plain Multi Review.

**Decisions.** Extend the manual launch UI (recommended): this follows the specified entry point and preserves existing coordinator semantics. Adding promotion to the shared review launch request would reduce command surface but would also expose it to callers explicitly excluded by the ticket.

### 3. Implement confirmed ticket creation and promotion

**Problem.** The requested confirmation command now creates a ticket, commits pending changes and invokes adoption.

**Context.** The internal adoption path persists the original provider session and transcript as round 1, retains its source tab identity and committed baseline, seeds key information, and follows the normal environment configuration and Review preparation paths. Its storage admission excludes a second pipeline in that environment and replays same-intent admission.

**Investigation.** Add an idempotent confirmation journal before mutations. Recheck tab idleness, ownership, environment linkage and the diff shown to the user. Create the in-progress ticket with reviewed criteria, commit the reviewed uncommitted paths, and use the saved Build defaults. Recover each publication boundary without duplicate tickets or commits. Replace the manual review surface with the existing pipeline graph. Confirm sidebar, coordinator reads, PR ownership and the Build inspector use the resulting authoritative pipeline. Prevent conflicting edits from the original tab while the pipeline owns the workspace.

**Decisions.** Adopt via the existing pipeline lifecycle (recommended): normal Review, Rework, Verify, delivery and restart handling remain shared. A second promotion-specific runner would duplicate recovery and PR ownership logic and could diverge. Do not expose the internal adoption argument on ordinary or coordinator launch commands.

### 4. Qualify the complete fake-model flow and document the shipped UI

**Problem.** Service tests covered model drafting, promotion and simulated delivery; complete real-backend browser qualification was outstanding.

**Context.** The backend tests cover adoption, transcript retention, simulated Review/Verify/PR completion, Build restart, replay, input bounds and concurrent admissions. `mise run test:agent:auto-pipeline` (`e2e/agent-testing/auto-pipeline-live.spec.ts`) is now the fake-model end-to-end run; see [agent-testing.md](../../development/agent-testing.md#auto-pipeline-flow-fake-model).

**Investigation.** Add component coverage for every eligibility case, editor controls, cancellation, failures and retries. Add backend malformed/failed drafting cases and a fake-model end-to-end run through confirmation to PR or commit-only delivery, reload and inactive-environment recovery. Follow the isolated-browser guide without real credentials, prohibited ports, toolchain installation or provider billing. Capture desktop/narrow before-and-after images. Update architecture and user-facing documentation once those paths exist.

**Decisions.** Fake-model qualification (recommended) proves the full path within the ticket's no-billing constraint. Real-provider qualification would exercise vendor behavior but requires separate explicit scope and is unnecessary for this feature's required coverage.

## Current state

Auto-pipeline is available from the manual Multi Review dialog. Durable read-only drafting, editable confirmation, ticket creation and completed-Build adoption are implemented. On 2026-11-09 `mise run test:agent:auto-pipeline` passed on beelink (Linux, headless): a disposable Pi-only profile with no credentials, Pi on a loopback fake model, drafting through the browser, confirmation, the promotion commit, package preparation, validation, a read-only Review, Verify and commit-only delivery finishing while another environment was shown, then the finished graph after a reload and at 390 px. The fake model answered 11 calls and one submission each for the draft, validation plan, review report and Verify; the source tab received no further turn. Every task is done; the durable behaviour is in [build-pipeline-view.md](../../architecture/build-pipeline-view.md#manual-auto-pipeline-promotion) and [review-preparation.md](../../architecture/review-preparation.md#auto-pipeline-build-handoff).

## Constraints and rationale

No real providers, logins or production data directories. Keep host reachability checks off for isolated app runs and avoid ports 34121, 34122 and 45507. Final full validation belongs to the next preparation stage.

## Needs verification

The browser run delivers commit-only. Open-PR delivery after promotion is the ordinary Ship stage and is not exercised by the fake-model run, because it needs `gh` and a GitHub remote; the backend tests cover simulated PR completion. Coordinator reads of a promoted pipeline are covered only by the shared pipeline records, not by a live coordinator.

## Assumptions and decisions

### Task 3: durable adoption replay and checkout ownership

The review repair retains an immutable SHA-256 fingerprint of the full input attempt, including notes and transcript. Replay uses durable admission identities even after terminal outcomes, rejects changed attempts, and returns failed provisioning records for explicit stage retry. Adopted checkout exclusivity applies whichever admission order wins; ordinary non-adopted pipelines retain their existing shared-environment behavior.

### Task 3: bootstrap recovery

Failure recording and stage retry retain the adopted Build as idle. The setup handoff requires the durable adoption marker, rather than inferring adoption from any completed Build. Regression tests cover source-link and environment-configuration failure, explicit retry, and code rewind to the adopted commit.

### Tasks 1, 2 and 4: outstanding product flow

Drafting, manual UI and confirmed ticket publication are implemented with focused fake-provider and fixture-browser tests. Task 4's real-backend browser run is done (below).

### Tasks 1–3: review repairs

Confirmation repairs tab publication on replay, validates checkout and transcript again before committing, and creates the request-keyed ticket after the commit. Draft retention is pruned and environment deletion purges drafts. Source lists refresh while mounted, prefer the active tab, and drafting dialogs can be dismissed without waiting for a provider response.

### Task 4: fake-model qualification

- **Engine.** Pi on a loopback OpenAI-compatible fake (`auto-pipeline-fake-model.ts`, script in `auto-pipeline-fake-model-script.ts`), because Pi runs in process with no login and its isolated `models.json` is inside the profile. The fake reads each stage's result tool and key from the instruction, submits a fixed valid result, and keeps only counts. A Claude or Codex fake would also work but needs a CLI home or config the spec would have to manage as well.
- **Delivery.** Commit-only, set on the ticket while Verify is parked by the fake, because open-PR needs `gh` and a GitHub remote the fixture does not have. The parked Verify also gives the inactive-environment step a fixed point: the spec switches environments before releasing it.
- **Bug found and fixed.** The Build pipeline's stage sends (`build-pipeline-service-supervisor.ts`) and durable re-sends (`build-pipeline-prompt-dispatch.ts`) named the result tool but not its key, so Pi's read-only gate refused a pipeline Review's `submit_review_report` and the run sat in Review. Multi Review and pipeline consolidation already sent the key; the stage sends now do too. `build-pipeline-address-findings-report.test.ts` pins the supervisor path; the re-send path has the identical change but no separate test, because the fan-out fixture's provider deduplicates re-sends.
- **Component and backend coverage.** The eligibility, editor, cancellation, failure and retry cases the task names were already covered by `AutoPipelineLaunch.test.tsx`, `AutoPipelineDescriptionField.test.tsx`, `e2e/AutoPipeline.spec.ts` and `auto-pipeline.test.ts` (malformed and failed drafting); no new cases were needed.
- **Screenshots.** "Before" is the Configure Multi Review dialog with the Auto-pipeline section before drafting; "after" is the finished graph at desktop and 390 px. They are written to `output/visual-previews/auto-pipeline-live-*.png` on each run.
- **File kept.** Every task is done and the index says Finished: Yes. The file is kept rather than deleted in this change because the ticket asked for it and its index row to be updated; a later docs sweep can delete it, since its durable behaviour already lives in the architecture docs.
