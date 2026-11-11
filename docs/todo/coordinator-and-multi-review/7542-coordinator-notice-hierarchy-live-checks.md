# Coordinator notice hierarchy: live checks across two nodes

## Task analysis

Analysed 2026-11-07 against `main` at `413bd6219`; re-analysed 2026-11-11
against `main` at `498b68766`, and updated the same day after the
usage-endpoint seam (task 1, item 1) was built.

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

1. **A two-backend harness with scripted provider accounts**: two linked `dev:test` profiles whose Claude or Codex accounts are fixtures and whose model and usage endpoints are loopback servers. Status: open (item 1, the loopback usage endpoints, done 2026-11-11; items 2 to 5 open).
2. **A leaf's usage-limit stops reach the command node's coordinator, once and grouped**: criteria AC2, AC8 and AC9 on two real backends. Status: open (depends on 1).
3. **A command node's coordinator on the limited login moves first**: criterion AC13 across two machines' account entries. Status: open (depends on 2).
4. **A stop raised while the link is down arrives once after a leaf restart**: criteria AC11 and AC12 on two real backends. Status: open (depends on 2).

### 1. A two-backend harness with scripted provider accounts

**Problem.** Tasks 2 to 4 need a usage-limit stop raised on one real backend
and delivered to another, with no billed turn and no real login. No harness in
the repository can do that today, so none of them can be run as written.

**Context.** Two harnesses each cover half of it:

- `e2e/agent-testing/coordinator-node-mail-fake.spec.ts` (to-do 2900, retired)
  links two real `dev:test` profiles, the desk attaching the leaf over the
  leaf's gateway, but drives Pi on a loopback model. Pi has no account
  entries: `AGENT_ACCOUNT_PLATFORMS` in `packages/protocol/src/agent-accounts.ts`
  is `claude` and `codex` only, so no stop is grouped by account and no
  automatic switch is attempted.
- `apps/backend/tests/account-switch-stack.ts` (with
  `account-switch-stack-host.ts`, run by `mise run verify:accounts:resend-live`)
  has fixture Claude and Codex accounts, the pinned CLIs pointed at a loopback
  model (`ANTHROPIC_BASE_URL`, Codex `openai_base_url` and `chatgpt_base_url`)
  and scripted usage readings. It runs one in-process `OrkestratorBackend`
  under a throwaway HOME and answers the usage reads by replacing the global
  `fetch`. Until 2026-11-11 that was the only way: `plan-usage.ts` always read
  `CLAUDE_USAGE_URL` and `CODEX_USAGE_URL`.

**Investigation.** Checked 2026-11-11. Every file the tasks below name still
exists on `main`, and the in-process evidence still holds:
`coordinator-notice-hierarchy.test.ts`, `coordinator-notice-sources.test.ts`
and `coordinator-usage-limit-account-routing.test.ts` pass (84 tests). A
`dev:test` backend is a separate process, so the stack's `fetch` replacement
cannot reach it; started with fixture accounts and no usage origin, its usage
reads would go to the real Anthropic and OpenAI hosts with fixture tokens,
which these runs must not do. What the harness needs:

1. **Done 2026-11-11.** A way for an agent-test profile's backend to read usage
   from a loopback origin. Start the profile with
   `ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN=http://127.0.0.1:<port>` (the desktop
   launcher passes it through to the isolated backend); `planUsageUrl` in
   `plan-usage.ts` then reads `/api/oauth/usage` (Claude) and
   `/backend-api/codex/usage` (Codex) from that origin, for both the settings
   card and the per-account reads the auto-switcher makes.
   `agentTestUsageOrigin` (`agent-test-fixtures.ts`) honours it only with
   flavor `agent-test`, `ORKESTRATOR_AGENT_TEST_ISOLATED=1`, a non-default
   data directory and a bare loopback origin; anything else reads the real
   endpoints. Tests: `plan-usage-agent-test-origin.test.ts`.
2. Each profile's Claude (or Codex) configuration, in its isolated credential
   home and never `~/.claude` or `~/.codex`, naming the loopback model, with
   two fixture accounts on the leaf (one limited) and, for task 3, the same
   login under a second entry plus one with headroom on the desk.
3. A scripted model that refuses with the provider's usage-limit error for the
   limited account, answers the others, and drives the leaf's coordinator to
   call `launch_environment` so a delegated worker exists.
4. A build pipeline started on the leaf with the limited account (through the
   `orkestrator` CLI against the leaf profile), so a pipeline worker stops too.
5. The link setup and content-free summary of
   `coordinator-node-mail-fake.spec.ts`, reused rather than copied.

**Decisions.**

