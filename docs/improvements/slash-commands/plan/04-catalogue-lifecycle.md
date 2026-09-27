# 04 — Make catalogue lifecycle authoritative and observable

Status: proposed. Dependencies: 02. [Index](00-index.md).

## Owners

`native-agent-service-base.ts`, `native-agent-service-projection.ts`,
`native-agent-service-shared.ts`, `http-bridge-catalog.ts`, provider catalogue
adapters, bridge session state, protocol projections, and
`apps/web/src/stores/nativeAgentProjectionStore.ts`.

## Preserve the existing strengths

Retain the backend cache's in-flight deduplication, invalidation guard,
stale-while-refresh behavior, 30-second baseline TTL, and bounded key count.
Keep discovery optional for transcript display. Extend the current cache value
with status/revision information rather than creating a renderer-owned cache.

## Snapshot lifecycle

1. Key authoritative inventories by environment, provider runtime generation,
   effective workspace/configuration authority, and session where applicable.
   Two sessions with different plugins/settings must not share an unqualified
   list just because their working directory matches.
2. Publish `loading` on the first request, and `ready` only after a successful
   authoritative read, including an empty result. Avoid making the first
   transcript wait for an expensive CLI probe; discovery can complete separately.
3. On expiry retain the last list as `stale` and start one bounded refresh.
   Errors retain the list and a bounded reason, with retry backoff. Never turn
   an error into authoritative `ready: []`.
4. Advance catalogue revision only for meaningful content/state changes.
   Assign execution binding revisions separately so presentation changes do
   not invalidate selected commands.
5. A provider restart changes generation. Persisted entries can be displayed
   stale, but private bindings must be reconstructed/revalidated before use.
6. Session close removes its cache/in-flight ownership. Tab unmount does not.
   Do not cancel provider work because its consumer became invisible.

## Refresh behavior

Add a command-specific refresh operation alongside the existing combined model
refresh. Register any new backend command through `createCommandRegistry()` and
carry it through authenticated gateway/IPC contracts. Reuse existing service
plumbing; do not implement direct browser-to-bridge requests.

Refresh must say whether it reloaded resources, re-read a cached provider list,
was deferred until idle, or failed. It must not claim a force reload where the
provider only supports push updates. Invalidate before initiating a replacement
read and prevent an older in-flight result from overwriting it.

Bound refresh concurrency per environment and globally. Start with a proposed
maximum of one active refresh per key and four expensive provider probes across
the service, an explicit timeout, and bounded queued refresh intents. Coalesce
repeated refresh requests; measure and adjust through synthetic tests. Keep
provider operations that cannot be interrupted handled after caller timeout;
do not leave rejected promises or orphaned probes.

## Dynamic provider updates

- Claude: consume full `commands_changed` replacement snapshots and init data.
- Codex: convert `skills/changed` into lightweight invalidation; perform I/O
  outside the stdout reader. Do not await catalogue consumers in that loop.
- Pi: publish one normalized list after attach/reload; record pending refresh
  when the SDK cannot safely reload while busy.
- Grok: retain replacement inventory and revision from ACP updates, then expose
  invalidation or reconcile freshness to the backend.
- OpenCode: use documented/qualified invalidation if present; otherwise TTL,
  explicit refresh, and configuration changes. Do not invent an event name.

Use existing revisioned projection/replay transport for updates. Reconnect must
obtain a snapshot after a revision gap or generation change. If a bridge lacks
catalogue revisions, mark its TTL snapshot accordingly and refresh on activation;
do not pretend event delivery is guaranteed.

## Bounds and liveness

Apply both row and serialized-byte bounds before retaining/rewriting provider
responses. Cap total catalogue memory across the 256-key cache, not just each
response; start with a proposed 16 MiB retained-catalogue budget and evict stale
least-recently-used entries. Keep private bindings and aliases in that budget.
Do not log names, arguments, paths, template content, or provider error dumps.

Cache refresh is a metadata operation. It must not poll `/session/:id` or
`/status`, touch `lastAccessed`, hydrate transcripts, or resume idle threads.
If a cold discovery truly needs attachment, make that an explicit foreground
operation and label the pre-attach state accurately.

## Legacy routes

Negotiate route/schema support separately from session existence. A current
bridge returning unknown-session 404 must not cause a fallback to a global
list. Use advertised route support or a cached version capability; probe a
legacy endpoint only when compatibility requires it. Test malformed success,
timeout, 401/403, 404, and 5xx separately.

Keep aliases while old clients are supported. Make legacy and current endpoints
read the same authoritative inventory wherever their scope permits; do not keep
an independent filesystem scanner as an invisible second source of truth.

## Acceptance tests

Use controlled clocks/deferred promises for expiry, concurrent refresh,
invalidation races, failure backoff, eviction, byte limits, and generation
replacement. Verify removed commands disappear through projection patches.
Start discovery, switch environment, finish/update inventory, then return and
verify snapshot freshness. Confirm metadata refresh alone never keeps an idle
Codex/Claude session attached. Cold discovery failure must leave chat usable.
