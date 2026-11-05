# Efficiency, logging and database: outstanding work

What is left to do from the [efficiency review](../2026-10-27-efficiency.md) and the [logging and database efficiency review](../2026-10-29-logging-and-database-efficiency.md), combined. Numbers 0100 to 0699 come from the efficiency review and 0700 onwards from the logging and database review. Efficiency finding DK-18 and recommendation R7 are the same work, so they share one file.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.
Work that is already built has no file; the status table below records it.

A batch file combines several reports as numbered parts and takes the rating of its most serious part. A number such as `0720` in this index names a part or a file, and the table below shows where it lives.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0400-e26-local-desktop-transport.md](0400-e26-local-desktop-transport.md) | High | No | **E26, Local desktop transport.**<br>`0400`: DK-1, DK-2: Local desktop windows relay every event and invoke through Electron main<br>`0860`: R7's remainder (L6) and DK-18: batching, line bound and skipping the relay. | From `0400`: Every terminal byte on a local desktop run is parsed in Electron main and cloned to each window, which wastes compute continuously. |
| 2 | [0420-e7-diff-scans.md](0420-e7-diff-scans.md) | High | No | **E7, Diff scans.**<br>`0420`: ST-16: Local diff scans have no minimum gap under constant writes<br>`0440`: ST-14: Each diff scan spawns several git processes<br>`0450`: ST-15: Untracked files are re-read on every scan<br>`0460`: ST-18: Git-scope demand never expires<br>`0570`: ST-17: Recursive `fs.watch` covers the whole worktree, `node_modules` included | From `0420`: Any install or build in a local environment runs git scans back to back with no spacing. |
| 3 | [0720-e13-silent-failures.md](0720-e13-silent-failures.md) | High | No | **E13, Silent failures.**<br>`0720`: R6's specific fixes (L4): writer lease, bridge exit, resume fallback, ACP, turn failures, storage swallows.<br>`0830`: R10's environment item and L10: filter inherited vendor debug variables. | From `0720`: Users hit silently stopped schedules and agents that forget their conversation, with nothing recording why. |
| 4 | [0540-e3-retention-and-deletion.md](0540-e3-retention-and-deletion.md) | High | No | **E3, Retention and deletion.**<br>`0730`: R16 (D4): purge on environment deletion and age-based ledger retention.<br>`0540`: ST-19 (rest): `activeTurns()` scans every turn boundary, and the rows are never removed<br>`0840`: D4's last sentence, which no recommendation covers: Kanban, notes, plans and completion comments survive project removal. | From `0730`: The ledger grows for every user with no bound, and deleting an environment leaves its history and evidence bodies behind. |
| 5 | [0100-e19-terminal-websocket.md](0100-e19-terminal-websocket.md) | Medium | No | **E19, Terminal WebSocket.**<br>`0100`: GW-6: Terminal WebSocket flush ignores the socket buffer and desyncs quiet channels<br>`0375`: GW-16: Small per-chunk and per-frame gateway costs<br>`0610`: WEB-11: The terminal WebSocket rebuilds every channel on every visibility change | From `0100`: A noisy terminal can force a quiet one to resync, a functional gap limited to the opt-in terminal WebSocket. |
| 6 | [0110-e9-transcript-reads.md](0110-e9-transcript-reads.md) | Medium | No | **E9, Transcript reads.**<br>`0150`: TX-2, TX-15: Dispatches and control changes trigger an unlimited raw transcript read<br>`0200`: TX-18: The `/messages` fallback ignores the limit it has in scope<br>`0110`: TX-8: A tool-detail cache miss cannot recreate remote references | From `0110`: An evicted summary-backed tool detail fails after a costly raw read, a functional gap that needs a cache eviction to appear. |
| 7 | [0120-gw-3-bearer-terminal-streams.md](0120-gw-3-bearer-terminal-streams.md) | Medium | No | GW-3: Bearer-token web clients open one event stream per terminal | Several terminals on a bearer client can starve `/invoke` on HTTP/1.1, a functional gap for that client type only. |
| 8 | [0130-e21-pi-bridge.md](0130-e21-pi-bridge.md) | Medium | Yes | **E21, Pi bridge.**<br>`0130`: BR-10: Pi session list parses every file on each call and hides a timeout<br>`0355`: BR-14: Pi persistence serialises every session on each write | From `0130`: A large Pi history times out and shows an empty list with no error, a functional gap on an infrequent path. |
| 9 | [0140-br-13-serial-queue-bound.md](0140-br-13-serial-queue-bound.md) | Medium | Yes | BR-13: Codex notification queue has no count bound and allocates per notification | The queue has no count bound, so the fix removes a real risk and restores a stated invariant. |
| 10 | [0430-e4-object-store.md](0430-e4-object-store.md) | Medium | No | **E4, Object store.**<br>`0430`: ST-3: Warm captures pay one `utimes` and one `stat` per reused object<br>`0480`: ST-6: Object store runs zlib and fsync synchronously on the event loop<br>`0530`: ST-5: Manifests are re-parsed for every diff page and searched linearly<br>`0550`: ST-20: Hourly retention walks the object store repeatedly | From `0430`: It is the largest remaining warm-capture cost seen in one profile, but runs on a bounded path and has no clean measurement. |
| 11 | [0490-e25-container-start.md](0490-e25-container-start.md) | Medium | No | **E25, Container start.**<br>`0490`: DK-14: Agent-home inputs are copied in full per environment and again on every start<br>`0500`: DK-13: Each environment clones from the remote again | From `0490`: Every container start copies inputs again, at a size nobody has measured. |
| 12 | [0510-e12-renderer-store.md](0510-e12-renderer-store.md) | Medium | No | **E12, Renderer store.**<br>`0510`: WEB-6: The live-head merge serialises parts with no identity shortcut<br>`0590`: WEB-2 (rest): The native session hook subscribes to whole cache entries it reads only at mount<br>`0640`: WEB-14: Projection store writes copy four Maps even when one changes | From `0510`: Head-row serialisation runs on transcript updates while streaming, at a cost no Profiler run has confirmed. |
| 13 | [0520-web-9-startup-bundle.md](0520-web-9-startup-bundle.md) | Medium | Yes | WEB-9: Heavy chat code is in the startup closure | Every launch loads heavy chat code, but the sizes come from one older build. |
| 14 | [0740-e14-docker-logs.md](0740-e14-docker-logs.md) | Medium | No | **E14, Docker logs.**<br>`0740`: R6 and L4: keep the previous Docker bridge log across a relaunch and make it readable.<br>`0850`: R10's disk items (L9): the no-perl fallback, dropped-write markers and the driver fallback. | From `0740`: It loses the evidence for a crash but no user data, and it affects container bridges only. |
| 15 | [0750-e15-health-and-diagnostics.md](0750-e15-health-and-diagnostics.md) | Medium | No | **E15, Health and diagnostics.**<br>`0750` (done): R6's always-on tier and control, plus L4's uncaught exception gap.<br>`0820`: R12 (M1): a rolling health row and a clean shutdown marker.<br>`0810`: R19 (M6): database size, waits, top tables and a panel.<br>`0880`: R13 (M3, M4, M5): write-only metrics, small inefficiencies and shared primitives.<br>`0780`: R11 (M2, L7) and its control: a local diagnostics bundle. | From `0750`: First-occurrence evidence is a missing measurement rather than a defect in shipped behaviour. |
| 16 | [0760-e5-database-upkeep.md](0760-e5-database-upkeep.md) | Medium | No | **E5, Database upkeep.**<br>`0760`: R17 (D3): the ledger leaves hourly snapshots.<br>`0800`: R18's checkpoint item (D6).: Stop the scrub checkpoint stalling the event loop during a backup<br>`0910`: R18's maintenance items (D5): `optimize`, `foreign_keys`, cache sizes.<br>`0920`: R18's tiers (D5).: Tier `synchronous` and `secure_delete` by data | From `0760`: Disk is already capped at 16 GiB and the copy runs off the event loop, and the cost shrinks with R14 and R15. |
| 17 | [0770-e17-dead-code.md](0770-e17-dead-code.md) | Medium | No | **E17, Dead code.**<br>`0770`: R9 (L8): remove the no-op toggle.<br>`0930`: L10 and M2 leftovers that no recommendation covers. | From `0770`: A default-on setting tells users something false, though nothing is captured today. |
| 18 | [0790-e16-log-controls.md](0790-e16-log-controls.md) | Medium | No | **E16, Log controls.**<br>`0790`: R8's remainder (L7) and its control: a switch, DevTools and a persisted error ring.<br>`0890`: User controls: presets, auto-revert and privacy text.<br>`0900`: User controls: `--log-level` and `--log-category`. | From `0790`: Renderer bugs in the packaged app leave no trace, which is a supportability gap rather than broken behaviour. |
| 19 | [0160-e10-conditional-reads-and-deltas.md](0160-e10-conditional-reads-and-deltas.md) | Low | No | **E10, Conditional reads and deltas.**<br>`0160`: TX-1: A transcript delta can only be built from the newest cached view<br>`0180`: TX-5: Session-state reads have no conditional path from the bridge<br>`0190`: TX-6: Bridge transcript windows are always sent whole | From `0160`: The report rates it High, but the maintainer gated it on a baseline, so it stays Low until that measurement arrives. |
| 20 | [0210-e11-projection-hashing.md](0210-e11-projection-hashing.md) | Low | No | **E11, Projection hashing.**<br>`0210`: TX-3: The legacy commit re-serialises the whole projection to fingerprint it<br>`0220`: TX-9, TX-13: Memoise row fingerprints and hash them for the view token<br>`0320`: TX-7: Head-row recovery re-reads the raw transcript on each streaming revision<br>`0330`: TX-11: Patch building re-serialises and hashes whole rows in a JavaScript loop<br>`0340`: TX-12: Already-encoded rows are stringified again on the way out<br>`0345`: TX-14: Restart-preview checkpoints are serialised three times and cloned<br>`0350`: TX-16: Inline tool bodies are re-hashed whenever their row misses the cache<br>`0380`: TX-17: Small linear scans in the transcript projection | From `0210`: A contained optimisation with no behaviour change and no measured cost. |
| 21 | [0240-e20-acp-bridge.md](0240-e20-acp-bridge.md) | Low | No | **E20, ACP bridge.**<br>`0270`: BR-16: ACP's Cursor replay looks like dead code<br>`0260`: BR-12: ACP stdout framing is quadratic for large frames<br>`0240`: BR-1 (remainder): ACP still serialises every session on each state write | From `0240`: The write rate is already down to once a second, so the remaining cache should wait for a measurement. |
| 22 | [0250-br-7-codex-running-tool-cards.md](0250-br-7-codex-running-tool-cards.md) | Low | Yes | BR-7: Codex re-renders and re-sends running tool cards every publish tick | A CPU optimisation with low wire cost and no measured impact. |
| 23 | [0280-e18-gateway-events.md](0280-e18-gateway-events.md) | Low | No | **E18, Gateway events.**<br>`0280`: GW-5: Events are measured and encoded again for each subscriber<br>`0290`: GW-12: Scoped stream replay writes one cursor frame per skipped event<br>`0300`: GW-14: Replay lookup is a linear filter and an oversized event is invisible<br>`0370`: GW-11: Relayed federation events share one name and the main replay window | From `0280`: A small per-subscriber cost that should wait for a profile. |
| 24 | [0310-e24-gateway-static-and-preview.md](0310-e24-gateway-static-and-preview.md) | Low | No | **E24, Gateway static and preview.**<br>`0310`: GW-15: Static fallback compression runs before the 304 check<br>`0365`: GW-10: The preview body rewrite makes many full regex passes | From `0310`: Wasted compression only for revalidated static files that have no precompressed sibling. |
| 25 | [0360-br-15-sse-replay-rings.md](0360-br-15-sse-replay-rings.md) | Low | No | BR-15 (remainder): Two SSE replay rings with uneven quality | Duplicate ring code whose backend subscriber only receives small observation frames. |
| 26 | [0385-tx-10-joined-history-pages.md](0385-tx-10-joined-history-pages.md) | Low | No | TX-10: Joined history pages read the whole transcript per page | A compatibility path that only older renderers use and that 0232 will remove, blocked on the support window. |
| 27 | [0390-gw-7-websocket-compression.md](0390-gw-7-websocket-compression.md) | Low | No | GW-7: No WebSocket message compression | Deferred by 0052 decision D6 until the transport direction is chosen. |
| 28 | [0560-st-9-agent-mail-store-remainder.md](0560-st-9-agent-mail-store-remainder.md) | Low | No | ST-9 (rest): Agent mail: pending injects and mailbox lists still sit on the whole store | The read cost the finding described has gone, and the rest needs a stored-format change only a measurement could justify. |
| 29 | [0580-st-21-file-rpc-and-usage-report.md](0580-st-21-file-rpc-and-usage-report.md) | Low | No | ST-21: Whole files cross RPC as base64, branch reads spawn twice, and usage reports parse every row | These are occasional, bounded reads. |
| 30 | [0600-e22-chat-rendering.md](0600-e22-chat-rendering.md) | Low | No | **E22, Chat rendering.**<br>`0600`: WEB-10: With find open, the whole transcript is re-indexed on every update<br>`0670`: WEB-19: Streaming markdown rebuilds the whole message's tree per update | From `0600`: The cost exists only while find is open on a long transcript. |
| 31 | [0620-e23-renderer-polling.md](0620-e23-renderer-polling.md) | Low | No | **E23, Renderer polling.**<br>`0620`: WEB-12: One environment change refetches the project's whole environment list<br>`0630`: WEB-13: Expanded truncated folders are re-read every 5 s without a digest<br>`0660`: WEB-18: Some renderer polls keep running while the window is hidden | From `0620`: Bursts already collapse to one project read, so this should wait for a measurement. |
| 32 | [0650-web-16-terminal-container-environment-subscription.md](0650-web-16-terminal-container-environment-subscription.md) | Low | No | WEB-16: `TerminalContainer` subscribes to the whole environment object | It is an unmeasured re-render, with launch-effect risk in the fix. |
| 33 | [0680-bg-10-multi-review-snapshot-drift-checks.md](0680-bg-10-multi-review-snapshot-drift-checks.md) | Low | No | BG-10: Multi Review snapshot mode runs a drift check per reviewer | It costs a bounded number of extra git probes per review pass. |
| 34 | [0691-dk-5-preview-capture-data-urls.md](0691-dk-5-preview-capture-data-urls.md) | Low | No | DK-5: Preview captures cross IPC as large data URLs | Captures are occasional and bounded. |
| 35 | [0692-dk-6-preview-tunnel-multiplexing.md](0692-dk-6-preview-tunnel-multiplexing.md) | Low | No | DK-6: The preview tunnel opens a WebSocket per TCP connection | The existing connection pool already removes most repeats. |
| 36 | [0693-dk-10-second-claude-binary.md](0693-dk-10-second-claude-binary.md) | Low | No | DK-10: The image ships two Claude Code native binaries | It is an optional image-size saving that waits on a maintainer decision. |
| 37 | [0694-dk-16-attention-follow-polling.md](0694-dk-16-attention-follow-polling.md) | Low | No | DK-16 (rest): CLI `attention --follow` re-downloads pending items on every poll | It affects only long-running followers, and pending pages are probably small. |

