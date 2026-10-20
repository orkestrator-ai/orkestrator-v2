# Agent mail conversation same-millisecond ordering

- **ID:** 0504
- **Status:** resolved
- **Date observed:** 2026-10-20
- **Test:** `StorageService agent mail conversations > joins both directions of a pair, oldest first, and lists each pair once`
- **Owner:** `apps/backend/src/core/storage-agent-mail-conversations.test.ts`
- **Scope:** uncommitted rich-transcripts work on branch `20261020-005611-6ba26bffea80` (base `67a6cc31`); the owning test and the agent-mail storage modules were unchanged.
- **Original command:** `mise run test:logged -- --name full-suite-2 -- mise run test`.
- **Failure:** the two messages came back in the reverse order. Both ids share the same millisecond prefix (`00mvg563up-…`), followed by random UUIDs, so ordering by id within one millisecond depends on the random suffix.
- **Suite counts:** backend reported one failure in the workspace group; web, desktop, protocol, toolchain, web-public and CLI passed.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/storage-agent-mail-conversations.test.ts` from `apps/backend` passed three times (3 pass, 0 fail each), and together with `agent-mail-conversations.test.ts` under `--parallel=2` (4 pass).
- **Evidence:** `orkestrator-test-run.4hwW5S/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Hypothesis:** two sends inside one millisecond tie on the time prefix and fall back to a random id order. A deterministic tie-break (an insertion sequence) or a test clock would remove it. No implementation, assertion or skip changed.
- **Recurrence (2026-10-20, later round):** failed again as the only failure of a full `mise run test` (bridges, root and agent-support, lockfile and the rest of the workspace group passed); five isolated reruns of the test from `apps/backend` gave 4 pass, 1 fail, so it reproduces without the rest of the suite. The owning test and the agent-mail modules are still unchanged on this branch.

- **Review-fix validation recurrence (2026-10-20):** `review-full-final`
  repeated the same-millisecond ordering failure while running alongside
  browser checks. `mise run test:logged -- --name review-mail-owner -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/storage-agent-mail-conversations.test.ts --parallel=1 --only-failures`
  passed the unchanged owner (0.1 seconds). Evidence:
  `orkestrator-test-run.rDZFZg/review-full-final.log.gz` under the host temporary
  directory. No storage implementation or test assertion changed.

- **Final review aggregate (2026-10-20):** `review-all-complete` reported
  9,531 backend passes, 41 skips and this one unchanged ordering failure;
  8,483 web tests passed (10 skips), and the other aggregate groups passed.
  The unchanged owner passed again in `review-mail-final-owner` (0.1 s).
  Evidence: `orkestrator-test-run.c7h361/review-all-complete.log.gz` under the
  host temporary directory. This remains an aggregate validation limitation.

## Resolution — 2026-10-20

`sortableId` in `apps/backend/src/core/storage-agent-mail.ts` now writes a
per-process sequence between the millisecond prefix and the random suffix, and
its clock never runs backwards. Two sends in one millisecond therefore sort in
send order; the random suffix no longer decides the tie. The regression
`keeps send order for mail sent within one millisecond` freezes the clock with
`setSystemTime` and sends 20 messages in both directions. It failed against the
previous id and passes with the fix; all five agent-mail owners passed
(109 tests).
