# 09 — Unify client resolution and migrate saved tabs

Status: Not started. Depends on: 03–04, 08. Unlocks: browser/client UX work.

## Outcome and owners

Every supported opening action identifies a service before choosing a transport.
Saved tabs preserve that service across binding changes, and old layouts load
without being silently reinterpreted.

Inspect [BrowserTabData](../../../../apps/web/src/types/paneLayout.ts),
[layout protocol](../../../../packages/protocol/src/pane-layout.ts),
[layout restore](../../../../apps/web/src/lib/pane-layout-restore.ts),
[layout persistence](../../../../apps/web/src/lib/pane-layout-persistence.ts),
[pane store](../../../../apps/web/src/stores/paneLayoutStore.ts),
[address resolver](../../../../apps/web/src/lib/browser-address.ts),
[environment addresses](../../../../apps/web/src/lib/environment-address.ts), and
[terminal opening](../../../../apps/web/src/components/terminal/TerminalContainer.view.tsx).

## Data and layout migration

Add a discriminated browser target: `service` reference or `legacy/manual-url`.
Service targets carry backend identity, environment ID, service ID, and
application navigation state. Transport URLs, host bindings, local listener
ports, cookies, grants, and attachment IDs remain runtime-only.

The current shared layout version is 3 and restore reconstructs browserData
from recognized fields. Audit every serialization, validation, merge, backend
storage, and restore boundary; adding a TypeScript field alone will lose data.
Use an explicit schema/version negotiation strategy. Prefer a new layout
version only after backend read/write and merge support ships; negotiate writes
so old backends are not sent an unsupported layout.

Migration rules:

1. Read existing URL/history tabs unchanged into legacy/manual mode.
2. Offer or perform conversion only when the stored URL is demonstrably bound
   to the same current environment/service and generation. Matching a current
   port alone cannot establish the owner of a historical URL.
3. Preserve ambiguous tabs with a “Choose service” action. Do not target the
   currently selected environment merely because the old endpoint is missing.
4. Old clients must not overwrite new service fields with downgraded URL-only
   records during concurrent pane saves. Reject unsupported writes or preserve
   fields through a proven merge contract; test real mixed-version clients.
5. Retain a reversible migration record/backup under existing storage rules.
   Do not generate a stale transport URL as a downgrade fallback for a service
   that has no valid legacy representation.

Preserve existing history privacy: superseded entries lose credentials, query,
and fragment, with the existing 100-entry bound and cursor rebasing. The current
address has different existing persistence semantics; document that distinction.
Transport secrets never qualify as an application URL, even for the current tab.

## Opening and navigation

Use one service-intent adapter from these callers:

- Environment browser button: select the registered entry service, resolving
  its current endpoint only at attachment time.
- Container terminal link: use source environment/container port semantics.
  Recognize `0.0.0.0` as a bind-address hint only in this context; it is not an
  arbitrary remote target. Ask for selection when ownership is ambiguous.
- Worktree terminal link: resolve a managed/registered service or offer explicit
  registration. An open host port is not automatic environment ownership.
- Address bar: support service selection and clearly labeled manual backend
  port mode. Preserve path/query/fragment through round trips.
- Native preview link: carry service identity for same-service links; perform
  policy-controlled resolution for cross-service/new-tab/external links.
- Agent-provided links: use the same environment context if the existing link
  action supports preview opening; do not silently change all chat links.

Separate display address from actual transport URL. Native in-page navigation,
history, redirects, copied links, annotations, and external opening must map
through the active service descriptor, not prefix-removal heuristics. Validate
mapping inputs so a page cannot turn an annotation URL into a privileged target.

## Store and reconciliation

Create a proposed `previewServiceStore` as a cache of backend snapshots, scoped
by backend identity and environment. It is not the registry owner. Subscribe
before fetching; reconcile epoch/revision changes. On backend switch, prevent
in-flight results from populating another connection's state.

When an endpoint generation changes, invalidate attachments, show reconnecting,
and acquire fresh access. Do not automatically resubmit forms or replay app
requests. Hidden tabs rehydrate when active; their service registration and
backend work continue. Distinguish page state, transport state, and service
readiness so a 502 document is not presented as a healthy application.

## Tests and completion

Test actual persistence/restore/merge round trips, not only type shapes. Cover
old layouts, malformed fields, duplicate IDs, backend identity mismatch,
concurrent saves, unsupported versions, bounded/sanitized histories, and
schema downgrade. Verify grants never reach storage.

Exercise every opening action with two containers at port 3000 and a decoy
backend listener. Recreate one container, return to its inactive tab, reload the
renderer, and verify it still opens the same service. Include active connection
switch during resolution, tab closure during attach, native history after
reattach, and service deletion. Exit when the normal desktop flow no longer
depends on persisted ephemeral ports and legacy tabs remain explicitly usable.
