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

The largest page is about 7% of a transcript page's 1 MiB cap (`PUBLIC_API_LIMITS.transcriptMaxBytes`). The last row needs fifty approvals pending for the whole day, all with names at the cut-off. Interaction bodies are omitted, and titles and environment names are cut at 200 UTF-16 code units (`apps/backend/src/core/public-api/actions-attention.ts:91`, `:97`). Not measured: a title made entirely of characters JSON escapes costs six bytes per unit, which by calculation gives about 136 KB for the largest page. Provider-chosen ids are not cut.

`public-api-attention.test.ts` ("a full page of over-long names stays small enough to re-read on every poll") holds a default page to 32 KiB and a full page to 80 KiB. So the ceiling is known. Not run, because it needs real pending interactions and so a billed provider turn: how many items a real follower sees, and how long their titles are.

A conditional read would save less than these figures. An empty page is already 264 bytes and an unchanged answer would still have to return the moving `cursor`. The backend would also still load environments, layouts and pending interactions to compute the token.

**Decisions.**

- **Add a conditional read?**
  - **Leave it until a real follower shows a meaningful page size (recommended).** Taken on 2026-11-05 on the numbers above.
    - Pros: pending items are few and small compared with a transcript page; public API surface stays as it is; the ceiling is pinned by a test.
    - Cons: a long-running follower re-downloads them every 2 s.
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

`attention --follow` and `attention.list` are unchanged: no `knownToken`, no new feature flag, nothing for older clients or nodes to rely on. The decision and its bound are recorded in [`control-mcp-voice.md`](../../architecture/control-mcp-voice.md#hearing-about-work-without-asking).

## Constraints and rationale

A public API change follows `docs/architecture/public-cli.md`. An older backend refuses unknown input, so if this is ever built the CLI must check capabilities first, as the transcript follow does, through the same `--node` routing as the read.

## Needs verification

- Typical attention page size on a real follower. Needs real pending interactions, which means a billed provider turn.

## Related

- [Efficiency report, G](../../reports/2026-10-27-efficiency.md#g-desktop-toolchain-docker-image-protocol-and-cli)
- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), task 16
- [0017 CLI command surface](0017-cli-command-surface.md), task 1: a push follow would serve this command too, and its trigger measurement also names `attention --follow`.

## Replaces

Report `0694-dk-16-attention-follow-polling.md` in `docs/reports/efficiency-logging-database/`, deleted with batch E-0694.
