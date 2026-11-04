# Coordinator notice hierarchy: acceptance evidence

Ticket `208ff0b5-8300-4ef2-8a69-50d745bcd3bf`, "Coordinator notification
hierarchy, session creation and usage-limit stop notices", branch
`coordinator-notifications-e0dd5a1eb9a6-r1`.

Earlier verification rounds were given only a pointer to the ticket, not its
criteria, so they could not check each one. This file quotes all 18 criteria
word for word and, for each, names the code that implements it and the tests
that cover it. The tests use fake providers, fake accounts and in-process
command/leaf worlds. No billed provider turn and no real machine link ran.

Paths below are relative to `apps/backend/src/core/` unless they start with
`packages/` or `docs/`. Test names are quoted from the test files. The
hierarchy tests are in `coordinator-notice-hierarchy.test.ts`, shortened to
"hierarchy" below.

## Criteria

### AC1

> One routing helper decides the receiving coordinator, and the existing
> status, pull request, auto-switch and new usage-limit notices all use it.

- Rule: `routeCoordinatorNotice` in
  `packages/protocol/src/coordinator-notices.ts`. Delivery:
  `CoordinatorNoticeRouter` in `coordinator-notice-router.ts`.
- Status wakes: `coordinator-status-wakes.ts` (`router`, `deliver`). Pull
  requests: `coordinator-pr-watches.ts` (`router`). Auto-switch:
  `index.ts` → `noticeRouter.deliverAutoSwitch`. Usage-limit stops:
  `coordinator-usage-limit-notices.ts` (`router.route`, `sendUp`, `mainFor`).
