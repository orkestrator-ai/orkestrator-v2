# Todo index

Checked against `main` at `2459b05c` (2026-10-15); reference docs folded in
against `9fb4e6a8` the same day.

`docs/todo/` holds every piece of outstanding work in the repository, one file
per concept. This file is the single checklist across all of them: each item is
scored by importance and listed most important first, and links the file that
holds the detail (what exists today, the constraints, and how to know it is
done). Pick work from the top.

## Scoring an item

Score the **impact of leaving the item undone**, not the effort to do it.
Walk down the questions and take the first score that answers yes.

1. **Very high.** Could leaving it lose or corrupt user data, leak a
   credential or cross an isolation boundary, break shipped behaviour for most
   users or every run today, or let a broken release ship unguarded?
2. **High.** Does a user hit it in normal use (even with a workaround)? Does it
   waste significant time, compute or money on every run? Is it a feature that
   is on by default but has never been proved on the real stack, or a gate that
   must pass before a shipped capability can be enabled? Is it security
   hardening against a real, reachable exposure?
3. **Medium.** Is it a functional gap or a provider-parity difference, a
   qualification run for a secondary provider or platform, a refactor that
   removes a real risk, a compatibility path to retire, or a missing
   measurement?
4. **Low.** Everything else: optional or deferred features, extensions,
   optimisations that should wait for a measurement, cosmetic fixes, comment
   and doc hygiene, and work blocked upstream.

When judging, weigh the worst realistic outcome against how many users or runs
it reaches. Some rules of thumb:

- `blocked` and `deferred` items usually score low, because nothing can or
  should start yet; rescore them when they are unblocked or the stated
  measurement arrives.
- Qualifying something that is on by default scores higher than qualifying
  something behind a flag or off by default.
- A prerequisite keeps its own score; say in the owning file what it unblocks
  rather than raising it.
- If torn between two scores, pick the higher one when data, credentials or
  release safety are involved, otherwise the lower one.
- Rescore when the facts change (a default flips, an upstream release lands, a
  measurement comes in), and move the line to its new section.

## How to use this file

- Tick an item (`- [x]`) in the same change that finishes it, and update or remove the item in its owning file.
- When every item of a file is ticked, move any durable behaviour into `architecture/` or `development/`, delete the file, and delete its ticked lines and its row in [By file](#by-file).
- New work goes into the owning file first, then gets a line here with a score.
- Items without a tag are code work. Tags mark the rest: `qualification` (evidence to collect, usually a live or real-stack run), `verify` (status still unknown), `decision`, `deferred` (start only when the stated measurement justifies it) and `blocked` (waiting on upstream).

## Scores

| Score | Meaning | Items |
| --- | --- | --- |
| Very high | A live correctness, data-loss or security defect, a regression in shipped behaviour that affects most users or every run, or an unguarded release pipeline. | 1 |
| High | Significant performance or cost regressions, features on by default but never qualified on the real stack, gates for enabling shipped capabilities, user-visible bugs with a workaround, security hardening with real exposure. | 44 |
| Medium | Functional gaps and provider parity, secondary-provider or platform qualification, risk-reducing refactors, retiring compatibility paths, measurement gaps. | 241 |
| Low | Optional or deferred features, measure-first optimisations, extensions, cosmetic fixes, comment and doc hygiene, work blocked upstream. | 254 |
| **Total** | | **540** |

## Very high

### MCP (very high)

- [x] Bring the Pi MCP catalogue, codecs and capabilities in line with Pi 1.x bridge rules, plus a parity test ([mcp-management.md](mcp-management.md))
- [x] Report Claude MCP removal and rename on a retained runtime as restart-required, or retire the runtime ([mcp-management.md](mcp-management.md))

### Transcripts, observation and bandwidth (very high)

- [x] Stop the build-stage supervisor reading the whole transcript every 1.5 s; probe between persist boundaries ([transcript-history-efficiency.md](transcript-history-efficiency.md))

### Multi Review (very high)

- [x] Fix fence checks that take the lease and parse the whole store since #969 (per-row reads) ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md))

### Cross-cutting (very high)

- [ ] Apply the approved `main` ruleset (lint, typecheck and tests required) once `main` passes three CI runs in a row; the CI-only failures are fixed or registered ([test-suite-and-ci-health.md](test-suite-and-ci-health.md))

## High

### Service previews and web annotations (high)

- [ ] Re-baseline the opt-in preview suites and all preview unit files on current main after #966, #967 and #969 ([service-preview-rollout.md](service-preview-rollout.md), qualification)
- [ ] Run the real Electron window service-preview qualification with the tunnel enabled in an isolated profile ([service-preview-rollout.md](service-preview-rollout.md), qualification)
- [ ] Write a two-machine tailnet runbook and run decoy, latency, throttling, reconnect and publication checks ([service-preview-rollout.md](service-preview-rollout.md), qualification)
- [ ] Re-run the annotation Electron and isolated browser suites on current main and record a sign-off ([web-annotation-qualification.md](web-annotation-qualification.md), qualification)
- [ ] Run the live annotation implement test once per provider and record skips explicitly ([web-annotation-qualification.md](web-annotation-qualification.md), qualification)
- [ ] Qualify the annotation native window: Notes column bounds, focus, keyboard, narrow switch, zoom and DPR ([web-annotation-qualification.md](web-annotation-qualification.md), qualification)
- [x] Decide whether annotations stay enabled by default or hold dispatch for providers without a live run ([web-annotation-qualification.md](web-annotation-qualification.md), decision)

### CLI and slash commands (high)

- [ ] Re-run CLI credential-free, container and live Claude, Codex and OpenCode matrices at current main ([cli-qualification.md](cli-qualification.md), qualification)
- [ ] Verify whether a new Claude tab shows legacy `BUILTIN_COMMANDS` rows in the picker before its first query ([slash-command-catalogue.md](slash-command-catalogue.md), verify)
- [ ] Run live slash-command probes for every provider at current pins in a disposable isolated profile ([slash-command-qualification.md](slash-command-qualification.md), qualification)
- [ ] Run the inactive-environment slash-command browser scenario, including restarts at dispatch boundaries ([slash-command-qualification.md](slash-command-qualification.md), qualification)

### Containers and environments (high)

- [ ] Re-run the full container live set, benchmarks and real-stack Docker specs on current `main` ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Qualify the container live set and real-stack Docker run on Docker Desktop for Apple Silicon ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Qualify stop with a pending approval (C11) on a real provider: the approval is denied, never approved ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Re-trace `PROVIDER_STATE_LAYOUT` paths at current pins and add the step to the agent-upgrade guide ([container-rebuild-state-preservation.md](container-rebuild-state-preservation.md))
- [x] Allow firewall traffic as address, protocol and port tuples (TCP 443, GitHub SSH) under a new policy version ([container-network-and-credential-isolation.md](container-network-and-credential-isolation.md))
- [ ] Replace the 1 s Claude state `docker exec` poll with a pushed change signal and a slow safety read ([container-state-observation.md](container-state-observation.md))
- [ ] Record a non-skipped run of the deletion-during-setup real-stack spec on current `main` ([environment-and-disk-cleanup.md](environment-and-disk-cleanup.md), qualification)
- [ ] Run a seeded real-stack pass of the pre-ledger startup sweeps in an isolated dev profile ([environment-and-disk-cleanup.md](environment-and-disk-cleanup.md), qualification)

### Design canvas (high)

- [ ] Run a live Claude and Codex design-tool cycle, including Ask agent, handoff and an environment switch ([design-canvas-qualification.md](design-canvas-qualification.md), qualification)
- [ ] Verify whether the open design flakes, especially the extra event in 0215, reflect ordering bugs ([design-canvas-qualification.md](design-canvas-qualification.md), verify)
- [x] Reject a reused design `correlationId` with different input on settled receipts in `submit` and `findCreate` ([design-operation-recovery-edges.md](design-operation-recovery-edges.md))

### MCP (high)

- [x] Close MCP apply-path gaps: runtime generations, bridge versions, external edits and the 64-runtime cap ([mcp-management.md](mcp-management.md))
- [ ] Run live MCP apply probes for every provider, proving a call to a removed tool actually fails ([mcp-management.md](mcp-management.md), qualification)
- [ ] Fill the MCP provider completion matrix for every writable scope and lifecycle case ([mcp-management.md](mcp-management.md), qualification)
- [ ] Qualify MCP apply for inactive environments across reload, dropped streams and bridge generation changes ([mcp-management.md](mcp-management.md), qualification)

### Agent engines and provider SDKs (high)

- [x] Park Claude `onElicitation` and `onUserDialog` requests as interactions instead of declining them ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md))
- [ ] Check on each platform that the Agent Info policy summary matches the options the adapter received ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), qualification)
- [ ] Qualify a paused question and approval on each provider's real CLI past ten minutes, then answer ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), qualification)
- [ ] Keep the Claude CLI open across idle turns with an idle detach instead of draining at turn end ([mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md))
- [x] Report `authentication-required` readiness on Claude, Pi, ACP and OpenCode; drop the Cursor-only 401 branch ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md))
- [ ] Confirm no auth response body carries a token or key except the login URL, and the URL is never logged ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md), qualification)
- [ ] Confirm close retains the conversation through the UI for Cursor, Pi, OpenCode and Grok ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), qualification)

### Transcripts, observation and bandwidth (high)

- [ ] Qualify live history paging and reviewer Load earlier messages beyond the 100-message live window ([transcript-history-efficiency.md](transcript-history-efficiency.md), qualification)
- [ ] Run a live multi-review: progress probes, reviewer windows, detail expansion, pages and scroll anchoring ([transcript-history-efficiency.md](transcript-history-efficiency.md), qualification)
- [ ] Qualify Claude inactive-tab and background-task runs against content-revision tokens ([transcript-history-efficiency.md](transcript-history-efficiency.md), qualification)
- [ ] Qualify cold restart: display tails and pipeline histories reconcile, including a mid-dispatch restart ([transcript-history-efficiency.md](transcript-history-efficiency.md), qualification)
- [ ] Qualify idle observation live per provider: missed final event, approvals, sub-agents, reconnect, hidden ([native-agent-idle-observation.md](native-agent-idle-observation.md), qualification)
- [x] Back off gateway terminal fallback reconnect timers with `ReconnectBackoff`, resetting after healthy streams ([client-reconnect-and-freshness.md](client-reconnect-and-freshness.md))
- [x] Fix `storageReads` = 0 since #969 by charging cached row reads, and add a test asserting it ([recurring-work-qualification.md](recurring-work-qualification.md))
- [ ] Run the live isolated-profile recurring-work qualification: 10 environments, clients, outage, CPU/RSS ([recurring-work-qualification.md](recurring-work-qualification.md), qualification)
- [ ] Qualify PR monitoring against live GitHub: terminal discovery, reopen, admission delay and rate limits ([recurring-work-qualification.md](recurring-work-qualification.md), qualification)
- [ ] Qualify recursive `fs.watch` worktree watching, Electron and Docker Desktop on macOS ([recurring-work-qualification.md](recurring-work-qualification.md), qualification)
- [ ] Run real-browser QA of the Files panel, coordinator view, validation output and hidden reconcile ([recurring-work-qualification.md](recurring-work-qualification.md), qualification)

### Multi Review (high)

- [x] Make the slow-reviewer admission benchmark deterministic with deferred fakes or a controllable clock ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md))
- [ ] Run the real-stack Multi Review inactive-environment cycle with restart, reload and bridge interruption ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), qualification)
- [ ] Run the Multi Review browser and agent-browser suites for the #833 launcher and reviewer tab ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), qualification)
- [ ] Compare full and compact consolidation on real providers over the corpus for recall and provenance ([multi-review-panel-value.md](multi-review-panel-value.md), qualification)

### Coordinator and agent mail (high)

