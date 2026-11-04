# E21: Pi bridge

This file combines 2 reports into one batch to build together. Same bridge.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0130](#0130-pi-session-list-parses-every-file-on-each-call-and-hides-a-timeout) | Medium | BR-10: Pi session list parses every file on each call and hides a timeout |
| [0355](#0355-pi-persistence-serialises-every-session-on-each-write) | Low | BR-14: Pi persistence serialises every session on each write |

## 0130: Pi session list parses every file on each call and hides a timeout

### Task analysis

#### Tasks

1. **Avoid re-parsing unchanged session files**: answer `/session/list` without reading every file when nothing changed. Status: done 2026-11-04 ([1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 6).
2. **Report a timed-out list**: stop answering a timeout with an empty list. Status: done 2026-11-04 ([1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 6).

#### 1. Avoid re-parsing unchanged session files

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

#### 2. Report a timed-out list

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

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): every cache needs byte and count bounds.

### Needs verification

- How the resume UI renders the error, and how large a history reaches the timeout. Neither was run.

## 0355: Pi persistence serialises every session on each write

### Task analysis

#### Tasks

1. **Encode each record once**: follow Cursor's budget code so a write and its shedding do not re-serialise everything. Status: done 2026-11-04 ([1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 6).

#### 1. Encode each record once

**Problem.** Each state write serialises every session, and if the state is over budget, shedding serialises the whole payload again after each session it trims.

**Context.** It runs only at turn and request edges, and bursts are coalesced (`schedulePersist`, `bridges/pi-bridge/src/persistence.ts:69`), so the report rates it Low.

**Investigation.** `persistNow` (`persistence.ts:164`) does `JSON.stringify(payload)` (`:175`). `shedToFit` re-serialises in its loop (`:152`). Cursor's `bridges/cursor-bridge/src/persistence-budget.ts` plans each record once (`planRecord`, `:201`) and splices them into the envelope (`:128-130`). The two differ in policy: Pi sheds the oldest transcripts, while Cursor refuses with `persistence-budget-exceeded`.

**Decisions.**

- **Port or share?**
  - **Port the encode-once technique into Pi's shedding, keeping Pi's policy (recommended).**
    - Pros: small and local; no change to what is written.
    - Cons: a second copy of the technique.
  - **Move a shared budget helper into `packages/protocol/src/node`.**
    - Pros: theme T4's direction.
    - Cons: the two policies differ, so the helper would need both, for a Low finding.

### Constraints and rationale

- A durability barrier must still throw when the state cannot fit (`bridges/pi-bridge/src/persistence.ts:176-181`), so dispatch stops when nothing was published.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) apply as usual.

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-10, BR-14)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0240](0240-e20-acp-bridge.md#0240-acp-still-serialises-every-session-on-each-state-write): the same pattern in ACP
