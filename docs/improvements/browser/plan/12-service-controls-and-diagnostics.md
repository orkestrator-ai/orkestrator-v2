# 12 — Add service controls, configuration, and diagnostics

Status: Implemented (`e25d3571`). Depends on: 09; 11 for browser-specific controls.
Unlocks: product completion and optional relay UX.

## Outcome and owners

Users can find the right service, understand why it is unavailable, and recover
without guessing ports or restarting containers unnecessarily. Keep ordinary
flows simple; put transport detail in an expandable diagnostic view.

Integrate [BrowserTab](../../../../apps/web/src/components/browser/BrowserTab.tsx),
[ActionBar](../../../../apps/web/src/components/layout/ActionBar.tsx),
[environment settings](../../../../apps/web/src/components/environments/EnvironmentSettingsDialog.tsx),
[repository settings](../../../../apps/web/src/components/settings/RepositorySettings.tsx),
and [container creation](../../../../apps/backend/src/core/commands-containers.ts).
Use existing shadcn/ui patterns. Split service picker, readiness, and diagnostic
components rather than adding every concern to BrowserTab.

## Service picker and navigation

Show an environment-scoped list with service label, application port, scheme,
readiness, and a primary Open action. Indicate local versus remote backend in
the surrounding context. Prefer the configured entry service without hiding
other services. Keep a separate explicit “Backend host port” registration path.

The address bar edits the application's address/path and supports choosing a
service. It should not require users to enter gateway prefixes or transient
host ports. For ambiguous terminal links, show the matched source environment
and service choices. Remember deliberate service selection in the durable tab.

Provide controls according to negotiated surface capability: Retry, Choose
service, Open externally, Copy preview link, DevTools, annotations, and Reset
site data. A missing capability explains the available alternative. Keyboard
focus, shortcuts, accessible names, narrow widths, and native-view overlays
must work with the new service controls.

## Register and configure services

Support label, environment target kind, application port, scheme, entry-service
selection, and optional safe readiness path. Validate through the backend even
if the form validates locally. No generic arbitrary remote-host field initially.
Allow multiple services with the same port only when their target identity or
protocol actually differs; prevent accidental duplicate registrations.

For additional Docker publications, add an explicit automatic host-port mode.
Represent automatic allocation distinctly from a literal user port; do not
silently use `0` where existing validators require 1–65535. Update backend models,
storage validation, protocol/client types, settings forms, create/fork/build
options, and Docker argument generation together. Preserve existing fixed
mappings and UDP settings, while offering browser preview only for supported
application transports.

Detect duplicate publication of a configured entry port and an explicit mapping
before Docker creation. Define precedence or reject the conflict clearly.
Saving desired mappings does not imply the running container changed. Show
“requires recreation” accurately and retain the existing explicit recreation
action. Never recreate automatically when a browser tab fails to load.

User-visible discovery initially means configured mappings and explicit
registration. Later process/terminal hints are suggestions that require a
verified resolution/registration path. Do not start broad port scans or treat
untrusted terminal text as permission to publish a service.

## Diagnostics and recovery

Expose safe structured layers:

| State | Useful message/action |
| --- | --- |
| Environment stopped | Start this environment |
| No mapping | Configure a mapping; offer relay only if available |
| Mapping exists, connect refused | Start the server or verify its bind address |
| Possible container-loopback bind | Explain container interface versus host loopback; do not assert diagnosis without evidence |
| TLS/host validation failure | Show expected scheme/host and certificate/configuration repair action |
| Access expired/revoked | Reconnect through trusted control authentication |
| Backend offline | Restore backend/tailnet connection, retaining service identity |
| Capacity exceeded | Retry after indicated backoff; no automatic duplicate writes |
| Frame/cookie restriction | Open the supported top-level preview |
| Legacy mode limitation | Identify unsupported behavior, such as HMR, and available upgrade path |

Show last observation time and effective mode. A diagnostic route may display
backend, container/application port, and resolved binding to the user, but
exported reports omit secrets and full URLs. Keep page-loading errors separate
from backend reachability and application HTTP status.

Reset-site-data affects only the selected service/session and explains that
the app may require login again. It must not clear control app credentials or
every service under a connection. Framework setup hints are version-aware and
copyable; they do not modify a user's project automatically.

## Tests and completion

Test forms against backend validation, automatic/fixed port configuration,
entry-port duplication, mapping recreation messaging, ambiguous links, and
capability-based controls. Check all recovery states without real secrets.
Verify keyboard/narrow viewport and native overlay behavior in an actual browser
and Electron window; component snapshots alone are insufficient.

Save a service while another environment is active, then return and reload.
Observe readiness changing while hidden. Test 401/404 application responses as
reachable, not “server missing.” Ensure Retry only probes/attaches/reloads through
the chosen user action and does not issue hidden mutating requests.

Exit when a user can distinguish a missing mapping, an offline app, expired
access, and a browser limitation from the UI, with a working next action for
each supported case. Desktop portions can ship before browser expansion once
their step-14 gate passes.

## Implementation record (2026-09-23)

Adds the service picker, registration dialog, environment **Preview services** section,
automatic host ports, **Settings → Previews** (kill switch, revoke, relay, publication), and
`get_preview_diagnostics`. Validated with component tests only; keyboard and narrow-viewport checks
in a real browser and Electron window are not run. See [evidence](evidence.md).
