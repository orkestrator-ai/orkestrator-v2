# Linear board labels and the `merged` label: live checks

## Task analysis

Analysed 2026-11-16 against main at `da2561021`. Created by the build that
added label chips to the Linear board's cards and the `merged` label on a
Linear-sourced build's issue when its pull request merges
([Linear](../../architecture/tickets.md#linear),
[Merged builds label their issue](../../architecture/tickets.md#merged-builds-label-their-issue)).
Both behaviours are built and covered by deterministic tests against a faked
Linear API; what is left needs the user's real Linear workspace, which agents
may not use. Task 3 was added on 2026-11-24 by the build that gives agents and
the Linear tab an issue's files
([Linear files](../../architecture/tickets.md#linear-files)). Task 4 was added on
2026-11-25 by the build that lets a command node write what a machine without
a Linear key owes
([Builds on a machine without Linear](../../architecture/tickets.md#builds-on-a-machine-without-linear)).

### Tasks

1. **Board cards against the user's real labels.** Status: open (blocked: waits on 7568 item "8174 task 1").
2. **A real merge labels its issue in the user's real workspace.** Status: open (blocked: waits on 7568 item "8174 task 2").
3. **An issue's files from the user's real workspace.** Status: open (blocked: waits on 7568 item "8174 task 3").
4. **A build on a machine without Linear labels and comments through the command node.** Status: open (blocked: waits on 7568 item "8174 task 4").

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
`environments/delete-tickets.test.ts`). Field names (`isGroup`,
`eqIgnoreCase`, `issueAddLabel`) were taken from Linear's published schema,
not from a live call.

**Context.** The PR monitor, the build itself, environment deletion and a
startup sweep (retrying incomplete scans) queue the label; the drain retries a failure from one
minute, doubling to an hour, until it lands.

**Investigation.** Read from the production log and store of arktech-mini on
2026-11-25: real merges of Linear-sourced builds logged
`merged-label.applied` with `created` (DND-104, 2026-11-16), `added`
(DND-98, 100 to 103 and 107) and `already-present`, so Linear accepts the
queries. Not observed: that the issues' other labels were kept, and that a
pull request closed without merging adds nothing. If Linear rejects a query
field, every attempt fails with Linear's message in
`[linear] merged-label.failed`, the record stays pending, and the fix is a
query change here.

**Decisions.**

- **What to do if the live run fails.**
  - **Fix the query or mutation from Linear's error message and keep the queue as built (recommended).**
    - Pros: pending records land on the next retry after the fix ships; no data is lost.
    - Cons: labels are late until then.
  - **Disable the feature until fixed.**
    - Pros: no failing requests every hour.
    - Cons: merges seen meanwhile would never be labelled.

### 3. An issue's files from the user's real workspace

**Problem.** Downloading from `uploads.linear.app` and reading signed links
have only run against fakes (`apps/backend/src/core/linear-files/*.test.ts`,
`LinearIssueFiles.test.tsx`).

**Context.** The key is sent to the file host as the API takes it, in the
`Authorization` header. Signed links come from the `public-file-urls-expire-in`
header on the issue read, matched to the plain link by path.

**Investigation.** Linear's file-storage page (read 2026-11-24) says the file
host takes the same `authorization` header as the API and that the header signs
every file link in a response. Its one example is an OAuth bearer token, and it
mentions neither redirects nor size limits. Nothing was run live.

**Decisions.**

- **What to do if the file host refuses a personal API key.**
  - **Download through a signed link the backend reads for itself (recommended).**
    - Pros: the same issue read already returns one; the key then goes to the API only.
    - Cons: one more dependency on Linear's signing.
  - **Ask for an OAuth connection.**
    - Pros: the documented example.
    - Cons: a new sign-in flow for something the existing key may already allow.

### 4. A build on a machine without Linear labels and comments through the command node

**Problem.** The relay has run only between two real storage services with a
faked Linear API (`apps/backend/tests/linear-two-machines.test.ts`), not
between two of the user's machines and their workspace.

**Context.** It needs the fixed build on both the command node and the build
machine. Labels already pending on a build machine land by themselves once
both are updated; completion comments that failed before the update and went
with their environment were never kept and cannot be recovered.

**Investigation.** On 2026-11-25 beelink held one pending label (DND-97, pull
request 102) after 55 attempts, each failing with "Linear is not connected on
this machine". beelink2 and the other build machines could not be read.

**Decisions.**

- **What to do if the live run fails.**
  - **Read `[linear] relay.failed` or `relay.write-failed` on the command node and fix from its reason (recommended).**
    - Pros: what is owed stays queued and lands after the fix.
    - Cons: labels and comments are late until then.
  - **Connect Linear on each build machine.**
    - Pros: works today.
    - Cons: the key is then on every build machine.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md), "Cross-cutting": all four checks.
- [Linear](../../architecture/tickets.md#linear)
