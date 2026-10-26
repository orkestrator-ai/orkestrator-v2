# OpenCode prompt attachment never reaches the provider

Found 2026-10-25 by the OpenCode `live-session` run in
[0014-cli-qualification.md](0014-cli-qualification.md) (branch
`todo-0014-cli-qualification-060fd6539163` on `00a0cb82`).

**Status: finished 2026-10-26.** Every item is done; the file is kept until
the Multi Review of its branch, then deleted per the folder rules. The durable
behaviour is in [agent-engines.md](../../architecture/agent-engines.md#opencode)
(attachment parts and the dispatch-failure outcome) and
[public-cli.md](../../architecture/public-cli.md#request-specific-completion).

## Current state

- `session prompt --attach <text file> --wait` on a live OpenCode session
  (local environment, OpenCode 1.19.0, model `opencode-go/gpt-5.6-luna`,
  API-key credentials) settled `unknown` after about 18 s and exited 7
  (`run-unknown`, "The turn ended but its outcome was not recorded"). It
  happened on both runs that day.
- The disposable OpenCode database for that run held only three user
  messages: the start turn, the follow-up and the `--literal` prompt. The
  attached prompt never became an OpenCode message, so
  `readOpenCodeTurnTerminalError` (`apps/backend/src/core/opencode-turn-outcome.ts`)
  never found an assistant reply whose `parentID` carries the request marker.
  It retried three times and `sessionTurnOutcome`
  (`native-agent-service.ts`) settled `unknown`. That is the safe answer, not
  a false success, but the prompt was lost without saying so.
- Attachments are staged under `.orkestrator/prompt-attachments/<operation>/`
  (`stageAttachments`, `public-api/prompt-delivery.ts`) and sent to OpenCode
  as `file` parts with a `file://` URL (`openCodePromptParts`,
  `opencode-provider-helpers.ts`; `promptAttachmentUrl`,
  `prompt-attachments.ts`). The backend log showed no error.
- Claude passes the same step: the agent quoted the attached file. Todo 0017
  only qualified it on Claude. Codex, Cursor and Grok refuse non-image files
  before admission.

### Root cause (diagnosed 2026-10-26)

`openCodePromptParts` labelled every attachment with `mimeTypeForFilename`,
which falls back to `image/png` for any name that is not an image, so
`attached-note.txt` went to OpenCode as an `image/png` file part. OpenCode
routes a `file://` part by its declared type alone (read from the 1.19.4
server code; the behaviour below reproduces on 1.19.0 and 1.19.4): an image type is read and decoded as an image, and the
text bytes failed decoding. `promptAsync` had already returned 204, so the
failure happened in the background, before the user message was stored, and
reached the backend only as a `session.error` event. Nothing in the turn
outcome read looked at that event.

Reproduced 2026-10-26 against a private `opencode serve` (1.19.0, then
1.19.4; disposable XDG homes, API-key credentials copied in and deleted
afterwards), sending exactly the backend's parts:

- `mime: "image/png"`, text file: 204, then one `session.error`
  (`UnknownError`, "ImageDecodeError: Image could not be decoded" plus a
  stack) and no message at all in the session. This is the lost prompt.
- `mime: "text/plain"`, same file: OpenCode ran its Read tool, stored the
  user message with the file's content and the model answered `PELICAN`
  (the secret word in the file).
- `mime: "text/plain"`, 2 KiB of random bytes: OpenCode published a
  `session.error` ("Cannot read binary file: …"), then still stored the user
  message (with a "Read tool failed" part) and the model answered. A binary
  file is therefore not lost, and a `session.error` alone does not mean the
  prompt was dropped.

## Outstanding work

### Code

1. **Done (2026-10-26): find where the prompt is dropped and make the failure
   reach the run.** Dropped by OpenCode in the background because of the
   `image/png` label (root cause above).
   - `openCodeAttachmentMime` (`opencode-provider-helpers.ts`) labels an
     image attachment by its name as before, a file attachment named like an
     image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) with that image type, and
     every other file `text/plain`. New `imageMimeTypeForFilename`
     (`prompt-attachments.ts`) names an image type only when the extension
     names one; `mimeTypeForFilename` keeps its PNG fallback for images.
   - A prompt OpenCode still drops after accepting it now settles `failed`
     with OpenCode's reason. `OpenCodeStreamState` remembers the request each
     dispatch sent (`beginTurn(sessionId, startedAt, requestId)`) and keeps
     the first non-abort `session.error` after it as `dispatchFailure`
     (message without stack frames). `readOpenCodeTurnTerminalError` returns
     "OpenCode did not accept the prompt: <reason>" when the history holds no
     message for the request (no user message with its marker, no assistant
     answer) and the error is at least
     `OPEN_CODE_DISPATCH_FAILURE_GRACE_MS` (2 s) old; inside that window, or
     with no error, it still throws so the read is retried. An error during a
     turn that did become a message is ignored there; that turn is judged by
     its answer as before.
   - No refusal before admission: OpenCode takes text files as `text/plain`
     parts (live, below), so `assertAttachmentSupport` keeps accepting files
     for OpenCode.
   - The same fix covers the composer: renderer file attachments for OpenCode
     tabs reach the provider through the same `openCodePromptParts`.
2. **Done (2026-10-26): regression tests for the path that failed.**
   - `opencode-provider-dispatch.test.ts`: "sends staged attachments with
     per-prompt model and effort overrides" now also sends
     `01-attached-note.txt` and expects a `text/plain` part; "fails a prompt
     OpenCode accepted and then dropped with a session error" drives the real
     provider through a fake SSE stream: pending inside the grace window,
     `failed` with the reason after it, another request unaffected, and a
     binary-file `session.error` whose message was stored is judged by its
     answer (pending, then completed).
   - `opencode-stream-state.test.ts`: "keeps the first session error after a
     dispatch for that request" (no attribution without a dispatch, user stop
     ignored, stack frames stripped, cleared by the next dispatch).
   - `prompt-attachments.test.ts`: `imageMimeTypeForFilename` names no image
     type for `notes.txt` or a name without an extension.
