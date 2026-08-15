# Cursor / ACP interactive snapshot size limit

Status: fixed on 2026-08-15. The incident analysis below describes the former
8 MiB transport path and is retained for regression context.

## Resolution

The native transcript path now uses a 16 MiB byte-aware ceiling and degrades to
an explicit tail window instead of failing the connection. The implementation
also reduces both serialized size and transfer bandwidth:

- Cursor and Grok fetch bounded `/messages` and `/status` responses separately,
  so composer/runtime metadata no longer consumes the transcript body budget.
- ACP re-bounds persisted state on every transcript read and reserves envelope
  headroom below the 16 MiB consumer cap. The re-bound is skipped when nothing
  has been appended since the last check, so polling a large idle session does
  not re-serialize the whole transcript on every request.
- Codex and Claude bound aggregate `/messages` responses to 16 MiB as well.
  All three ceilings run through one implementation,
  `@orkestrator/protocol/transcript-window`, which drops whole messages
  oldest-first, then parts off the front of the oldest message left, then the
  head of that message's own content. Part sizes are measured once and
  subtracted as parts are shed; re-measuring the message per shift made the
  overflow path quadratic in the number of parts.
- Large tool output, errors, and diff bodies are omitted from ordinary renderer
  projections and loaded through an opaque, session-scoped reference only when
  the user expands that tool row. A deferred diff keeps a `deferred` marker on
  its metadata: providers that identify a file mutation by diff content rather
  than tool name would otherwise be indistinguishable from a location-only hint
  on a read tool and would lose the edit treatment while collapsed.
- A unified diff is no longer accompanied by redundant full before/after file
  snapshots, and failed-command output is no longer duplicated as both output
  and error.
- Staged images retain their path but do not resend their inline data URL in
  every projection.
- Transcript HTTP responses negotiate gzip internally. The browser gateway's
  existing Brotli/gzip compression continues to cover the renderer hop.
  Compression is always off the event loop: the Codex and Claude bridges use
  Hono's streaming `compress()`, and the ACP bridge — one process that also
  runs the agent's JSON-RPC stdio loop and every session's SSE writer — uses
  the asynchronous `zlib.gzip` rather than `gzipSync`, which would stall all of
  them for the duration of a multi-megabyte read.

Regression coverage includes aggregate single-turn overflow, single-message
part trimming, UTF-8-safe content fallback, linear-time trimming of a
many-part message, persistence and restart, repeat reads leaving a bounded
transcript untouched, exact response-size bounds, deferred-detail loading and
its cross-session rejection, eviction recovery, the per-entry detail cap,
the split ACP status/transcript read with its truncation notice, and
compressed transcript responses on all three bridges.

This document records why a live Cursor native tab can render **Connection
Failed** with the exact message `cursor interactive snapshot is oversized`, even
though the ACP bridge claims to keep transcripts under 8 MiB. The same path
applies to Grok ACP sessions; the agent name in the error is interpolated from
the provider (`cursor` or `grok`).

The failure is a **budget mismatch between producer and consumer**, not a
network outage. The bridge process is up, the session exists, and Retry hits
the same oversized body.

## Symptom

`NativeChatShell` shows Connection Failed whenever the native-agent projection
has `connection: "error"`. That field is set when
`NativeAgentService.refreshProjectionOnce` throws while building the
authoritative snapshot.

For Cursor and Grok the throw happens before any message is parsed. The backend
reads `GET /session/:id` from the ACP bridge with a hard byte cap:

```text
boundedJson(response, `${this.agent} interactive snapshot`, { remaining: 8 * 1024 * 1024 })
```

`boundedJson` (`apps/backend/src/core/build-pipeline-provider.ts`) streams the
HTTP body and, the moment `remaining` goes negative, cancels the reader and
throws `ProviderUnavailableError("cursor interactive snapshot is oversized")`.
That string is copied into `projection.turn.error` and displayed under the
headline. The tab never reaches transcript rendering, composer controls, or
the incremental `/session/:id/messages` window.

Retry cannot help: the idle session stays slightly over the cap, and GET does
not re-bound it.

## Layers that all say "8 MiB"

Several independent 8 MiB numbers exist. They are not the same budget.

