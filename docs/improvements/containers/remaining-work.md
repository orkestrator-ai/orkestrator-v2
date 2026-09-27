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
| 18 | 10 | Placeholder zeros (unknown memory/CPU/disk, `created: 0`) still reach the UI | Done — unknown figures are `null` end to end and render as "unknown" |
| 19 | 10 | No automatic refresh of usage; staleness only means "daemon unavailable" | Done — the dialog refreshes every 5 s while open; samples older than 15 s read as stale |
| 20 | 10 | Rootless flag computed but unused; memory vs `--shm-size` not validated; below-usage update cannot be confirmed from the UI | Done — `--shm-size` capped at half the memory limit; rootless named in the policy; "Apply anyway" sends `allowBelowUsage` after a `confirmation-required` refusal |
| 21 | 10 | Child-process OOM (PID 1 survives) invisible | Done — `container-oom-events.ts` follows Docker `oom` events (replaying gaps) and the dialog shows kills of running containers |
| 22 | 07 | Success toasts ignore the final snapshot; failures have no actions | Done — rebuild and restore toasts read the lifecycle record; a replayed discard says so; a failed rebuild offers "Review again" |
| 23 | 07 | Recovery copies on volumes report no size | Done — storage-set copies sum their volumes from one `docker system df -v` |
| 24 | 06 | Port conflict on the candidate rolls back instead of a recoverable result | Done — a candidate that cannot bind a published port fails `port-conflict` with a remedy; the rollback keeps the original (the candidate held only a copy) |
| 25 | 06 | Queued work for the old runtime generation is not cancelled or rebound after commit | Done — no dispatch reaches a runtime under replacement (#9); after commit the replaced container's state polling and fetch policy are retired, and environment-keyed work (sessions, parked dispatches, queued prompts) resolves the new runtime on next use |
| 26 | 11 | `get_container_logs` cuts by characters with no truncation marker | Done — byte-bounded with a truncation marker (`boundContainerLogTail`) |
| 27 | 09 | Effective network report lacks gateway/subnet/DNS identity from Docker | Done — the policy report carries the network name, subnet and gateway from `docker network inspect` |
| 28 | 09 | AGENTS.md: sudo grant count, root-terminal `NET_ADMIN` in restricted mode, GitHub range source; all-ports allowlist and shared-IP caveat | Done — AGENTS.md corrected |
| 29 | 12 | Manifest agent versions come from build args, not the installed binaries; bridges listed by directory presence | Done — manifest versions verified against each installed CLI at build time; bridges listed by built entry point |
| 30 | 12 | CI never runs the built image (bridge `/global/health`, CLI versions, dynamic assets) | Done — `docker/tests/final-image-smoke.sh`, run by CI on both native architectures after a contract-argument build |
| 31 | 14 | Manifest `stateFormats` never enforced against storage | Done — `imageWritesVolumeStorage` gates volume storage at creation (`unsupported-format`) |
| 32 | 12 | `docker/build.sh` cannot build the image | Done — builds from the repository root with the contract arguments |
| 33 | 13 | No regression criteria/latency targets; missing benchmark scenarios (concurrency, idle calls/min) | Done — regression table in benchmarks.md; concurrency-3 and Docker-calls-per-minute scenarios measured |

## Tier 3 — verification depth

| # | Step | Item | Status |
| --- | --- | --- | --- |
| 34 | 06/C16 | ENOSPC and inode exhaustion on a real daemon (size-capped tmpfs volumes) | Done — live: tmpfs candidate volumes out of inodes and out of bytes mid-copy roll back, original intact (test-only volume-option seam) |
| 35 | 06 | Corrupt archive / malformed link / occupied name / failed setup injection; kill around commit | Done — truncated archive and escaping hard link refused (unit); occupied candidate name (live); reconciliation at every pre-commit phase and just after the commit write (unit). A failed candidate boot follows the same rollback as the port conflict |
| 36 | 07/C29 | Real-browser cycle for rebuild, recovery copies and cleanup review, including switch-away during a rebuild | Done — `container-rebuild-cycle.spec.ts` (real stack): rebuild, switch environments mid-rebuild, return to backend progress, one new copy, reload, reviewed cleanup; it exposed and fixed a recovery-copy list that did not refresh when a rebuild committed while open |
| 37 | 08/C21 | Interrupted revoke and restart during staging (fixture credentials) | Done — an interrupted revoke stays recorded and gates syncs; a staging interrupted by a restart is never read and is pruned after the grace |
| 38 | 10 | `DockerStatsDialog` tests; parser edge cases | Done — `DockerStatsDialog.test.tsx`; watcher and shared-memory tests |
| 39 | 09 | Sibling access through the environment gateway IP and a sibling's published port | Done — C22 also rejects the environment gateway address and a sibling's published host port |

## Environment-limited

- arm64 image run (C27) — needs an arm64 host; CI builds it natively.
- Docker Desktop and rootless Engine qualification.
- Registry compressed size and cold pull time — needs a registry push.
- Provider session resume after a rebuild (C13): qualified for Claude with
  real credentials; Codex, OpenCode, Pi, Cursor and Grok could not complete a
  first turn in the test profile (provider-side, before any rebuild) and stay
  gated in the preview. Live credential rotation (C21 live half) needs a
  provider whose running process can be observed re-reading its credential.
- Human pull-request review.