## Parallel running

The full plan, with every lane across all four folders, is in [batches.md](../batches.md).

Batches in the same lane run one at a time, in the order shown. Batches in different lanes can run together unless **Not at the same time as** names the other one. A batch with no lane only has to respect that column.

This index only changes when a branch merges, so it can't show what is running now. Before starting a batch, check the running environments and open PRs for its lane and its **Not at the same time as** list. Put the batch ID in the environment and branch name so that check can find it.

### Batches

| Batch | Name | Parts | Lane and position | Finish first | Not at the same time as |
| --- | --- | --- | --- | --- | --- |
| E1 | Baseline run | The baseline task in `0150`, `0160`, `0180`, `0190` and `0400` | No lane | None | None |
| E14 | [Docker logs](0740-e14-docker-logs.md) | `0740`, `0850` | Containers, 5 of 6 | None | None |
| E25 | [Container start](0490-e25-container-start.md) | `0490`, `0500` | Containers, 6 of 6 | None | None |
| E9 | [Transcript reads](0110-e9-transcript-reads.md) | `0150`, `0200`, `0110` | Transcript, 1 of 4 | E1 (Baseline run) | None |
| E10 | [Conditional reads and deltas](0160-e10-conditional-reads-and-deltas.md) | `0160`, `0180`, `0190` | Transcript, 2 of 4 | E1 (Baseline run) | None |
| E11 | [Projection hashing](0210-e11-projection-hashing.md) | `0210`, `0220`, `0320`, `0330`, `0340`, `0345`, `0350`, `0380` | Transcript, 3 of 4 | None | None |
| E12 | [Renderer store](0510-e12-renderer-store.md) | `0510`, `0590`, `0640` | Transcript, 4 of 4 | None | C6 (Errors and dead ends) |
| E3 | [Retention and deletion](0540-e3-retention-and-deletion.md) | `0730`, `0540`, `0840` | Change tracking, 1 of 2 | None | E7 (Diff scans) |
| E4 | [Object store](0430-e4-object-store.md) | `0430`, `0480`, `0530`, `0550` | Change tracking, 2 of 2 | None | None |
| E5 | [Database upkeep](0760-e5-database-upkeep.md) | `0760`, `0800`, `0910`, `0920` | Storage, 1 of 2 | None | E15 (Health and diagnostics) |
| E7 | [Diff scans](0420-e7-diff-scans.md) | `0420`, `0440`, `0450`, `0460`, `0570` | Git scans and file reads, 1 of 2 | None | E3 (Retention and deletion) |
| E26 | [Local desktop transport](0400-e26-local-desktop-transport.md) | `0400`, `0860` | Desktop, 1 of 2 | E1 (Baseline run) | E-0120 (Bearer terminal streams) |
| E19 | [Terminal WebSocket](0100-e19-terminal-websocket.md) | `0100`, `0375`, `0610` | Gateway, 1 of 6 | None | None |
| E18 | [Gateway events](0280-e18-gateway-events.md) | `0280`, `0290`, `0300`, `0370` | Gateway, 4 of 6 | None | None |
| E24 | [Gateway static and preview](0310-e24-gateway-static-and-preview.md) | `0310`, `0365` | Gateway, 5 of 6 | None | None |
| E13 | [Silent failures](0720-e13-silent-failures.md) | `0720`, `0830` | Logging and diagnostics, 1 of 4 | None | S2 (Bridge credential), E20 (ACP bridge), E21 (Pi bridge) |
| E17 | [Dead code](0770-e17-dead-code.md) | `0770`, `0930` | Logging and diagnostics, 2 of 4 | None | None |
| E15 | [Health and diagnostics](0750-e15-health-and-diagnostics.md) | `0750`, `0820`, `0810`, `0880`, `0780` | Logging and diagnostics, 3 of 4 | None | E5 (Database upkeep) |
| E16 | [Log controls](0790-e16-log-controls.md) | `0790`, `0890`, `0900` | Logging and diagnostics, 4 of 4 | None | None |
| E20 | [ACP bridge](0240-e20-acp-bridge.md) | `0270`, `0260`, `0240` | No lane | None | S2 (Bridge credential), E13 (Silent failures) |
| E21 | [Pi bridge](0130-e21-pi-bridge.md) | `0130`, `0355` | No lane | None | S2 (Bridge credential), E13 (Silent failures) |
| E22 | [Chat rendering](0600-e22-chat-rendering.md) | `0600`, `0670` | No lane | None | None |
| E23 | [Renderer polling](0620-e23-renderer-polling.md) | `0620`, `0630`, `0660` | No lane | None | C7 (Work panel and navigation) |

