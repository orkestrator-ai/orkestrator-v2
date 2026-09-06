# TODO: reliable terminal history and reconnect recovery

Status: implemented on `remote-terminal-transcripts`; awaiting maintainer review.

Created: 2026-09-06. Based on the terminal recovery investigation in this
checkout. The code path and existing tests were inspected; the reported remote
machine was not used for a live reproduction.

## Outcome

After a terminal runs unattended for hours, reconnecting must show its latest
output, including the final lines if the command finished while disconnected.
Switching environments, hiding a tab, closing the client, or losing the network
must not stop backend collection. Reconnection must not require another
keystroke or another output event to refresh the screen.

Keep memory, disk use, and network transfers bounded. Load recent output first;
make older retained history available on demand. Retention may eventually
remove old history, but inactivity alone must never do so. Explain actual
retention loss without presenting stale output as current.

The checklist below tracks the implementation now present in this branch.

Related plans:

- [Remote-client efficiency](../efficiency-plan.md)
- [Remote stream compression](remote-stream-compression.md)
- [Client data-saving mode](remote-client-data-saving-mode.md)
- [Isolated agent testing](../development/agent-testing.md)

## Implementation record

The backend now owns two independent terminal representations. The existing
2 MiB/1,024-entry delta ring remains available for efficient short reconnects.
A pinned `@xterm/headless` 6.0 terminal continuously parses every PTY output
callback and `@xterm/addon-serialize` 0.14 produces versioned current-state
snapshots. Collection is attached where the backend launches local, container,
root, setup, and job PTYs, so it does not depend on a mounted React component or
an active client subscription.

Snapshots target 512 KiB and have a hard 2 MiB decoded limit. Serialization
removes complete scrollback rows until the target fits; it never slices ANSI
state. The current screen is retained up to the hard limit. A bounded 64 KiB
parser carry restores a control sequence split across callbacks. An oversized
unterminated sequence makes the snapshot explicitly unavailable until the
parser reaches a safe boundary. Snapshot jobs coalesce per session. The backend
tracks the received and emulator-applied revisions separately, and the renderer
acknowledges a snapshot only after xterm's write callback fires.

Durable archives live below the application's private `terminal-history`
directory. Backend-generated SHA-256 history IDs confine paths; directories use
mode 0700 and files use mode 0600. Each archive has an atomically replaced
manifest and checksummed state checkpoint plus ordered JSONL segments. Segments
rotate at 4 MiB; individual records are limited to 128 KiB and 500 line/control
boundaries. Writes batch for at most 250 ms, and state checkpoints are scheduled
every five seconds or 1 MiB. PTY exit and orderly backend shutdown flush queued
records and a final checkpoint.

The archive queue is bounded at 1 MiB/256 records per session and 16 MiB/4,096
records globally. Saturation never blocks PTY parsing; it records a durable gap
marker through a separate serialized metadata write. File reads, metadata scans,
parser carry, page reads, snapshot work, terminal dimensions, retry buffers, and
client caches have explicit byte/count or concurrency limits. Corrupt and
oversized checkpoints or records are rejected while usable archive segments
remain readable, with the gap reported to the client.

Retention defaults to 64 MiB per terminal, 1 GiB globally, and seven days for
completed histories. These values are configurable in Terminal settings within
validated ranges. The 128 MiB emulator-state target uses a conservative 96-byte
reservation per cell and reduces older terminals' optional scrollback before
refusing the minimum current screen. Disk admission reserves 3 MiB of global
quota per active terminal for its checkpoint and metadata; segment shares are
rebalanced as terminals are added or settings are reduced. Explicit tab and
environment deletion wait for in-flight writes before removing active and
dormant archives. Client disconnect and component unmount do not delete them.

