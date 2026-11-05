# Report batches and parallel running

Which files under `docs/reports` can be built together, and which pieces of work must not run at the same time. Each folder's `0000-index.md` has the same information for its own files, in a **Parallel running** section.

Worked out on 2026-11-03 against `main` at `a44641cbc`, from the 167 work files in the four folders. On 2026-11-04, 137 of them were combined into the 41 batch files listed under [Batch files](#batch-files), which keep each report as a numbered part, with repeated text removed. That leaves 71 files. The other 30 are built on their own, need a decision or measurement first, or are blocked. E1 is a set of baseline tasks inside other batch files, so it has no file of its own. E8 (Agent tab polling) was built on 2026-11-04 and its file deleted, so this plan no longer lists it; its result is in [1202 task 4](../todo/cross-cutting/1202-efficiency-review-follow-ups.md). E4 (Object store) was built on 2026-11-05 and its file deleted the same way; its outcome is the closing check in [the efficiency index](efficiency-logging-database/0000-index.md#closing-check-of-e4-object-store). E5 (Database upkeep) was built on 2026-11-05 and its file deleted; its outcome is in the [efficiency folder's index](efficiency-logging-database/0000-index.md#closing-check-of-e5-database-upkeep). E18 (Gateway events) was built on 2026-11-05 and its file deleted too; see [its closing check](efficiency-logging-database/0000-index.md#closing-check-of-e18-gateway-events). E-0120 (Bearer terminal streams) was built on 2026-11-05 and its file deleted too; GW-3 is recorded as done in the efficiency index. E21, E-0140, E-0250, E-0520 and E-0692 were finished, checked back and deleted on 2026-11-05; their outcome is in the efficiency index's [closing check](efficiency-logging-database/0000-index.md#closing-check-of-e21-e-0140-e-0250-e-0520-and-e-0692). S-0200 (Workspace grant allowlist) was built on 2026-11-05 and its file deleted too; I1 is recorded as done in the security index, and its live checks are in [todo 5740](../todo/cross-cutting/5740-workspace-grant-scope-live-evidence.md). S-0080 (Legacy host mounts) was built on 2026-11-05 and its file deleted too; M9 is recorded as done in the security index, and what only a running install can answer is in [todo 5860](../todo/containers-and-environments/5860-legacy-host-mounts-live-evidence.md). S-0230 (Preview publication domain) was built on 2026-11-05 and its file deleted; its result is in the security index status table (I5) and its live check in [5240](../todo/previews-and-annotations/5240-same-site-preview-domain-live.md). S-0270 (iOS app review) was built on 2026-11-05 and its file deleted, so this plan no longer lists it; what it left is in to-dos [5600](../todo/cross-cutting/5600-ios-bridge-user-consent.md), [5601](../todo/cross-cutting/5601-ios-runtime-security-checks.md) and [5602](../todo/cross-cutting/5602-ios-session-and-privacy-hardening.md). C4 (Tool surface) was built on 2026-11-05 and its file deleted; what it could not prove without real provider turns is in [4920](../todo/coordinator-and-multi-review/4920-coordinator-tool-surface-live-follow-ups.md). E17 (Dead code) was built on 2026-11-05 and its file deleted too; its outcome is the closing check in [the efficiency index](efficiency-logging-database/0000-index.md#closing-check-of-e17-dead-code). E15 (Health and diagnostics) was built on 2026-11-05 and its file deleted too; its outcome is the closing check in [the efficiency index](efficiency-logging-database/0000-index.md#closing-check-of-e15-health-and-diagnostics).

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
| C2 | [coordinator/0080-c2-workflow-records.md](coordinator/0080-c2-workflow-records.md) | `0080`, `0100`, `0380` |
| C3 | [coordinator/0110-c3-sweep-and-reads.md](coordinator/0110-c3-sweep-and-reads.md) | `0110`, `0370` |
| C7 | [coordinator/0060-c7-work-panel-and-navigation.md](coordinator/0060-c7-work-panel-and-navigation.md) | `0060`, `0260`, `0280`, `0450` |
| C6 | [coordinator/0020-c6-errors-and-dead-ends.md](coordinator/0020-c6-errors-and-dead-ends.md) | `0020`, `0180`, `0200`, `0210`, `0250`, `0440` |
| C10 | [coordinator/0240-c10-explanations.md](coordinator/0240-c10-explanations.md) | `0320`, `0330`, `0400`, `0240` |
| E25 | [efficiency-logging-database/0490-e25-container-start.md](efficiency-logging-database/0490-e25-container-start.md) | `0490`, `0500` |
| E9 | [efficiency-logging-database/0110-e9-transcript-reads.md](efficiency-logging-database/0110-e9-transcript-reads.md) | `0150`, `0200`, `0110` |
| E10 | [efficiency-logging-database/0160-e10-conditional-reads-and-deltas.md](efficiency-logging-database/0160-e10-conditional-reads-and-deltas.md) | `0160`, `0180`, `0190` |
| E11 | [efficiency-logging-database/0210-e11-projection-hashing.md](efficiency-logging-database/0210-e11-projection-hashing.md) | `0210`, `0220`, `0320`, `0330`, `0340`, `0345`, `0350`, `0380` |
| E12 | [efficiency-logging-database/0510-e12-renderer-store.md](efficiency-logging-database/0510-e12-renderer-store.md) | `0510`, `0590`, `0640` |
| E3 | [efficiency-logging-database/0540-e3-retention-and-deletion.md](efficiency-logging-database/0540-e3-retention-and-deletion.md) | `0730`, `0540`, `0840` |
| E26 | [efficiency-logging-database/0400-e26-local-desktop-transport.md](efficiency-logging-database/0400-e26-local-desktop-transport.md) | `0400`, `0860` |
| E24 | [efficiency-logging-database/0310-e24-gateway-static-and-preview.md](efficiency-logging-database/0310-e24-gateway-static-and-preview.md) | `0310`, `0365` |
| E16 | [efficiency-logging-database/0790-e16-log-controls.md](efficiency-logging-database/0790-e16-log-controls.md) | `0790`, `0890`, `0900` |
| E20 | [efficiency-logging-database/0240-e20-acp-bridge.md](efficiency-logging-database/0240-e20-acp-bridge.md) | `0270`, `0260`, `0240` |

## Lanes

| Lane | Run order | Code it protects |
| --- | --- | --- |
| Coordinator backend | 1. X1 (Coordinator trust boundary)<br>2. C2 (Workflow records)<br>3. C3 (Sweep and reads) | `coordinator-service.ts`, `control-mcp-tools.ts`, the protocol's `coordinator.ts` and the context prompt in `native-agent-service.ts` |
| Coordinator panel | 1. C7 (Work panel and navigation)<br>2. C6 (Errors and dead ends)<br>3. C10 (Explanations)<br>4. C-0390 (Panel re-render cost, measure first) | `CoordinatorPanel.tsx`, `CoordinatorPanelNotices.tsx`, `TabShell.tsx` |
| Containers | 1. S-0100 (Egress SNI and DNS)<br>2. S-0170 (Agent-tools bind address)<br>3. E25 (Container start) | `commands-containers.ts`, `commands-registry-servers.ts` and the `docker/` entrypoint, setup and firewall scripts |
| Transcript | 1. E9 (Transcript reads)<br>2. E10 (Conditional reads and deltas)<br>3. E11 (Projection hashing)<br>4. E12 (Renderer store) | `native-agent-transcript-projection.ts` (5,570 lines), `useNativeAgentSession.ts` (3,870 lines), `nativeAgentProjectionStore.ts` |
| Change tracking | 1. E3 (Retention and deletion) | `apps/backend/src/core/change-tracking/` |
| Storage | 1. S-0190 (Provider secrets at rest) | `storage-database.ts`, `storage-backups.ts`, `storage-stores.ts` |
| Desktop | 1. E26 (Local desktop transport) | `apps/desktop/electron/` windows, IPC and preloads, `backend-process.ts` |
| Gateway | 1. E24 (Gateway static and preview)<br>2. S-0160 (Descriptor process binding) | `gateway-auth.ts`, `gateway-events.ts`, `gateway-proxy.ts`, `gateway-support-*.ts`, `terminal-websocket-server.ts` |
| Logging and diagnostics | 1. E16 (Log controls) | `application-logging.ts`, the metrics route and the logging settings |

## Work with no lane

These batches don't share a protected area. They only have to respect the conflicts below.

- **E1 (Baseline run):** the baseline task in `0150`, `0160`, `0180`, `0190` and `0400`, in efficiency-logging-database
- **E20 (ACP bridge):** efficiency-logging-database `0270`, `0260`, `0240`
- **CI-0010 (Backend shard timeout):** ci-shard-validation `0010`

## Conflicts between lanes

Don't run these pairs at the same time.

| Batch | Batch | Shared code |
| --- | --- | --- |
| C3 (Sweep and reads) | C6 (Errors and dead ends) | `coordinator-service.ts`, `control-mcp-server.ts` |
| C6 (Errors and dead ends) | E12 (Renderer store) | `useNativeAgentSession.ts`, `AgentNativeTab.controller.tsx` |

## Must finish first

| Finish | Before |
| --- | --- |
| E1 (Baseline run) | E9, E10 and E26, on code those batches have not changed yet |
| `0490` in E25 | `0500` in E25 |

## Rebase with care

These files are named by several batches that can still run together. The reports mostly cite different parts of them, so conflicts should be small, but expect to rebase.

| File | Batches |
| --- | --- |
| `apps/backend/src/core/index.ts` | E9, S-0170 |
| `native-agent-service.ts`, `control-mcp-tools.ts` | E9 with C2, C3 and X1 |
| `commands-servers.ts` | C6, E3, E20 |
| `MailTile.tsx` | E-0520, C7 |

## How this was worked out

Each report's file references were matched against the files tracked in the repository, then compared across batches. A lane or conflict was kept where the tasks look likely to change the shared file. Where a report only cites a file as background, the pair went under [Rebase with care](#rebase-with-care) or was dropped.

- **It's a judgement, not a proof.** It rests on the task lists, the file references and 14 reports read in full or in part, not on a code audit. Lanes lean cautious, so two batches in a lane may turn out to be separable.
- **The reports may lag the code.** They were analysed at `a2bba9d8`, and later commits changed 36 code files, so line numbers can drift. Re-check overlaps when starting a batch from this plan much later.
- **Cross-folder links are inferred.** The reports don't link across folders, so X1 and the conflicts between folders come from this comparison.
