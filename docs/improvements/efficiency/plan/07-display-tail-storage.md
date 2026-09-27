# 07 — Move display tails to independent records and bounded checkpoints

Status: Complete. Prerequisite: 06. Finding: E04.

## Outcome

Reading/writing a tail touches that tail and small metadata only. Continuous
streaming produces a recent restart preview within a documented maximum age.
The preview remains explicitly non-authoritative for actions and history
completeness.

## Owners

- [Display-tail schema and stripping](../../../../apps/backend/src/core/native-agent-display-tails.ts).
- [Storage methods](../../../../apps/backend/src/core/storage-native.ts).
- [Projection scheduling and shutdown](../../../../apps/backend/src/core/native-agent-service-projection.ts).
- Existing display-tail, storage-native, progressive, and lifecycle test owners.

## Implementation

1. Keep the public storage methods and logical keys stable. Implement them using
   step 06 with 512 KiB per-record, 128-record, and 64 MiB compact-data ceilings.
   Account temporary and backup disk usage separately. Cache validated decoded
   tails by record revision within an explicit memory/count bound.
2. Keep the existing payload stripping, checksum, history-completeness, and
   message-window rules. A cache miss is not evidence that the session has no
   transcript. Deferred detail references in a restored preview remain hints
   until the current provider/generation confirms or replaces them.
3. Store eviction metadata independently of payloads. Update changed byte totals
   incrementally; use timestamps/revisions to choose victims without serializing
   every tail. One key must not prevent global eviction from converging.
4. Replace timer reset on every update with per-key dirty state, a quiet-period
   deadline, and a maximum checkpoint deadline. Start with the existing 2-second
   quiet period and a proposed 10-second maximum age for evaluation; document
   any adjusted value from step-01 disk/latency results. One pending latest value
   per key is enough; never enqueue every intermediate tail.
5. Use a small shared write scheduler with count/byte admission. If an update
   arrives during a write, mark dirty and issue one trailing write. Capture the
   session identity/generation and reject stale completion after deletion or
   session replacement.
6. On shutdown, stop accepting new dirty entries before bounded draining.
   Attempt the newest pending tail once per key; if the deadline expires,
   report aggregate skipped counts and rely on provider recovery. Do not block
   exit indefinitely for a display cache or cancel running agents to flush it.
7. On explicit deletion, fence in-flight writers and delete current record,
   prior generations, and any legacy copies under the migration protocol.
   Remove scheduler entries so a late timer cannot recreate the tail.

## Migration

Read v1/v2 legacy tails using their existing validators. On first migration,
process the shared file in a bounded offline/background pass and write each
valid target record. Publish the completed migration marker after enumeration.
Until then, a missing target may fall back to the legacy record unless tombstoned.
Do not reread the whole legacy file on every request: share one bounded import
operation and allow the provider to supply the foreground preview if import is
still running. Oversized/corrupt cache input may be skipped explicitly.

After successful verification, retire the legacy cache and its sensitive
backups according to the cache retention policy. Do not dual-write it forever.
Downgrading may lose only the restart preview, not provider conversation data;
test that older code treats the absent cache as a cache miss. Do not enable
legacy fallback after a completed migration/deletion.

## Validation

- Update/read one key with 1/32/128 records; unchanged neighbors have zero payload
  reads/checksum computations/writes during steady state.
- Stream continuously beyond the maximum checkpoint interval; restart and check
  preview age, then authoritative state/transcript recovery.
- Race update, eviction, shutdown, deletion, and provider generation replacement.
- Crash halfway through import; restart twice and prove idempotence and no
  resurrected deleted records.
- Verify no approvals, credentials, inline tool results, or excluded attachment
  bytes enter persisted tail records or backups.

Ship storage migration and scheduler changes as separate PRs if useful. Both
need to land before E04 is marked resolved.

## Execution record