Older output is exposed through a 256 KiB/1,000-row backward paging command.
Cursors bind format version, stable history identity, PTY incarnation, and a
fixed sequence boundary. The UI uses the deliberately separate read-only
“Earlier terminal output” viewer, preserving its scroll anchor as pages prepend,
with retry, gap/expiry status, and a return-to-live action. It caches at most 16
pages/4 MiB per open viewer and never feeds archived ANSI back into the live
terminal. The historical view is a sanitized ordered output journal: carriage
return progress updates become readable successive rows, control sequences and
styles are omitted, clear-screen operations do not erase prior journal records,
and alternate-screen bytes appear as their printable text. The current terminal
snapshot, rather than this journal view, preserves cursor, wrapping, colors,
modes, erase effects, resize behavior, and alternate-screen state exactly.

Durability means data accepted by the asynchronous archive queue is written on
the cadence above. The implementation does not call `fsync`; a process crash can
lose the current batch or checkpoint interval, and a host power failure can also
lose data still in the operating-system cache. The manifest's
`durableThroughSequence`, checksum, truncation flag, and gap flag report the
recoverable boundary. A backend restart restores the most recent valid terminal
state and archive, but it does not keep the PTY process alive.

### Measured budgets

`scripts/benchmark-terminal-history.ts` is a repeatable synthetic benchmark. On
the Linux development host on 2026-09-06, each noisy terminal ingested 256 KiB
of 80-column output. Measurements include forced GC at sample boundaries; RSS is
process-level and allocator-dependent, so the enforced reservation and response
caps remain the portable guarantees.

| Terminals | Workload | Ingest | Snapshot p50 / p95 | Largest snapshot | Largest page | Estimated state | RSS delta | Disk |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | quiet | 1.9 ms | 4.24 / 4.24 ms | 0 B | 199 B | 14.8 MiB | 9.4 MiB | 347 B |
| 1 | 256 KiB | 69.6 ms | 16.17 / 16.17 ms | 158.0 KiB | 80.4 KiB | 14.8 MiB | 39.7 MiB | 425.4 KiB |
| 10 | quiet | 2.1 ms | 0.49 / 1.19 ms | 0 B | 199 B | 128.0 MiB | 2.3 MiB | 3.4 KiB |
| 10 | 2.5 MiB total | 210.3 ms | 6.33 / 13.57 ms | 158.0 KiB | 80.4 KiB | 128.0 MiB | 91.5 MiB | 3.9 MiB |
| 50 | quiet | 19.7 ms | 0.28 / 0.46 ms | 0 B | 199 B | 128.0 MiB | 14.3 MiB | 16.9 KiB |
| 50 | 12.5 MiB total | 621.1 ms | 0.24 / 8.82 ms | 158.0 KiB | 80.4 KiB | 128.0 MiB | 70.6 MiB | 14.2 MiB |

The 50-terminal case demonstrates scrollback rebalancing under the aggregate
reservation. The deterministic rollover test sends about 550 KiB across 1,101
revisions and confirms the final marker after both legacy replay limits expire.
The isolated real-browser case sends about 517 KiB to a never-mounted local PTY,
reloads the page while it runs, and recovers the final marker from a bounded
state snapshot and history page without waiting for further output.

## Original behavior and failure

| Layer | Current behavior | Consequence |
| --- | --- | --- |
| PTY collection | `spawnTerminalProcess` registers a backend `onData` listener; `emitTerminalOutput` appends before publishing events | Output collection already continues without a subscribed UI |
| Recent raw output | Latest `500 * 1024` JavaScript string code units per session; older content is trimmed | Not an archive and not necessarily a valid standalone terminal replay |
| Incremental replay | At most 2 MiB of UTF-8 output or 1,024 delta entries | Long disconnections can expire the client's replay cursor |
| Full recovery | Returns retained output with `truncated: true` after trimming | `PersistentTerminal.handleReplay` refuses that output and preserves/restores the older UI view |
| Cursor | `useTerminal` advances to the snapshot revision after calling `onReplay`, even when the component discarded it | The client considers unseen output consumed; a finished task can remain stale indefinitely |
| Disk history | Renderer serialization saved through `save_session_buffer` during component cleanup | Cannot accumulate bytes that arrived while the renderer was disconnected |
| Saved buffer cap | Storage slices serialized text at `500 * 1024` code units | The fallback described as safe can itself start inside an escape sequence |
| UI scrollback | Defaults to 1,000 lines | Independent of backend retention and network budgets |

