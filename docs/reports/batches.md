# Report batches and parallel running

Which files under `docs/reports` can be built together, and which pieces of work must not run at the same time. Each folder's `0000-index.md` has the same information for its own files, in a **Parallel running** section.

Worked out on 2026-11-03 against `main` at `a44641cbc`, from the 167 work files in the four folders. On 2026-11-04, 137 of them were combined into the 41 batch files listed under [Batch files](#batch-files), which keep each report as a numbered part, with repeated text removed. That leaves 71 files. The other 30 are built on their own, need a decision or measurement first, or are blocked. E1 is a set of baseline tasks inside other batch files, so it has no file of its own. E8 (Agent tab polling) was built on 2026-11-04 and its file deleted, so this plan no longer lists it; its result is in [1202 task 4](../todo/cross-cutting/1202-efficiency-review-follow-ups.md).

## Rules

1. Batches in the same lane run one at a time, in the order shown. Batches in different lanes can run together unless [Conflicts between lanes](#conflicts-between-lanes) lists the pair. A batch with no lane only has to respect that list.
2. These files only change when a branch merges, so they can't show what is running now. Before starting a batch, check the running environments and open PRs for its lane and its conflicts. Put the batch ID in the environment and branch name so that check can find it.
3. [Must finish first](#must-finish-first) is a real ordering: the earlier work changes what the later work measures or builds on. Finish it even when the two could run side by side.
4. Give each batch its own worktree and `dev:test` profile. A complete `mise run test` holds the host, so runs from parallel batches queue rather than overlap.
5. After another batch from the same area merges, rebase before review, especially for the files under [Rebase with care](#rebase-with-care).

## Batch files

| Batch | File | Parts |
| --- | --- | --- |
| X1 | [security/0090-x1-coordinator-trust-boundary.md](security/0090-x1-coordinator-trust-boundary.md) | `Security 0090`, `Security 0180`, `Security 0210`, `Coordinator 0120`, `Coordinator 0310` |
| S2 | [security/0040-s2-bridge-credential.md](security/0040-s2-bridge-credential.md) | `0040`, `0120`, `0250` |
| C5 | [coordinator/0030-c5-prompt-and-context.md](coordinator/0030-c5-prompt-and-context.md) | `0360`, `0170`, `0140`, `0030`, `0460` |
| C4 | [coordinator/0040-c4-tool-surface.md](coordinator/0040-c4-tool-surface.md) | `0040`, `0130`, `0150`, `0160` |
| C2 | [coordinator/0080-c2-workflow-records.md](coordinator/0080-c2-workflow-records.md) | `0080`, `0100`, `0380` |
| C3 | [coordinator/0110-c3-sweep-and-reads.md](coordinator/0110-c3-sweep-and-reads.md) | `0110`, `0370` |
| C9 | [coordinator/0190-c9-panel-split.md](coordinator/0190-c9-panel-split.md) | `0340`, `0220`, `0350`, `0190` |
| C7 | [coordinator/0060-c7-work-panel-and-navigation.md](coordinator/0060-c7-work-panel-and-navigation.md) | `0060`, `0260`, `0280`, `0450` |
| C8 | [coordinator/0070-c8-tab-strip.md](coordinator/0070-c8-tab-strip.md) | `0070`, `0230`, `0420`, `0430` |
| C6 | [coordinator/0020-c6-errors-and-dead-ends.md](coordinator/0020-c6-errors-and-dead-ends.md) | `0020`, `0180`, `0200`, `0210`, `0250`, `0440` |
| C10 | [coordinator/0240-c10-explanations.md](coordinator/0240-c10-explanations.md) | `0320`, `0330`, `0400`, `0240` |
| E14 | [efficiency-logging-database/0740-e14-docker-logs.md](efficiency-logging-database/0740-e14-docker-logs.md) | `0740`, `0850` |
| E25 | [efficiency-logging-database/0490-e25-container-start.md](efficiency-logging-database/0490-e25-container-start.md) | `0490`, `0500` |
| E9 | [efficiency-logging-database/0110-e9-transcript-reads.md](efficiency-logging-database/0110-e9-transcript-reads.md) | `0150`, `0200`, `0110` |
| E10 | [efficiency-logging-database/0160-e10-conditional-reads-and-deltas.md](efficiency-logging-database/0160-e10-conditional-reads-and-deltas.md) | `0160`, `0180`, `0190` |
| E11 | [efficiency-logging-database/0210-e11-projection-hashing.md](efficiency-logging-database/0210-e11-projection-hashing.md) | `0210`, `0220`, `0320`, `0330`, `0340`, `0345`, `0350`, `0380` |
| E12 | [efficiency-logging-database/0510-e12-renderer-store.md](efficiency-logging-database/0510-e12-renderer-store.md) | `0510`, `0590`, `0640` |
| E3 | [efficiency-logging-database/0540-e3-retention-and-deletion.md](efficiency-logging-database/0540-e3-retention-and-deletion.md) | `0730`, `0540`, `0840` |
| E4 | [efficiency-logging-database/0430-e4-object-store.md](efficiency-logging-database/0430-e4-object-store.md) | `0430`, `0480`, `0530`, `0550` |
| E5 | [efficiency-logging-database/0760-e5-database-upkeep.md](efficiency-logging-database/0760-e5-database-upkeep.md) | `0760`, `0800`, `0910`, `0920` |
| E7 | [efficiency-logging-database/0420-e7-diff-scans.md](efficiency-logging-database/0420-e7-diff-scans.md) | `0420`, `0440`, `0450`, `0460`, `0570` |
| E26 | [efficiency-logging-database/0400-e26-local-desktop-transport.md](efficiency-logging-database/0400-e26-local-desktop-transport.md) | `0400`, `0860` |
| E18 | [efficiency-logging-database/0280-e18-gateway-events.md](efficiency-logging-database/0280-e18-gateway-events.md) | `0280`, `0290`, `0300`, `0370` |
| E24 | [efficiency-logging-database/0310-e24-gateway-static-and-preview.md](efficiency-logging-database/0310-e24-gateway-static-and-preview.md) | `0310`, `0365` |
| E13 | [efficiency-logging-database/0720-e13-silent-failures.md](efficiency-logging-database/0720-e13-silent-failures.md) | `0720`, `0830` |
| E17 | [efficiency-logging-database/0770-e17-dead-code.md](efficiency-logging-database/0770-e17-dead-code.md) | `0770`, `0930` |
| E15 | [efficiency-logging-database/0750-e15-health-and-diagnostics.md](efficiency-logging-database/0750-e15-health-and-diagnostics.md) | `0750`, `0820`, `0810`, `0880`, `0780` |
| E16 | [efficiency-logging-database/0790-e16-log-controls.md](efficiency-logging-database/0790-e16-log-controls.md) | `0790`, `0890`, `0900` |
| E20 | [efficiency-logging-database/0240-e20-acp-bridge.md](efficiency-logging-database/0240-e20-acp-bridge.md) | `0270`, `0260`, `0240` |
| E21 | [efficiency-logging-database/0130-e21-pi-bridge.md](efficiency-logging-database/0130-e21-pi-bridge.md) | `0130`, `0355` |
| E22 | [efficiency-logging-database/0600-e22-chat-rendering.md](efficiency-logging-database/0600-e22-chat-rendering.md) | `0600`, `0670` |
| E23 | [efficiency-logging-database/0620-e23-renderer-polling.md](efficiency-logging-database/0620-e23-renderer-polling.md) | `0620`, `0630`, `0660` |

## Lanes

| Lane | Run order | Code it protects |
| --- | --- | --- |
| Coordinator backend | 1. C5 (Prompt and context)<br>2. C4 (Tool surface)<br>3. X1 (Coordinator trust boundary)<br>4. C2 (Workflow records)<br>5. C3 (Sweep and reads) | `coordinator-service.ts`, `control-mcp-tools.ts`, the protocol's `coordinator.ts` and the context prompt in `native-agent-service.ts` |
| Coordinator panel | 1. C9 (Panel split)<br>2. C7 (Work panel and navigation)<br>3. C8 (Tab strip)<br>4. C6 (Errors and dead ends)<br>5. C10 (Explanations)<br>6. C-0390 (Panel re-render cost, measure first) | `CoordinatorPanel.tsx`, `CoordinatorPanelNotices.tsx`, `TabShell.tsx` |
| Containers | 1. S2 (Bridge credential)<br>2. S-0080 (Legacy host mounts)<br>3. S-0100 (Egress SNI and DNS)<br>4. S-0170 (Agent-tools bind address)<br>5. E14 (Docker logs)<br>6. E25 (Container start) | `commands-containers.ts`, `commands-registry-servers.ts` and the `docker/` entrypoint, setup and firewall scripts |
| Transcript | 1. E9 (Transcript reads)<br>2. E10 (Conditional reads and deltas)<br>3. E11 (Projection hashing)<br>4. E12 (Renderer store) | `native-agent-transcript-projection.ts` (5,570 lines), `useNativeAgentSession.ts` (3,870 lines), `nativeAgentProjectionStore.ts` |
| Change tracking | 1. E3 (Retention and deletion)<br>2. E4 (Object store) | `apps/backend/src/core/change-tracking/` |
| Storage | 1. E5 (Database upkeep)<br>2. S-0190 (Provider secrets at rest) | `storage-database.ts`, `storage-backups.ts`, `storage-stores.ts` |
| Git scans and file reads | 1. E7 (Diff scans)<br>2. E-0580 (File RPC and usage report) | `commands-files.ts`, `git-scopes.ts`, `diff-stats-service.ts` |
| Desktop | 1. E26 (Local desktop transport)<br>2. E-0691 (Preview capture data URLs) | `apps/desktop/electron/` windows, IPC and preloads, `backend-process.ts` |
| Gateway | 1. E-0120 (Bearer terminal streams)<br>2. S-0200 (Workspace grant allowlist)<br>3. E18 (Gateway events)<br>4. E24 (Gateway static and preview)<br>5. S-0160 (Descriptor process binding) | `gateway-auth.ts`, `gateway-events.ts`, `gateway-proxy.ts`, `gateway-support-*.ts`, `terminal-websocket-server.ts` |
| Logging and diagnostics | 1. E13 (Silent failures)<br>2. E17 (Dead code)<br>3. E15 (Health and diagnostics)<br>4. E16 (Log controls) | `application-logging.ts`, the metrics route and the logging settings |

## Work with no lane

These batches don't share a protected area. They only have to respect the conflicts below.

- **C-0410 (Leaf-mode gate):** coordinator `0410`
- **E1 (Baseline run):** the baseline task in `0150`, `0160`, `0180`, `0190` and `0400`, in efficiency-logging-database
- **S-0230 (Preview publication domain):** security `0230`
- **S-0270 (iOS app review):** security `0270`
- **S-0260 (Live checks on other platforms):** security `0260`
- **E20 (ACP bridge):** efficiency-logging-database `0270`, `0260`, `0240`
- **E21 (Pi bridge):** efficiency-logging-database `0130`, `0355`
- **E22 (Chat rendering):** efficiency-logging-database `0600`, `0670`
- **E23 (Renderer polling):** efficiency-logging-database `0620`, `0630`, `0660`
- **E-0140 (Codex queue bound):** efficiency-logging-database `0140`
- **E-0250 (Codex running tool cards):** efficiency-logging-database `0250`
- **E-0360 (SSE replay rings):** efficiency-logging-database `0360`
- **E-0520 (Startup bundle):** efficiency-logging-database `0520`
- **E-0650 (Terminal container subscription):** efficiency-logging-database `0650`
- **E-0680 (Multi Review drift checks):** efficiency-logging-database `0680`
- **E-0692 (Preview tunnel multiplexing):** efficiency-logging-database `0692`
- **E-0694 (Attention follow polling):** efficiency-logging-database `0694`
- **CI-0010 (Backend shard timeout):** ci-shard-validation `0010`

## Conflicts between lanes

Don't run these pairs at the same time.

| Batch | Batch | Shared code |
| --- | --- | --- |
| C3 (Sweep and reads) | C6 (Errors and dead ends) | `coordinator-service.ts`, `control-mcp-server.ts` |
| C5 (Prompt and context) | C6 (Errors and dead ends) | `CoordinatorPanel.tsx`, `coordinator-service.ts`, protocol `coordinator.ts` |
| C5 (Prompt and context) | C7 (Work panel and navigation) | `CoordinatorPanel.tsx`, `coordinator-service.ts`, protocol `coordinator.ts` |
| C5 (Prompt and context) | C9 (Panel split) | `CoordinatorPanel.tsx` |
| C6 (Errors and dead ends) | E12 (Renderer store) | `useNativeAgentSession.ts`, `AgentNativeTab.controller.tsx` |
| C7 (Work panel and navigation) | E23 (Renderer polling) | `useUserCommands.ts` |
| S2 (Bridge credential) | E13 (Silent failures) | Bridge `http.ts` files, `acp-context.ts`, `acp-server.ts`, `commands-registry-servers.ts` |
| S2 (Bridge credential) | E20 (ACP bridge) | `acp-context.ts` |
| S2 (Bridge credential) | E21 (Pi bridge) | `bridges/pi-bridge/src/http.ts` |
| E3 (Retention and deletion) | E7 (Diff scans) | `change-tracking/service.ts` |
| E5 (Database upkeep) | E15 (Health and diagnostics) | `storage-backups.ts` |
| E26 (Local desktop transport) | E-0120 (Bearer terminal streams) | `web-gateway.ts` |
| E13 (Silent failures) | E20 (ACP bridge) | `commands-servers.ts`, `acp-context.ts` |
| E13 (Silent failures) | E21 (Pi bridge) | `agent-session.ts`, `bridges/pi-bridge/src/http.ts` |

## Must finish first

| Finish | Before |
| --- | --- |
| E1 (Baseline run) | E9, E10 and E26, on code those batches have not changed yet |
| `0040` in S2 | `0120` in S2, or do both together, because `0040` can change how the token reaches the bridge |
| `0360` in C5 | `0170` in C5, so the new lines go into the extracted builder |
| `0530` in E4 | `0550` in E4 |
| `0490` in E25 | `0500` in E25 |

## Rebase with care

These files are named by several batches that can still run together. The reports mostly cite different parts of them, so conflicts should be small, but expect to rebase.

| File | Batches |
| --- | --- |
| `apps/backend/src/core/index.ts` | C5, C9, E9, E13, E15, S-0170 |
| `gateway-support-core.ts` | E15, E17, E18, E24, E-0120 |
| `native-agent-transcript-projection.ts` | E15 (`0880` task 1) with the Transcript lane |
| `native-agent-service.ts`, `control-mcp-tools.ts` | E9 with C2, C3, C4, C5 and X1 |
| `commands-files.ts` | S2, E7, E-0580 |
| `commands-servers.ts` | C6, E3, E13, E20 |
| `GlobalSettings.sections.tsx` | C6, E15, E17 |
| `native-agent-display-tail-store.ts` | E5, E11 |
| `change-tracking/capture.ts` | E4, E7 |
| `usage-history-store.ts` | E15, E-0580 |
| `App.tsx`, `MailTile.tsx` | E-0520 with E23 (`App.tsx`) and C7 (`MailTile.tsx`) |

## How this was worked out

Each report's file references were matched against the files tracked in the repository, then compared across batches. A lane or conflict was kept where the tasks look likely to change the shared file. Where a report only cites a file as background, the pair went under [Rebase with care](#rebase-with-care) or was dropped.

- **It's a judgement, not a proof.** It rests on the task lists, the file references and 14 reports read in full or in part, not on a code audit. Lanes lean cautious, so two batches in a lane may turn out to be separable.
- **The reports may lag the code.** They were analysed at `a2bba9d8`, and later commits changed 36 code files, so line numbers can drift. Re-check overlaps when starting a batch from this plan much later.
- **Cross-folder links are inferred.** The reports don't link across folders, so X1 and the conflicts between folders come from this comparison.
