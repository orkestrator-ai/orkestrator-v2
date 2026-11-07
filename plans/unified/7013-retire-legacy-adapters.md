---
id: 7013
title: "Retire legacy adapters and capability commands when the floor allows"
phase: 7
plan: "§11.2 Client adapters (retirement) and §11.4"
status: blocked
depends_on: [7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009]
blocked_by: "date gate: first Stable with domains + 60 days"
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 7013 · Retire legacy adapters and capability commands when the floor allows

- **Report:** [§11.2](../../docs/reports/unified-federation.md#112-design), [§11.4](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Depends on:** every Phase 7 domain item. It is also **date-gated**: it starts only when the support floor passes the first Stable release that advertises `domains`, which is at least 60 days after that release ships.
- **Size:** S per domain (rolling)
- **Track:** C (contract)

## Goal

Compatibility code leaves on schedule. Each removal is counted and justified by the register.

## Work

- [x] Contract CI ([1008](1008-contract-ci-job.md)) flags any adapter that is now unreachable: for every adapter below its domain's current version it finds the first Stable release that advertises the domain at `v + 1` (adapter 0: the domain at all) and fails with "adapter `<domain>` v`<n>` is unreachable: delete it and move its register rows to Retired" once the floor has passed it; the same for a kept capability command whose condition the floor has passed. Tested with synthetic release indexes before and at the exact moment.
- [x] A machine-readable retirement schedule: `packages/protocol/contracts/retirements.json` classifies every capability command, and `mise run contract:ci -- --retirements [--json]` lists every adapter and command with its condition, first qualifying Stable release, earliest date and register rows.
- [x] Docs: the retirement rule, the CI check and how to read the schedule in [`version-compatibility.md#domain-contracts`](../../docs/architecture/version-compatibility.md#domain-contracts) ("Client adapters", "Retirement"; "The manifest, the ratchet and CI", "Retirement schedule").
- [ ] When the floor passes the first Stable release with `domains`, delete every version-0 legacy adapter and the client-side capability gating it packaged. Record the release and date in Notes. **Gated:** no Stable release advertises `domains` as of 2026-11-07.
- [ ] Remove the per-domain `*_capabilities` commands when their register rows retire (counter at zero over the window, or the floor past every caller). **Gated** the same way; the three kept for pre-contract renderers have no counter, so only the floor retires them, and five stay (see Notes).
- [ ] From then on, apply the standing rule: adapter `v` goes when the floor passes the first Stable release with `v + 1`. Contract CI now fails on the day one is due (box 1).
- [ ] Move each retired row to the register's "Retired" table. **Gated:** happens with the deletions.

## Done when

- [ ] No version-0 adapter remains. After that, the item stays as a standing rule; mark it `done` with a note that the CI job owns future retirements.

## Notes

### What remains, and when it can go (2026-11-07)

**Condition for all of it:** the support floor passes (is at or above) the first Stable release that advertises the domain, which is the first Stable release that advertises `domains` (every domain ships in the same release). **Earliest possible date: 60 days after the first Stable release that advertises `domains`; not yet shipped as of 2026-11-07** (the latest Stable, v2.36.1, is pre-contract; this branch is unmerged). The day that release is published, `mise run contract:ci -- --retirements` shows the date for every entry below, and contract CI fails on that date until they are deleted.

- **Version-0 adapters (28, one per domain, all `waiting`):** `accounts`, `agent-mail`, `agent-servers`, `claude-tmux`, `config`, `coordinator`, `design`, `docker`, `environments`, `files`, `git`, `graphs`, `kanban`, `mcp`, `multi-review`, `native-sessions`, `node-files`, `node-mail`, `nodes`, `pipelines`, `previews`, `projects`, `pull-requests`, `system`, `terminals`, `ticket-sync`, `transcripts`, `web-annotations`. No adapter above 0 exists (every domain is at version 1). A domain added later (for example `public-api`, being defined concurrently) is picked up from `adapters.json` automatically.
- **Register rows that move to Retired with them** (named by their adapter counter): `node-mail` v0, five rows (turn origin, coordinator-to-coordinator mail, mail attachments, mail return, coordinator notices); `ticket-sync` v0 (leaves without `ticket-sync`); `config` v0 (backends without `get_client_state_capabilities`); `native-sessions` v0 (`liveUpdateVersions`, handoffs); `claude-tmux` v0 (paged transcripts); `files` v0 (`knownDigest`); `previews` v0 (`entryServiceId`); `transcripts` v0 (media stream `environmentId`). Several of these rows also have their own feature condition and counter (for example `node-coordinator-mail.older-node`); check both.
- **Capability commands the backend keeps for pre-contract renderers (3, `waiting`):** `get_client_state_capabilities` (`config`, row "Renderers before `config`"), `get_native_agent_sync_capabilities` and `get_agent_handoff_capabilities` (`native-sessions`, row "Renderers before `native-sessions`"). Same condition and date.
- **Capability commands that stay (5, `kept`):** `changes_get_capabilities` (git: restore policy, partly folded by 7006), `design_capabilities`, `get_preview_capabilities`, `transcript_artifact_capabilities`, `web_annotations_capabilities` (runtime state, 7004). They leave `LEGACY_CAPABILITY_COMMANDS` with their domain's adapter 0, not the registry.

### Decisions (2026-11-07)

- **Status `blocked`, not `in-progress`.** Every open box waits on an external date no work on this branch can bring forward, which is what the index's `blocked` (with `blocked_by`) means; `in-progress` would say someone is working on it. The automation boxes are done, and the CI job itself turns the gate into a red build on the day, so nobody has to watch the calendar. Owner and branch stay set for the record.
- **Per-domain condition.** The prompt's wording for v0 was "`domains` at all"; the check uses "the first Stable release that advertises *this* domain" (version ≥ `v + 1`), which is exact for a domain added after the first contract release and the same date for the 28 domains here.
- **Dates.** "The floor passes X" is `supportFloor(...)` at or above X. The earliest date is the earliest publication of a Stable release at or above X, plus 60 days (a later Stable published first would move it earlier; an unpublished X has no date). Every Stable snapshot is read, also below the floor, because the first qualifying release is below the floor by the time it is due. Beta releases never date anything (they are never the floor).
- **Where the schedule lives.** Options: (a) a committed, generated schedule with dates (it would drift on every `release:version` and need a regeneration step there); (b) everything computed on demand; (c) a hand-kept list for what cannot be derived plus a computed report. Chose (c): adapters are derived from `adapters.json` (generated), and only the capability commands' classification, which is a judgement recorded by 7001/7004/7005/7006, is in `packages/protocol/contracts/retirements.json` (`{ domain, retireAtDomainVersion | null, why, retired? }`), checked against `LEGACY_CAPABILITY_COMMANDS`, the manifest and the register. The dates come from `--retirements --json` (`RetirementSchedule`, `schemaVersion: 1`).
- **Deleting a kept command without a domain bump.** 1008's removed-command check requires a domain bump for a command of an in-window release; once a retiring command's condition is met every in-window renderer has the domain and never calls it, so a bump would be pointless. The entry stays in `retirements.json` with `"retired": "<date>"` while an in-window release has the command; such a command is exempt from the bump (its row must still be in Register or Retired), and a `retired` mark before the condition is met, or on a still-registered command, fails.
- **Counters are not available offline.** They are local to each backend (`get_compatibility_path_usage`); the repository has no copy. The report names each adapter's counter ids (`domain-adapter.<backend|renderer>.<domain>.v0`) and the docs say to read them before deleting. The three kept capability commands have no counter (their callers are older renderers, which the backend does not count per command), so the "counter at zero" route is unavailable for them; only the floor retires them. Adding a per-command counter was considered and not done: by the time it could show anything the floor rule already decides.
- **Effect:** not used. The schedule is plain JSON and date arithmetic in a root script, like 1008's stage 1; no services, scopes or typed failures are needed, and the problems are strings the job prints.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): `scripts/contract-ci-retirements.ts` (`parseRetirementList`, `firstStableAdvertising`, `floorReachesOn`, `retirementSchedule`, `checkRetirements`, `checkRetirementList`, `retiredCommands`, `formatRetirementSchedule`, `RETIREMENT_LIST_PATH`, `SUPPORT_WINDOW_DAYS` moved here and re-exported by `contract-ci.ts`); `scripts/contract-ci.ts` gained the "Retirements" section, `--retirements [--json]`, the `legacyCapabilityCommands` option and the `retired` exemption in `checkRemovedCommands`; `packages/protocol/contracts/retirements.json`; docs in `version-compatibility.md` ("Retirement" bullet, a stage 1 bullet and "Retirement schedule"). `tests/unit/contract-ci-retirements.test.ts` (17 tests: today waits; scheduled with the date once the release ships; fires at exactly publication + 60 days and not 1 ms before; adapter v waits for v + 1; Betas never count; kept never due; the `retired` lifecycle; list validation; the committed list and schedule; end to end through `runContractCi` with a synthetic tree). With `contract-ci.test.ts` and `contract-untyped-ratchet.test.ts`, 59 pass. `mise run contract:ci` passes on this tree (36 entries: 31 waiting, 5 kept; nothing due). oxlint and `bun fmt` clean; `tests/tsconfig.json` reports no error in these files.