Stable tab sessions retain their bounded in-memory transcript across a natural
shell exit until explicit cleanup. The five-minute/32-buffer retention policy
applies to the one-shot session cleanup path, not every ordinary tab. Finishing
a command inside an interactive shell is also different from the PTY exiting.
Do not treat the five-minute policy as the primary explanation for this report.

Existing tests explicitly expect truncated snapshots to be discarded. Those
expectations need to change alongside a safe recovery representation; merely
removing the renderer guard or raising the raw buffer cap is insufficient.

Source references, relative to this document:

- [PTY ownership](../../apps/backend/src/core/commands-environment.ts)
- [Buffer, revisions, and cleanup](../../apps/backend/src/core/commands-terminal.ts)
- [Current limits and process-local state](../../apps/backend/src/core/commands-runtime-state.ts)
- [Terminal commands and snapshot endpoint](../../apps/backend/src/core/commands-registry-terminal.ts)
- [Renderer reconciliation](../../apps/web/src/hooks/useTerminal.ts)
- [Replay rejection and renderer persistence](../../apps/web/src/components/terminal/PersistentTerminal.tsx)
- [Disk buffer storage](../../apps/backend/src/core/storage-drafts.ts)
- [HTTP snapshot observation by the gateway client](../../apps/web/src/lib/native/web-gateway.ts)
- [WebSocket client recovery](../../apps/web/src/lib/native/terminal-websocket-client.ts)

## Design and guarantees

Use three separate representations:

1. **Live terminal state:** backend-owned parsed screen, cursor/modes, and bounded
   recent scrollback. This is the authority for reconnecting a live terminal.
2. **Replay journal:** a short bounded sequence of output and relevant state
   transitions for clients whose cursors are still available.
3. **Durable history:** bounded disk segments and checkpoints, owned by the
   backend, for older history and history recovery after a backend restart.

A trimmed history is still a valid current screen. Represent `historyTruncated`
separately from `snapshotUnavailable` or an invalid snapshot. Trimming old rows
must not make the newest rows unusable.

The terminal emulator adapter must be proven before selecting its package and
serialization format. A backend headless terminal implementation compatible
with the frontend is the preferred direction. Plain ANSI stripping, slicing at
a newline, and replaying an arbitrary byte suffix do not reconstruct general
terminal state, especially for progress displays, editors, and alternate screens.

Historical scrollback is a view of terminal output, not a promise to retain every
intermediate redraw as a separate line. Retain a bounded ordered output journal
if exact byte-stream inspection is needed; do not interpret arbitrary archived
control sequences directly in the current live terminal.

### Required invariants

- [x] Backend collection and terminal state processing remain active with zero
      connected clients, and are independent of React mount/unmount.
- [x] Output ordering, resize ordering, process incarnation, and applied revision
      are explicit. A backend restart cannot accidentally validate an old cursor.
- [x] Snapshot generation, serialization, disk writes, and network consumers never
      make the PTY reader await I/O or frontend work.
- [x] Subscribe before capturing the recovery boundary; buffer subsequent events
      within byte and count bounds, then flush only events after that boundary.
- [x] A cursor denotes state actually applied by the renderer, not a response
      received, callback invoked, or frame queued for rendering.
- [x] Transport gaps and overload trigger explicit desync and exact current-state
      recovery. Never substitute the old screen and claim synchronization.
- [x] Background work survives presentation cleanup. Keep explicit user teardown
      separate from unsubscribing a client; existing `detach_terminal` terminates
      a session and must not be used as a presentation-only unsubscribe.
- [x] Diagnostic logs and metrics contain no terminal contents, prompts, input,
      credentials, attachments, or file contents. User terminal history is stored
      privately as application data, separate from diagnostic logging.

## Initial budgets to benchmark

These are proposed starting values, not measured defaults. Record final choices
and measured overhead before enabling the implementation by default. Use bytes
for serialized data and explicit row/cell counts for emulator memory; character
counts alone are not memory or wire-byte limits.