- Tests: `coordinator-notice-sources.test.ts` ("a status wake › on a leaf goes
  to the command node…", "a watched pull request › goes up from a leaf");
  `agent-accounts-auto-switch-notices.test.ts` ("coordinators whose repository
  the command node hears about instead"); hierarchy "a session stopped on a
  usage limit"; protocol `coordinator-notices.test.ts`.

### AC2

> A leaf session's notice for a repo the command node has reaches the command
> node's main coordinator for that repo and not the leaf's.

- Tests: hierarchy "a leaf's notice for a repository the command node has
  reaches that node's coordinator, not the leaf's"; "a stale list: the command
  node declines, and the leaf's coordinator takes it once"; "acceptance audit
  regressions › a retry with changed words stays in the outbox and reaches one
  coordinator"; sources "on a leaf goes to the command node, and is counted as
  sent".

### AC3

> A leaf session's notice for a repo the command node lacks reaches the leaf's
> main coordinator.

- Rule: `repository-not-on-command` in `routeCoordinatorNotice`.
- Tests: hierarchy "a leaf's notice for a repository the command node lacks
  reaches the leaf's coordinator"; "a leaf session's stop › a command node
  without the repository hands it to the leaf's coordinator".

### AC4

> A notice on a standalone machine or on the command node reaches the local
> main coordinator.

- Rule: `standalone` (no controller) in `routeCoordinatorNotice`. A command
  node has no controller, so it takes the same path.
- Tests: hierarchy "a standalone machine's notice reaches its own
  coordinator"; the command-node side of every leaf test above delivers to that
  node's local main.

### AC5

> A notice for a repo with no running main coordinator session creates one and
> delivers to it; with one running, it wakes that session and creates nothing.

- Code: `CoordinatorNoticeRouter` → `coordinator-service.ts`
  `ensureMainConversation`.
- Tests: hierarchy "a notice with no main coordinator running › creates one and
  delivers to it", "› with one running it wakes that one and creates nothing",
  "› a project that never had a coordinator gets its first one";
  "acceptance audit regressions › a later stop after the woken main closed
  starts one and files it without a wake"; sources "standalone, a new event
  with no main running starts one".

### AC6

> Two notices arriving together for a repo with no session create only one
> session.

- Tests: hierarchy "two notices together create only one session"; "with no
  main running one is created, once, for stops arriving together".

### AC7

> A startup sweep of older state creates no session, and a machine-wide notice
> with no repo creates no session.

- Code: `createSession: false` on sweep and backfill notices in
  `coordinator-status-wakes.ts` and `coordinator-pr-watches.ts`;
  `machineWide` notices are never created for.
- Tests: hierarchy "a sweep of older state creates nothing and takes no
  delivery", "a machine-wide notice creates nothing", "older state with no
  coordinator open waits on the leaf rather than creating one", "a stop whose
  window ended before the restart starts no session"; sources "a sweep of older
  state starts nothing, and sends it when one opens", "a sweep on a leaf tells
  the command node not to start anything either", "the first sweep after a
  restart compares older state, so it starts nothing".

### AC8

> A session stopping on a usage limit produces a notice naming the session,
> machine, repo, account, reset time when known, and whether it will resend or
> wait. This holds for a user-started native tab, a delegated worker and a
> pipeline worker.

- Sources of stops: `AgentAccountAutoSwitcher.handleLimitStop` and
  `noteUnresentStop` (`agent-accounts-auto-switch.ts`) call `onLimitStop`,
  wired in `index.ts` to `usageLimitNotices.noteStop`. Native tabs report from
  `native-agent-usage-limit-resend.ts`; pipeline and review workers report
  through `usageLimitStop` (`build-pipeline-service-supervisor.ts` passes the
  session label; `native-agent-provider.ts` covers providers without accounts).
- Rendering: `packages/protocol/src/coordinator-notices.ts` names the session
  kind and name, tab, environment, machine, node, repository, account, reset
  time or hint, and the next step (resend, wait, stop).
- Tests: hierarchy "a session stopped on a usage limit › a user-started tab
  produces a notice naming what happened" and "› a pipeline worker produces a
  notice naming what happened" (session kind, environment, machine, repository,
  account, reset time, waiting); "a delegated worker is named as one, and its
  reset hint stands in for a time" (resend); "a worker this command node
  delegated to a leaf is named as one"; `native-agent-usage-limit-resend.test.ts`
  "a stop nothing here will resend still gets reported";
  `agent-accounts-auto-switch.test.ts` "reports the account the turn ran on, the
  reset and the verdict, once", "a stop that waits is reported as waiting, when
  the wait starts and not again".

### AC9

> Stops on one account within one reset window coalesce into a single wake
> that lists the sessions.

- Code: account-and-window groups in `coordinator-usage-limit-notices.ts`,
  ledger in `storage-coordinator-notices.ts`.
- Tests: hierarchy "stops on one account in one window share one wake that
  lists them", "another account, or the next window, gets its own wake", "large
  UTF-8 windows chunk mail and overflow retains one wake".

### AC10

> A transient limit the provider retries while the session continues produces
> no notice.

- Code: only a failed turn whose error `classifyUsageLimitError` recognises is
  reported.
- Tests: `native-agent-usage-limit-resend.test.ts` "not a turn that completed
  after the provider retried a transient limit"; `agent-accounts-auto-switch.test.ts`
  "an error that is not a usage limit, such as a transient 429, reports
  nothing".

### AC11

> A notice raised while the leaf's link is down arrives once after reconnect,
> and survives a backend restart on the leaf in between.

- Code: durable leaf outbox (`nodes/node-mail.ts`), collected by
  `nodes/node-mail-collector.ts`.
- Tests: hierarchy "the link › a notice raised while the link is down arrives
  once, across a leaf restart"; "a leaf session's stop › raised while the link
  is down, it arrives once after a restart and reconnect"; "a machine-wide
  notice on a leaf › goes through the outbox once and survives the link being
  down".

### AC12

> Retries, restarts and reconnects produce no duplicate notice.

- Code: durable request ids per notice and per stop group; a retried notice in
  the leaf outbox keeps its first rendering (`nodes/node-mail.ts`).
- Tests: hierarchy "a lost acknowledgement delivers again and finds it already
  placed", "a retry and a restart raise no second notice", "a stop grouped
  before a restart is still sent after it, once", "a lost acknowledgement does
  not list the stop twice", "a retry with changed words stays in the outbox and
  reaches one coordinator"; `agent-accounts-auto-switch-notices.test.ts` "the
  same switch reaches a coordinator under one request id, so a retry cannot
  repeat it".

### AC13

> When the receiving coordinator runs on the limited account, including one
> matched across machines by identity, a switch to an account with headroom is
> attempted before it runs, without pinning.

- Code: `coordinator-usage-limit-notices.ts` compares
  `coordinatorAccountKey` with the group's key (provider plus email,
  `usageLimitAccountKey` in the protocol), then calls `moveOff` →
  `AgentAccountAutoSwitcher.moveOffLimitedAccount`, the automatic path that
  never pins. Production callbacks: `coordinator-usage-limit-account-routing.ts`.
