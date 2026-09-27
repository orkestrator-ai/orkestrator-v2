# 03 — Image contracts and daemon preflight

Status: Implemented on branch; awaiting review. Dependencies:
[02](02-lifecycle-authority-and-durable-operations.md).
Return to [index](00-index.md).

## Goal

Know which image and daemon an operation targets before creating or replacing
resources. Gate storage, readiness, credential and network behavior by declared
capabilities instead of assuming a mutable tag names a compatible image.

## Integration points

- [Dockerfile](../../../../docker/Dockerfile) and
  [release workflow](../../../../.github/workflows/publish-container.yml).
- [Backend options](../../../../apps/backend/src/options.ts),
  [Docker registry](../../../../apps/backend/src/core/commands-registry-docker.ts),
  [container exec](../../../../apps/backend/src/core/commands-container-exec.ts),
  [workspace preparation](../../../../apps/backend/src/core/commands-local-server-lifecycle.ts).
- [Docker availability protocol](../../../../packages/protocol/src/docker-availability.ts)
  and [availability tests](../../../../apps/backend/src/core/commands-registry-docker.test.ts).
- [Remote gateway guide](../../../architecture/remote-gateway.md).

## Manifest design

Generate an image-owned JSON file, proposed path
`/usr/local/share/orkestrator/image-manifest.json`, plus compact image labels.
Generate it from repository pins rather than maintaining new manual copies.
Its bounded schema should contain:

| Field | Purpose |
| --- | --- |
| `schemaVersion`, application version and source revision | Parse compatibility and trace builds |
| Architecture and runtime versions | Distinguish amd64/arm64 and Bun/Node assumptions |
| Agent/bridge versions | Diagnose mismatches with packaged providers |
| Capability versions | Workspace layout, readiness, input staging, firewall policy, graceful shutdown |
| Persistent-state format support | Compatible read/write versions per storage role |

The image cannot embed its own final content digest. Resolve image ID and
registry digest from Docker after build/pull, and store them in the backend
runtime record. A local build may have no registry digest; its immutable image
ID is still useful. Never substitute the tag as if it were immutable identity.

## Implementation tasks

- [x] Add a bounded manifest parser and explicit required/optional capability
  checks. Reject malformed/oversized/unsupported manifests with a typed error.
  Initial proposed file cap: 64 KiB; no secrets or host paths in fields.
- [x] Read manifests without executing arbitrary image entrypoints. Use a
  temporary owned, never-started container and a bounded file read/copy, with
  cleanup recorded even after timeout. Cache by immutable image ID.
- [x] Resolve the requested tag once at operation admission, store the image
  ID, and create the candidate from that ID. Re-tagging mid-operation must not
  switch the candidate underneath the migration.
- [x] Replace the boolean-only image check with an additive detailed status:
  missing, compatible, legacy, incompatible or unavailable. Preserve the old
  boolean adapter for old callers without enabling unsupported mutations.
- [x] Keep old-image start/stop where safe. Gate volume migration, staged-only
  credentials and generation readiness on matching capabilities. Explain which
  update/rebuild is needed before touching the original environment.
- [x] Detect the effective Docker context/endpoint and daemon OS/architecture.
  Do not classify a context as local just because `DOCKER_HOST` is unset.
- [x] Support a backend beside a Linux daemon and Docker Desktop's local
  integration. Explicitly reject an unverified remote-daemon topology for
  operations requiring backend-local files and loopback bridge ports.
- [x] Keep the standalone backend plus remote gateway as the supported remote
  workflow. Do not block a remote client merely because the client is elsewhere.
- [x] Preserve platform-specific host alias behavior: Linux host-gateway and
  Desktop-provided DNS must be validated separately.
- [x] Return fixed error categories and safe remediation. Do not persist raw
  Docker endpoint URLs, inspect environments or daemon stderr containing secrets.

## Compatibility and rollout

First publish a manifest-bearing image with existing runtime behavior and an
additive backend reader. Add capabilities only when their actual implementation
and tests exist. An image version number alone does not prove a capability.
Old images do not gain capability claims through fallback defaults.

Document minimum tested Engine/Desktop versions from the qualification matrix;
do not invent version requirements from an SDK schema. Check rootless behavior
explicitly because firewall capabilities and cgroup enforcement may differ.
Unsupported rootless features should produce a precise limitation, not a silent
switch to unrestricted networking or unlimited resources.

## Verification and exit criteria

- [x] Parse missing, truncated, unknown-version and valid manifests.
- [x] Re-tag the requested image between preflight and create; the candidate
  must still use the persisted immutable ID.
- [x] Test local builds with no RepoDigest and both release architectures.
  (Parser and no-digest paths are unit-tested; an arm64 image build is part of
  the step 12/14 release matrix.)
- [x] Exercise local socket, Desktop context, SSH/TCP remote context and daemon
  unavailable cases without exposing endpoint credentials in diagnostics.
- [x] Prove a manifest probe never runs the image entrypoint and cleans up its
  own temporary resource without deleting any foreign resource.
- [x] UI displays the effective image and actionable compatibility status.

Exit when all later steps can require a named capability before mutation.
Rollback keeps persisted image identities and treats new capabilities as
unsupported; it must never reinterpret a new storage layout as legacy data.

## Implementation record

- **Contract.** `packages/protocol/src/image-manifest.ts`: manifest schema 1,
  capability registry with highest understood versions, bounded parser (64 KiB,
  restricted value charset, unknown capabilities dropped), status and topology
  types.
- **Build.** `docker/image-manifest.ts` generates the manifest from ARG pins and
  probes `ORKESTRATOR_CAPABILITY` markers in installed contract scripts;
  `scripts/docker-image-build-args.ts` computes the capability label and source
  revision for `mise run docker:build`, `docker:build:dev` and the release
  workflow; the build fails on a mismatch. Initial capability:
  `workspace-prepare=1`. Later steps add markers as they land.
- **Backend.** `apps/backend/src/core/docker-image.ts`: immutable image
  resolution, never-started probe container with bounded tar extraction (no
  entrypoint, `--network none`, labelled, removed; stale probes reclaimed at
  startup), id-keyed cache, `getImageStatus`, `detectDockerTopology`. Operations
  persist `imageId`/`registryDigest` at admission and create from the id.
  Remote daemons are refused before `docker create`; the host-gateway alias is
  limited to Linux Engine.
- **UI.** `DockerImageStatusPanel` in the Docker dialog shows state, id, digest,
  build revision, contracts, missing capabilities, daemon kind and remediation.
- **Decision (topology).** Only a positively remote endpoint is refused; an
  undeterminable endpoint is reported `unknown` and keeps the previous
  behavior. Qualified: Engine 29.7.2 Linux amd64. Desktop and rootless are
  reported, not yet qualified (step 14).
- **Tests.** `tests/unit/electron/docker-image.test.ts` (manifest parsing
  bounds, tar extraction refusing symlinks/oversize/truncation, capability
  probe, digest and no-digest resolution, probe container lifecycle and cache,
  legacy status, endpoint classification without leaking endpoints, remote
  refusal before create, create pinned to the admitted id after a re-tag);
  `apps/web/src/components/docker/DockerImageStatusPanel.test.tsx`.
