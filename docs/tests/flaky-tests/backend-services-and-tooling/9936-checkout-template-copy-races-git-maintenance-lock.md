# Checkout template copy races Git's background maintenance lock

- **ID:** 9936
- **Status:** open
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

- **Base:** `498b68766f5c9f357a3a86782406d1e9e0977559`; `mise run flaky:recurrence -- 9936 --base 498b68766…` answered `open`.
- **Observed head:** `coordinator-tab-groups-93e8abebd558-r1` at `1dffbbfac`, a
  renderer layout-store fix plus a plan-usage URL seam. It does not touch the
  fixture or the failing tests.
- **Command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name review-default-tests-skip-guards -- mise run test`
  on macOS, on a host shared with other worktrees' suites (1400.9 s; the
  runner's own reruns queued for host capacity and ran out of their 600 s
  budget).
- **Tests:** `real scoped credentials prompt and launch jobs in leaf-only environments with durable delegations` (`control-mcp-node-auth.test.ts`),
  `a command node's coordinator sending to a leaf > an agent tab there can open the image from the path its own node wrote` (`coordinator-mail-attachments-nodes.test.ts`),
  `tickets on a leaf > a ticket created for a leaf is on the board and on the leaf under one id, and its build runs there` (`coordinator-node-tickets.test.ts`)
  and `one failing delegation > does not stop the wakes behind it` (`coordinator-delegation-wakes.test.ts`),
  each with the same `ENOENT … .git/objects/maintenance.lock` at about 190 to 410 ms
  (backend 18,326 passed and 4 failed).
- **Isolated reruns:** `bun --cwd=apps/backend test` on the three files plus
  `coordinator-delegation-wakes.test.ts` with `--parallel=2` failed the first
  two again with the same error (75 pass, 2 fail); `coordinator-delegation-wakes` passed in that run;
  each of the other three alone with `--parallel=1` passed (1.5 s, 4.8 s,
  2.1 s). So two loaded files are
  enough to hit it, which fits the hypothesis below.

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
