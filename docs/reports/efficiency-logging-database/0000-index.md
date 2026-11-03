# Efficiency, logging and database: outstanding work

What is left to do from the [efficiency review](../2026-10-27-efficiency.md) and the [logging and database efficiency review](../2026-10-29-logging-and-database-efficiency.md), combined. Files 0100 to 0699 come from the efficiency review and 0700 onwards from the logging and database review. Efficiency finding DK-18 and recommendation R7 are the same work, so they share one file.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.
Work that is already built has no file; the status table below records it.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0400-dk-1-dk-2-local-desktop-transport.md](0400-dk-1-dk-2-local-desktop-transport.md) | High | No | DK-1, DK-2: Local desktop windows relay every event and invoke through Electron main | Every terminal byte on a local desktop run is parsed in Electron main and cloned to each window, which wastes compute continuously. |
| 2 | [0410-web-1-live-agent-view-polling.md](0410-web-1-live-agent-view-polling.md) | High | No | WEB-1: Live agent views poll transcript, state and discovery together | Every visible running agent tab sends three requests every 500 ms in normal use. |
| 3 | [0420-st-16-local-scan-minimum-gap.md](0420-st-16-local-scan-minimum-gap.md) | High | No | ST-16: Local diff scans have no minimum gap under constant writes | Any install or build in a local environment runs git scans back to back with no spacing. |
| 4 | [0700-r14-bound-measurement-file-rows.md](0700-r14-bound-measurement-file-rows.md) | High | No | R14 (D1): a cap on net measurement file rows, and readers past it. | Unbounded rows were about 90% of the database on the machine sampled and raise disk and write cost on every run. |
| 5 | [0710-r15-prune-superseded-measurements.md](0710-r15-prune-superseded-measurements.md) | High | No | R15 (D2): prompt pruning, skipping no-change publishes, provisional spacing. | The insert-then-delete cycle wastes significant disk writes during normal agent work. |
| 6 | [0720-r6-silent-failure-logging.md](0720-r6-silent-failure-logging.md) | High | No | R6's specific fixes (L4): writer lease, bridge exit, resume fallback, ACP, turn failures, storage swallows. | Users hit silently stopped schedules and agents that forget their conversation, with nothing recording why. |
| 7 | [0730-r16-ledger-retention.md](0730-r16-ledger-retention.md) | High | No | R16 (D4): purge on environment deletion and age-based ledger retention. | The ledger grows for every user with no bound, and deleting an environment leaves its history and evidence bodies behind. |
| 8 | [0100-gw-6-terminal-flush-watermark.md](0100-gw-6-terminal-flush-watermark.md) | Medium | No | GW-6: Terminal WebSocket flush ignores the socket buffer and desyncs quiet channels | A noisy terminal can force a quiet one to resync, a functional gap limited to the opt-in terminal WebSocket. |
| 9 | [0110-tx-8-tool-detail-miss-recovery.md](0110-tx-8-tool-detail-miss-recovery.md) | Medium | No | TX-8: A tool-detail cache miss cannot recreate remote references | An evicted summary-backed tool detail fails after a costly raw read, a functional gap that needs a cache eviction to appear. |
| 10 | [0120-gw-3-bearer-terminal-streams.md](0120-gw-3-bearer-terminal-streams.md) | Medium | No | GW-3: Bearer-token web clients open one event stream per terminal | Several terminals on a bearer client can starve `/invoke` on HTTP/1.1, a functional gap for that client type only. |
| 11 | [0130-br-10-pi-session-list.md](0130-br-10-pi-session-list.md) | Medium | No | BR-10: Pi session list parses every file on each call and hides a timeout | A large Pi history times out and shows an empty list with no error, a functional gap on an infrequent path. |
| 12 | [0140-br-13-serial-queue-bound.md](0140-br-13-serial-queue-bound.md) | Medium | No | BR-13: Codex notification queue has no count bound and allocates per notification | The queue has no count bound, so the fix removes a real risk and restores a stated invariant. |
| 13 | [0430-st-3-object-reuse-and-closure-stats.md](0430-st-3-object-reuse-and-closure-stats.md) | Medium | No | ST-3: Warm captures pay one `utimes` and one `stat` per reused object | It is the largest remaining warm-capture cost seen in one profile, but runs on a bounded path and has no clean measurement. |
| 14 | [0440-st-14-git-scan-processes.md](0440-st-14-git-scan-processes.md) | Medium | No | ST-14: Each diff scan spawns several git processes | Each scan repeats git processes, a real but per-scan cost that the recurring-work metrics have not yet confirmed. |
| 15 | [0450-st-15-untracked-file-count-cache.md](0450-st-15-untracked-file-count-cache.md) | Medium | No | ST-15: Untracked files are re-read on every scan | Scans re-read every untracked file, which costs real time only in worktrees with many of them. |
| 16 | [0460-st-18-git-scope-demand-expiry.md](0460-st-18-git-scope-demand-expiry.md) | Medium | No | ST-18: Git-scope demand never expires | One look at a scope view adds recomputation, with container execs, for the rest of the environment's life. |
| 17 | [0470-st-10-whole-value-store-writes.md](0470-st-10-whole-value-store-writes.md) | Medium | No | ST-10 (rest): One-field environment, session and project changes rewrite the whole store | Whole-store environment writes are a refactor that removes a real scaling cost, and nothing is broken today. |
| 18 | [0480-st-6-object-store-event-loop-blocking.md](0480-st-6-object-store-event-loop-blocking.md) | Medium | No | ST-6: Object store runs zlib and fsync synchronously on the event loop | A large blob can stall every backend request while it compresses, though only on first write. |
| 19 | [0490-dk-14-agent-home-input-copies.md](0490-dk-14-agent-home-input-copies.md) | Medium | No | DK-14: Agent-home inputs are copied in full per environment and again on every start | Every container start copies inputs again, at a size nobody has measured. |
| 20 | [0500-dk-13-shared-clone-mirror.md](0500-dk-13-shared-clone-mirror.md) | Medium | No | DK-13: Each environment clones from the remote again | Each new container environment clones again, which costs most for large repositories and has an open question on blobless fetches. |
| 21 | [0510-web-6-live-head-merge-serialisation.md](0510-web-6-live-head-merge-serialisation.md) | Medium | No | WEB-6: The live-head merge serialises parts with no identity shortcut | Head-row serialisation runs on transcript updates while streaming, at a cost no Profiler run has confirmed. |
| 22 | [0520-web-9-startup-bundle.md](0520-web-9-startup-bundle.md) | Medium | No | WEB-9: Heavy chat code is in the startup closure | Every launch loads heavy chat code, but the sizes come from one older build. |
| 23 | [0740-r6-docker-bridge-log-rotation.md](0740-r6-docker-bridge-log-rotation.md) | Medium | No | R6 and L4: keep the previous Docker bridge log across a relaunch and make it readable. | It loses the evidence for a crash but no user data, and it affects container bridges only. |
| 24 | [0750-r6-essential-event-log.md](0750-r6-essential-event-log.md) | Medium | No | R6's always-on tier and control, plus L4's uncaught exception gap. | First-occurrence evidence is a missing measurement rather than a defect in shipped behaviour. |
| 25 | [0760-r17-ledger-out-of-hourly-snapshots.md](0760-r17-ledger-out-of-hourly-snapshots.md) | Medium | No | R17 (D3): the ledger leaves hourly snapshots. | Disk is already capped at 16 GiB and the copy runs off the event loop, and the cost shrinks with R14 and R15. |
| 26 | [0770-r9-codex-raw-event-logging.md](0770-r9-codex-raw-event-logging.md) | Medium | No | R9 (L8): remove the no-op toggle. | A default-on setting tells users something false, though nothing is captured today. |
| 27 | [0780-r11-export-diagnostics.md](0780-r11-export-diagnostics.md) | Medium | No | R11 (M2, L7) and its control: a local diagnostics bundle. | It is a functional gap in supportability, and the Bug button and `--fix` remain as workarounds. |
| 28 | [0790-r8-renderer-diagnostics.md](0790-r8-renderer-diagnostics.md) | Medium | No | R8's remainder (L7) and its control: a switch, DevTools and a persisted error ring. | Renderer bugs in the packaged app leave no trace, which is a supportability gap rather than broken behaviour. |
| 29 | [0800-r18-scrub-checkpoint-stall.md](0800-r18-scrub-checkpoint-stall.md) | Medium | No | R18's checkpoint item (D6).: Stop the scrub checkpoint stalling the event loop during a backup | A possible 10 s event-loop stall is a real risk to remove, though it has not been reproduced. |
| 30 | [0810-r19-database-observability.md](0810-r19-database-observability.md) | Medium | No | R19 (M6): database size, waits, top tables and a panel. | It is a missing measurement, and the retention report is computed and thrown away. |
| 31 | [0820-r12-rolling-health-summary.md](0820-r12-rolling-health-summary.md) | Medium | No | R12 (M1): a rolling health row and a clean shutdown marker. | Leaks and restart causes cannot be answered afterwards, which is a missing measurement. |
| 32 | [0830-r10-vendor-debug-environment.md](0830-r10-vendor-debug-environment.md) | Medium | No | R10's environment item and L10: filter inherited vendor debug variables. | Vendor debug output can carry content into a saved log, though it takes a stray shell variable to happen. |
| 33 | [0840-d4-project-removal-orphans.md](0840-d4-project-removal-orphans.md) | Medium | No | D4's last sentence, which no recommendation covers: Kanban, notes, plans and completion comments survive project removal. | Content stays on disk with nothing able to reach it, a functional gap with a small privacy cost and no size cost. |
| 34 | [0150-tx-2-tx-15-post-dispatch-raw-reads.md](0150-tx-2-tx-15-post-dispatch-raw-reads.md) | Low | No | TX-2, TX-15: Dispatches and control changes trigger an unlimited raw transcript read | The report rates it High, but the maintainer gated it on a baseline, so it stays Low until that measurement arrives. |
| 35 | [0160-tx-1-delta-base-ring.md](0160-tx-1-delta-base-ring.md) | Low | No | TX-1: A transcript delta can only be built from the newest cached view | The report rates it High, but the maintainer gated it on a baseline, so it stays Low until that measurement arrives. |
| 36 | [0170-gw-1-native-session-read-round.md](0170-gw-1-native-session-read-round.md) | Low | No | GW-1: Native session views send three requests per tick and there is no combined read | The report rates it High, but the maintainer gated it on a baseline, so it stays Low until that measurement arrives. |
| 37 | [0180-tx-5-session-state-conditional-read.md](0180-tx-5-session-state-conditional-read.md) | Low | No | TX-5: Session-state reads have no conditional path from the bridge | An optimisation the maintainer gated on a baseline, so it waits for that measurement. |
| 38 | [0190-tx-6-bridge-transcript-delta.md](0190-tx-6-bridge-transcript-delta.md) | Low | No | TX-6: Bridge transcript windows are always sent whole | An optimisation the maintainer gated on a baseline, and its cost is local CPU rather than remote bandwidth. |
| 39 | [0200-tx-18-messages-fallback-limit.md](0200-tx-18-messages-fallback-limit.md) | Low | No | TX-18: The `/messages` fallback ignores the limit it has in scope | A small saving on a compatibility fallback that only older bridges and non-resident sessions reach. |
| 40 | [0210-tx-3-legacy-commit-fingerprint.md](0210-tx-3-legacy-commit-fingerprint.md) | Low | No | TX-3: The legacy commit re-serialises the whole projection to fingerprint it | A contained optimisation with no behaviour change and no measured cost. |
| 41 | [0220-tx-9-tx-13-memoised-fingerprints.md](0220-tx-9-tx-13-memoised-fingerprints.md) | Low | No | TX-9, TX-13: Memoise row fingerprints and hash them for the view token | A contained optimisation of hashing that has no measured cost. |
| 42 | [0230-tx-4-lease-held-session-loads.md](0230-tx-4-lease-held-session-loads.md) | Low | No | TX-4 (remainder): Native session mutations still decode the whole store inside the lease | The read path this finding was about is fixed, and what remains is an unmeasured cost on mutations. |
| 43 | [0240-br-1-acp-persist-fragments.md](0240-br-1-acp-persist-fragments.md) | Low | No | BR-1 (remainder): ACP still serialises every session on each state write | The write rate is already down to once a second, so the remaining cache should wait for a measurement. |
| 44 | [0250-br-7-codex-running-tool-cards.md](0250-br-7-codex-running-tool-cards.md) | Low | No | BR-7: Codex re-renders and re-sends running tool cards every publish tick | A CPU optimisation with low wire cost and no measured impact. |
| 45 | [0260-br-12-acp-stdout-framing.md](0260-br-12-acp-stdout-framing.md) | Low | No | BR-12: ACP stdout framing is quadratic for large frames | The quadratic cost applies only to large frames and is capped by the 4 MiB line limit. |
| 46 | [0270-br-16-acp-cursor-replay.md](0270-br-16-acp-cursor-replay.md) | Low | No | BR-16: ACP's Cursor replay looks like dead code | This is removal of code no production launch reaches, so leaving it costs only maintenance. |
| 47 | [0280-gw-5-event-frame-encoding.md](0280-gw-5-event-frame-encoding.md) | Low | No | GW-5: Events are measured and encoded again for each subscriber | A small per-subscriber cost that should wait for a profile. |
| 48 | [0290-gw-12-replay-cursor-frames.md](0290-gw-12-replay-cursor-frames.md) | Low | No | GW-12: Scoped stream replay writes one cursor frame per skipped event | Extra small frames on reconnect for filtered clients, with no user-visible failure beyond an occasional needless reconcile. |
| 49 | [0300-gw-14-replay-window-lookup.md](0300-gw-14-replay-window-lookup.md) | Low | No | GW-14: Replay lookup is a linear filter and an oversized event is invisible | A linear scan over a bounded window plus a missing metric for a rare event. |
| 50 | [0310-gw-15-static-fallback-304.md](0310-gw-15-static-fallback-304.md) | Low | No | GW-15: Static fallback compression runs before the 304 check | Wasted compression only for revalidated static files that have no precompressed sibling. |
| 51 | [0320-tx-7-head-row-recovery.md](0320-tx-7-head-row-recovery.md) | Low | No | TX-7: Head-row recovery re-reads the raw transcript on each streaming revision | The trigger is narrow, needing a part-trimmed head or a cached summary, and its frequency is unmeasured. |
| 52 | [0330-tx-11-patch-digest-cost.md](0330-tx-11-patch-digest-cost.md) | Low | No | TX-11: Patch building re-serialises and hashes whole rows in a JavaScript loop | An unmeasured CPU optimisation in patch building. |
| 53 | [0340-tx-12-update-serialiser.md](0340-tx-12-update-serialiser.md) | Low | No | TX-12: Already-encoded rows are stringified again on the way out | An unmeasured saving bounded by the size of one transcript window. |
| 54 | [0345-tx-14-display-tail-serialisation.md](0345-tx-14-display-tail-serialisation.md) | Low | No | TX-14: Restart-preview checkpoints are serialised three times and cloned | Repeated serialisation of a byte-bounded checkpoint, with no measured cost. |
| 55 | [0350-tx-16-inline-tool-body-hash.md](0350-tx-16-inline-tool-body-hash.md) | Low | No | TX-16: Inline tool bodies are re-hashed whenever their row misses the cache | An unmeasured cost limited to raw reads and inline-body providers. |
| 56 | [0355-br-14-pi-persistence-encoding.md](0355-br-14-pi-persistence-encoding.md) | Low | No | BR-14: Pi persistence serialises every session on each write | It runs only at turn and request edges, and bursts are coalesced. |
| 57 | [0360-br-15-sse-replay-rings.md](0360-br-15-sse-replay-rings.md) | Low | No | BR-15 (remainder): Two SSE replay rings with uneven quality | Duplicate ring code whose backend subscriber only receives small observation frames. |
| 58 | [0365-gw-10-preview-rewrite-passes.md](0365-gw-10-preview-rewrite-passes.md) | Low | No | GW-10: The preview body rewrite makes many full regex passes | GW-9 already removed this work from reloads, and the legacy route is a fallback. |
| 59 | [0370-gw-11-relayed-node-events.md](0370-gw-11-relayed-node-events.md) | Low | No | GW-11: Relayed federation events share one name and the main replay window | It affects federation users only, and the worst outcome is a needless reconcile. |
| 60 | [0375-gw-16-small-per-chunk-costs.md](0375-gw-16-small-per-chunk-costs.md) | Low | No | GW-16: Small per-chunk and per-frame gateway costs | Small allocations and small frames with no user-visible effect. |
| 61 | [0380-tx-17-small-linear-scans.md](0380-tx-17-small-linear-scans.md) | Low | No | TX-17: Small linear scans in the transcript projection | Single passes over a bounded window that may not need any change. |
| 62 | [0385-tx-10-joined-history-pages.md](0385-tx-10-joined-history-pages.md) | Low | No | TX-10: Joined history pages read the whole transcript per page | A compatibility path that only older renderers use and that 0232 will remove, blocked on the support window. |
| 63 | [0390-gw-7-websocket-compression.md](0390-gw-7-websocket-compression.md) | Low | No | GW-7: No WebSocket message compression | Deferred by 0052 decision D6 until the transport direction is chosen. |
| 64 | [0530-st-5-manifest-cache-and-lookup.md](0530-st-5-manifest-cache-and-lookup.md) | Low | No | ST-5: Manifests are re-parsed for every diff page and searched linearly | It is a user-driven diff-page optimisation that should wait for a measurement on large trees. |
| 65 | [0540-st-19-active-turns-and-boundary-growth.md](0540-st-19-active-turns-and-boundary-growth.md) | Low | No | ST-19 (rest): `activeTurns()` scans every turn boundary, and the rows are never removed | Measurement pruning has landed, leaving a small query change and a slow-growing table. |
| 66 | [0550-st-20-retention-walks.md](0550-st-20-retention-walks.md) | Low | No | ST-20: Hourly retention walks the object store repeatedly | An hourly walk has a bounded impact and should wait for a measurement. |
| 67 | [0560-st-9-agent-mail-store-remainder.md](0560-st-9-agent-mail-store-remainder.md) | Low | No | ST-9 (rest): Agent mail: pending injects and mailbox lists still sit on the whole store | The read cost the finding described has gone, and the rest needs a stored-format change only a measurement could justify. |
| 68 | [0570-st-17-recursive-worktree-watch.md](0570-st-17-recursive-worktree-watch.md) | Low | No | ST-17: Recursive `fs.watch` covers the whole worktree, `node_modules` included | The impact depends on Bun's watcher, which nobody has inspected, so it should wait for a measurement. |
| 69 | [0580-st-21-file-rpc-and-usage-report.md](0580-st-21-file-rpc-and-usage-report.md) | Low | No | ST-21: Whole files cross RPC as base64, branch reads spawn twice, and usage reports parse every row | These are occasional, bounded reads. |
| 70 | [0590-web-2-native-session-store-subscriptions.md](0590-web-2-native-session-store-subscriptions.md) | Low | No | WEB-2 (rest): The native session hook subscribes to whole cache entries it reads only at mount | Unchanged polls no longer re-render, so the remaining benefit needs a Profiler run to show. |
| 71 | [0600-web-10-find-reindexing.md](0600-web-10-find-reindexing.md) | Low | No | WEB-10: With find open, the whole transcript is re-indexed on every update | The cost exists only while find is open on a long transcript. |
| 72 | [0610-web-11-terminal-socket-visibility-rebuild.md](0610-web-11-terminal-socket-visibility-rebuild.md) | Low | No | WEB-11: The terminal WebSocket rebuilds every channel on every visibility change | It affects only the opt-in terminal WebSocket transport. |
| 73 | [0620-web-12-environment-list-refetch.md](0620-web-12-environment-list-refetch.md) | Low | No | WEB-12: One environment change refetches the project's whole environment list | Bursts already collapse to one project read, so this should wait for a measurement. |
| 74 | [0630-web-13-expanded-folder-reloads.md](0630-web-13-expanded-folder-reloads.md) | Low | No | WEB-13: Expanded truncated folders are re-read every 5 s without a digest | It is a small read that runs only with the All files tab open and visible. |
| 75 | [0640-web-14-projection-store-map-copies.md](0640-web-14-projection-store-map-copies.md) | Low | No | WEB-14: Projection store writes copy four Maps even when one changes | Copying Maps of at most 128 entries is cheap and may never show in a profile. |
| 76 | [0650-web-16-terminal-container-environment-subscription.md](0650-web-16-terminal-container-environment-subscription.md) | Low | No | WEB-16: `TerminalContainer` subscribes to the whole environment object | It is an unmeasured re-render, with launch-effect risk in the fix. |
| 77 | [0660-web-18-polls-while-hidden.md](0660-web-18-polls-while-hidden.md) | Low | No | WEB-18: Some renderer polls keep running while the window is hidden | These are slow or dialog-bound polls whose hidden-window cost may already be throttled. |
| 78 | [0670-web-19-streaming-markdown-render.md](0670-web-19-streaming-markdown-render.md) | Low | No | WEB-19: Streaming markdown rebuilds the whole message's tree per update | The parse is already incremental, so the remaining render cost should wait for a Profiler run. |
| 79 | [0680-bg-10-multi-review-snapshot-drift-checks.md](0680-bg-10-multi-review-snapshot-drift-checks.md) | Low | No | BG-10: Multi Review snapshot mode runs a drift check per reviewer | It costs a bounded number of extra git probes per review pass. |
| 80 | [0690-bg-14-tmux-transcript-reopen.md](0690-bg-14-tmux-transcript-reopen.md) | Low | No | BG-14: Reopening a tmux tab replays its whole transcript | It is an occasional reopen read with no measured size. |
| 81 | [0691-dk-5-preview-capture-data-urls.md](0691-dk-5-preview-capture-data-urls.md) | Low | No | DK-5: Preview captures cross IPC as large data URLs | Captures are occasional and bounded. |
| 82 | [0692-dk-6-preview-tunnel-multiplexing.md](0692-dk-6-preview-tunnel-multiplexing.md) | Low | No | DK-6: The preview tunnel opens a WebSocket per TCP connection | The existing connection pool already removes most repeats. |
| 83 | [0693-dk-10-second-claude-binary.md](0693-dk-10-second-claude-binary.md) | Low | No | DK-10: The image ships two Claude Code native binaries | It is an optional image-size saving that waits on a maintainer decision. |
| 84 | [0694-dk-16-attention-follow-polling.md](0694-dk-16-attention-follow-polling.md) | Low | No | DK-16 (rest): CLI `attention --follow` re-downloads pending items on every poll | It affects only long-running followers, and pending pages are probably small. |
| 85 | [0850-r10-docker-log-bounds.md](0850-r10-docker-log-bounds.md) | Low | No | R10's disk items (L9): the no-perl fallback, dropped-write markers and the driver fallback. | It reaches only unusual images and daemons, with no evidence any is in use. |
| 86 | [0860-r7-relay-and-file-writer.md](0860-r7-relay-and-file-writer.md) | Low | No | R7's remainder (L6) and DK-18: batching, line bound and skipping the relay. | These are optimisations that should wait for a measurement, since the sampled volume was fine. |
| 87 | [0870-r20-read-path-leftovers.md](0870-r20-read-path-leftovers.md) | Low | No | R20's remainder (D7, D8): blob length, read-only leases and the usage prune. | Small costs, and the overflow read has not been timed. |
| 88 | [0880-r13-metric-primitives.md](0880-r13-metric-primitives.md) | Low | No | R13 (M3, M4, M5): write-only metrics, small inefficiencies and shared primitives. | It is cleanup with no user-visible effect. |
| 89 | [0890-controls-presets-and-auto-revert.md](0890-controls-presets-and-auto-revert.md) | Low | No | User controls: presets, auto-revert and privacy text. | These are optional extensions to controls that already work. |
| 90 | [0900-controls-log-cli-flags.md](0900-controls-log-cli-flags.md) | Low | No | User controls: `--log-level` and `--log-category`. | `ORKESTRATOR_LOG_LEVEL` already provides the ability. |
| 91 | [0910-r18-sqlite-maintenance.md](0910-r18-sqlite-maintenance.md) | Low | No | R18's maintenance items (D5): `optimize`, `foreign_keys`, cache sizes. | These are optimisations that should wait for a measurement, and hygiene. |
| 92 | [0920-r18-durability-tiers.md](0920-r18-durability-tiers.md) | Low | No | R18's tiers (D5).: Tier `synchronous` and `secure_delete` by data | A maintainer deferred this on 2026-11-01 until a measurement shows fsync cost. |
| 93 | [0930-l10-logging-hygiene.md](0930-l10-logging-hygiene.md) | Low | No | L10 and M2 leftovers that no recommendation covers. | Dead code and wrong comments only. |