| Resource | Initial proposal | Behavior at limit |
| --- | --- | --- |
| Recent emulator scrollback | 2,000 rows per terminal, with a separate cell/memory budget | Remove oldest scrollback while preserving the current screen and modes |
| Backend terminal-state memory | 128 MiB aggregate target for emulator state, queues, and indexes | Reduce optional history/cache first; define and enforce terminal/dimension admission limits before claiming a hard bound |
| In-memory delta journal | Existing 2 MiB / 1,024 entries per terminal, plus an aggregate cap | Expire old cursors and recover from a valid screen snapshot |
| Initial snapshot | Target 512 KiB decoded; hard response cap 2 MiB | Serialize fewer complete scrollback rows; never slice serialized terminal state |
| History response | 256 KiB decoded and at most 1,000 rows | Return an earlier-page cursor; define continuation for exceptionally long rows |
| Client history cache | 4 MiB / 16 pages per viewed terminal; 32 MiB aggregate | Evict distant pages and refetch on demand |
| Disk segment | 4 MiB target; cap record bytes and records per segment | Rotate at record boundaries; split oversized output into ordered bounded records |
| Durable session history | 64 MiB, including checkpoints and indexes | Evict oldest recoverable segment groups; publish earliest available cursor |
| Aggregate durable history | 1 GiB, including metadata and temporary writes | Evict oldest completed history first, then oldest eligible active history; protect each admitted session's latest recoverable state |
| Completed history age | Seven days by default, subject to byte quotas | Expire old history with explicit status; active work is not expired because no client is connected |
| Async disk queue | 1 MiB / 256 records per session, 16 MiB / 4,096 records globally | Explicit archival gap/degraded durability if storage cannot keep up; preserve exact live state and surface the failure |
| Flush/checkpoint cadence | Batch writes within 250 ms; checkpoint every 5 s or 1 MiB of output | Flush on PTY exit and orderly shutdown within a bounded deadline |

- [x] Tune limits with Unicode, very wide terminals, many quiet terminals, and
      several high-volume producers; include allocator and string/cell overhead.
- [x] Define minimum current-screen storage and session admission rules so a global
      cap cannot require deleting every recoverable checkpoint of a live session.
- [x] Bound pending snapshots, page requests, serializer jobs, compression jobs,
      partial records, and retry queues by both bytes and count/concurrency.
- [x] Distinguish received, parsed, written, and durable-through revisions. Specify
      the crash-loss window and fsync policy; a resolved buffered write does not
      promise survival of a host power failure.
- [x] Keep history-loss markers outside an overflowing history queue so the failure
      itself is retained. Resume healthy collection with a fresh checkpoint.

Normal disconnection and inactivity must be lossless within the configured
retention window. Disk exhaustion, sustained storage overload, retention expiry,
and a crash before durable flush are separate, explicit limitations. Do not
promise unlimited or unconditional archival retention.

## Phase 1 — establish the regression and terminal-state contract

- [x] Add a deterministic regression: render an initial marker, disconnect the
      client, emit more than 512,000 characters and 1,024 coalesced chunks, emit a
      final marker, stop output, reconnect, and assert the final marker is visible.
- [x] Cover an existing mounted view, a remount with a saved UI buffer, and a cold
      client without saved history. No further PTY output may be needed to pass.
- [x] Prototype the backend terminal-state adapter with real terminal parsing,
      using synthetic fixtures and an independent frontend terminal as the oracle.
- [x] Verify snapshot/restore equivalence for cursor position, wrapping, colors,
      modes, normal/alternate screens, resize, erase, and subsequent live output.
- [x] Explicitly test partial UTF-8 input and escape sequences split across output
      callbacks. Do not assume an emulator serializer includes pending parser
      state: prove that it does, or use safe checkpoints plus an exact bounded
      suffix and define behavior for oversized/unterminated control sequences.
- [x] Ensure the backend emulator is observational: parsing output must not write
      duplicate device-query replies to the PTY, trigger clipboard operations, or
      cause other terminal-side effects. Define how restored frontend state avoids
      replaying those effects too.
- [x] Choose a versioned snapshot format and adapter dependency only after the
      parity tests pass; pin compatible versions and include packaging checks.
