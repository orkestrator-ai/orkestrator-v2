# Interaction test matrix gaps

Checked against `main` at `00a0cb82` (2026-10-25). Worked on
`todo-0162-interaction-test-matrix-gaps-aad7b1f9a6f1` from `863b5782`
(2026-10-27): every code item is done, and the OpenCode abort item turned
into a behaviour change. Finished on
`todo-0162-interaction-test-matrix-b84e65a019ca` from `79f3bc97`
(2026-10-29): the backend mapping suite is split by provider, and the live
OpenCode abort check passed against the pinned CLI. Nothing is left.

## Task analysis

Analysed 2026-10-27 against main at `863b5782`.

Statuses re-checked 2026-10-29 against main at `79f3bc97`. The analysis
was written against the commit before the work landed (#1332), so its
statuses were stale; the line references in the subsections below are from
`863b5782`.

### Tasks

1. **Per-kind expiry on shared timers**: code item 1, expiry tests for Claude, Codex, Grok and Pi kinds that are timed only through another kind. Status: done (2026-10-27).
2. **`mcp-url` expiry**: code item 2, on Claude and Codex. Status: done (2026-10-27).
3. **Backend mapping fixtures**: code item 3, for Claude `file-approval`, Grok's generic `permission` and a Pi-shaped approval. Status: done (fixtures 2026-10-27; suite split by provider 2026-10-29).
4. **Bridge-route coverage**: code item 4, for Claude, Grok and Pi route cells. Status: done (2026-10-27).
5. **OpenCode abort rejects pending requests**: code item 5. Status: done (code change and tests 2026-10-27; live check against the pinned CLI 2026-10-29).
6. **OpenCode deadline**: the open question, whether an OpenCode permission or question gets a backend-enforced deadline. Status: done (decided no; no code).

### 1. Per-kind expiry on shared timers

**Problem.** Several interaction kinds rely on a timer that only another kind's test exercises. A regression in a kind-specific branch (for example the deny payload for a file change) would pass the suite.

**Context.** The audit for 0001 found these gaps. AGENTS.md invariant 10 requires a timeout to deny.

**Investigation.** None of the owning tests has changed since the audit except in `b52267c2`, the same day.
- Claude: `bridges/claude-bridge/src/services/session-manager-parked-interactions.test.ts:370` ("denies an unanswered approval after five minutes") uses `Bash` only. File edits are parked and declined at `:313`, but not timed out.
- Codex: `bridges/codex-bridge/src/app-server/server-request-router.test.ts:465` times out `item/commandExecution/requestApproval` only. `fileChange` and `permissions` requests appear at `:125-285` for other behaviour.
- Grok: `bridges/acp-bridge/src/acp-request-expiry.test.ts:1-38` covers `permission`, `question` and `plan`. Its permission fixture is one `write_file` edit-kind call with no detail, so command approvals and file approvals with detail are still missing.
- Pi: `bridges/pi-bridge/src/interactions-gate.test.ts:108` ("denies a call nobody answered before it expired") uses a single mutating call. Pi advertises `file-approval` under `ask` (`bridges/pi-bridge/src/public.ts:289`).

**Decisions.**

- **One parametrised test per bridge, or a shared conformance suite?**
  - **Parametrise each bridge's existing expiry test over its kinds (recommended).**
    - Pros: small, local diffs; reuses each bridge's harness; closes every listed cell.
    - Cons: the matrix stays spread over five files, and a new kind can be missed again.
  - **Build a cross-bridge interaction conformance suite.**
    - Pros: one place that proves park, render, resolve and fail-closed timeout for every kind.
    - Cons: much larger; each bridge's harness differs (SDK callbacks, JSON-RPC, ACP, Pi gate), so it needs adapters.

### 2. `mcp-url` expiry

**Problem.** Only form-mode elicitations have an expiry test on Claude and Codex.

**Context.** Codex marks MCP elicitations `upstreamMayExpire` (`server-request-router.ts:826`), which affects how a pause is described.

**Investigation.** Claude's expiry test is form-only (`session-manager-parked-interactions.test.ts:109`). Codex's expiry test uses a question (`server-request-router.test.ts:834`). URL descriptors are tested for shape in `bridges/codex-bridge/src/app-server/interactions.test.ts:398` and `:423`, not for expiry.

**Decisions.**

- **Is this a separate test or a parameter?**
  - **Add `url` as a parameter of the existing form expiry tests (recommended).**
    - Pros: a two-line change per bridge; same assertions (cancel, never accept).
    - Cons: none of substance.
  - **Leave it, since URL and form share the path.**
    - Pros: no work.
    - Cons: the cell stays unproved, which is why the file exists.

### 3. Backend mapping fixtures

**Problem.** The backend mapper has no fixture for a Claude `file-approval`, Grok's generic `permission`, or a Pi-shaped approval.

**Context.** `apps/backend/src/core/agent-provider-interactions.test.ts` covers mapping and resolve.

**Investigation.** That suite uses the default Claude connection, `codexConnection` (5 cases) and `grokConnection` (2 cases), and never `piConnection`. Claude's mixed fixture (`:384`) has `mcp-form`, `mcp-url`, `command-approval` and `permission`, but no `file-approval`. A Pi connection appears only in `agent-provider-interaction-holds.test.ts:217`.

**Decisions.**

- **Where do the fixtures go?**
  - **Add them to `agent-provider-interactions.test.ts` beside the existing per-provider cases.**
    - Pros: one owning file for mapping; follows the existing pattern.
    - Cons: the file is at 1,972 lines, so three fixtures would push it past the 2,000-line limit.
  - **Split the suite by provider first, then add the fixtures to the matching file (recommended).**
    - Pros: keeps every file under the limit; each provider's mapping is in one place.
    - Cons: a larger diff (a move plus the new fixtures).

### 4. Bridge-route coverage

**Problem.** Some kinds are not exercised through their bridge's HTTP routes.

**Context.** The route is what the backend and the rehydration path actually call.

**Investigation.**
- Claude: `bridges/claude-bridge/src/routes/session-interactions.test.ts:136-140` parks a URL elicitation as a sibling of a form, and cancels it, through the route. Listing `mcp-url`, `file-approval` and `permission` through `GET /session/:id/interactions` is still not asserted.
- Grok: plan approval is parked and resolved at the process level (`bridges/acp-bridge/src/acp-session-process.test.ts:126`), not through HTTP.
- Pi: `bridges/pi-bridge/src/http.test.ts:2932` calls `requestToolApproval` for `bash` only.

**Decisions.**

- **How much of item 4 is needed?**
  - **All listed cells, done together with items 1 and 3 so each bridge is touched once (recommended).**
    - Pros: one pass per bridge.
    - Cons: a larger change to review.
  - **Only the cells that have a kind-specific branch in the route.**
    - Pros: less test code.
    - Cons: needs a per-cell judgement, which the audit was meant to avoid.

### 5. OpenCode abort rejects pending requests

**Problem.** No test shows that aborting an OpenCode turn rejects its pending permissions and questions.

**Context.** Close already does this, explicitly, and it is tested (`apps/backend/src/core/opencode-provider-close.test.ts:51`, "rejects pending permissions and questions of the closed session only").

**Investigation.** New finding: abort does not reject them in Orkestrator's code. `OpenCodeProvider.abort` (`apps/backend/src/core/opencode-provider.ts:1354-1360`) calls the broker's `abort` (`apps/backend/src/core/opencode-workflow-result-broker.ts:275-306`). That only calls `client.session.abort`, ends the turn and settles the workflow result. Whether pending requests are rejected depends on OpenCode's server. So item 5 is not just a missing test: if OpenCode leaves them pending, a card could outlive its turn.

**Decisions.**

- **Test upstream behaviour, or reject explicitly?**
  - **Reject pending permissions and questions explicitly on abort, with the close path's helper, and test it (recommended).**
    - Pros: does not depend on OpenCode's server; matches close; a fake SDK client is enough for the test.
    - Cons: a code change, not only a test; double rejection must stay harmless (close already treats "answered between read and rejection" as success, `opencode-provider-close.test.ts:105`).
  - **Only test that OpenCode rejects them on abort, live or against a real `opencode serve`.**
    - Pros: no code change if upstream already does it.
    - Cons: needs a live server; behaviour can change with any OpenCode bump.

### 6. OpenCode deadline

**Problem.** OpenCode publishes no deadline, so an unanswered OpenCode request in an interactive tab waits until the user answers, the session closes or the turn is aborted.

**Context.** The backend never enforces a deadline; each bridge times out on its own (`apps/backend/src/core/native-agent-interaction-tracker.ts`). OpenCode has no bridge; its interactions are mapped in `apps/backend/src/core/opencode-interactions.ts`, unchanged since `3b2cf141`. Unattended sessions are answered by the owner's policy straight away.

**Investigation.** It fails closed today (it never approves). The cost is a tab that stays `waiting` indefinitely, which is what an interactive user expects.

**Decisions.**

- **Add a backend deadline for OpenCode?**
  - **No; record the decision and close the question (recommended).**
    - Pros: never approves; unattended runs are already answered by policy; it matches a blocking question elsewhere, which has no deadline either.
    - Cons: a forgotten tab keeps an environment `waiting`.
  - **Yes, a backend timer that rejects after the shared default.**
    - Pros: parity with the bridges' 5-minute window.
    - Cons: the first backend-enforced deadline, with new pause and hold semantics to build and test.

Found by the "Needs verification" item of
[0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md),
which asked whether every bridge has per-kind tests for park, render, resolve
and fail-closed timeout. The audit on 2026-10-25 found tests for most cells;
the cells below had none. Writing them found two real gaps: OpenCode's abort
left pending requests answerable, and the HTTP bridge adapter reported a
session grant that Pi or an ACP bridge had turned into a denial as applied.
Both are fixed (decisions 1 and 2).

## Current state

- There is no interaction conformance suite. Each bridge tests its own
  kinds, and `apps/backend/src/core/agent-provider-interactions.test.ts`
  and its per-provider siblings (`agent-provider-interactions-{claude,codex,
  grok,pi,opencode}.test.ts`) cover the backend mapping and resolve paths.
  Every kind each bridge emits now has a park, resolve and fail-closed
  expiry test of its own.
- The backend never enforces a deadline; each bridge denies on its own
  timer (`native-agent-interaction-tracker.ts`).
- OpenCode publishes no deadline at all (`opencode-interactions.ts`), so an
  unanswered OpenCode question or permission waits until the user answers,
  the session closes or the turn is aborted. It never approves. Abort and
  close both reject what is still pending
  (`rejectPendingOpenCodeRequests` in `opencode-session-close.ts`).
- OpenCode's capability row claimed `command-approval` and `file-approval`,
  which its mapper never emits; corrected to `question` and `permission` on
  2026-10-25.
- `HttpBridgeInteractionAdapter.resolveInteraction` refuses
  `approve-for-session` on a card without `approveForSessionLabel` before
  anything reaches the bridge. Only Codex approvals offer it.

## Outstanding work

### Code

1. ~~**Timeouts for every kind on a shared timer.**~~ Done 2026-10-27. Each
   test runs the timer to one millisecond short of the deadline, then to it,
   and checks the request is denied, never approved:
   - Claude: `denies an unanswered {command-approval,file-approval,permission}
     after five minutes` (`session-manager-parked-interactions.test.ts`), with
     the `interaction.resolved` timeout event and the turn left running.
   - Codex: `an unanswered {item/fileChange/requestApproval,
     applyPatchApproval,item/permissions/requestApproval} expires as a denial
     in its own shape` (`server-request-router.test.ts`, on the manual clock):
     `decline`, the legacy `denied` object, and an empty turn-scoped grant.
   - Grok: `acp-request-expiry.test.ts` now parks a `command` (execute with a
     command) and a `file-change` (edit with a path) beside the detail-less
     `permission`, checks the published kind, and expects `cancelled` at five
     minutes for each.
   - Pi: `denies a {edit,write} nobody answered before it expired`
     (`interactions-gate.test.ts`).
2. ~~**`mcp-url` expiry** on Claude and Codex.~~ Done 2026-10-27. Claude:
   `an unanswered {form,url} elicitation is cancelled after five minutes`.
   Codex: `an unanswered MCP url sign-in is cancelled at its deadline`
   (`{ action: "cancel", content: null }`).
3. ~~**Backend mapping fixtures.**~~ Done 2026-10-27; the suite they were
   added to grew to 2,213 lines, so on 2026-10-29 it was split by provider
   (decision 6), and each fixture now sits in its provider's file:
   - `Claude maps a file approval with its paths and answers it exactly`
     (`agent-provider-interactions-claude.test.ts`): title, `File:` lines,
     accept and decline bodies.
   - `Grok maps a call without command or file detail to a generic
     permission` (`agent-provider-interactions-grok.test.ts`): option
     question, no body, `optionId`/`deny`/`cancel` bodies, a session grant
     refused.
   - `Pi approvals map through the Codex shapes and answer with a decision`
     (`agent-provider-interactions-pi.test.ts`):
     the exact `publicApprovals` payload (command, file change, pathless
     file change), confirm disabled for the pathless one, no session grant,
     `approve`/`deny` bodies.
4. ~~**Bridge-route coverage.**~~ Done 2026-10-27.
   - Claude: `lists a url sign-in, a file approval and a permission, and
     answers each` (`routes/session-interactions.test.ts`), through the
     bridge's real app.
   - Grok: new `acp-interaction-answer-routes.test.ts` over the real ACP
     router: plan approvals answered `approve`, `revise` with feedback and
     `abandon` reach Grok as `approved`, `cancelled` with feedback and
     `abandoned`; any other action leaves the plan unapproved; a repeat is
     404. A file change listed with its paths and approved by `optionId` and
     by `decision` selects the allow option.
   - Pi: `parks a {edit,write} as a file approval and runs it once allowed`
     (`interactions-gate.test.ts`), through `requestToolApproval` and
     `publicApprovals`.
5. ~~**OpenCode abort.**~~ Done 2026-10-27, with a behaviour change: abort
   did not reject anything, only close did. `OpenCodeProvider.abort` now
   calls `rejectPendingOpenCodeRequests` after stopping the turn (decision
   1). Tests: `OpenCode abort fails closed on pending requests`
   (`opencode-provider-close.test.ts`): only the aborted session's requests
   are rejected, nothing is deleted, an unreadable or unrejectable request
   fails the abort, a 404 rejection is not a failure, and a failed abort
   rejects nothing.

### Qualification

- None left. The OpenCode abort check passed on 2026-10-29 (see "Needs
  verification").

## Constraints and rationale

- Approvals fail closed: a timeout, disconnect or malformed answer denies
  (AGENTS.md invariant 10).

## Open questions

- ~~Should OpenCode get a backend-enforced deadline, so an unattended
  OpenCode session cannot wait forever on a permission?~~ No (decision 3).

## Needs verification

- ~~**OpenCode abort with a pending permission and question, live.**~~
  Passed 2026-10-29 (decision 8). `opencode-provider-abort.live.test.ts`
  ran with `RUN_LIVE_OPENCODE_COMPATIBILITY=1` against the pinned
  `opencode-ai@1.19.4` CLI (installed into a temporary directory; the host's
  own CLI is 1.19.3), a scripted loopback model and a disposable
  `HOME`/XDG profile. A turn parked a `bash` permission and a question in
  the same turn. After `OpenCodeProvider.abort` stopped the turn, OpenCode
  still held both, so the explicit rejection is what retires them:
  `permission.reply` and `question.reject` each answered 200. A stale
  card's later answer got 404, and in the 404 race (another responder
  rejects first) abort still succeeds. Not run: Stop pressed in the app UI
  with a real model; the provider path the button calls is the one
  exercised.

## Assumptions and decisions

The first worker made decisions 1 to 5 on 2026-10-27. Decisions 6 to 9
were made on 2026-10-29. For every task the first worker took the option
the Task analysis marks (recommended), except task 3's split, which
decision 6 completes.

### 1. OpenCode abort rejects pending requests explicitly (task 5)

The item assumed abort already rejected them "as closing the session
already does"; it did not. Options: (a) pin today's behaviour (abort leaves
them for the server); (b) reject them on abort the way close does, failing
the abort when they cannot be read or rejected; (c) reject them
best-effort, logging failures. Chose (b), the recommended option, sharing
close's code (`rejectPendingOpenCodeRequests`). Pros: a request answered
after Stop can no longer grant something to a turn nobody is running, which
is what invariant 10 asks; one implementation for both paths. Cons: one
more list call pair per abort; if OpenCode answers a rejection after abort
with something other than 200 or 404, Stop reports an error although the
turn did stop. (c) would hide exactly the failure that leaves a request
answerable. Decision 8 confirms the pinned CLI answers 200 and 404.

