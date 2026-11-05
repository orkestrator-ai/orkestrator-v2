# Pi resume list: the timeout's reason, its size and the barrier test

Carried from efficiency report batch E21 (`docs/reports/efficiency-logging-database/0130-e21-pi-bridge.md`, findings BR-10 and BR-14), deleted on 2026-11-05. Its original text is at `69a3b4ca5`; its last version, ending with its outcome table, is the parent of the commit that deleted it (`git log --diff-filter=D -- <path>`). The code for both parts is built; this is what the closing check could not confirm.

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Re-checked and acted on 2026-11-05 against `main` at `6e796ca32`. One claim did not hold: the message did not reach the renderer on a real timeout (task 1).

### Tasks

1. **Show the timeout's reason in the resume dialog**: the user saw "Failed to load sessions", not why. Status: done (2026-11-05).
2. **Check a timed-out list in a real browser**: on a throwaway `dev:test` profile, desktop and narrow. Status: done (2026-11-05).
3. **Measure how large a Pi history reaches the 30 s timeout**: Status: done (2026-11-05).
4. **Test that a durability barrier rejects when the state cannot fit**: Status: done (2026-11-05).

### 1. Show the timeout's reason in the resume dialog

**Problem.** Part `0130` chose a 504 with a short message so that "the message reaches the user through the existing path". It did not reach the user, and on a real timeout it did not reach the renderer either.

**Context.** `bridges/pi-bridge/src/http.ts` answers a timed-out `/session/list` with 504 and `SESSION_LIST_TIMEOUT_MESSAGE` ("Pi took too long to read its session history", `agent-session.ts`). The dialog is shared by every native platform (`AgentNativeTab.controller.tsx`), so a change applies to all of them.

**Investigation.** The path, traced in code and then observed live:

| Hop | File | What happens to the message |
| --- | --- | --- |
| Bridge | `bridges/pi-bridge/src/http.ts` | 504 `{ error: <reason> }` when its 30 s ceiling (`CATALOG_TIMEOUT_MS`) expires. |
| Backend request | `http-bridge-transport.ts` `bridgeFetch` | Had the 30 s default budget, started before the bridge's clock, so it aborted first: `pi bridge is unavailable`. **The reason was lost here.** |
| Backend response | `http-bridge-transport.ts` `assertOkWithErrorDetail` | Had the bridge answered in time: `pi resumable session list is temporarily unavailable (HTTP 504): <reason>`, so not unchanged. Newlines are collapsed and the reason is cut at 500 characters. |
| Backend service | `native-agent-session-operations.ts`, `commands-registry-native.ts` | Rethrown untouched. |
| Gateway | `apps/backend/src/gateway-handlers.ts` | 500 `{ error: error.message }`, text unchanged. The class survives only as a kebab-case `code`, and this error has none, so the renderer cannot tell a 504 from any other failure. |
| Browser client | `apps/web/src/lib/native/web-gateway.ts` | `GatewayHttpError(500, payload.error)`, text unchanged. |
| Desktop client | `apps/desktop/electron/backend-process.ts`, `preload-api.ts` | `new Error(payload.error)`; the preload strips Electron's "Error invoking remote method" wrapper, leaving the text unchanged. Read in code only; the live check used the browser client. |
| Dialog | `NativeResumeSessionDialog.tsx` | Logged `session-list.load-failed` and showed fixed text. |

The live run on the old code logged `error.message="pi bridge is unavailable"` both times (task 2). The earlier test, `a bridge's timed-out list reaches the caller as an error, not an empty list`, used a fake `fetch` that answers at once, so it could not see the race. The old to-do also said `bridges/AGENTS.md` already asks that error bodies be short and content-free; it only said that of the close route, so a rule for this route is now there.

Built: the dialog shows a failure's own message as plain text under the heading, and the heading alone when there is no usable message. A list gets a 35 s request budget (`BRIDGE_SESSION_LIST_TIMEOUT_MS`), and when the bridge gave a reason the message is that reason alone.

**Decisions.**

- **What should the dialog show?**
  - **The bridge's message under the generic heading, when the error carries one (recommended, built).**
    - Pros: the reason the bridge chose reaches the user; every bridge's error body benefits, not only Pi's.
    - Cons: a message from any bridge is shown verbatim, so each must stay short and content-free.
  - **Map known failures (504) to fixed renderer text.**
    - Pros: the renderer controls the wording.
    - Cons: needs a status or code to cross the backend command, which it does not carry today.
  - **Keep the generic text.**
    - Pros: no change.
    - Cons: part `0130`'s reason for the 504 stays unmet.
- **How should the reason outrun the backend's budget?** Added by the re-check.
  - **Give a list its own budget just above the bridge's ceiling, 35 s (recommended, built).**
    - Pros: one line per side; the bridge keeps ownership of the ceiling and the abort. Live, the reason arrived at about 30 s.
    - Cons: every bridge's list waits 5 s longer before the backend gives up on a bridge that never answers.
  - **Shorten Pi's ceiling below 30 s.**
    - Pros: no backend change.
    - Cons: fails histories that list successfully today.
