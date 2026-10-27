# Interaction test matrix gaps

Checked against `main` at `00a0cb82` (2026-10-25).

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
these are the cells without one. No behaviour is known to be broken: every
gap below shares code with a kind that is tested.

## Current state

- There is no interaction conformance suite. Each bridge tests its own
  kinds, and `apps/backend/src/core/agent-provider-interactions.test.ts`
  covers the backend mapping and resolve paths.
- The backend never enforces a deadline; each bridge denies on its own
  timer (`native-agent-interaction-tracker.ts`).
- OpenCode publishes no deadline at all (`opencode-interactions.ts`), so an
  unanswered OpenCode question or permission waits until the user answers,
  the session closes or the turn is aborted. It never approves.
- OpenCode's capability row claimed `command-approval` and `file-approval`,
  which its mapper never emits; corrected to `question` and `permission` on
  2026-10-25.

## Outstanding work

### Code

1. **Timeouts for every kind on a shared timer.** Add expiry tests for the
   kinds whose timer is tested only through another kind: Claude
   `file-approval` and `permission` (the Bash test in
   `session-manager-parked-interactions.test.ts`), Codex `file-approval` and
   `permission` (`server-request-router.test.ts`), Grok `command-approval`
   and `file-approval` with detail (`acp-request-expiry.test.ts`), and Pi
   `file-approval` (`interactions-gate.test.ts`).
2. **`mcp-url` expiry** on Claude and Codex; only form mode has an expiry
   test.
3. **Backend mapping fixtures** for Claude `file-approval`, Grok's generic
   `permission`, and a Pi-shaped approval (Pi goes through the Codex mappers
   with no Pi fixture).
4. **Bridge-route coverage**: Claude `mcp-url`, `file-approval` and
   `permission` listed through `GET /session/:id/interactions`; Grok
   plan-approval resolved through its HTTP route and a positive Grok
   file-approval resolve; Pi `file-approval` parked and resolved through
   `requestToolApproval`.
5. **OpenCode abort**: a test that aborting a turn rejects its pending
   permissions and questions, as closing the session already does
   (`opencode-provider-close.test.ts`).

### Qualification

- None; these are unit tests.

## Constraints and rationale

- Approvals fail closed: a timeout, disconnect or malformed answer denies
  (AGENTS.md invariant 10).

## Open questions

- Should OpenCode get a backend-enforced deadline, so an unattended OpenCode
  session cannot wait forever on a permission? Today the owner's policy
  answers it at once, so only an interactive tab waits.

## Needs verification

- None.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md)
  ("Needs verification").

## Replaces

- The first "Needs verification" item of 0001.
