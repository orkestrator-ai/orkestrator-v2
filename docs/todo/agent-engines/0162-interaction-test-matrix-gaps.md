# Interaction test matrix gaps

Checked against `main` at `00a0cb82` (2026-10-25). Worked on
`todo-0162-interaction-test-matrix-gaps-aad7b1f9a6f1` from `863b5782`
(2026-10-27): every code item is done, and the OpenCode abort item turned
into a behaviour change. One live check of that change is left (see "Needs
verification").

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Per-kind expiry on shared timers**: code item 1, expiry tests for Claude, Codex, Grok and Pi kinds that are timed only through another kind. Status: open.
2. **`mcp-url` expiry**: code item 2, on Claude and Codex. Status: open.
3. **Backend mapping fixtures**: code item 3, for Claude `file-approval`, Grok's generic `permission` and a Pi-shaped approval. Status: open (Pi has a fixture only in the holds suite).
4. **Bridge-route coverage**: code item 4, for Claude, Grok and Pi route cells. Status: partly done (a Claude URL elicitation reaches the route only as a cancelled sibling).
5. **OpenCode abort rejects pending requests**: code item 5. Status: open, and the code may not do it (see below).
6. **OpenCode deadline**: the open question, whether an OpenCode permission or question gets a backend-enforced deadline. Status: open.

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
  covers the backend mapping and resolve paths. Every kind each bridge emits
  now has a park, resolve and fail-closed expiry test of its own.
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
3. ~~**Backend mapping fixtures.**~~ Done 2026-10-27, in
   `agent-provider-interactions.test.ts`:
   - `Claude maps a file approval with its paths and answers it exactly`:
     title, `File:` lines, accept and decline bodies.
   - `Grok maps a call without command or file detail to a generic
     permission`: option question, no body, `optionId`/`deny`/`cancel`
     bodies, a session grant refused.
   - `Pi approvals map through the Codex shapes and answer with a decision`:
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

- None for the tests; the OpenCode abort change has one live check under
  "Needs verification".

## Constraints and rationale

- Approvals fail closed: a timeout, disconnect or malformed answer denies
  (AGENTS.md invariant 10).

## Open questions

- ~~Should OpenCode get a backend-enforced deadline, so an unattended
  OpenCode session cannot wait forever on a permission?~~ No (decision 3).

## Needs verification

- **OpenCode abort with a pending permission and question, live.** Start an
  interactive OpenCode tab under an `ask` policy with a throwaway OpenCode
  profile, let the turn raise a permission (and, separately, a question),
  press Stop, and record what `permission.reply` / `question.reject`
  answer for a request whose turn was just aborted. The code accepts 200 and
  404; any other status makes Stop report "OpenCode pending requests could
  not be rejected" even though the turn stopped. Not run here: it needs a
  model login, and this host's OpenCode logins are the user's own.

## Assumptions and decisions

Decisions made on 2026-10-27 while working through the file.

1. **What OpenCode abort does with pending requests (item 5).** The item
   assumed abort already rejected them "as closing the session already
   does"; it did not. Options: (a) pin today's behaviour (abort leaves them
   for the server); (b) reject them on abort the way close does, failing the
   abort when they cannot be read or rejected; (c) reject them best-effort,
   logging failures. Chose (b), sharing close's code
   (`rejectPendingOpenCodeRequests`). Pros: a request answered after Stop can
   no longer grant something to a turn nobody is running, which is what
   invariant 10 asks; one implementation for both paths. Cons: one more list
   call pair per abort; if OpenCode answers a rejection after abort with
   something other than 200 or 404, Stop reports an error although the turn
   did stop (the live check above). (c) would hide exactly the failure that
   leaves a request answerable.
2. **`approve-for-session` on a card that offers none (found by item 3).**
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
3. **No backend deadline for OpenCode (open question).** Options: (a) a
   backend timer that rejects an OpenCode request after the shared default
   window; (b) none. Chose (b). Unattended sessions never wait: the owner's
   policy answers their requests at once. An interactive tab waits only
   while its user can see the card, and Stop and close now reject what is
   left. Pros: no second timer to keep in step with OpenCode's own state;
   no request is rejected while its user is reading it. Cons: parity gap with
   the other providers, whose bridges deny after five minutes; a tab left
   open with a pending card keeps its turn waiting until someone acts.
4. **Where the new tests live.** Options: a cross-bridge conformance suite,
   or each bridge's existing test file. Chose the existing files (plus one
   new Grok route file beside `acp-interaction-hold.test.ts`), parameterised
   over kinds where one test already proved the shared timer. Pros: each
   test sits next to the code and harness it exercises; no new shared
   fixtures across packages. Cons: the matrix stays spread over seven files;
   a conformance suite would show missing cells at a glance.
5. **Codex expiry on the manual clock.** The existing Codex expiry tests
   sleep against a 50 ms window. The new ones use the `pausing a parked
   deadline` manual clock instead, so they cannot flake on a busy host.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md)
  ("Needs verification").

## Replaces

- The first "Needs verification" item of 0001.