- **Where should the operation and status prefix come off?** Added by the re-check.
  - **In the backend, for this one call, when the bridge gave a reason (recommended, built).**
    - Pros: one place; the error class is kept, so callers classify it as before; a body-less failure still names the operation and status.
    - Cons: the message no longer carries the HTTP status.
  - **Parse the prefix in the renderer.**
    - Pros: backend untouched.
    - Cons: the renderer depends on the wording of a backend message.
  - **Show the whole message.**
    - Pros: no extra change.
    - Cons: the user reads "pi resumable session list is temporarily unavailable (HTTP 504)" before the reason.

### 2. Check a timed-out list in a real browser

**Problem.** The closing check read the dialog's code and unit test; nothing was rendered.

**Context.** `setSessionListTimeoutForTests` exists in the bridge only for tests, so a live check needs a history large enough to time out or another way to slow the read.

**Investigation.** Run on a throwaway profile (`--fixture --headless --no-agent-credentials --agent-platforms pi`) in Playwright's Chromium against the profile's `browserUrl`, with a local fixture environment and 34,816 generated files (36.6 GB, the task 3 shape) in that environment's own `pi-bridge-sessions` directory. Host load average was 45 to 69 throughout.

| Code | Viewport | Spinner until | Dialog body | Renderer's `error.message` |
| --- | --- | --- | --- | --- |
| Before | 1280x800 | 31.0 s | Failed to load sessions | `pi bridge is unavailable` |
| Before | 390x844 | 29.6 s | Failed to load sessions | `pi bridge is unavailable` |
| After | 1280x800 | 30.2 s | Failed to load sessions / Pi took too long to read its session history | the reason |
| After | 390x844 | 29.8 s | Failed to load sessions / Pi took too long to read its session history | the reason |

The spinner showed for the whole wait, and neither viewport overflowed sideways. Each run was a fresh page, so a reload gives the same result: a history that times out fails on every attempt. The empty-history state still read "No previous sessions found." The profile was stopped and reset and the files removed. Screenshots are in the pipeline's report, not the repository.

**Decisions.**

- **How to produce the timeout live?**
  - **A seeded fixture Pi session directory large enough to exceed the timeout, found in task 3 (recommended, built).**
    - Pros: exercises the real read and abort.
    - Cons: depends on task 3's measurement, and needs 37 GB of disk while it runs.
  - **A test-only bridge flag that shortens the timeout.**
    - Pros: quick.
    - Cons: a new switch on the bridge for a one-off check, and answering early would have hidden the race with the backend's budget.

### 3. Measure how large a Pi history reaches the 30 s timeout

**Problem.** Part `0130` did not say how large a history has to be before the list times out, so it was unknown how many users meet the error.

**Context.** `SessionManager.list` from `@earendil-works/pi-coding-agent` (1.4.0) parses every session file in full, and Pi does not export the per-file step, so `session-list-cache.ts` can only keep the whole result. A history that times out never fills the cache, so it fails on every attempt (1202 task 6).

**Investigation.** `listResumableSessions` was timed in a fresh process per run with the ceiling lifted, outside any provider turn, with `HOME`, `PI_CODING_AGENT_DIR`, `PI_SESSION_DIR` and `CWD` pointing at a temporary directory. Machine: Apple M1 Max, 10 cores, 32 GiB, internal SSD, macOS 26.2, Bun 1.4.4, shared with other agents' work. Each generated session repeats a user message, an assistant message with text and a tool call, and a tool result, about 2.9 KB per entry.

| Session file | History | Files | Entries | Listing took | Peak RSS | Load average |
| --- | --- | --- | --- | --- | --- | --- |
| 1 MiB | 2.2 GB | 2,048 | 0.7 M | 2.6 s | 0.7 GB | 24 |
| 1 MiB | 8.6 GB | 8,192 | 3.0 M | 10.2 to 10.4 s | 3.1 to 4.0 GB | 18 |
| 1 MiB | 17.2 GB | 16,384 | 6.0 M | 21.1 to 21.2 s | 5.8 to 6.1 GB | 21 |
| 1 MiB | 34.5 GB | 32,768 | 11.9 M | 42.7 to 44.9 s | 7.7 to 8.3 GB | 17 to 19 |
| 200 KiB | 8.8 GB | 41,943 | 3.1 M | 11.1 to 11.2 s | 1.7 to 1.9 GB | 14 |
| 10 MiB | 17.2 GB | 1,638 | 5.9 M | 22.3 to 22.9 s | 3.6 to 4.9 GB | 82 to 97 |
| 1 MiB | 6.5 GB, just written | 6,144 | 2.2 M | 42.6 s | 0.8 GB | 34 |
| 1 MiB | 6.5 GB, after writing 36.6 GB more | 6,144 | 2.2 M | 54.5 s | 1.1 GB | 60 |
| 1 MiB | 6.5 GB, read again at once | 6,144 | 2.2 M | 52.0 s | 1.6 GB | 44 |
| 1 MiB | 26.9 GB | 25,600 | 9.3 M | 194 to 212 s | 5.4 to 6.0 GB | 52 |

