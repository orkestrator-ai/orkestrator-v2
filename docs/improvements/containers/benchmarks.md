# Container baselines and optimization decisions

Step 13 report for the [containers plan](plan/00-index.md). Numbers are
from the opt-in harness `tests/unit/electron/container-benchmarks.test.ts`
(`RUN_CONTAINER_BENCHMARKS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image>`), which
writes the full JSON under `output/benchmarks/` (git-ignored). Fixtures are
synthetic; nothing records commands, paths or contents.

## Conditions

| | |
| --- | --- |
| Host | Linux x86_64, 12 CPUs, Docker Engine 29.7.2 (containerd store) |
| Image | `orkestrator-v2:containers-plan-check` built from this branch (step 12 layout) |
| Concurrency | 1, plus one case with 3 fresh environments at once (the sampler case had 8 running) |
| Resource budget | none (unrestricted) |
| Cold | per environment: new network, volumes and staged inputs; Docker's image and global caches untouched |
| Restricted mode | allowlist `registry.npmjs.org` plus GitHub ranges |

Samples are small (5–10); the columns are min / median / p90 / max, not a
statistically robust p95.

## Results (after the optimizations below)

Latest run (after the audit fixes: stricter copy verification, refreshed
allowlist, admission limits):

| Scenario | n | min | median | p90 | max |
| --- | --- | --- | --- | --- | --- |
| Fresh restricted environment, total (ms) | 5 | 1,949 | 1,985 | 1,995 | 2,720 |
| — storage volumes create + init | 5 | 328 | 336 | 344 | 349 |
| — `docker create` (network, staged inputs, policy) | 5 | 145 | 154 | 158 | 890 |
| — start to current-boot ready (firewall included) | 5 | 1,418 | 1,425 | 1,441 | 1,444 |
| Three fresh environments at once, each (ms) | 3 | 2,186 | 2,281 | 2,281 | 2,377 |
| Warm stop (drain + `docker stop`) | 10 | 468 | 496 | 504 | 512 |
| Warm start to ready | 10 | 1,424 | 1,439 | 1,445 | 1,446 |
| Rebuild, 200 files / 0.8 MB, total | 5 | 4,375 | 4,831 | 5,100 | 5,162 |
| — copying + verification | 5 | 1,500 | 1,527 | 1,601 | 1,633 |
| Rebuild, 5,000 files / 102 MB, total | 3 | 17,053 | 17,507 | 17,507 | 17,998 |
| — copying + verification | 3 | 14,074 | 14,235 | 14,235 | 14,972 |
| Usage sample, 8 running (ms) | 10 | 2,009 | 2,015 | 2,026 | 2,074 |

Other measurements: a fresh environment costs 15 Docker CLI calls (21 at most
when the manifest probe is uncached). Three environments created at once took
2.4 s wall time, each 1.15× the sequential median. A usage sample costs 3
calls whatever the number of containers; with the Docker view open (5 s
refresh) the backend makes **24 Docker calls a minute**, and none while no
view asks. 200 open/close log-subscription cycles over 3 containers took
3 ms, peaked at 3 followers, returned to 0 after the idle grace and grew RSS
by 1 MiB.

## Regression criteria and targets

A change to these paths is a regression when, on the reference host above,
it exceeds any of these (medians unless stated):

| Measure | Target | Current |
| --- | --- | --- |
| Fresh restricted environment to ready | ≤ 3 s | 2.0 s |
| Start to current-boot ready (warm) | ≤ 2 s | 1.4 s |
| Warm stop | ≤ 1 s | 0.5 s |
| Three concurrent fresh environments, each vs sequential | ≤ 1.5× | 1.15× |
| Rebuild copy + verify, 102 MB / 5,000 files | ≤ 20 s | 14.2 s |
| Docker CLI calls per fresh environment | ≤ 21 | 15 |
| Docker calls per minute with the Docker view open | ≤ 36 | 24 |
| Docker calls per minute with no view | 0 (the OOM event follower is one long-lived process) | 0 |
| GitHub API calls per restricted boot with a fresh seed | 0 | 0 |
| Follower count after the idle grace | 0 | 0 |

Anything slower is either fixed or recorded here with its reason before the
change merges.

## Dominant costs found, and what changed

1. **Restricted boots depended on GitHub's API rate limit.** Every boot and
   restart fetched `api.github.com/meta` and verified with
   `api.github.com/zen` — two unauthenticated API calls against a
   60-an-hour-per-address budget. During qualification that budget ran out and
   every restricted boot failed closed (5/5 incomplete in one run). Now the
   backend fetches the ranges at most hourly into a read-only seed
   (`github-ranges-cache.ts`), the firewall prefers a seed under a day old,
   then a live fetch (cached in the container), then either copy under a
   week old, and verifies reachability against `github.com` instead of the
   API. Measured: **17 → 1** GitHub API calls for the same benchmark run, and
   0 incomplete boots.
2. **Verified copy spent most of its time spawning processes.** The verifier
   ran a shell and `sha256sum` per destination file. Hashing in batches of 256
   cut the 102 MB / 5,000-file rebuild from **29.5 s to 18.4 s** (copy +
   verify 25.6 s → 14.3 s); the 0.8 MB case went from 6.4 s to 5.9 s. The same
   corruption, symlink-root and git checks still pass.

## Decision table

| Candidate (plan section) | Decision | Evidence / reason |
| --- | --- | --- |
| Backend GitHub-ranges seed + API-free verification (network) | **Implemented** | 17 → 1 API calls per run; restricted boots no longer fail when the budget is spent |
| Batched destination hashing in the copy verifier (C) | **Implemented** | Rebuild −38% at 5,000 files; no guarantee weakened |
| Phase timing on durable operations (measurement) | **Implemented** | Outcomes carry `durationMs` and per-phase durations; the rebuild figures above come from it |
| Source-side per-member hashing (`tar --to-command`) (C) | Deferred | Now the largest remaining copy cost (~2.8 ms per file); replacing it needs an in-process tar hasher with its own safety review |
| Reuse verified input revisions (A) | Rejected for now | Staging is inside the 266 ms create step for a small home; not a dominant phase |
| Docker events watcher (B) | Rejected for now | The sampler costs 3 CLI calls per sample whatever the environment count; the 3 s status cache already batches `docker ps` |
| Faster usage samples | Deferred | ~2 s is `docker stats --no-stream`'s own CPU sampling interval; samples are shared and the visible refresh is 5 s |
| Dependency cache volumes (C) | Deferred | No dependency downloads in these scenarios; needs its own poisoning/ownership analysis |
| Snapshot/reflink copy fast path (C) | Rejected for now | Not portable across Engine/Desktop storage drivers; the verified streaming copy is the contract |
| Default resource budget (step 10) | Deferred | Needs browser/build/provider workload measurements, which these synthetic scenarios do not exercise |

## Not measured here

Docker Desktop, arm64, registry pull time and compressed layer bytes (CI
builds both architectures natively), UI response under multi-environment
load, and real provider/bridge authentication paths. Image size before and
after step 12 is recorded in the step 12 implementation record.