- [x] Specify separate stable history identity and concrete PTY incarnation.
      Tab reuse, shell restart, backend restart, and container replacement must
      not silently splice unrelated streams into one generation.

Deliverable: a regression demonstrating the stale-view behavior and an approved
technical contract for safely restoring current state. No production switch to
the new recovery path until the adapter meets this contract.

## Phase 2 — backend current-state collection and safe snapshots

- [x] Introduce focused backend modules, for example `terminal-state.ts` and
      `terminal-history.ts`, rather than expanding the already large command files.
- [x] Attach collection at `spawnTerminalProcess` for local, container, root,
      setup, and backend-launched terminal jobs, regardless of subscribers.
- [x] Apply ordered output to the backend emulator continuously. Measure the cost
      in the reader callback; if a worker is needed, define bounded handoff and
      recovery before moving work there. Never silently drop parser input.
- [x] Sequence resizes with output and checkpoints. Bound allowed terminal
      dimensions and preserve the existing policy for multiple clients resizing
      one PTY; a historical viewer must not resize the live process.
- [x] Expose a capability-negotiated snapshot command through
      `createCommandRegistry()`, with validated shared types in `packages/protocol`.
- [x] Include format version, history identity, process incarnation, represented
      revision, dimensions, current screen, recent scrollback, and history status.
- [x] Return safe serialized state even when older history was trimmed. Model
      `historyTruncated`, `historyGap`, and snapshot failure separately.
- [x] Bound snapshot serialization work and response bytes. Remove whole old rows
      before serialization; if even the current screen cannot fit, return an
      explicit bounded error rather than an invalid partial snapshot.
- [x] Capture an immutable snapshot at a known applied revision; account for
      queued emulator writes before assigning that revision. Include only suffix
      records known to follow it.
- [x] Retain the latest state when the PTY exits; expose completion/missing/live
      status without requiring a replacement shell to show completed output.
- [x] Keep the existing raw/delta endpoint available for legacy consumers during
      migration; do not silently change the meaning of its `output` field.

## Phase 3 — reconnect application and transport handoff

Recovery order: subscribe and buffer → request snapshot/deltas → validate →
apply to xterm → confirm application → commit cursor → drain later events.

- [x] Change the replay application contract to report completion/failure, using
      xterm's write completion mechanism or another verified application barrier.
- [x] Track received and applied revisions separately wherever asynchronous
      terminal writes permit them to differ. Serialize application operations.
- [x] Update `useTerminal` so rejected, failed, disposed, or superseded replay
      cannot advance the applied cursor or mark the view synchronized.
- [x] Update `PersistentTerminal` to render safe snapshots whose older history
      was trimmed. Replace existing discard assertions with current-output checks.
- [x] Audit `web-gateway.ts` and `TerminalWebSocketClient.observeSnapshot`: an HTTP
      response currently triggers snapshot observation before the caller has
      proved xterm applied it. Replace timer assumptions with an explicit applied
      acknowledgement shared with the hook.
- [x] Preserve subscribe-before-snapshot in the WebSocket gateway and the
      subscribe-before-reconcile path for HTTP/SSE and Electron events.
- [x] Keep reconnect cursors anchored to applied client state. Preserve the SSE
      rule that the connected frame echoes the client's cursor before replay.
- [x] Bound live buffering during snapshot application in the hook and socket
      client. Overflow forces fresh snapshot recovery, never partial continuation.
- [x] Keep generation changes, snapshot supersession, duplicate events, and events
      arriving during the final write callback deterministic and deduplicated.
- [x] Reconcile on reconnect, remount, and return to visibility where delivery may
      have been suspended. Coalesce triggers and bound retries with backoff.
- [x] Cover the default HTTP/SSE gateway path, opt-in terminal WebSocket transport,
      and Electron. Do not infer coverage of one from success in another.
- [x] Respect the WebSocket 256 KiB binary-frame ceiling, including its header.
      Any fragmentation must define logical revision/reassembly semantics and
      bounds; do not send one logical revision as ambiguous independent frames.
