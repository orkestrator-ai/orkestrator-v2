# Containers plan — remaining work

An item-by-item audit of plan steps 06–14 against the code (2026-09-27)
found gaps the implementation records did not state. This file tracks them to
closure. Status: **Open**, **Done** (with the change that closed it), or
**Environment-limited** (needs hardware, a daemon variant or real provider
credentials this host does not have — named explicitly).

## Tier 1 — safety and isolation defects

| # | Step | Item | Status |
| --- | --- | --- | --- |
| 1 | 09 | DNS refresh with expiry, atomic swap, revocation of removed domains, durable in-place edits (C23) | Done — `firewall-domains.sh`, `update-firewall.sh --set-domains`, live C23 |
| 2 | 09 | Allowing example.com made every restricted boot fail its self-check | Done — probe the first example host not allowed |
| 3 | 11 | Container log lines were broadcast to every client and filled the shared replay ring | Done — log content is read by cursor only |
| 4 | 11 | Records bounded by characters not bytes; huge-line cut could split a surrogate pair | Done — `recordCut` |
| 5 | 11 | A stopped container's restart reused the ended source; a gap carried no tail | Done — new source per follower; gap returns the bounded tail |
| 6 | 09 | An explicit empty allowlist widened to the image's broad default list | Done — an empty environment list means the global one; an empty result is sent as `none` (nothing beyond GitHub) |
| 7 | 08 | Claude credential sync and `ANTHROPIC_API_KEY` ignore whether Claude is enabled | Done — `providerCredentialsAllowed` gates creation, staging and syncs |
| 8 | 08 | Revocation is not durable: next boot re-imports; no pending state, no process stop | Done — durable `revokedInputProviders`, staged subtrees emptied, bridge stopped, "Allow again" |
| 9 | 06 | Rebuild fences only terminals/bridges/exec: prompts, native dispatch, pending approvals not fenced | Done — `withEnvironmentReplacement` refuses new prompts and mail injections for the whole rebuild/reset/restore before anything is journaled; bridges still deny parked approvals on the drain's SIGTERM; an in-flight ambiguous dispatch stays recoverable |
| 10 | 07 | `cleanup_orphaned_containers` / `docker_system_prune` remove without a reviewed preview; ownerless legacy containers can be eligible | Done — both commands refused; ownerless containers are `legacy-unadopted`, never eligible |
| 11 | 07 | Deletion revokes tool access last and force-removes without a drain | Done — tool access revoked right after the ledger is written; a short drain precedes the forced removal |
| 12 | 06 | Copy helper does not verify ownership or directory counts; xattrs, hardlinks, devices have no policy | Done — numeric owner in the manifest, whole-tree directory count, hard links verified as links, devices refused, `user.*`/capability xattrs preserved; Git state is covered by the byte-identical `.git` |
| 13 | 08 | Input pruning ignores in-flight staging (can delete an active `.partial`) | Done — 30-minute grace before an unreferenced revision is pruned |
| 14 | 09 | `NET_ADMIN` added to full-mode containers that never run the firewall | Done — only restricted runtimes get `NET_ADMIN` |

## Tier 2 — contracts and product behaviour

| # | Step | Item | Status |
| --- | --- | --- | --- |
| 15 | 14 | No switch that refuses new rebuild/migration admissions while recovery continues | Done — `ORKESTRATOR_CONTAINER_REPLACEMENT=paused`; preview reports `admission-paused` |
| 16 | 10 | No admission limit for concurrent expensive starts/migrations | Done — `container-admission.ts`: 4 starts, 2 copies, bounded FIFO waits |
| 17 | 11 | No renderer log viewer on the subscription API (ended/gap/disconnected states, release when hidden) | Done — `ContainerLogViewer` in the Container section: cursor reads, gap and ended states, "Follow again", released when hidden |
| 18 | 10 | Placeholder zeros (unknown memory/CPU/disk, `created: 0`) still reach the UI | Open |
| 19 | 10 | No automatic refresh of usage; staleness only means "daemon unavailable" | Open |
| 20 | 10 | Rootless flag computed but unused; memory vs `--shm-size` not validated; below-usage update cannot be confirmed from the UI | Open |
| 21 | 10 | Child-process OOM (PID 1 survives) invisible | Open |
| 22 | 07 | Success toasts ignore the final snapshot; failures have no actions | Open |
| 23 | 07 | Recovery copies on volumes report no size | Open |
| 24 | 06 | Port conflict on the candidate rolls back instead of a recoverable result | Open |
| 25 | 06 | Queued work for the old runtime generation is not cancelled or rebound after commit | Open |
| 26 | 11 | `get_container_logs` cuts by characters with no truncation marker | Done — byte-bounded with a truncation marker (`boundContainerLogTail`) |
| 27 | 09 | Effective network report lacks gateway/subnet/DNS identity from Docker | Open |
| 28 | 09 | AGENTS.md: sudo grant count, root-terminal `NET_ADMIN` in restricted mode, GitHub range source; all-ports allowlist and shared-IP caveat | Done — AGENTS.md corrected |
| 29 | 12 | Manifest agent versions come from build args, not the installed binaries; bridges listed by directory presence | Open |
| 30 | 12 | CI never runs the built image (bridge `/global/health`, CLI versions, dynamic assets) | Open |
| 31 | 14 | Manifest `stateFormats` never enforced against storage | Open |
| 32 | 12 | `docker/build.sh` cannot build the image | Open |
| 33 | 13 | No regression criteria/latency targets; missing benchmark scenarios (concurrency, idle calls/min) | Open |

## Tier 3 — verification depth

| # | Step | Item | Status |
| --- | --- | --- | --- |
| 34 | 06/C16 | ENOSPC and inode exhaustion on a real daemon (size-capped tmpfs volumes) | Open |
| 35 | 06 | Corrupt archive / malformed link / occupied name / failed setup injection; kill around commit | Open |
| 36 | 07/C29 | Real-browser cycle for rebuild, recovery copies and cleanup review, including switch-away during a rebuild | Open |
| 37 | 08/C21 | Interrupted revoke and restart during staging (fixture credentials) | Open |
| 38 | 10 | `DockerStatsDialog` tests; parser edge cases | Open |
| 39 | 09 | Sibling access through the environment gateway IP and a sibling's published port | Open |

## Environment-limited

- arm64 image run (C27) — needs an arm64 host; CI builds it natively.
- Docker Desktop and rootless Engine qualification.
- Registry compressed size and cold pull time — needs a registry push.
- Provider session resume after a rebuild (C13) and live credential
  rotation (C21 live half) — need real provider credentials; the rebuild
  preview keeps resume gated (`resumeQualified: false`).
- Human pull-request review.
