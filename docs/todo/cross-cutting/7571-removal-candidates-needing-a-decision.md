# Removal candidates that need a decision, a live check or a larger change

## Task analysis

Analysed 2026-11-13 against main at `17d28238c`, first written on
2026-11-10 against `53340356c` from the dead-code and fallback
investigation of that day. The same branch removed everything that was safe
under the support window
([version-compatibility.md](../../architecture/version-compatibility.md)).
Window-dated removals are in
[7570](7570-compatibility-paths-waiting-on-the-floor.md). This file holds
the rest: candidates that need a product decision, a live check, or a
change too large to fold into a removal sweep. On 2026-11-13 tasks 1, 2,
8, 12 and 14 and four of task 9's six items were done (see Assumptions and
decisions); every part that needs a person is on the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md).

### Tasks

1. **Bridge full-payload SSE mode**: removed from the Claude and Codex bridges, with the replay ring only it kept. Status: done.
2. **Claude bridge delete-tombstone machinery**: writer and reader removed; no tombstone was ever stored. Status: done.
3. **Image readiness markers**: stop writing `/tmp/.environment-ready` and `/tmp/.entrypoint-complete`, validated with an image build. Status: open.
4. **`envFilePatterns` setting**: Settings offers it, but the backend never reads it. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
5. **Interaction observer switches**: decide the fate of `ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY` and `..._MONITOR_KILL_SWITCH`. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
6. **Artifact rollout flags**: keep the four `ORKESTRATOR_RICH_MARKDOWN`/`ARTIFACT_*` flags as kill switches, or remove them. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
7. **Unmounted and uncalled surfaces**: `NetworkWhitelistDialog.tsx`, and the admin commands `set_workflow_result_tools_rollout` and `graph_capability_ceiling_set`. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
8. **Old browser-held and stored state readers**: the localStorage build-pipeline import, `migrateLegacyClaudeTmuxState` and single-`pipelineId` handoff records removed from the renderer. Status: done (the backend command is task 15).
9. **Small probable leftovers needing one check each**: four of six items checked (two removed, two kept with the reason in a code comment); `bypassPermissionsModeAccepted` waits on a live container start and the `kind: "legacy"` readiness path on a decision. Status: open (depends on the live check and the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
10. **Remaining retired to-do numbers in source comments**: about 39 numbers on about 80 comment lines. Status: open.
11. **Root `conductor.json`**: keep it only if someone opens this repository in Conductor. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
12. **Commands kept only for tests**: `merge_pr_local` and `refresh_environment_diff_stats` removed, their tests ported. Status: done.
13. **Linear connection commands**: `connect_linear` and `disconnect_linear` have no UI caller. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
14. **Uncalled renderer API factories**: `createCommandNodesApi` and `createSelfImprovementApi` removed. Status: done.
15. **`import_legacy_build_pipelines`**: the backend half of task 8; e2e specs seed pipelines through it. Status: open.

### 1. Bridge full-payload SSE mode

**Problem.** The Claude and Codex bridges served a full-payload
`/event/subscribe` stream that no backend from v2.21.0 opens: v2.21.0 never
subscribes, and every later backend sends `observe=1`.

**Context.** Done 2026-11-13. Removed: the full-mode branches, the
serialisation cache and superseded-frame collapse in
`bridges/claude-bridge/src/routes/events.ts` and
`bridges/codex-bridge/src/index.ts`, the Codex per-tab `sessionId` filter and
5 s active keepalive (keepalives are now a flat 30 s), and the replay ring
`packages/protocol/src/node/event-ring.ts` with its test and package export.
Observers never armed the ring, so they already got a gap frame on any
cursor behind the current one.

**Investigation.** The observe path keeps a revision counter, cursor parsing
and a gap frame (`replay.required` for Claude, `session.reconcile-required`
for Codex). It still subscribes and reads the revision in one synchronous
step and buffers the handshake (invariant 7), and its `connected` frame
echoes the client's cursor (invariant 8). The root, bridge and Codex
`AGENTS.md` text that described full mode and replay was updated.

**Decisions.** A request without `observe=1` gets 400 (see Assumptions and
decisions); the live observer check is on the manual-test checklist.

### 2. Claude bridge delete-tombstone machinery

**Problem.** `deleteSessionDurably`, `recordDeletedSdkSession` and
`sessionDeletionTick` in the Claude bridge served `DELETE /session/:id`,
which is removed, and still ran through reconcile and many tests.

**Context.** Done 2026-11-13. Writer and reader removed, together with the
"permanent deletion in progress" branch of `closeSessionRetainingHistory`
and its route message. No code in the bridge calls the SDK's
`deleteSession` any more; the prompt refusal during a close now says
"Session is being closed".

**Investigation.** The tombstone was never stored: from #179 through
v2.21.0 to v2.38.1-beta it was a process-local map, lost on every bridge
restart. The v2.21.0 backend never sent DELETE to the Claude bridge
(`LEGACY_DELETE_RETAINS_HISTORY.claude = false`), and #2105 (first in
v2.37.5-beta) removed the route. So no data directory can hold one, and
the recommended "keep the reader" option had nothing to read.

