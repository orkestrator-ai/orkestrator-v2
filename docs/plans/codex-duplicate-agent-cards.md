# Fix duplicate Codex agent cards and failed spawns shown as active

Status: implemented with automated verification on 2026-09-07; isolated browser QA remains pending.
Investigation date: 2026-09-07.

## Expected outcome

A successfully spawned child has one current agent card for its launch, enriched
with its thread identity, transcript, and lifecycle updates. A rejected spawn
remains a visible failed attempt and contributes nothing to the active count.
These results must survive switching environments, reloading the renderer, and
rehydrating the bridge from authoritative state.

The reported screenshot should represent four successfully started direct
children and one failed attempt. While those four children are running, the
pinned active group should contain four cards. The failed attempt should remain
in the transcript as a failure. Do not require all five launch outcomes to stay
in one group: the existing frontend moves active and settled cards differently.

## What the investigation established

The actual saved parent session contains these spawn results:

| Task | Saved result | Screenshot |
| --- | --- | --- |
| `plan11_usage` | One successful spawn; task path returned | Two active cards |
| `plan12_policy` | One successful spawn; task path returned | Two active cards |
| `plan13_opencode` | One successful spawn; task path returned | Two active cards |
| `plan14_acp` | One successful spawn; task path returned | Two active cards |
| `plan15_simplify` | `collab spawn failed: agent thread limit reached` | One active card |

The successful outputs return objects such as
`{"task_name":"/root/plan11_usage"}`. They contain no `agent_id`.
The examined parent rollout has no `event_msg/sub_agent_activity` records to
resolve the missing IDs. Child session headers do contain child thread IDs,
parent thread IDs, and full agent paths.

The parent, its four direct children, and a child of `plan11_usage` account for
the six occupied slots when `plan15_simplify` was rejected. The screenshot's
nine active cards are therefore not evidence of nine running direct children.

A diagnostic run fed the actual parent transcript and synthetic normalized
`subagent_activity: started` items for the four successful tasks through the
existing parser and collaboration merger. It asserted five transcript cards,
nine merged cards, and nine pending cards. Each successful task appeared twice.
This reproduced the screenshot's membership and count. The synthetic activity
items were representative inputs, not a recording of that session's live wire
stream; exact frame timing and ordering were not captured.

The existing focused tests for `subagent-transcript`,
`subagent-transcript-parts`, and `codex-collaboration` passed during the
investigation. That establishes a missing regression case, not correctness of
the current behavior.

## Relevant code

All bridge paths below are relative to `bridges/codex-bridge/src/`.

| File / function | Responsibility and relevant gap |
| --- | --- |
| [`app-server/item-adapter.ts`](../../bridges/codex-bridge/src/app-server/item-adapter.ts), `subAgentActivity` branch | Already retains activity kind, thread ID, and full agent path. |
| [`subagent-transcript.ts`](../../bridges/codex-bridge/src/subagent-transcript.ts), `deriveSubagentPartsFromTranscriptRecords` | Creates a launch record for every spawn, but does not retain the returned task path or classify the observed plain-text rejection. |
| [`subagent-transcript.ts`](../../bridges/codex-bridge/src/subagent-transcript.ts), `parseSubAgentActivityRecords` | Resolves IDs from saved activity records; these records were absent in the affected parent. |
| [`subagent-transcript-parts.ts`](../../bridges/codex-bridge/src/subagent-transcript-parts.ts), `deriveTranscriptSubagentPartsForTurn` | Resolves IDs, scopes launches to assistant rows, and loads child transcripts. It needs identity evidence from live activity too. |
| [`codex-collaboration.ts`](../../bridges/codex-bridge/src/codex-collaboration.ts), `getCodexSpawnedAgentIdsInOrder` | Supplies fallbacks from native collaboration spawn items, excluding standalone activity items. |
| [`codex-collaboration.ts`](../../bridges/codex-bridge/src/codex-collaboration.ts), `applyCodexCollabStateToSubagentParts` | Matches anonymous transcript cards in the native-spawn loop, then appends unmatched activity identities. Activity-only inputs bypass that matching loop. |
| [`codex-collaboration.ts`](../../bridges/codex-bridge/src/codex-collaboration.ts), `reconcileCodexSubagentTimeline` | Retains occurrences and removes entries absent from a successful snapshot. It cannot infer that an anonymous card and an identified card are the same launch. |
| [`messages/render-turn.ts`](../../bridges/codex-bridge/src/messages/render-turn.ts), `loadSubagentPartsFromTranscripts` | Composes identity resolution, hydration, and lifecycle reconciliation. Also explicitly copies fields into normalized parts. |
| [`history/rollout.ts`](../../bridges/codex-bridge/src/history/rollout.ts) | Provides bounded header reads and cached transcript lookup. Existing exported metadata does not expose parent/agent-path fields. |
| [`native-agent-pinning.ts`](../../apps/web/src/lib/chat/native-agent-pinning.ts) | Moves cards into their visible positions; fixing grouping alone would leave bridge snapshots incorrect. |

