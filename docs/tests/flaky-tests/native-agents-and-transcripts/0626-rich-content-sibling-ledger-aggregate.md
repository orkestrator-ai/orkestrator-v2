# Sibling rich-content ledger is empty in the aggregate

- **ID:** 0626
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `conversation deletion clears that conversation's protected rich content > the backend's transcript-artifact hint for a deleted conversation clears it once`
- **File:** `apps/web/src/lib/chat/rich-conversation-revocation.test.tsx:187`
- **Original command:** `mise run test:logged -- --name reorder-suite -- mise run test`, default workspace/root/bridges/protocol reservations of 4/1/2/1 on the shared macOS host.
- **Failure:** the sibling ledger had length 0 instead of 1 after deletion of the other conversation (151.90 ms).
- **Owning-file rerun:** `mise run test:logged -- --name reorder-rich-revocation-owner -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 2.4 seconds logged).
- **Evidence:** `orkestrator-test-run.U6kMZC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent failure; cause unknown. The remote reorder changes do not touch rich-content ledgers. No implementation, assertion, timeout or skip in this owner changed.


## Desktop recovery validation — 2026-10-26

`mise run test:logged -- --name recovery-repository -- mise run test` repeated
this failure on Linux x64 with two web workers: the sibling ledger had length
0 instead of 1 (274.56 ms). The default repository groups ran alongside Electron
validation and other worktrees. The complete unchanged owner passed alone with
`mise run test:logged -- --name unrelated-rich-content-owner -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures`
(exit 0, 3.3 seconds). This is a recurrence of the tracked intermittent failure;
its cause remains unconfirmed. No rich-content implementation, assertion,
timeout or skip changed. Aggregate evidence is in
`/tmp/orkestrator-test-run.DpxCwj/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
after completion; the outer summary is `/tmp/orkestrator-test-run.vHWLs2/summary.json`.

## Comparison-base review fixes — 2026-10-29

`mise run test:logged -- --name root-tests -- mise run test` repeated the
sibling-ledger failure on Linux (229.74 ms): expected one sibling ledger row,
received zero at line 187. The complete unchanged owner passed separately:
`mise run test:logged -- --name unrelated-rich-content-owner -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures`
(exit 0, 3.0 seconds logged). This is a recurrence of the existing intermittent
failure; its cause remains unconfirmed. No rich-content implementation,
assertion, timeout or skip changed. Aggregate evidence is in
`/tmp/orkestrator-test-run.eqUv2v/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
after finalization; the outer summary is
`/tmp/orkestrator-test-run.0MSwpb/summary.json`.

## Agent mail review repair validation — 2026-10-29

`mise run test:logged -- --name review-default-tests -- mise run test` at
`9e82e514b` repeated the same failure on macOS: expected sibling ledger
length 1, received 0 (211.25 ms). The scheduler reserved workspace/root/bridges/
protocol slots of 6/1/2/1. Web finished with 10,398 pass, 10 skip and 1 fail
across 655 files. The aggregate also retained the unrelated setup-terminal
timeout tracked in
[1304](../aggregate-validation-runs/1304-agent-mail-read-model-0741-validation.md).

The complete unchanged renderer owner passed alone (exit 0, 1.5 s):

```bash
mise run test:logged -- --name review-rich-conversation-revocation -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures
```

Aggregate evidence: `orkestrator-test-run.2mai8S/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
and `orkestrator-test-run.LbkZa8/summary.json` under the host temporary
directory. No rich-content implementation or test changed. The cause remains
unconfirmed.

## Pipeline validation-history review, 2026-10-30

`mise run test:logged -- --name repaired-unit-suite -- mise run test` repeated
this unchanged owner failure. The sibling ledger had length zero instead of one at line 187 (165.55 ms); web totals were 10,845 passed, 10 skipped and one failed.
The complete unchanged owner then passed alone with exit 0 in 1.9 s:

```sh
mise run test:logged -- --name recorded-rich-revocation -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures
```

Aggregate evidence is `orkestrator-test-run.jn7K1f/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. Passing output was removed by the runner.
No owner implementation, assertion, timeout or skip changed; the cause remains
unconfirmed.

## Settings layout review — 2026-10-31

- **Original command:** `mise run test`, at implementation commit `d639571b2`; workspace reservation six slots with two isolated Bun workers for web/desktop and four for backend, bridges reservation two slots with one worker per provider. The component browser suite also ran on the shared host. The aggregate waited about 658 seconds for capacity and exited 1 after 1461 seconds.
- **Failure:** `conversation deletion clears that conversation's protected rich content > the backend's transcript-artifact hint for a deleted conversation clears it once`, `apps/web/src/lib/chat/rich-conversation-revocation.test.tsx:187`, expected a sibling ledger of length one but received zero (285.08 ms). The owning package reported 10883 passed, 10 skipped, two failed across 722 files.
- **Complete unchanged owner rerun:** the following one-worker command passed (exit 0, 12.7 seconds logged). Multi-file commands ran the two complete owners sequentially with Bun isolation. Passing raw output was removed by the bounded logger.