3. **Done (2026-10-26): scenario harness installs every provider's pinned
   binary.** Needed to run the qualification below. Since #1270 an
   agent-test backend never falls back to `PATH` for Claude, Codex, OpenCode
   or Pi, but `prepareProviderRuntime`
   (`packages/cli/scenarios/provider-runtime.ts`) installed only Grok's
   pinned binary, so `live-session` failed at once for every host provider
   ("OpenCode is not installed in this agent-test profile's toolchain",
   manifest `2026-10-26T00-35-10-927Z-be855dae`). It now returns the
   provider as `toolchainTools` for Claude, Codex, OpenCode, Pi and Grok
   (Cursor has none), and `startIsolatedBackend` installs it with
   `toolchain install --tool` before `serve`.
   `scenario-provider-homes.test.ts` covers the packaged providers and the
   Pi install.

### Qualification

1. **Done (2026-10-26): `live-session` on OpenCode passes the attach step,
   local and container.** macOS (Darwin 27.0.0, arm64), Bun 1.4.4, Docker
   29.9.2, OpenCode 1.19.4 (pinned, installed by the harness), model
   `opencode-go/gpt-5.6-luna` (provider default), API-key credentials.
   - `mise run test:cli:scenarios -- --scenario live-session --provider
     opencode`: pass (51.8 s); `prompt --attach --wait` exit 0 (4.2 s) and
     "transcript after attachment" passed (the agent read the secret word).
     Manifest `2026-10-26T00-36-39-580Z-6b222f87`.
   - Same with `--environment-type container --docker-image
     orkestrator-v2:dev-742a66a47e71`: pass (88.0 s); `prompt --attach
     --wait` exit 0 (8.3 s). Manifest `2026-10-26T00-38-15-570Z-fa598ef6`.
     No cleanup errors in either run.
   - The `failed` path, live: the real `OpenCodeProvider` against a private
     `opencode serve` 1.19.4 with an image attachment whose bytes are text
     (`fake.png`, so OpenCode still decodes it as an image): `turnTerminalError`
     answered "OpenCode did not accept the prompt: ImageDecodeError: Image
     could not be decoded" on its first read, 2.5 s after `send`. The same
     script with the text file as a `file` attachment answered completed.

