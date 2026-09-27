# 08 — Portable inputs and credential lifecycle

Status: Not started. Dependencies:
[02](02-lifecycle-authority-and-durable-operations.md),
[03](03-image-contracts-and-daemon-preflight.md),
[04](04-runtime-readiness-and-graceful-shutdown.md).
Return to [index](00-index.md).

## Goal

Expose only selected portable inputs to workloads, not the entire host agent
home that happened to contain them. Make provider enablement, credential refresh
and revocation explicit without weakening existing copy protections.

## Integration points

- [Host mounts and credentials](../../../../apps/backend/src/core/commands-containers.ts),
  [credential discovery](../../../../apps/backend/src/core/host-agent-credentials.ts),
  [entrypoint copy helpers](../../../../docker/entrypoint.sh).
- [Configured project files](../../../../apps/backend/src/core/commands-project-files.ts)
  and [runtime environment](../../../../docker/runtime-env.sh).
- [Global configuration](../../../../apps/backend/src/core/storage-config.ts),
  [shared defaults](../../../../apps/backend/src/core/storage-shared-core.ts)
  and existing provider launchers/credential synchronization helpers.

## Input model and bounds

Introduce a proposed portable-input manifest per environment/provider with
input kind, relative destination, validated source identity, byte/entry count,
revision and status. It is backend-private; user-facing projections contain
only provider/category, status and a safe error reason. Never include secret
contents or raw host paths in routine events.

Preserve current defaults as initial per-entry caps: 10 MiB per file, 5,000
entries and 256 MiB per directory. Add explicit total file/byte budgets across
all selected providers so many individually valid entries cannot exceed a
bounded staging operation. Proposed starting aggregate budget: 20,000 entries
and 512 MiB, configurable within a documented hard ceiling after fixture
measurement. Oversized inputs fail or show a specific skipped-input result;
they must not disappear without explanation.

## Implementation tasks

### Selection and staging

- [ ] Extract current portable-input allowlists into a versioned backend-owned
  specification shared with image generation where possible. Preserve provider
  exceptions such as user-authored OpenCode configuration and excluded native
  host binaries. Do not replace them with a blanket recursive copy.
- [ ] Select providers from enabled/authorized settings and the stricter
  agent-test credential policy. Enabling a provider later is a deliberate input
  refresh, not a reason to expose all providers at container creation.
- [ ] Create private staging directories under backend data with owner-only
  permissions and operation identity. Use atomic revision directories so a
  workload never observes half-refreshed credentials/configuration.
- [ ] Validate source ancestry and type; prevent symlink traversal and races
  between validation and read. Validate the destination ancestry independently.
  Enforce bounds during copying, not just using a pre-copy size estimate.
- [ ] Expose only staged files through explicit read-only mounts or bounded
  copy-in. Missing bind sources must fail rather than create unexpected host
  directories. Do not mount the staging parent containing other environments.
- [ ] Preserve safe user extensions/resources and report skipped categories.
  Do not run user-authored plugins on the host during staging.
- [ ] Keep project `.env` and configured copied files in their existing explicit
  project-input policy; disabling agent history mounts must not inadvertently
  change which project files a user chose to copy.

### Credentials and revocation

- [ ] Reuse atomic owner-only credential-file publication where supported.
  Keep bridge/server authentication tokens distinct from provider credentials.
- [ ] Remove provider keys from immutable Docker creation environment where a
  supported file/launch-time input exists. For providers that require process
  environment, scope it to their process, redact failures and document the
  unavoidable same-user visibility.
- [ ] Refresh only backend-owned imported files; do not overwrite arbitrary
  session state or erase in-container user changes without a defined policy.
  Coordinate updates with provider startup and operation locks.
- [ ] Track successful credential/input revision per provider. A failed refresh
  must not be reported as synchronized; preserve the prior known state or mark
  unavailable according to the requested revocation semantics.
- [ ] On disable/revoke, fence new provider work, stop affected processes as
  required, remove imported credentials and invalidate bridge caches. If an old
  credential is embedded in immutable container configuration or retained mounts,
  require safe rebuild and display pending revocation until it completes.
- [ ] Do not promise deletion can retract credentials already read by a workload.
  Upstream credential rotation/revocation remains the user's/provider's action;
  do not automatically revoke account-wide keys used by other environments.
- [ ] Exclude staged credentials from step 05's selected provider-state copies.
  Retained legacy containers still contain their former inputs/configuration;
  label this limitation until those runtimes are retired safely.

### Compatibility and cleanup

- [ ] Require the staged-input image capability before removing broad mounts.
  Existing containers cannot lose immutable bind mounts in place; offer step 06
  rebuild when available and never claim a running legacy mount is narrowed.
- [ ] Clean up staging revisions only after no live runtime/operation references
  them. Failed refresh and backend restart must leave a recoverable revision.
- [ ] Generate redacted diagnostics with provider/category and byte/count totals.
  Treat private input manifests as sensitive artifacts, not log payloads.

## Verification and exit criteria

- [ ] Sentinel files in excluded host histories, databases and disabled-provider
  credentials are unreadable from every container mount, not merely absent from
  the copied home. Inspect mount sources in fixture metadata only.
- [ ] Test nested symlinks, source replacement races, oversized trees, invalid
  UTF-8 names where supported, unreadable files and exhausted aggregate budgets.
- [ ] Rotate credentials while a provider is idle and while its process is live;
  verify the documented stop/restart behavior and no partial publication.
- [ ] Restart backend during staging/revocation and recover the correct revision.
- [ ] Real authorized profiles cover provider login parity; credential-free
  fixtures cover absence, disabled providers and redaction without real secrets.

Exit when new/rebuilt containers expose only selected inputs and the UI reports
actual synchronization/revocation state. Rollback may keep staged inputs with
the compatible image; it must never silently restore whole-home exposure.
