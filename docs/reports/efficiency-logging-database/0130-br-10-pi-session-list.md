# Pi session list parses every file on each call and hides a timeout

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Avoid re-parsing unchanged session files**: answer `/session/list` without reading every file when nothing changed. Status: open.
2. **Report a timed-out list**: stop answering a timeout with an empty list. Status: open.

### 1. Avoid re-parsing unchanged session files

**Problem.** Each `/session/list` reads and parses every Pi session file in full, with no cache. On a large history it is slow enough to hit the 30 s catalogue timeout.

**Context.** The call is infrequent; it answers the resumable-session list, not a poll.

**Investigation.** `listResumableSessions` (`bridges/pi-bridge/src/agent-session.ts:1272`) calls `SessionManager.list` from `@earendil-works/pi-coding-agent` 1.4.0. In that package's `dist/core/session-manager.js`, `buildSessionInfo` (`:492`) reads each file line by line and parses every entry. `buildSessionInfo` is not exported, so the bridge cannot cache per file around it. The list's signature also takes a `signal` (`:1449`) that the bridge does not pass, so a timed-out read goes on running.

**Decisions.**

- **What to cache?**
  - **Memoise the whole result, keyed by each file's path, size and mtime (recommended).**
    - Pros: the report's key; one directory listing and a `stat` per file when nothing changed; no dependence on the session file's private format. One entry per session directory, so it is bounded.
    - Cons: one changed file re-parses all of them; the entry's size still has to be bounded, as `MAX_RESUME_ENTRIES` only applies after listing.
  - **Read only each file's head in the bridge.**
    - Pros: fast even when every file changed.
    - Cons: reimplements a third-party format; `modified`, `name` and message counts come from later lines, so the result would differ from Pi's.

### 2. Report a timed-out list

**Problem.** A timeout is caught and returned as `[]` (`bridges/pi-bridge/src/agent-session.ts:1277`), so the user sees no sessions rather than an error.

**Context.** The backend already surfaces a bridge's error body: `assertOkWithErrorDetail` in `apps/backend/src/core/http-bridge-resumable-sessions.ts:27`, with a comment naming the ACP bridge's 410 as the model.

**Investigation.** `bridges/pi-bridge/src/http.ts:389` turns the result straight into a 200. Nothing tells a timeout from an empty directory.

**Decisions.**

- **What should a timeout answer?**
  - **An error status with a short message, and abort the read through `signal` (recommended).**
    - Pros: the message reaches the user through the existing path; no orphaned read.
    - Cons: a list that used to look empty now shows an error, which needs a check in the resume UI.
  - **Keep `[]` and log.**
    - Pros: no behaviour change.
    - Cons: the silent failure stays.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): every cache needs byte and count bounds.

## Needs verification

- How the resume UI renders the error, and how large a history reaches the timeout. Neither was run.

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-10)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
