# Codebase inconsistency review

Reviewed: 2026-09-21  
Revision: `88c2f9ccfaa68045573b658dd4f172bc5ff7c51b`  
Status: Findings only; no application changes made.

## Scope and interpretation

This review compared shared protocol contracts with their backend, bridge, and
renderer implementations. It also inspected configuration defaults, platform
registration, tab teardown, package/task configuration, and the documentation
catalog. The most consequential inconsistencies found are in session lifecycle
and persistence behavior between the Cursor and Pi bridges.

This is a targeted cross-cutting review, not a claim that every file or runtime
path was audited. Findings below distinguish deterministic fixture observations
from source-level conclusions and product decisions. The execution probes used
synthetic state and fake agents, rather than starting live provider turns or
operating on production sessions.

The existing [platform inventory](../architecture/platform-inconsistencies.md)
is explicitly historical. Findings here were checked against the current
implementation, rather than treating that inventory as an outstanding backlog.
Intentional differences, such as Pi's provider/model identifiers, OpenCode's
execution profiles, and provider-specific capabilities, are not defects merely
because they differ.

Priority meanings: **P1** risks untracked execution or loss of recovery state;
**P2** is a functional or reliability inconsistency; **P3** is a lower-impact
contract inconsistency.

## Findings at a glance

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| INC-01 | P1 | Cursor's dispatch durability barrier does not guarantee a durable journal | Source trace and filesystem failure probe |
| INC-02 | P1 | Cursor can start a prompt after its session has been deleted | Router probe with a deferred attach |
| INC-03 | P1 | Cursor silently stops persisting all sessions above the aggregate state-file limit | Filesystem probe |
| INC-04 | P2 | Cursor acknowledges newly created sessions without persisting them | Source trace |
| INC-05 | P2 | Pi loses cancellation requests received before its cancel handle exists | Router probe and source trace |
| INC-06 | P2 | Draft restoration drops supported Cursor and Grok image attachments | Capability and renderer source trace |
| INC-07 | P2 | Cursor's steer journal is unbounded while comparable journals are bounded | Router probe and source trace |
| INC-08 | P2 | Closing a tab preserves or deletes conversation history depending on provider | Source trace; product decision required |
| INC-09 | P3 | Pi and Cursor interpret malformed transcript cursors differently | Direct parser probe |

## INC-01 — Cursor's dispatch durability barrier does not guarantee durability

**Locations**

