# Coordinator notice hierarchy: live checks across two nodes

## Task analysis

Analysed 2026-11-07 against `main` at `413bd6219`.

The notice hierarchy (one routing rule for status, pull request, auto-switch
and usage-limit stop notices; session creation for a notice with no main
running) was built under ticket `208ff0b5-8300-4ef2-8a69-50d745bcd3bf`, branch
`coordinator-notifications-e0dd5a1eb9a6-r1`. Its acceptance record quoted all
18 criteria and named the code and tests for each, all on fake providers, fake
accounts and in-process node links. Its **Not verified live** section is what
this file holds. The record was `docs/reports/2026-11-04-coordinator-notice-acceptance.md`,
deleted with the rest of `docs/reports/` on 2026-11-07; read it with
`git show 413bd6219:docs/reports/2026-11-04-coordinator-notice-acceptance.md`.

### Tasks

1. **A leaf's usage-limit stops reach the command node's coordinator, once and grouped**: criteria AC2, AC8 and AC9 on two real backends. Status: open.
2. **A command node's coordinator on the limited login moves first**: criterion AC13 across two machines' account entries. Status: open (depends on 1).
3. **A stop raised while the link is down arrives once after a leaf restart**: criteria AC11 and AC12 on two real backends. Status: open (depends on 1).

### 1. A leaf's usage-limit stops reach the command node's coordinator, once and grouped

**Problem.** A session that stops on a usage limit on a leaf should produce
one notice, at the command node's main coordinator for that repository (not
the leaf's), and stops on one account in one reset window should share one
wake that lists every session. Only in-process command and leaf worlds have
shown this.

**Context.** The rule is `routeCoordinatorNotice`
(`packages/protocol/src/coordinator-notices.ts`); delivery is
`CoordinatorNoticeRouter` (`apps/backend/src/core/coordinator-notice-router.ts`);
stops are grouped by account and window in
`coordinator-usage-limit-notices.ts` with the ledger in
`storage-coordinator-notices.ts`. Stops come from
`AgentAccountAutoSwitcher.handleLimitStop` and `noteUnresentStop`, native tabs
(`native-agent-usage-limit-resend.ts`) and pipeline and review workers
(`build-pipeline-service-supervisor.ts`). The hierarchy tests are
`coordinator-notice-hierarchy.test.ts`. How it works is in
[coordinator.md](../../architecture/coordinator.md) ("Who hears a notice",
"Usage-limit stop notices") and [command-nodes.md](../../architecture/command-nodes.md)
(Leaf mode).

**Investigation.** Not run. Steps the acceptance record gave, on throwaway
`dev:test` profiles only:

1. Link a leaf profile to a command-node profile that has the same repository.
2. On the leaf, run a native tab, a delegated worker and a pipeline worker on
   one provider account, then let that account reach its limit.
3. Confirm the command node's main coordinator gets one notice listing all
   three sessions (each named with its kind, machine, repository, account,
   reset time and whether it resends or waits), and the leaf's coordinator
   gets none.

**Decisions.**

- **How to make the account reach its limit?**
  - **A scripted provider server answering with a usage-limit refusal, as `mise run verify:accounts:resend-live` already does for one machine (recommended).**
    - Pros: no billed turns or exhausted subscription; repeatable; uses the real bridges and pinned CLIs.
    - Cons: proves the routing and grouping, not a real provider's refusal text; that half is to-do 1250 (retired 2026-11-10; now in the manual-test checklist) tasks 1 and 2.
  - **A real account at its weekly limit.**
    - Pros: end to end, including the provider's own refusal.
    - Cons: needs an exhausted subscription at the moment of the run, as 1250 does.

### 2. A command node's coordinator on the limited login moves first

**Problem.** When the receiving coordinator runs on the limited account,
including the same login under another machine's entry (same provider and
email), a switch to an account with headroom should be attempted before the
coordinator's turn, without pinning. Only fakes have matched accounts across
machines.

**Context.** `coordinator-usage-limit-notices.ts` compares
`coordinatorAccountKey` with the group's `usageLimitAccountKey` and calls
`moveOff`, which is `AgentAccountAutoSwitcher.moveOffLimitedAccount`
(production callbacks in `coordinator-usage-limit-account-routing.ts`). A move
it cannot make keeps the notice with a reason (AC14).

**Investigation.** Not run. Repeat task 1 with the command node's coordinator
on the same login as the leaf's limited account, under a different account
entry, and a second login with headroom on the command node. Confirm the
command node moves to the second login before the coordinator's turn, and
that nothing is pinned afterwards.

**Decisions.**

- **Where to run it?**
  - **The same two profiles as task 1, straight after it (recommended).**
    - Pros: the setup is already in place; one run covers both.
    - Cons: needs a second login with headroom on the command node.
  - **Join to-do 0722's two-machine batch (0722 retired 2026-11-10; its runs are in the manual-test checklist, 7568).**
    - Pros: shares the cost with the other cross-machine account checks.
    - Cons: waits on that batch.

### 3. A stop raised while the link is down arrives once after a leaf restart

**Problem.** A notice raised while the leaf's link to the command node is down
should arrive once after reconnect, and survive a leaf backend restart in
between. Retries, restarts and reconnects should produce no duplicate. Only
in-process links have shown this.

**Context.** Leaf notices go through the durable leaf outbox
(`apps/backend/src/core/nodes/node-mail.ts`), drained by
`nodes/node-mail-collector.ts`, under durable request ids per notice and per
stop group; a retried notice keeps its first rendering.

**Investigation.** Not run. Repeat task 1 with the link down when the stops
happen, stop and start the leaf profile's backend, then restore the link.
Confirm the command node's coordinator gets the notice exactly once.

**Decisions.**

- **How to take the link down?**
  - **Stop the command-node profile (`dev:stop`) and start it again (recommended).**
    - Pros: uses only the profile lifecycle commands; no host networking changes.
    - Cons: also restarts the command node, which is a second variable.
  - **Block the link's port on the host.**
    - Pros: keeps the command node running.
    - Cons: a host firewall change, which these runs should not make.

## Constraints and rationale

- Use only isolated `dev:test` profiles and a fixture repository; never a
  production instance or its data directory.
- Record no prompts, notice bodies or account emails in evidence; counts,
  routes and request-id equality are enough.

## Related

- To-do 1250 (retired 2026-11-10; now in the manual-test checklist), task 7: a leaf's automatic switch notice reaching the command node; how it works is in [Automatic switching: Coordinators](../../architecture/agent-accounts.md#coordinators).
- to-do 2900 (retired 2026-11-10; see [coordinator.md](../../architecture/coordinator.md#coordinators-on-two-nodes)): the same two-node setup for coordinator mail.
- [4860](4860-c1-wake-reliability-follow-ups.md): other coordinator wake checks that need two nodes.
