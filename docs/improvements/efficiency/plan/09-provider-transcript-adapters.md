# 09 — Implement lightweight transcript and detail reads for every provider

Status: Complete — all five HTTP bridges serve v2; OpenCode is in-process (projection defers artifacts before windowing). Validated on real Codex and Claude sessions (step 19).

## Outcome

Large artifacts do not enter the bridge live window merely to be removed later
by the backend. Each provider advertises only features it actually implements.
Native chat can use summaries without breaking old clients or exact consumers.

## Provider work map

| Provider | Main owners | Particular constraint |
| --- | --- | --- |
| Claude | `routes/session.ts`, `services/session-manager-*` | Revision from step 05; hydration and local overlays |
| Codex | `index.ts`, `app-server-runtime-sessions.ts`, `messages/` | Never await from stdout; attached vs cached preview |
| Cursor | `http.ts`, `translate.ts`, `transcript.ts`, `state.ts` | Producer bounds and stable identity after trim |
| Pi | `http.ts`, `translate.ts`, `transcript.ts`, `state.ts` | SDK events synchronous; durable Pi history remains authoritative |
| Grok/ACP | `acp-http.ts`, `acp-transcript.ts`, `acp-public.ts` | Truncation notices and replayed updates |
| OpenCode | Backend `opencode-snapshots.ts`, `opencode-stream-state.ts` | In-process adapter; incremental SSE cache and SDK v2 |

Paths for bridge rows are under `bridges/<provider>-bridge/src/`; backend rows
are under `apps/backend/src/core/`. New small adapter modules should keep
normalization out of route/composition-root files.

## Shared implementation

1. Build summaries from the normalized message boundary, before response
   windowing. Reuse completed summary parts by trustworthy mutation revision.
   Keep current raw provider state for its existing duties; do not eagerly
   duplicate every payload into a second artifact store.
2. Prefer a locator into already owned exact data. If the only representation
   is a mutable transient value, freeze/version that specific detail at a
   bounded handoff point. Historical locators must not resolve to the latest
   mutated value. Cap retained detail revisions and return expired explicitly.
3. Issue detail locators with source message/part identity and content revision.
   Backend/frontend requests carry identity and authorization context; a client
   cannot replace the locator with an arbitrary provider file path or URL.
4. Perform per-message/part summary sizing through step 02, then apply the live
   window. A multi-megabyte screenshot must leave a small attachment summary
   rather than displacing every earlier message.
5. Make unchanged reads depend on the summary revision, metadata, and window
   parameters, without serializing raw details. Detail changes that alter a
   summary's locator/preview invalidate that part's revision.
6. Serve details under independent response and in-flight byte limits. A slow
   artifact consumer cannot hold a provider stdout callback or block unrelated
   summary reads. Catch cancellation errors; share reads only with correct
   ownership/ref-counting and per-session scope.
7. Extend `HttpBridgeProvider` and the in-process OpenCode adapter to expose
   the new surface. Keep backend detail normalization compatible with existing
   `get_native_agent_tool_details` callers, translating locators internally.
8. Update projection hydration decisions: use summary completeness/pageability,
   not raw artifact size, to decide if a broader read is necessary. Retain a
   bounded legacy fallback for unsupported bridges, recording its use.

## Provider-specific checks

- Claude: overlays, background task decoration, SDK history load, and title-only
  changes all participate in summary revision. Do not spawn catalogue probes
  to answer transcript or detail reads.
- Codex: freeze detail revisions off the stdout path; avoid keeping entire render
  state alive through one detail reference. Detached previews remain cached and
  incomplete until their source history is actually hydrated.
- Cursor/Pi/ACP: audit new-part initialization as well as append paths. IDs must
  not be derived solely from the current length after front trimming. Preserve
  active lifecycle registries when summary rows are evicted.
- OpenCode: retain `/v2/client` imports and current SSE rejection handling. A
  cached source revision may skip normalization; do not re-fetch SDK history
  simply to mint a detail reference.

Before invoking new vendor SDK/CLI capabilities, resolve current documentation
through Context7 as required by AGENTS.md. No upgrade is assumed by this plan;
use the existing pinned API or preserve a documented capability fallback.

## Tests and rollout