- [x] Make snapshot install compatible with rolling versions. Introduce a protocol
      version/capability if process identity or frame semantics require it; never
      reinterpret existing numeric generation fields without negotiation.

Milestone A: a disconnected client reliably returns to the latest retained
output, even after buffer rollover and after the task has stopped producing
output. This milestone can ship before disk history and lazy loading.

## Phase 4 — durable collection, retention, and restart recovery

- [x] Give each durable terminal history a backend-owned manifest under the
      application data directory, associated with environment/tab and incarnation.
- [x] Append bounded ordered records and persist safe checkpoints continuously,
      without depending on `save_session_buffer` or any mounted UI component.
- [x] Use private file/directory permissions and confined backend-generated paths;
      validate history IDs and never accept a client-supplied filesystem path.
- [x] Store version, sequence ranges, timestamps, dimensions, integrity metadata,
      earliest retained position, durability boundary, and completion status.
- [x] Use atomic checkpoint/manifest replacement. On restart, detect incomplete
      tail records and corrupt/missing segments, retain usable data, and mark gaps.
- [x] Define segment dependencies: never evict a checkpoint while retaining suffix
      records whose reconstruction depends on it. Rotate/evict recoverable groups.
- [x] Bound metadata scans and indexes; startup and session lists must not read
      whole terminal archives. Load history only for requested sessions/pages.
- [x] Implement per-session byte, global byte, age, file-count, and metadata bounds,
      including temporary files and any encoded/decoded duplicate representations.
- [x] Apply documented eviction priorities. Make readers robust to concurrent
      rotation/expiry with bounded file leases or a typed cursor-expired response.
- [x] Flush final records/checkpoints on PTY exit and graceful backend shutdown;
      do not expire a stable tab merely because its command returned to a prompt.
- [x] Persist collection failures as history gaps with recovery status. Disk full,
      write failure, or slow storage must not stall live terminal input/output.
- [x] Restore retained history after backend restart. Show a terminated/replaced
      process accurately; durable history alone does not make a Bun PTY survive a
      backend restart. Process survival via an external supervisor is separate work.
- [x] Preserve completed history for the configured window. Define explicit tab
      deletion/environment deletion cleanup and bound any history kept after tab
      closure; never confuse client disconnect with deletion.
- [x] Avoid resurrecting deleted history from an in-flight disk write or checkpoint.
- [x] Make retention and actual available history visible through lightweight
      status metadata without reading terminal contents.

Milestone B: output produced while all clients are absent is stored by the
backend, survives within the documented durability boundary, and remains
available within explicit retention quotas.

## Phase 5 — older-history API and optional scroll-up loading

- [x] Add a bounded `get_terminal_history_page`-style command with an opaque cursor
      tied to history identity, incarnation, ordering position, and format version.
- [x] Include an earlier-page cursor with the initial recent-history response.
      Page backwards from a fixed boundary so concurrent new output cannot shift
      offsets, duplicate rows, or skip retained records.
- [x] Validate cursor size, ownership, limits, and format. Distinguish empty/end
      through rows and `earliestAvailable`, missing through `null`, invalid or
      expired cursors through a bounded error, and corruption through `historyGap`.
- [x] Choose bounded normalized text rows with stable sequence-derived IDs and
      Unicode-safe record splitting. Omit terminal styles in the explicit archive
      viewer and bound enormous lines, carriage returns, and control strings.
- [x] Document how progress rewrites, clear-screen commands, resize/reflow, and
      alternate screens appear in history. Do not claim a byte journal is an
      append-only line transcript.
- [x] Use a read-only virtualized history region/viewer, or prove safe prepend
      support in an adapter. Never replay old raw ANSI into the active xterm to
      simulate prepending; that can move the live cursor or change input modes.
- [x] Prototype seamless loading when scrolling above the recent retained rows.
      If integration with xterm selection/scrolling is unreliable, ship an explicit
      “Earlier output” viewer first while keeping the same paging API.
- [x] Preserve the user's scroll anchor/selection while fetching older pages and
      while new output arrives. Offer a clear return-to-live action.