| Layer | Constant | What it measures | When it is enforced |
| --- | --- | --- | --- |
| ACP bridge transcript | `MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024` | `JSON.stringify(state.messages)` only | Periodically while streaming, on prompt start, and on persist restore. **Not** on GET. |
| ACP check interval | `TRANSCRIPT_CHECK_INTERVAL_BYTES = 64 * 1024` | Incrementally charged new bytes since the last full stringify | A full bound runs only after this much new charged data, or when message count exceeds `MAX_MESSAGES`. |
| Backend Cursor/Grok snapshot | `boundedJson(..., { remaining: 8 * 1024 * 1024 })` | The **entire** `GET /session/:id` JSON body | Every tab refresh / mount / Retry. Hard fail; no truncation. |
| Native projection | `NATIVE_PROJECTION_MAX_BYTES = 8 * 1024 * 1024` | Windowed, normalized messages after a successful fetch | Not reached if `boundedJson` already threw. Would throw `Provider transcript projection is oversized`. |
| ACP persisted state | `MAX_STATE_FILE_BYTES = 16 * 1024 * 1024` | `state.json` for **all** sessions of one environment/provider | Persist refuses to write above 16 MiB. An 8.3 MiB file is legal. |

Codex and Claude do **not** put the transcript in the same HTTP body as
composer metadata. Their interactive snapshot reads `/status` or `/session/:id`
with a **512 KiB** cap, then reads messages on a separate request. Cursor and
Grok are the exception: one combined `publicSession` payload.

## What `GET /session/:id` actually returns

`publicSession` (`bridges/acp-bridge/src/index.ts`) is:

```text
{
  id, provider, status, error,
  messages,          // the 8 MiB-bounded array
  baseIndex, revision, sessionId,
  composer,          // full model catalog + selected ids
  contextUsage?,     // Cursor usually omits this
  runtime            // version, mcpServers, commands, state
}
```

The bridge's 8 MiB bound applies to `messages` alone. The HTTP body the backend
caps at 8 MiB is `messages` **plus** the envelope. Even a transcript that is
exactly 8 MiB will overflow once composer and metadata are attached.

Composer is not huge (about 5–12 KiB for ~35 Cursor models and two modes) but
it is enough to cross a cap that was already saturated by the transcript.

The bridge also exposes `GET /session/:id/messages?fromIndex=`, documented as
an incremental window so "the whole transcript, which is bounded at 8 MiB,
would otherwise be re-sent on every poll". The backend's Cursor/Grok
`interactiveSnapshot` never uses that route. Every mount and Retry asks for
the full `publicSession`.

`GET /session/:id` is also a liveness touch (it refreshes `lastAccessed`).
That is why a background reconciler must not poll it; a human opening the tab
is supposed to. The size bug therefore appears exactly when the user looks at
the chat.

## How the bridge thinks it is bounding

`boundTranscript` is the only function that can shrink `state.messages`:

1. Drop whole messages from the front while `messages.length > MAX_MESSAGES`
   (500).
2. Recompute `bytes = Buffer.byteLength(JSON.stringify(state.messages))`.
3. While `bytes > MAX_TRANSCRIPT_BYTES` and more than one message remains,
   drop the oldest message.
4. If a single message remains and still overflows, drop **parts from the
   front** of that message until one part is left.
5. If that last part still overflows, set `status = "error"` and
   `error = "${provider} output exceeded the transcript limit"`. It does
   **not** truncate the remaining part's content.

Two properties of a Cursor coding turn make this weaker than it looks.

### One assistant message owns the whole turn

Tool updates always upsert onto `state.messages.at(-1)`. A long unattended
startup turn is typically **one** assistant message with hundreds of parts.
Step 3 never runs: there is no older message to drop. The bound can only
delete the *beginning* of the current turn (early searches and reads) while
leaving the bulky later tool diffs in place.

The 2026-08-15 incident session was exactly this shape: 1 assistant message,
246 parts, no user/assistant split that `boundTranscript` could evict.

### Bounding is deferred by 64 KiB

Text chunks and tool-part patches do not stringify the whole transcript on
every ACP notification. They add to `uncheckedTranscriptBytes` and call
`boundTranscript` only when that counter reaches 64 KiB (or the message count
hits 500).

Tool parts are patched in place. The charger records `JSON.stringify(part)`
and only bills the delta against the previous `chargedBytes`, so a streaming
1 MiB diff is not re-billed every frame. That is correct for CPU, but it
means the **full-array JSON overhead** (message envelope, part metadata,
commas, `content` duplicated onto the parent message for text) is invisible
until the next full stringify.

After a successful `boundTranscript`, `messages` are ≤ 8 MiB. The next
64 KiB of charged growth is allowed before the next check. GET does not
check at all. An idle session can therefore sit forever in the window
`(8 MiB, 8 MiB + 64 KiB]`.

Per-part caps do not prevent the sum from reaching that window:

| Cap | Limit |
| --- | --- |
| `MAX_MESSAGES` | 500 |
| `MAX_PARTS_PER_MESSAGE` | 512 |
| `MAX_MESSAGE_TEXT_BYTES` | 2 MiB |
| `MAX_TOOL_ARGUMENT_BYTES` | 512 KiB |
| `MAX_TOOL_OUTPUT_BYTES` | 512 KiB |
| `MAX_TOOL_DIFF_BYTES` | 1 MiB |
| `MAX_TOOL_INLINE_FILE_BYTES` | 256 KiB |

