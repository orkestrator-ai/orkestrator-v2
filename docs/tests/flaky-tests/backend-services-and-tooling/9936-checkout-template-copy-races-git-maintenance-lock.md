# Checkout template copy races Git's background maintenance lock

- **ID:** 9936
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Base:** `53340356c51e6bdb6f86cb6d806575218bbbc6bd`.
- **Observed head:** the uncommitted dead-code removal branch
  `dead-code-investigation-0dd96028bc56` on that base. It does not touch the
  fixture or the failing tests.
- **File:** `apps/backend/src/core/git-checkout-template-test-support.ts`
  (`copyCommittedCheckout`, added in a57ea8702, #2095), through its users.
- **Tests (one aggregate run):**
  - `send_message with attachments, to an environment on this node > the recipient can open the image from the path its message names` (`coordinator-mail-attachments.test.ts`)
  - `tickets on a leaf > a ticket created for a leaf is on the board and on the leaf under one id, and its build runs there` (`coordinator-node-tickets.test.ts`)
  - `update-agents-md approval > approval with the user's edits opens the PR on this node and mails the URL` (`nodes/node-coordination-agents-md.test.ts`)
  - `approved create-project maps choices and mails success to its requesting conversation` (`nodes/node-coordination-project-copy.test.ts`)
  - `graph run status wakes > one wake when a run the coordinator launched ends, however often it is saved` (`coordinator-status-wakes-graph.test.ts`)
  - `production coordinator and leaf RPC share the raw/turn activity probe and exact session lookup`, `a remote stop runs on the node, marks the open delegation, and survives a lost answer` (`worker-session-activity.test.ts`)
  - `backend init resumes persisted AGENTS.md approval once and mails the result`
- **Failure:** `ENOENT: no such file or directory, lstat
  '<tmp>/ork-checkout-template-XXXXXX/.git/objects/maintenance.lock'`, 16
  times in the backend group's log, each failing test at about 180 to 330 ms.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`
  on macOS, git 2.56.0. The runner's own reruns of the six owning files it
  retried passed alone.
- **Evidence:** `orkestrator-test-run.HOxbkF/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.

## Unchanged owners

Each of `coordinator-mail-attachments`, `coordinator-node-tickets`,
`node-coordination-agents-md`, `node-coordination-project-copy`,
`coordinator-status-wakes-graph` and `worker-session-activity` passed when
the aggregate runner reran it alone (0.6 to 2.2 s). A second complete
`mise run test` on the same tree passed (exit 0, 265.4 s) with no
`maintenance.lock` error.

## Recurrence 2026-11-11

- **Base:** `498b68766f5c9f357a3a86782406d1e9e0977559`; observed on branch
  `macos-watch-churn-47b622d64a81-r1` at `ea553276d`, which changes the
  worktree watcher and touches neither the fixture nor the failing tests.
  `mise run flaky:recurrence -- 9936 --base 498b68766`: open, record it.
- **Command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name
  default-tests-skip-guards -- mise run test` on macOS, git 2.56.0, while
  other worktrees' aggregate runs held the host (the groups queued 1,250 s).
  Backend group: 18,340 pass, 200 skip, 5 fail. Four of the five failed with
  this `maintenance.lock` error, at 290 to 400 ms:
  `real scoped credentials prompt and launch jobs in leaf-only environments
  with durable delegations` (`control-mcp-node-auth.test.ts`), `one failing
  delegation > does not stop the wakes behind it`
  (`coordinator-delegation-wakes.test.ts`), `a command node's coordinator
  sending to a leaf > an agent tab there can open the image from the path its
  own node wrote` (`coordinator-mail-attachments-nodes.test.ts`) and `backend
  init resumes persisted AGENTS.md approval once and mails the result`
  (`index-agents-md-recovery.test.ts`). The fifth was flake 4843's loopback
  listener.
- **Rerun alone:** the five owning files with `--parallel=1`: 85 pass, 1 fail.
  `control-mcp-node-auth.test.ts` failed again with the same error (419 ms),
  so a single file on a loaded host is enough; the other three passed.
- **Evidence:** `orkestrator-test-run.tOQhj5` and `orkestrator-test-run.WIUK3M`
  under the host temporary directory.

## Hypothesis

`committedCheckoutTemplate` runs `git commit` in the template. Git then
starts auto-maintenance in the background (detached), which creates and
removes `.git/objects/maintenance.lock` in the template. A concurrent
`fs.cp` of the template lists the lock and then fails to `lstat` it once
maintenance removes it. Under load the copy and the detached maintenance
overlap; on a quiet host maintenance finishes first.

A fix would disable auto-maintenance for the template (for example
`git -c maintenance.auto=false -c gc.auto=0 commit`, or the same keys in the
template's config before committing). Per the testing guide, reproduce the
failure first (for example by copying while a held `maintenance.lock`
appears and disappears) before changing the fixture.

## Recurrence 2026-11-11

- **Observing base:** `498b68766` (`main`), with the uncommitted renderer error ring changes of branch `renderer-error-ring-e3a48fce2746-r1` (no checkout-template or coordinator code changed). `mise run flaky:recurrence 9936 --base 498b68766` answered open.
- **Command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:changed` on mini (macOS arm64, Bun 1.4.4), load average about 24 to 32 from other worktrees.
- **Failures:** `ENOENT: no such file or directory, lstat '…/ork-checkout-template-…/.git/objects/maintenance.lock'` in `tickets on a leaf > a ticket created for a leaf is on the board and on the leaf under one id, and its build runs there` (`apps/backend/src/core/coordinator-node-tickets.test.ts`, 260.58 ms) and in a test not listed above, `on the real coordinator > a refused conversation is woken with one message when the node reconnects` (`apps/backend/src/core/coordinator-node-reconnect-wakes.test.ts`, 432.83 ms).
- **Owning-file reruns:** the runner's isolated reruns passed unchanged: `coordinator-node-tickets.test.ts` in 1.4 s, `coordinator-node-reconnect-wakes.test.ts` in 1.0 s.
- **Evidence:** `orkestrator-test-run.PS6O8Y/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory. The same run's CLI timeout is [9944](9944-cli-bash-completion-aggregate-timeout.md).

The fix proposed under Hypothesis still applies; it was not attempted here.

## Recurrence — 2026-11-11 (SQLite activity metrics branch)

- **Base:** `498b68766f5c9f357a3a86782406d1e9e0977559`; head `9530616a0` on
  branch `sqlite-storage-tuning-d0d420a0c5e2-r1`, which changes only storage
  instrumentation, the deletion scrub, diagnostics types and docs, not the
  fixture or the failing tests. `mise run flaky:recurrence -- 9936 --base
  498b68766` answered `open`.
- **Command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name
  default-tests-skip-guards -- mise run test` (macOS, 18 CPUs, load average
  about 34–39, git 2.56.0). Backend group: 18334 pass, 7 fail.
- **Failing tests with `ENOENT … lstat '<tmp>/ork-checkout-template-XXXXXX/.git/objects/maintenance.lock'`:**
  - `production coordinator and leaf RPC share the raw/turn activity probe and exact session lookup` (`worker-session-activity.test.ts`, 1111 ms)
  - `real scoped credentials prompt and launch jobs in leaf-only environments with durable delegations` (`control-mcp-node-auth.test.ts`, 272 ms)
  - `a command node's coordinator sending to a leaf > an agent tab there can open the image from the path its own node wrote` (`coordinator-mail-attachments-nodes.test.ts`, 364 ms)
  - `coordinator deliverNow > a busy native worker gets the message steered into its running turn` (`coordinator-deliver-now.test.ts`, 522 ms)
- **Reruns:** the runner's one-file reruns passed `worker-session-activity`,
  `control-mcp-node-auth` and `coordinator-mail-attachments-nodes`.
  `coordinator-deliver-now` failed its runner rerun with the same
  `maintenance.lock` error inside `MailWorld.create()` (28 pass, 1 fail),
  then passed alone twice: `mise run test:logged -- --name
  deliver-now-rerun-N -- mise exec -- bun --cwd=apps/backend test --preload
  ../../tests/setup-node.ts src/core/coordinator-deliver-now.test.ts
  --parallel=1` (11.9 s each). Failing alone under load fits the hypothesis
  (the race is with Git's detached maintenance, not with sibling test files).
- **Evidence:** `orkestrator-test-run.tVTJUs/` under the host temporary
  directory (`workspace-…-toolchain.log.gz`,
  `rerun-apps-backend-src-core-coordinator-deliver-now-test-ts.log.gz`).

## Recurrence and resolution (2026-11-11)

Observed again on branch `webkit-scroll-fix-d230c4f38350-r1` (base
`498b68766f5c9f357a3a86782406d1e9e0977559`, which does not touch the fixture),
in `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
on macOS while two other worktrees ran their own aggregate suites. Five backend
tests failed with the same `maintenance.lock` ENOENT:
`a nonzero hold survives sweeps and expires at its bound`
(`coordinator-background-work.test.ts`), `real scoped credentials prompt and
launch jobs …` (`control-mcp-node-auth.test.ts`), `approved create-project
maps choices …` (`nodes/node-coordination-project-copy.test.ts`),
`answer-worker-question approval > approving unchanged …`
(`nodes/node-worker-answer.test.ts`) and `a remote stop runs on the node …`
(`coordinator-worker-turns-remote.test.ts`). The runner's solo reruns hit the
group deadline before giving a verdict.

**Reproduced** before the fix: those five files run on their own
(`bun --cwd=apps/backend test <five files> --parallel=2`) failed once with the
same ENOENT (30 pass, 1 fail), so the race does not need the aggregate suite.

**Root cause:** the hypothesis above. The template's `git commit` starts
detached auto-maintenance, which creates and removes
`.git/objects/maintenance.lock` while `fs.cp` lists and copies the directory.

**Fix:** `committedCheckoutTemplate` sets `maintenance.auto=false` and
`gc.auto=0` in the template before committing; copies inherit the config.

**Verification:** after the fix, those five files plus the four other owners
named above (`coordinator-mail-attachments`, `coordinator-node-tickets`,
`node-coordination-agents-md`, `coordinator-status-wakes-graph`) passed in
five consecutive runs with `--parallel=4`. None of them logged a `maintenance.lock` error.

**Second template (same day).** The next `mise run test` on the same branch
failed `fingerprints content changes even when HEAD and dirty paths stay the
same (bun)` in `apps/backend/src/core/review-worktree-fingerprint.test.ts`
with the same ENOENT, from that file's own template
(`ork-review-fingerprint-template-*`, built with `git commit` and copied with
`fs.cp`); the aggregate runner's rerun of the unchanged file passed alone in
7.5 s. That template now sets the same two keys before committing, and the
file passed three consecutive solo runs afterwards.
`environment-move.test.ts` also commits in a template it then copies with
`fs.cp`; it has not been observed failing this way and was not changed.
