# 19 — Validate the full pipeline and roll out in measured waves

Status: Complete for the function-level, repository-suite and isolated real-stack evidence below; remote-proxy, Docker, Electron-window and live Cursor/Pi/Grok runs were not performed. Findings: all.

## Outcome

The optimized paths work together under real background activity, restarts,
mixed versions, and constrained clients. Publish measured improvements and
remaining fallback costs, with each finding linked to implementation evidence.

## Integration matrix

| Dimension | Required coverage |
| --- | --- |
| Provider | Claude, Codex, OpenCode, Cursor, Pi, Grok/ACP |
| Deployment | Local worktree; exact-owner Docker fixture where supported |
| Client | Desktop IPC; browser gateway; responsive/mobile web path |
| Transcript | Small, long immutable prefix, giant tool result, diff, image, nested agents |
| Lifecycle | Active, inactive environment, hidden document, disconnect, restart, deletion |
| History | Paging, cache eviction, partial head, rewind/replacement, expired cursor |
| Concurrency | Multiple environments, sessions, clients, and shared reads |
| Persistence | Fresh install, old schema, interrupted migration, corrupt cache, failed durable write |
| Transport | Slow consumer, replay gap, old capability set, supported remote proxy |
| Workflows | Reviewer progress/stall, build/fix stages, queued prompt, structured result recovery |

Not every Cartesian product is needed. Cover every provider's basic summary,
details, page/fallback, and background recovery; target adversarial combinations
at the shared mechanisms and provider-specific lifecycle differences.

## Required end-to-end sequences

1. **Background bounds:** run Cursor with no transcript subscribers past count
   and byte thresholds; let a child remain active after its card is trimmed;
   return and verify bounded history plus correct lifecycle/control state.
2. **Cold restart:** populate multiple display tails and pipeline histories,
   restart backend/bridge, paint a cached preview, then reconcile current state.
   Pending prompts and approvals must not be reconstructed from display cache.
3. **Shared reads:** open the same session on two clients with different windows,
   hide one, cancel a read, and replace the backend connection. Verify no data
   leakage across identities and no cancellation of work still owned by peers.
4. **Artifact recovery:** expand a historical tool/image, expire its detail cache,
   reconnect, and request it again. Return that exact revision or a truthful
   expired/unavailable result, never current unrelated content.
5. **History rewrite:** load earlier pages, rewind/fork/replace history while the
   view is inactive, then return. Old cursors and retained pages cannot survive
   an incompatible epoch; scroll and load-earlier controls still work.
6. **Dispatch crash boundary:** fail durable Cursor writes before prepare and
   around SDK acceptance, restart, and retry under the same ID. Prove no send
   after a failed pre-dispatch barrier and no automatic ambiguous duplicate.
7. **Workflow storage:** pause/cancel/advance pipelines with long transcripts,
   migrate while another supervisor attempts a write, then restart. Preserve
   reservations, leases, structured request/results, and offline retained views.
8. **Transport recovery:** disconnect mid-replay and mid-snapshot, exceed replay
   retention, and use a slow consumer. Detect every gap; preserve cursor echo,
   subscribe-before-replay, and exact terminal snapshot recovery.
9. **Filesystem recovery:** fail local/container watchers, mutate trees, and
   recover via TTL/manual reads. Two clients should share scans rather than
   multiplying container processes.

## Measurement acceptance

Use the fixtures and counters from 01 on the same named machine/profile.
Compare baseline, narrow-fix wave, storage/summary wave, and final behavior.

| Finding | Minimum evidence before closure |
| --- | --- |
| E01 | Enforced count/byte bound with no reader; bounded transient overshoot |
| E02 | Essential state persists above display budget; failed barriers prevent send |
| E03 | Zero message-body serialization visits for unchanged Claude read |
| E04 | One-tail update/read avoids unrelated payloads; checkpoint age bounded |
| E05 | Changed-only backend processing; per-hop byte/CPU improvement; 14 decision |
| E06 | Large artifacts absent from live summary traffic; no unnecessary legacy recovery |
| E07 | Warm page avoids interactive projection; cold fallback cost documented |
| E08 | Large-file source processing has bounded working memory and no self-eviction thrash |
| E09 | Linear serialization-visit growth with output parity |
| E10 | Historical prefix not re-encoded for a tail-only update; exact accounting |
| E11 | Hidden scheduled reads cease; complete batched observations preserve semantics |
| E12 | Watched unchanged trees reuse digest; TTL-only limitations explicit |
| E13 | Conditional reviewer reads and meaningful progress without full legacy bodies |
| E14 | Small workflow control writes independent of historical display volume |