Why these are grouped:

- **E1:** The baseline task in `0150`, `0160`, `0180`, `0190` and `0400`. A measurement on an isolated `dev:test` profile with no code change, and it must happen before E9, E10 and E26. `0400` also needs Electron main-process CPU and IPC figures.
- **E14:** Same log writer and bounds.
- **E25:** `0500` depends on `0490`.
- **E9:** `0200` and `0110` link to `0150`.
- **E10:** Waiting on the baseline. `0190` links to `0160`.
- **E11:** Serialising and hashing in the projection path. All Low.
- **E12:** Same hook and projection store.
- **E3:** All decide what gets deleted and when.
- **E4:** Same store and capture code. `0550` depends on `0530`.
- **E5:** `0760`, `0910` and `0920` follow the measurement row cap, which is built. `0920` also has a maintainer deferral.
- **E7:** The reports cross-reference each other. `0570` is measure-first.
- **E26:** Both in `backend-process.ts`.
- **E19:** Same server and client pair.
- **E18:** Same replay and event files.
- **E24:** Both in `gateway-proxy.ts`.
- **E13:** Local bridge launch and exit.
- **E17:** Low-risk removals. Goes before E15, which names six of the same files.
- **E15:** Build the sources first. `0780` then packages them.
- **E16:** Linked settings for log detail.
- **E20:** Remove the dead code first.
- **E21:** Same bridge.
- **E22:** Both redo work on each transcript update.
- **E23:** Background refetches.

