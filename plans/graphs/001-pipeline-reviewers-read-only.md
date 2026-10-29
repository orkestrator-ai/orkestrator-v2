---
id: 001
title: "Pipeline reviewers run read-only, with a generic git guard"
phase: 0
plan: "P0.1"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 001 · Pipeline reviewers run read-only, with a generic git guard

- **Plan:** [P0.1 Pipeline reviewers run read-only, with a generic git guard](../composable-graphs.md#p01-pipeline-reviewers-run-read-only-with-a-generic-git-guard)
- **Decisions:** none (report §2.7, finding 1)
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Build Pipeline reviewers get the same read-only treatment as Multi Review reviewers, and a git guard backs it up on every provider. Today the launcher claims a Git check for Review that does not exist.

## Work

- [ ] Set `reviewerMode: "plan"` on the Build Pipeline fan-out host when a review package exists (`build-pipeline-review-fanout.ts`; host field at `review-fanout.ts:534`).
- [ ] Create and prompt the single-review session with `readOnly: true` when a package exists (`startStage` for `review` in `build-pipeline-service-supervisor.ts`).
- [ ] Generalise the Verify baseline in `build-pipeline-validation-worktree.ts` into a read-only guard: capture HEAD and the git-visible paths before dispatch, check them at submit time and again when the result is consumed.
- [ ] Apply the guard to pipeline review, pipeline consolidation and Verify.
- [ ] Change `WorkflowResultService.setAcceptanceCheck` from one check per kind to a list per kind. Each check skips attempts it does not own.
- [ ] Correct the launcher note in `BuildLaunchDialog.tsx:571-574` so it describes what is enforced.

## Tests

- [ ] Pipeline single-review and fan-out tests assert that `mode: "plan"` and `readOnly: true` reach `createSession` and `send`.
- [ ] A reviewer that commits is refused at submit time and can repair within its turn.
- [ ] Two acceptance checks registered for one kind both run, and each ignores attempts it does not own.

## Done when

- [ ] Pipeline reviewers are read-only on every provider that supports it, and the guard refuses a committing reviewer.
- [ ] The launcher note matches what is enforced.
- [ ] `docs/architecture/build-pipeline-view.md` and `review-preparation.md` describe the new behaviour.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