The result is that the history size depends on how busy the host is, by a factor of about six:

- **While the listing ran at about 820 MB/s (the first pass): about 24.5 GB**, or some 23,000 of these 1 MiB sessions. That is interpolated between 21 s at 17.2 GB and 43 to 45 s at 34.5 GB.
- **While it ran at about 120 to 150 MB/s (later, on the same machine): about 3.5 to 4.5 GB**, extrapolated from the 6.5 GB and 26.9 GB rows. A list that took over 30 s was seen directly at 6.5 GB.

File size made little difference at the same total, so bytes rather than session count set the cost. The slower period coincided with other work on the host. It did not change with disk-cache state in the three 6.5 GB rows, but its cause was not isolated, and load average alone does not predict it (17.2 GB took 22 s at load 90). With the real ceiling the read gave up at 30.006 s and 30.024 s, so the timer is not held up by the parsing. Generated files may parse faster or slower than real ones, and a real history was deliberately not read. A list of this size also costs gigabytes of bridge memory (see [5980](5980-pi-session-list-read-cost.md)).

**Decisions.**

- **How to measure?**
  - **Time `listResumableSessions` against generated session directories of growing size, outside any provider turn (recommended, built).**
    - Pros: no credentials or model calls; repeatable.
    - Cons: generated files may parse faster or slower than real ones.
  - **Read sizes from real users' histories.**
    - Pros: real data.
    - Cons: needs access to histories that contain prompts and file contents.

### 4. Test that a durability barrier rejects when the state cannot fit

**Problem.** Part `0355` required that a durability barrier still throws when the state cannot fit, so dispatch stops when nothing was published. The code did it, but no test drove it.

**Context.** `persistNow` in `bridges/pi-bridge/src/persistence.ts` throws "Pi bridge state exceeds its persistence budget" when `encodeStateWithinBudget` answers `undefined`.

**Investigation.** `persistence.test.ts` now has `a durability barrier > rejects when the non-transcript state cannot fit, and publishes nothing`. It puts a session's `error` over `MAX_STATE_FILE_BYTES`, expects the rejection, checks the previous state file is byte-identical, and checks a barrier publishes again once the state fits. Two temporary mutations, a `persistBarrier` that swallows the rejection and a `persistNow` that returns instead of throwing, each failed the test with "Expected promise that rejects"; both were reverted.

**Decisions.**

- **Where to test it?**
  - **In `persistence.test.ts`, with non-transcript state larger than `MAX_STATE_FILE_BYTES` (recommended, built).**
    - Pros: next to the encoder tests; no HTTP needed.
    - Cons: allocates a 32 MiB string, which took about 12 ms and needed no test seam.
  - **Through the prompt route, expecting the dispatch to be refused.**
    - Pros: proves the user-facing effect.
    - Cons: a heavier test for a two-line branch.

## Assumptions and decisions

### Task 1: a message beyond the bridge's reason is shown too

The dialog shows any failure's message, not only a bridge's reason, so "pi bridge is unavailable" or "Failed to fetch" appears under the heading. The dialog cannot tell them apart, because only the text crosses the gateway, and each still says more than the heading alone. An `Error` with a blank message and a non-`Error` rejection keep the heading alone.

### Task 1: the dialog bounds the message too

The backend cuts a bridge's reason at 500 characters, but other failures reach the dialog unbounded (the OpenCode provider does not use this path), so the dialog applies the same bound.

### Task 2: live check through the browser client only

The desktop client's path was read in code and has its own preload test. Driving the Electron window would have added nothing the dialog can show differently, and the to-do asks for a real browser.

### Task 3: no timing script committed

The generator and timing scripts were throwaway, kept in a temporary directory and removed with the fixtures. The file shape and method above are enough to repeat the measurement, and a committed script would need maintenance for a one-off number.

## Related

- [1202 task 6](../cross-cutting/1202-efficiency-review-follow-ups.md#6-bridge-hot-paths): what was built for BR-10 and BR-14.
- [Efficiency report, C](../../reports/2026-10-27-efficiency.md#c-bridges) (BR-10, BR-14).
- [5980](5980-pi-session-list-read-cost.md): what a large history costs each list.

## Replaces

- Report `0130-e21-pi-bridge.md`, part `0130`: the decision that the reason reaches the user, and both "Needs verification" items.
- Report `0130-e21-pi-bridge.md`, part `0355`: the test for the barrier constraint.
