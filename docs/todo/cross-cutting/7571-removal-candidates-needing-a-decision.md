# Removal candidates: what was removed, and the larger changes left

## Task analysis

Analysed 2026-11-14 against main at `dc90609bf` (task 3), before that
2026-11-13 against `17d28238c`, first written on
2026-11-10 against `53340356c` from the dead-code and fallback
investigation of that day. The same branch removed everything that was safe
under the support window
([version-compatibility.md](../../architecture/version-compatibility.md)).
Window-dated removals are in
[7570](7570-compatibility-paths-waiting-on-the-floor.md). This file held
the rest: candidates that needed a product decision, a live check, or a
change too large to fold into a removal sweep. On 2026-11-13 tasks 1, 2,
8, 9, 12 and 14 were done (see Assumptions and decisions), and every
candidate or part of one that needs a person (tasks 4, 5, 6, 7, 11, 13 and
15, the two remaining task 9 items and task 1's live check) moved to the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md),
which carries each one's context, options and the agent work that follows
the answer. Task 3 was done on 2026-11-14. What is left here is agent work
only: task 10.

### Tasks

1. **Bridge full-payload SSE mode**: removed from the Claude and Codex bridges, with the replay ring only it kept. Status: done.
2. **Claude bridge delete-tombstone machinery**: writer and reader removed; no tombstone was ever stored. Status: done.
3. **Image readiness markers**: the image no longer writes or reads `/tmp/.environment-ready` and `/tmp/.entrypoint-complete`; it and its smoke and live checks use boot status, validated with an image build and the final-image smoke on a disposable daemon. Status: done.
4. `envFilePatterns` setting (Settings offers it, but the backend never reads it): moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) on 2026-11-13.
5. Interaction observer switches (`ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY` and `..._MONITOR_KILL_SWITCH`): moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) on 2026-11-13.
6. Artifact rollout flags (the four `ORKESTRATOR_RICH_MARKDOWN`/`ARTIFACT_*` flags): moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) on 2026-11-13.
7. Unmounted and uncalled surfaces (`NetworkWhitelistDialog.tsx`, `set_workflow_result_tools_rollout`, `graph_capability_ceiling_set`): moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) on 2026-11-13.
8. **Old browser-held and stored state readers**: the localStorage build-pipeline import, `migrateLegacyClaudeTmuxState` and single-`pipelineId` handoff records removed from the renderer. Status: done (the backend command is task 15, on the manual-test checklist).
9. **Small probable leftovers needing one check each**: four of six items checked (two removed, two kept with the reason in a code comment). Status: done (the `bypassPermissionsModeAccepted` live check and the `kind: "legacy"` readiness decision moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).
10. **Remaining retired to-do numbers in source comments**: about 39 numbers on about 80 comment lines. Status: open.
11. Root `conductor.json`: moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) on 2026-11-13.
12. **Commands kept only for tests**: `merge_pr_local` and `refresh_environment_diff_stats` removed, their tests ported. Status: done.
13. Linear connection commands (`connect_linear`, `disconnect_linear`): moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) on 2026-11-13.
14. **Uncalled renderer API factories**: `createCommandNodesApi` and `createSelfImprovementApi` removed. Status: done.
15. `import_legacy_build_pipelines` (the backend half of task 8, still used by e2e seeding): moved to the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) on 2026-11-13.

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

**Problem.** `docker/entrypoint.sh` (lines 1721-1722 at `dc90609bf`) wrote
`/tmp/.environment-ready` and `/tmp/.entrypoint-complete`, and
`docker/network-policy-entrypoint.sh` and the entrypoint deleted them at
boot. No backend from v2.21.0 onward reads them; it reads boot status
(`/run/orkestrator/boot-status.json`).

**Context.** Done 2026-11-14. The image used them itself:
`docker/workspace-setup.sh` fell back to the marker when `/run/orkestrator`
was missing, and `docker/tests/final-image-smoke.sh`,
`docker/tests/root-boundary-smoke.sh`,
`apps/backend/tests/portable-inputs-container.test.ts`,
`apps/backend/tests/container-live-qualification.test.ts` and
`e2e/agent-testing/browser-gateway.spec.ts` checked it.

