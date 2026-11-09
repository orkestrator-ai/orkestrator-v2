# Complete the Auto-pipeline launch flow

## Task analysis

Analysed 2026-11-09 against main at `30bce689555ce4f62e473d19e196d912535d3d04`.

### Tasks

1. Implement durable read-only drafting and typed commands. Status: open.
2. Implement the manual launch and draft-review dialogs. Status: open (depends on 1).
3. Implement confirmed ticket creation and promotion. Status: open (depends on 1).
4. Qualify the complete fake-model flow and document the shipped UI. Status: open (depends on 2 and 3).

### 1. Implement durable read-only drafting and typed commands

**Problem.** There is no model session that converts finished prompt work into a reviewed ticket and Build handoff.

**Context.** `BuildPipelineService.startFromCompletedBuild` now accepts a backend-owned completed attempt. No command calls it. Ordinary launch commands do not accept this attempt. The new entry point does not validate native-tab ownership or activity; its future caller must do so authoritatively.

**Investigation.** Reuse saved launch defaults, the native transcript APIs, environment Git and the structured workflow-result transport. Persist the selected tab, branch identity, diff fingerprint, model selection and request identity before dispatch. Bound transcript, diff and result sizes and fail explicitly when input cannot fit. Deny unattended interactions and close owned drafting sessions on cancellation. Use fake providers only.

**Decisions.** A durable drafting workflow (recommended) survives navigation and backend restart, at the cost of an additional persisted record. Renderer-owned async work is smaller but cannot recover a missed result or an ambiguous dispatch. The ticket requires a backend-owned workflow and one separate read-only session.

### 2. Implement the manual launch and draft-review dialogs

**Problem.** The Multi Review button offers no Auto-pipeline option or draft editor.

**Context.** The existing launch dialog and ActionBar controller remain unchanged. Coordinator review tools must remain unchanged.

**Investigation.** Offer promotion only on an unlinked prompt environment. Select the active agent tab or present a picker, disable running tabs with a reason, and revalidate on the backend. Provide editable title, structured description and criteria with add/remove/reorder controls; show generated notes read-only and list pending uncommitted paths. Cancel creates nothing. Failure offers retry and plain Multi Review.

**Decisions.** Extend the manual launch UI (recommended): this follows the specified entry point and preserves existing coordinator semantics. Adding promotion to the shared review launch request would reduce command surface but would also expose it to callers explicitly excluded by the ticket.

### 3. Implement confirmed ticket creation and promotion

**Problem.** There is no confirmation command that creates a ticket, commits pending changes and invokes adoption.

**Context.** The internal adoption path persists the original provider session and transcript as round 1, retains its source tab identity and committed baseline, seeds key information, and follows the normal environment configuration and Review preparation paths. Its storage admission excludes a second pipeline in that environment and replays same-intent admission.

**Investigation.** Add an idempotent confirmation journal before mutations. Recheck tab idleness, ownership, environment linkage and the diff shown to the user. Create the in-progress ticket with reviewed criteria, commit the reviewed uncommitted paths, and use the saved Build defaults. Recover each publication boundary without duplicate tickets or commits. Replace the manual review surface with the existing pipeline graph. Confirm sidebar, coordinator reads, PR ownership and the Build inspector use the resulting authoritative pipeline. Prevent conflicting edits from the original tab while the pipeline owns the workspace.

**Decisions.** Adopt via the existing pipeline lifecycle (recommended): normal Review, Rework, Verify, delivery and restart handling remain shared. A second promotion-specific runner would duplicate recovery and PR ownership logic and could diverge. Do not expose the internal adoption argument on ordinary or coordinator launch commands.

### 4. Qualify the complete fake-model flow and document the shipped UI

**Problem.** Current fake-provider tests start at internal adoption, not at the Multi Review button or model drafting.

**Context.** The new backend tests cover adoption, transcript retention, simulated Review/Verify/PR completion, Build restart, replay, input bounds and concurrent admissions. They are not the requested fake-model end-to-end test.

**Investigation.** Add component coverage for every eligibility case, editor controls, cancellation, failures and retries. Add backend malformed/failed drafting cases and a fake-model end-to-end run through confirmation to PR or commit-only delivery, reload and inactive-environment recovery. Follow the isolated-browser guide without real credentials, prohibited ports, toolchain installation or provider billing. Capture desktop/narrow before-and-after images. Update architecture and user-facing documentation once those paths exist.

**Decisions.** Fake-model qualification (recommended) proves the full path within the ticket's no-billing constraint. Real-provider qualification would exercise vendor behavior but requires separate explicit scope and is unnecessary for this feature's required coverage.

## Current state

This branch contains only the completed-Build adoption foundation. Auto-pipeline is **not available to users** and the feature ticket is **not complete**.

## Constraints and rationale

No real providers, logins or production data directories. Keep host reachability checks off for isolated app runs and avoid ports 34121, 34122 and 45507. Final full validation belongs to the next preparation stage.

## Needs verification

The internal adoption tests use an in-process fake provider. They do not prove drafting, actual Git commits, rendered graph behavior, coordinator ownership, or the manual button flow.