There are two independent defects. Matching identities removes the four extra
cards. Recognizing the rejection removes the fifth attempt from the active
count. Fixing only one leaves the screenshot incorrect.

## 1. Add a regression fixture before changing behavior

Use a small synthetic fixture committed with the tests. Do not copy the user's
rollout, prompts, encrypted message envelopes, credentials, or absolute paths.

The fixture needs five `response_item/function_call` records named
`spawn_agent`, with unique `call_id` values and distinct `task_name` arguments.
Supply four corresponding outputs containing full task paths and a fifth
containing exactly the observed plain-text rejection. Deliberately omit saved
`sub_agent_activity` records and native `collab_tool_call` spawn items. Those
omissions are what make this a regression test for this incident.

Provide four normalized live items of this shape, with synthetic identifiers:

```typescript
{
  id: "activity-review",
  type: "subagent_activity",
  activity: "started",
  agent_thread_id: "child-review",
  agent_path: "/root/review",
}
```

Exercise `loadSubagentPartsFromTranscripts` with the real derivation and merger,
injecting only metadata/transcript I/O. A unit test that injects already-correct
subagent parts into `renderTurn` will miss the broken composition.

Assert the desired result: four identified child cards, one failed attempt, and
four pending cards while the children are running. Assert each successful
launch is represented exactly once and the rejection explanation remains
visible. Use deliberately different call and activity IDs so the fixture does
not accidentally assume those identifiers are equal.

## 2. Preserve launch identity before converting to display parts

Introduce a small bridge-internal launch model, either alongside the current
`SpawnedSubagent` or in a focused helper module. Suggested fields are:

```typescript
interface SpawnIdentity {
  parentThreadId: string;
  callId: string;
  returnedAgentPath?: string;
  agentThreadId?: string;
  spawnFailure?: "agent-limit";
}
```

This is a proposed internal shape, not an existing API. Keep task labels and
prompts in the existing display model. Preserve enough association with the
owning assistant segment to avoid assigning another segment's launch to it.

Use the full `task_name` from a successful output as the canonical path when
available. The requested short name, role, nickname, and rendered card title
are labels; none establishes unique identity. `/root/review` and
`/root/plan11/review` must remain different children.

A spawn attempt and a child thread are related but different identities. A
failed attempt has a call ID and no child ID. A child can receive follow-up
work in a later turn. Preserve both concepts so later interactions do not
erase failed attempts or collapse legitimate historical references.

Do not place a fabricated path or call ID in `subagentId`: downstream code
uses that field as a real child identity. If a stable pre-spawn card key is
needed, carry an explicit internal launch key or use an existing suitable call
identity field and test its consumers.

## 3. Resolve live activity identities before child hydration

At the loader boundary, build a scoped index of normalized activity items by
full agent path and actual thread ID. Pass this evidence to
`deriveTranscriptSubagentPartsForTurn` before it selects child transcripts.
Resolving IDs only in the final merger fixes a card count but leaves that
probe unable to load the child's transcript.

