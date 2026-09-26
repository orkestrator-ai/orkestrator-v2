# 04 — Persist session identity before acknowledging lifecycle changes

Status: Verified (2026-09-26), including the live bridge-restart check; not yet merged. See [step 11 evidence](11-conformance-verification-and-release-handoff.md#evidence-record-2026-09-26).  
Depends on: [02](02-mandatory-persistence-and-dispatch-barriers.md),
[03](03-aggregate-persistence-budgeting-and-recovery.md).  
Finding: INC-04.

## Target behavior

When a persistent Cursor bridge acknowledges create or resume, a fresh bridge
can recover the returned session ID and associated client identity from the
published file without relying on a later prompt or graceful shutdown. An
attachment that changes provider identity follows the same publication rule.

## Owners

- [Cursor lifecycle](../../../../bridges/cursor-bridge/src/agent-session.ts):
  `createSession`, `resumeSession`, attach/recovery, and client-key registries.
- [Cursor routes](../../../../bridges/cursor-bridge/src/http.ts): create, resume,
  attach, configuration and deletion acknowledgement boundaries.
- [Cursor persistence](../../../../bridges/cursor-bridge/src/persistence.ts).
- [Backend session storage](../../../../apps/backend/src/core/storage-native.ts)
  and [provider](../../../../apps/backend/src/core/http-bridge-provider.ts).
- [Pi create/attach/resume routes](../../../../bridges/pi-bridge/src/http.ts)
  and their existing durability tests as comparison cases.

## Define what each acknowledgement promises

| Operation | State required in the acknowledged snapshot | Work not implied |
| --- | --- | --- |
| Create | Bridge ID, client key, chosen policy/composer, initial metadata | No model turn; no requirement to attach eagerly |
| Resume | Bridge ID and adopted provider ID, policy/composer, recovery metadata | No replay of the user's prior prompts |
| Attach | New/replaced provider identity and identity-dependent metadata | No prompt dispatch |
| Already warm attach | Existing identity already known durable | No unconditional whole-file rewrite |
| Idempotent create | Same canonical bridge ID and accepted configuration | No second session for a lost response |

These are lifecycle guarantees, not a requirement to await every streaming
transcript update before serving a status read.

## Implementation tasks

- [x] Add mandatory publication before successful create and resume responses.
  Resolve the publication promise before writing response headers/body.
- [x] Keep creation lazy. Do not fix persistence by creating an SDK agent or
  sending a dummy prompt merely to cause another path to write state.
- [x] Keep the existing same-client-key creation single flight. Concurrent
  requests must not receive different IDs or bypass publication because one
  request inserted into the map before another started waiting.
- [x] Track whether lifecycle state still needs publication, or simply make
  every create acknowledgement satisfy a barrier. If optimizing, prove that
  an idempotent fast path cannot acknowledge dirty state after a failed write.
- [x] On publication failure, do not return a successful reference. Choose and
  document a retry-safe in-memory policy: preferably retain the unpublished
  session under its client key and retry publication, rather than create a
  second provider conversation or discard an identity another request holds.
- [x] If an operation changes an existing session's policy/read-only mode,
  preserve the busy-session guards and publish the accepted boundary. Failure
  must not make an unapplied change look acknowledged.
- [x] Attach must publish provider identity changes, including replacement after
  failed resume. A no-change warm attach may avoid a write only when that
  identity is already acknowledged as durable.
- [x] Handle publication failures after a live run has been recovered differently
  from failures before any work exists. Keep recovered execution observed and
  owned; do not delete it to make the HTTP request look clean.
- [x] Keep per-tab MCP credentials out of persisted records. Identity persistence
  must not serialize the bearer or the attached SDK object.
- [x] Audit create/resume retry handling in the backend. A failed acknowledgement
  must not invalidate some other tab's mapping or automatically launch a fresh
  turn. Preserve authoritative `missing` versus unavailable distinction.

## Required tests

Proposed file: `bridges/cursor-bridge/src/http-session-durability.test.ts`.

Implemented as (2026-09-26): `bridges/cursor-bridge/src/http-session-durability.test.ts` and `process-restart.test.ts`.

1. Create with a client key; after HTTP 201, read the state file in a fresh
   process without draining the old process. Recover the same ID and selections.
2. Hold publication and issue a second same-key create. Neither acknowledges
   a state not yet published; both resolve to one identity.
3. Fail publication, restore the writer, and retry the same key. Assert no
   duplicate session/provider creation and that success now has a durable file.
4. Lose the create response after publication, then retry. The existing ID is
   returned and no additional session appears.
5. Resume a synthetic persisted provider conversation. The acknowledged adopted
   identity reloads even when no later attach/prompt occurs.
6. Attach an unmaterialized session; change its provider ID; verify the new ID
   is published before success. Test the failed-resume replacement path too.
7. Repeat a genuinely unchanged warm attach. If write elision is implemented,
   prove it does not rewrite and that a previously failed publication is retried.
8. Force aggregate shedding during create, then reload. The new identity and
   older sessions' essential state survive together.
9. Inspect synthetic persisted JSON for absent credential and SDK-handle fields.
10. Race close against create/attach publication after step 05: the late
    acknowledgement cannot revive a closed session.

## Backend and real-stack verification

Run Cursor HTTP/persistence tests and typecheck. Run backend provider/session
storage tests if acknowledgement/error handling changes there. Then use an
isolated fixture environment to create a native Cursor tab, choose composer
settings before the first prompt, restart the bridge through the owned test
lifecycle, and reload the frontend. The tab must retain its logical identity
and selections without sending an unintended prompt.

Record a bridge restart separately from a full backend restart; the latter can
hide a lost mapping by rebuilding more of the environment. Include inactive-tab
rehydration and credential-free error states where safe.

## Acceptance and compatibility

- [x] Success responses establish the snapshot guarantees in the table.
- [x] No graceful shutdown is needed to pass the creation recovery test.
- [x] Failed publication has a deterministic same-key recovery path.
- [x] Warm attach remains efficient without skipping dirty identity changes.
- [x] Backend mapping and permission boundaries remain consistent after restart.
- [x] Old valid persisted sessions load without a destructive migration.
- [x] The change does not claim to reconstruct sessions lost before the fix.