- [ ] Add an opt-in live coordinator suite that assigns each qualified platform on the fixture project ([coordinator-live-conformance.md](coordinator-live-conformance.md))
- [ ] Add the live read-only scenario: hash the tree, attempt each mutation, assert unchanged and discovery works ([coordinator-live-conformance.md](coordinator-live-conformance.md))
- [ ] Run the live read-only and async coordinator scenarios on all six platforms ([coordinator-live-conformance.md](coordinator-live-conformance.md), qualification)
- [ ] Run the worker-mail family scenario once per qualified platform with default messaging settings ([coordinator-live-conformance.md](coordinator-live-conformance.md), qualification)

### Backend structure (high)

- [x] Stop non-deleting sensitive saves rewriting the retired JSON archive with current values ([storage-service-repositories.md](storage-service-repositories.md))
- [x] Add storage guard tests: `saveJson` only under a lease, and no mixed `updateStore`/`saveJson` writers ([storage-service-repositories.md](storage-service-repositories.md))
- [x] Verify no store is written by both `updateStore` and a leased `saveJson` ([storage-service-repositories.md](storage-service-repositories.md), verify)

### Cross-cutting (high)

- [ ] Qualify Codex sub-agent cards on a fixture profile: one card per child, recovery after reload and restart ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), qualification)
- [x] Decide and implement a renderer-backend skew guard for raw OpenCode envelopes from older backends ([mixed-version-compatibility.md](mixed-version-compatibility.md))
- [x] Fix flake 0166 (OpenCode probe deadline), which recurred on 2026-10-15 ([test-suite-and-ci-health.md](test-suite-and-ci-health.md))
- [x] Keep split panes mounted across the mobile breakpoint through stable per-pane hosts ([mobile-layout-gaps.md](mobile-layout-gaps.md))
- [x] Move the environment settings dialog out of the drawer row so it is usable on mobile ([mobile-layout-gaps.md](mobile-layout-gaps.md))

## Medium

### Service previews and web annotations (medium)

- [ ] Add a real-Electron service-preview spec under `e2e/agent-testing/` and add it to the Electron `testMatch` ([service-preview-rollout.md](service-preview-rollout.md))
- [ ] Add a hostile service-worker route to the preview-app fixture that intercepts `/__orkestrator_preview/session` ([service-preview-rollout.md](service-preview-rollout.md))
- [ ] Diagnose or fix preview flakes 0184, 0195 and 0221 ([service-preview-rollout.md](service-preview-rollout.md))
- [ ] Clear preview service and connection partitions when services, environments or connections are removed ([service-preview-rollout.md](service-preview-rollout.md))
- [ ] Remove `ServiceBrowserTab` compatibility mode and retire the legacy loopback route after the support window ([service-preview-rollout.md](service-preview-rollout.md))
- [ ] Qualify publication with real private DNS and wildcard certificates per deployment type, with or without Serve ([service-preview-rollout.md](service-preview-rollout.md), qualification)
- [ ] Run top-level previews in Firefox and Safari and the iOS handoff on a device or simulator ([service-preview-rollout.md](service-preview-rollout.md), qualification)
- [ ] Qualify previews on Docker Desktop for macOS and Windows, including Auto ports and the exec relay ([service-preview-rollout.md](service-preview-rollout.md), qualification)
- [ ] Run the hostile service-worker bootstrap and re-bootstrap check against the documented outcome ([service-preview-rollout.md](service-preview-rollout.md), qualification)
- [ ] Set preview performance thresholds from the two-machine baseline and add HMR and reconnect metrics ([service-preview-rollout.md](service-preview-rollout.md), qualification)
- [ ] Verify the opt-in preview suites still pass on main after #966, #967 and #969 ([service-preview-rollout.md](service-preview-rollout.md), verify)
- [ ] Verify the Electron agent-test task starts cleanly on the run host ([service-preview-rollout.md](service-preview-rollout.md), verify)
- [ ] Decide the observation window, error and resource thresholds, and sign-off owner per preview cohort ([service-preview-rollout.md](service-preview-rollout.md), decision)
- [ ] Decide whether the Chromium preview spec or the Docker preview suites join a regular gated run ([service-preview-rollout.md](service-preview-rollout.md), decision)
- [ ] Seed local worktree preview services safely from `entryPort`, never from a port scan ([preview-service-discovery.md](preview-service-discovery.md))
- [ ] Extend the annotation Electron spec with the real Notes column and capture alignment at several zooms and DPRs ([web-annotation-qualification.md](web-annotation-qualification.md))
- [ ] Add a Docker annotation spec titled `Docker fixture` asserting materialization, cleanup and file checks ([web-annotation-qualification.md](web-annotation-qualification.md))
- [ ] Assert on the real stack that a sent request writes the annotation PNG into the local worktree ([web-annotation-qualification.md](web-annotation-qualification.md))
- [ ] Add live Discuss and needs-input annotation cases beside the live implement case ([web-annotation-qualification.md](web-annotation-qualification.md))
- [ ] Fix annotation-related flakes 0204 and 0225 ([web-annotation-qualification.md](web-annotation-qualification.md))
- [ ] Qualify annotation capture and materialization against a remote backend on another host ([web-annotation-qualification.md](web-annotation-qualification.md), qualification)
- [ ] Test annotation approvals across environment switch, reload, SSE loss and backend restart ([web-annotation-qualification.md](web-annotation-qualification.md), qualification)
- [ ] Review desktop captures from the gateway web client and iOS wrapper with no desktop connected ([web-annotation-qualification.md](web-annotation-qualification.md), qualification)
- [ ] Record annotation latency baselines from `web_annotations_metrics` and client-side selection-to-saved timing ([web-annotation-qualification.md](web-annotation-qualification.md), qualification)
- [ ] Record annotation sign-off per milestone A, B and C and update the client capability matrix ([web-annotation-qualification.md](web-annotation-qualification.md), qualification)
- [ ] Verify the 2026-09-25 annotation runs still pass after #969 and #983 ([web-annotation-qualification.md](web-annotation-qualification.md), verify)
- [ ] Verify the gateway spec's synthetic capture still matches what the Electron capture path produces ([web-annotation-qualification.md](web-annotation-qualification.md), verify)
- [ ] Decide whether macOS is required alongside Linux for the annotation native-window gate ([web-annotation-qualification.md](web-annotation-qualification.md), decision)
- [ ] Decide whether unit-level fault and race tests suffice for annotation gate A ([web-annotation-qualification.md](web-annotation-qualification.md), decision)
- [ ] Discard stale pin anchor results by `documentGeneration` in `useAnnotationPins` ([web-annotation-known-limitations.md](web-annotation-known-limitations.md))
- [ ] Add bounded containment and existence checks for container workspace paths in annotation results ([web-annotation-known-limitations.md](web-annotation-known-limitations.md))
- [ ] Attest Electron-produced captures, or show the producer of gateway captures as unverified ([web-annotation-known-limitations.md](web-annotation-known-limitations.md))
- [ ] Offer a separate read-only discussion session for Discuss on providers without turn-scoped modes ([web-annotation-known-limitations.md](web-annotation-known-limitations.md))
- [ ] Reduce `unknown` request outcomes and Answer-in-chat fallbacks found by the live runs ([web-annotation-known-limitations.md](web-annotation-known-limitations.md))
- [ ] Add missing annotation metrics series and decide whether anything reads `web_annotations_metrics` ([web-annotation-known-limitations.md](web-annotation-known-limitations.md))
- [ ] Identify which providers produce `unknown` outcomes or Answer in chat in practice ([web-annotation-known-limitations.md](web-annotation-known-limitations.md), verify)

### CLI and slash commands (medium)

- [ ] Add CLI `session commands`, `session command` and an explicit `--literal` for selected slash commands ([cli-command-surface.md](cli-command-surface.md))
- [ ] Add an explicit CLI `--enqueue` over the backend-drained native prompt queue ([cli-command-surface.md](cli-command-surface.md))
- [ ] Add bounded CLI prompt attachments with a lifecycle and an attachment digest in the request fingerprint ([cli-command-surface.md](cli-command-surface.md))
- [ ] Add explicitly provisioned, scope-limited worker credentials for CLI automation ([cli-command-surface.md](cli-command-surface.md))
- [ ] Verify CLI `run retry` of a typed-command prompt replays with the same intent ([cli-command-surface.md](cli-command-surface.md), verify)
- [ ] Decide whether CLI prompt text defaults to literal instead of typed slash-command intent ([cli-command-surface.md](cli-command-surface.md), decision)
- [ ] Make Pi, Cursor and Grok CLI-qualifiable by targeting a running profile or bundling their bridges ([cli-qualification.md](cli-qualification.md))
- [ ] Run the live CLI `live-session` scenario for Pi, Cursor and Grok, local and container ([cli-qualification.md](cli-qualification.md), qualification)
- [ ] Qualify the CLI on macOS: packed install, config directory, profile discovery and Docker Desktop matrix ([cli-qualification.md](cli-qualification.md), qualification)
- [ ] Check CLI-started question and approval cards in the browser for providers other than Claude ([cli-qualification.md](cli-qualification.md), qualification)
- [ ] Add a CLI scenario with a foreign-owner Docker decoy and assert no fallback or mutation ([cli-qualification.md](cli-qualification.md), qualification)
- [ ] Verify the CLI credential-free scenario matrix still passes at `2459b05c` ([cli-qualification.md](cli-qualification.md), verify)
- [ ] Retire the legacy slash catalogue routes and stop pre-session tabs showing guessed rows ([slash-command-catalogue.md](slash-command-catalogue.md))
- [ ] Label UI-dependent Pi extension commands unavailable or return a bounded unsupported-interaction result ([slash-command-catalogue.md](slash-command-catalogue.md))
- [ ] Check slash picker source groups, keyboard order and catalogue refresh on Claude, Pi and Grok in a browser ([slash-command-catalogue.md](slash-command-catalogue.md), qualification)
- [ ] Collect legacy-route use counts and run a mixed-version check before deleting legacy catalogue routes ([slash-command-catalogue.md](slash-command-catalogue.md), qualification)
- [ ] Verify whether a Grok tab reads the catalogue without a session ID and fails on `/plugins/commands` ([slash-command-catalogue.md](slash-command-catalogue.md), verify)
- [ ] Verify whether old-backend/new-bridge and old/new renderer catalogue projections are tested ([slash-command-catalogue.md](slash-command-catalogue.md), verify)
- [ ] Check that slash skill and template paths resolve inside the provider's container environment ([slash-command-qualification.md](slash-command-qualification.md), qualification)
- [ ] Run the slash-command mixed-version matrix across backend, bridge and renderer versions ([slash-command-qualification.md](slash-command-qualification.md), qualification)
- [ ] Measure slash catalogue discovery latency, refresh coalescing, cache bytes and probe counts ([slash-command-qualification.md](slash-command-qualification.md), qualification)

### Containers and environments (medium)

