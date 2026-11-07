---
id: 5006
title: "Keep the fleet current: version skew in the sidebar and an update policy"
phase: 5
plan: "§11.6"
status: done
depends_on: [1004, 1005]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 5006 · Keep the fleet current: version skew in the sidebar and an update policy

- **Report:** [§11.6 Operational mitigation](../../docs/reports/unified-federation.md#116-operational-mitigation-keep-the-fleet-current)
- **Depends on:** [1004](1004-hello-domains.md), [1005](1005-typed-incompatibility-errors.md)
- **Parallel with:** everything in Phases 2-4 (it needs only the contract track)
- **Size:** M
- **Track:** C (contract), UI

## Goal

For one user's fleet, most skew is "not updated yet". Make that visible and one click away.

## Current state (verified 2026-11-07)

- "Update app to latest" across machines exists: `components/settings/machines/BulkUpdateDialog.tsx` and `machineBulkUpdateStore` (51 LOC).

## Work

- [x] Sidebar machine header: when a node's version differs from the command node's, show it, with the domains the node lacks (from the hello `domains` versus the command node's). Summary-tier nodes take this from command-node summaries; check whether `get_node_summaries` already carries the version and the hello domains, and add them if not.
- [x] Typed incompatibility errors ([1005](1005-typed-incompatibility-errors.md)) link to the update action for that machine.
- [x] Optional, and needing user approval for its default: an opt-in update policy per channel, "keep leaves on the command node's version". The command node runs it through the node link's existing host-maintenance path.

## Tests

- [x] The header with equal, older and pre-contract nodes; the error link opens the update for the right machine.
- [x] Screenshots of the header and the error state (the visual-change rule in `AGENTS.md`).

## Done when

- [x] A skewed node is visible in the sidebar, and its typed errors lead to its update.

## Notes

### Decisions (2026-11-07)

- **Update-policy default: off for every channel (opt-in).** The report (§11.6) calls it "an opt-in update policy per channel", so that is the recommended default, and the user said to use the report's recommended default. What the user approved, on 2026-11-07, in one combined PR: using the report's recommended default. What is not yet confirmed: that "all channels off" is the right reading of that default (the report says "opt-in"; this item reads it as off for every channel). **That concrete default still needs the user's explicit confirmation**; the index lists it under "User approval needed". *(Reworded 2026-11-07 by the orchestrator so the approval and the open confirmation do not read as contradictory; both statements kept.)* Nothing updates a machine until the user turns a channel on.
- **What "per channel" means.** A switch per update channel (Stable, Beta, Unstable); a leaf counts under its *own* channel (`updateChannel` in its maintenance snapshot). Options: (a) per leaf channel; (b) one switch keyed by the command node's channel; (c) per machine. Chose (a): it matches "per channel" and lets a user keep Stable leaves current without dragging Beta ones. The command node's version is pushed only when it is a release the leaf's channel ships (`hostUpdateChannelsReceived`), so a Stable leaf never gets a beta.
- **Policy safety.** Only an older leaf is updated (never a downgrade; a newer or non-semver version is left alone), with `drain: "when-idle"` and the longest wait (`HOST_UPDATE_IDLE_WAIT.maxSeconds`, 24 h) so an automatic update does not cut running agents short; one request per (leaf, version) every 6 h, recorded before the request so an unknown acknowledgement never loops; skipped when the leaf's updater is unavailable or a job runs; nothing in leaf mode. Runs on node changes (debounced 1 s), on a policy change, and every 10 min while a channel is on (no timer otherwise). It uses the node link's existing host-maintenance commands (`get_host_maintenance`, `request_host_update`), the same ones Settings sends through `invoke_on_node`. Logs (`nodes` area): `fleet-update.requested` (version only), `fleet-update.failed`, `fleet-update.policy-load-failed`; no node IDs.
- **Commands are defined, in `system`.** `get_fleet_update_policy` and `set_fleet_update_policy` use `defineCommand` (`packages/protocol/src/contract/domains/system/fleet-update-policy.ts`, `access: "admin"`): the ratchet refuses new string-registered commands. `system` rather than `nodes` because its domain file is committed (the `nodes` domain file was another agent's untracked work at the time) and because the host-maintenance commands the policy drives are in `system`. Registered in `commands-registry-host.ts` (not `commands-registry-nodes.ts`, which another agent was converting). Both are in `NODE_EXCLUDED_COMMANDS`, so they are never routed to a node nor reachable by a workspace grant. No `contract-domain-map.ts` entry (defined). The manifest was built from HEAD plus these two entries (the generator in the shared worktree would have swept in other agents' uncommitted conversions); the two argument schemas are committed in `contracts/schemas/`.
- **Summaries carry the facts** (`get_node_summaries` had `version` but no domains): `NodeSummary.domains?: NegotiatedDomains | null` (from the live link's hello; `null` when not connected, and `null` with a non-null `version` for a pre-contract node; absent from an older command node), and `NodeSummariesResult.selfVersion?`/`selfDomains?` (`APP_VERSION` and `CommandRegistry.helloDomains()`, passed to `NodeReadModel` as `selfHello`, without the hello's storage reads). Older machines degrade to no skew display.
- **Presentation rule.** The fact is `MachineView.release` (`MachineRelease`), supplied by every adapter: `viewFromNodeSummary`, `viewFromSelfSummary` (the command node's release), and `useBoundMachineView` (the command node's, or the bound node's summary). The shared `MachineSectionHeader` renders it (`MachineVersionSkew`), comparing with `PortalState.commandRelease`. Older: amber button with an up-arrow, version, "lacks a, b, c +n" or "predates contracts"; full list in the tooltip/accessible name; click opens the update. Newer or non-semver: muted text, no action. The chip shrinks before the machine name (capped at half the header).
- **"Lacks"** = command-node domains the node does not advertise, or advertises with a range that does not overlap; own-key lookups only. A pre-contract node lacks all of them and is labelled "predates contracts".
- **The update action.** `requestMachineUpdate(nodeId)` (`lib/settings-navigation.ts`, beside `requestCurrentMachineUpdates`) opens Settings → Machines, which opens `BulkUpdateDialog` for that one machine (progress in `machineBulkUpdateStore`, as the bulk action), or `MachineUpdatesDialog` when the machine cannot update from here (it says why). From a workspace realm only Settings → Machines opens (the pending request does not cross frames), as with `requestCurrentMachineUpdates`; realms are being removed (6002/6003).
- **Typed errors link.** `incompatibilityNotice(error, machine, command?)` wraps 1005's `describeIncompatibility` with an `update` action. Used by `reportFederatedActionError` (now takes the machine view, not its name) and `RemoteMachineTree`'s `reportWriteError` (toast action "Update"), and by `DiagnosticsExportCard` (the closing "Update it." becomes a link; the text is unchanged).
- **Effect.** Effect Schema for the policy wire/stored shape (`FleetUpdatePolicyWireSchema`, tolerant decoder with `optionalKey`) and the command definitions. Deliberately not Effect: the runner (plain timers and a promise chain, like `NodeReadModel`; a Schedule would add nothing to one debounced pass and one interval), `machineCurrency` and the UI helpers (synchronous pure functions).
- **Screenshots** (real components, bundled with `bun build` and the app's Tailwind CSS from a temporary `vite build`, captured with headless Chromium; harness in `output/visual-previews/5006-harness/`, not committed): `output/visual-previews/5006-header-{before,after}-{desktop,narrow}.png`, `5006-error-{desktop,narrow}.png`, `5006-policy-{desktop,narrow}.png`.
- Docs: `docs/architecture/host-updates.md#keeping-the-fleet-current` (new), one bullet in `docs/architecture/federation.md#one-presentation-for-both-paths`.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): protocol `fleet-currency.ts` (`compareReleaseVersions`, `machineCurrency`, `MachineRelease`, `FleetUpdatePolicy`, `DEFAULT_FLEET_UPDATE_POLICY`, `parseFleetUpdatePolicy`, `fleetUpdateDecision`), `contract/domains/system/fleet-update-policy.ts`, `NodeSummary.domains`, `NodeSummariesResult.selfVersion/selfDomains`, three `nodes` log events. Backend: `FleetUpdatePolicyRunner` (started/stopped with `NodePortal`), storage `load/saveFleetUpdatePolicy`, read-model domains and self hello, the two defined commands, routing exclusion. Web: `MachineView.release` from every adapter, `PortalState.commandRelease`, `MachineVersionSkew` in the machine header, `requestMachineUpdate` and its handling in `MachinesSettings`, `incompatibilityNotice` in the remote-action toasts and diagnostics, `FleetUpdatePolicySection`. Tests: protocol `fleet-currency.test.ts`; backend `fleet-update-policy.test.ts`, `node-summaries-currency.test.ts` (real node links), `commands-registry-fleet-update-policy.test.ts`; web `machine-version-skew.test.tsx` (equal, unknown, older, pre-contract, newer; click and typed-error toast open the right machine's update), `MachinesSettings.update-request.test.tsx` (request opens the right machine's update; unupdatable machine opens its updates; policy off by default and per channel). Related suites rerun. Typecheck clean in protocol, backend, web.
- 2026-11-07 (orchestrator, completeness check): reworded the update-policy default note: the approval (use the report's recommended default) and the open confirmation (that all-off is that default) are kept and no longer read as contradictory.
