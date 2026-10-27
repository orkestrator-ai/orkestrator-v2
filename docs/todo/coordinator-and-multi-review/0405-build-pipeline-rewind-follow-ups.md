# Build pipeline rewind follow-ups

Checked against the branch that made build pipeline restarts rewind
(2026-10-27). The design is in
[build-pipeline-view.md](../../architecture/build-pipeline-view.md#restarting-a-step).

## Current state

"Restart from here" on any live step rewinds the pipeline to that step's round
and position (`restartLocatedStage` in
`apps/backend/src/core/build-pipeline-service-lifecycle.ts`, rules in
`build-pipeline-rewind.ts`). Later sessions are kept with `supersededBy` and a
bounded `rewinds` history; the graph collapses them into a greyed "Previous
attempt" node (`pipeline-flow.ts`). Restarts work from `failed` and `complete`;
a re-Ship updates the existing PR; a merged PR refuses the restart. Unit and
service tests cover the rewind, the loop continuing to `maxIterations`, fix
feedback per round, terminal restarts, Kanban, idempotency, denied late
submissions, older records and the projection. Added regression coverage exercises
validation restart repeats while pending/running and after controller reload,
validation-only history beside a live reviewer panel, persistent Kanban failures,
earlier Build/Address/conflict restarts, and a multi-reviewer rewind through
replacement consolidation. Closed-PR service integration covers confirmed reopen
and refusal to complete while the PR stays closed. Browser fixtures cover retained
validation actions and panel grouping at both viewport widths across reload.
Live provider/GitHub qualification below remains separate from these controlled fixtures.

## Outstanding work

### Qualification

1. **A real rewind end to end.** On a `dev:test` profile, let a pipeline fail
   its last Verify, restart round 1's Verify, and check the line, the previous
   attempt node and its expansion, the rerun's Fix 2 → Verify 2 rounds, and
   that leaving the tab and returning keeps the selection and expansion.
2. **Re-Ship on a real repository.** Restart Verify on a completed pipeline
   with an open PR and confirm the agent pushes to and edits the same PR
   (`gh pr edit`), and reopens a closed one, rather than opening a second.
3. **Stacked layout.** Check a phone-width pipeline with an expanded previous
   attempt: consecutive superseded stages each draw the bypass beside them.

### Code

4. **Rewind the code to a step.** Restarts keep the current code by design. A
   separate, explicit action (with a confirmation naming the commits it
   drops) could reset the worktree to the commit a step started from. It
   needs that commit recorded on each session and a story for pushed commits
   and an open PR.
5. **Address without rerunning Review.** Only the newest review report is
   kept, so restarting an earlier round's Address reruns that round's Review.
   A bounded per-round copy of the consolidated report would let Address
   rerun alone.
6. **Package-only restart on the single-review path.** Restarting a Build or
   Fix that wrote the package plan now reruns the step; re-preparing the
   package alone is only reachable through Restart validation or a dedicated
   preparation session.

## Known limits (by design)

- Rewinds older than the newest 50 drop their record; their sessions stay
  superseded and the attempt node then shows no restart time.
- A same-round restart carries the first fix attempt's unchanged-worktree
  baseline; a rewind from a later round does not.