```text
Status: Implemented, validation pending
Implementation commit / PR: branch worktree-agent-a56e0fae6b3366331 (commit
  "perf(backend): keyed record storage and independent display-tail records")
Protocol or storage decisions: see below
Tests and isolated profiles: focused and full backend suites passed (below);
  no isolated real-stack/Electron restart QA run yet
Before/after measurements: structural operation counts (tests); no timing profile
Compatibility/migration result: one-time legacy import implemented and tested;
  downgrade loses only the restart preview
Remaining limitations: see below
```

### Storage (StorageNative display-tail methods)

Public methods and logical keys are unchanged
(`getNativeAgentDisplayTail`, `putNativeAgentDisplayTail`,
`deleteNativeAgentDisplayTail`, `deleteNativeAgentDisplayTailsByEnvironment`).
`putNativeAgentDisplayTail` gained an optional `{ fence }`; two additive methods
exist for the scheduler: `captureNativeAgentDisplayTailFence()` and
`onNativeAgentDisplayTailDeleted(listener)`. Implementation lives in
`native-agent-display-tail-store.ts` on a cache-class `KeyedRecordStore`
(step 06). On-disk layout under the backend data directory:

```text
native-agent-display-tail-records/          (0700)
  <sha256(namespace, session key)>.rec       one compact tail per session (0600)
  _meta/index.json                           eviction/quota metadata only
  _meta/tombstones.json                      deletions pending legacy retirement
  _meta/migration-<id>.json                  legacy import progress/completion
```

- Limits: 512 KiB per record payload (enforced on write and, newly, on read),
  128 records, 64 MiB aggregate compact payload. Header (4 KiB), temporary
  staging (semaphore: 2 writes / ~1 MiB) and metadata are accounted
  separately. Cache records keep no backups and no previous generation.
- Reads are lock-free and no longer queue behind writes. A decoded-tail cache
  (16 entries / 8 MiB) keyed by record fingerprint and revision serves an
  unchanged record after one `lstat`; callers receive a copy. The decoded
  tail must match the header's key, environment and agent, and still pass the
  existing v1/v2 validator and checksum. A miss is only a miss.
- Eviction uses the metadata index (write time, sizes) updated incrementally;
  no tail is serialized or read to choose victims, and busy keys are skipped.
- Deletion fence: every delete records a monotonically increasing sequence per
  key and per environment (bounded memory, 4,096 each; a fence older than
  forgotten entries is refused conservatively). A write carrying an older fence
  is refused inside the key's critical section, before staging and again before
  publish. Environment deletion enumerates metadata only, then settles in-flight
  writes and enumerates again.

### Scheduler (`native-agent-display-tail-scheduler.ts`)

The projection now calls `NativeAgentDisplayTailScheduler.update` instead of
re-arming a 2 s timer; only the fields, `scheduleDisplayTailPersist`,
`flushDisplayTailPersist` and `settleAndClearProgressiveReads` changed in
`native-agent-service-projection.ts`.

- One pending latest value per key; the tail is built (stripped, checksummed,
  size-checked) lazily once per checkpoint, not per update.
- Due at `min(lastUpdate + 2 s quiet, firstDirty + 10 s max age)`. At most one
  timer per key; an early timer re-arms for the remainder rather than every
  update clearing and recreating it. The 10 s value is the plan's proposal;
  no step-01 disk/latency profile has adjusted it yet.
- Shared write pool of 2 with bounded pending keys (128; excess updates are
  counted and dropped, the provider remains the recovery source). An update
  during a write yields exactly one trailing write (immediately if its deadline
  passed during the write).
- Each pending value captures the storage deletion fence at update time.
  Deletion events from storage discard pending entries and timers; an in-flight
  write is refused by the fence. This fixes the previous resurrection bug where
  a timer firing after invalidation or environment deletion recreated the tail.
- Shutdown (`settleAndClearProgressiveReads`, called from service shutdown)
  stops accepting updates first, then drains concurrently with read settling:
  each key's newest pending value is attempted once within 1.5 s. Anything
  still pending or in flight is reported as one aggregate warning count (no
  keys, no content). Agents are never cancelled and exit never waits longer
  than the deadline.

### Migration from `native-agent-display-tails.json`