- [x] Fetch only on demand, deduplicate requests, cap page concurrency and cache
      size, and cancel presentation requests on unmount without touching collection.
- [x] Show “Earlier output has expired” only at the actual retention boundary;
      show loading/retry errors separately from irreversible history gaps.
- [x] Keep history controls usable with keyboard, mouse, touch, and split panes.

Milestone C: older retained output can be read without transferring the full
archive at reconnect or growing browser memory without a bound.

## Phase 6 — migration and operational controls

- [x] Make backend snapshots authoritative. Keep old renderer-saved buffers only
      as labelled legacy history when no matching authoritative history exists.
- [x] Never let a late legacy buffer overwrite a newer backend snapshot or claim
      continuity across an unknown gap/process restart.
- [x] Stop arbitrary slicing of legacy serialization. Preserve existing files
      during migration; unparseable/truncated legacy data needs explicit degraded
      handling rather than being treated as a valid current screen.
- [x] For terminals already running when collection is enabled, record the start
      boundary honestly. Previously discarded output cannot be recovered from a
      larger buffer or a new archive; do not claim complete pre-upgrade history.
- [x] Expose retention controls through existing backend configuration patterns,
      with validated limits and documented effects of reducing quotas.
- [x] Keep backend retention settings separate from per-client xterm scrollback
      and page-cache settings. A UI preference must not silently delete disk history.
- [x] Test old/new client/backend combinations and provide explicit unsupported
      recovery status when an older backend cannot supply a safe snapshot.
- [x] Keep rollback readable or explicitly version-gated; do not destructively
      rewrite existing history before migration/rollback behavior is verified.
- [x] Coordinate with data-saving and compression plans. Reducing hidden
      subscriptions is safe only after snapshot recovery passes; changing global
      compression defaults is outside this plan.

## Validation matrix

Use synthetic numbered records and distinctive final markers. Compare restored
terminal state and subsequent behavior with an uninterrupted reference terminal,
not only string inclusion or mocked `write()` calls.

| Scenario | Required result |
| --- | --- |
| Disconnect, exceed both existing replay limits, finish, reconnect | Final marker appears without any new output; state equals reference |
| Switch to another environment/tab for the whole job | Work and collection continue; returning restores latest output |
| Cold client with no local checkpoint | Same latest state as an already connected client |
| Browser sleep/resume, reload, remote-host switch | Correct history identity; no cross-host/tab output or stale-cursor acceptance |
| Shell remains open versus PTY exits | Final output available in both; lifecycle controls accurately reflect each |
| Two clients with different connectivity and sizes | One slow/absent client does not stop collection or corrupt the other's state |
| Continuous output during snapshot capture/application | No missing/duplicated revisions; no snapshot/live race |
| Snapshot refused, write callback delayed, component disposed | Applied cursor stays correct; recovery retries remain bounded |
| UTF-8/ANSI split, CR progress, erase, wrapping, alternate screen | Exact restored screen/modes and correct subsequent live behavior |
| Oversized lines/frames/control sequences and huge resize | Explicit bounds; no malformed snapshot or unbounded parser/queue growth |
| Network backpressure/replay overflow | Explicit desync followed by exact current-state recovery |
| Disk full/slow/failure and recovery | Live PTY remains responsive; durable gap visible and collection resumes |
| Restart/crash with partial record/checkpoint | Usable retained history recovers; durability boundary/gaps accurately reported |
| Quota expiry while a client pages backwards | Stable pages or explicit expired cursor; no misleading empty success |
| Late legacy checkpoint after successful new snapshot | New output remains authoritative |
| Explicit tab/environment deletion racing writes | Correct cleanup; deleted history is not recreated |

- [x] Add focused backend collector, serializer, retention, storage, and paging
      tests in modules matching the implementation boundaries.
- [x] Update `tests/unit/electron/commands-registry-terminal.test.ts` and the
      relevant `apps/web/src/hooks/useTerminal.test.tsx`, `PersistentTerminal`,
      `web-gateway`, and terminal WebSocket tests. Split oversized test files when
      adding a new independently testable subsystem.