## Status of every efficiency finding

48 done, 8 partly done, 65 open, 2 no action.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| GW-1 | Open | Discovery is still sent in the fast round (`apps/web/src/hooks/useNativeAgentSession.ts:2484`) and only `/invoke` exists (`apps/backend/src/gateway-auth.ts:471`); see 0170. |
| GW-2 | Done | The default compression mode is `on` (`apps/backend/src/gateway-support-core.ts:536`, #1548 `12289fc56`, 0052 D14), and SSE streams use `GzipEventClientWriter` (`apps/backend/src/gateway-handlers.ts:211`). |
| GW-3 | Open | Bearer and cross-origin clients still open one fetch stream per terminal (`apps/web/src/lib/native/web-gateway.ts:1092-1098`); see 0120. |
| GW-4 | Done | `SseFrameDecoder` keeps a chunk list and searches only the new text (`packages/protocol/src/gateway-event-stream.ts:162`, #1548 `12289fc56`), though the report's minor `indexOf` sub-fix in `parseSseBlock` (`:96`) was not taken, which leaves that parse linear per frame. |
| GW-5 | Open | Writers still call `Buffer.byteLength` per subscriber (`apps/backend/src/gateway-support-extra.ts:661`, `:708`); see 0280. |
| GW-6 | Open | `flush` never reads `bufferedAmount` (`apps/backend/src/terminal-websocket-server.ts:868`); see 0100. |
| GW-7 | Open | No compression option is set (`apps/backend/src/terminal-websocket-server.ts:193-198`), and 0052 D6 defers the work; see 0390. |
| GW-8 | Done | The private-origin proxy reuses pooled connections (`apps/backend/src/preview-http-proxy.ts:160`, `apps/backend/src/preview-upstream-pool.ts`, #1604 `b64242842`). |
| GW-9 | Done | Compressed and rewritten bodies get a derived ETag that maps back upstream (`apps/backend/src/gateway-proxy.ts:188`, `:397`, `apps/backend/src/gateway-proxy-etag.ts`, #1604 `b64242842`). |
| GW-10 | Open | The rewrite still runs nine `replace` passes on HTML (`apps/backend/src/gateway-support-extra.ts:555`); see 0365. |
| GW-11 | Open | All relayed frames share one event name (`apps/backend/src/core/nodes/node-event-relay.ts:233`, `:248`) and the main replay ring; see 0370. |
| GW-12 | Open | Each skipped replay frame still writes a cursor frame (`apps/backend/src/gateway-events.ts:214`); see 0290. |
| GW-13 | Done | The rebuild section follows `container-lifecycle-updated` with a 15 s backstop (`apps/web/src/components/environments/EnvironmentRebuildSection.tsx:146`, `:175-177`, #1606 `9c06cb7aa`), and 1202 records the choice to leave the other two 3 s backstops. |
| GW-14 | Open | The lookup is still `frames.filter` (`apps/backend/src/gateway-event-replay.ts:162`) and no oversized metric exists; see 0300. |
| GW-15 | Open | Compression still runs before the 304 check (`apps/backend/src/gateway-proxy.ts:794`, `:860`); see 0310. |
| GW-16 | Open | Timers, decoders, per-operation results and 50 ms acks all remain (`apps/backend/src/gateway-proxy.ts:301-308`, `apps/backend/src/terminal-websocket-server.ts:400`, `:1040`, `apps/web/src/lib/native/terminal-websocket-client.ts:97`); see 0375. |
| TX-1 | Open | The view cache holds one entry per key, and a delta needs the newest token (`apps/backend/src/core/native-agent-transcript-projection.ts:468`, `:3012-3017`); see 0160. |
| TX-2 | Open | `interactiveSnapshot` still reads `legacy` with no limit (`apps/backend/src/core/http-bridge-provider.ts:648`, `:771`) after dispatch (`apps/backend/src/core/native-agent-service.ts:2023`); see 0150. |
| TX-3 | Open | The fingerprint is still a whole `JSON.stringify` (`apps/backend/src/core/native-agent-transcript-projection.ts:5465`); see 0210. |
| TX-4 | Partly done | Reads are keyed (`apps/backend/src/core/storage-native.ts:424`, `apps/backend/src/core/storage-prompt-queue-store.ts:126-127`, #1548 `12289fc56`), but mutations still load the whole store (`apps/backend/src/core/storage-native.ts:1209`); see 0230. |
| TX-5 | Open | State reads have no condition (`apps/backend/src/core/http-bridge-progressive.ts:217`) and the hash covers the composer (`apps/backend/src/core/native-agent-transcript-projection.ts:3418-3420`); see 0180. |
| TX-6 | Open | A bridge answers `unchanged` or a whole snapshot only (`apps/backend/src/core/http-bridge-transcript-v2.ts:197`); see 0190. |
| TX-7 | Open | Recovery restarts per source token with no delay (`apps/backend/src/core/native-agent-transcript-projection.ts:1901`, `:2006`), though only for a part-trimmed head or cached summary (`:1924-1929`); see 0320. |
| TX-8 | Open | A miss runs a `sync-v1` refresh with `remote` undefined and then throws (`apps/backend/src/core/native-agent-transcript-projection.ts:4194`, `:4205`, `:5032`); see 0110. |
| TX-9 | Open | `valueFingerprint` memoises the JSON but hashes on each call (`apps/backend/src/core/native-agent-projection-encoding.ts:64-66`); see 0220. |
| TX-10 | Open | Joined pages still refresh and scan with SHA-256 per row (`apps/backend/src/core/native-agent-transcript-projection.ts:3878`, `:3903-3909`), owned by 0232 task 4; see 0385. |
| TX-11 | Open | `partsDigest` still serialises and loops per character (`packages/protocol/src/native-agent-transcript-patch.ts:71`); see 0330. |
| TX-12 | Open | The gateway still stringifies the whole result (`apps/backend/src/gateway-handlers.ts:133`), and `revisedMessages` is not measured through the memo (`apps/backend/src/core/native-agent-projection-encoding.ts:131-138`); see 0340. |
| TX-13 | Open | The view token still hashes every row's JSON (`apps/backend/src/core/native-agent-transcript-projection.ts:2611-2631`); see 0220. |
| TX-14 | Open | A checkpoint is serialised for the checksum, the size check and the row, then cloned (`apps/backend/src/core/native-agent-display-tails.ts:160`, `apps/backend/src/core/native-agent-display-tail-store.ts:231`, `:258`); see 0345. |
| TX-15 | Open | The legacy and summary paths use different row cache contexts (`apps/backend/src/core/native-agent-projection-entries.ts:40`, `apps/backend/src/core/native-agent-transcript-projection.ts:2137`, `:5032`); see 0150. |
| TX-16 | Open | Inline bodies are still serialised and hashed on a row miss (`apps/backend/src/core/native-agent-transcript-projection.ts:807-808`); see 0350. |
| TX-17 | Open | The scans remain (`apps/backend/src/core/native-agent-transcript-projection.ts:1203`, `:2035`, `:2078`), and the report names no fix; see 0380. |
| TX-18 | Open | The fallback still calls `this.legacy(sessionId)` without the limit (`apps/backend/src/core/http-bridge-transcript-reader.ts:66`); see 0200. |
| BR-1 | Partly done | Streaming writes are limited to one a second (`bridges/acp-bridge/src/acp-persist-writer.ts:239-249`, #1548 `12289fc56`), but the report's fragment cache was not built and each write still serialises every session (`:293`); see 0240. |
| BR-2 | Done | `isSessionConfigPersisted` reads one record through `loadRecord` (`bridges/codex-bridge/src/app-server-runtime-sessions.ts:1803`, `bridges/codex-bridge/src/sessions/persistence.ts:386`, #1683 `38ac30844`). |
| BR-3 | Done | The check interval is 1 MiB (`bridges/acp-bridge/src/acp-context.ts:961`, #1548 `12289fc56`). |
| BR-4 | Done | `TranscriptRowSizes` remembers row sizes (`packages/protocol/src/node/transcript-budget.ts:296`), used by Pi and Cursor through `packages/protocol/src/node/bridge-transcript-bounds.ts:80` and by ACP through `bridges/acp-bridge/src/acp-rows.ts:197` (#1593 `e668f0a6d`). |
| BR-5 | Done | `EncodedObjectSizes` replaces whole-card serialisation in all three bridges (`packages/protocol/src/node/transcript-budget.ts:384`, `bridges/pi-bridge/src/translate.ts:969`, `bridges/acp-bridge/src/acp-tools.ts:165`, #1593 `e668f0a6d`), though 1202 notes a Pi frame still costs one O(output) prefix comparison. |
| BR-6 | Done | `BoundedTextAppender` keeps each owner's byte count (`packages/protocol/src/node/bridge-transcript-text.ts:83`, #1593 `e668f0a6d`), and all three bridges use it. |
| BR-7 | Open | Running items are re-rendered each tick and `content` is in every patch (`bridges/codex-bridge/src/messages/render-turn.ts:875`, `bridges/codex-bridge/src/app-server-runtime-rows.ts:477`); see 0250. |
| BR-8 | Done | `getToolWithCreatedAt` stamps the tracker entry once (`bridges/claude-bridge/src/services/session-manager-messages.ts:118`, `:994`, #1693 `9a878575d`). |
| BR-9 | Done | `emitRow` returns whether it published, and the caller returns early otherwise (`bridges/claude-bridge/src/services/session-manager-prompt-stream.ts:431`, `:553`, #1693 `9a878575d`). |
| BR-10 | Open | `SessionManager.list` is still called uncached and a timeout becomes `[]` (`bridges/pi-bridge/src/agent-session.ts:1272-1277`); see 0130. |
| BR-11 | Done | `readSessionIndex` caches the parsed index and reads only appended bytes (`bridges/codex-bridge/src/history/session-index-cache.ts`, `bridges/codex-bridge/src/history/rollout.ts:92`, #1683 `38ac30844`). |
| BR-12 | Open | Each chunk still runs `Buffer.concat` and `indexOf` from zero (`bridges/acp-bridge/src/acp-context.ts:1386-1388`); see 0260. |
| BR-13 | Open | `run` still chains promises, and depth is only measured (`bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts:559-575`); see 0140. |
| BR-14 | Open | `persistNow` and `shedToFit` still serialise the whole payload (`bridges/pi-bridge/src/persistence.ts:152`, `:175`); see 0355. |
| BR-15 | Partly done | The transcript helpers moved to `packages/protocol/src/node` (#1593 `e668f0a6d`), but the rings remain separate (`bridges/codex-bridge/src/event-ring.ts:62`, `bridges/claude-bridge/src/routes/events.ts:101`); see 0360. |
| BR-16 | Open | The Cursor gates remain (`bridges/acp-bridge/src/acp-tools.ts:570`, `:688`, `:810`), and the test harness defaults to Cursor (`bridges/acp-bridge/src/acp-test-harness.ts:246`); see 0270. |
| WEB-1 | Open | Discovery still sent per tick, `useNativeAgentSession.ts:2484`; see 0410. |
| WEB-2 | Partly done | Identity kept at `useNativeAgentSession.ts:1501`, recency condition gone at `nativeAgentProjectionStore.ts:244-246` (12289fc56); narrower subscriptions remain, see 0590. |
| WEB-3 | Done | `useHydrateOncePerEnvironment`, `App.tsx:368`; no-op guards in `environmentStore.ts` setters (12289fc56). |
| WEB-4 | Done | Identity and hydration check before serialising, `pane-layout-persistence.ts:799` (9c06cb7aa). |
| WEB-5 | Done | `quiet` background reads leave the flags alone, `useNativeAgentSession.ts:2233-2237` (9c06cb7aa). |
| WEB-6 | Open | No identity shortcut, `useNativeAgentSession.ts:260-307`; see 0510. |
| WEB-7 | Done | `selectActivePaneTab`, `AppShell.tsx:69`, `:176`; per-field selectors, `usePullRequest.ts:62-70` (387d1412f). |
| WEB-8 | Done | Normalised only when a handler runs, `AgentInfoButton.tsx:475-479` (9c06cb7aa). |
| WEB-9 | Open | Eager imports at `AppShell.tsx:41`, `MailTile.tsx:41`; re-export at `stores/index.ts:15`; see 0520. |
| WEB-10 | Open | Recomputes on every `items` change, `AgentChatFind.tsx:110-118`; see 0600. |
| WEB-11 | Open | Unconditional rebuild, `terminal-websocket-client.ts:359-372`; see 0610. |
| WEB-12 | Open | Project read per change, `useEnvironmentListSync.ts:84-92`; see 0620. |
| WEB-13 | Open | `reloadFolders` has no digest, `useFilesPanel.ts:644-663`; see 0630. |
| WEB-14 | Open | Four Maps copied up front, `nativeAgentProjectionStore.ts:173-178`; see 0640. |
| WEB-15 | Done | Memoised `readTranscriptTail`, `AgentNativeTab.controller.tsx:1152` (9c06cb7aa). |
| WEB-16 | Open | Whole environment subscribed, `TerminalContainer.view.tsx:168-170`; see 0650. |
| WEB-17 | Done | `LiveElapsed`, `ClaudeTmuxChatTab.tsx:1406`; `createRuntimeClock`, `MultiReviewTab.tsx:564` (387d1412f); `BuildChatTab.tsx` has no interval. |
| WEB-18 | Open | Plain intervals at `App.tsx:683`, `useUserCommands.ts:68` and others; see 0660. |
| WEB-19 | Open | One `Markdown` render per update, `MessageMarkdown.tsx:393-399`; see 0670. |
| ST-1 | Done | Settled stamp skips the read, `capture.ts:321-322` (c3c899b16). |
| ST-2 | Done | `dlopen` once per process, `confined-read.ts:28` (c3c899b16); the handle cache was deliberately not done, 1202 task 7. |
| ST-3 | Open | Per-object `utimes` and `stat`, `object-store.ts:110-119`, `capture.ts:944-947`; see 0430. |
| ST-4 | Done | Bounded line count LRU, `snapshot-diff.ts:96-120` (c3c899b16). |
| ST-5 | Open | No cache in `readManifest`, `capture.ts:987`; linear `find`, `diff-bodies.ts:169`; see 0530. |
| ST-6 | Open | `deflateSync`, `object-store.ts:139`; `fsyncSync`, `:254`; see 0480. |
| ST-7 | Done | One-row reads, `storage-projects.ts:654`, `storage-native.ts:424`, `storage-prompt-queue-store.ts:127`, `storage-drafts.ts:160`, `:731`, `storage-sessions.ts:262` (12289fc56); 1202 assigns the lease-held native mutations to TX-4. |
| ST-8 | Done | `updateStoreRow` carries the cache forward, `storage-database.ts:830-838` (12289fc56). |
| ST-9 | Partly done | Frozen read model and single serialisation, `storage-agent-mail-store.ts:364`, `:431-436` (6953e8df7); pending-inject collection and body-free list remain, see 0560. |
| ST-10 | Partly done | Compose drafts done, `storage-drafts.ts:228`, `:264` (381b26f90); array stores remain, see 0470. |
| ST-11 | Done | `store_rows_position` index, `storage-database.ts:361-365` (381b26f90). |
| ST-12 | No action | Maintainer decided 2026-11-01 to leave pragmas unchanged unless fsync cost still shows (1202 task 2); still as described, `storage-database.ts:291-293`, `:1309`. |
| ST-13 | Done | Hourly copy and check run in a child process, `storage-backups.ts:223`, `:555` (8a6bc2f84); only the pre-migration snapshot stays synchronous, deliberately, `storage-database.ts:1060-1066`. |
| ST-14 | Open | Two diffs with `-M`, `commands-files.ts:1005-1029`; exclude per scan, `:979`; see 0440. |
| ST-15 | Open | Counts every untracked file per scan, `commands-files.ts:1078-1082`; serial in `git-scopes.ts:389-396`; see 0450. |
| ST-16 | Open | No gap, `diff-stats-service.ts:929`, `:1089-1097`, `:1126`; see 0420. |
| ST-17 | Open | Recursive root watch, `worktree-watcher.ts:149-150`, `:233`; fsmonitor option is gone; see 0570. |
| ST-18 | Open | `demanded` only cleared by `forget`, `git-scopes.ts:168`, `:231-233`; see 0460. |
| ST-19 | Partly done | Measurement pruning, `change-ledger.ts:1144`, `measurement-service.ts:213`, `retention.ts:122` (8a6bc2f84); `NOT IN` scan at `change-ledger.ts:931-936` remains, see 0540. |
| ST-20 | Open | Two `storedBytes` walks, `retention.ts:95`, `:102`; sweep holds the mutex, `object-store.ts:194`; see 0550. |
| ST-21 | Open | Base64 commands, `commands-registry-terminal.ts:940`, `:960`; two spawns, `commands-files.ts:2335-2361`; see 0580. |
| BG-1 | Done | Bound through the snapshot, `tmux-backend.ts:406`; bounded head and memo, `tmux-hooks.ts:978`, `:1025` (051261eee). |
| BG-2 | Done | Idle cadence and doorbell, `tmux-session-manager.ts:696-707`, `tmux-hook-signal.ts:84` (051261eee). |
| BG-3 | Done | Disabled returns early, `agent-mail-service.ts:380` (12289fc56); liveness reuse, `tmux-commands.ts:334-342` (d7054dace); paused refresh kept by decision, 1202 task 10. |
| BG-4 | Done | Same fix as ST-7. |
| BG-5 | Done | `FrozenStoreSnapshot`, `storage-frozen-snapshot.ts:47`; moved callers include `tmux-poll.ts:447`, `index.ts:708-709`, `native-agent-launch-activity-reconciler.ts:683-684` (381b26f90). |
| BG-6 | Done | `commands-pr-monitor-batch.ts`; quiet backoff, `pr-monitor-policy.ts:88-91` (5254f8e27). |
| BG-7 | Done | `terminalClaudeDemand`, `tmux-poll.ts:457`, `:802` (051261eee). |
| BG-8 | Done | Follower widened, `container-oom-events.ts:25` (12289fc56); `ContainerLifecycleReactor`, `container-lifecycle-events.ts:30` (051261eee). |
| BG-9 | Done | Revision reuse, `agent-human-prompt-monitor.ts:59`, `:249`; OpenCode tail, `opencode-provider.ts:904` (d7054dace). |
| BG-10 | Open | `beforeAdmission` still package-only, `multi-review-service.ts:3631-3633`; per-prompt probe, `:5011-5033`; see 0680. |
| BG-11 | Done | Shared prompt per pass, `build-pipeline-review-fanout.ts:482-496` (d7054dace). |
| BG-12 | Done | Digest first with one pass snapshot, `agent-accounts-containers.ts:1144` (d7054dace). |
| BG-13 | Done | Queued sync shared by later callers, `pr-monitor-runtime.ts:116`, `:169-170` (5254f8e27); the project-scoped alternative was not needed. |
| BG-14 | Open | Whole file read, `tmux-session-manager.ts:284-311`; see 0690. |
| BG-15 | No action | The whole-store reads have gone, as the report predicted; what repeats is keyed reads and a deliberate fresh probe, `prompt-queue-drainer.ts:115-170`, kept by 1202's task 10 record and its recommendation to leave it. |
| DK-1 | Open | Unfiltered stream, `backend-process.ts:662-663`; see 0400. |
| DK-2 | Open | Four serialisations remain, `ipc.ts:297-305`, `backend-process.ts:490-506`; see 0400. |
| DK-3 | Done | `file-stamps.ts:34` (da0f720fa). |
| DK-4 | Done | Idle timeout and `Range:` resume, `download.ts:8-14` (da0f720fa). |
| DK-5 | Open | Data URLs, `browser-preview-capture-image.ts:45-69`, `browser-preview-capture-store.ts:736-739`; see 0691. |
| DK-6 | Open | One socket per stream, `preview-tunnel-client.ts:130-150`; see 0692. |
| DK-7 | Done | Order and split SDK layers, `docker/Dockerfile:40-65`, `:421-423` (fd679c0e2). |
| DK-8 | Done | `mise link`, `docker/Dockerfile:399` (fd679c0e2). |
| DK-9 | Done | `npm cache clean --force`, `docker/Dockerfile:218`, `:247`, `:321` (fd679c0e2). |
| DK-10 | Open | Left for a maintainer, 1202 task 14; pins at `docker/Dockerfile:207`, `bridges/claude-bridge/package.json:16`; see 0693. |
| DK-11 | Done | One `apt-get update`, `docker/Dockerfile:82`; `util-linux` in that layer, `:111` (fd679c0e2). |
| DK-12 | Done | `move_clone_into_workspace`, `docker/workspace-setup.sh:406`, `:500` (2525fc05c). |
| DK-13 | Open | Direct clone only, `docker/workspace-setup.sh:385-397`; see 0500. |
| DK-14 | Open | No stamp in the entrypoints or `portable-inputs.ts`; see 0490. |
| DK-15 | Done | Rename, repair and `EXDEV` fallback, `environment-move.ts:428`, `:470`, `:559` (2525fc05c). |
| DK-16 | Partly done | Transcript `knownToken`, `session.ts:1085`, `actions-transcript.ts:154` (b68b6e710); `attention --follow` remains, see 0694. |
| DK-17 | Done | One bounded read, `packages/cli/src/client/transport.ts:134` (b68b6e710). |
| DK-18 | Open | `mkdir` and `appendFile` per entry, `packages/protocol/src/node/application-logging.ts:441-442`; see [0860-r7-relay-and-file-writer.md](0860-r7-relay-and-file-writer.md), task 1, shared with R7. |

## Status of every logging and database item

12 done, 4 partly done, 21 open, 1 no action.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| R1 levels and categories | Done | `createLogger` (`packages/protocol/src/logger.ts:600`), fixed vocabulary (`packages/protocol/src/log-vocabulary/`) and the lint rule (`.oxlintrc.json:35`), through #1558, #1582, #1590, #1592 and #1619; the report's `legacy` area was deliberately not built (`docs/architecture/logging.md:186`). |
| R2 live settings, persist split from detail | Done | `LogPolicyService` (`apps/backend/src/core/log-policy-service.ts:104`), writer always installed and gated (`packages/protocol/src/node/application-logging.ts:452`), `POST /debug/log-policy` and the `policy.changed` audit line, in #1583. |
| R3 throttle primitive | Done | `log.throttled` (#1565) at `tmux-session-manager.ts:617`, `core/index.ts:2305`, `web-annotation-service-requests.ts:1367`, `preview-publication.ts:359`, `commands-servers.ts:886`, `useTerminal.ts:1125`; kept-branch set bounded (`environment-cleanup.ts:525-530`); three bespoke variants kept on purpose (`docs/architecture/logging.md:109-116`). |
| R4 change-driven heartbeats | Done | `STALL_NO_DELTA_MS` and the keepalive (`packages/protocol/src/node/bridge-diagnostics.ts:18`, `:29`), buffered logger flush (`:684`, `:696`), #1637; report addendum. |
| R5 safe error formatter | Done | `formatLogError` and `CommandFailedError` print backstop (`apps/backend/src/core/shell.ts:75-80`), #1570; the stderr tail was dropped by the user's decision (`docs/architecture/logging.md:258-260`). |
| R6 essential tier and silent gaps | Partly done | Deletion steps log and retrieval commands exist (`commands-servers.ts:1611`, `commands-registry-servers.ts:655`); the tier and most fixes are open in 0720, 0740 and 0750. |
| R7 relay and file writer | Partly done | Level-carrying records and the updater logger landed in #1558 (`backend-process.ts:46-64`, `updater-log.ts:35`); batching, line bound and relay skip are open in 0860 (`docs/architecture/logging.md:634-635`). |
| R8 renderer diagnostics | Partly done | Lifecycle logs moved to `debug` (#1592) and keystroke warnings throttled (`useTerminal.ts:1125`); switch, DevTools and ring are open in 0790. |
| R9 Codex raw event logging | Open | `ORKESTRATOR_CODEX_RAW_LOG_DIR` is read and never set (`bridges/codex-bridge/src/index.ts:382`), writer reachable only for tests (`:974`), default still on (`app-config-defaults.ts:91`); 0770. |
| R10 Docker log hygiene | Open | `cat >>` fallback (`docker/orkestrator-log-writer.sh:35-40`), no options without `local` (`container-resources.ts:212`), `...process.env` (`commands-servers.ts:961`); 0830 and 0850. |
| R11 export diagnostics | Open | No export code or `diagnostics` CLI command exists; the Bug button reads facts, not metrics (`packages/protocol/src/node/bug-report-facts.ts`); 0780. |
| R12 health summary | Open | No `process.memoryUsage` under any `src`, and no shutdown marker; 0820. |
| R13 metric primitives | Open | `samples.shift()` (`apps/backend/src/preview-metrics.ts:53`), write-only stores, `/metrics` flushes through SQLite (`gateway-handlers.ts:352`); 0880. |
| R14 bound measurement rows | Open | Every file row is inserted (`change-ledger.ts:1055-1075`), with no cap on net scopes; 0700. |
| R15 prune fully, skip no-change | Open | Still 256 rows per publish (`measurement-service.ts:213-219`), and `provisional` does not compare trees (`turn-boundaries.ts:626-680`); 0710. |
| R16 ledger retention | Open | No `DELETE` for frames, operations, evidence, boundaries or windows in `change-ledger.ts`, and `deleteEnvironment` never touches change tracking (`commands-servers.ts:1500`); 0730. |
| R17 ledger out of hourly snapshots | Open | `VACUUM INTO` copies the whole file (`storage-backups.ts:313`), in one database; 0760. |
| R18 durability and maintenance | Open | Settings unchanged (`storage-database.ts:291-294`) and `wal_checkpoint(TRUNCATE)` still synchronous (`:927`); tiers deferred by a maintainer decision (1202 task 2, ST-12); 0800, 0910 and 0920. |
| R19 database observability | Open | `handleMetrics` has no database field (`gateway-handlers.ts:337-358`), `RetentionReport` discarded (`change-tracking/service.ts:242`), no `dbstat` query; 0810. |
| R20 keyed reads, blob length | Partly done | ST-7 and ST-8 done (`storage-projects.ts:654`, 1202 task 2); `length(CAST(value AS BLOB))` (`storage-database.ts:1152`, `:1186`), read-only leases and the per-row prune are open in 0870. |
| Control: Essential event log note | Open | No essential log or note in Settings → Debug; 0750. |
| Control: Save detailed logs to disk | Done | **Save Logs to Disk**, off by default, live (`GlobalSettings.sections.tsx:2182`, `app-config-defaults.ts:92`). |
| Control: Keep detailed logs for | Done | Retention input with live sweep and size display (`GlobalSettings.sections.tsx:2213`, `docs/architecture/logging.md:514-519`). |
| Control: Detail level | Done | **Log Detail** default level, `info` (`LogDetailSettings.tsx`, `logDetail` in `app-config-defaults.ts:93`). |
| Control: Per-area overrides | Done | Levels by area, collapsible (`LogDetailSettings.tsx`), with `logDetailAreas` from `packages/protocol/src/log-policy.ts`. |
| Control: Quick presets | Open | No preset in `LogDetailSettings.tsx`; 0890. |
| Control: Auto-revert detail | Open | No expiry on `logDetail` (`packages/protocol/src/log-policy.ts`); 0890. |
| Control: Renderer debug logging | Open | `orkestrator:debug` has no setting or UI (`docs/architecture/logging.md:755-761`); 0790. |
| Control: Export diagnostics | Open | Not built; 0780. |
| Control: Open log folder and clean up | Done | Both buttons exist in Settings → Debug (`GlobalSettings.sections.tsx`, near `:2293`). |
| Control: `--log-level`, `--log-category` | Open | Neither is in `apps/backend/src/server-flags.ts` or `packages/cli/src/client/argv.ts`; recommended outcome is no flag; 0900. |
| Control: `ORKESTRATOR_LOG` | Done | Built as `ORKESTRATOR_LOG_LEVEL` with the same syntax (`packages/protocol/src/node/logger-environment.ts:11`). |
| Design note: privacy text in the UI | Open | Log Detail's copy does not state it (`LogDetailSettings.tsx`); 0890. |
| Finding with no recommendation: D4 Kanban, notes, plans, comments after project removal | Open | `removeProject` does not touch them (`storage-projects.ts:476-502`); 0840. |
| Finding with no recommendation: L4 backend `uncaughtException` | Open | No handler in the backend, while the desktop has one (`native-dialogs.ts:232`); task in 0750. |
| Finding with no recommendation: L4 Electron `crashReporter` | No action | Nothing leaves the machine by design, and a minidump is not content-free; recorded in 0750. |
| Finding with no recommendation: L10 dead code, M2 wrong comments | Open | `run-diagnostics.ts:12`, `commands-registry-system.ts:66`; 0930. |
| Finding with no recommendation: L10 tags and level misuse | Done | Fixed areas replaced tags (`docs/architecture/logging.md:794-884`); raw stderr stays `ERROR` by design, as text with no level (`:604`). |
