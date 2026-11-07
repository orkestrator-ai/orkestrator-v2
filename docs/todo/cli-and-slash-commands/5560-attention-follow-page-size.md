# `attention --follow`: page size on a real follower

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

What was left of `docs/reports/efficiency-logging-database/0694-dk-16-attention-follow-polling.md` (batch E-0694). That report is deleted; read the original with `git show 69a3b4ca5:docs/reports/efficiency-logging-database/0694-dk-16-attention-follow-polling.md`. Its one task was decided from a fixture measurement, and only the live part is left.

### Tasks

1. **Typical page size on a real follower**: report `0694`, task 1 (Conditional attention reads) and its Needs verification item. Status: open.

### 1. Typical page size on a real follower

**Problem.** Each poll of `attention --follow` receives every pending question and approval again, and only the CLI drops the repeats. A long-running follower re-downloads them every 2 s. The report's recommendation was to leave this until a real follower shows a meaningful page size, and no real follower has been measured.

**Context.** The follow loop calls `attention.list` on every observation and removes repeats with a local `seen` set (`packages/cli/src/client/commands/attention.ts:94-115`). The cursor only pages runs and setups, and the command's help says pending items are listed "always" (`:43`). Polling backs off to 2 s (`packages/cli/src/client/wait.ts:63-71`), for up to 24 h. `session transcript --follow` already has an optional `knownToken`, advertised as `features.transcriptKnownToken` (`packages/cli/src/client/commands/session.ts:1085`, `apps/backend/src/core/public-api/actions-transcript.ts:154`).

**Investigation.** Measured on 2026-11-05 on the real `attention.list` handler and `NativeAgentService` with the scripted provider in `apps/backend/src/core/public-api/test-provider.ts`, over real storage and with no provider turn. The sizes are the JSON response envelope, without HTTP headers. Interaction ids are 36 characters.

| Page | Items | Bytes per poll | Per 24 h at one poll per 2 s |
| --- | --- | --- | --- |
| Nothing pending | 0 | 264 | 11 MB |
| One approval with a 33-character title | 1 | 626 | 27 MB |
| Three such approvals | 3 | 1,352 | 58 MB |
| Default limit, 200-character ASCII titles | 20 | 10,901 | 471 MB |
| Largest limit, 200-character ASCII titles and environment name | 50 | 36,401 | 1.6 GB |
| Default limit, 200 3-byte characters in title and environment name | 20 | 30,741 | 1.3 GB |
| Largest limit, 200 3-byte characters in title and environment name | 50 | 76,401 | 3.3 GB |

The largest measured fixture page is about 7% of a transcript page's 1 MiB cap (`PUBLIC_API_LIMITS.transcriptMaxBytes`). The last row needs fifty approvals pending for the whole day, all with names at the cut-off. Interaction bodies are omitted, and titles and environment names are cut at 200 UTF-16 code units (`apps/backend/src/core/public-api/actions-attention.ts:91`, `:97`). Not measured: titles and environment names made entirely of characters JSON escapes cost six bytes per unit, which by calculation gives about 136 KB for a full page with the same 36-character ids. That estimate was not measured and is not a universal bound. Provider-chosen ids are not cut, so longer ids can increase the serialized size further.

`public-api-attention.test.ts` ("pages with three-byte names and 36-character IDs stay within fixture budgets") holds a default page of this fixture to 32 KiB and a maximum page to 80 KiB. These regression budgets cover three-byte names and 36-character interaction ids; they do not establish a universal serialized-page ceiling or cover escaped names and longer provider ids. Not run, because it needs real pending interactions and so a billed provider turn: how many items a real follower sees, and how long their titles are.

For the measured fixture pages, a conditional read would save less than these figures. An empty page is already 264 bytes and an unchanged answer would still have to return the moving `cursor`. The backend would also still load environments, layouts and pending interactions to compute the token.

**Decisions.**

- **Add a conditional read?**
  - **Leave it until a real follower shows a meaningful page size (recommended).** Taken on 2026-11-05 on the numbers above.
    - Pros: the measured fixture pages are small compared with a transcript page; public API surface stays as it is; fixture budgets are pinned by a test.
    - Cons: a long-running follower re-downloads them every 2 s; the fixture does not bound escaped names or longer provider ids.
  - **An optional `knownToken` on `attention.list`, advertised as a feature, as `session transcript` now does.**
    - Pros: the contract the transcript action already uses.
    - Cons: public API surface, and the backend still has to build the page to compute the token.
- **What counts as a meaningful page size?** The report did not say.
  - **A real follower whose typical non-empty page is above 10 KiB, about a full default page of ASCII titles (recommended).**
    - Pros: a number someone can check; at that size the saving is hundreds of megabytes a day for one follower.
    - Cons: a judgment, not derived from a complaint.
  - **A user report only.**
    - Pros: no work until someone needs it.
    - Cons: the item may never be re-rated.
- **How to measure it?**
  - **Sample `orkestrator attention --json` byte counts during ordinary use on a host where sessions already wait for approval (recommended).**
    - Pros: no new code or counters; uses turns that are being run anyway.
    - Cons: sampled, and it reflects one user's habits.
  - **Add a bytes counter to the follow loop.**
    - Pros: exact for a whole follow.
    - Cons: new code for a Low-rated question.

## Current state

`attention --follow` and `attention.list` are unchanged: no `knownToken`, no new feature flag, nothing for older clients or nodes to rely on. The decision and fixture evidence are recorded in [`control-mcp-voice.md`](../../architecture/control-mcp-voice.md#hearing-about-work-without-asking).

## Assumptions and decisions

### Task 1: scope the payload evidence to the fixture

On 2026-11-05, qualified the 32/80 KiB regression budgets as applying to the tested three-byte names and 36-character interaction ids. Kept the recommended unconditional polling decision provisional on these measurements and left task 1 open for live measurement. Enforcing a universal byte or id limit would change the public contract; this documentation correction introduces no such limit. Escaped strings and longer provider ids remain outside the fixture guarantee.

## Constraints and rationale

A public API change follows `docs/architecture/public-cli.md`. An older backend refuses unknown input, so if this is ever built the CLI must check capabilities first, as the transcript follow does, through the same `--node` routing as the read.

## Needs verification

- Typical attention page size on a real follower. Needs real pending interactions, which means a billed provider turn.

## Related

- Efficiency report, G (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`)
- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), task 16
- [0017 CLI command surface](0017-cli-command-surface.md), task 1: a push follow would serve this command too, and its trigger measurement also names `attention --follow`.

## Replaces

Report `0694-dk-16-attention-follow-polling.md` in `docs/reports/efficiency-logging-database/`, deleted with batch E-0694.