### Files built on their own

These still follow the lane and conflict rules above.

| Batch | Name | Files | Lane and position | Finish first | Not at the same time as |
| --- | --- | --- | --- | --- | --- |
| E-0580 | [File RPC and usage report](0580-st-21-file-rpc-and-usage-report.md) | `0580` | Git scans and file reads, 2 of 2 | None | None |
| E-0691 | [Preview capture data URLs](0691-dk-5-preview-capture-data-urls.md) | `0691` | Desktop, 2 of 2 | None | None |
| E-0120 | [Bearer terminal streams](0120-gw-3-bearer-terminal-streams.md) | `0120` | Gateway, 2 of 6 | None | E26 (Local desktop transport) |
| E-0140 | [Codex queue bound](0140-br-13-serial-queue-bound.md) | `0140` | No lane | None | None |
| E-0250 | [Codex running tool cards](0250-br-7-codex-running-tool-cards.md) | `0250` | No lane | None | None |
| E-0360 | [SSE replay rings](0360-br-15-sse-replay-rings.md) | `0360` | No lane | None | None |
| E-0520 | [Startup bundle](0520-web-9-startup-bundle.md) | `0520` | No lane | None | None |
| E-0650 | [Terminal container subscription](0650-web-16-terminal-container-environment-subscription.md) | `0650` | No lane | None | None |
| E-0680 | [Multi Review drift checks](0680-bg-10-multi-review-snapshot-drift-checks.md) | `0680` | No lane | None | None |
| E-0692 | [Preview tunnel multiplexing](0692-dk-6-preview-tunnel-multiplexing.md) | `0692` | No lane | None | None |
| E-0694 | [Attention follow polling](0694-dk-16-attention-follow-polling.md) | `0694` | No lane | None | None |

### Not ready to start

When one of these becomes ready, it joins the lane shown.

| File | Why it waits | Lane |
| --- | --- | --- |
| [`0385`](0385-tx-10-joined-history-pages.md) | Blocked on todo 0232 and the support window | Transcript |
| [`0390`](0390-gw-7-websocket-compression.md) | Deferred by 0052 decision D6 | Gateway |
| [`0693`](0693-dk-10-second-claude-binary.md) | Waits on a maintainer decision | Containers |
| [`0560`](0560-st-9-agent-mail-store-remainder.md) | Needs a measurement to justify a stored-format change | Storage |

## Status of every efficiency finding

