# A held trimmed head whose length equals the omitted count shows a part twice

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`, plus the branch that moved the merge to `apps/web/src/hooks/native-agent-live-head.ts`.

### Tasks

1. **Stop reading a same-length held copy as the omitted prefix**: decide how the merge can tell a fuller copy from an earlier trimmed copy of the same window. Status: open.

### 1. Stop reading a same-length held copy as the omitted prefix

**Problem.** `preferCompleteLiveHead` takes a held row with exactly as many parts as `omittedParts` to be the prefix the live window cut. When the held row is really an earlier trimmed copy of the same window, the merge lays the incoming parts after it, so the kept parts appear twice and `restoredPrefix` wrongly reports true.

**Context.** Found during 1202's WEB-6, which moved this function without changing the behaviour. It is the `omittedParts === localParts.length ? localParts.length` branch. Its parity test deliberately keeps the result, so a fix here has to change that test's expectation for this case.

**Investigation.** Reproduced by calling the function directly, on both the old and the moved code: held row `[{ content: "kept" }]`, incoming row `[{ content: "kept and grown" }]` with the same source id and `omittedParts: 1` returned parts `["kept", "kept and grown"]`. Not reproduced in a running app. The sequence that should reach it is a first read of a part-trimmed head with no fuller copy held, kept parts equal in number to omitted parts, then a later update to that row; whether a real transcript window produces that is not established.

**Decisions.**

- **How to tell the two cases apart?**
  - **Check for overlap first, and use the length rule only when the incoming parts do not overlap the held row (recommended).**
    - Pros: local to the function; the held copy in this bug overlaps by durable identity, which a true prefix does not.
    - Cons: a true prefix whose parts have no durable identity and equal content would be read as an overlap.
  - **Record in the cache how many parts each held row omitted.**
    - Pros: exact: the client knows whether its copy was itself trimmed.
    - Cons: new state to carry through the sync and progressive caches, and retained rows have no such record.

## Related

- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), task 3