**Decisions.** Both removed (see Assumptions and decisions).

### 3. Image readiness markers

**Problem.** `docker/entrypoint.sh` (about line 1662) and
`docker/workspace-setup.sh` (about line 120) write
`/tmp/.environment-ready` and `/tmp/.entrypoint-complete`. No backend from
v2.21.0 onward reads them; it reads boot status.

**Context.** The image still uses them itself: `workspace-setup.sh:120`
reads the marker, and `docker/tests/final-image-smoke.sh:57` and
`docker/tests/root-boundary-smoke.sh:47` check it, as do three live backend
tests (`portable-inputs-container.test.ts`,
`container-live-qualification.test.ts`). Read docker/AGENTS.md first.

**Investigation.** Replace the image's own use and the smoke checks with
boot status, then validate with an image build and
`bash docker/tests/final-image-smoke.sh <image>`.

**Decisions.**

- **Remove with an image build and smoke run (recommended).**
  - Pros: proves the image still boots.
  - Cons: needs Docker and a build.
- **Leave them.**
  - Pros: no risk.
  - Cons: two unread files on every boot.

### 4. `envFilePatterns` setting

**Problem.** Settings has an "Environment Files" field saying matching files
"will be copied into containers", but the backend never reads
`envFilePatterns`. The copy list is fixed to `.env` and `.env.local`
(`commands-environment.ts`, `container-project-seed-files.ts`).

**Context.** The field is part of the global config schema
(`packages/protocol/src/contract/domains/config/models.ts`) and is
required, so a schema change needs care with stored configs.

**Investigation.** None further needed; this is a product choice.

**Decisions.**

- **Implement it: copy files matching the patterns (recommended).**
  - Pros: the UI then tells the truth, and users with other env files are served.
  - Cons: real work, and copying arbitrary patterns into containers needs a security review.
- **Remove the control and leave the schema key ignored.**
  - Pros: small; no misleading UI.
  - Cons: drops a setting some users may expect to work.

### 5. Interaction observer switches

**Problem.** The interaction observer (B08) is off unless
`ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY=1`, and
`ORKESTRATOR_AGENT_INTERACTION_MONITOR_KILL_SWITCH` only stops adoption
inside that opt-in mode. Nothing sets either variable except a test.

**Context.** Read at `apps/backend/src/core/index.ts`, allowlisted in
`apps/desktop/electron/backend-process.ts`, implemented in
`native-agent-interaction-tracker.ts` (several hundred lines). 0049 (retired 2026-11-11) decision
D8 left B08 to
[agent-engines 0001](../agent-engines/0001-agent-interactions-and-permissions.md).

