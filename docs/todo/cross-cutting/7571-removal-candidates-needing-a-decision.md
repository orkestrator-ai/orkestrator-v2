# Removal candidates that need a decision, a live check or a larger change

## Task analysis

Analysed 2026-11-10 against main at `53340356c`, from the dead-code and
fallback investigation of that day. The same branch removed everything that
was safe under the support window
([version-compatibility.md](../../architecture/version-compatibility.md)).
Window-dated removals are in
[7570](7570-compatibility-paths-waiting-on-the-floor.md). This file holds
the rest: candidates that need a product decision, a live check, or a
change too large to fold into a removal sweep.

### Tasks

1. **Bridge full-payload SSE mode**: remove the non-observe branch of `/event/subscribe` in the Claude and Codex bridges and the replay retention only it keeps alive. Status: open.
2. **Claude bridge delete-tombstone machinery**: `deleteSessionDurably` and its tombstone ticks have no HTTP route since `DELETE /session/:id` was removed. Status: open.
3. **Image readiness markers**: stop writing `/tmp/.environment-ready` and `/tmp/.entrypoint-complete`, validated with an image build. Status: open.
4. **`envFilePatterns` setting**: Settings offers it, but the backend never reads it. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
5. **Interaction observer switches**: decide the fate of `ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY` and `..._MONITOR_KILL_SWITCH`. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
6. **Artifact rollout flags**: keep the four `ORKESTRATOR_RICH_MARKDOWN`/`ARTIFACT_*` flags as kill switches, or remove them. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
7. **Unmounted and uncalled surfaces**: `NetworkWhitelistDialog.tsx`, and the admin commands `set_workflow_result_tools_rollout` and `graph_capability_ceiling_set`. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
8. **Old browser-held and stored state readers**: the localStorage build-pipeline import, `migrateLegacyClaudeTmuxState`, and single-`pipelineId` handoff records. Status: open.
9. **Small probable leftovers needing one check each**: the CLI targets fallback without an instance descriptor, command rows without `catalogueVersion`, `bypassPermissionsModeAccepted` in the entrypoint, Cursor's `streamed.total` usage fallback, Pi's no-runtime `forkSession`, and the `kind: "legacy"` container readiness path. Status: open.
10. **Remaining retired to-do numbers in source comments**: about 39 numbers on about 80 comment lines. Status: open.
11. **Root `conductor.json`**: keep it only if someone opens this repository in Conductor. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
12. **Commands kept only for tests**: `merge_pr_local` and `refresh_environment_diff_stats` have no product caller. Status: open.
13. **Linear connection commands**: `connect_linear` and `disconnect_linear` have no UI caller. Status: open (depends on the decision on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
14. **Uncalled renderer API factories**: `createCommandNodesApi` and `createSelfImprovementApi`. Status: open.

### 1. Bridge full-payload SSE mode

**Problem.** The Claude and Codex bridges still serve a full-payload
`/event/subscribe` stream. No backend from v2.21.0 onward opens it: v2.21.0
never subscribes, and every later backend sends `observe=1` (checked against
v2.21.0, v2.27.0-beta and v2.36.0). The full mode costs a few hundred lines:
serialisation, superseded-frame collapse and the replay ring.

**Context.** In the Claude bridge's `routes/events.ts`, only full-mode
subscribers keep the replay ring alive; observers never arm it. So the
removal is a redesign of replay retention, not a deletion, and it touches
the root AGENTS.md invariants 7 and 8 (replay subscribes before it
calculates; a connected frame echoes the client's cursor). The "legacy web
client" text in root AGENTS.md and `bridges/claude-bridge/AGENTS.md` refers
to this mode. `apps/backend/tests/codex-subagent-stack.ts` (about line 212)
uses full mode and must move to observe mode.

**Investigation.** List what the observe path needs from
`packages/protocol/src/node/event-ring.ts` and from the Claude and Codex
SSE code, delete the rest, and keep the cursor and replay tests that the
observe path exercises.

**Decisions.**

- **Remove now, or keep as the documented debugging stream?**
  - **Remove it in its own change (recommended).**
    - Pros: drops a few hundred lines and a second serialisation path nobody uses.
    - Cons: needs care with the replay invariants and a review of its own.
  - **Keep it.**
    - Pros: no work.
    - Cons: dead code that the bridge rules still have to describe.

### 2. Claude bridge delete-tombstone machinery

**Problem.** `deleteSessionDurably`, `recordDeletedSdkSession` and
`sessionDeletionTick` in the Claude bridge served `DELETE /session/:id`,
which is now removed. They still run through reconcile and many tests.

**Context.** A tombstone recorded by an older bridge may still be on disk
and finished by reconcile, so the reader may need to stay while a data
directory can hold one.

**Investigation.** Find every caller other than the removed route. Decide
whether a stored delete tombstone can still exist (written by any bridge in
the window) and whether reconcile must finish it.

**Decisions.**

- **Keep finishing stored tombstones, remove the writer (recommended).**
  - Pros: no stored deletion is left half done.
  - Cons: the reader stays until no supported release writes tombstones.
- **Remove both.**
  - Pros: the least code.
  - Cons: a tombstone from an older bridge would never be finished.

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
`native-agent-interaction-tracker.ts` (several hundred lines). 0049 decision
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

**Problem.** Three readers serve state from before v2.21.0:

- the localStorage build-pipeline import (`lib/build-pipeline-persistence.ts`, about lines 614-735, called from `App.tsx`) and the backend `import_legacy_build_pipelines`;
- `migrateLegacyClaudeTmuxState` (`stores/claudeTmuxStore.ts`, about lines 829-870, plus `ClaudeTmuxChatTab.tsx` and `paneLayoutStore.ts`);
- single-`pipelineId` handoff records (`lib/pane-selection-storage.ts`, about lines 140-143).

**Context.** No renderer has written `orkestrator-build-pipelines` since
#178 (2026-07-27), but the hosted client has been live since 2026-07-14, so
a browser that used it in those two weeks and has not opened it since could
still hold some. `claudeTmuxStore` never used persistence middleware, so its
only possible source is stored prompt-queue records keyed by a bare tab id.

**Investigation.** For the tmux migration, check whether
`prompt-queue-sources.ts` can still hydrate a bare-key record. For the
others, no further investigation is possible: the data is in users'
browsers.

**Decisions.**

- **Retire all three (recommended).**
  - Pros: about 190 lines; only browsers idle for over three months could lose anything, and the tmux path is probably unreachable.
  - Cons: such a browser loses its pre-July pipelines.
- **Keep them.**
  - Pros: no data loss.
  - Cons: dead code for a case that may never occur.

### 9. Small probable leftovers needing one check each

**Problem.** Each of these is probably dead, but proving it needs a check
the investigation could not run:

- `packages/cli/src/client/targets.ts` (about lines 454-470): the fallback for a profile without an instance descriptor. Confirm every ready backend publishes the descriptor.
- Command-catalogue rows without `catalogueVersion` (`http-bridge/catalog.ts`, `native-agent-command-dispatch.ts`). Confirm every v2.21.0 bridge's `/commands` answer carries it (`git grep catalogueVersion v2.21.0 -- bridges`). Keep `isLegacyCommandId` for stored intents.
- `bypassPermissionsModeAccepted` in `docker/entrypoint.sh` (about lines 1271-1343). The pinned Claude CLI may ignore it; confirm with one live container start.
- Cursor's `streamed.total` usage fallback (`bridges/cursor-bridge/src/prompt.ts`, about line 641) "for older SDK/runtime pairs". Confirm `RunResult.usage` is always present on `@cursor/sdk` 1.3.1.
- Pi's no-runtime `forkSession` fallback (`bridges/pi-bridge/src/agent-session.ts`, about lines 1619-1650). It serves only dependency-injected test sessions; move those tests onto a runtime.
- The `kind: "legacy"` readiness path for images without boot status (`container-readiness.ts`, about lines 54 and 209-226). It serves only images from before v2.21.0, but images are unmigrated user state, so the container-lifecycle owner decides.

**Context.** See each item.

**Investigation.** As listed.

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

**Problem.** `merge_pr_local` has no product caller (its renderer wrapper was
removed), but about 15 backend tests use it as the entry point to the
stored-merge path. `refresh_environment_diff_stats` has no product caller
either, but `e2e/agent-testing/browser-gateway.spec.ts` drives it.

**Context.** No renderer in the window calls either command (checked
against v2.21.0 and v2.36.6-beta). Removing a command bumps its contract
domain; `pull-requests` and `environments` are already at version 2 on this
branch, so do it before that version ships if possible.

**Investigation.** Port the backend tests to `merge_environment_pr`, and
point the e2e spec at whichever command the UI uses to refresh diff stats.

**Decisions.**

- **Port the tests, then remove both commands (recommended).**
  - Pros: the tests exercise the path users take.
  - Cons: a test rewrite.
- **Keep them as test entry points.**
  - Pros: no work.
  - Cons: two public commands exist only for tests.

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
`apps/web/src/lib/backend/` have no non-test caller. The removal sweep left
them alone because they are factories that may be wired up through a scope.

**Context.** Fork A1 found that `machine-profile.ts`'s factory, which looked
dead, is wired into `scope-backend.ts`.

**Investigation.** Search `scope-backend.ts` and the node-scope wiring for
each factory.

**Decisions.** Remove each one that no scope wires in (recommended).

## Related

- [7570](7570-compatibility-paths-waiting-on-the-floor.md): window-dated removals.
- [version-compatibility.md](../../architecture/version-compatibility.md)
- [Cross-cutting index](0000-index.md)