For each launch, use existing explicit thread IDs and verified call-linked
evidence first. If those are absent, match its returned full task path against
activity evidence belonging to the same parent thread. Require an unambiguous
match. Evidence with conflicting thread IDs must be reconciled against an
authoritative source rather than resolved by map insertion order.

Do not assume a live activity item's `id` equals the original spawn `call_id`.
The existing saved-activity parser relies on a call association for its
`event_id`; the normalized live activity shape alone does not establish the
same association. An implementation that wants to use that relationship must
first verify it with a suitable contract fixture.

Keep the existing positional fallback only within its current one-to-one
ownership safeguards. Do not zip activity items against spawn calls. Failed
spawns have no activity, children can emit many beats, and activity can arrive
out of order.

After successful identity resolution:

1. Attach the real thread ID to the launch.
2. Add that ID to the selected child-transcript requests, deduplicated by ID.
3. Hydrate that child's transcript through the existing cached loader.
4. Derive one enriched part for the launch.
5. Apply lifecycle evidence to that part before considering orphan cards.

An unmatched activity record can still justify an orphan card: collaboration
wrappers and references to earlier children are already supported. Append one
only after all available identity matching has run. Preserve ambiguity rather
than merging two unrelated children because their display labels happen to
match.

## 4. Preserve assistant-row ownership and handle timing races

Keep ownership separate from identity discovery. Live activity can help identify
a child without proving that the current assistant row originally spawned it.
Simply adding every activity ID to `ownedSubagentIds` would move cards across
steered rows and can cause one launch to appear in multiple rows.

Use exact spawn ownership where available. Preserve the current time-window
fallback where item ownership cannot identify every spawn. Resolve identities
before applying an ownership filter that would otherwise discard unresolved
launches. Explicitly failed receiver-less launches must also survive filtering;
an ID-only selection must not silently erase their failure cards.

`renderTurn` awaits transcript I/O and then takes a fresh item snapshot. Keep
that behavior. If an activity arrives during the probe, either reconcile its
identity against the existing launch before publishing or defer its unmatched
addition until the next authoritative probe. Do not briefly publish both forms
and rely on the next render to hide the extra card.

Test both directions: activity before the spawn output, and spawn output before
activity. When the identity becomes known, replace/enrich the earlier launch
representation. A successful snapshot must remove obsolete anonymous timeline
entries and fingerprints. Preserve the last successful snapshot on I/O failure,
as the current renderer does.

## 5. Make failed spawn results terminal

Parse spawn results through a dedicated result classifier before the existing
JSON-only extraction of `agent_id` and `nickname`.

Support the observed exact rejection:

```text
collab spawn failed: agent thread limit reached
```

Classify it as an explicit failed launch. Keep the classifier narrow: arbitrary
non-JSON output, truncated JSON, a missing response, and unrelated text are
unknown outcomes, not proof of failure or success. Extend structured error
handling only for shapes established by fixtures or the pinned protocol.

Keep spawn outcome separate from child execution outcome. A successful spawn
means a child exists; it does not mean the child's work completed. An explicit
spawn rejection with no child produces `toolState: "failure"` and must never
receive another launch's ID through positional fallback. If later evidence
contradicts the rejection for the same call, surface/reconcile that inconsistency
rather than silently attaching an arbitrary child.

Use a bounded, fixed user-facing explanation such as
"Agent could not start: agent limit reached." The existing subagent card
renders `subagentActions`, so a text action is a suitable minimal carrier for
the explanation. Do not claim it is an action performed by a child: retain a
tool/action count of zero where that count describes actual child work.

If using `toolError` instead, verify that the explicit mapping in
`loadSubagentPartsFromTranscripts`, the normalized transport, projection, and
subagent renderer all preserve and display it. Adding that field only to the
parser will not make it visible.

The rejected attempt must remain terminal during repeated probes, reloads, and
unrelated activity updates. Do not retry it automatically. A new user-authorized
attempt is a separate call with its own outcome.

## 6. Make the identity match recoverable after restart

Renderer unmount must not destroy identity information. Keep reconciliation in
the bridge and use authoritative snapshots for returning tabs. A renderer-side
map of labels to IDs cannot satisfy this requirement.