- [ ] Qualify rootless Engine: unenforceable cgroup or firewall axes are reported and refused, never weakened ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Run the container C-scenarios on native arm64 hardware and mark emulation-only evidence ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Measure compressed manifest and layer bytes and cold pull time for a pushed GHCR image ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Qualify session resume after rebuild (C13) for Codex, OpenCode, Pi, Cursor and Grok ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Qualify live credential rotation (C21) while a provider process runs, including account switching ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Inject readiness failures on a real daemon (firewall, DNS, permissions, status write, Docker restart, C10) ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Run a live daemon disconnect mid-copy and a process kill around the rebuild commit write ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Check the agent-tools port is answered from a container on a host whose reachability path is open (C22) ([container-platform-qualification.md](container-platform-qualification.md), qualification)
- [ ] Decide the published minimum Engine and Desktop versions and whether rootless is gated or refused ([container-platform-qualification.md](container-platform-qualification.md), decision)
- [ ] Decide whether the container live suites get a scheduled CI job on Linux amd64 and arm64 runners ([container-platform-qualification.md](container-platform-qualification.md), decision)
- [ ] Close or explicitly accept partial rebuild preservation for Codex, OpenCode and Grok state files ([container-rebuild-state-preservation.md](container-rebuild-state-preservation.md))
- [ ] Retire the legacy-layer, host-mounts and policy-1 paths, with an export path for legacy containers ([container-rebuild-state-preservation.md](container-rebuild-state-preservation.md))
- [ ] Decide whether `restoreRecoveryCopy` always assigns a new `runtimeGeneration` so stale handles are refused ([container-rebuild-state-preservation.md](container-rebuild-state-preservation.md), decision)
- [ ] Generate one canonical default allowlist for the backend, renderer and firewall fallbacks ([container-network-and-credential-isolation.md](container-network-and-credential-isolation.md))
- [ ] Prototype bounded external egress enforcement so restricted containers no longer need `NET_ADMIN` ([container-network-and-credential-isolation.md](container-network-and-credential-isolation.md))
- [ ] Choose and apply a measured default CPU, memory and PID budget for new container runtimes ([container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md))
- [ ] Measure browser, build and provider workloads with and without the experiment budget on Engine and Desktop ([container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md), qualification)
- [ ] Record container benchmark numbers for Docker Desktop and arm64 against the regression targets ([container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md), qualification)
- [ ] Measure the latency and backend CPU of one Claude state-poll exec (B18) on Desktop and Linux Engine ([container-state-observation.md](container-state-observation.md))
- [ ] Add a capability-gated container worktree change signal so quiet Files-panel reads use valid state ([container-state-observation.md](container-state-observation.md))
- [ ] Record idle execs and activity, turn and Files-panel latency before and after each observation change ([container-state-observation.md](container-state-observation.md), qualification)
- [ ] Regenerate the deterministic recurring-work baseline; stored step artifacts no longer reproduce ([container-state-observation.md](container-state-observation.md), qualification)
- [ ] Decide whether Claude state polling can be limited to containers running Claude in a terminal ([container-state-observation.md](container-state-observation.md), decision)
- [ ] Qualify container deletion through the ledger (container, volumes, network steps) on Docker Desktop ([environment-and-disk-cleanup.md](environment-and-disk-cleanup.md), qualification)
- [ ] Qualify backend upgrade over old containers and rollback-floor refusal with real releases ([container-platform-qualification.md](container-platform-qualification.md), qualification)

### Design canvas (medium)

- [ ] Run real-container design export with interruptions at each write and association boundary ([design-canvas-qualification.md](design-canvas-qualification.md), qualification)
- [ ] Qualify the design canvas in a real Electron window, including native host-file picking ([design-canvas-qualification.md](design-canvas-qualification.md), qualification)
- [ ] Do a manual screen-reader and keyboard-only accessibility pass over the design canvas ([design-canvas-qualification.md](design-canvas-qualification.md), qualification)
- [ ] Measure design client performance and leaks at 1, 16 and 64 frames, and library open up to 256 canvases ([design-canvas-qualification.md](design-canvas-qualification.md), qualification)
- [ ] Run design mixed-version and migration checks on real old and new binaries ([design-canvas-qualification.md](design-canvas-qualification.md), qualification)
- [ ] Prove with a fault test whether a hung renderer `browser.close()` leaks Chromium, and fix it if so ([design-operation-recovery-edges.md](design-operation-recovery-edges.md))
- [ ] Persist the native session id on design session links through `design_session_link` ([design-agent-conversation-links.md](design-agent-conversation-links.md))
- [ ] Offer Resume conversation for closed design links whose native session can be resumed ([design-agent-conversation-links.md](design-agent-conversation-links.md))
- [ ] Qualify design conversation resume after tab close: same session and no duplicate initial prompt ([design-agent-conversation-links.md](design-agent-conversation-links.md), qualification)
- [ ] Qualify design link recovery for missing or detached sessions and a disconnected backend ([design-agent-conversation-links.md](design-agent-conversation-links.md), qualification)
- [ ] Decide whether design conversation links should survive native tab closure ([design-agent-conversation-links.md](design-agent-conversation-links.md), decision)

### MCP (medium)

- [x] Update Pi terminal MCP and sign-in capabilities for Pi 1.2.0's built-in CLI MCP extension ([mcp-management.md](mcp-management.md))
- [ ] Implement OpenCode MCP application with `applied` evidence and trace how its OAuth completes ([mcp-management.md](mcp-management.md))
- [ ] Prove Codex reload reaches existing threads, add thread-level evidence, and page `mcpServerStatus/list` ([mcp-management.md](mcp-management.md))
- [ ] Join saved MCP entries to live rows by native name plus target and runtime identity ([mcp-management.md](mcp-management.md))
- [ ] Redact runtime MCP `error` strings in `normalizeMcp`, not just bound their length ([mcp-management.md](mcp-management.md))
- [ ] Re-derive OpenCode and Grok MCP source and precedence rules from the current pinned binaries ([mcp-management.md](mcp-management.md), qualification)
- [ ] Run a real-browser MCP editor pass after the dialog-layer fix and consider an agent-testing MCP spec ([mcp-management.md](mcp-management.md), qualification)
- [ ] Qualify the read-only container MCP catalogue and remote-browser paths on the Docker real stack ([mcp-management.md](mcp-management.md), qualification)
- [ ] Decide whether to keep or narrow the all-on MCP management rollout once the matrix is filled ([mcp-management.md](mcp-management.md), qualification)
- [ ] Verify when running Claude account sessions see editor writes; warn that account-home servers are overwritten ([mcp-management.md](mcp-management.md), verify)
- [x] Decide which Pi disable spelling the editor writes and whether to migrate `disabled: true` entries ([mcp-management.md](mcp-management.md), decision)
- [ ] Treat a host Pi project `mcp.json` as loaded when the environment's execution policy turns project resources on ([mcp-management.md](mcp-management.md))
- [ ] Build a durable per-environment MCP overlay and enable container MCP writes ([mcp-environment-delivery.md](mcp-environment-delivery.md))
- [ ] Stage `~/.cursor/mcp.json` into containers and retire Cursor's `blocked-policy` delivery branch ([mcp-environment-delivery.md](mcp-environment-delivery.md))
- [ ] Show MCP execution location and allowlist warnings; gate container or remote sign-in on callback reachability ([mcp-environment-delivery.md](mcp-environment-delivery.md))
- [ ] Qualify that Pi and Cursor MCP delivery respects opt-outs, size bounds, symlink rules and modes ([mcp-environment-delivery.md](mcp-environment-delivery.md), qualification)

### Control MCP (medium)

- [x] Add JSON Schema inputs, capabilities and confirmation classes for every public action, and test handlers against them ([control-mcp-voice-surface.md](control-mcp-voice-surface.md))
- [ ] Dispatch public actions in-process from Control MCP under a per-credential authority, and scope `run.get` to it ([control-mcp-voice-surface.md](control-mcp-voice-surface.md))
- [ ] Add named, scoped Control MCP operator credentials with profiles, and filter `tools/list` by credential ([control-mcp-voice-surface.md](control-mcp-voice-surface.md))
- [ ] Add the Control MCP gateway (`find_actions`, `describe_action`, `run_action`, `run_status`) with confirmation tokens ([control-mcp-voice-surface.md](control-mcp-voice-surface.md))
- [ ] Add the voice core tools with spoken result summaries, within an 8,000-byte `tools/list` budget ([control-mcp-voice-surface.md](control-mcp-voice-surface.md))
- [ ] Add an `attention.list` public action and CLI command for proactive voice notifications ([control-mcp-voice-surface.md](control-mcp-voice-surface.md))
- [ ] Rebase the operator MCP tools on public actions, and add `ticket.*` and `mail.*` public actions with CLI commands ([control-mcp-voice-surface.md](control-mcp-voice-surface.md))
- [ ] Add a public-action, CLI and MCP parity test ([control-mcp-voice-surface.md](control-mcp-voice-surface.md))
- [ ] Qualify a local realtime voice client end to end: latency, target resolution and token use ([control-mcp-voice-surface.md](control-mcp-voice-surface.md), qualification)
- [x] Decide MCP credential authority and storage, and voice confirmation rules ([control-mcp-voice-surface.md](control-mcp-voice-surface.md), decision)
- [ ] Decide hosted-voice access (local relay only, or the remote gateway) for Control MCP ([control-mcp-voice-surface.md](control-mcp-voice-surface.md), decision)

### Agent engines and provider SDKs (medium)

- [ ] Decide Claude `permission-grant` amendments and add a permission-rule list and revoke surface first ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md))
- [ ] Derive Grok approval kinds from ACP `toolCall.kind` (execute as command, edit as file-change) ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md))
- [ ] Pause countdowns in Claude tmux mode (hook-script hold sidecar, hook `timeout` above the ceiling) ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md))
- [ ] Retire the Cursor, Pi and ACP policy env overrides and make `cursorMcpServers` follow the session policy ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md))
- [ ] Raise and answer an MCP elicitation in the browser, reload mid-question, and confirm it rehydrates ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), qualification)
- [ ] Run the Docker agent suite for the Cursor and Pi container execution-policy cells ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), qualification)
- [ ] Verify every bridge has per-kind park, render, resolve and fail-closed timeout interaction tests ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), verify)
- [ ] Verify whether a container Cursor session loads the repository's `.cursor/mcp.json` today ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), verify)
- [ ] Decide whether Claude MCP OAuth sign-in uses parked `mcp-url` elicitations or a separate MCP flow ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), decision)
- [ ] Retire Claude per-turn bookkeeping (continuation watchdog, `backgroundTaskControls`) with the warm runtime ([mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md))
- [ ] Steer long Claude and Cursor turns, switch environment, return and reload; confirm the snapshot restores it ([mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md), qualification)
- [ ] Measure Claude turn-start and follow-up first-token latency before and after the warm runtime changes ([mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md), qualification)
- [ ] Move session title generation into a backend title service and delete the Codex and Claude bridge generators ([session-titles-and-history.md](session-titles-and-history.md))
- [ ] Adopt Codex `thread/reverted` by trimming the served transcript and remove it from the ignore list ([session-titles-and-history.md](session-titles-and-history.md))
- [ ] Rehydrate Claude subagent detail on resume with `getSubagentMessages()` ([session-titles-and-history.md](session-titles-and-history.md))
- [ ] Fork and rewind on Codex, Pi and Cursor fixtures, reload, and confirm resume-list branches and transcripts ([session-titles-and-history.md](session-titles-and-history.md), qualification)
- [ ] Emit the `auth` notice from Claude `auth_status` and Codex `authRecoveryStarted|Completed` ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md))
- [ ] Point Claude's needs-auth state at the backend `claude auth login` flow instead of the terminal hint ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md))
- [ ] Add a session-free settings auth card per enabled platform, built from `NativeAgentAuthStatus` ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md))
- [ ] Add OpenCode in-app sign-in: API keys via a secret-input interaction, OAuth via `provider.oauth.*` ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md))
- [ ] Reconcile the active account when a container agent terminal opens, or say in the UI that it lags ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md))
- [ ] Show each auth state from fixtures in the per-session card and, later, the settings card ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md), qualification)
- [ ] Run a Codex sign-out then sign-in round trip on a fixture profile with Codex credentials ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md), qualification)
- [ ] Confirm an expired Claude login mid-turn shows the `auth` notice and actionable readiness, not a spawn failure ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md), qualification)
- [ ] Migrate reasoning and speed axes onto generic `parameters`, or record the decision to keep both models ([composer-model-parameters.md](composer-model-parameters.md))
- [ ] Change an extra Cursor model axis, send a turn, reload, and confirm the value returns from the backend ([composer-model-parameters.md](composer-model-parameters.md), qualification)
- [ ] Re-arm pending Claude permissions on (re)initialize via `pending_permission_requests` and `reinitialize()` ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Surface Claude MCP permission provenance (`McpServerProvenance`) in the shared interaction card ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Remove the legacy `DELETE` close fallback and `bridge-upgrade-required` path after the support window ([session-lifecycle-consistency.md](session-lifecycle-consistency.md))
- [ ] Close a Cursor tab during cold startup and during a run, switch away, return and reload ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), qualification)
- [ ] Interrupt a Pi prompt before acceptance, switch away, return and reload; status settles, next prompt runs ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), qualification)
- [ ] Restore an assigned Grok tab image draft in the browser once the Grok CLI connects ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), qualification)
- [ ] Check large-transcript recovery in the browser after Cursor persistence shedding ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), qualification)
- [ ] Leave an approval pending in an inactive environment, close and reload; no card returns actionable ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), qualification)
- [ ] Verify an attachment-only Cursor or Grok draft survives a backend restart without losing its image ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), verify)

