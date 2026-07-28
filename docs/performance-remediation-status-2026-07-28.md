# Performance remediation status — 2026-07-28

This document reconciles:

- `docs/performance-review-2026-07-28.md`
- `docs/performance-review-transcript.md`
- the implementation currently present in this worktree

## Outcome

All eight high-impact findings are implemented. The concrete medium-impact
items are also implemented, including the items that were still partial when
the earlier agent stopped: terminal filtering end to end, completed-item render
caching in the Codex bridge, zero selector-less production Zustand
subscriptions, a bounded local file-tree scan, and replay cursors for Claude
SSE.

The remaining entries from the original "low-impact" list are documented at
the end. They are either intentionally retained correctness trade-offs or
opportunistic micro-optimizations rather than untracked gaps.

## High-impact findings

| # | Finding | Status | Implemented outcome |
|---|---|---|---|
| 1 | `environments.json` write amplification | Complete | Stat-validated read cache; activity-only writes skip backup rotation; timestamp-only lease renewals suppress announcements; no-op updates bail; lease sweeps skip locking when no leases exist; Docker state uses a shared 3-second `docker ps` snapshot with safe `inspect` fallback on disagreement. |
| 2 | OpenCode full-transcript streaming refetch | Complete | `message.part.updated` and message metadata apply incrementally; full fetch is reserved for final reconciliation and failed incremental application; streaming fallbacks skip recursive subagent hydration; subagent ID discovery is reference-cached; message identities survive equal snapshots. |
| 3 | Claude BuildChatTab ignored delta patches | Complete | `message.updated` upserts and revision-checked `message.patched` updates are applied directly. Full transcript fetch is now recovery/final reconciliation, not the normal streaming path. OpenCode build chat received the equivalent incremental path. |
| 4 | Codex whole-home catalog scans | Complete | Direct per-thread lookup runs before catalog fallback; whole-home catalog builds share a short-lived promise cache; `/session/list` reuses generated titles rather than parsing the title index twice. |
| 5 | Claude tmux polling/transcript I/O | Complete | Hook directories and transcript size are sampled in one operation; liveness checks run at a slower cadence; transcript reads start at the prior byte offset and preserve split UTF-8/JSONL tails; state polling avoids storage on unchanged observations; pane capture coalesces concurrent requests and backs off while idle; previous-session metadata uses a head read plus line count. |
| 6 | Terminal output serialization/fan-out | Complete | PTY and tmux terminal bytes use base64 rather than JSON number arrays; PTY callbacks coalesce to a 16 ms window with a hard pending cap; the rolling backend buffer is chunked; gateway clients have soft/hard backpressure limits and explicit desync recovery; remote browsers receive non-terminal events plus only terminal session streams they currently consume. |
| 7 | Transcript normalization identity churn | Complete | WeakMap caches cover native, Claude, and split-Claude display normalization; equal transcript snapshots preserve both array and message identities; optimistic matching avoids full tool payload serialization. |
| 8 | Selector-less Zustand subscriptions | Complete | Production `apps/web/src` now has zero `useXStore()` calls without a selector. Hot tabs, compose bars, app root, terminals, sidebar, files panel, settings, dialogs, and utility hooks subscribe to the exact fields/actions they consume. Global environment lifecycle listeners are mounted once. |

## Medium-impact findings

### Backend and renderer data refresh

- The duplicate 60-second environment-list interval was removed; the global
  resource resync remains the single safety net.
- Environment, config, and session snapshots now preserve store identity when
  the authoritative data is equal.
- Files-panel polling publishes only changed digests.
- Local file-tree traversal is capped at 5,000 nodes, matching the bounded
  container path, and skips symlinks plus dependency/Git directories.

The global safety resync still checks every known environment. This is
intentional: background environments continue running while their React tree
is inactive, and the project reliability contract requires them to rehydrate
after missed events.

### Codex bridge

- SSE event JSON is serialized once per event and reused for subscribers and
  replay.
- The replay ring is capped at 4 MB and releases retained payloads after 60
  seconds without a subscriber; its cursor continues advancing so a later
  client receives `replay.required` instead of stale or incomplete frames.
- Completed app-server items cache their normalized parts, so only mutable
  streaming items are rebuilt.
- The redundant pre-probe `collectTurnItems` pass was removed.
- Diff baselines maintain an O(1) byte count.
- JSONL RPC parsing tracks the scan offset, avoiding quadratic rescans for
  large lines.

### Claude bridge

- Streaming text/thinking deltas use append accumulators and publish only dirty
  part changes.
- Idle hydrated transcripts are evicted and remain disk-rehydratable.
- CLI discovery/version probes are asynchronous rather than event-loop-blocking.
- Slash-command discovery is fingerprint-cached.
- SSE serialization is shared and byte-accounted.
- SSE now has a 512-frame/4 MB replay ring, monotonic cursors, subscribe-before-
  replay ordering, bounded handshake buffering, `Last-Event-ID`/`since`
  resumption, and an authoritative transcript fallback when a cursor is too old.
  Retained payloads are released after 60 seconds without a subscriber.

### Components

- `TerminalContext` retains its public API but its provider value is stable.
  Splitting state/actions contexts is no longer required to eliminate
  provider-parent render churn; it remains an optional future refinement if a
  measured consumer hotspot justifies the API change.
- Hidden background terminals use `visibility: hidden` so xterm measurement
  remains valid, and reveal still forces fit/refresh.
- Terminal readiness decoding stops after readiness is established, and
  ResizeObserver fitting is animation-frame coalesced.

## Low-impact items and deliberate trade-offs

These are considered addressed by bounding, caching elsewhere, or retaining a
correctness-sensitive behavior:

- Codex command discovery already avoids directory scans for ordinary prompts;
  caching actual `/command` invocations would save user-paced I/O only.
- Codex runtime environment refresh remains per prompt so shell/PATH changes are
  observed immediately. A TTL would trade correctness for a small process-spawn
  saving.
- Codex config persistence and generated-title compaction remain low-frequency
  paths. The high-frequency callers were removed or catalog-cached.
- Setup terminal buffers remain until environment cleanup because they are the
  authoritative rehydration source for an inactive setup tab; gateway terminal
  drops also depend on that buffer.
- The shared 60-second resync is retained for inactive/background environment
  correctness, but equal snapshots no longer churn the stores.
- Image drafts retain both preview URLs and base64 send payloads because both
  representations are actively consumed. Re-deriving either would move work
  onto the paste/send hot path.
- The GitHub issue detail cache is now capped at 50 entries.

## Verification

- `bun run --cwd apps/backend typecheck` — pass
- `bun run --cwd apps/web typecheck` — pass
- `bun run --cwd apps/desktop typecheck` — pass
- `bun run test` — pass across workspace, root, bridge, protocol, and iOS
  groups; the environment-gated live-runtime tests remain skipped.
- `bun test bridges/codex-bridge/src/app-server-runtime.test.ts -t
  "persists reroutes for inactive sessions across a stale-first restart"` —
  pass, covering the transcript-catalog staleness regression found during
  review.

`git diff --check` is clean.
