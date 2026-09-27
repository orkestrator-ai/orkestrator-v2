# 15 — Package, document, and release the supported command set

Status: In progress — packaging, documentation and rollout notes done; awaiting human review and merge.
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

- [x] Installed package works without the source checkout and preserves service startup.
- [x] Current and legacy clients have explicit tested compatibility behavior.
- [x] Every advertised action/provider has the required qualification evidence.
- [x] README/help/examples and living guides describe shipped behavior accurately.
- [x] Retention, uncertainty, authority, timeout, and cleanup semantics are documented.
- [x] Rollback retains observation/recovery of accepted operations.
- [ ] Index/steps record verified evidence and human-merged PRs when they occur.

The implementation handoff should list the shipped command/capability versions,
tested platforms/providers, exact validation results, remaining limitations,
and migration/rollback notes. Do not mark the complete plan finished because
documentation exists or only the parser/client skeleton has landed.

## Implementation record

Revision: working tree on `a9337716`, 2026-09-26 (uncommitted; not yet
reviewed or merged).

- Shipped contract: one registry command, `public_action`, schema version 1,
  every action at version 1 (catalogue in
  [`public-api.ts`](../../../../packages/protocol/src/public-api.ts)).
  `capabilities` advertises exactly the registered handlers; exec is
  advertised for local and container environments. Completion is
  qualified for Claude, Codex and OpenCode and reported `unsupported` for Pi,
  Cursor and Grok.
- Package: `dist/client.js` (client bundle, no backend imports) is loaded
  first by `bin/orkestrator.js`; `dist/main.js` still serves. The published
  package ships the Claude and Codex bridges; OpenCode runs its own server.
- Compatibility: historical service argv forms, `serve`, and all existing
  server flags are unchanged (`client-parsing.test.ts`, `options.test.ts`).
  A new client refuses a backend without the public contract as
  `backend-incompatible` before any mutation (`client-transport.test.ts`).
  Existing web, desktop and MCP callers use their unchanged commands; the
  legacy create path gained only a conflict check for a reused request with a
  different intent.
- Documentation: [public-cli.md](../../../architecture/public-cli.md) (contract,
  exit codes, retention, uncertainty, authority, timeouts, cleanup,
  provider matrix, limitations, rollback), the
  [CLI README](../../../../packages/cli/README.md), and the
  [remote gateway](../../../architecture/remote-gateway.md),
  [control MCP](../../../architecture/control-mcp.md) and
  [testing](../../../development/testing-guide.md) guides; `AGENTS.md` has the
  contributor rules.
- Rollback: remove a handler from `public-api/registry.ts` to withdraw one
  action; `run.*`, the reconciler and `public-operations/` keep serving
  accepted work. Never delete the operation store.

Validation on the final code (Linux, Bun 1.4.2 via mise, Docker 29.7.2):

| Check | Command | Result |
| --- | --- | --- |
| Full suite | `mise run test:logged -- --name full-suite -- mise run test` | PASS (265.9s) |
| Static | `mise run test:logged -- --name check -- mise run check` | PASS |
| Packed install | `mise run test:logged -- --name smoke-cli -- mise run smoke:cli` | PASS |
| Scenarios, local / container | `mise run test:cli:scenarios` (± `--environment-type container --docker-image …`) | PASS 7/7 and 5/5 |
| Live providers | see [step 14](14-targeted-testing-and-qualification.md#evidence) | Claude, Codex, OpenCode pass, local and container |
| Browser | `mise run test:agent:browser:isolated`; live `cli-ui.spec.ts` with Claude | PASS (see step 14 for pre-existing intermittent tests) |

Remaining limitations: macOS (package and Docker Desktop) was not run;
Pi, Cursor and Grok are not live-qualified; follow mode polls snapshots
rather than streaming events. Merge status is recorded only after a human
maintainer merges.