**Investigation.** None further; it needs 0001's owner to decide.

**Decisions.**

- **Remove the kill switch now and decide the observer in 0001 (recommended).**
  - Pros: the kill switch guards something already off; about 15 lines.
  - Cons: the observer itself stays until 0001 decides.
- **Remove the whole observer.**
  - Pros: several hundred lines less.
  - Cons: discards work 0001 may still want.

### 6. Artifact rollout flags

**Problem.** `ORKESTRATOR_RICH_MARKDOWN`, `ORKESTRATOR_ARTIFACT_PUBLICATION`,
`ORKESTRATOR_ARTIFACT_LIVE_INTERACTIVE` and
`ORKESTRATOR_ARTIFACT_STATIC_PRESENTATION` (`readArtifactRolloutFlags`,
`transcript-artifacts/service.ts`) default on, and no end condition is
recorded.

**Context.** Documented only as "Rollout switches (default on)" in
`transcript-artifacts-runtime.md`.

**Investigation.** None further.

**Decisions.**

- **Keep them as documented kill switches, and record that in the runtime doc (recommended).**
  - Pros: an operator can turn a misbehaving surface off without a release.
  - Cons: a gate check at each use stays.
- **Remove them.**
  - Pros: about 15 lines plus the gate checks.
  - Cons: no off switch.

### 7. Unmounted and uncalled surfaces

**Problem.** `apps/web/src/components/environments/NetworkWhitelistDialog.tsx`
(347 lines and a test) is never mounted, yet was edited on 2026-11-05.
`set_workflow_result_tools_rollout` and `graph_capability_ceiling_set` are
admin commands no client has ever called.

**Context.** The two commands may be meant as operator commands reachable
only by a raw invoke, like `set_mcp_management_rollout`.

**Investigation.** Ask the author of #1878 about the dialog, and the
owners of workflow-result tools and graphs about the commands.

**Decisions.**

- **Delete what nobody claims within a release (recommended).**
  - Pros: a clear end.
  - Cons: needs the owners to answer.
- **Keep them all.**
  - Pros: no risk to an intended feature.
  - Cons: dead code stays.

### 8. Old browser-held and stored state readers

**Problem.** Three renderer readers served state from before v2.21.0: the
`orkestrator-build-pipelines` localStorage import, `migrateLegacyClaudeTmuxState`
and single-`pipelineId` handoff records.

**Context.** Done 2026-11-13. Removed `migrateLegacyBuildPipelines` and its
`App.tsx` call, the renderer wrapper `importLegacyBuildPipelines`,
`migrateLegacyClaudeTmuxState` with the chat tab's bare-tab-id fallback read
and the pane-layout store's bare-key reset, and the single-`pipelineId`
branch of `pane-selection-storage.ts`. Their tests went or now assert the
old shape is ignored.

**Investigation.** Prompt-queue hydration (`prompt-queue-sources.ts`) only
sets `messageQueue` and never creates a tab entry, the tmux store was never
persisted, and every store write in `ClaudeTmuxChatTab.tsx` uses the scoped
key, so the tmux migration could not fire. The backend command stays for
now (task 15).

**Decisions.** The recommended "retire all three" for the renderer readers.

### 9. Small probable leftovers needing one check each

**Problem.** Each of these was probably dead, but proving it needed a check.

**Context.** Checked 2026-11-13:

- CLI targets fallback without an instance descriptor (`packages/cli/src/client/targets.ts`): **kept**. The backend writes the descriptor before its ready line only as a best effort (from v2.21.0 a failed write is logged and the backend still serves), so a ready dev:test profile can lack one. The reason is in a code comment.
- Command-catalogue answers without `catalogueVersion`: **removed**. Every v2.21.0 bridge stamps it on every `/session/:id/commands` answer; such an answer is now `outdated-bridge`. The non-enhanced path stays for another catalogue version and display-only providers, and `isLegacyCommandId` stays for stored intents.
- Cursor's `streamed.total` usage fallback (`bridges/cursor-bridge/src/prompt.ts`): **kept**. `@cursor/sdk` 1.3.1 declares `RunResult.usage` optional, and a turn failed without a result has only what streamed. The comment now says so.
- Pi's no-runtime `forkSession` fallback: **removed**; its two tests run on a fake runtime, and a new test forks through the real SDK runtime with a scripted model.
- `bypassPermissionsModeAccepted` in `docker/entrypoint.sh` (about lines 1271-1343): open. The pinned Claude CLI may ignore it; confirming that needs one live container start, which is on the manual-test checklist.
- The `kind: "legacy"` readiness path for images without boot status (`container-readiness.ts`, `parseBootProbe` and `observeContainerBoot`): open. It serves only images from before v2.21.0, but images are unmigrated user state, so the container-lifecycle owner decides; the decision is on the manual-test checklist.

**Investigation.** For the two open items, the agent work after the answer
is: delete the entrypoint block if the CLI ignores it (with an image build
and `bash docker/tests/final-image-smoke.sh <image>`), and delete or keep the
legacy readiness path as decided, with a comment if kept.

**Decisions.** For each item, remove it when its check passes
(recommended); otherwise record why it stays in a code comment.

### 10. Remaining retired to-do numbers in source comments

**Problem.** The same branch repointed the ten most-cited retired to-do
numbers (7250, 3800, 7530, 0160, 7550, 7522, 4520, 7540, 7310, 7200) to the
pull requests that did the work. About 39 others remain on about 80
comment lines. `plans/*` links also remain inside to-do files 0007, 0031 and
0025.

**Context.** They are cosmetic. "recurring-processes step NN" comments are
deliberately kept (0048 task 15).

**Investigation.** For each number, `git log --diff-filter=D --
'docs/todo/**/NNNN-*'` finds the deletion, and `git log -S` on the citing
file finds the pull request that did the work.

**Decisions.**

- **Repoint them as files are touched (recommended).**
  - Pros: no cross-area churn.
  - Cons: the stale links linger.
- **Sweep them in one change.**
  - Pros: clean.
  - Cons: touches about 60 files for comments alone.

### 11. Root `conductor.json`

**Problem.** `conductor.json` configures the Conductor app. Nothing in the
repository references it, and it was last edited on 2026-09-09.

**Context.** None.

**Investigation.** None; this is the user's call.

**Decisions.**

- **Keep it if anyone still uses Conductor on this repository; otherwise delete it (recommended: ask).**

### 12. Commands kept only for tests

**Problem.** `merge_pr_local` and `refresh_environment_diff_stats` had no
product caller.

**Context.** Done 2026-11-13. Both commands, their definitions and handlers
were removed. `pull-requests` went to version 3 and `git` to version 2
(both `min: 1`), each client keeping an older-version adapter with the same
API; the register and Retired rows are in
[version-compatibility.md](../../architecture/version-compatibility.md).

**Investigation.** The backend merge tests now call `merge_environment_pr`
(the command the UI uses). The diff-stats tests and
`e2e/agent-testing/browser-gateway.spec.ts` use `changes_refresh`, which the
Files panel's Refresh sends. The e2e spec was edited but not run (real-stack
suites are on demand).

**Decisions.** The recommended "port the tests, then remove both commands".

### 13. Linear connection commands

**Problem.** Neither `connect_linear` nor `disconnect_linear` has a UI
caller. Removing only `disconnect_linear` would leave a connection that no
one can undo.

**Context.** Linear completion comments (`postLinearCompletionComment`)
were also uncalled from the renderer.

**Investigation.** Check whether any stored configuration still holds a
Linear connection, and whether any backend path still posts to Linear.

**Decisions.**

- **Remove the Linear integration as a whole if nothing uses it (recommended).**
  - Pros: removes a dead integration and its credential handling.
  - Cons: a user who connected Linear by hand loses it.