A few dozen `read` / `edit` / `search` parts, each well under their own cap,
add up to 8 MiB. The incident was 191 tool invocations (93 read, 58 edit, 38
search, 2 updateTodos) plus 52 thinking parts.

## Why Codex/Claude tabs do not fail the same way

`interactiveSnapshot` branches:

- **Cursor / Grok:** one `GET /session/:id`, 8 MiB body cap, messages and
  composer together.
- **Codex:** `GET /session/:id/status` (512 KiB) + `GET .../config` (128 KiB)
  + `GET .../messages` separately.
- **Claude:** session metadata at 512 KiB, messages on `/messages`.

Splitting metadata from transcript is what keeps those providers inside their
caps. The ACP bridge already has `/session/:id/status` (status, error,
revision, composer, no messages) and `/session/:id/messages`. The backend
simply does not use that split for ACP.

OpenCode has its own oversized-snapshot errors
(`OpenCode interaction snapshot is oversized`) at
`AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes` (256 KiB), which is a
different, tighter interaction-card budget.

## Request path from tab to error

```text
NativeChatShell (Connection Failed)
  <- AgentNativeTab.connectionState = projection.connection
    <- NativeAgentService.refreshProjectionOnce
      <- provider.interactiveSnapshot(providerSessionId)
        <- GET {acp-bridge}/session/{id}
           body streamed into boundedJson (8 MiB)
             over -> ProviderUnavailableError
               -> projection.connection = "error"
               -> projection.turn.error = "cursor interactive snapshot is oversized"
```

If `boundedJson` had succeeded, `projectionMessages` would still refuse a
normalized window whose JSON exceeds `NATIVE_PROJECTION_MAX_BYTES` (also
8 MiB). That second check was not reached in the incident because the HTTP
body was already over.

The error projection keeps any *previous* successful snapshot's messages when
one exists. A first paint or a process that never cached a projection shows
an empty chat and the Connection Failed card. That matches the screenshot:
no transcript, only Retry.

## Persistence vs live GET

ACP state lives at:

```text
{dataDir}/acp-bridge-state/{sha256(environmentId)[0..32]}/{provider}/state.json
```

On macOS, `{dataDir}` is typically
`~/Library/Application Support/orkestrator-v2`. The file may be up to 16 MiB
and contains every Cursor (or Grok) session for that environment, including
prompt journals, structured output, and composer.

Consequences:

- Persist can succeed for a session whose `publicSession` body is already
  illegal for the backend's 8 MiB GET cap.
- Restore *does* call `boundTranscript`. A bridge restart would trim
  `messages` back under 8 MiB — but would still leave no headroom for
  composer, so GET can still fail after restore if the transcript is at the
  ceiling.
- A long-lived bridge (`cursorBridgePid` still running) never restores, so
  the 64 KiB overshoot stays in memory and on disk until the next stream
  event that trips the interval.

`boundTranscript` is also called at the start of each prompt. An oversized
idle session is therefore not trimmed until the user sends another message
on **that** session — which they cannot do, because the tab will not load.

## Incident (2026-08-15, `default-reasoning-settings`)

Environment `3794a8ab-9f6a-4c2e-9257-99df145c9782`, Cursor ACP state file
`acp-bridge-state/ed7f447a968ac93421d64fed63d4575b/cursor/state.json`.

Measured from the persisted file (UTF-8 JSON byte lengths):

| Object | Bytes | MiB | vs 8 MiB cap (8,388,608) |
| --- | ---: | ---: | --- |
| Whole `state.json` (3 sessions) | 8,749,841 | 8.34 | persist cap is 16 MiB; OK |
| Startup session `messages` | 8,400,428 | 8.01 | **+11,820** |
| Startup session `publicSession` | 8,405,833 | 8.02 | **+17,225** |
| Startup session composer | 5,197 | 0.005 | envelope that GET counts and the transcript bound does not |
| Other Cursor session A `publicSession` | 100,410 | 0.10 | fine |
| Other Cursor session B `publicSession` | 227,263 | 0.22 | fine |

Startup session identity: provider session `ef9bf2c47a8197a4a224883bbd120ad0`,
logical key `…:startup-agent`, status `idle`, revision 3354, **1** assistant
message, 246 parts (191 `tool-invocation`, 52 `thinking`, 3 `text`). This is
the turn that applied the default-reasoning-settings code change.

The overshoot (+12 KiB on messages, +17 KiB on the HTTP body) sits
comfortably inside the 64 KiB check interval plus the composer envelope.
That is the smoking gun: the binder believed it was still under, the
consumer used a hard 8 MiB cap on a larger object, and GET never rebound.