**Investigation.** Every write, delete and read of both markers is gone.
`workspace-setup.sh` waits only for the current boot's record (the image
creates `/run/orkestrator`, and the script ships in the same image as the
entrypoint, so its pre-boot-status branch could never run). The root-boundary
smoke and the portable-inputs test wait for a `ready` record naming PID 1's
start time; the final-image smoke and the live restart test now assert both
markers are absent; the gateway spec already waited for boot status and
only lost its marker line. `container-lifecycle.md`'s Readiness section and
a `container-readiness.ts` comment no longer mention the markers. The
backend's `kind: "legacy"` readiness path is untouched: it is the task 9
decision on the manual-test checklist.

**Decisions.** Removed, with an image build and smoke run (the recommended
option; results in Assumptions and decisions).

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
now; whether to port its callers and remove it (task 15) is a decision on
the manual-test checklist.

**Decisions.** The recommended "retire all three" for the renderer readers.

### 9. Small probable leftovers needing one check each

**Problem.** Each of these was probably dead, but proving it needed a check.

**Context.** Checked 2026-11-13:

- CLI targets fallback without an instance descriptor (`packages/cli/src/client/targets.ts`): **kept**. The backend writes the descriptor before its ready line only as a best effort (from v2.21.0 a failed write is logged and the backend still serves), so a ready dev:test profile can lack one. The reason is in a code comment.
- Command-catalogue answers without `catalogueVersion`: **removed**. Every v2.21.0 bridge stamps it on every `/session/:id/commands` answer; such an answer is now `outdated-bridge`. The non-enhanced path stays for another catalogue version and display-only providers, and `isLegacyCommandId` stays for stored intents.
- Cursor's `streamed.total` usage fallback (`bridges/cursor-bridge/src/prompt.ts`): **kept**. `@cursor/sdk` 1.3.1 declares `RunResult.usage` optional, and a turn failed without a result has only what streamed. The comment now says so.
- Pi's no-runtime `forkSession` fallback: **removed**; its two tests run on a fake runtime, and a new test forks through the real SDK runtime with a scripted model.
- `bypassPermissionsModeAccepted` in `docker/entrypoint.sh` (about lines 1271-1343): **moved to the manual-test checklist**. The pinned Claude CLI may ignore it; confirming that needs one live container start with a Claude login.
- The `kind: "legacy"` readiness path for images without boot status (`container-readiness.ts`, `parseBootProbe` and `observeContainerBoot`): **moved to the manual-test checklist**. It serves only images from before v2.21.0, but images are unmigrated user state, so the container-lifecycle owner decides.

**Investigation.** The checklist items for the two moved items say what an
agent does once they are answered.

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

### 14. Uncalled renderer API factories

**Problem.** `createCommandNodesApi` and `createSelfImprovementApi` in
`apps/web/src/lib/backend/` had no non-test caller.

**Context.** Done 2026-11-13. Neither `scope-backend.ts` nor any node-scope
wiring uses them: command-node commands always go to the command node over
the portal, and self-improvement is the window's own backend. Both files
now export plain functions bound to `portalBackendClient` and
`commandBackendClient`; `factories.test.ts` checks that every exported
command reaches the window's command scope instead, and plan item
[3002](../../../plans/unified/3002-lib-backend-client-parameter.md) records it.

**Investigation.** None further.

**Decisions.** Remove each one that no scope wires in (recommended).

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
unverified edit. Task 15 is a choice between a public test-only command
and porting its callers, so it is on the manual-test checklist.

### Task 9: two items kept with a comment, two left for a person

The CLI fallback and the Cursor usage fallback failed their checks and stay,
each with the reason in a comment. The entrypoint item needs a live
container start and the legacy readiness path a decision; both moved to the
manual-test checklist, so task 9 holds no agent work and is done.

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

### Tasks 4, 5, 6, 7, 11, 13 and 15: moved to the manual-test checklist

Each needs a maintainer decision (task 13 also a look at the user's real
configuration), and the ticket asked for every such candidate to go to the
checklist's decisions section so this file keeps only agent work. Their
subsections were removed rather than kept as `open (depends on ...)`: a
to-do task waiting on the user is neither backlog nor blocked
([Choosing a status](../../README.md#choosing-a-status)). Each checklist
item now holds the context, the options with their pros and cons, the
recommendation and the agent work that follows the answer, and asks for the
answer as a reply to the coordinator rather than in this file, which is
retired once task 10 is done. The numbering is kept so the
checklist's "7571 task N" references stay correct.

## Related

- [7570](7570-compatibility-paths-waiting-on-the-floor.md): window-dated removals.
- [version-compatibility.md](../../architecture/version-compatibility.md)
- [Cross-cutting index](0000-index.md)