- [Cursor persistence](../../bridges/cursor-bridge/src/persistence.ts#L40),
  lines 40–57: `schedulePersist` and `persistBarrier`.
- [Cursor prompt route](../../bridges/cursor-bridge/src/http.ts#L674),
  lines 674–733: preparation through SDK dispatch.
- [Cursor steer route](../../bridges/cursor-bridge/src/http.ts#L486),
  lines 486–514: journal barriers around `run.steer`.
- [Pi persistence](../../bridges/pi-bridge/src/persistence.ts#L53),
  lines 53–70, and [Pi prompt route](../../bridges/pi-bridge/src/http.ts#L917),
  lines 917–922: the contrasting implementation.

**Inconsistency.** Cursor's `persistBarrier()` schedules a best-effort write and
awaits `tail`, but that tail already catches and suppresses write failures.
Consequently, a fulfilled barrier does not establish that anything reached disk.
The prompt route has a second gap: it records `prepared` and schedules
persistence, then calls `dispatchPrompt` without awaiting a barrier at all.
The steer route does await the barrier, but inherits its suppressed failures.

Pi explicitly chains a new write behind the persistence queue, propagates its
failure to the caller, and awaits it before sending a prompt. These are different
guarantees behind the same at-most-once session contract.

**Observed evidence.** An isolated probe set each bridge's state directory to a
regular temporary file, making creation of `state.json` impossible. Cursor's
barrier resolved; Pi's rejected. This exercised the real persistence modules.

**Impact.** A crash after provider acceptance but before journal publication can
leave no bridge-owned evidence of dispatch. Steer replay then cannot rely on the
local journal to prevent duplicate delivery. Prompt dispatch does pass an SDK
`idempotencyKey`, which may mitigate duplication at the provider layer; this
review did not establish the vendor's retention or restart guarantees. That
mitigation does not make Cursor's local durability claim true.

**Recommended change.** Separate best-effort transcript writes from mandatory
journal publication. Make the barrier reject on publication failure and await it
before both prompt and steer dispatch. Keep uncertain outcomes uncertain rather
than inferring that an absent journal means work never ran.

**Regression coverage.** Hold a state write pending and assert the provider has
not received the prompt. Then inject a write failure and assert neither prompt
nor steer is sent. Reload the last published file to verify that any operation
allowed to reach the provider already has a recoverable prepared record.

## INC-02 — Cursor can start a prompt after session deletion succeeds

**Locations**

- [Cursor DELETE handler](../../bridges/cursor-bridge/src/http.ts#L550),
  lines 550–557.
- [Cursor attachment](../../bridges/cursor-bridge/src/agent-session.ts#L164),
  lines 164–172, and attachment completion around lines 342–367.
- [Cursor detachment](../../bridges/cursor-bridge/src/agent-session.ts#L487),
  lines 487–502.
- [Pi permanent close](../../bridges/pi-bridge/src/agent-session.ts#L730),
  lines 730–742, with closed-session checks at lines 303 and 495.

**Inconsistency.** Cursor DELETE calls `detachAgent`, which releases the agent
currently stored in `state.agent`, and then removes the session. It neither
marks the state permanently closed nor waits for `state.attaching`. A pending
attach can subsequently install its agent on the removed state, and a prompt
already awaiting that attach continues into `dispatchPrompt`.

Pi has a separate permanent-close path: it marks the session before awaiting
the shared attach, and late attachment checks the mark and disposes its result.
That distinction is absent from Cursor, where idle detachment and permanent
deletion use the same primitive.

**Observed evidence.** A probe used the real Cursor router and the repository's
fake agent, with a deferred `state.attaching` promise:

1. Start a prompt and wait until it claims dispatch.
2. DELETE the session while attachment is pending.
3. Receive HTTP 200 for DELETE, then release the attach.
4. The original prompt returns HTTP 202 and calls the fake agent's `send` once.

At the end, the session is absent from `sessions`, but its detached state object
holds an attached agent. No live SDK execution was needed to demonstrate this.

**Impact.** Closing a tab during startup can allow work to begin after teardown
has succeeded. Activity polling and idle cleanup cannot find that session in the
registry, so execution and resources can outlive their visible owner.

**Recommended change.** Introduce a permanent-close marker/generation, set it
before the first await, and reject dispatch after closure. Dispose late attach
results and coordinate deletion with any in-flight dispatch claim. Keep ordinary
idle detachment resumable.

**Regression coverage.** Add the sequence above to Cursor's HTTP tests and assert
zero sends, disposal of any late agent, no retained client key, and no background
activity after successful deletion. Also cover deletion while `send` is pending.

## INC-03 — Cursor silently stops persisting above the aggregate file limit

**Locations**

- [Cursor serialization](../../bridges/cursor-bridge/src/persistence.ts#L67),
  lines 67–84.
- [Cursor limits](../../bridges/cursor-bridge/src/config.ts#L133),
  lines 133–151: roughly 16 MiB per transcript versus 32 MiB for all state.
- [Pi aggregate shedding](../../bridges/pi-bridge/src/persistence.ts#L85),
  lines 85–145.

**Inconsistency.** Cursor bounds individual transcripts, but serializes every
session into one state file. If that aggregate exceeds 32 MiB, `persistNow`
simply returns. Trimming each session to its own limit does not guarantee that
the aggregate fits, so the comment promising a later trimmed write is not a
recovery mechanism.

Pi handles the same condition by shedding persisted transcript copies in
oldest-access order while retaining session pointers and journals. If even the
essential state cannot fit, Pi throws so a durability-dependent caller cannot
proceed under a false assumption.

**Observed evidence.** After publishing an empty Cursor state file, a probe added
three synthetic sessions with 12 MiB of text each, individually below the
transcript byte limit. `persistBarrier()` resolved, but the file remained
byte-for-byte identical to the empty baseline.

**Impact.** Several large conversations can stop persistence for every session,
including small or newly created ones. Journal changes, session mappings, and
composer changes remain stale on disk until the aggregate shrinks. A restart
restores the old snapshot; the provider's own conversation store may survive,
but the bridge state needed to recover it consistently does not.

**Recommended change.** Apply an aggregate persistence budget that preserves
recovery metadata and dispatch records. Shed reconstructible transcript data or
store sessions separately. Report failure when mandatory state cannot fit.

**Regression coverage.** Persist several individually valid large sessions, add
a small session and journal record, then restart. Assert that essential records
survive and any transcript shedding is explicitly represented. Test a payload
whose non-transcript metadata alone exceeds the limit as well.

## INC-04 — Cursor acknowledges newly created sessions without persisting them

**Locations**

- [Cursor session creation](../../bridges/cursor-bridge/src/agent-session.ts#L116),
  lines 116–154.
- [Cursor create response](../../bridges/cursor-bridge/src/http.ts#L189),
  lines 189–223.
- [Pi create response](../../bridges/pi-bridge/src/http.ts#L260),
  lines 260–265.

**Inconsistency.** Cursor's normal creation path populates `sessions` and
`clientSessionKeys` and returns HTTP 201 without scheduling a write. The nearby
`schedulePersist()` is conditional on changing an existing session's read-only
boundary; it is not persistence for a normal new session. A later attach,
prompt, unrelated write, or graceful shutdown may eventually save it.

Pi awaits a persistence barrier before acknowledging creation because the
backend stores the returned provider session ID immediately.

**Impact.** If Cursor's bridge dies after acknowledging creation and before a
later write, the backend can retain a provider session mapping that the bridge
cannot reload. Pre-send selections and client-key idempotency are also lost.
This is distinct from INC-01: it affects an acknowledged session even when no
prompt has been dispatched.

**Recommended change.** Publish the session and client-key mapping before
returning 201, using the corrected mandatory barrier from INC-01. Apply the same
acknowledgement rule to resume and attachment identity changes where appropriate.

**Regression coverage.** Create an otherwise unused session with a configured
state directory, reload only the published state without calling the graceful
shutdown flush, and verify that the same client key resolves to the same ID and
composer selection.

## INC-05 — Pi drops cancellation received before a cancel handle exists

**Locations**

- [Pi cancellation](../../bridges/pi-bridge/src/http.ts#L614), lines 614–624.
- [Pi prompt acceptance](../../bridges/pi-bridge/src/prompt.ts#L120),
  lines 120–138: `cancelTurn` is installed after preflight acceptance.
- [Cursor cancellation](../../bridges/cursor-bridge/src/http.ts#L586),
  lines 586–605, and [deferred cancellation](../../bridges/cursor-bridge/src/prompt.ts#L155).

**Inconsistency.** During cold attachment or prompt preflight, Pi can own an
in-progress prompt while `state.cancelTurn` is still unset. Its cancel handler
answers `{ cancelled: false }` and records no pending cancellation. Once
startup finishes, the prompt proceeds normally.

Cursor explicitly records `pendingCancelPromptSequence` in that window,
returns HTTP 202 with `pending: true`, and applies the cancellation when the run
handle becomes available.

**Observed evidence.** A router probe seeded the pre-handle state
(`status: "running"`, `dispatching: true`, no cancel handle). Pi returned HTTP
200 with `cancelled: false`; Cursor returned HTTP 202 and retained the target
prompt sequence. The source trace confirms that Pi has no later cancellation
application step corresponding to Cursor's.

**Impact.** An interruption during slow startup is ineffective in Pi. The user
may need to interrupt again after startup, or rely on a caller's separate
hard-stop escalation. This finding does not imply that every higher-level stop
workflow lacks such escalation.

**Recommended change.** Retain cancellation against the claimed turn before
startup/preflight completes, and consume it as soon as abort is possible. Clear
it on failure or completion so it cannot stop a subsequent turn.

**Regression coverage.** Hold both cold attachment and preflight separately;
cancel in each window, release it, and verify the intended turn stops. A later
turn must run normally. Retain the existing fail-closed approval behavior.

## INC-06 — Draft restoration discards supported Cursor and Grok images

**Locations**

- [Attachment capability table](../../packages/protocol/src/native-agent.ts#L650),
  lines 650–655: Cursor and Grok support images but not files.
- [Draft attachment validator](../../apps/web/src/hooks/useNativeComposeDraftPersistence.ts#L74),
  lines 74–87: both platforms unconditionally return `false`.
- [Draft hydration and save](../../apps/web/src/hooks/useNativeComposeDraftPersistence.ts#L253),
  lines 253–290.
- [Assigned native-tab persistence](../../apps/web/src/components/native-agent/AgentNativeTab.controller.tsx#L430).
- [Existing draft tests](../../apps/web/src/lib/draft-persistence.test.ts#L1218)
  and the platform test loop at line 1530.

**Inconsistency.** The shared capability table allows image attachments for both
platforms, and the composer uses those capabilities when accepting attachments.
The persistence hook instead uses an older platform-specific rule that rejects
every Cursor/Grok attachment, including a well-formed image.

The problem also affects an unassigned `agent-native` draft whose saved metadata
selects Cursor or Grok: `effectiveAttachmentNamespace` routes it through the same
rejection. Hydration subsequently schedules a save, so the filtered draft can
replace the saved attachment list.

**Impact.** A user can attach a supported image and see it disappear after a
fresh renderer load. Ordinary visibility changes may retain the in-memory
draft, which can conceal the problem until a restart or true rehydration.

**Recommended change.** Derive persisted attachment eligibility from the shared
capability table while retaining structural validation. Image-only platforms
must preserve images and reject files consistently across selection, save,
restore, and dispatch.

**Regression coverage.** Round-trip an image draft for assigned Cursor/Grok tabs
and for `agent-native` metadata selecting each platform. Verify both the
rehydrated attachments and the next persisted value. Existing tests cover
Codex and Pi restoration but do not exercise this Cursor/Grok case.

## INC-07 — Cursor's steer journal has no retention bound

**Locations**

- [Cursor steer insertion](../../bridges/cursor-bridge/src/http.ts#L486),
  lines 486–530.
- [Cursor journal restoration](../../bridges/cursor-bridge/src/persistence.ts#L187),
  lines 187–202.
- [Cursor bounded prompt journal](../../bridges/cursor-bridge/src/prompt.ts#L860).
- [Pi bounded steer journal](../../bridges/pi-bridge/src/state.ts#L382),
  lines 382–390, and [its limit](../../bridges/pi-bridge/src/config.ts#L117).

**Inconsistency.** Cursor inserts steer records directly into a `Map`, persists
all records, and reloads all records without pruning. Its prompt journal is
bounded at 256 entries. Pi applies an equivalent 256-entry bound to steering
through `setSteerJournal`.

**Observed evidence.** A real-router probe with a fake active run sent 300
successful steer requests with distinct IDs. Cursor retained 300 entries. The
write and restore paths contain no count, age, or total-byte eviction policy.

**Impact.** A long-lived session accumulates records indefinitely, increasing
retained memory and the cost of every whole-file persist. Eventually this can
contribute to the global persistence failure in INC-03. Restarting does not
reset the accumulation because the journal is restored.

**Recommended change.** Define explicit byte/count bounds and use one insertion
helper for live writes and hydration. Retention must preserve uncertainty for
evicted request IDs; eviction must not become evidence that an old steer never
ran. Avoid evicting a still-pending operation without an explicit policy.

**Regression coverage.** Exceed the retention bound, persist and reload, and
check that both states remain bounded. Probe an evicted request and verify it
is treated as unknown rather than safe to replay.

## INC-08 — Closing a tab has inconsistent conversation-retention semantics

**Locations**

- [Shared tab teardown](../../apps/backend/src/core/commands-registry-teardown.ts#L181),
  lines 181–220: sends DELETE to the provider session route.
- [Claude durable deletion](../../bridges/claude-bridge/src/services/session-manager-persistence.ts#L622),
  particularly lines 651–657: invokes the SDK's `deleteSession` when available.
- [Cursor close contract](../../bridges/cursor-bridge/src/http.ts#L535),
  lines 535–557: deliberately preserves the SDK conversation.
- [Pi close contract](../../bridges/pi-bridge/src/http.ts#L547),
  lines 547–582: preserves the Pi JSONL conversation.
- [Codex session deletion](../../bridges/codex-bridge/src/app-server-runtime-sessions.ts#L1346)
  and [thread release](../../bridges/codex-bridge/src/engine/app-server-engine.ts#L1553):
  unsubscribe without `thread/delete`.

**Inconsistency.** The common tab-close workflow calls the same-looking session
DELETE operation, but that operation has materially different meanings. Claude
can delete the underlying vendor conversation; Cursor, Pi, and Codex release
bridge/runtime ownership while preserving conversation history. OpenCode's
teardown also targets its provider session DELETE endpoint; its external storage
behavior was not independently exercised in this review.

**Impact.** The ability to resume after closing a tab depends on the selected
platform. The discrepancy affects user data, not just implementation details.
It also makes a shared lifecycle method named DELETE too ambiguous to establish
a consistent retention policy.

**Classification.** This is a verified product-semantic difference, not proof
that the current deletion policy was unintended. It was also noted in the older
inventory and remains present in the current source. A product decision is
needed before changing it.

**Recommended change.** Define separate operations for closing/detaching a tab
and permanently deleting a conversation. Either make ordinary close retain
history across providers or expose the destructive difference explicitly before
the action. Keep permanent deletion an intentional user choice.

**Regression coverage.** Run the same create → complete a turn → close tab →
list resumable sessions flow for every provider. Assert the chosen retention
policy and separately exercise intentional permanent deletion.

## INC-09 — Transcript cursor parsing differs across equivalent routes

**Locations**

- [Pi `parseFromIndex`](../../bridges/pi-bridge/src/public.ts#L110), lines 110–114.
- [Cursor `parseFromIndex`](../../bridges/cursor-bridge/src/public.ts#L82), lines 82–85.

**Inconsistency.** Pi uses `Number.parseInt` and `Number.isInteger`; Cursor uses
`Number` and `Number.isSafeInteger`. Pi therefore accepts numeric prefixes,
truncates fractions, and accepts rounded values beyond the safe integer range.
The routes otherwise expose the same incremental message-window concept.

**Observed evidence.** Direct calls into the real parser functions returned:

| Input | Pi | Cursor |
| --- | --- | --- |
| `12junk` | `12` | `null` |
| `1.5` | `1` | `null` |
| `9007199254740993` | `9007199254740992` | `null` |

**Impact.** A malformed cursor can silently select a partial or empty message
window on Pi while causing a full-window fallback on Cursor. Correct callers
that send safe nonnegative integers are unaffected; this is primarily contract
hardening, not evidence of a normal UI failure.

**Recommended change.** Share a strict safe-nonnegative-integer parser and define
the same malformed-input behavior for all bridge routes. Preserve the existing
authoritative reconciliation behavior when a cursor cannot be used.

**Regression coverage.** Test fractions, suffixes, negatives, empty strings,
exponent notation, unsafe integers, and valid zero/positive cursors against a
single expected contract for every provider.

## Validation performed

The following existing suites passed without application or test modifications:

```sh
mise run test:logged -- --name inconsistency-bridge-checks -- \
  bun test ./bridges/cursor-bridge/src/http.test.ts \
  ./bridges/cursor-bridge/src/persistence.test.ts \
  ./bridges/pi-bridge/src/http.test.ts \
  ./bridges/pi-bridge/src/persistence.test.ts --parallel=2 --only-failures

mise run test:logged -- --name inconsistency-draft-checks -- \
  bun test --cwd apps/web ./src/lib/draft-persistence.test.ts \
  --parallel=1 --only-failures
```

The bridge check completed in 4.6 seconds; the draft check in 4.0 seconds.
Passing tests do not disprove these findings: the identified cross-platform
cases are not asserted by the passing paths inspected here.

Additional temporary probes, outside the repository, exercised real persistence
modules, the HTTP routers on ephemeral loopback ports, and direct parser calls.
They used synthetic records and a fake agent. Their observed results are recorded
under INC-01, INC-02, INC-03, INC-05, INC-07, and INC-09. The probes cleaned up
their temporary state and servers. They are investigative evidence, not committed
regression tests or live-provider validation.

`mise run test` also passed all four groups: workspace packages, root and
agent-support tests, all bridges, and the Codex protocol lockfile check. Total
reported elapsed time was 461.1 seconds, including host-capacity queue waits.
This establishes a passing existing-suite baseline; it does not supply the
missing regression cases proposed in these findings.

No isolated browser, Docker, Electron, iOS, or live-provider validation was run.
Renderer findings are source-level conclusions, not claimed end-to-end UI
reproductions. Suggested regression coverage above is future work.

## Suggested implementation order

1. Fix mandatory persistence and aggregate state budgeting together
   (INC-01 and INC-03), then use the corrected barrier for creation (INC-04).
2. Fix permanent-close ownership and startup cancellation (INC-02 and INC-05).
3. Correct image draft restoration and bound steer history (INC-06 and INC-07).
4. Agree on close-versus-delete semantics before changing provider behavior
   (INC-08), and consolidate cursor validation (INC-09).

The recurring maintenance issue is that similar bridges have independently
evolved fixes for the same contracts. A shared conformance suite for creation,
dispatch durability, cancellation, deletion, and bounded recovery state would
catch this drift without requiring the provider engines themselves to be merged.