### 2. Refuse `approve-for-session` on a card that offers none (found by task 3)

The Pi fixture showed the adapter forwarding it: Pi denies any decision
other than `approve`, and the ACP path sends `deny`, yet the adapter
reported `applied`. The UI and the public action already refuse it (they
read `approveForSessionLabel`), so only an internal caller could reach
this. Options: (a) leave it and document it in the test; (b) refuse it in
`resolveInteraction` for every HTTP bridge when the card has no
`approveForSessionLabel`. Chose (b). Pros: the reported outcome is true;
one check covers Pi, Grok and Cursor; no provider call is made. Cons:
Claude's own refusal in `httpResolutionTarget` is now unreachable; it is
kept as the reason Claude never offers the label.

### 3. No backend deadline for OpenCode (task 6)

Options: (a) a backend timer that rejects an OpenCode request after the
shared default window; (b) none. Chose (b), the recommended option.
Unattended sessions never wait: the owner's policy answers their requests
at once. An interactive tab waits only while its user can see the card,
and Stop and close now reject what is left. Pros: no second timer to keep
in step with OpenCode's own state; no request is rejected while its user
is reading it. Cons: parity gap with the other providers, whose bridges
deny after five minutes; a tab left open with a pending card keeps its turn
waiting until someone acts. Re-checked on 2026-10-29 (decision 9).

