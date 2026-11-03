# ACP still serialises every session on each state write

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Decide whether to cache clean sessions' fragments**: the report's last BR-1 fix, not done when the interval was lowered. Status: open.

### 1. Decide whether to cache clean sessions' fragments

**Problem.** The write rate fell from about one per 25 ms to one per second while a turn streams, but each write still does the whole job: at least three serialisation passes over up to 256 sessions, up to the 16 MB cap.

**Context.** The report lists three fixes: a trailing debounce, keeping `persistState()` barriers, and "cache each clean session's serialised fragment". 1202 marks BR-1 done, and its decision of 2026-11-01 covers only the interval. The third fix was not built and was not explicitly declined.

**Investigation.** In `bridges/acp-bridge/src/acp-persist-writer.ts`, `persistedSnapshot` (`:105`) measures structured entries, journals and config per session with `JSON.stringify` (`:126`, `:135`, `:148`, `:173`). `boundPersistedSnapshot` (`:39`) serialises metadata and messages again (`:52`, `:59`), and the write serialises the lot once more (`:293`). No per-session cache exists. Sessions other than the streaming one are unchanged between writes, so most of this repeats.

**Decisions.**

- **Build the cache now?**
  - **Measure a write on a large state first, and build it only if the once-a-second cost shows (recommended).**
    - Pros: the rate fix already removed most of the cost; the bounds in `persistedSnapshot` work across sessions, newest first, so a fragment depends on its neighbours and the cache is not simple.
    - Cons: a turn on a backend holding many large sessions keeps paying in the meantime.
  - **Cache each clean session's fragment by session revision.**
    - Pros: the report's fix; writes approach the cost of the session that changed.
    - Cons: every state change must move the revision; a missed one writes stale state to disk, the worst failure for this file.

## Current state

Done, checked in code:

- `scheduleStreamingPersist` writes at most once per `STREAMING_PERSIST_INTERVAL_MS` (1 s) with a timer later chunks do not reset, so it is also the maximum wait (`acp-persist-writer.ts:239-249`; #1548, `12289fc56`). Its callers are `acp-session.ts:2160` and `acp-tools.ts:193`.
- `persistState()` barriers remain for the dispatch journal.

## Constraints and rationale

- A crash can lose at most one interval of output, by the 2026-11-01 decision.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): any cache needs byte and count bounds.

## Needs verification

- What a write costs at the cap; nothing here was run. 1202 notes that BR-1 has no new test.

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-1)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), which lists BR-1 as done
- [0355](0355-br-14-pi-persistence-encoding.md): the same pattern in Pi