Also report peak heap/RSS, backend event-loop lag, p50/p95 first/current-update
and page latency, UI long tasks/input latency, decoded/encoded bytes, storage
bytes written/copied, and slow-client resets. Do not claim success from one
reduced metric if memory or interaction latency materially worsened.

## Test commands and evidence

Follow the living [testing guide](../../../development/testing-guide.md) and
[agent-testing guide](../../../development/agent-testing.md). Run focused owning
tests while implementing, and use repository validation before handoff:

```bash
mise run test:changed
mise run check
mise run test
```

Use the logged wrapper prescribed by the guide for failure artifacts. Add the
applicable `test:agent:browser`, `test:agent:electron`, and exact-owner Docker
workflow when those surfaces changed. Native iOS checks require a supported
Mac/simulator and apply when the wrapper itself changes; web mobile viewport
QA alone is not a native lifecycle test. State unavailable infrastructure and
unrun checks explicitly instead of inventing successful results.

Avoid new cross-file global mocks. When writing Bun suites, follow the
bun-testing skill and existing centralized test support. If aggregate-only
failure occurs, rerun the owning file alone and update the existing flake
registry only when that evidence supports it.

## Rollout waves

1. Ship 02–05 with the targeted counters and regressions. Verify no bound or
   persistence regression before enabling later protocol changes.
2. Publish protocol readers and storage primitives. Migrate display tails;
   enable new provider capabilities individually after adapter validation.
3. Enable direct history and incremental projection/frontend accounting. Retain
   bounded negotiated legacy fallbacks; count their use.
4. Cut review consumers and pipeline records over after mixed-version and crash
   migration tests. Verify imports/exports before retiring legacy sources.
5. Enable scheduling and tree caching. Adopt optional part deltas only under
   the recorded step-14 decision. Keep compression defaults as they were.

## Rollback matrix

| Change | Safe rollback |
| --- | --- |
| Summary/page capability | Stop advertising it and reconcile via compatible bounded snapshots |
| Part deltas | Disable capability and obtain a fresh whole-message base |
| Derived Codex index | Discard/rebuild index; keep bounded source reader |
| Display-tail records | Discard cache or use supported cache reader; recover from provider |
| Durable pipeline format | Tested export or compatible reader; preserve committed manifests |
| Visibility scheduling/tree cache | Restore existing bounded polls/scans, retaining correctness fixes |
| Cursor barrier/background bounds | Fix forward or retain conservative safe implementation |

Do not roll back by removing durability checks, restoring unbounded allocations,
silencing revision gaps, or approving requests on timeout. A feature switch is
not a storage downgrade strategy.

## Completion checklist

- [x] Each numbered step has an execution record and truthful status.
- [x] Every finding maps to a commit/PR and validation evidence or a documented
      remaining limitation; none is closed solely because a plan exists.
