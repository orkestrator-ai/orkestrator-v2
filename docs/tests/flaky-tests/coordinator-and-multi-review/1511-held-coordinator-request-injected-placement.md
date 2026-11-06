# A held coordinator request is still pending-inject after the turn finishes

- **ID:** 1511
- **Status:** resolved
- **Date observed:** 2026-10-31
- **Test:** `a command node's deliverNow on this leaf > node coordinator requests stay pending while held, until injection`
- **File:** `apps/backend/src/core/nodes/node-coordination.test.ts:348`
- **Original command:** `mise run test` (`scripts/test-all.ts`, default tier) on Linux (Arch, 16 cores), with other worktrees' suites holding the shared test slots; the workspace group ran in parallel with root, bridges and the codex protocol lockfile.
- **Failure:** after `world.finishTurn(recipient)`, `getAgentMailMessage` returned the message with `placement: "pending-inject"` (revision 2, `userReleasedAt` set) where the test expects `placement: "injected"` (174.01 ms). The workspace group's only other failure was the Codex title runner's missing `binaries/codex` in a fresh worktree, which is a setup gap, not a flake.
- **Owning file rerun:** `bun test src/core/nodes/node-coordination.test.ts` in `apps/backend` passed unchanged: 24 pass, 0 fail, 1.2 s.
- **Full rerun:** the exact original command passed on the same branch straight afterwards (every group, workspace 310.9 s), once `mise run download:codex` had provided the pinned Codex CLI.
- **Cause:** unconfirmed. It reads as the injection after the finished turn not having landed before the placement read. Aggregate case [1324](../aggregate-validation-runs/1324-storage-test-split-0930-validation.md) recorded a different test in this file reading the opposite state (`injected` where `pending-inject` was expected), so the file's placement reads may not wait for the inject to settle in either direction. Hypothesis only.
- **Evidence:** failure artifacts `/tmp/orkestrator-test-run.ry7ngK` on beelink (temporary).


### Resolution — 2026-11-06

- **Stale; fixed by `b965aea44` (#1547, merged 2026-11-01 12:34 UTC).** In the
  `held` variant the test sent "Uses the first wake budget." to a busy recipient
  and left that message pending, with its busy backoff, when it released the
  second message. The next `finishTurn` drain could then deliver the first
  message ahead of the released one. That delivery consumed the turn, so the
  released message stayed `pending-inject` with `userReleasedAt` set at
  revision 2, which is exactly the recorded symptom. `b965aea44` settles the
  first delivery (`await world.finishTurn(recipient)`) before sending and
  releasing the second.
- **Every recorded sighting predates that fix.** The 2026-10-31 runs predate it,
  and the 2026-11-01 run on `visual-change-image-05b2937be199-r1` came from
  `ec08062d8` (#1521, merged 11:21 UTC), which does not contain `b965aea44`. No
  recurrence has been recorded since.
- **Reproduced:** yes, for the pre-fix test. With the settle line temporarily
  removed,
  `mise run test:logged -- --name coord-node-prefix -- bun --cwd=apps/backend test ./src/core/nodes/node-coordination.test.ts -t "stay pending while held" --rerun-each=30`
  failed 1 of 30 on an unpinned host (70.8 ms), with the identical
  `pending-inject` / `userReleasedAt` / revision 2 record.
- **Verification of the current test:** `coord-node-postfix` (`--rerun-each=300`):
  300/300 pass. `coord-node-held-stress` (`--rerun-each=100`, pinned to one core
  beside 6 busy loops): 100/100 pass. `coord-node-file-stress` (whole owner,
  `--rerun-each=10`, same contention): pass. No source changed.