The other two Cursor tabs in the same environment were well under the cap.
Only the long startup transcript was affected. Opening a new Cursor tab
works; Retry on the original tab does not.

## What caused this session to be large

Not a single oversized file and not a leak of the 16 MiB persist file into
GET. The size is the **sum of a long tool-heavy turn**:

1. **Unattended startup agent.** The environment's initial prompt asked for a
   repo-wide reasoning-default change. That is exactly the workload that
   produces tens of `search` hits, tens of full-file `read`s, and tens of
   `edit` diffs in one turn.
2. **Tool payloads retained in the live transcript.** Each ACP tool part
   keeps `toolArgs`, `toolOutput`, and/or `toolDiff` up to the per-part
   caps. `read` of ordinary TypeScript/TSX source and `edit` diffs of those
   files are large enough, in aggregate, to reach 8 MiB without any one part
   hitting 1 MiB.
3. **Thinking parts.** 52 `thinking` chunks sit alongside the tools. They
   are charged as text (`byteLength * 2` because parent `content` and part
   `content` both grow) but they are not evicted except as front-of-message
   parts if `boundTranscript` actually runs.
4. **No second message to drop.** `boundTranscript`'s cheap eviction is
   whole older messages. A single-turn session cannot use it.
5. **Idle after the last 64 KiB window.** The session finished and went
   `idle` slightly over 8 MiB. Nothing called `boundTranscript` again.
6. **Combined snapshot fetch.** Tab mount asked for `publicSession`, which
   added composer on top of an already-over transcript.

Secondary contributors that did **not** decide this incident, but will
decide the next one:

- **No headroom constant.** Even a perfectly bounded 8 MiB transcript cannot
  fit in an 8 MiB `publicSession` body.
- **Test gap.** `bridges/acp-bridge/src/index.test.ts` asserts
  `JSON.stringify(session.messages) < 8 MiB` after an oversized turn. It does
  not assert the HTTP body of `GET /session/:id`, does not add composer size,
  and does not simulate the 64 KiB deferred check against a consumer with a
  matching hard cap.
- **Fail-closed UI.** An oversized snapshot is treated like a down bridge.
  There is no truncated-window fallback, no use of `/messages?fromIndex=`,
  and no "transcript truncated" banner that still shows the tail.
- **Grok shares the code.** A Grok tab with a similar tool-heavy turn would
  fail as `grok interactive snapshot is oversized`.
- **`messageWindow` also embeds `composer`.** Switching the backend to
  `/messages` without a `fromIndex` still ships the catalog beside the
  transcript. Incremental `fromIndex` is the actual size win, and only if
  the first window is itself capped.

## What a fix has to satisfy

Any change should keep the efficiency-plan invariants: long-running state in
the bridge, live events as incremental updates over an authoritative
snapshot, bounded queues, and no silent drop of authoritative frames.

Minimum bar:

1. **One number, one object.** The byte cap the backend enforces on
   `GET /session/:id` must be the byte cap the bridge enforces on
   `publicSession` (or the backend must read split routes). Bounding
   `messages` to 8 MiB and then serving `messages + composer` under an 8 MiB
   GET cap is internally inconsistent.
2. **Headroom or split.** Either reserve envelope budget
   (`MAX_TRANSCRIPT_BYTES = GET_CAP - max(composer, runtime, usage)`) or
   fetch composer from `/status` / `/config` and messages from `/messages`
   the way Codex already does.
3. **Bound on read, not only on write.** `GET /session/:id` should not
   serialize a body the consumer will reject. Re-running `boundTranscript`
   (against the *public* payload size) on GET, or refusing to persist a
   `publicSession` that cannot be served, closes the idle-overshoot hole.
4. **Tighten near the ceiling.** Once remaining budget is below
   `TRANSCRIPT_CHECK_INTERVAL_BYTES`, every patch should full-stringify, or
   the interval should drop to zero. Otherwise the deferred check is a
   licensed overflow of up to 64 KiB.
5. **Do not fail the connection.** Prefer a truncated tail plus an explicit
   desync/truncation notice over `connection: "error"`. The session is not
   missing; the snapshot is too large. Retry should then succeed on the
   trimmed body.
6. **Test the consumer object.** Cover: messages at `MAX_TRANSCRIPT_BYTES`,
   composer attached, GET body ≤ backend cap; a 64 KiB post-check overshoot
   still serves; a 191-tool single-message turn is truncated rather than
   disconnecting the tab; Grok uses the same assertion.

Until that lands, the workaround is operational: open a **new** Cursor tab.
The oversized session remains in `state.json` and will fail again if that
tab is selected. Restarting the Cursor bridge may trim `messages` under
8 MiB via restore, but without envelope headroom Retry can still fail.
)