- [x] Mixed-version and migration tests pass, including explicit deletion.
- [x] Background agent/terminal work survives tab and document lifecycle changes
      (owning suites and the isolated browser suite's inactive/reload cases).
- [x] Diagnostics and artifacts contain only synthetic data and bounded metrics.
- [x] Isolated profiles are stopped and reset, or intentional retention recorded.
- [x] Documentation catalog, review status, and existing TODOs reflect shipped
      versus deferred work. Keep the original review as dated evidence.
- [ ] Changes reach `main` only through reviewed PRs; final merge is human-owned.

## Execution record

```text
Status: Complete for the evidence below; unrun surfaces listed as limitations.
Implementation commit / PR: branch implement-efficiency-improvements-7f0993836777-r1
  (commits 5d819c87 .. final head); no PR opened from this change.
Finding → evidence:
  E01 steps 02/03 — producer bound; harness c (600 → ≤ 440 parts, bounded bytes);
      cursor translate-bounds.test.ts.
  E02 step 04 — unique temp, fsync, newest-tail shedding, barrier failures;
      persistence-durability.test.ts and budget/durability suites.
  E03 step 05 — Claude revisions + title/freshness token; harness a (1,000 → 0
      visits); real Claude session unchanged re-read (504 B response).
  E04 steps 06/07 — keyed records, bounded checkpoints, deletion fence;
      harness d (one-tail update 16,734 KiB read → 8 KiB).
  E05 steps 12/14 — encoding memo (400 → 100 serializations) and negotiated
      part patches (85–94% fewer decoded delta bytes, harness j).
  E06 steps 08/09 — v2 summaries on all five bridges; harness e; real Codex
      and Claude bridges: 1.5–1.9 KB v2 vs 18.2–18.6 KB v1 for a 14 KB tool
      output, exact detail on expansion.
  E07 step 11 — direct pages; harness i (4 interactive snapshots → 0).
  E08 step 10 — bounded rollout reader; harness h (20 full parses → 1);
      unreadable rollouts no longer read as empty transcripts.
  E09 step 02 — linear trimming; harness b (4,585 → 100 visits).
  E10 step 13 — incremental accounting; harness g (4,196 → 1 visits);
      provider-replacement ordering fix in the hook.
  E11 step 17 — batched no-touch activity (100 sessions: 100 → 2 requests);
      frontend visibility scheduling from 0ba8628e.
  E12 step 18 — single serialization per walk, container TTL, ad hoc cache
      (quiet container panel 12 → 4 walks/min).
  E13 step 15 — conditional probes, lightweight reviewer windows + details.
  E14 step 16 — transcripts in a chunk/manifest store (control file 25.9 MB →
      30 KB; tail checkpoint ≈ 42 KB written).
Tests and isolated profiles (all on this branch head, AMD Ryzen 5 PRO 5650U,
  12 logical CPUs, 30.7 GiB, Bun 1.4.2):
  - mise run check — pass.
  - mise run test — pass (workspace 405 s, root 144 s, bridges 178 s, codex
    protocol lockfile). Earlier runs were killed by the no-output watchdog
    only while another session held 7 of 8 shared test slots; every package
    passes alone and the quiet run passed.
  - mise run test:agent:browser:isolated — 12 passed, 7 skipped (after
    rebuilding bridge bundles; one earlier run hit a first-load dev-server
    502, recorded as environmental flake 0168, and passed on rerun).
  - Isolated profile eff-qa-7f09 (claude, codex; fixture project): real Codex
    and Claude sessions via the orkestrator CLI, then gateway reads: summary
    rows carry a detail reference, expansion returns the exact 13.9 KB
    output, an unchanged re-read answers `unchanged` (≈ 500 B), and each
    bridge answers v2 with details and pages advertised. Environment deleted,
    profile stopped and reset.
  - scripts/efficiency final run: ../baseline/final-summary.json and README.
Compatibility/migration result: every new wire form is negotiated (v2
  envelope discriminator, detail/page route presence, transcriptPatchVersions,
  batch activity route) and old readers keep v1; storage migrations (display
  tails, pipeline transcripts) are idempotent with deletion markers and
  documented downgrade paths (display tails: cache miss; pipelines: bounded
  export command).
Rollout note: `dev:test` launches bridges from their built `dist/` bundles and
  does not rebuild them; after bridge source changes run
  the build script in each bridge directory before real-stack QA,
  or the profile tests stale bridges.
Remaining limitations (not validated here): remote proxy and compression
  bytes, Docker/container environments, the Electron window, live Cursor/Pi/
  Grok/OpenCode sessions, native iOS, browser long-task and heap/RSS
  profiling, and p95 latency on real providers. Per-pipeline control-record
  partitioning (E14) and a container file watcher (E12) remain deferred with
  their measured costs; part patches cover the backend-to-client hop only.
```
