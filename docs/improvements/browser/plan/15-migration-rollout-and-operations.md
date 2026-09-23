# 15 — Roll out, document operations, and prove rollback

Status: Not started. Depends on: the step-14 gate for the delivery group.

## Outcome

Ship improvements in bounded groups while preserving older clients/backends
and making unsupported configurations explicit. Operators can diagnose,
disable, and recover the feature without destroying application data or taking
the backend offline.

## Delivery groups

| Group | Required implementation | Enablement |
| --- | --- | --- |
| Foundation preview | 01–04, read-only service/readiness UI where useful | Internal/experimental; existing navigation remains available |
| Desktop service previews | 05–09, desktop subset of 12, relevant 14 | New desktop capability after real Electron/remote tests |
| Private external previews | 10–11 top-level path, relevant 12/14 | Installations with verified private publication/bootstrapping |
| Embedded web/iOS | Passing per-platform parts of 11–12/14 | Only tested combinations; top-level fallback retained |
| Optional relay | 13 and its 14 coverage | Explicit capability on supported owned container images |

A group may ship while a later numbered step remains Not started. Record partial
step scope honestly; do not mark the whole plan complete after desktop delivery.

## Feature/capability controls

Use a small number of authoritative controls: service registry availability,
new preview transport, private publication, embedded surfaces, and optional
relay. Derive client behavior from authenticated capabilities; avoid conflicting
renderer-only flags. Disabled publication must not advertise a usable origin.

Keep an operational kill switch for new access issuance and a separate action
to revoke active preview transport. Disabling new transport does not silently
fall back across an authorization failure. Explicit legacy fallback explains
its limitations and uses only the user's existing permitted legacy target.

Unsupported capability command means an old backend only when the error actually
indicates that. Network/auth/malformed responses remain failures. Include an
operator-visible reason for each unavailable mode.

## Mixed-version matrix

| Client / backend | Required behavior |
| --- | --- |
| Old / old | Existing semantics unchanged |
| New / old | Explicit legacy mode; no new schema writes or assumed WS support |
| Old / new | Legacy routes remain stable during the compatibility window; scoped credentials never authenticate them accidentally |
| New / new, publication absent | Desktop transport available if supported; web shows a setup/unsupported path |
| New / new, feature disabled | Existing saved data remains readable; new transport is not issued |
| Old client opens a new service-tab layout | Safe unsupported/read-only behavior or proven preservation; no silent lossy rewrite |

Test each matrix row before release. Negotiate minimum layout/protocol versions
and preserve compare-and-set conflict semantics. Maintain a documented support
window for legacy routes and schemas; removing them is a later reviewed change,
not hidden cleanup in the initial rollout.

## Rollout sequence

1. Land small reviewed PRs behind disabled-by-default new capabilities. Keep
   schema additions reversible and old readers/writers tested.
2. Enable isolated development profiles and synthetic fixtures. Confirm logs
   are safe and metrics can distinguish legacy/new transport failures.
3. Enable developer desktop usage against a test remote backend, with container
   recreation and credential-rotation drills.
4. Enable opt-in production desktop usage on supported systems, document fresh
   preview logins from session partition changes, and monitor bounded metrics.
5. Enable private external-browser publication only after provisioning/renewal
   and bootstrap gates pass on that deployment type.
6. Enable embedded web/iOS combinations individually after privacy-policy tests.
   Keep unsupported combinations on a clear top-level fallback.
7. Consider defaults after the chosen observation window and thresholds are met.
   Record that window and error/resource thresholds before enabling the cohort;
   an absence of complaints is not a validation metric.

Do not run old and new backends simultaneously against the same data directory
to test rollout. Use isolated copies/profiles and separate fixture environments.

## Rollback drill

Prove the following sequence with active HTTP, WS, and hidden previews:

1. Stop minting new scoped access and publish capability/status change.
2. Revoke affected attachments and close their resources with a safe reason.
3. Preserve service definitions, application processes, and reversible layout
   migration data. Do not delete app cookies/control credentials as rollback.
4. Disable only owned publication/relay resources as required; preserve unrelated
   Tailscale settings and backend listeners.
5. Restore compatible client/backend versions or explicit legacy mode according
   to the documented schema downgrade path. New-only tabs can show an upgrade
   requirement instead of guessing a legacy URL.
6. Re-enable the feature, rehydrate snapshots, obtain fresh access, and confirm
   the original service identity reconnects without replaying application writes.

Database/layout schema incompatibility is a release blocker unless there is a
tested restore path. Keep old preview partitions for the declared rollback
window, then remove them only through ownership-aware retention cleanup.

## Operator and product documentation

Update the living [remote gateway guide](../../../architecture/remote-gateway.md)
and documentation catalog when implementation lands. Document:

- Service registration and container application-port versus host-port behavior.
- Supported clients, transport modes, framework versions, and known limitations.
- Private publication setup, certificate renewal, listener conflicts, and
  tailnet/DNS troubleshooting.
- App public-origin/HMR/allowed-host/OAuth configuration where required.
- Access expiry, external links, reset-site-data, session persistence, and
  browser privacy/framing fallbacks.
- Resource limits, safe diagnostics, revocation, kill switch, and rollback.
- Old-image relay behavior and the explicit recreation alternative.

Move enduring implementation details into living architecture/operator docs;
keep this directory as the historical execution plan with final evidence.
Mark the investigation's findings addressed/remaining with links, rather than
leaving obsolete statements presented as the current product.

## Completion

For each shipped group, attach PRs, exact tested versions, validation matrix,
rollout configuration, operational drill results, and cleanup evidence. All
changes go through PR review; final integration into `main` remains a human
maintainer action. Full completion means the enabled support matrix is proven,
documentation matches behavior, and any deferred optional work is explicitly
listed with its capability disabled.
