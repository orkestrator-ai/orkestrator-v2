# The `/messages` fallback ignores the limit it has in scope

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Pass the limit to the fallback read**: request only the rows the caller will keep. Status: open.

### 1. Pass the limit to the fallback read

**Problem.** When `/transcript` is unavailable, the fallback reads the whole `/messages` body (up to 16 MiB) and then slices it to the limit it already knew.

**Context.** This path stays until the support window passes a release whose Claude bridge materialises sessions on `/transcript` (see the comment in `readHttpBridgeTranscriptSnapshot`). A small fix, with no baseline needed under the maintainer's hybrid rule in 1202 task 1.

**Investigation.** `apps/backend/src/core/http-bridge-transcript-reader.ts:66` passes `readLegacy: () => this.legacy(sessionId)`, though `legacy` takes a `limit` (`:41`) and `options.limit` is in scope. The fallback slices afterwards (`http-bridge-progressive.ts:119-122`), so a bridge that predates `?limit=` still gives the right answer. Claude, Codex, Cursor, Pi and ACP all parse the parameter (for example `bridges/claude-bridge/src/routes/session.ts:704`).

The `complete` flag needs care. It is `!legacy.truncated && legacy.messages.length <= limit` (`http-bridge-progressive.ts:123`). Today a longer transcript fails the length check. With the limit passed, the length check always succeeds, so `complete` depends on the bridge setting `messageWindow.truncated` when the limit cut rows.

**Decisions.** None: the change is one argument, once the check below has passed.

## Constraints and rationale

- A wrong `complete: true` would make a client treat a tail as the whole history, so the check in Needs verification must come first.

## Needs verification

- That each bridge sets `messageWindow.truncated` when `?limit=` cuts rows. The route code was read, but the flag was not traced through every bridge's window helper.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-18)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0150](0150-tx-2-tx-15-post-dispatch-raw-reads.md): the wider limit work