## Assumptions and decisions

- **MIME type for a non-image file part.** Options: (a) `text/plain` for
  every file, letting OpenCode's Read tool decide; (b) a type per extension
  (`text/markdown`, `application/pdf`, `application/octet-stream`, …);
  (c) refuse files for OpenCode before admission, as Codex does. Chose (a),
  except that a file named like an image keeps that image type (the old
  behaviour for those names). Why: OpenCode routes by declared type only, and
  `text/plain` is the one route that reads text inline, turns images and PDFs
  into attachments and refuses binary content in a message the model still
  receives, so no file is lost. Pros: one rule, every file reaches the agent,
  OpenCode owns content detection. Cons: a binary file arrives as a read
  failure rather than as data; a PDF depends on the Read tool's PDF support
  rather than being sent to the model directly. (b) would inline unknown
  types as data URLs a model may reject; (c) would remove a capability that
  works.
- **How a dropped prompt reaches the run.** Options: (a) remember the
  `session.error` the stream sees after a dispatch and use it in the outcome
  read when the transcript holds nothing for the request; (b) treat any
  `session.error` during the turn as the turn's failure; (c) switch
  attachment prompts to the synchronous `session.prompt` so the HTTP response
  carries the error. Chose (a). Why: (b) would fail a binary-file turn that
  OpenCode stored and answered (it raises the same event first); (c) changes
  the dispatch path every prompt shares (message-id reservation, ambiguous
  dispatch recovery, timeouts) for one failure mode. Pros: narrow, evidence
  based (OpenCode's own event plus an empty transcript), falls back to
  `unknown` whenever evidence is missing. Cons: in-memory only, so a stream
  gap or a backend restart between the error and the read still settles
  `unknown`; the error is attributed to the backend's latest dispatch on that
  session.
- **Grace window of 2 s.** OpenCode publishes the binary-file error a few
  milliseconds before it stores the message; a read inside that gap must not
  fail the turn. The outcome reader retries after 5 s and 10 s, so 2 s costs
  nothing in practice. Smaller risks a false `failed`; larger delays nothing
  useful.
- **Reason text.** The stored reason is the error's message without stack
  frames (OpenCode's `UnknownError` carries a full stack), prefixed "OpenCode
  did not accept the prompt:". The transcript's error notice keeps the full
  message as before.
- **No sticky transcript notice for a dropped prompt.** The stream already
  shows the `session.error` as an error notice until the next authoritative
  read, and with the MIME fix this path is no longer expected in normal use.
  Keeping it past that read would need new transcript state for a case with
  no known trigger left; revisit if a dropped prompt is seen again.
- **Harness installs every pinned provider binary.** Options: install the
  selected provider's pinned binary on every live run; seed the scenario
  toolchain from the host's managed copy; restore a `PATH` fallback for
  scenarios. Chose the install. Why: it matches how Grok already worked and
  the agent-test rule from #1270 (spawn only what the profile pinned).
  Pros: the run uses exactly the pinned version, and Claude, Codex and Pi
  live runs are unblocked too. Cons: each live run downloads the binary
  (OpenCode about 180 MB) within the existing 5-minute install timeout.
- **File kept after finishing.** The folder rules say to delete a finished
  file; like 0069 it stays until the Multi Review of this branch so the
  reviewers have the diagnosis and evidence, then it is deleted.

## Constraints and rationale

- A dropped prompt must never look like a completed one; `unknown` is
  correct until the cause is known, but it is not an answer to ship.

## Open questions

- None.

## Related

- [0017-cli-command-surface.md](0017-cli-command-surface.md) (prompt
  attachments, item 3).
- [0014-cli-qualification.md](0014-cli-qualification.md) evidence log,
  2026-10-25 and 2026-10-26.
