# CLI `attention --follow` re-downloads pending items on every poll

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Conditional attention reads**: decide whether an unchanged follow poll should skip the payload. Status: open.

### 1. Conditional attention reads

**Problem.** Each poll of `attention --follow` receives every pending question and approval again, and only the CLI drops the repeats.

**Context.** The report guessed that this "probably has the same pattern" as the transcript follow and did not check. 1202 task 16 checked it and left it unchanged.

**Investigation.** The follow loop calls `attention.list` on every observation and removes repeats with a local `seen` set (`packages/cli/src/client/commands/attention.ts:94-115`). The cursor only pages runs and setups, and the command's help says pending items are listed "always" (`:43`). Polling backs off to 2 s (`packages/cli/src/client/wait.ts:63-71`). It takes no `knownToken`.

**Decisions.**

- **Add a conditional read?**
  - **Leave it until a real follower shows a meaningful page size (recommended).**
    - Pros: pending items are few and small compared with a transcript page; public API surface stays as it is.
    - Cons: a long-running follower re-downloads them every 2 s.
  - **An optional `knownToken` on `attention.list`, advertised as a feature, as `session transcript` now does.**
    - Pros: the contract the transcript action already uses.
    - Cons: public API surface, and the backend still has to build the page to compute the token.

## Current state

`session transcript --follow` is done: an optional `knownToken` answers `unchanged`, advertised as `features.transcriptKnownToken` (`packages/cli/src/client/commands/session.ts:1085`, `apps/backend/src/core/public-api/actions-transcript.ts:154`, b68b6e710). This file covers only the part the report did not check.

## Constraints and rationale

A public API change follows `docs/architecture/public-cli.md`. An older backend refuses unknown input, so the CLI must check capabilities first, as the transcript follow does.

## Needs verification

- Typical attention page size. Not measured.

## Related

- [Efficiency report, G](../2026-10-27-efficiency.md#g-desktop-toolchain-docker-image-protocol-and-cli)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 16