- **Keep it and give it UI.**
  - Pros: the feature works.
  - Cons: product work for an integration nobody has asked about.

### 14. Uncalled renderer API factories

**Problem.** `createCommandNodesApi` and `createSelfImprovementApi` in
`apps/web/src/lib/backend/` had no non-test caller.

**Context.** Done 2026-11-13. Neither `scope-backend.ts` nor any node-scope
wiring uses them: command-node commands always go to the command node over
the portal, and self-improvement is the window's own backend. Both files
now export plain functions bound to `portalBackendClient` and
`commandBackendClient`; `factories.test.ts` skips them, and plan item
[3002](../../../plans/unified/3002-lib-backend-client-parameter.md) records it.

**Investigation.** None further.

**Decisions.** Remove each one that no scope wires in (recommended).

### 15. `import_legacy_build_pipelines`

**Problem.** The backend command that imported task 8's localStorage
snapshots has no product caller now that the renderer import is gone.

**Context.** `e2e/agent-testing/container-app-wiring.spec.ts` (about line
315) and `e2e/agent-testing/pipeline-delete.spec.ts` (about line 64) seed
pipelines through it, and so does `scripts/mixed-version/scenarios/pipelines.ts`.
It is a `pipelines` domain command (version 1, shipped), so removing it
bumps that domain to 2 with a version-1 adapter, a register row and a
Retired row, as task 12 did.

**Investigation.** Find or add a seeding path for those specs (a dev:test
fixture, or a test-only storage seed through the CLI), port the three
callers, run the two e2e specs against an isolated profile, then remove the
command, its schema and its backend tests in `commands-state-sync.test.ts`.

**Decisions.**

- **Port the seeding, then remove the command (recommended).**
  - Pros: no public command exists only for tests.
  - Cons: needs a real-stack run of two e2e specs.
- **Keep it as a documented test seeding entry point.**
  - Pros: no work.
  - Cons: a public command that writes arbitrary pipeline snapshots stays.

## Assumptions and decisions

### Task 1: a request without `observe=1` is refused with 400

Chose refusal over treating every subscription as observe: a leftover
client that expects payloads fails loudly instead of reading content-free
frames as empty updates. Every backend in the window sends `observe=1`.
Replay was dropped rather than kept for observers, because observers never
armed the ring and the backend already re-reads every session on each
`connected` frame.

### Task 2: removed the reader as well as the writer

The recommended option kept the reader for stored tombstones, but the
history shows none was ever stored and no supported backend ever sent the
DELETE that wrote one, so nothing could be left half done.

### Task 8: kept `import_legacy_build_pipelines` on the backend

The renderer readers went as recommended. The backend command is the
seeding entry point of two e2e specs and a mixed-version scenario, which
this change could not run, so its removal is task 15 rather than an
unverified edit.

### Task 9: two items kept with a comment, two left for a person

The CLI fallback and the Cursor usage fallback failed their checks and stay,
each with the reason in a comment. The entrypoint item needs a live
container start and the legacy readiness path a decision; both are on the
manual-test checklist.

### Task 12: bumped `pull-requests` and `git`

Both domains' current versions had shipped, so removing a command needed a
bump (`pull-requests` 3, `git` 2, both `min: 1`) with an older-version
adapter of the same API, as the 2026-11-10 removals did. One project-home
test changed intent: with `merge_environment_pr`, only an unguarded call
with `deleteBranch: true` and no cleanup still shows that a home ignores a
branch delete.

### Task 14: plain functions instead of factories

The files keep their named exports, so no caller changed; the
`lib-backend-command-default` guard no longer counts them as shims, which is
correct because they always mean one node.

## Related

- [7570](7570-compatibility-paths-waiting-on-the-floor.md): window-dated removals.
- [version-compatibility.md](../../architecture/version-compatibility.md)
- [Cross-cutting index](0000-index.md)