### 4. Tests live in each bridge's existing files (tasks 1, 2 and 4)

Options: a cross-bridge conformance suite, or each bridge's existing test
file. Chose the existing files, the recommended option (plus one new Grok
route file beside `acp-interaction-hold.test.ts`), parameterised over kinds
where one test already proved the shared timer, with `url` added as a
parameter of the form expiry tests (task 2's recommended option). All of
task 4's cells were done in the same pass. Pros: each test sits next to
the code and harness it exercises; no new shared fixtures across packages.
Cons: the matrix stays spread over seven files; a conformance suite would
show missing cells at a glance.

### 5. Codex expiry on the manual clock (task 1)

The existing Codex expiry tests sleep against a 50 ms window. The new ones
use the `pausing a parked deadline` manual clock instead, so they cannot
flake on a busy host.

### 6. Split the backend mapping suite by provider (task 3)

The first worker added the three fixtures to
`agent-provider-interactions.test.ts`, the option the analysis said would
push it past the 2,000-line limit; it reached 2,213 lines. Chose the
recommended option after the fact: split it by provider. The Claude,
Codex, Grok, Pi and OpenCode cases moved verbatim to
`agent-provider-interactions-{claude,codex,grok,pi,opencode}.test.ts`.
The registration, snapshot-bound, tracker-bound and write-reconciliation
cases that span providers stay in `agent-provider-interactions.test.ts`.
`HTTP bridge questions remain pending without a provider write` uses the
Codex connection, so it moved with Codex. All 33 tests are kept, and every
file is under 650 lines. Pros: each provider's mapping is in one place; a
new fixture no longer reopens the limit. Cons: a move-only diff. References
in 0001 and 0160 now point at the split files.

### 7. Verify rather than redo (all tasks)

The brief for this pass listed all six tasks as open, following the Task
analysis. The code showed #1332 had already landed every item, so this
pass checked each named test against the code and re-ran the suites
instead of writing them again. It acted only on the gaps it found
(decisions 6 and 8).

### 8. Run the OpenCode abort check with a scripted model (task 5)

"Needs verification" asked for a live tab with a model login. The live test
from #1332 needs no credentials: a scripted loopback model, a disposable
`HOME`/XDG profile and the pinned CLI. It asserts the pinned SDK version,
so it ran against `opencode-ai@1.19.4` installed into a temporary
directory, not the host's 1.19.3. It read no user settings or logins. It
answers what the item asked: which statuses OpenCode returns for requests
whose turn was just aborted. The UI path was not driven; Stop calls the
same `abort`.

### 9. Keep task 6 closed with no code (task 6)

Took the recommended "no deadline". Nothing in the code argues against it:
`opencode-interactions.ts` still publishes no `expiresAt`; unattended
OpenCode sessions are answered by policy; Stop and close reject what is
left, and the live run in decision 8 shows OpenCode would otherwise keep
them pending. A backend timer would be the first backend-enforced deadline,
and would need new pause and hold semantics for no fail-closed gain.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md)
  ("Needs verification").

## Replaces

- The first "Needs verification" item of 0001.