- **Where should the usage endpoints come from on a profile?** Implemented 2026-11-11 as the recommended option.
  - **An agent-test-only override read at backend start (recommended).** The `dev:test` launcher passes a loopback origin, and the backend honours it only when the profile is an agent-test profile.
    - Pros: tests the real separate-process backends the tasks ask for; the same seam serves any later two-node account check.
    - Cons: a production code path, however gated, that needs its own test proving it is refused outside agent-test profiles.
  - **Two in-process backends in one test process, linked over loopback HTTP, with the stack's `fetch` replacement.**
    - Pros: no production change; reuses the stack almost whole.
    - Cons: one process shares HOME, globals and the replaced `fetch`, so it is closer to the in-process worlds already tested than to two machines; a leaf restart (task 4) is not a process restart.
- **Which platform?**
  - **Claude (recommended).** Its refusal shape and usage reading are already scripted in the stack, and its CLI reads `ANTHROPIC_BASE_URL`.
    - Pros: least new scripting.
    - Cons: the coordinator turn that calls `launch_environment` needs Anthropic tool-use responses scripted, which the stack does not have yet.
  - **Codex.**
    - Pros: also scripted in the stack.
    - Cons: two base URLs to point and a JWT fixture per account; no simpler.

### 2. A leaf's usage-limit stops reach the command node's coordinator, once and grouped

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

**Investigation.** Not run: it needs the harness from task 1. Steps the
acceptance record gave, on throwaway `dev:test` profiles only:

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

### 3. A command node's coordinator on the limited login moves first

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

**Investigation.** Not run (depends on task 2). Repeat task 2 with the command node's coordinator
on the same login as the leaf's limited account, under a different account
entry, and a second login with headroom on the command node. Confirm the
command node moves to the second login before the coordinator's turn, and
that nothing is pinned afterwards.

**Decisions.**

- **Where to run it?**
  - **The same two profiles as task 2, straight after it (recommended).**
    - Pros: the setup is already in place; one run covers both.
    - Cons: needs a second login with headroom on the command node.
  - **Join to-do 0722's two-machine batch (0722 retired 2026-11-10; its runs are in the manual-test checklist, 7568).**
    - Pros: shares the cost with the other cross-machine account checks.
    - Cons: waits on that batch.

### 4. A stop raised while the link is down arrives once after a leaf restart

**Problem.** A notice raised while the leaf's link to the command node is down
should arrive once after reconnect, and survive a leaf backend restart in
between. Retries, restarts and reconnects should produce no duplicate. Only
in-process links have shown this.

**Context.** Leaf notices go through the durable leaf outbox
(`apps/backend/src/core/nodes/node-mail.ts`), drained by
`nodes/node-mail-collector.ts`, under durable request ids per notice and per
stop group; a retried notice keeps its first rendering.

**Investigation.** Not run (depends on task 2). Repeat task 2 with the link down when the stops
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

## Assumptions and decisions

### Task 1: added as a prerequisite rather than run as written (2026-11-11)

Ticket "To-dos 5000 + 7542" asked for every task an agent can finish on this
machine. Tasks 2 to 4 cannot be run without new harness code: the only
two-backend harness drives Pi, which has no accounts, and the only scripted
account stack is in-process. The harness is recorded here as task 1 with what
it needs. The file stays `backlog`: nothing in it waits on the user or on
another to-do. No item was added to the manual-test checklist, because the
scripted run proves the routing and grouping, and the real provider's refusal
is already there from retired to-do 1250.

### Task 1: the usage-endpoint seam built; items 2 to 5 left open (2026-11-11)

Review of that ticket asked for the harness to be built. Item 1, the one
production code path the harness needs, was built and tested in the same
branch: it is small, deterministic to test, and the refusal outside
agent-test profiles is what makes the rest safe to build. Items 2 to 5 were
not: they are a scripted Anthropic model that streams tool-use turns
(`launch_environment`) through the pinned Claude CLI, fixture account homes
and a pipeline started on the leaf, and a two-profile Playwright spec reusing
`coordinator-node-mail-fake.spec.ts`'s link setup. That is new real-stack
harness code (`e2e/agent-testing/**`), whose runs take many minutes each, in a
branch whose change is a renderer fix, so it is left for its own pipeline
rather than appended to this one. Tasks 2 to 4 therefore still have no live
evidence.

## Constraints and rationale

- Use only isolated `dev:test` profiles and a fixture repository; never a
  production instance or its data directory.
- Record no prompts, notice bodies or account emails in evidence; counts,
  routes and request-id equality are enough.
- No billed turn, no real login and no real provider endpoint: fixture
  accounts and loopback servers only, and never `~/.claude`, `~/.codex` or the
  real data directory.

## Related

- To-do 1250 (retired 2026-11-10; now in the manual-test checklist), task 7: a leaf's automatic switch notice reaching the command node; how it works is in [Automatic switching: Coordinators](../../architecture/agent-accounts.md#coordinators).
- to-do 2900 (retired 2026-11-10; see [coordinator.md](../../architecture/coordinator.md#coordinators-on-two-nodes)): the same two-node setup for coordinator mail.
- [4860](4860-c1-wake-reliability-follow-ups.md): other coordinator wake checks that need two nodes.