### Transcripts, observation and bandwidth (medium)

- [ ] Range-bound Claude cold hydration with SDK `limit`/`offset`, or record full hydration as the accepted cost ([transcript-history-efficiency.md](transcript-history-efficiency.md))
- [ ] Add harness workloads for activity sweep, file-tree cache, reviewer/progress probes and checkpoints ([transcript-history-efficiency.md](transcript-history-efficiency.md))
- [ ] Add heap/RSS and event-loop-lag reporting to the efficiency harness ([transcript-history-efficiency.md](transcript-history-efficiency.md))
- [ ] Decide whether to keep, cache or remove the joined sync-v1 history fallback and pre-`/transcript` reads ([transcript-history-efficiency.md](transcript-history-efficiency.md))
- [ ] Qualify a live Grok/ACP session through the v2 transcript summary, detail and page routes ([transcript-history-efficiency.md](transcript-history-efficiency.md), qualification)
- [ ] Run Cursor past producer trim thresholds while inactive; check window, sub-agents and controls ([transcript-history-efficiency.md](transcript-history-efficiency.md), qualification)
- [ ] Qualify transcript efficiency in Electron and Docker environments with real providers ([transcript-history-efficiency.md](transcript-history-efficiency.md), qualification)
- [ ] Profile browser long tasks, input latency and heap/RSS at an 8 MiB retained history ([transcript-history-efficiency.md](transcript-history-efficiency.md), qualification)
- [ ] Measure activity-sweep p50/p95 for 1, 10 and 100 sessions against real bridges ([transcript-history-efficiency.md](transcript-history-efficiency.md), qualification)
- [ ] Re-measure display-tail cost and maximum checkpoint age with workload d now tails are SQLite rows ([transcript-history-efficiency.md](transcript-history-efficiency.md), qualification)
- [ ] Verify whether Grok's ACP `session/new` Invalid params rejection is fixed by #874 ([transcript-history-efficiency.md](transcript-history-efficiency.md), verify)
- [ ] Build the remote baseline matrix: SSE in body and on modes vs terminal WebSocket, normal and constrained ([remote-client-bandwidth.md](remote-client-bandwidth.md), qualification)
- [ ] Check gateway `on` mode streams SSE incrementally across direct, proxied, replay, idle and non-gzip cases ([remote-client-bandwidth.md](remote-client-bandwidth.md), qualification)
- [ ] Verify whether Tailscale Serve buffers or re-encodes SSE before using it as the proxied case ([remote-client-bandwidth.md](remote-client-bandwidth.md), verify)
- [ ] Verify gateway and terminal WebSocket suites cover the Phase 1 no-leak exit criteria ([remote-client-bandwidth.md](remote-client-bandwidth.md), verify)
- [ ] Subscribe the backend to HTTP-bridge event streams and set `idleBackoffWakeup` per provider ([native-agent-idle-observation.md](native-agent-idle-observation.md))
- [ ] Announce Claude background-task and Codex async-question/terminal changes, then qualify quiet backoff ([native-agent-idle-observation.md](native-agent-idle-observation.md))
- [ ] Mark mail presence stale or unknown before any HTTP-bridge observation group backs off ([native-agent-idle-observation.md](native-agent-idle-observation.md))
- [ ] Decide when the Codex circuit breaker closes and make its backoff sleep cancellable on shutdown ([client-reconnect-and-freshness.md](client-reconnect-and-freshness.md))
- [ ] Expose gateway and desktop transport connection state and drive `ReadCoordinator.setDisconnected` ([client-reconnect-and-freshness.md](client-reconnect-and-freshness.md))
- [ ] Show stale, degraded, unsupported and container remote freshness in PR, diff-badge and Files views ([client-reconnect-and-freshness.md](client-reconnect-and-freshness.md))
- [ ] Reset the coordinator panel's `legacyRef` capability when the active connection changes ([client-reconnect-and-freshness.md](client-reconnect-and-freshness.md))
- [ ] Run an outage workload with several tabs and terminals showing reconnects spread out ([client-reconnect-and-freshness.md](client-reconnect-and-freshness.md), qualification)
- [ ] Re-run exact terminal recovery under backpressure after the terminal reconnect backoff changes ([client-reconnect-and-freshness.md](client-reconnect-and-freshness.md), qualification)
- [ ] Count OpenCode SDK requests as `provider-request` and decide whether direct `fs` reads count ([recurring-work-qualification.md](recurring-work-qualification.md))
- [ ] Drive multi review in the recurring baseline workflows harness ([recurring-work-qualification.md](recurring-work-qualification.md))
- [ ] Remove `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and the whole-store drivers domain by domain after soak ([recurring-work-qualification.md](recurring-work-qualification.md))
- [ ] Remove `ORKESTRATOR_NATIVE_OBSERVATION_SHARING` and its desktop allowlist entry after soak ([recurring-work-qualification.md](recurring-work-qualification.md))
- [ ] Check the iOS wrapper's read-coordinator hidden pause and resume across backgrounding and screen lock ([recurring-work-qualification.md](recurring-work-qualification.md), qualification)
- [ ] Qualify `HostSuspendDetector` with a real host suspend and resume ([recurring-work-qualification.md](recurring-work-qualification.md), qualification)
- [ ] Soak add, remove, stop and restart cycles; confirm counts return to baseline with no guard lines ([recurring-work-qualification.md](recurring-work-qualification.md), qualification)
- [ ] Qualify two clients with one disconnected, restarts at durable boundaries, and an older backend ([recurring-work-qualification.md](recurring-work-qualification.md), qualification)
- [x] Verify that `cache-hit` attribution fully explains `storageReads` = 0 by reporting `storage-stat` ([recurring-work-qualification.md](recurring-work-qualification.md), verify)
- [ ] Charge `StorageDatabase.rows()` reads and workflow-result index hits as storage reads or stats ([recurring-work-qualification.md](recurring-work-qualification.md))

### Multi Review (medium)

- [ ] Remove the Multi Review rollback gates (`evidencePermits`, `adaptiveScheduling`, `WorkflowDueScheduler`) ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md))
- [ ] Retire the reviewer-transcript compatibility fallback once no reviewer platform reaches it ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md))
- [ ] Add seeded randomised interleaving tests across concurrent reviewers (commits, cancellation, fence loss) ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md))
- [ ] Add a production sink for `recordEfficiency` or stop treating rollout observation as a gate ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md))
- [ ] Run a mixed real-provider Multi Review panel at 8 to 32 reviewers, recording caps, latency and RSS ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), qualification)
- [x] Count Multi Review fence checks per pass at 8 to 32 reviewers, before and after the per-row fix ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), verify)
- [x] Decide whether Multi Review fence reads need the cross-process mutation lease at all ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), decision)
- [ ] Add a content-free reviewer overlap metric from `reviewSourceIds` per run and reviewer position ([multi-review-panel-value.md](multi-review-panel-value.md))
- [ ] Check in a synthetic or redacted Multi Review evaluation corpus covering agreement, conflicts and limits ([multi-review-panel-value.md](multi-review-panel-value.md))
- [ ] Capture per-reviewer `cacheReadTokens` alongside `tokenCount` ([multi-review-panel-value.md](multi-review-panel-value.md))
- [ ] Measure prefix-cache reads for reviewers 2..N against reviewer 1 on providers that report them ([multi-review-panel-value.md](multi-review-panel-value.md), qualification)

### Coordinator and agent mail (medium)

- [ ] Decide whether Claude on Windows stays offered at the default coordinator safety level ([coordinator-read-only-adapters.md](coordinator-read-only-adapters.md))
- [ ] Disable command-backed project MCP servers for OpenCode coordinators if it must reach `enforced` ([coordinator-read-only-adapters.md](coordinator-read-only-adapters.md))
- [ ] Decide whether `provider-configured` is an acceptable final coordinator tier for OpenCode and Cursor ([coordinator-read-only-adapters.md](coordinator-read-only-adapters.md), decision)
- [ ] Add the live async scenario: async launch, queue before mail, one carrier, one silent-worker notice ([coordinator-live-conformance.md](coordinator-live-conformance.md))
- [ ] Require every `enforced` coordinator platform to appear on the live suite's platform list in tests ([coordinator-live-conformance.md](coordinator-live-conformance.md))
- [ ] Run the ten-message peer scenario between two environments with Wake peers on ([coordinator-live-conformance.md](coordinator-live-conformance.md), qualification)
- [ ] Confirm Grok Orkestrator mail tools auto-allow under both naming forms on the pinned Grok build ([coordinator-live-conformance.md](coordinator-live-conformance.md), qualification)
- [ ] Verify Cursor and Grok mailbox identity, injection, coordinator wake, resume and token rotation live ([coordinator-live-conformance.md](coordinator-live-conformance.md), qualification)
- [ ] Decide whether Wake peers stays off by default and align `agent-messaging.md` with the code ([coordinator-live-conformance.md](coordinator-live-conformance.md), decision)
- [ ] Auto-close an unassigned, empty-draft coordinator conversation when a new one is created ([coordinator-consistency-gaps.md](coordinator-consistency-gaps.md))

### Backend structure (medium)

- [ ] Introduce `StorageContext` for the database, atomic scope, primitives and changes; document lease order ([storage-service-repositories.md](storage-service-repositories.md))
- [ ] Extract the leaf storage repositories: preview services, agent mail, Kanban, drafts, public operations ([storage-service-repositories.md](storage-service-repositories.md))
- [ ] Extract the entangled storage repositories, replacing abstract hooks with constructor dependencies ([storage-service-repositories.md](storage-service-repositories.md))
- [ ] Delete the empty storage `extends` chain and `StorageBase`, and remove the pinned chain entry ([storage-service-repositories.md](storage-service-repositories.md))
- [x] Verify every `saveJson` call site is under a lease, beyond the text-sweep match ([storage-service-repositories.md](storage-service-repositories.md), verify)
- [ ] Extract `CatalogCache` (model and command catalogue caches) from `NativeAgentService` ([native-agent-service-collaborators.md](native-agent-service-collaborators.md))
- [ ] Extract `TranscriptProjection` state and most of `native-agent-service-projection.ts` ([native-agent-service-collaborators.md](native-agent-service-collaborators.md))
- [ ] Extract `InteractionTracker` from the native agent service layers ([native-agent-service-collaborators.md](native-agent-service-collaborators.md))
- [ ] Extract `PromptQueueDispatcher` and `LaunchActivityReconciler`, keeping ordering against session leases ([native-agent-service-collaborators.md](native-agent-service-collaborators.md))
- [ ] Remove the empty native agent service layers so the service is one plain class ([native-agent-service-collaborators.md](native-agent-service-collaborators.md))
- [ ] Add direct `createPromptStreamState` tests for row identity, bounds, flush order and steer anchoring ([claude-bridge-prompt-stream-state.md](claude-bridge-prompt-stream-state.md))
- [ ] Move wave 1 leaf domains into folders, index mcp-management and public-api, place keyed-record-format.ts ([backend-core-domain-folders.md](backend-core-domain-folders.md))
- [ ] Move wave 2 mid-tier domains (plan-usage through native-agent) into folders with `index.ts` and lint ([backend-core-domain-folders.md](backend-core-domain-folders.md))
- [ ] Move wave 3 hub domains (terminals, tmux, recurring, containers, environments, storage) into folders ([backend-core-domain-folders.md](backend-core-domain-folders.md))
- [ ] Decide whether `storage` and `native-agent` move before or after their inheritance chains are split ([backend-core-domain-folders.md](backend-core-domain-folders.md), decision)
- [ ] Move the 19 terminal bindings into a `TerminalRuntime` class on `BackendRuntime` ([backend-runtime-state-ownership.md](backend-runtime-state-ownership.md))
- [ ] Move the 18 local-server bindings into `LocalServerRuntime` with injected spawn and terminate ([backend-runtime-state-ownership.md](backend-runtime-state-ownership.md))
- [ ] Move the 9 environment-operation bindings into `EnvironmentOperations` or the lifecycle task tracker ([backend-runtime-state-ownership.md](backend-runtime-state-ownership.md))
- [ ] Delete `commands-runtime-state.ts`, relocate its constants and drop it from the `no-mutable-exports` allowlist ([backend-runtime-state-ownership.md](backend-runtime-state-ownership.md))

### Cross-cutting (medium)

- [ ] Decide and align agent-test binary resolution: document the `PATH` fallback or refuse it ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md))
- [ ] Refresh the live OpenCode spec for the no-default-model and fork-keeps-model fixes ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md))
- [ ] Re-run the Electron terminal input resume spec and confirm Resume keeps the same PTY process ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), qualification)
- [ ] Run the refreshed live OpenCode spec and check whether 1.19 `session.fork` fills `Session.model` ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), qualification)
- [ ] Drive compaction, image and long-tool parts through an inactive environment; confirm they render after reload ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), qualification)
- [ ] Run an OpenCode turn through the inactive path, reload, and record the poll count ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), qualification)
- [ ] Confirm Grok shell terminal output renders inline and survives a reload ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), qualification)
- [ ] Decide whether qualified providers are re-qualified after every agent SDK or CLI upgrade ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), decision)
- [ ] Decide which providers have agent-test credentials and who owns macOS, iOS and two-machine runs ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), decision)
- [ ] Decide whether Docker live suites or a macOS Electron run become scheduled CI jobs ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), decision)
- [ ] Remove the dead prompt-queue claim commands, renderer wrappers, persistence helper and storage methods ([mixed-version-compatibility.md](mixed-version-compatibility.md))
- [ ] Decide the mixed-version support window per client type and record it in an architecture doc ([mixed-version-compatibility.md](mixed-version-compatibility.md), decision)
- [ ] Drive `AddProjectDialog.test.tsx` timers with controlled time instead of real sleeps ([test-suite-and-ci-health.md](test-suite-and-ci-health.md))
- [ ] Fix and re-enable, or delete, the untracked skipped GitHub credential propagation retry test ([test-suite-and-ci-health.md](test-suite-and-ci-health.md))
- [ ] Add `BackendProcess.launch` tests for readiness timeout, invalid auth file and startup races ([test-suite-and-ci-health.md](test-suite-and-ci-health.md))
- [ ] Test `main.ts` window and connection bookkeeping, including the `useConnection` rollback ([test-suite-and-ci-health.md](test-suite-and-ci-health.md))
- [ ] Add a breakpoint-crossing browser spec and check both mobile fixes in a real narrow browser ([mobile-layout-gaps.md](mobile-layout-gaps.md), qualification)
- [x] Keep the panes the mobile switcher hides laid out, so a pane switch keeps the transcript's scroll ([mobile-layout-gaps.md](mobile-layout-gaps.md))
- [ ] Upgrade Electron 44 → 46 before 44 loses support on 2027-03-02; re-test annotation masking on a HiDPI display ([dependency-upgrades.md](dependency-upgrades.md))
- [ ] Burn down the React Compiler lint warnings in `apps/web` and raise each rule back to `error` at zero ([dependency-upgrades.md](dependency-upgrades.md))
- [ ] Decide how to manage the update-manifest signing key before electron-builder 27 ([dependency-upgrades.md](dependency-upgrades.md), decision)

## Low

### Service previews and web annotations (low)

- [ ] Add relay fault tests for an oversized frame and a protocol-version mismatch ([service-preview-rollout.md](service-preview-rollout.md))
- [ ] Optionally add Playwright firefox and webkit projects and dedicated tasks for the opt-in preview suites ([service-preview-rollout.md](service-preview-rollout.md))
- [ ] Offer an Open as service action for legacy URL tabs that map unambiguously to a current service ([service-preview-rollout.md](service-preview-rollout.md))
- [ ] Reword preview code comments that cite deleted plan steps or the old evidence log ([service-preview-rollout.md](service-preview-rollout.md))
- [ ] Run the remaining preview compatibility cases in a real browser (SPA, srcset, source maps, OAuth, IPv6) ([service-preview-rollout.md](service-preview-rollout.md), qualification)
- [ ] Measure disk used by `orkestrator-preview-svc-*` partitions on a long-lived profile ([service-preview-rollout.md](service-preview-rollout.md), verify)
- [ ] Decide whether annotations on legacy URL tabs may keep depending on the legacy route ([service-preview-rollout.md](service-preview-rollout.md), decision)
- [ ] Build the web iframe preview surface: minimal sandbox, honoured framing, top-level fallback, safe postMessage ([embedded-service-previews.md](embedded-service-previews.md))
- [ ] Investigate partitioned (CHIPS) cookies for the `__Host-orkestrator-preview` transport cookie only ([embedded-service-previews.md](embedded-service-previews.md))
- [ ] Build an optional iOS in-app preview in a dedicated `WKWebView` with its own data store ([embedded-service-previews.md](embedded-service-previews.md))
- [ ] Report preview capabilities per surface and never advertise capture or DevTools on browser surfaces ([embedded-service-previews.md](embedded-service-previews.md))
- [ ] Advertise `browserEmbedded` per platform and lift the `browser-embedded` refusal only for passing platforms ([embedded-service-previews.md](embedded-service-previews.md))
- [ ] Qualify embedded previews on real Chromium, Firefox, Safari and `WKWebView` on iPhone and iPad ([embedded-service-previews.md](embedded-service-previews.md), qualification)
- [ ] Qualify embedded previews from both hosted and backend-served client origins ([embedded-service-previews.md](embedded-service-previews.md), qualification)
- [ ] Test embedded previews with private browsing, blocked third-party cookies, denied popups, framed CSP and OAuth ([embedded-service-previews.md](embedded-service-previews.md), qualification)
- [ ] Test embedded previews against malicious postMessage, opener access, grant leakage and cross-service cookies ([embedded-service-previews.md](embedded-service-previews.md), qualification)
- [ ] Test embedded previews across environment switch, reload, iOS background and access expiry or rotation ([embedded-service-previews.md](embedded-service-previews.md), qualification)
- [ ] Decide whether embedded service previews are worth building at all ([embedded-service-previews.md](embedded-service-previews.md), decision)
- [ ] Decide whether a per-platform embedded mode is acceptable if only some browsers pass ([embedded-service-previews.md](embedded-service-previews.md), decision)
- [ ] Decide whether the iOS in-app preview comes before or after the web iframe ([embedded-service-previews.md](embedded-service-previews.md), decision)
- [ ] Record managed-process ownership for backend-started dev servers so the resolver reports `managed-process` ([preview-service-discovery.md](preview-service-discovery.md))
- [ ] Offer user-confirmed re-registration when a dev server moves to the next free port ([preview-service-discovery.md](preview-service-discovery.md))
- [ ] Route chat loopback links through `linkBrowserTarget` with the agent origin if an open-in-tab action is added ([preview-service-discovery.md](preview-service-discovery.md))
- [ ] Add optional version-aware, copyable framework setup hints to the service dialog or diagnostics ([preview-service-discovery.md](preview-service-discovery.md))
- [ ] Qualify seeding and ownership with shared dev ports, reused ports and auto-incremented ports ([preview-service-discovery.md](preview-service-discovery.md), qualification)
- [ ] Add fixture-app routes for a CSS animation, a late web font and an expired sign-in redirect ([web-annotation-qualification.md](web-annotation-qualification.md))
- [ ] Run annotation comparison cases for routes, viewports, unstable content and expired authentication ([web-annotation-qualification.md](web-annotation-qualification.md), qualification)
- [ ] Assign region-crop `parentCaptureId` in Electron main, or remove the field from the contract ([web-annotation-known-limitations.md](web-annotation-known-limitations.md))
- [ ] Add per-capture asset byte sizes to annotation summaries so the review tray matches backend checks ([web-annotation-known-limitations.md](web-annotation-known-limitations.md))
- [ ] Reword annotation code comments that cite deleted plan steps, and add paths for kept documents ([web-annotation-known-limitations.md](web-annotation-known-limitations.md))
- [ ] Add controlled pixel or region diffs with an optional overlay behind their own capability ([web-annotation-extensions.md](web-annotation-extensions.md))
- [ ] Add automatic after-capture that never navigates or reloads the user's active page ([web-annotation-extensions.md](web-annotation-extensions.md))
- [ ] Add development source hints with a self-identifying producer and backend containment checks ([web-annotation-extensions.md](web-annotation-extensions.md))
- [ ] Support annotation anchors inside open shadow roots and same-origin iframes with bounded traversal ([web-annotation-extensions.md](web-annotation-extensions.md))
- [ ] Design and build non-desktop annotation capture via a trusted bridge or a backend-owned browser session ([web-annotation-extensions.md](web-annotation-extensions.md))
- [ ] Design shared-component grouping of annotation notes ([web-annotation-extensions.md](web-annotation-extensions.md))
- [ ] Design issue-tracker export for annotations ([web-annotation-extensions.md](web-annotation-extensions.md))
- [ ] Design multi-user annotation discussion once identity and permissions exist ([web-annotation-extensions.md](web-annotation-extensions.md))
- [ ] Design generated, attributed thread summaries that never replace the latest human instruction ([web-annotation-extensions.md](web-annotation-extensions.md))
- [ ] Qualify each annotation extension that lands with synthetic pages and frame and shadow adversarial cases ([web-annotation-extensions.md](web-annotation-extensions.md), qualification)
- [ ] Decide which annotation extension, if any, to build next ([web-annotation-extensions.md](web-annotation-extensions.md), decision)
- [ ] Qualify pins and Show on page for offscreen, in-modal and late-font layout-shift targets ([web-annotation-qualification.md](web-annotation-qualification.md), qualification)

### CLI and slash commands (low)

- [ ] Add tracked cascade removal to CLI `project remove` that deletes child environments ([cli-command-surface.md](cli-command-surface.md))
- [ ] Add a local-only project initialiser (git init, no remote) for the CLI ([cli-command-surface.md](cli-command-surface.md))
- [ ] Add optional JSONL event-stream following over the gateway SSE for CLI transcripts ([cli-command-surface.md](cli-command-surface.md))
- [ ] Add a declarative CLI apply or scenario DSL if shell composition proves insufficient ([cli-command-surface.md](cli-command-surface.md))
- [ ] Add CLI shell completion ([cli-command-surface.md](cli-command-surface.md))
- [ ] Add opt-in CLI backend auto-start with process ownership and data-directory exclusivity ([cli-command-surface.md](cli-command-surface.md))
- [ ] Replace manual gateway invoke setup in `browser-gateway.spec.ts` with CLI commands where shorter ([cli-command-surface.md](cli-command-surface.md))
- [ ] Measure CLI scenario start-up time, failure latency, flake rate, cleanup failures and token cost ([cli-qualification.md](cli-qualification.md), qualification)
- [ ] Support Claude session-changing commands by adopting the new conversation, or keep them unavailable ([slash-command-catalogue.md](slash-command-catalogue.md))
- [ ] Build a policy-reviewed executor for Codex inline-shell templates, or keep them unavailable ([slash-command-catalogue.md](slash-command-catalogue.md))
- [ ] Add further Orkestrator slash shortcuts beyond `/steer` and `/compact` with qualified semantics ([slash-command-catalogue.md](slash-command-catalogue.md))
- [ ] Update stale SDK pin facts in the OpenCode, Claude and Cursor command owner comments ([slash-command-catalogue.md](slash-command-catalogue.md))
- [ ] Update the pins and tables in `native-agent-commands.md` ("Provider support") and the owner comments after a qualification pass ([slash-command-qualification.md](slash-command-qualification.md), qualification)
- [ ] Check whether any slash-command live runs happened informally after #827 ([slash-command-qualification.md](slash-command-qualification.md), verify)

### Containers and environments (low)

- [ ] Verify whether the container live suites have run since #877 ([container-platform-qualification.md](container-platform-qualification.md), verify)
- [ ] Verify Codex `session_index.jsonl` and Grok `active_sessions.json` / `worktrees.db` paths at current pins ([container-rebuild-state-preservation.md](container-rebuild-state-preservation.md), verify)
- [ ] Decide whether a resumable copy journal is worth its complexity for very large workspaces ([container-rebuild-state-preservation.md](container-rebuild-state-preservation.md), decision)
- [ ] Optionally switch between restricted and full network mode in place instead of requiring a rebuild ([container-network-and-credential-isolation.md](container-network-and-credential-isolation.md))
- [ ] Decide between per-platform regression targets and one reference host with a tolerance ([container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md), decision)
- [ ] Replace per-member source `sha256sum` with an in-process tar hasher after a safety review ([container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md), deferred)
- [ ] Add Bun download-cache BuildKit mounts to `docker/Dockerfile` if image build time matters ([container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md), deferred)
- [ ] Add environment-private dependency cache volumes only if downloads dominate ([container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md), deferred)
- [ ] Speed up container usage samples beyond the `docker stats` sampling interval ([container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md), deferred)
- [ ] Track aggregate per-environment diagnostic log bytes ([container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md), deferred)
- [ ] Route `containerRevertFileCommand` base resolution through `ContainerGitFetchPolicy` or document why not ([container-state-observation.md](container-state-observation.md))
- [ ] Measure a container watcher's process and memory cost against the current walk cost before adopting it ([container-state-observation.md](container-state-observation.md), qualification)
- [ ] Verify the per-exec cost of the Claude state poll (B18) on Docker Desktop ([container-state-observation.md](container-state-observation.md), verify)
- [ ] Decide whether the ~15 s delay for Git-invisible file changes is acceptable against the 6 s budget ([container-state-observation.md](container-state-observation.md), decision)
- [ ] Decide whether ad hoc worktree roots should key their read cache by `realpath` ([container-state-observation.md](container-state-observation.md), decision)
- [ ] Fix the remaining test temp-directory leaks in Pi, Codex and Cursor bridge and worktree-watcher tests ([environment-and-disk-cleanup.md](environment-and-disk-cleanup.md))
- [ ] Optionally surface ledger entries at the cleanup attempt cap in diagnostics or `disk:report` ([environment-and-disk-cleanup.md](environment-and-disk-cleanup.md))
- [ ] Verify which writers still produce `<name>.json.<pid>.tmp` files since the #969 SQLite move ([environment-and-disk-cleanup.md](environment-and-disk-cleanup.md), verify)
- [ ] Decide whether a permanently failing ledger entry blocks re-creating an environment in its namespace ([environment-and-disk-cleanup.md](environment-and-disk-cleanup.md), decision)
- [ ] Decide whether ledger entries at the attempt cap are ever retried, after an upgrade or on user action ([environment-and-disk-cleanup.md](environment-and-disk-cleanup.md), decision)

### Design canvas (low)

- [ ] Decide whether a cross-environment design transfer UI is wanted ([design-canvas-qualification.md](design-canvas-qualification.md), decision)
- [ ] Add library and offscreen design thumbnails as bounded low-priority capture jobs ([design-canvas-qualification.md](design-canvas-qualification.md), deferred)
- [ ] Add a design capture and inspection cache once repeated identical captures are measured ([design-canvas-qualification.md](design-canvas-qualification.md), deferred)
- [ ] Raise `renderWorkers` to two after measuring memory and p95 latency with several environments ([design-canvas-qualification.md](design-canvas-qualification.md), deferred)
- [ ] Add a warm browser-context pool only if context setup dominates after the other work ([design-canvas-qualification.md](design-canvas-qualification.md), deferred)
- [ ] Redesign design record storage only if full-record rewrites dominate on near-limit documents ([design-canvas-qualification.md](design-canvas-qualification.md), deferred)
- [ ] Report `interrupted` instead of `unknown` for restart-interrupted operations on legacy canvases ([design-operation-recovery-edges.md](design-operation-recovery-edges.md))
- [ ] Make a duplicate interrupted between copy commit and source receipt report a truthful outcome ([design-operation-recovery-edges.md](design-operation-recovery-edges.md))
- [ ] Derive design link state from native-agent projections instead of the local pane layout ([design-agent-conversation-links.md](design-agent-conversation-links.md))
- [ ] Drop the `inlineText` path in `planDesignDraft` once the new-tab composer supports annotations ([design-agent-conversation-links.md](design-agent-conversation-links.md))
- [ ] Add a test for two clients resuming the same design link concurrently ([design-agent-conversation-links.md](design-agent-conversation-links.md))

### MCP (low)

- [ ] Implement per-session Grok ACP MCP application and document its collision rules ([mcp-management.md](mcp-management.md))
- [ ] Re-check external MCP edits for OpenCode, container and post-reload Codex runtimes, which no pass polls ([mcp-management.md](mcp-management.md))
- [ ] Stop Claude's no-control MCP fallback collapsing server status to connected or failed ([mcp-management.md](mcp-management.md))
- [ ] Replace the count-only MCP metric tiles for Claude and OpenCode in `AgentInfoButton` ([mcp-management.md](mcp-management.md))
- [ ] Model plugin, team, remote and profile MCP layers only where a passive reader exists ([mcp-management.md](mcp-management.md))
- [ ] Verify how OpenCode MCP OAuth completes after `mcp.auth.start` ([mcp-management.md](mcp-management.md), verify)
- [ ] Get the Claude CLI to stop a server's old process when `setMcpServers` replaces its configuration ([mcp-management.md](mcp-management.md), blocked)
- [ ] Consider bounded project-file MCP writes inside `volume-v1` containers without an overlay ([mcp-environment-delivery.md](mcp-environment-delivery.md))
- [ ] Point the recreate copy at rebuild once confirmed, and add a host-defaults re-import operation ([mcp-environment-delivery.md](mcp-environment-delivery.md))
- [ ] Audit staged Claude, Grok and OpenCode MCP configs for host-absolute `command` and `cwd` paths ([mcp-environment-delivery.md](mcp-environment-delivery.md))
- [ ] Qualify that the MCP overlay and tombstones survive backend restart, stop and start, and preserving rebuilds ([mcp-environment-delivery.md](mcp-environment-delivery.md), qualification)
- [ ] Qualify that container-private MCP edits leave host files byte-for-byte unchanged ([mcp-environment-delivery.md](mcp-environment-delivery.md), qualification)
- [ ] Qualify that an in-container MCP edit produces a conflict that can be imported ([mcp-environment-delivery.md](mcp-environment-delivery.md), qualification)
- [ ] Qualify that environment deletion removes only its own MCP overlay and jobs ([mcp-environment-delivery.md](mcp-environment-delivery.md), qualification)
- [ ] Qualify the MCP execution and callback scope shown for a remote browser and a restricted network ([mcp-environment-delivery.md](mcp-environment-delivery.md), qualification)
- [ ] Qualify that MCP environment delivery never interrupts terminal work or background native sessions ([mcp-environment-delivery.md](mcp-environment-delivery.md), qualification)
- [ ] Decide whether MCP overlay data is included in rebuild recovery copies ([mcp-environment-delivery.md](mcp-environment-delivery.md), decision)

### Agent engines and provider SDKs (low)

- [ ] Set Claude `askUserQuestion.previewFormat` once the question card's plain or html mode is decided ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md))
- [ ] Delete the unused OpenCode `autoAnswerRequests` branch and move its tests onto the journaled path ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md))
- [ ] Let a Grok pause outlive the 30-minute turn deadline and Grok's own question timeout ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md))
- [ ] Show `hold` in `session interactions list` and add a CLI and public API hold action ([agent-interactions-and-permissions.md](agent-interactions-and-permissions.md))
- [ ] Read the Claude model catalogue from `initializationResult()` on the live runtime, not a throwaway query ([mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md))
- [ ] Use `startup()` / `WarmQuery` to warm the first Claude turn in an environment, and measure it ([mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md))
- [ ] Add Cursor `SendOptions.local.force` for wedged agents only if `recoverActiveRun` shows them ([mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md))
- [ ] Add OpenCode native steer once OpenCode 2.x offers `delivery: steer` and an expected-turn precondition ([mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md), blocked)
- [ ] Enable Grok steer once ACP gains a mid-turn input equivalent ([mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md), blocked)
- [ ] Use Codex `thread/archive` / `unarchive` when a user removes a session from the resume list ([session-titles-and-history.md](session-titles-and-history.md))
- [ ] Read Cursor `SDKAgentInfo.archived` and hide archived agents in the resume list by default ([session-titles-and-history.md](session-titles-and-history.md))
- [ ] Decide whether to offer Claude message-level rewind through the SDK resume-at options ([session-titles-and-history.md](session-titles-and-history.md))
- [ ] With the backend title service, confirm generated titles, first-message fallback and push-failure retention ([session-titles-and-history.md](session-titles-and-history.md), qualification)
- [ ] Send Codex `account/login/cancel` when an in-tab sign-in is abandoned ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md))
- [ ] Update `oauthAccount` in a running container's `$HOME/.claude.json` during account reconcile ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md))
- [ ] Report or re-link account entries whose shared symlink a CLI atomic-rename replaced with a file ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md))
- [ ] Verify with a live switch mid-turn that usage windows no longer fold into the new account's card ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md), verify)
- [ ] Stop older container images restoring the host login on restart by retiring the legacy host-mount path ([agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md), blocked)
- [ ] Source Codex reasoning `summary` and `personality` from a setting, or remove the bridge plumbing ([composer-model-parameters.md](composer-model-parameters.md))
- [ ] Decide whether Claude `acceptEdits` joins the `mode` axis, or stop forwarding `permissionMode` ([composer-model-parameters.md](composer-model-parameters.md))
- [ ] Add a backend per-environment `maxBudgetUsd` setting mapped to a stopped notice, or drop the option ([composer-model-parameters.md](composer-model-parameters.md))
- [ ] After the axis migration, round trip reasoning and speed controls on every platform through a reload ([composer-model-parameters.md](composer-model-parameters.md), qualification)
- [ ] Make `checkHttpHealth` reject HTML so an OpenCode 2.x server is never reported healthy ([opencode-v2.md](opencode-v2.md))
- [ ] Recheck upstream OpenCode 2.x since 2.0.18: new release, storage policy, steer precondition, MCP endpoints ([opencode-v2.md](opencode-v2.md), verify)
- [ ] Migrate to OpenCode 2.x as a separate `opencode2` provider once the upstream readiness gate opens ([opencode-v2.md](opencode-v2.md), deferred)
- [ ] Delete the dead Claude `isSdkCompactBoundaryMessage` guard and its four unused imports ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md))
- [ ] Run one billed Grok turn, compare `costUsdTicks` with the billed amount, and record the unit ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), qualification)
- [ ] Recheck each deferred SDK candidate, including Grok 1.0.52 elicitation and cost, against current pins ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), verify)
- [ ] Evaluate Claude SDK `additionalDirectories`, inline `agents` and the `skills` option ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Decide whether `createSdkMcpServer()` replaces the bearer-token loopback for Orkestrator control tools ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Add MCP Apps widgets for Claude and Codex after a provider-neutral tool-card field exists ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Evaluate Codex `config/*` writes, `command/exec`, `fs/*`, `feedback/upload` and `gitDiffToRemote` ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Support Codex dynamic tools instead of answering `item/tool/call` as a failure ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Project Codex managed application and network requirements once a provider-neutral surface exists ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Add Pi compaction controls: custom instructions, `abortCompaction` and an auto-compaction toggle ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Add a second ACP agent (Gemini CLI or Claude-over-ACP) through an `AcpProviderConfig` record ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Accept Grok `costUsdTicks` as cost once a billed turn confirms the tick unit ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Evaluate the unused OpenCode 1.x `find.*` file search on the surface the provider already drives ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), deferred)
- [ ] Map Cursor `askQuestion` to a `question` interaction once the SDK adds a typed answer path ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), blocked)
- [ ] Add Grok MCP elicitation UI once Grok exposes a supported reverse-request contract ([provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), blocked)
- [ ] Add an opt-in real-stack spec that closes a tab, finds the conversation and resumes it per provider ([session-lifecycle-consistency.md](session-lifecycle-consistency.md))
- [ ] Saturate Cursor steer in the browser: 429 refusal, runtime notice, turn continues, draft survives reload ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), qualification)
- [ ] Show the `bridge-upgrade-required` restart toast for an old Claude bridge using a stale-bundle fixture ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), qualification)
- [ ] Decide whether to align idle cancel and abort responses across Claude, Codex and ACP ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), decision)
- [ ] Decide whether Claude, Codex, Pi and ACP publish bounded-state occupancy in runtime health ([session-lifecycle-consistency.md](session-lifecycle-consistency.md), decision)

### Transcripts, observation and bandwidth (low)

- [ ] Record source and normalise phase timing for state and discovery reads ([transcript-history-efficiency.md](transcript-history-efficiency.md))
- [ ] Verify whether Claude SDK `getSessionMessages` `limit`/`offset` avoids a full JSONL parse ([transcript-history-efficiency.md](transcript-history-efficiency.md), verify)
- [ ] Restructure frontend retained history into immutable pages if 8 MiB profiling shows long tasks ([transcript-history-efficiency.md](transcript-history-efficiency.md), deferred)
- [ ] Measure bridge-to-backend snapshot bytes and CPU before designing incremental bridge part deltas ([transcript-history-efficiency.md](transcript-history-efficiency.md), deferred)
- [ ] Add per-message provider revisions so projection can skip its per-row comparison walk ([transcript-history-efficiency.md](transcript-history-efficiency.md), deferred)
- [ ] Change at most one remote default (compression mode or terminal transport) per recorded decision ([remote-client-bandwidth.md](remote-client-bandwidth.md))
- [ ] Add a client-local data-saving preference that feeds the read coordinator as a scheduling input ([remote-client-bandwidth.md](remote-client-bandwidth.md))
- [ ] Trial a 1 s active native cadence and quiet backoff for Files panel and reviewer under data-saving ([remote-client-bandwidth.md](remote-client-bandwidth.md))
- [ ] Keep approvals, errors and dispatch controls responsive under data-saving through small status reads ([remote-client-bandwidth.md](remote-client-bandwidth.md))
- [ ] Reduce or detach hidden terminal presentation subscriptions where exact snapshot recovery exists ([remote-client-bandwidth.md](remote-client-bandwidth.md))
- [ ] Prototype negotiated `permessage-deflate` for terminal WebSockets only if Phase 2 shows large payloads ([remote-client-bandwidth.md](remote-client-bandwidth.md))
- [ ] Measure terminal HTTP/SSE and opt-in WebSocket bytes separately before any WebSocket compression ([remote-client-bandwidth.md](remote-client-bandwidth.md), qualification)
- [ ] Measure encoded bytes of transcript part patches and of several remote clients on one session ([remote-client-bandwidth.md](remote-client-bandwidth.md), qualification)
- [ ] Measure data-saving mode bytes and request counts against the quiet-backoff baseline ([remote-client-bandwidth.md](remote-client-bandwidth.md), qualification)
- [ ] Share native session reads across hook instances through a store keyed by session and view window ([native-agent-idle-observation.md](native-agent-idle-observation.md))
- [ ] Decide whether to retire the B08 interaction observer or fold it into the observation broker ([native-agent-idle-observation.md](native-agent-idle-observation.md), decision)
- [ ] Adopt jittered `reconnectDelayMs` for terminal WebSocket reconnects and denied-subscription retries ([client-reconnect-and-freshness.md](client-reconnect-and-freshness.md))
- [ ] Check in a real browser that freshness indicators appear, clear and do not flicker ([client-reconnect-and-freshness.md](client-reconnect-and-freshness.md), qualification)
- [ ] Decide whether to instrument or drop the 19 uninstrumented `external(...)` catalogue kinds ([recurring-work-qualification.md](recurring-work-qualification.md))
- [ ] Commit the live idle A/B procedure as a script or documented commands ([recurring-work-qualification.md](recurring-work-qualification.md))
- [ ] Decide whether `ORKESTRATOR_RECURRING_METRICS` stays as a permanent off switch ([recurring-work-qualification.md](recurring-work-qualification.md))
- [ ] Verify whether flake 0177 (`recurring-baseline.test.ts` timeout) is load-only ([recurring-work-qualification.md](recurring-work-qualification.md), verify)
- [ ] Decide whether to measure the Claude terminal-state poll (B18) before other recurring work ([recurring-work-qualification.md](recurring-work-qualification.md), decision)
- [ ] Decide settled check-rollup backoff for `pr-check-rollup` (60 s) from live data ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Decide a container-scoped PR cooldown from live data ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Tune the container fetch failure ladder (5 to 30 min) from `git-fetch-container` metrics ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Tune the admission pool limits from live data ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Re-prioritise a queued discovery scan when an interactive read joins it in `WorkAdmissionPool` ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Decide a coarser `mail-retention` deadline than 60 s from live data ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Share Docker availability polling across clients (`DOCKER_AVAILABILITY_POLL_INTERVAL_MS`, 60 s) ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Lengthen the design canvas cursor check interval after missed-final-hint recovery is qualified ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Share one visible display clock between `useElapsedTimer` and `usePromptDeadline` ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Avoid the validation reader's in-environment `bun` spawn on every poll ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Read one feature plan's row in the keyed planning pass instead of decoding the whole store ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Demand-gate interactive tmux capture (B19, `tmux-interactive.ts`) ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Split the validation worker's 500 ms liveness write from result writes (B20) with crash-recovery proof ([recurring-work-qualification.md](recurring-work-qualification.md), deferred)
- [ ] Bring `RECURRING_JOB_CATALOGUE` and the recurring harness limitation text back in line with the code (L07, C13, `coordinator-repair`) ([recurring-work-qualification.md](recurring-work-qualification.md))

### Multi Review (low)

- [ ] Report referenced artifact bytes in Multi Review evidence verification counts ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md))
- [ ] Add an opt-in large-evidence Multi Review benchmark with real hashing ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md))
- [ ] Verify whether any supported reviewer platform still reaches the reviewer-transcript fallback ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), verify)
- [ ] Verify whether the browser and agent suites were ever run for the #833 launcher and reviewer tab ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), verify)
- [ ] Design a backend-owned, content-addressed review evidence store with read-only mounts ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), deferred)
- [ ] Add provider batch status observation once a bridge exposes batch settlement status ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), deferred)
- [ ] Add hierarchical map/reduce consolidation only if real workflows exceed the 640 KiB budget ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), deferred)
- [ ] Add `admissionState` / `queuedAt` reviewer fields only if queue time becomes user-visible ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), deferred)
- [ ] Skip identical Multi Review renderer refetches using per-workflow revisions in resource-change events ([multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), deferred)
- [ ] Verify whether any real-provider consolidation comparison was ever run ([multi-review-panel-value.md](multi-review-panel-value.md), verify)
- [ ] Add Quick, Balanced and Thorough Multi Review presets that expand into editable reviewer rows ([multi-review-panel-value.md](multi-review-panel-value.md), deferred)
- [ ] Add optional, non-exclusive review lenses as a shared-protocol enum ([multi-review-panel-value.md](multi-review-panel-value.md), deferred)
- [ ] Add opt-in adaptive stopping with a minimum panel and a measured novelty rule ([multi-review-panel-value.md](multi-review-panel-value.md), deferred)
- [ ] Revisit the default two-reviewer Multi Review panel ([multi-review-panel-value.md](multi-review-panel-value.md), deferred)
- [ ] Show findings from a Multi Review reviewer that is still running, through a bounded partial-findings channel ([multi-review-flow-graph.md](multi-review-flow-graph.md))
- [ ] Show queue position and expected start for queued Multi Review reviewers ([multi-review-flow-graph.md](multi-review-flow-graph.md))
- [ ] Add a bounded transcript tail for the preparation, consolidation and Fix sessions in the flow graph inspector ([multi-review-flow-graph.md](multi-review-flow-graph.md))
- [ ] Add flow graph zoom controls and keep zoom and pan between visits ([multi-review-flow-graph.md](multi-review-flow-graph.md))

### Coordinator and agent mail (low)

- [ ] Add an argv0 deny for `sleep` on the Codex coordinator profile if live runs show Codex using it ([coordinator-read-only-adapters.md](coordinator-read-only-adapters.md))
- [ ] Raise Grok above `advisory` only after adding a real read-only gate in the ACP bridge ([coordinator-read-only-adapters.md](coordinator-read-only-adapters.md), deferred)
- [ ] Raise the Cursor coordinator tier only once a probe can prove a denied tool did not run ([coordinator-read-only-adapters.md](coordinator-read-only-adapters.md), blocked)
- [ ] Extend the coordinator poll guard to `list_environments` if live runs show coordinators polling it ([coordinator-consistency-gaps.md](coordinator-consistency-gaps.md))
- [ ] Add an optional `data-mail-kind` to injected mail carriers so system and tab mail style apart ([coordinator-consistency-gaps.md](coordinator-consistency-gaps.md))
- [ ] Hide coordinator favourites for platforms the conversation cannot use under `platformFilter` ([coordinator-consistency-gaps.md](coordinator-consistency-gaps.md))
- [ ] Verify how the coordinator favourites view renders a favourite whose platform is filtered out ([coordinator-consistency-gaps.md](coordinator-consistency-gaps.md), verify)
- [ ] Decide whether the sidebar working/waiting icon moves from `agentActivityState` onto the agent registry ([coordinator-consistency-gaps.md](coordinator-consistency-gaps.md), decision)
- [ ] Design copying uncommitted root changes into a worker as a user-selected patch ([coordinator-consistency-gaps.md](coordinator-consistency-gaps.md), deferred)
- [ ] Design coordinator MCP for terminal, browser, pane editing, reviewer subtabs, looped review and feature plans ([coordinator-consistency-gaps.md](coordinator-consistency-gaps.md), deferred)

### Backend structure (low)

- [ ] Move protected-member test casts onto repository APIs as each store moves ([storage-service-repositories.md](storage-service-repositories.md), qualification)
- [ ] Extend the storage writer guard to raw `StorageDatabase` writers outside the `StorageService` chain ([storage-service-repositories.md](storage-service-repositories.md))
- [ ] Move the six `queue*` parsers into a module of pure functions ([native-agent-service-collaborators.md](native-agent-service-collaborators.md))
- [ ] Split `applyPartialAssistantMessage` into one function per `stream_event` type ([claude-bridge-prompt-stream-state.md](claude-bridge-prompt-stream-state.md))
- [ ] Move the three plan-mode flags from `PromptStreamState` to `TurnState` and fix the stale comment ([claude-bridge-prompt-stream-state.md](claude-bridge-prompt-stream-state.md))
- [ ] Optionally convert the prompt stream factory into a `PromptStream` class with private fields ([claude-bridge-prompt-stream-state.md](claude-bridge-prompt-stream-state.md))
- [ ] Move the `commands` domain into a folder after `commands-runtime-state.ts` is deleted ([backend-core-domain-folders.md](backend-core-domain-folders.md))
- [ ] Re-measure and record the type-level import cycle across `core/` ([backend-core-domain-folders.md](backend-core-domain-folders.md))
- [ ] Decide where `pi-model-catalog-seeding.ts` belongs: native-agent model catalogue code or the kernel ([backend-core-domain-folders.md](backend-core-domain-folders.md), decision)
- [ ] Add a two-backend test proving terminals and local servers are isolated per `BackendRuntime` ([backend-runtime-state-ownership.md](backend-runtime-state-ownership.md))
- [ ] Check whether sibling `await import()` calls exist only to dodge an import cycle ([backend-runtime-state-ownership.md](backend-runtime-state-ownership.md))
- [ ] Run the isolated browser agent tests for the terminal and local-server runtime steps ([backend-runtime-state-ownership.md](backend-runtime-state-ownership.md), qualification)

### Cross-cutting (low)

- [ ] Confirm runtime drift counters and advisory notices show and rehydrate in Agent Info on two platforms ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), qualification)
- [ ] Confirm the usage panel shows turns and account windows across a reload on two providers ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), qualification)
- [ ] Verify agent-test Claude profiles do not treat `~/.claude` as a first run when `CLAUDE_CONFIG_DIR` is unset ([live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md), verify)
- [ ] Document `export_build_pipeline_for_downgrade` in storage.md as a downgrade aid, or remove it ([mixed-version-compatibility.md](mixed-version-compatibility.md))
- [ ] Add content-free usage counters for each legacy compatibility path once the support window is agreed ([mixed-version-compatibility.md](mixed-version-compatibility.md))
- [ ] Verify no external tool invokes the claim commands or downgrade export through `/__orkestrator/invoke` ([mixed-version-compatibility.md](mixed-version-compatibility.md), verify)
- [ ] Convert the remaining literal waits in `PersistentTerminal` and `AgentNativeTab` tests where faithful ([test-suite-and-ci-health.md](test-suite-and-ci-health.md))
- [ ] Profile and trim backend slow test owners (validation worker, public-api exec, commands, tmux) ([test-suite-and-ci-health.md](test-suite-and-ci-health.md))
- [ ] Resolve the gateway-auth part of flake 0006 once the registry criteria are met ([test-suite-and-ci-health.md](test-suite-and-ci-health.md))
- [ ] Record fresh test-suite baselines and a controlled before-and-after comparison if speed work resumes ([test-suite-and-ci-health.md](test-suite-and-ci-health.md), qualification)
- [ ] Confirm the desktop test gaps with coverage before writing tests ([test-suite-and-ci-health.md](test-suite-and-ci-health.md), verify)
- [ ] Find the root cause of the `AddProjectDialog.test.tsx` cost ([test-suite-and-ci-health.md](test-suite-and-ci-health.md), verify)
- [ ] Measure current wall-clock test group times with Turbo `--summarize` from a quiet run ([test-suite-and-ci-health.md](test-suite-and-ci-health.md), verify)
- [ ] Decide whether the testing guide should carry current reference timings ([test-suite-and-ci-health.md](test-suite-and-ci-health.md), decision)
- [ ] Re-measure before moving ACP transcript subprocess cases to direct parse and merge tests ([test-suite-and-ci-health.md](test-suite-and-ci-health.md), deferred)
- [ ] Add longest-first bridge test scheduling if the ACP bridge stops dominating ([test-suite-and-ci-health.md](test-suite-and-ci-health.md), deferred)
- [ ] Split backend `test:workspace` into source and `dist`-consuming tests if Turbo summaries justify it ([test-suite-and-ci-health.md](test-suite-and-ci-health.md), deferred)
- [ ] Rotate a real phone or iOS simulator with a split and a terminal pane open ([mobile-layout-gaps.md](mobile-layout-gaps.md), qualification)
- [ ] Verify the mobile environment-settings defect still reproduces in a real narrow browser ([mobile-layout-gaps.md](mobile-layout-gaps.md), verify)
- [ ] Open the ActionBar's environment settings through `AppDialogHost`, leaving one host for the dialog ([mobile-layout-gaps.md](mobile-layout-gaps.md))
- [ ] Return focus to the opener when a fullscreen settings dialog closes ([mobile-layout-gaps.md](mobile-layout-gaps.md))
- [ ] Drop `tsx` from claude-bridge and codex-bridge in favour of `bun --watch` ([dependency-upgrades.md](dependency-upgrades.md))
- [ ] Move to electron-builder 27 / electron-updater 7 once 27 is stable ([dependency-upgrades.md](dependency-upgrades.md), blocked)
- [ ] Move to `marked` 18 once `@tiptap/markdown` accepts it ([dependency-upgrades.md](dependency-upgrades.md), blocked)
- [ ] Move to hono 5 once it is stable ([dependency-upgrades.md](dependency-upgrades.md), blocked)
- [ ] Migrate to `@dnd-kit/react` 1.0 and drop the duplicate root dev dependencies ([dependency-upgrades.md](dependency-upgrades.md), blocked)
- [ ] Clear the `postcss-selector-parser` advisory when `@tailwindcss/typography` moves off its pin ([dependency-upgrades.md](dependency-upgrades.md), blocked)
- [ ] Move the Docker image to Node 26 after its LTS settles, not before December 2026 ([dependency-upgrades.md](dependency-upgrades.md), deferred)

## By file

| File | Very high | High | Medium | Low | Total |
| --- | --- | --- | --- | --- | --- |
| **Service previews and web annotations** | | | | | |
| [service-preview-rollout.md](service-preview-rollout.md) |  | 3 | 14 | 7 | 24 |
| [embedded-service-previews.md](embedded-service-previews.md) |  |  |  | 13 | 13 |
| [preview-service-discovery.md](preview-service-discovery.md) |  |  | 1 | 5 | 6 |
| [web-annotation-qualification.md](web-annotation-qualification.md) |  | 4 | 14 | 3 | 21 |
| [web-annotation-known-limitations.md](web-annotation-known-limitations.md) |  |  | 7 | 3 | 10 |
| [web-annotation-extensions.md](web-annotation-extensions.md) |  |  |  | 11 | 11 |
| **CLI and slash commands** | | | | | |
| [cli-command-surface.md](cli-command-surface.md) |  |  | 6 | 7 | 13 |
| [cli-qualification.md](cli-qualification.md) |  | 1 | 6 | 1 | 8 |
| [slash-command-catalogue.md](slash-command-catalogue.md) |  | 1 | 6 | 4 | 11 |
| [slash-command-qualification.md](slash-command-qualification.md) |  | 2 | 3 | 2 | 7 |
| **Containers and environments** | | | | | |
| [container-platform-qualification.md](container-platform-qualification.md) |  | 3 | 11 | 1 | 15 |
| [container-rebuild-state-preservation.md](container-rebuild-state-preservation.md) |  | 1 | 3 | 2 | 6 |
| [container-network-and-credential-isolation.md](container-network-and-credential-isolation.md) |  | 1 | 2 | 1 | 4 |
| [container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md) |  |  | 3 | 6 | 9 |
| [container-state-observation.md](container-state-observation.md) |  | 1 | 5 | 5 | 11 |
| [environment-and-disk-cleanup.md](environment-and-disk-cleanup.md) |  | 2 | 1 | 5 | 8 |
| **Design canvas** | | | | | |
| [design-canvas-qualification.md](design-canvas-qualification.md) |  | 2 | 5 | 6 | 13 |
| [design-operation-recovery-edges.md](design-operation-recovery-edges.md) |  | 1 | 1 | 2 | 4 |
| [design-agent-conversation-links.md](design-agent-conversation-links.md) |  |  | 5 | 3 | 8 |
| **MCP** | | | | | |
| [mcp-management.md](mcp-management.md) |  | 3 | 10 | 7 | 20 |
| [mcp-environment-delivery.md](mcp-environment-delivery.md) |  |  | 4 | 10 | 14 |
| [control-mcp-voice-surface.md](control-mcp-voice-surface.md) |  |  | 9 |  | 9 |
| **Agent engines and provider SDKs** | | | | | |
| [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md) |  | 3 | 9 | 4 | 16 |
| [mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md) |  | 1 | 3 | 5 | 9 |
| [session-titles-and-history.md](session-titles-and-history.md) |  |  | 4 | 4 | 8 |
| [agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md) |  | 2 | 8 | 5 | 15 |
| [composer-model-parameters.md](composer-model-parameters.md) |  |  | 2 | 4 | 6 |
| [opencode-v2.md](opencode-v2.md) |  |  |  | 3 | 3 |
| [provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md) |  |  | 2 | 15 | 17 |
| [session-lifecycle-consistency.md](session-lifecycle-consistency.md) |  | 1 | 7 | 5 | 13 |
| **Transcripts, observation and bandwidth** | | | | | |
| [transcript-history-efficiency.md](transcript-history-efficiency.md) |  | 4 | 11 | 5 | 20 |
| [remote-client-bandwidth.md](remote-client-bandwidth.md) |  |  | 4 | 9 | 13 |
| [native-agent-idle-observation.md](native-agent-idle-observation.md) |  | 1 | 3 | 2 | 6 |
| [client-reconnect-and-freshness.md](client-reconnect-and-freshness.md) |  | 1 | 6 | 2 | 9 |
| [recurring-work-qualification.md](recurring-work-qualification.md) |  | 5 | 10 | 19 | 34 |
| **Multi Review** | | | | | |
| [multi-review-scale-and-cost.md](multi-review-scale-and-cost.md) |  | 3 | 5 | 9 | 17 |
| [multi-review-panel-value.md](multi-review-panel-value.md) |  | 1 | 4 | 5 | 10 |
| [multi-review-flow-graph.md](multi-review-flow-graph.md) |  |  |  | 4 | 4 |
| **Coordinator and agent mail** | | | | | |
| [coordinator-read-only-adapters.md](coordinator-read-only-adapters.md) |  |  | 3 | 3 | 6 |
| [coordinator-live-conformance.md](coordinator-live-conformance.md) |  | 4 | 6 |  | 10 |
| [coordinator-consistency-gaps.md](coordinator-consistency-gaps.md) |  |  | 1 | 7 | 8 |
| **Backend structure** | | | | | |
| [storage-service-repositories.md](storage-service-repositories.md) |  | 3 | 5 | 2 | 10 |
| [native-agent-service-collaborators.md](native-agent-service-collaborators.md) |  |  | 5 | 1 | 6 |
| [claude-bridge-prompt-stream-state.md](claude-bridge-prompt-stream-state.md) |  |  | 1 | 3 | 4 |
| [backend-core-domain-folders.md](backend-core-domain-folders.md) |  |  | 4 | 3 | 7 |
| [backend-runtime-state-ownership.md](backend-runtime-state-ownership.md) |  |  | 4 | 3 | 7 |
| **Cross-cutting** | | | | | |
| [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md) |  | 1 | 10 | 3 | 14 |
| [mixed-version-compatibility.md](mixed-version-compatibility.md) |  | 1 | 2 | 3 | 6 |
| [test-suite-and-ci-health.md](test-suite-and-ci-health.md) | 1 | 1 | 4 | 11 | 17 |
| [mobile-layout-gaps.md](mobile-layout-gaps.md) |  |  | 1 | 4 | 5 |
| [dependency-upgrades.md](dependency-upgrades.md) |  |  | 3 | 7 | 10 |