50 done, 8 partly done, 63 open, 2 no action.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| GW-1 | Done | Discovery left the round (`NativeDiscoveryReadSchedule`, `apps/web/src/lib/native-session-read-policy.ts`) and `get_native_agent_live_update` answers transcript and state in one request (`apps/backend/src/core/native-agent-live-update.ts`): 246 requests over 40 s became 85 on a visible running tab; see [1202 task 4](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md). |
| GW-2 | Done | The default compression mode is `on` (`apps/backend/src/gateway-support-core.ts:536`, #1548 `12289fc56`, 0052 D14), and SSE streams use `GzipEventClientWriter` (`apps/backend/src/gateway-handlers.ts:211`). |
| GW-3 | Open | Bearer and cross-origin clients still open one fetch stream per terminal (`apps/web/src/lib/native/web-gateway.ts:1092-1098`); see 0120. |
| GW-4 | Done | `SseFrameDecoder` keeps a chunk list and searches only the new text (`packages/protocol/src/gateway-event-stream.ts:162`, #1548 `12289fc56`), though the report's minor `indexOf` sub-fix in `parseSseBlock` (`:96`) was not taken, which leaves that parse linear per frame. |
| GW-5 | Done | One `Buffer` per frame is written to every client, with its byte count passed to the writer (`apps/backend/src/gateway-events.ts:30`, `apps/backend/src/gateway-support-extra.ts:653`); see 0280 and 1202 task 11. |
| GW-6 | Done | `flush` pauses channel frames at a 256 KiB watermark and resumes on the send callback (`apps/backend/src/terminal-websocket-server.ts:905`, `:932`); see 0100 and 1202 task 11. |
| GW-7 | Open | No compression option is set (`apps/backend/src/terminal-websocket-server.ts:193-198`), and 0052 D6 defers the work; see 0390. |
| GW-8 | Done | The private-origin proxy reuses pooled connections (`apps/backend/src/preview-http-proxy.ts:160`, `apps/backend/src/preview-upstream-pool.ts`, #1604 `b64242842`). |
| GW-9 | Done | Compressed and rewritten bodies get a derived ETag that maps back upstream (`apps/backend/src/gateway-proxy.ts:188`, `:397`, `apps/backend/src/gateway-proxy-etag.ts`, #1604 `b64242842`). |
| GW-10 | Open | The rewrite still runs nine `replace` passes on HTML (`apps/backend/src/gateway-support-extra.ts:555`); see 0365. |
| GW-11 | Open | All relayed frames share one event name (`apps/backend/src/core/nodes/node-event-relay.ts:233`, `:248`) and the main replay ring; see 0370. |
| GW-12 | Done | One cursor frame per run of skipped replay frames (`apps/backend/src/gateway-events.ts:198`); see 0290 and 1202 task 11. |
| GW-13 | Done | The rebuild section follows `container-lifecycle-updated` with a 15 s backstop (`apps/web/src/components/environments/EnvironmentRebuildSection.tsx:146`, `:175-177`, #1606 `9c06cb7aa`), and 1202 records the choice to leave the other two 3 s backstops. |
| GW-14 | Done | The lookup is a `slice` (`apps/backend/src/gateway-event-replay.ts:182`), and `oversizedAppends` counts frames over the byte bound (`:146`); see 0300 and 1202 task 11. |
| GW-15 | Open | Compression still runs before the 304 check (`apps/backend/src/gateway-proxy.ts:794`, `:860`); see 0310. |
| GW-16 | Open | Timers, decoders, per-operation results and 50 ms acks all remain (`apps/backend/src/gateway-proxy.ts:301-308`, `apps/backend/src/terminal-websocket-server.ts:400`, `:1040`, `apps/web/src/lib/native/terminal-websocket-client.ts:97`); see 0375. |
| TX-1 | Done | Superseded views stay in a bounded ring per key, and the cached answer and the read path both build deltas from it (`apps/backend/src/core/native-agent-transcript-delta-bases.ts`); see 0160. |
| TX-2 | Done | Reads other than `sync-v1` pass a limit to `legacy` through `interactiveSnapshot`, and dropped refreshes read a 32-row tail (`refreshProjectionState` in `apps/backend/src/core/native-agent-transcript-projection.ts`); see 0150. |
| TX-3 | Open | The fingerprint is still a whole `JSON.stringify` (`apps/backend/src/core/native-agent-transcript-projection.ts:5465`); see 0210. |
| TX-4 | Done | Reads are keyed (`apps/backend/src/core/storage-native.ts`, `apps/backend/src/core/storage-prompt-queue-store.ts`, #1548 `12289fc56`), and every mutation holding a key's lease now reads one row (`readNativeAgentSessionUnderLease`); the prompt queue half of a steer is [5100](../../todo/cross-cutting/5100-prompt-queue-row-writes.md). |
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
| BR-7 | Done | `runningItemParts` keeps running parts by accumulator version and `content` is sent only when it changed (`bridges/codex-bridge/src/messages/render-turn.ts`, `bridges/codex-bridge/src/app-server-runtime-rows.ts`); see 1202 task 6. |
| BR-8 | Done | `getToolWithCreatedAt` stamps the tracker entry once (`bridges/claude-bridge/src/services/session-manager-messages.ts:118`, `:994`, #1693 `9a878575d`). |
| BR-9 | Done | `emitRow` returns whether it published, and the caller returns early otherwise (`bridges/claude-bridge/src/services/session-manager-prompt-stream.ts:431`, `:553`, #1693 `9a878575d`). |
| BR-10 | Done | `session-list-cache.ts` keeps the list while no file changes, and a timeout answers 504 (`bridges/pi-bridge/src/agent-session.ts`); see 1202 task 6. |
| BR-11 | Done | `readSessionIndex` caches the parsed index and reads only appended bytes (`bridges/codex-bridge/src/history/session-index-cache.ts`, `bridges/codex-bridge/src/history/rollout.ts:92`, #1683 `38ac30844`). |
| BR-12 | Done | `JsonlLineFramer` searches only the new chunk (`bridges/acp-bridge/src/acp-jsonl-framer.ts`); see 1202 task 6. |
| BR-13 | Done | `SerialQueue` drains an array per key with count and byte bounds, and overflow replaces the child (`bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts`); see 1202 task 6. |
| BR-14 | Done | `encodeStateWithinBudget` encodes each record once (`bridges/pi-bridge/src/persistence.ts`); see 1202 task 6. |
| BR-15 | Partly done | The transcript helpers moved to `packages/protocol/src/node` (#1593 `e668f0a6d`), but the rings remain separate (`bridges/codex-bridge/src/event-ring.ts:62`, `bridges/claude-bridge/src/routes/events.ts:101`); see 0360. |
| BR-16 | Done | The replay and its gates are removed and the harness uses `acp-fixture`; the method-gated `cursor/*` handlers are [4540](../../todo/agent-engines/4540-acp-bridge-cursor-extension-leftovers.md). See 1202 task 6. |
| WEB-1 | Done | A background round is one request plus discovery when due, 3 requests per round to 1.04 (`useNativeAgentSession.ts`); the finding's note that Claude and Codex idle views never back off no longer held (`turn.quietObservation`, `native-session-read-policy.ts`); see [1202 task 4](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md). |
| WEB-2 | Done | Identity kept and recency condition gone (12289fc56); the hook reads its sync and progressive caches with `getState()` (`useNativeAgentSession.ts`, 2026-11-04); see 0590 and [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md). |
| WEB-3 | Done | `useHydrateOncePerEnvironment`, `App.tsx:368`; no-op guards in `environmentStore.ts` setters (12289fc56). |
| WEB-4 | Done | Identity and hydration check before serialising, `pane-layout-persistence.ts:799` (9c06cb7aa). |
| WEB-5 | Done | `quiet` background reads leave the flags alone, `useNativeAgentSession.ts:2233-2237` (9c06cb7aa). |
| WEB-6 | Done | Early return and `sameTranscriptJson` in `hooks/native-agent-live-head.ts` (2026-11-04); see 0510 and 1202. |
| WEB-7 | Done | `selectActivePaneTab`, `AppShell.tsx:69`, `:176`; per-field selectors, `usePullRequest.ts:62-70` (387d1412f). |
| WEB-8 | Done | Normalised only when a handler runs, `AgentInfoButton.tsx:475-479` (9c06cb7aa). |
| WEB-9 | Done | Startup closure 4.23 MB to 2.55 MB, 1.28 MB to 0.80 MB gzip; guarded by `startup-closure.test.ts` (2026-11-04); see 0520 and 1202. |
| WEB-10 | Done | `AgentChatSearchIndex`, gated on `isOpen`, `AgentChatFind.tsx` (2026-11-04); see 0600 and 1202. |
| WEB-11 | Done | On return the terminal socket is pinged and kept when the pong arrives within 2.5 s, replaced otherwise or when the server lacks the `ping` feature, `terminal-websocket-client.ts`, `terminal-websocket-server.ts` (2026-11-04); see 0610 and 1202. |
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
| ST-10 | Done | Compose drafts (`storage-drafts.ts`, 381b26f90), environments (#1736), sessions and projects (`updateStoreRow` in `storage-drafts.ts`, `storage-sessions.ts`, `storage-projects.ts`) write one row; numbers in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 2, live sizes and rates in [5101](../../todo/cross-cutting/5101-store-size-and-write-rate-live.md). |
| ST-11 | Done | `store_rows_position` index, `storage-database.ts:361-365` (381b26f90). |
| ST-12 | No action | Maintainer decided 2026-11-01 to leave pragmas unchanged unless fsync cost still shows (1202 task 2); still as described, `storage-database.ts:291-293`, `:1309`. |
| ST-13 | Done | Hourly copy and check run in a child process, `storage-backups.ts:223`, `:555` (8a6bc2f84); only the pre-migration snapshot stays synchronous, deliberately, `storage-database.ts:1060-1066`. |
| ST-14 | Done 2026-11-04 | One combined diff, the base's commit reused, the exclude file ensured once; see 0440 and [git-scan-caches.md](../../architecture/git-scan-caches.md). |
| ST-15 | Done 2026-11-04 | Per-worktree stat-keyed counts for local scans; bounded concurrency in `git-scopes.ts`; see 0450. |
| ST-16 | Open | No gap, `diff-stats-service.ts:929`, `:1089-1097`, `:1126`; see 0420. |
| ST-17 | Open | Recursive root watch, `worktree-watcher.ts:149-150`, `:233`; fsmonitor option is gone; see 0570. |
| ST-18 | Done 2026-11-04 | Demand lasts 2 min from the last read, then a `reset` event; see 0460. |
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
| BG-14 | Done | One bounded page per reopen, `readPage`, `tmux-transcript-reader.ts`; earlier history pages in, `prependTranscriptPage`, `claudeTmuxStore.ts`; older renderers keep the whole read, counted. Live evidence left in [5120](../../todo/transcripts-and-observation/5120-tmux-transcript-reopen-live-evidence.md). |
| BG-15 | No action | The whole-store reads have gone, as the report predicted; what repeats is keyed reads and a deliberate fresh probe, `prompt-queue-drainer.ts:115-170`, kept by 1202's task 10 record and its recommendation to leave it. |
| DK-1 | Partly done | Local windows on the filtered gateway transport behind a setting that is off by default (2026-11-04, 1202 task 12); the default flip is todo 4501; see 0400. |
| DK-2 | Partly done | Two serialisations per invoke on the gateway transport, behind the same off-by-default setting (2026-11-04, 1202 task 12); see 0400. |
| DK-3 | Done | `file-stamps.ts:34` (da0f720fa). |
| DK-4 | Done | Idle timeout and `Range:` resume, `download.ts:8-14` (da0f720fa). |
| DK-5 | Done | Capture images cross IPC as bytes (2026-11-04, 1202 task 12); region crops still cross as data URLs; see 0691. |
| DK-6 | Done | Tunnel v2 multiplexes an attachment's connections over one socket, `preview-tunnel-session.ts`, `preview-tunnel-mux-server.ts` (2026-11-04, todo 4500); see 0692. |
| DK-7 | Done | Order and split SDK layers, `docker/Dockerfile:40-65`, `:421-423` (fd679c0e2). |
| DK-8 | Done | `mise link`, `docker/Dockerfile:399` (fd679c0e2). |
| DK-9 | Done | `npm cache clean --force`, `docker/Dockerfile:218`, `:247`, `:321` (fd679c0e2). |
| DK-10 | Open | Left for a maintainer, 1202 task 14; pins at `docker/Dockerfile:207`, `bridges/claude-bridge/package.json:16`; see 0693. |
| DK-11 | Done | One `apt-get update`, `docker/Dockerfile:82`; `util-linux` in that layer, `:111` (fd679c0e2). |
| DK-12 | Done | `move_clone_into_workspace`, `docker/workspace-setup.sh:406`, `:500` (2525fc05c). |
| DK-13 | Open | Direct clone only, `docker/workspace-setup.sh:385-397`; see 0500. |
| DK-14 | Partly done | Start copy stamped, `import_agent_input` in `docker/entrypoint.sh` (`staged-inputs=5`, 1202 task 15); the per-environment staging copy remains, see 0490. |
| DK-15 | Done | Rename, repair and `EXDEV` fallback, `environment-move.ts:428`, `:470`, `:559` (2525fc05c). |
| DK-16 | Partly done | Transcript `knownToken`, `session.ts:1085`, `actions-transcript.ts:154` (b68b6e710); `attention --follow` remains, see 0694. |
| DK-17 | Done | One bounded read, `packages/cli/src/client/transport.ts:134` (b68b6e710). |
| DK-18 | Done | One `appendFile` per event-loop turn and `mkdir` only after a failure, in `packages/protocol/src/node/application-logging.ts`; see [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 16 and [E26 part 0860](0400-e26-local-desktop-transport.md#0860-finish-the-electron-relay-and-file-writer), task 1, shared with R7. |

## Status of every logging and database item

12 done, 6 partly done, 19 open, 1 no action.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| R1 levels and categories | Done | `createLogger` (`packages/protocol/src/logger.ts:600`), fixed vocabulary (`packages/protocol/src/log-vocabulary/`) and the lint rule (`.oxlintrc.json:35`), through #1558, #1582, #1590, #1592 and #1619; the report's `legacy` area was deliberately not built (`docs/architecture/logging.md:186`). |
| R2 live settings, persist split from detail | Done | `LogPolicyService` (`apps/backend/src/core/log-policy-service.ts:104`), writer always installed and gated (`packages/protocol/src/node/application-logging.ts:452`), `POST /debug/log-policy` and the `policy.changed` audit line, in #1583. |
| R3 throttle primitive | Done | `log.throttled` (#1565) at `tmux-session-manager.ts:617`, `core/index.ts:2305`, `web-annotation-service-requests.ts:1367`, `preview-publication.ts:359`, `commands-servers.ts:886`, `useTerminal.ts:1125`; kept-branch set bounded (`environment-cleanup.ts:525-530`); three bespoke variants kept on purpose (`docs/architecture/logging.md:109-116`). |
| R4 change-driven heartbeats | Done | `STALL_NO_DELTA_MS` and the keepalive (`packages/protocol/src/node/bridge-diagnostics.ts:18`, `:29`), buffered logger flush (`:684`, `:696`), #1637; report addendum. |
| R5 safe error formatter | Done | `formatLogError` and `CommandFailedError` print backstop (`apps/backend/src/core/shell.ts:75-80`), #1570; the stderr tail was dropped by the user's decision (`docs/architecture/logging.md:258-260`). |
| R6 essential tier and silent gaps | Partly done | The silent failures log and the previous Docker bridge log is kept (0720, 0740); the essential tier is built (0750, `docs/architecture/logging.md`); the user-facing notices are open in 0720. |
| R7 relay and file writer | Partly done | Level-carrying records and the updater logger landed in #1558 (`backend-process.ts:46-64`, `updater-log.ts:35`); batching landed with DK-18; only the line bound and relay skip remain open in [0860](0400-e26-local-desktop-transport.md#0860-finish-the-electron-relay-and-file-writer). See [the file writer](../../architecture/logging.md#the-file-writer). |
| R8 renderer diagnostics | Partly done | Lifecycle logs moved to `debug` (#1592) and keystroke warnings throttled (`useTerminal.ts:1125`); switch, DevTools and ring are open in 0790. |
| R9 Codex raw event logging | Open | `ORKESTRATOR_CODEX_RAW_LOG_DIR` is read and never set (`bridges/codex-bridge/src/index.ts:382`), writer reachable only for tests (`:974`), default still on (`app-config-defaults.ts:91`); 0770. |
| R10 Docker log hygiene | Open | `cat >>` fallback (`docker/orkestrator-log-writer.sh:35-40`), no options without `local` (`container-resources.ts:212`), `...process.env` (`commands-servers.ts:961`); 0830 and 0850. |
| R11 export diagnostics | Open | No export code or `diagnostics` CLI command exists; the Bug button reads facts, not metrics (`packages/protocol/src/node/bug-report-facts.ts`); 0780. |
| R12 health summary | Open | No `process.memoryUsage` under any `src`, and no shutdown marker; 0820. |
| R13 metric primitives | Open | `samples.shift()` (`apps/backend/src/preview-metrics.ts:53`), write-only stores, `/metrics` flushes through SQLite (`gateway-handlers.ts:352`); 0880. |
| R14 bound measurement rows | Partly done | Capped at 2,000 rows per measurement with true totals and a partial mark (`measurement-file-cap.ts`, `measurementFileRowCap` in `policy-registry.ts`), and restore, file pages, diffs and handoffs read past it; the live soak and the directory-row re-check remain, see [4960](../../todo/cross-cutting/4960-measurement-rows-live-soak.md) and [4961](../../todo/cross-cutting/4961-measurement-directory-rows.md). |
| R15 prune fully, skip no-change | Partly done | Owner drain after a publish (`ChangeRetentionService.drainOwner`) and no publish when the tree did not move (`TurnBoundaryService.provisional`); the spacing decision waits on a live measurement, see [4962](../../todo/cross-cutting/4962-provisional-capture-spacing.md). |
| R16 ledger retention | Open | No `DELETE` for frames, operations, evidence, boundaries or windows in `change-ledger.ts`, and `deleteEnvironment` never touches change tracking (`commands-servers.ts:1500`); 0730. |
| R17 ledger out of hourly snapshots | Open | `VACUUM INTO` copies the whole file (`storage-backups.ts:313`), in one database; 0760. |
| R18 durability and maintenance | Open | Settings unchanged (`storage-database.ts:291-294`) and `wal_checkpoint(TRUNCATE)` still synchronous (`:927`); tiers deferred by a maintainer decision (1202 task 2, ST-12); 0800, 0910 and 0920. |
| R19 database observability | Open | `handleMetrics` has no database field (`gateway-handlers.ts:337-358`), `RetentionReport` discarded (`change-tracking/service.ts:242`), no `dbstat` query; 0810. |
| R20 keyed reads, blob length | Done | ST-7 and ST-8 done (1202 task 2). Sizes-only listings use `octet_length` and a primary-key scan (`rows()` in `storage-database.ts`), read-only leases are gone (`getAgentInteractionResolutionJournal`, `resetAgentMailInjectBackoff`) and the prune batches (`usage-history-store.ts`); the fallback on an older macOS is [5102](../../todo/cross-cutting/5102-sqlite-size-fallback-live.md). |
| Control: Essential event log note | Done | One read-only sentence under **Save Logs to Disk** and the size under **Stored logs** (`GlobalSettings.sections.tsx`); 0750. |
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

## Closing check of E2 (Measurement rows)

The outcome of every task in the E2 batch file, checked back against the code on 2026-11-05 before the file was deleted. Base commit `48d2ed40c`; read the batch file at that commit or at `e198fd4a7`, where the build began. R14 and R15 in the table above summarise this. No finding had stopped holding.

| Part | Task | Outcome | Code, evidence or to-do |
| --- | --- | --- | --- |
| 0700 | 1. Cap stored rows | Done | `capMeasurementFiles` in `measurement-file-cap.ts`, `measurementFileRowCap` (2,000) in `policy-registry.ts`, applied at `measurement-service.ts`. It covers `turn-net`, `thread-net` and `environment-net`, plus the other snapshot-pair and Git scopes. Tests in `measurement-file-cap.test.ts`: `text changes survive first, then the rest by path, whatever the input order`; `goes partial with its reason first and counts each dropped file once`; `the same list makes no new measurement, a change past the cap makes one`; `turn-net and thread-net store the cap's rows with true totals`. |
| 0700 | 2. Serve readers past the cap: restore | Done | Plan recomputed with `compareManifests` in `restore.ts`. Tests in `measurement-file-cap.test.ts`: `restore recomputes the whole plan from the manifests and undoes every file`; `restore plans at the real cap stay complete and cost no blob reads`; `restore includes omitted symlinks and gitlinks as explicit unsupported skips`. |
| 0700 | 2. Serve readers past the cap: file list | Done | `omittedRows` in `projection-service.ts`, `actions-changes.ts`, `ChangesView.tsx`, `NativeMessage.change-parts.tsx` and `packages/cli/src/client/commands/changes.ts`. Tests: `stores the cap's rows, keeps true totals and pages to a real end` (`measurement-file-cap.test.ts`); `past the row cap it says how many files are not listed once paging has ended` (`ChangesView.projection.test.tsx`); `a capped file list without a cursor shows the omitted-files note` (`NativeMessage.change-parts.test.tsx`); `says how many changed files have no row past the cap` (`changes-command.test.ts`). |
| 0700 | 2. Serve readers past the cap: diff bodies | Done | `diff-bodies.ts` and `DiffViewerTab.tsx`. Tests: `a diff of a capped measurement ends at its rows and says it is partial` (`measurement-file-cap.test.ts`); `a comparison past the row cap says it does not list every file` (`DiffViewerTab.test.tsx`). |
| 0700 | 2. Serve readers past the cap: handoffs | Done | `handoff.ts`. Test: `the handoff names the true total and the limit` (`measurement-file-cap.test.ts`). |
| 0700 | 2. Serve readers past the cap: recorded contributions and worker summary | Done | The contribution read in `measurement-service.ts` and `coordinator-worker-changes.ts`. Tests: `a capped contribution makes the touched-file count unknown, not short` (`measurement-file-cap.test.ts`); `past the measurement's row cap a filter gives no match count and names what is unlisted` and `capped Git scopes keep positive flags and report omitted membership as unknown` (`coordinator-worker-changes.test.ts`). |
| 0700 | 3. Collapse bulk directories | Moved to a to-do | The report's recommendation, not now, was taken. The re-check after the soak is [4961](../../todo/cross-cutting/4961-measurement-directory-rows.md). |
| 0700 | 4. Prove the size curve flattens | Moved to a to-do | Generated workload `measurement-rows` is recorded in [change tracking](../../architecture/change-tracking.md#benchmarks): at 20,000 files, peak rows 751,834 to 12,000 and peak database 173.5 to 3.5 MiB; at 58,051 files, peak rows 2,082,180 to 12,000 and peak database 479.1 to 3.5 MiB. The soak on a busy live profile is [4960](../../todo/cross-cutting/4960-measurement-rows-live-soak.md). |
| 0700 | Constraint: update the change-tracking architecture document | Done | [Retention and backup](../../architecture/change-tracking.md#retention-and-backup) describes the cap. |
| 0700 | Constraint: older clients stay valid; existing rows read back | Done | `totalRows` still pages, and `omittedRows` is optional. Test: `reads back complete past the cap and shrinks when it is superseded` (`measurement-file-cap.test.ts`). |
| 0700 | Needs verification: sizes come from one installation | Moved to a to-do | [4960](../../todo/cross-cutting/4960-measurement-rows-live-soak.md), "Needs verification". |
| 0700 | Needs verification: does the web diff view render a capped measurement clearly | Done | Checked in a real browser on the throwaway `dev:test` profile `e2-measurement-rows`, with a 2,100-file Claude turn, at desktop and 390 px. Test: `a comparison past the row cap says it does not list every file` (`DiffViewerTab.test.tsx`). |
| 0710 | 1. Prune a superseded measurement promptly | Done | `ChangeRetentionService.drainOwner` in `retention.ts`, started from `onSupersededBacklog` in `measurement-service.ts`. Tests in `measurement-retention.test.ts`: `a publication drains the owner's superseded rows in batches, without the hourly pass`; `a publication under the row ceiling prunes in its own transaction and starts no drain`; `one owner runs one drain, and a reader's pin outlives it`; `a failed drain does not reject and the retention pass still finishes the work`. |
| 0710 | 2. Skip no-change provisional publishes | Done | `TurnBoundaryService.provisional` in `turn-boundaries.ts` skips a publish when both the turn and the thread have published the same tree and consistency. Tests in `service-turns.test.ts`: `a provisional pass whose tree did not move writes no measurement rows`; `unchanged capture retries publication failure on call 1` and `on call 2`; `one capture publishes every running turn in a shared segment`; `a new turn publishes a revert to the prior turn's endpoint`. |
| 0710 | 3. Decide the provisional spacing | Moved to a to-do | Spacing is unchanged, as the report recommended. The measurement and decision are [4962](../../todo/cross-cutting/4962-provisional-capture-spacing.md). |
| 0710 | Needs verification: how often a dirty hint finds an unchanged tree | Moved to a to-do | [4962](../../todo/cross-cutting/4962-provisional-capture-spacing.md) task 1. |
| 0710 | Needs verification: size swings come from one machine and date | Moved to a to-do | [4960](../../todo/cross-cutting/4960-measurement-rows-live-soak.md), "Needs verification". |