Run the shared contract fixture through every adapter: large result, diff,
image, nested tools, missing detail, streaming mutation, trim, restart, rewind,
and generation replacement. Compare visible summaries with legacy behavior and
exact details with the source revision. Test old clients against new bridges and
new backend against an old bridge returning v1.

Ship one provider family at a time behind actual capability advertisement;
enable backend preference only when that adapter's tests pass. Measure raw bridge
bytes and incomplete-hydration calls before/after. E06 is complete only when all
six providers have the new behavior or an explicit bounded fallback documented
with its remaining cost.

## Execution record

```text
Status: Complete — bridge half and backend half implemented (backend half below)
Implementation commit / PR: branch worktree-agent-a4451cb3afadce5d0, commit "perf(bridges): serve v2 lightweight transcripts, exact details and history pages"; no PR yet
Protocol or storage decisions: see "Bridge half" below
Tests and isolated profiles: focused Bun suites below; no isolated Electron/browser profile was started
Before/after measurements: synthetic 300-message transcript, each message with a 20 KiB tool output, default 100-message / 512 KiB window: v1 517,803 bytes carrying 25 messages; v2 36,207 bytes carrying 100 messages (every output behind a detail locator)
Compatibility/migration result: absent or non-"2" `version` answers the v1 envelope byte-for-byte from the same inputs; detail/page are new routes that answer unknown sessions in band; stored nothing, so there is no migration
Remaining limitations: see below
```

### Bridge half (Claude, Codex, Cursor, Pi, Grok/ACP)

- `packages/protocol/src/bridge-transcript-routes.ts` (new, additive): one
  `BridgeTranscriptSource` per request (messages, identity, generation,
  content epoch, revision, completeness, freshness, title) and the three route
  bodies built from it. `bridgeTranscriptRouteBody` answers
  `bridgeTranscriptSummaryUpdate(..., { pages: true })` for `version=2` and the
  unchanged `bridgeTranscriptUpdate` otherwise; the detail and page bodies
  answer an absent source `missing` / `expired` and an absent locator or
  cursor `invalid`. The semantics of `bridge-transcript-summary.ts` are
  untouched.
- Each bridge computes the source once in a small helper, so the summary,
  detail and page routes read the same array, generation, epoch and
  completeness: Claude `routes/session-transcript.ts` (`peekSession` +
  `getSessionMessages` + `readTranscriptVersion`; also owns the three routes
  and the detail/page gzip registration), Codex `transcript-routes.ts`
  (`getStatus(id, false)` + `getCachedMessages`; no touch, attach or await),
  Cursor/Pi `transcript-source.ts`, ACP `acp-transcript-source.ts`. Cursor, Pi
  and ACP call `boundTranscriptForRead` before building it, exactly as the
  summary route does.
- New routes `GET /session/:id/transcript/detail?locator=` and
  `GET /session/:id/transcript/page?cursor=&limit=&targetBytes=` on every
  bridge, behind the same auth. Unknown sessions answer 200
  `{version:1,status:"missing"}` / `{version:1,status:"expired"}`; the summary
  route keeps its 404. Routing: Claude/Codex are Hono paths (no route swallows
  them; `/transcript/other` stays 404). Cursor and Pi route by
  `action`/`subject`, where `/transcript/<anything>` always answered the
  summary; `detail` and `page` are now dispatched first and other sub-paths
  keep that behavior. ACP's anchored route regex gained exactly
  `transcript/(detail|page)`, so other sub-paths stay 404.
- Liveness: Claude refreshes the idle clock through `getSessionMessages`, as
  the summary route does; detail/page never hydrate, never start hydration and
  never probe the catalogue. A cursor minted from the preview epoch expires
  once hydration flips it to `hydrated:<epoch>`. Codex reads do not touch
  liveness (as before). Cursor/Pi refresh `lastAccessed` for every
  `transcript` action; ACP has no idle clock.
- Compression: Claude and Codex register gzip + `Vary: Accept-Encoding` for
  the detail and page paths beside the transcript's own; Cursor/Pi/ACP use
  their `json` helper, which compresses only when the client asked.