- Tests: hierarchy "a coordinator on the limited account › moves first, without
  being told twice, and then runs", "› matches the same login under another
  machine's entry", "› on another account nothing moves"; "a command node's
  coordinator on that login moves, matched across machines";
  `coordinator-usage-limit-account-routing.test.ts`; `agent-accounts-auto-switch.test.ts`.

### AC14

> When no switch is possible (no account with headroom, explicit pin, or
> auto-switch off), the notice is kept, no turn is started on the limited
> account, and the reason is recorded.

- Code: a refused move returns `kept` with its reason; the notice is filed
  `stored` with `placementReason: "coordinator-on-limited-account"`, the
  ledger keeps `keptReason`, and the body says why.
- Tests: hierarchy "no-account-with-headroom / account-pinned / auto-switch-off
  keeps the notice, starts no turn and says why"; "a bridge whose live work
  holds it on the limited login keeps the notice" (`coordinator-busy`).

### AC15

> A coordinator's own limit stop does not notify itself; a leaf coordinator's
> goes to the command node coordinator for that repo when there is one.

- Tests: hierarchy "a coordinator's own stop › does not notify itself, and
  attempts the move", "› on a leaf goes to the command node's coordinator for
  that repository", "› on a leaf without the command node having the
  repository, it stops with the move", "› a side agent's stop reaches its
  main"; `native-agent-usage-limit-resend.test.ts` "a coordinator's own turn,
  whose queue is not held for it".

### AC16

> Upward notices do not use the pair budget and are not lost when it is
> exhausted.

- Code: coordinator notices ride the leaf outbox as their own item kind and
  are delivered by `CoordinatorNoticeRouter` without the node link's pair
  budget (`coordinator-notice-router.ts`, `nodes/node-mail.ts`). A relayed
  status notice is charged to its own resource budget, namespaced by node
  (`statusBudgetKey`, `storage-agent-mail-budgets.ts`).
- Tests: hierarchy "the pair budget › upward notices do not use it and are not
  lost when it is exhausted".

### AC17

> An older command node falls back to the local coordinator, gated by a backend
> capability.

- Code: capability `coordinatorNotices` in
  `packages/protocol/src/backend-profile.ts`; the router uses only controllers
  that advertised it (`older-command-node` route).
  `docs/architecture/version-compatibility.md` records it.
- Tests: hierarchy "an older command node leaves notices with the leaf's
  coordinator", "an older leaf is never sent the new collect key", "a command
  node downgraded with notices queued hands them back to the leaf".

### AC18

> The architecture docs for coordinators, accounts, messaging and command
> nodes describe the hierarchy and session creation, and the old comments
> saying notices do not start a coordinator are corrected.

- Docs: `docs/architecture/coordinator.md` ("Who hears a notice", "Usage-limit
  stop notices", "Status wakes"), `agent-accounts.md`, `agent-messaging.md`
  (Node mail), `command-nodes.md` (Leaf mode), `version-compatibility.md`.
- Comments: `coordinator-status-wakes.ts` `deliver` and
  `coordinator-pr-watches.ts` now say a new event with no main running starts
  one and a sweep does not. The only remaining "starts no coordinator" text is
  about machine-wide auto-switch notices, which by the ticket's default 6 do
  not create sessions.

## Not verified live

Real provider usage limits and a real two-machine command-node link were not
exercised. To check live, on throwaway `dev:test` profiles:

1. Link a leaf profile to a command-node profile that has the same
   repository.
2. On the leaf, run a native tab, a delegated worker and a pipeline worker on
   one provider account, then let that account reach its weekly limit.
3. Confirm the command node's main coordinator gets one notice listing all
   three sessions, and the leaf's coordinator gets none.
4. Repeat with the command node's coordinator on the same login (same email,
   different entry) and confirm the command node moves accounts before the
   coordinator's turn.
5. Repeat with the link down and the leaf backend restarted before reconnect.
   Confirm the notice arrives once.
