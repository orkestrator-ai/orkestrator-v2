# 12 — Image build and release delivery

Status: Not started. Dependency:
[03](03-image-contracts-and-daemon-preflight.md).
Return to [index](00-index.md).

## Goal

Remove bridge build-only layers from the delivered development image, keep
runtime artifacts compatible and make releases traceable by digest/capabilities.
Preserve the tooling required for interactive development; this is not a
conversion to a minimal production web-service image.

## Integration points

- [Dockerfile](../../../../docker/Dockerfile),
  [build helper](../../../../docker/build.sh),
  [build context exclusions](../../../../.dockerignore),
  [mise tasks](../../../../mise.toml).
- [Container release workflow](../../../../.github/workflows/publish-container.yml),
  [runtime validation workflow](../../../../.github/workflows/validate-bun-runtime.yml).
- [Version-drift tests](../../../../tests/unit/version-drift.test.ts),
  [agent upgrade guide](../../../development/upgrade-agents.md),
  [README image installation](../../../../README.md).

## Build design

Use a common pinned Debian/Bun base for compatible build/runtime stages. Build
bridge artifacts in a separate stage and copy only required output into the
final development stage. Preserve real Node, agent CLIs, mise, shell utilities,
Chromium, firewall tools and explicitly needed shared libraries there.

| Stage | Contents/output |
| --- | --- |
| Shared base | Pinned architecture-compatible Bun/OS base and required build runtime |
| Bridge dependencies | Required workspace manifests, root lockfile, patch files and filtered frozen install |
| Bridge build | Sources and generated protocol; compile each bridge and vendor required runtime assets |
| Development runtime | Agent CLIs, shell/browser tools, image scripts and runtime-only bridge outputs |
| Verification | Smoke the actual final filesystem/identities and generate capability manifest |

Do not copy an entire builder workspace into the final image and then delete
its dependencies in a later layer. Validate native vendored artifacts against
the final glibc/architecture, including Claude, Pi and Cursor runtime resources.

## Implementation tasks

- [ ] Record baseline compressed manifest/layer bytes, unpacked image size and
  cold/warm builds before changing stage structure. Separate shared base bytes
  from bridge build-only bytes to explain the measured difference.
- [ ] Pin the base digest and retain an intentional update mechanism; a digest
  pin without security refresh is not the desired end state.
- [ ] Copy all manifests needed by Bun's workspace resolution before source
  trees. Preserve `patches/` before filtered install because root patched
  dependencies are validated even for workspaces that do not use OpenCode.
- [ ] Prove filtered `--frozen-lockfile` installation with the pinned Bun version.
  If Bun needs additional workspace metadata, include it explicitly rather than
  falling back to a non-frozen install that mutates the build's resolution.
- [ ] Build each bridge and copy its runtime output plus necessary vendored
  files to the existing `/opt/*-bridge` paths. Preserve runtime entry commands.
- [ ] Audit dynamic assets: Pi extension compilation/themes, Cursor native
  helpers/grammars, Claude SDK native binaries and Codex code-mode host. Bundled
  JavaScript alone does not prove these runtimes are complete.
- [ ] Use architecture/version-scoped dependency caches with size/age limits.
  Cache misses must affect speed only, never correctness or credential access.
- [ ] Tighten `.dockerignore` for irrelevant test artifacts/private local files
  without excluding required bridge fixtures/assets or generated protocol.
- [ ] Integrate step 03's manifest with real capability implementations from
  steps 04–11. Fail build verification if scripts/layout and declared versions
  disagree; no capability flag is enabled solely because a file was copied.
- [ ] Keep native amd64/arm64 CI jobs and the existing provenance publication.
  Ensure release manifest includes both successful architectures before tags
  advance. Do not publish a partial multi-architecture release as complete.
- [ ] Publish the resolved image digest/version for backend upgrade selection.
  Retain local development image overrides; never silently switch an existing
  environment just because `latest` moved.
- [ ] Keep all agent pins aligned with desktop/toolchain manifests and protocol
  lockfiles. Follow lockfile regeneration/frozen checks whenever package metadata
  changes; do not edit lockfile contents by hand.

## Final-image verification

- [ ] Build and smoke both architectures from a clean-enough context, then
  repeat with warm caches. Run the final image, not just builder-stage binaries.
- [ ] Verify every CLI version and Codex code-mode host, all five bridge health
  paths, authenticated OpenCode startup and expected runtime assets.
- [ ] Run the existing Chromium verifier as `node` and uid-0 terminal identity,
  plus a page with realistic shared-memory use under the runtime resource profile.
- [ ] Exercise shell prompt/history, mise, Git credentials, partial clone,
  restricted networking and root setup policy in an isolated fixture.
- [ ] Change one bridge source file and confirm dependency install layers stay
  reusable; change a lockfile/patch and confirm the affected cache invalidates.
- [ ] Compare registry compressed bytes and cold startup/pull time. Report real
  results rather than declaring success based on a smaller visible directory.

## Delivery and exit criteria

Land stage separation with unchanged observable runtime behavior first, then
add capability qualification for later features. If the new image fails, keep
the prior release digest available for compatible recovery; never downgrade
provider-state formats by launching an old image against a newer writable set.

Exit when the final image contains complete runtime artifacts, excludes bridge
build-only layers, preserves both architectures and has a reproducible
manifest/digest path. Per-agent image variants and removing Chromium remain
out of scope until measurements show a worthwhile benefit.
