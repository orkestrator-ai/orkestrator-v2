# A held coordinator request is still pending-inject after the turn finishes

- **ID:** 1511
- **Status:** open
- **Date observed:** 2026-10-31
- **Test:** `a command node's deliverNow on this leaf > node coordinator requests stay pending while held, until injection`
- **File:** `apps/backend/src/core/nodes/node-coordination.test.ts:348`
- **Original command:** `mise run test` (`scripts/test-all.ts`, default tier) on Linux (Arch, 16 cores), with other worktrees' suites holding the shared test slots; the workspace group ran in parallel with root, bridges and the codex protocol lockfile.
- **Failure:** after `world.finishTurn(recipient)`, `getAgentMailMessage` returned the message with `placement: "pending-inject"` (revision 2, `userReleasedAt` set) where the test expects `placement: "injected"` (174.01 ms). The workspace group's only other failure was the Codex title runner's missing `binaries/codex` in a fresh worktree, which is a setup gap, not a flake.
- **Owning file rerun:** `bun test src/core/nodes/node-coordination.test.ts` in `apps/backend` passed unchanged: 24 pass, 0 fail, 1.2 s.
- **Full rerun:** the exact original command passed on the same branch straight afterwards (every group, workspace 310.9 s), once `mise run download:codex` had provided the pinned Codex CLI.
- **Cause:** unconfirmed. It reads as the injection after the finished turn not having landed before the placement read. Aggregate case [1324](../aggregate-validation-runs/1324-storage-test-split-0930-validation.md) recorded a different test in this file reading the opposite state (`injected` where `pending-inject` was expected), so the file's placement reads may not wait for the inject to settle in either direction. Hypothesis only.
- **Evidence:** failure artifacts `/tmp/orkestrator-test-run.ry7ngK` on beelink (temporary).
