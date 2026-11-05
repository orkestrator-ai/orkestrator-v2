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

## Outcome

Checked item by item against this file on 2026-11-05, at `main` `69a3b4ca5`. Every line number above still holds.

| Item | Outcome | Evidence |
| --- | --- | --- |
| Task 1, Conditional attention reads: add one? | Done, by taking the recommended option, so no product code changed | `attention.list` keeps no `knownToken` (`apps/backend/src/core/public-api/actions-attention.ts`, `packages/cli/src/client/commands/attention.ts`). The decision rests on the fixture measurement in the next row and is recorded in `docs/architecture/control-mcp-voice.md`. Test: "a full page of over-long names stays small enough to re-read on every poll" in `apps/backend/src/core/public-api/public-api-attention.test.ts`, which fails if a default page passes 32 KiB or a full page passes 80 KiB. |
| Needs verification, typical attention page size: the ceiling | Done | Measured on the real handler with the scripted provider, no provider turn: empty 264 bytes, three approvals 1,352 bytes, default limit with 200-character ASCII titles 10,901 bytes, and largest limit with 200 3-byte characters in title and environment name 76,401 bytes, against a 1 MiB transcript page cap. Same test as above. |
| Task 1 and Needs verification: a real follower's page size | Moved to to-do 5560 | Needs real pending interactions, which means a billed provider turn. `docs/todo/cli-and-slash-commands/5560-attention-follow-page-size.md` carries the problem, context and both options across, with a proposed threshold. |
| Constraints: public API change follows `public-cli.md`; CLI checks capabilities first | No longer holds | No public API change was made, so nothing for older clients or nodes to rely on and no entry in `version-compatibility.md`. To-do 5560 keeps the constraint for a later build. |
| Current state: `session transcript --follow` | No longer holds as work: already done | `packages/cli/src/client/commands/session.ts:1085` and `apps/backend/src/core/public-api/actions-transcript.ts:154` are unchanged from what this file names. |
