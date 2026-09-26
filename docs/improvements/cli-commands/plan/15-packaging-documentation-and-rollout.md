# 15 — Package, document, and release the supported command set

Status: Planned; packaging checks start with step 02.
Depends on: Steps 01–12 and [14](14-targeted-testing-and-qualification.md);
[13](13-environment-command-execution.md) only if exec is shipped.
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

The installed `orkestrator` package supports the qualified commands independently
of a repository checkout, retains its existing service behavior, and documents
the exact observable guarantees. Unqualified features remain unavailable.

## Owners and starting points

- [Package manifest](../../../../packages/cli/package.json),
  [build script](../../../../packages/cli/scripts/build.ts),
  [packed smoke](../../../../packages/cli/scripts/smoke-packed.ts), and
  [package tests](../../../../packages/cli/tests/cli.test.ts).
- [CLI README](../../../../packages/cli/README.md) and
  [mise tasks](../../../../mise.toml).
- [Remote gateway guide](../../../architecture/remote-gateway.md),
  [Control MCP guide](../../../architecture/control-mcp.md), and
  [documentation catalog](../../../README.md).

## Packaging work

1. Include client bundles, required protocol helpers, and operator docs in the
   packed files. Prove resolution from a scratch installation, not workspace
   hoisting or an ambient checkout. Keep backend/bridge resource paths and
   external-dependency manifest checks intact.
2. Extend the packed smoke with help/version without a server, explicit/legacy
   serve readiness, connection to the selected ephemeral backend, pure JSON
   discovery, one fixture lifecycle operation, and graceful cleanup. Confirm a
   client command never starts another backend process.
3. Exercise macOS and Linux distribution behavior, private path/permission
   handling, argv with spaces/non-ASCII, installed profile discovery, and remote
   connection errors. Keep network-requiring package install/pack checks in
   their existing smoke/publish gate instead of silently adding them to all
   unit runs.
4. Test new CLI/old backend, old CLI launcher/new backend, and current desktop/web
   clients against new backend actions. Verify capability negotiation refuses
   unsupported mutations before submission and preserves old invoke envelopes.
5. If dependencies, exports recorded as package metadata, or versions change,
   use pinned Bun to regenerate every tracked lockfile and run frozen-install
   and version-drift checks from AGENTS.md. An application version bump must
   update all listed manifests; do not bump merely for this planning task.

## Operator documentation

Document service versus client modes, explicit connection registration/defaults,
dev profile discovery, credential handling, local-versus-backend paths, command
help, JSON schemas, exit codes, request keys, retention/expiry, and recovery
after unknown/partial results. Include environment ready versus running,
provider-completion support, pending interactions, stop versus discard, and
observer timeout versus execution timeout.

Provide runnable examples for register → create → configure → start → prompt →
wait → inspect → cleanup, follow-up to a saved session, restart/reconciliation,
and one targeted fixture scenario. Examples must use explicit IDs/receipts and
an owned cleanup path; do not imply illustrative syntax is already installed.
Keep private-GitHub creation effects explicit and local fixture setup free of
remote repository creation.

Update the CLI README and living architecture/testing guides to match released
capabilities. Link those living guides from the source review and this index
once implemented. Preserve the original review's dated findings and limitations.

## Release gates

1. Run focused owning tests during implementation, `mise run test:changed` for
   iteration, `mise run check` through the logged wrapper, and `mise run test`
   for final non-iOS validation per the testing guide. Run relevant browser,
   Electron, Docker, and live-provider scenarios from step 14 separately.
2. Run the existing `mise run smoke:cli` when packaged qualification is required.
   Record its network/tool prerequisites and artifacts. Do not execute publishing
   as a validation shortcut; `publish:cli` changes the external package registry.
3. Review evidence by milestone/capability rather than one aggregate green badge.
   Unavailable Docker/live/browser evidence remains visible; unsupported provider
   completion must not be advertised just because generic unit tests pass.
4. Review the final diff for accidental credential-bearing fixtures, raw provider
   recordings, unrelated config changes, and documentation claiming unrun checks.
5. Prepare reviewable PRs on feature branches. Verify branch and upstream before
   any authorized push; never push/merge directly into `main`. Publishing and
   final human merge remain separate from implementing/qualifying this plan.

## Rollout and rollback

Release milestone A/B/C capabilities as they are qualified; exec/following can
arrive later. Prefer additive capability negotiation over a second runtime
engine or broad feature-flag architecture.

Withdraw new admission for a defective action while preserving receipt reads,
reconciliation, interaction handling, and cancellation for existing work.
Retain operation/tombstone storage through downgrade, and prevent an old client
from bypassing the new backend's dispatch fences. Reverting a CLI adapter must
not destroy user workspaces or erase the evidence needed to recover a turn.

## Acceptance and completion record

- [ ] Installed package works without the source checkout and preserves service startup.
- [ ] Current and legacy clients have explicit tested compatibility behavior.
- [ ] Every advertised action/provider has the required qualification evidence.
- [ ] README/help/examples and living guides describe shipped behavior accurately.
- [ ] Retention, uncertainty, authority, timeout, and cleanup semantics are documented.
- [ ] Rollback retains observation/recovery of accepted operations.
- [ ] Index/steps record verified evidence and human-merged PRs when they occur.

The implementation handoff should list the shipped command/capability versions,
tested platforms/providers, exact validation results, remaining limitations,
and migration/rollback notes. Do not mark the complete plan finished because
documentation exists or only the parser/client skeleton has landed.
