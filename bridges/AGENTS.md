# Bridge instructions

These rules apply to every bridge under `bridges/` and to the backend code that
calls them (`apps/backend/src/core/http-bridge-provider*.ts`,
`bridge-session-close.ts`, the activity sweep). The root
[`AGENTS.md`](../AGENTS.md) still applies; each bridge directory adds its own
`AGENTS.md` for engine-specific rules.

## Session surface routes

- Never poll a tab-facing route from a background reconciler. `/session/:id` and
  `/session/:id/status` are liveness touches — the codex bridge refreshes
  `lastAccessed` (which is what `detachableThreads` reads) and the claude bridge
  additionally hydrates the transcript. The backend's activity sweep runs every
  two seconds for every persisted session, so polling those would put idle
  detaching and transcript eviction permanently out of reach. Both bridges
  expose `GET /session/:id/activity` for exactly this: no touch, no hydration,
  no re-attach. Anything else the backend wants to poll needs the same
  treatment.
- `/session/:id/activity` answers an unknown session **in band** as
  `{"activity":"missing"}` and never 404s. The backend reads a 404 there as "this
  bridge predates the route" and fails the environment; if 404 also meant "session
  gone" it would delete a live session mapping against an older bridge. For the
  same reason the claude bridge answers a failed existence probe `idle`, never
  `missing` — an error is not evidence of deletion.
- `GET /session/:id/dispatch?requestId=` answers `dispatched` **only** on an
  explicit positive from that bridge's own dispatch journal. No record, a record
  that predates a bridge restart (the ACP journal's `ambiguous`, the codex
  journal's `prepared`), an unreadable journal and a missing route are all
  `unknown`. The backend clears a parked dispatch on `dispatched` alone, so
  reporting a *lost* record as "never sent" would have it run the same turn
  twice. Like `/activity`, it must never touch liveness, hydrate or re-attach.
- Prompt dispatch and `POST /session/:id/attach` share the same client timeout,
  because they do the same work. A bridge with no attached agent process pays a
  full spawn plus `initialize` plus `session/load` on whichever request arrives
  first; budgeting the prompt at the 30s default aborted cold dispatches
  mid-flight and reported them to the user as unresolvable. Attach exists to
  move that cost *outside* the at-most-once window, where a failure is
  unambiguous — nothing journaled, no prompt written. It must never dispatch a
  turn, and callers must treat it as best-effort: the prompt request performs
  the same work and is the one that answers authoritatively.
- A parked dispatch blocks its whole session, not just the prompt that created
  it: storage refuses every other request id until it is settled. Surface both
  ways out — retry under the same idempotency key, or discard — rather than the
  storage-level refusal, which names an invariant the user cannot act on.

## Tab close and conversation retention

Closing a tab retains the conversation on every platform. Every managed bridge
(Claude, Codex, Cursor, Grok/ACP, Pi) serves `POST /session/:id/close`; backend
tab teardown and `HttpBridgeProvider.closeSession` both go through
`closeBridgeSessionRetaining` (`apps/backend/src/core/bridge-session-close.ts`).
When touching any of them:

- **Close is non-destructive.** It stops owned work, denies parked approvals,
  questions and plan approvals, settles dispatch claims, and releases the
  bridge's live mapping. It never deletes vendor history: no Claude SDK
  `deleteSession`, no Codex `thread/delete`, no OpenCode
  `client.session.delete`.
- **Only a 2xx that affirms `closed: true` is a confirmed close.** 200
  `{ closed: true, retained: true }` or `{ closed: true, missing: true }`.
  Anything else, including an empty or malformed 2xx, is not a close.
- **An unknown session is answered in band, never 404.** 200
  `{ closed: true, missing: true }`. A 404/405 from the close route means the
  bridge predates it; it is never evidence that the session is gone.
- **503 `{ closed: false, pending: true, error }` keeps everything.** The
  bridge keeps the session registered (and refuses new work on it); the
  backend keeps its durable teardown intent and the tab mapping, and the
  periodic reconcile sweep retries. Errors are fixed, content-free strings.
- **Legacy fallback is per bridge.** On 404/405 the backend may send the old
  `DELETE /session/:id` only where `LEGACY_DELETE_RETAINS_HISTORY` is `true`
  (Codex, Cursor, Grok, Pi). **Never for Claude**, whose DELETE deletes the
  rollout: that teardown stays pending with a `bridge-upgrade-required`
  failure the renderer shows as a restart notice. Do not add a platform to
  that table without evidence from every released version of its DELETE.
- **The last owner closes.** Two tabs can map to one provider session. Backend
  teardown is serialized per (environment, agent, provider session) and only
  the tab that finds no other mapping performs the provider close.

## Native slash commands

The contract is [`docs/architecture/native-agent-commands.md`](../docs/architecture/native-agent-commands.md).
When touching command discovery or dispatch:

- **Never seed or guess rows.** A catalogue lists only what the provider
  reported and what its executor can run. A successful empty list stays
  empty; a failed read is `stale` or `unavailable`, never `ready: []`.
- **A selected command never becomes a prompt.** Removed, changed, forged or
  unverifiable selections are refused before journaling (bridges answer 422
  `command-unavailable`). Retries and queued items carry the resolved intent.
- **Private bindings stay private.** Skill paths, template bodies and
  provider command defaults never appear in a public descriptor.
- **Catalogue reads are metadata.** They must not touch `lastAccessed`,
  hydrate a transcript or re-attach an idle session; push freshness rides on
  `commandRevision` in the snapshot the backend already reads.

## Packaging

Every bridge that builds has to be listed in the root `package.json`'s
`build.extraResources`. `getBridgePath` falls back to `resourceRoot/<name>`
outside development and fails only at the moment a user selects it, while
containers carry on working from `/opt/<name>`.
`tests/unit/bridge-packaging.test.ts` enumerates them so the next one cannot be
forgotten.