```sh
mise run test:logged -- --name transcript-review-failures-isolated -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures
```

- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.4NhQjk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** recurrence confirmed by the unchanged owner pass. Shared-host scheduling pressure is a hypothesis, not an established cause. No implementation, assertion, deadline or skip in the owning file changed; the aggregate remains non-green.

## Live logging review repair validation — 2026-11-01

Original command: `mise run test:logged -- --name review-repair-default -- mise run test`
on the shared macOS host, workspace/root/bridges/protocol reservations 5/1/2/1,
with the web package using two workers and the bridge packages one worker each.
The run waited 925 seconds for another worktree's aggregate reservation while
browser and Electron checks were also active. No assertion, timeout, skip or
implementation in this owner changed.

The sibling ledger again had length zero instead of one at line 187
(266.51 ms). The complete unchanged owner passed in 2.7 s:
`mise run test:logged -- --name conversation-revocation-owner -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures`.
Evidence: aggregate `orkestrator-test-run.BSqVX9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed at finalization). The cause remains unknown.

### Final default-suite verification — 2026-11-02

`mise run test:logged -- --name review-repair-default-controlled -- mise run test`
passed all four groups (exit 0, 741.9 seconds including a 540.5-second capacity
wait) at code commit `1144ea780`. The logging shutdown clock fix is in that
commit; the other owners listed here were unchanged. This green aggregate
does not establish a root cause for the still-open intermittent cases.

## Domain-boundary review repair — 2026-11-03

`mise run test:logged -- --name default-suite-fix-rerun -- mise run test`
at `f4904db41` repeated the sibling-ledger mismatch at line 187 on Linux
(156.49 ms). Web totals: 11,516 passed, 10 skipped, one failed across 767
files; workspace reserved six slots, root one, bridges two and protocol one.
The complete unchanged owner passed alone (exit 0, 1.9 seconds):

```sh
NODE_ENV=test mise run test:logged -- --name revocation-isolated-test-env -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures
```

An initial owner rerun without explicit `NODE_ENV=test` loaded production React
and failed all 11 tests because `React.act` was undefined. Its diagnostics are
in `/tmp/orkestrator-test-run.GsCwi6/revocation-isolated-fix.log.gz`.
Aggregate evidence is in `/tmp/orkestrator-test-run.1hUmLu/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
(compressed on completion), with the outer result under
`/tmp/orkestrator-test-run.d2pMF8/`. The cause of the sibling-ledger flake
remains unknown. No rich-content implementation or assertions changed.

## Bridge credential repair validation — 2026-11-05

- Original command: `mise run test:logged -- --name review-default-tests -- mise run test`; default workspace group reserved six worker slots.
- Failure: 139.88 ms: sibling ledger expected length 1, received 0. Evidence: `/tmp/orkestrator-test-run.8nVKRg/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` (compressed on aggregate completion).
- Complete unchanged owner: `NODE_ENV=test mise run test:logged -- --name triage-rich-revocation -- bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures` passed, exit 0, in 2.4 s. Passing output was removed by the logged runner.
- Owning code and assertions were unchanged. This repeats the open case; no new root cause established. Aggregate totals were not yet available when the owner reran.

## Leaf-mode branch merge validation — 2026-11-05

- Merge parents: `0c9f7eb93c03d510284bf27200d7f058d0498556` and `e1f4c875fe7667a094ab350b8f7880aab8b6783d`. This owner was outside the four original conflicts and was unchanged by resolution.
- Original command: `mise run test:logged -- --name merge-default-suite -- mise run test`; workspace/root/bridges/protocol reservations 6/1/2/1 slots, web two isolated Bun workers. The run waited 660.1 seconds for capacity and exited 1 after 1268.2 seconds.
- Failure: `conversation deletion clears that conversation's protected rich content > the backend's transcript-artifact hint for a deleted conversation clears it once`, `apps/web/src/lib/chat/rich-conversation-revocation.test.tsx:187`, sibling ledger expected length 1, received 0 (233.79 ms). Web totals: 12,500 passed, 10 skipped, one failed across 833 files. All other package tasks and the root, bridge and protocol-check groups passed.
- Complete unchanged owner rerun: `mise run test:logged -- --name merge-revocation-rerun -- env NODE_ENV=test bun test --cwd apps/web ./src/lib/chat/rich-conversation-revocation.test.tsx --parallel=1 --only-failures` passed (exit 0, 2.6 seconds). Passing output was removed by the logged runner.
- Evidence: `/tmp/orkestrator-test-run.WgzY1u/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer aggregate log `/tmp/orkestrator-test-run.6qQiEz/merge-default-suite.log.gz`.
- This repeats the open case. No implementation, assertion, timeout or skip changed; root cause remains unconfirmed, and the aggregate remains non-green.
