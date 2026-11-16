# Linear board labels and the `merged` label: live checks

## Task analysis

Analysed 2026-11-16 against main at `da2561021`. Created by the build that
added label chips to the Linear board's cards and the `merged` label on a
Linear-sourced build's issue when its pull request merges
([Linear](../../architecture/tickets.md#linear),
[Merged builds label their issue](../../architecture/tickets.md#merged-builds-label-their-issue)).
Both behaviours are built and covered by deterministic tests against a faked
Linear API; what is left needs the user's real Linear workspace, which agents
may not use.

### Tasks

1. **Board cards against the user's real labels.** Status: open (blocked: waits on 7568 item "8174 task 1").
2. **A real merge labels its issue in the user's real workspace.** Status: open (blocked: waits on 7568 item "8174 task 2").

### 1. Board cards against the user's real labels

**Problem.** The board's label chips have only been rendered from fake data
(`LinearIssueBoard.test.tsx`) and a faked Linear list response
(`apps/backend/tests/linear.test.ts`). Whether a real workspace's colours,
long names and label counts look right is unobserved.

**Context.** `get_linear_issues` now asks Linear for each issue's labels with
`id name color` (at most 25 per issue) and returns them as `issueLabels`; the
card names four and folds the rest into `+N`. A colour that is not a hex value
gets a neutral dot.

**Investigation.** None beyond the tests: agents may not read the user's
Linear workspace.

**Decisions.**

- **Where the check runs.**
  - **The user's real workspace, from the manual-test checklist (recommended).**
    - Pros: real colours and label counts; nothing written to Linear.
    - Cons: needs the user.
  - **A throwaway workspace an agent is given a key for.**
    - Pros: an agent can run it.
    - Cons: no such key exists, and a fresh workspace has none of the label variety the check is about.

### 2. A real merge labels its issue in the user's real workspace

**Problem.** The label lookup, creation and `issueAddLabel` calls have only
run against a fake that mimics Linear's GraphQL answers
(`apps/backend/src/core/linear-merged-label.test.ts`,
`environment-delete-tickets.test.ts`). Field names (`isGroup`,
`eqIgnoreCase`, `issueAddLabel`) were taken from Linear's published schema,
not from a live call.

**Context.** The PR monitor, the build itself, environment deletion and a
startup sweep (retrying incomplete scans) queue the label; the drain retries a failure from one
minute, doubling to an hour, until it lands.

**Investigation.** None live. If Linear rejects a query field, every attempt
fails with Linear's message in `[linear] merged-label.failed`, the record
stays pending, and the fix is a query change here.

**Decisions.**

- **What to do if the live run fails.**
  - **Fix the query or mutation from Linear's error message and keep the queue as built (recommended).**
    - Pros: pending records land on the next retry after the fix ships; no data is lost.
    - Cons: labels are late until then.
  - **Disable the feature until fixed.**
    - Pros: no failing requests every hour.
    - Cons: merges seen meanwhile would never be labelled.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md), "Cross-cutting": both checks.
- [Linear](../../architecture/tickets.md#linear)
