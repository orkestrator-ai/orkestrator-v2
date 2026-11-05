# Pi resume list: the timeout's reason, its size and the barrier test

Carried from efficiency report batch E21 (`docs/reports/efficiency-logging-database/0130-e21-pi-bridge.md`, findings BR-10 and BR-14), deleted on 2026-11-05. Read the file at `69a3b4ca5` for its full text and outcome table. The code for both parts is built; this is what the closing check could not confirm.

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

### Tasks

1. **Show the timeout's reason in the resume dialog**: the user sees "Failed to load sessions", not why. Status: open.
2. **Check a timed-out list in a real browser**: on a throwaway `dev:test` profile, desktop and narrow. Status: open (depends on 1).
3. **Measure how large a Pi history reaches the 30 s timeout**: Status: open.
4. **Test that a durability barrier rejects when the state cannot fit**: Status: open.

### 1. Show the timeout's reason in the resume dialog

**Problem.** Part `0130` chose a 504 with a short message so that "the message reaches the user through the existing path". The message reaches the renderer but is not shown.

**Context.** `bridges/pi-bridge/src/http.ts` answers a timed-out `/session/list` with 504 and `SESSION_LIST_TIMEOUT_MESSAGE` ("Pi took too long to read its session history", `agent-session.ts`). `assertOkWithErrorDetail` in `apps/backend/src/core/http-bridge-resumable-sessions.ts` passes it on as the error's message (test `a bridge's timed-out list reaches the caller as an error, not an empty list`, `apps/backend/src/core/http-bridge-provider-archive.test.ts`).

**Investigation.** `NativeResumeSessionDialog.tsx` catches any failure, logs it as `session-list.load-failed` and sets the fixed text "Failed to load sessions". Its test `surfaces a fetch failure instead of an empty list` expects that text. So the timeout is no longer hidden as an empty list, but the user cannot tell a slow history from a broken bridge. The dialog is shared by every native platform (`AgentNativeTab.controller.tsx`), so a change applies to all of them. Whether the error's message survives the backend command and the gateway unchanged was not traced.

**Decisions.**

- **What should the dialog show?**
  - **The bridge's message under the generic heading, when the error carries one (recommended).**
    - Pros: the reason the bridge chose reaches the user; every bridge's error body benefits, not only Pi's.
    - Cons: a message from any bridge is shown verbatim, so each must stay short and content-free, which `bridges/AGENTS.md` already asks of error bodies.
  - **Map known failures (504) to fixed renderer text.**
    - Pros: the renderer controls the wording.
    - Cons: needs a status or code to cross the backend command, which it does not carry today.
  - **Keep the generic text.**
    - Pros: no change.
    - Cons: part `0130`'s reason for the 504 stays unmet.

### 2. Check a timed-out list in a real browser

**Problem.** The closing check read the dialog's code and unit test; nothing was rendered.

**Context.** `setSessionListTimeoutForTests` exists in the bridge only for tests, so a live check needs a history large enough to time out or another way to slow the read.

**Investigation.** None run.

**Decisions.**

- **How to produce the timeout live?**
  - **A seeded fixture Pi session directory large enough to exceed the timeout, found in task 3 (recommended).**
    - Pros: exercises the real read and abort.
    - Cons: depends on task 3's measurement.
  - **A test-only bridge flag that shortens the timeout.**
    - Pros: quick.
    - Cons: a new switch on the bridge for a one-off check.

### 3. Measure how large a Pi history reaches the 30 s timeout

**Problem.** Part `0130` did not say how large a history has to be before the list times out, so it is unknown how many users meet the error.

**Context.** `SessionManager.list` from `@earendil-works/pi-coding-agent` parses every session file in full, and Pi does not export the per-file step, so `session-list-cache.ts` can only keep the whole result. A history that times out never fills the cache, so it fails on every attempt (1202 task 6).

**Investigation.** Not measured.

**Decisions.**

- **How to measure?**
  - **Time `listResumableSessions` against generated session directories of growing size, outside any provider turn (recommended).**
    - Pros: no credentials or model calls; repeatable.
    - Cons: generated files may parse faster or slower than real ones.
  - **Read sizes from real users' histories.**
    - Pros: real data.
    - Cons: needs access to histories that contain prompts and file contents.

### 4. Test that a durability barrier rejects when the state cannot fit

**Problem.** Part `0355` required that a durability barrier still throws when the state cannot fit, so dispatch stops when nothing was published. The code does it, but no test drives it.

**Context.** `persistNow` in `bridges/pi-bridge/src/persistence.ts` throws "Pi bridge state exceeds its persistence budget" when `encodeStateWithinBudget` answers `undefined`.

**Investigation.** `persistence.test.ts` covers the encoder half (`answers nothing when the non-transcript state alone does not fit`). No test calls `persistBarrier()` with state that cannot fit and expects a rejection, so a change that swallowed the error would pass the suite.

**Decisions.**

- **Where to test it?**
  - **In `persistence.test.ts`, with non-transcript state larger than `MAX_STATE_FILE_BYTES` (recommended).**
    - Pros: next to the encoder tests; no HTTP needed.
    - Cons: needs a way to make the state that large, or a test seam for the bound.
  - **Through the prompt route, expecting the dispatch to be refused.**
    - Pros: proves the user-facing effect.
    - Cons: a heavier test for a two-line branch.

## Related

- [1202 task 6](../cross-cutting/1202-efficiency-review-follow-ups.md#6-bridge-hot-paths): what was built for BR-10 and BR-14.
- [Efficiency report, C](../../reports/2026-10-27-efficiency.md#c-bridges) (BR-10, BR-14).

## Replaces

- Report `0130-e21-pi-bridge.md`, part `0130`: the decision that the reason reaches the user, and both "Needs verification" items.
- Report `0130-e21-pi-bridge.md`, part `0355`: the test for the barrier constraint.