- Epoch fixes needed for positional pages (both also correct v1 `startIndex`):
  Codex's local ring (`appendLocalMessages`) now bumps `contentEpoch` when it
  drops its oldest rows; Pi gains a process-local `transcriptEpoch`, bumped by
  branch navigation's `resetRenderedHistory`, and the epoch becomes
  `"<transcriptEpoch>:<droppedMessages>"` only after such a replacement (the
  same scheme Cursor already used), so an untouched session keeps its numeric
  epoch and token.
- The Claude source-scan test now asserts that no route calls the envelope
  helpers directly and that all three bodies read the revisioned source.
- `AGENTS.md`: one bullet under "Tab close and conversation retention".

### Tests run (bridge half)

- `bun test ./bridges/{claude,codex,cursor,pi,acp}-bridge/src --parallel=2`
  (logged runner): all pass. New suites:
  `claude-bridge/src/services/session-manager-transcript-v2.test.ts`,
  `codex-bridge/src/transcript-routes.test.ts`,
  `cursor-bridge/src/http-transcript-v2.test.ts`,
  `pi-bridge/src/http-transcript-v2.test.ts`,
  `acp-bridge/src/acp-http-transcript-v2.test.ts`; each covers a v2 snapshot
  where a >4 KiB output becomes a locator and an earlier message stays in a
  window v1 drops it from, v2/v1 unchanged tokens, detail ok/expired/missing/
  invalid, a 250-message page walk with advancing cursors, cursor expiry after
  an epoch change, and in-band unknown-session answers (plus auth, gzip,
  no-hydration and liveness where the bridge has them).
- `bun test --cwd packages/protocol ./src --parallel=2`: pass (new
  `bridge-transcript-routes.test.ts`).
- Typecheck of protocol and all five bridges; `mise run format:check`;
  `mise run lint` (no new warnings).

### Remaining limitations (bridge half)

- The backend does not request `version=2` or call detail/page yet (the
  orchestrator's half); OpenCode (in-process) is not covered here.
- Summaries are built per read from the retained messages (the protocol
  memoizes per-part digests); no provider freezes detail revisions, so a
  streaming tool card's locator expires as soon as its output changes.
- Claude history before the live array is not pageable beyond what the
  session holds; Cursor/Pi/ACP pages stop at their retained front trim and
  Codex's detached preview pages only the local tail until hydration.
- Claude harness suites cannot share one Bun process with each other (true of
  the existing suites too); they pass under the repo's `--parallel` runner.

### Backend half (orchestrator)

- `http-bridge-transcript-v2.ts` + `http-bridge-transcript-reader.ts`: the
  native projection's `transcriptSnapshot` asks for `representation:
  "summary"`; the HTTP provider sends `version=2` unless this connection
  already answered v1 (negative answer cached 10 minutes; a 5xx, timeout or
  malformed body is a failed read, never a capability verdict). A v1 answer to
  the v2 request is used as-is, so an old bridge costs no second request.
  Detail/page 404/405 mean "route absent" for that connection. Other
  consumers (reviewer views, workflows) keep raw v1 bodies.
- Projection: summary `detail` locators become session-scoped backend
  `detailRef`s registered as remote entries (no body fetched); expanding a
  row calls `provider.transcriptDetail` once, caches the exact body under the
  existing tool-detail budget, and reports missing/expired as "no longer
  available" (never a newer body). Summary windows skip the legacy
  incomplete-preview hydration (the `/messages` full read) unless the head is
  part-trimmed.
- OpenCode is in-process: there is no bridge hop to move artifacts across.
  Its snapshot is projected (heavy fields → local detail refs) before the
  live-window byte bound is applied, so large artifacts already do not
  displace earlier rows. Remaining cost: inline heavy bodies are serialized
  and hashed once per changed read to mint content-addressed refs (as for v1
  bridges).
- Tests: `apps/backend/src/core/http-bridge-transcript-v2.test.ts`
  (v2 bridge, old bridge answered-v1-and-remembered, missing routes, failures
  prove nothing, malformed v2 is an error, negative expiry) and
  `native-agent-service-summary-transcripts.test.ts` (remote reference
  resolved exactly once and cached, changed body → expired, no legacy
  `/messages` or interactive snapshot on the summary path).
- Measured structurally: a 300 × 20 KiB-output transcript sends 36 KB with
  100 messages over v2 versus 518 KB with 25 messages over v1 (bridge half).