Verify whether a fresh `thread/read` snapshot for the pinned app-server retains
the required activity identities. Do not assume it does: the incident's saved
parent rollout lacks the corresponding activity records. Test bridge restart
separately from browser reload; the latter can succeed using surviving bridge
memory and conceal a recovery defect.

For the observed disk-only case, implement a fallback using child session
headers. Read `source.subagent.thread_spawn.parent_thread_id` and `agent_path`
alongside the header's thread ID, and match the same parent plus full task path.
The current `PersistedSessionMeta` interface does not expose these fields, so
extend a suitable metadata representation or add a dedicated child-identity
index. Do not assume `loadSessionMeta` already supports path-based lookup.

Use `readTranscriptHead` and existing catalog/cache patterns. Never read all
rollout bodies to discover children, and never repeat a full catalog walk for
each card or each streaming render. Add explicit entry/count and byte bounds,
bounded scan concurrency, cache invalidation for new child files, and isolation
by Codex home. A bounded or incomplete scan is unknown evidence; it must not
delete a known child or establish a unique match without sufficient coverage.

Scope full transcript reads to children selected for hydration. Keep this work
off app-server's stdout read loop. Preserve the existing probe throttling and
final authoritative probe. Do not introduce polling of tab-facing session/status
routes from a background reconciler; those routes affect liveness and detaching.

Existing sessions should repair themselves on authoritative rehydration. Do not
edit the user's rollout files, clear their conversation, or delete child threads.

## 7. Preserve existing lifecycle and timeline behavior

The current merger distinguishes authoritative statuses from weak activity
hints. Preserve those semantics while changing identity matching:

- A `started` activity must not overwrite a newer terminal child transcript.
- A terminal activity may settle an otherwise pending child when stronger
  evidence is absent.
- Queue-only `send_message` activity must not automatically reopen a child.
- Actual follow-up work can reopen a child that finished an earlier task.
- Repeated probes must not append the same final message repeatedly.

The timeline tests deliberately preserve duplicate anonymous and identified
occurrences. Do not replace that behavior with a global `Set(subagentId)` or a
filter by task name. Fix the source merge that generated the redundant launch
representation. If a timeline contract genuinely needs changing, explicitly
distinguish duplicate evidence for one launch from separate historical
references to a reusable child, and retain coverage for both.

## Regression test matrix

| Scenario | Required assertion | Primary test owner |
| --- | --- | --- |
| Four path-only successes, one rejection, activity-only live inputs | Four identified pending children; one failure; no duplicated launch cards | Loader / render integration |
| Failure text with no native collaboration item | Failure is visible and excluded from active count | Transcript parser |
| Missing output, malformed JSON, unrelated plain text | No invented terminal outcome or child identity | Transcript parser |
| Failed launch between two successes | Subsequent activity IDs attach to the correct successful calls | Identity resolver / loader |
| Two nested agents both named `review` | Different full paths remain distinct | Identity resolver |
| Same full path under different parent threads | Parent scoping prevents cross-session assignment | Identity resolver / metadata |
| Conflicting IDs for a candidate path | No arbitrary match or destructive deduplication | Identity resolver |
| Repeated activity beats for one child | One launch card with the latest supported status | Collaboration merger |
| Activity before output and output before activity | Existing card is enriched without a duplicate publication | Render integration |
| Activity arrives while transcript I/O is pending | No mixed old/new snapshot creates duplicate cards | Render integration |
| Steer splits a turn around a spawn | Card stays with its owner; failed attempts are not filtered out | Transcript loader / render integration |
| Child transcript appears after a negative lookup | The final authoritative probe retries once and hydrates it; streaming probes do not rescan | Metadata / loader |
| New bridge state, no saved parent activity | Child headers recover identity and transcript | Metadata / hydration integration |
| Reload and inactive environment completion | Correct membership, terminal status, and available controls | Runtime / browser |
| Follow-up after completion; queue-only message | Existing lifecycle semantics remain intact | Collaboration merger |