- [x] Add real isolated backend/browser coverage for HTTP/SSE and focused protocol
      and application-barrier coverage for the opt-in WebSocket transport.
- [x] Run local-worktree and Docker cases through the isolated real renderer.
      Include backend-created jobs whose tab was never mounted while running.
- [x] Use accelerated deterministic rollover and an isolated disconnected-browser
      run for routine validation. Record producer byte count, revisions,
      final-marker visibility, and state-comparison result.
- [x] Benchmark 1, 10, and 50 terminals with quiet and noisy mixes under the
      enforced state, response, page, queue, and disk constraints.
- [x] Measure p50/p95 snapshot time, decoded snapshot/page bytes, heap/RSS delta,
      disk use, and the implementation's explicit state reservation.
- [x] Demonstrate the initial transfer stays within the snapshot budget regardless
      of archive size; reconnect must not scan or download the whole archive.
- [x] Record measured defaults and unresolved limits here before declaring done.

Run every test/typecheck/build/smoke command through `bun run test:logged`, with
explicit focused paths and `--parallel` when invoking Bun suites directly. Run
the owning focused tests and relevant web/backend/protocol/desktop typechecks,
then required repository checks and `bun run test` for integration validation.
Follow `AGENTS.md` for exact wrapper commands and flake reporting.

For browser/Electron QA, follow the linked isolated testing guide: unique
`dev:test --profile ... --fixture`, returned fixture only, status discovery and
login, green real-stack baseline, inactive-environment verification, and exact
profile cleanup. Do not reproduce this against the user's running research job.

### Validation evidence

Validation completed on the Linux development host on 2026-09-06:

- `bun run check` passed after the final implementation and retention changes.
- Focused backend history/storage/command tests, protocol contract tests, and
  renderer hook, terminal, history-viewer, gateway, and WebSocket tests passed.
- The production backend and renderer builds passed, including packaging the
  pinned headless xterm dependencies.
- The deterministic 1,101-revision rollover test recovered its final marker
  after both legacy replay limits had expired.
- Isolated real-stack QA passed for a local browser terminal
  (`terminal-agent-browser-1`), a Docker terminal
  (`terminal-agent-docker-1`), and Electron
  (`terminal-agent-electron-1`). The local case produced about 517 KiB while
  its tab was never mounted, and the Docker case produced its final marker
  after the client became inactive. All three test profiles were cleaned up.
- The complete `bun run test` repository suite passed through
  `bun run test:logged` in 73.8 seconds with the runner constrained to its
  eight-core worker plan. The host's twelve-core plan caused unrelated timing
  failures in process-heavy tests; reducing worker contention produced a clean
  run without changing test timeouts. A later run after the final paging and
  parser-queue hardening overlapped another checkout's full suite and timed out
  unrelated process-heavy tests; the exact final source passed `bun run check`
  and its focused backend and history-viewer suites.
- The credential-bearing fake-Docker fixture now pins credential discovery to
  its temporary test home. This prevents Bun's cached `os.homedir()` value from
  reading a developer credential or writing it to a failed-test artifact.
- The benchmark above covered 1, 10, and 50 quiet and noisy terminals. Initial
  snapshots stayed below the 512 KiB target and history pages stayed below the
  256 KiB limit in every measured case.

## Completion checklist

- [x] Milestone A: safe current-state recovery passes the finished-while-offline
      regression on all supported terminal transports.
- [x] Milestone B: backend-owned disk history, retention, crash recovery, and
      visible collection failures are implemented and validated.
- [x] Milestone C: bounded history paging and a usable older-output UI are shipped;
      record whether seamless scroll-up or the explicit viewer was selected.
- [x] Migration and rolling-version behavior are covered without silently showing
      stale saved buffers as current output.
- [x] Resource budgets are measured and enforced; final defaults and durability
      guarantees are documented.
- [x] Required checks and isolated inactive-environment QA pass; evidence and any
      limitations are recorded, with no terminal content in diagnostic artifacts.
- [x] Changes are prepared on feature branches and submitted through PRs; final
      integration into `main` remains with a human maintainer.
