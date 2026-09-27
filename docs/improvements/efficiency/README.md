# Application efficiency review

Reviewed 2026-09-20–21 at commit `88c2f9cc`.

Status: Implemented on branch `implement-efficiency-improvements-7f0993836777-r1`
(2026-09-27). Every finding has shipped changes; remaining limitations and
unrun real-stack checks are listed per step in the [plan](plan/00-index.md) and
consolidated in [step 19](plan/19-integration-and-rollout.md). Measured
before/after results: [baseline/](baseline/README.md). The findings below are
kept as the dated review evidence.

The [implementation plan](plan/00-index.md) expands these findings into 19
numbered steps with dependencies, file ownership, compatibility/migration
rules, regression scenarios, acceptance criteria, and a staged rollout.

The largest opportunities are to avoid reprocessing unchanged transcript data,
enforce display budgets while agents run in the background, and separate
transcript storage from shared workflow/configuration snapshots. Compression
and slower polling can help, but they do not remove the underlying work.

## Findings and suggested order

P1 means address next because the issue can defeat a resource or persistence
boundary, or puts substantial avoidable work on a common path. P2 means a
confirmed optimization opportunity whose production impact should be measured
before choosing the implementation. These are priorities, not measured incident
severities. “Probe” means reproduced with synthetic inputs against repository
functions; “source” means established by tracing the implementation.

| ID | Priority | Finding | Evidence | Main cost |
| --- | --- | --- | --- | --- |
| [E01](transcripts.md#e01-cursor-does-not-enforce-aggregate-budgets-during-unobserved-streaming) | P1 | Cursor transcript bounds depend on reads or turn boundaries | Probe | Background memory growth |
| [E02](transcripts.md#e02-cursor-skips-all-persistence-when-the-shared-state-file-is-too-large) | P1 | Cursor skips persistence when aggregate state exceeds 32 MiB | Source | Repeated serialization; lost durable updates |
| [E03](transcripts.md#e03-claudes-unchanged-response-still-hashes-the-whole-transcript) | P1 | Claude hashes full history to answer an unchanged tail read | Probe | Idle CPU and allocations |
| [E04](transcripts.md#e04-display-tail-storage-amplifies-one-session-update-across-all-sessions) | P1 | Display-tail storage reads, validates, and rewrites the shared store | Source | Disk I/O, CPU, lock contention |
| [E05](transcripts.md#e05-streaming-deltas-replace-whole-messages-and-repeat-content-processing) | P2 | Streaming deltas replace whole messages; several stages serialize them | Source | CPU, allocation, bandwidth |
| [E06](transcripts.md#e06-heavy-details-are-deferred-after-the-bridge-has-already-transferred-or-trimmed-them) | P2 | Tool details and attachments are deferred too late in the path | Source | Transfer amplification; hydration retries |
| [E07](transcripts.md#e07-history-pages-rebuild-the-joined-projection-before-serving-the-page) | P2 | History paging refreshes and fingerprints a larger history first | Source | Page latency, bridge traffic |
| [E08](transcripts.md#e08-codex-rollout-caching-does-not-bound-the-cost-of-a-cold-read) | P2 | Codex rollout cache bounds retained source bytes, not cold-read allocations | Source | Peak heap; oversized-file rereads |
| [E09](transcripts.md#e09-provider-trimming-still-repeatedly-serializes-the-shrinking-transcript) | P2 | Cursor/Pi/ACP trimming repeatedly serializes shrinking histories | Probe + source | Event-loop stalls at limits |
| [E10](frontend-and-workflows.md#e10-retained-frontend-history-is-reserialized-on-live-updates) | P2 | Frontend byte accounting revisits retained history on live updates | Source | Main-thread work and GC |
| [E11](frontend-and-workflows.md#e11-polling-is-tab-aware-but-not-document-visibility-aware) | P2 | Hidden documents still poll; HTTP activity sweeps are per session | Source | Requests, battery, backend work |
| [E12](frontend-and-workflows.md#e12-unchanged-file-tree-responses-still-enumerate-the-workspace) | P2 | Conditional file trees still scan, sort, and hash the workspace | Source | Filesystem I/O and Docker exec |
| [E13](frontend-and-workflows.md#e13-multi-review-transcripts-bypass-the-progressive-native-chat-path) | P2 | Reviewer views and progress probes use legacy transcript reads | Source | Whole-transcript transfer |
| [E14](frontend-and-workflows.md#e14-build-pipelines-embed-transcripts-in-the-shared-workflow-store) | P1 | Build pipelines duplicate transcripts inside shared persisted snapshots | Source | Storage amplification, snapshot growth |

Start with E01/E02, then E03 and E09: these have narrow ownership and direct
regression criteria. Address E04/E14 together at the storage-design level, while
keeping their recovery semantics separate. Next, implement upstream lightweight
transcript windows and shared conditional reads (E06/E07/E13), then evaluate
finer-grained updates and frontend accounting (E05/E10). E11/E12 are useful
independent work once baseline request and scan counts are available.

## What already works well

This is not an unbounded full-transcript design throughout the app:

- The progressive bridge envelope supports conditional tokens, 100-message
  windows, and a 512 KiB target. Codex, Cursor, and Pi pass revisions that can
  avoid content hashing on an unchanged read.
- Native chat separates transcript, state, and discovery reads. The backend
  shares in-flight work and maintains bounded caches. A cached display tail can
  paint before the provider finishes recovery.
- Backend projections defer heavy tool output, diffs, and eligible images.
  The renderer has bounded live/history caches, a virtualized list, and WeakMap
  caches for message normalization. Merely adding virtualization or memoization
  would duplicate work already done.
- Codex rollout metadata scans read a bounded head; incremental cache reads
  parse appended records. Codex publication already coalesces message updates
  and uses slower publication for larger messages.
- Gateway and bridge streams have replay/reconciliation and slow-consumer
  controls. Terminal history has its own authoritative snapshot/archive path.
  These mechanisms should survive optimization.

## Scope and confidence

The review traced all six provider paths (Claude, Codex, OpenCode, Cursor, Pi,
and Grok/ACP), shared transcript contracts, backend projections and persistence,
native chat stores and rendering, history paging, multi-review and build
pipeline consumers. It also sampled gateway compression/replay, Electron IPC,
terminal history, filesystem polling, and background activity reconciliation.
The iOS app hosts the same web interface, so web polling and rendering costs
also apply there; this was not a native iOS profiling exercise.

This is a cross-application source review, not a claim that every feature or
line was exhaustively audited. There was no production profiling, provider
traffic capture, live-user transcript inspection, browser performance trace,
or full application test-suite run. Three small synthetic probes ran with Bun
1.4.2; [validation.md](validation.md) contains the inputs, observations, and
reproduction commands. Only documentation was changed.

## Follow-up measurement

Measure source bytes read, normalization/serialization time, decoded and encoded
bytes at each hop, cache size/eviction counts, storage bytes rewritten, and
renderer long tasks. A small response alone is not evidence of a cheap read.
Use bounded labels and synthetic content; never log prompts, tool output,
credentials, attachment data, or file contents.

The existing [compression evaluation](../../todo/remote-stream-compression.md)
and [client data-saving proposal](../../todo/remote-client-data-saving-mode.md)
already cover optional transport/scheduling work. E11 adds current source
evidence to that proposal. Keep compression defaults unchanged until an
isolated remote-path benchmark demonstrates a net benefit.

All fixes must retain backend ownership of background work, authoritative
rehydration, explicit revision/generation recovery, bounded queues, and
fail-closed approvals. Removing a view must never cancel an agent; truncating a
display buffer must never imply that a background tool completed.
