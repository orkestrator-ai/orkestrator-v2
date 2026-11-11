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