- The first display-tail operation starts one shared background import per
  process (serialized across processes with the legacy file's existing
  mutation lock). A cold `get` waits at most 1 s for it; otherwise the
  provider supplies the foreground preview. The legacy file is read once,
  bounded at 192 MiB (it was pretty-printed), never on every request.
- Entries are validated with the existing v1/v2 validators and re-checked
  against the 512 KiB limit; invalid, tampered and oversized entries are
  skipped explicitly and counted. Valid entries are imported newest first,
  at most 128, with create-only CAS (a live checkpoint always wins) and a
  tombstone check inside each record's critical section.
- Progress is checkpointed; the completion marker is published after the
  enumeration. Then the legacy file, its `.bak.1`–`.bak.5` sensitive backups
  and crashed `.native-agent-display-tails.json.*.tmp` copies are removed, and
  tombstones are retired. Legacy fallback therefore exists only until the
  marker and never for tombstoned keys or environments.
- An absent, unreadable, oversized or unparsable legacy file, or an overflowed
  tombstone set, marks the migration complete without importing and retires
  the legacy data (only restart previews are lost).
- If an older binary recreates the legacy file after migration, the next start
  retires it without reading it. Downgrading: older code finds no legacy file
  and treats it as an empty cache (its `loadJson` fallback), losing only the
  restart preview; provider history is untouched.

### Tests

New: `native-agent-display-tail-store.test.ts`,
`native-agent-display-tail-scheduler.test.ts`,
`native-agent-service-display-tail.test.ts` (plus the step-06 suites).
Coverage of the Validation list:

- 1/32/128 records: updating and cold-reading one key performs payload
  reads/writes/checksums/header reads/evictions only for that key (observer
  counts), and exactly one tail decode; unchanged re-reads hit the decoded
  cache with zero payload reads. 129 records evict exactly the oldest.
- Streaming every 500 ms for 35 s (fake clock) checkpoints at the 10 s maximum
  age (3 writes, max age 10 s) and the final value lands 2 s after the stream
  stops; the projection restart path (`getTranscriptUpdate` cold read then
  provider publish) is covered by the existing progressive tests, unchanged.
- Races: update during write (one trailing write), deletion during an in-flight
  write, environment deletion racing due writes, session replacement with a new
  provider session under the same key, bounded pool/admission, shutdown drain
  and deadline expiry with a hung write; through the real projection, session
  invalidation and environment deletion no longer resurrect a pending tail and
  shutdown persists the newest pending preview.
- Crash halfway through import, deletions (key, not-yet-imported key,
  environment) while it is down, a second crash, then completion: exactly the
  undeleted records exist, the legacy file is gone and tombstones are retired.
- Persisted files (records and metadata) contain no tool output/errors,
  approvals/interactions, tokens, credentials, data-URL attachments or diff
  bodies, and no backup/previous/temp copies exist.

Commands run (all passed):

```text
mise exec -- bun run --cwd apps/backend typecheck
mise run test:logged -- --name be-all-e04 -- mise exec -- bun test --cwd apps/backend \
  --preload ../../tests/setup-node.ts ./src --parallel=2 --only-failures      # PASS (123 s)
mise run test:logged -- --name be-e04-focused -- mise exec -- bun test --cwd apps/backend \
  --preload ../../tests/setup-node.ts <10 keyed-record/display-tail/progressive/projection/
  storage-native files> --parallel=2 --only-failures                           # PASS
mise run format && mise run format:check && mise run lint                      # clean for touched files
```

### Remaining limitations

- Not run: aggregate `mise run test`, isolated real-stack/Electron restart QA
  (inactive-environment path), and the step-01 timing profile (bytes, lock wait,
  first-tail latency). Evidence is structural.
- The deletion fence is per process. A second backend sharing the data
  directory can still write a stale checkpoint after this process deletes it,
  exactly as with the previous shared-file design; the preview remains
  non-authoritative and is replaced by the provider.
- `StorageBase.enqueueNativeAgentDisplayTailMutation` is now unused but left in
  place (storage-base changes were limited to additive path helpers).
- A restored preview's deferred detail references remain hints; this step did
  not change how the projection confirms them.