Add new focused test files if needed. `subagent-transcript.test.ts` is already
large; follow the repository guidance to keep new helpers and their tests
cohesive instead of growing another oversized file.

## Verification commands and browser procedure

Run commands from the repository root. These commands were used to verify the
implementation. Use `test:logged` for tests, typechecks, build checks, and smoke
suites.

Start with the owning files and add any new resolver/failure test paths:

```bash
mise run test:logged --name codex-agent-cards -- bun test bridges/codex-bridge/src/subagent-transcript.test.ts bridges/codex-bridge/src/subagent-transcript-parts.test.ts bridges/codex-bridge/src/codex-collaboration.test.ts bridges/codex-bridge/src/messages/render-turn.test.ts --parallel=2 --only-failures
mise run test:logged --name codex-bridge-typecheck -- bun run --cwd bridges/codex-bridge typecheck
mise run test:logged --name web-typecheck -- bun run --cwd apps/web typecheck
mise run format:check
mise run lint
```

If the fix changes rollout metadata, include its tests. If it changes backend
projection or runtime hydration, add the owning tests and backend typecheck.
Complete the relevant checks before browser QA. Use the logged runner's exit
status and saved failure artifact, not truncated terminal output, to assess
results.

Follow [the isolated testing reference](../development/agent-testing.md) and
the current root `AGENTS.md`. Start a unique fixture profile, for example:

```bash
mise run dev:test --profile agent-codex-card-dedup --fixture --credential-source codex --agent-platforms codex
mise run dev:status --profile agent-codex-card-dedup --json
mise run dev:login --profile agent-codex-card-dedup --json
```

The startup command supervises a long-running stack; run status/login from a
second session. Use the returned browser URL and single-use login URL. Verify
the DEV profile identity. Use only the returned fixture project.

For the browser scenario, use bounded synthetic fixture work that launches
distinct children. Exercise the rejected-at-capacity case in that isolated
profile or through a deterministic scenario supported by the test harness.
Do not assume a particular slot limit across versions; observe the configured
limit. Stop all fixture work when the scenario is complete.

Verify one card per successful child, a visible failed attempt, and an active
count that excludes the failure. Expand a successful child and check its
available transcript loads. Switch to another environment/tab while work
finishes, return, and verify status, transcript, and controls. Reload and check
again. Restart the isolated stack and reopen the session to exercise cold
identity recovery. Terminal children must not return to permanent spinners.

Keep screenshots and test artifacts free of real prompts, files, credentials,
and terminal contents. Prefer synthetic task labels and structural assertions.
Do not launch a production session to manufacture the failure.

After verification:

```bash
mise run dev:stop --profile agent-codex-card-dedup
mise run dev:reset --profile agent-codex-card-dedup
```

Confirm the profile has stopped and its state was reset. Report any deliberately
retained fixture state. For broad runtime/projection changes, follow the root
minimum-verification table and run the complete suite through the logged wrapper
around `mise run test`; never use bare root-level `bun test`.

## Completion checklist

- [x] The regression fixture fails on the old implementation and passes on the fix.
- [x] Activity-only live items resolve path-only spawn outputs before hydration.
- [x] Four real children produce four current launch cards in the reported case.
- [x] The rejected fifth attempt displays a failure and never counts as active.
- [x] Error explanations survive normalization and are available on the failed card.
- [x] Matching uses parent/call/path/thread evidence; equal labels do not merge children.
- [x] Failed attempts survive assistant-row ownership filtering.
- [x] Late events and repeated probes cannot leave obsolete anonymous cards behind.
- [x] Automated rehydration coverage exercises fresh render state and persisted bridge state.
- [x] Metadata discovery uses bounded header reads and bounded caches off the stdout loop.
- [x] Existing follow-up, terminal-status, and historical-reference tests still pass.
- [ ] The isolated browser workflow passes for inactive tabs, reload, and bridge restart.
- [x] User rollouts and production sessions are unchanged.

Prepare the implementation on a feature branch and submit it for human review.
Follow the repository policy: never push directly to `main` or merge the pull
request yourself.
