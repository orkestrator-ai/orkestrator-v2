# 14 — Validation, observability, and release gates

Status: Unit, contract, fixture, bound and real-stack specs landed (2026-09-25); live-agent, Docker, remote and iOS gates outstanding. Starts after: 01; applied throughout 02–13. Milestones: A–C.

## Purpose

This is the verification and operations checklist for the whole plan. Implement
tests with their owning changes, then run the relevant gate before enabling each
milestone. This step does not defer testing until the end or require milestone C
before releasing milestone A.

Read the current [testing guide](../../../development/testing-guide.md) and
[isolated testing guide](../../../development/agent-testing.md) before executing
commands. Their instructions remain authoritative if task names or environments
change after this plan was written.

## Test ownership

| Layer | Existing suite/area to extend | New behaviors |
| --- | --- | --- |
| Protocol | `tests/unit/protocol-browser-preview.test.ts`, protocol package tests | New records, limits, provenance, target unions, transition validation. |
| Inspector | `tests/unit/electron/browser-preview-annotation-script.test.ts` | Selection-only runtime, traversal bounds, injection resistance, target modes. |
| Native capture | `tests/unit/electron/browser-preview-manager.test.ts`, IPC/adapter coverage | Coherent capture, pending spool, acknowledgement, restart, scaling. |
| Browser UI | `apps/web/src/components/browser/BrowserTab.test.tsx`, new annotation components | Trusted editor, panels, destination, conflict/error states, keyboard flow. |
| Legacy persistence | `apps/web/src/lib/draft-persistence.test.ts`, compose store tests | Migration, dirty-draft reconciliation, unchanged transcript annotations. |
| Prompt preparation | Browser/transcript annotation tests plus new backend brief tests | Trusted intent, inert evidence, deterministic byte budgets, immutable revisions. |
| Backend service | New storage/command/request suites | Ownership, CAS, commit/crash recovery, assets, quotas, cursor repair. |
| Native execution | `native-agent-service-dispatch.test.ts`, reconciliation tests, storage queue tests | One execution, stable IDs, queue holds, unknown outcomes, cancellation races. |
| Native chat | `AgentNativeTab.test.tsx`, session hook tests | Transcript links, questions/approvals, unchanged drafts, result recovery. |
| Real stack | Existing browser/Electron/Docker agent suites | Native view placement, actual capture, background work, workspace materialization. |

Use the repository's Bun test-isolation guidance when writing tests. Prefer
dependency injection and fresh per-test temporary storage over global module
mocks. Use injected clocks and deterministic synthetic pages for time/geometry
cases; reserve real browser checks for behavior mocks cannot establish.

## Synthetic fixture application

Create a small isolated fixture with a settings form, pricing cards, repeated
buttons, nested elements, long text, overflow at a narrow viewport, optional
iframe/shadow/canvas regions, and a controlled hot-reload/DOM replacement hook.
Use only synthetic data and credentials. Include an explicit expected source
change and a functional check so the workflow proves repository implementation,
not merely a browser style mutation.

- [ ] Provide deterministic initial route/viewport and a reset mechanism.
- [ ] Include adversarial page strings that look like agent instructions and
  forged annotation payloads; verify they stay inert.
- [ ] Include synthetic password/token-like data for redaction checks without
  using live accounts, work prompts, or personal page content.
- [ ] Keep Electron fixture access separate from the user's production app and
  backend data. Follow profile/port ownership in the isolated testing guide.

## Fault-injection matrix

| Fault boundary | Expected invariant |
| --- | --- |
| Selected element disappears before screenshot | Explicit stale/recapture state; no falsely coherent evidence. |
| Renderer unmounts after native pending capture is saved | Capture recoverable from main-process spool. |
| Backend commits capture, response/ack is lost | Retry returns original receipt/annotation; no duplicate. |
| Draft save conflicts during hydration | Local text preserved and conflict visible. |
| Annotation commit succeeds, native queue publication fails | Persisted enqueue intent reconciles with stable identity. |
| Native queue publishes/consumes, annotation receipt write fails | Receipt/dispatch evidence repairs status without republishing a consumed request. |
| Provider accepts, response is lost | Unconfirmed/native recovery or positive journal settlement; no fresh-ID resend. |
| Bridge restarts with incomplete dispatch evidence | Unknown stays unknown; no inference from absent record. |
| Cancellation races dispatch/new turn | Only matching request/turn affected; no false cancelled state. |
| Final change hint is lost | Periodic revision check or activation snapshot repairs the UI. |
| Image quota/write fails | Saved text/draft remains recoverable; missing evidence is explicit. |
| User edits/recaptures while request runs | Frozen request unchanged; old result cannot resolve newer content. |
| Session/provider history disappears | Historical result remains available with unavailable source link. |
| Environment is deleted during upload/dispatch | Access revoked, no cross-environment materialization, lifecycle cleanup is bounded. |

## Gate A — First complete workflow

- [ ] Capture an element without an agent tab open; save and reload the app.
- [ ] Open two native sessions with existing drafts; target one. Verify neither
  unrelated draft is modified and the selected session's queue rules are honored.
- [ ] Discuss the note, answer a clarification, request implementation, and inspect
  the actual repository change after reload. Test analysis-only limitations as
  described in step 06; do not claim unsupported execution enforcement.
- [ ] Start work in environment A, switch to B, let it progress or finish, return,
  and verify transcript links, status, pending interactions, and controls.
- [ ] Repeat with renderer reload, SSE disconnect, backend restart, and a pending
  approval. A dead-generation approval is withdrawn, never approved implicitly.
- [ ] Verify screenshot paths/materialization in both a local worktree and an
  isolated Docker environment. Include a remote backend upload path where supported.
- [ ] Accept the current result, reopen, then race a new comment against old-result
  acceptance. Confirm only the intended revision is resolved.
- [ ] Migrate identical and divergent copies, missing assets, and pending native
  dispatches; restart during each migration boundary without data loss.
- [ ] Verify desktop panel visibility, native bounds, focus, menus, keyboard
  interaction, narrow viewport, and zoom in the actual native window.
- [ ] Negative authorization/provenance tests pass and storage/log inspection
  contains no synthetic secret, page content, or image payload leakage.

Exercise contract tests for every native provider. Run real-agent smoke cases
for the supported capture/dispatch combinations; record unavailable credentials
or platforms explicitly and keep unverified new capabilities disabled where
the missing evidence affects safety/correctness. Do not infer six-provider
support from a single provider's happy path.

## Gate B — Stable targets and batch work

- [ ] Hot reload/reorder duplicate cards; pins either match by corroborated identity
  or explicitly become stale/ambiguous. No pin silently changes target.
- [ ] Navigate service routes/hash/query variants and reselect historical notes.
  Verify capture/request revisions and old results remain distinct.
- [ ] Prepare/send a batch at count/text/image bounds; manifest and delivered
  evidence agree. Overflow never drops selected requirements silently.
- [ ] Race overlapping batches from two clients and verify all-or-none reservation.
- [ ] Review partial outcomes, resolve a subset, and send only the remaining work.
- [ ] Test large collections with bounded pagination, observer work, image memory,
  and request preparation concurrency; no whole-history image/DOM loading.

## Gate C — Results, comparison, and supported clients

- [ ] Structured tools enforce exact request/session scope and cannot resolve,
  dispatch, or read unrelated feedback. Unsupported tools retain manual review.
- [ ] Compare matching and mismatched routes/viewports, unstable animation/fonts,
  expired authentication, and unavailable functional verification.
- [ ] Agent-reported tests cannot impersonate app-observed checks or human acceptance.
- [ ] Exercise text, region, page, and each enabled root/frame mode end-to-end.
- [ ] Review desktop captures from web/iOS without a live desktop. Run native iOS
  checks only on an appropriate Mac/Xcode fixture if iOS capture is implemented;
  otherwise document that capability as unavailable.
- [ ] Pixel differences remain advisory and bounded; no automatic resolution.

## Commands and evidence

Run the smallest owning tests while developing, followed by the repository's
required checks. The standard repository commands at plan-writing time are:

```bash
mise run test:logged -- --name annotation-check -- mise run check
mise run test:logged -- --name annotation-changed -- mise run test:changed
mise run test:logged -- --name annotation-all -- mise run test
mise run test:logged -- --name annotation-browser -- mise run test:browser
mise run test:logged -- --name annotation-agent-browser -- mise run test:agent:browser
mise run test:logged -- --name annotation-electron -- mise run test:agent:electron
mise run test:logged -- --name annotation-docker -- mise run test:agent:docker
```

Run applicable commands separately. Browser/Electron/Docker suites require
their documented prerequisites and isolated profiles. Focused Bun runs must
name explicit paths and use the logged wrapper and bounded parallelism. These
are implementation validation instructions; none were executed to author this
documentation-only plan.

For each PR/gate record profile, worktree/commit, exact command, exit status,
pass/fail counts, relevant viewport/platform/provider, and reproducible steps.
Use the logged runner's retained failure artifacts. Screenshots/traces must
show synthetic fixtures and follow existing redaction requirements. Record
skips and limitations; a skipped platform is not a passing platform.

## Observability

Add content-free counters/histograms for capture/save duration, pending spool
depth/bytes, upload failures, revision conflicts/resets, queue hold reason,
unconfirmed dispatch age, resolution rule outcome, evidence omissions, request
duration, acceptance time, and reopen count.

- [ ] Use bounded categorical labels; no raw URL, selector, user text, repository
  path, token, DOM, image, or high-cardinality arbitrary error text in telemetry.
- [ ] Separate user cancellation, infrastructure failure, agent-reported failure,
  and unavailable verification. Do not collapse them into a single success rate.
- [ ] Baseline capture-to-saved and request-to-review latency before enabling
  improvements. Add performance regression fixtures for worst allowed payloads.
- [ ] For initial release target no duplicate executions in fault injection,
  complete deterministic crash recovery at acknowledged boundaries, and visible
  active-client catch-up within two configured reconciliation intervals once
  transport/storage recover. Set latency/memory targets from fixture measurements
  rather than asserting an unmeasured universal SLA.

## Rollout and rollback

- [ ] Separate backend capabilities for reads, authoring, capture acceptance,
  dispatch, and optional tools/comparison. Incomplete later work stays disabled.
- [ ] Begin with isolated internal profiles and complete the corresponding gate;
  record capability/provider/client support before broader enablement.
- [ ] On regression, stop new affected operations while preserving read access,
  pending capture recovery, existing native requests, and migration receipts.
  Never disable reconciliation for requests already sent.
- [ ] Publish a living guide and catalog link covering supported clients, limits,
  missing/stale targets, queue holds, unknown dispatch recovery, migration, and
  asset retention. Keep this plan as the implementation checklist.
- [ ] Each milestone has its own sign-off record. Mark step 14 complete only when
  all intended milestone gates have passed or explicit deferrals are documented.

## Sign-off template

```text
Milestone / PR / commit:
Implemented steps and remaining deferrals:
Platforms, providers, and client versions exercised:
Logged commands and results:
Real workflow and inactive-environment evidence:
Fault-injection boundaries exercised:
Capability matrix and known limitations:
Migration and rollback verification:
Reviewer / date:
```

## Gate evidence record (2026-09-25)

Partial evidence only; no milestone is signed off. Worktree: integration of
the gap-closure changes on top of `6edc6e4c`, Linux (Wayland, display `:0`).

| Command | Result |
| --- | --- |
| `mise run check` | Pass |
| `mise run test` | Pass, all four groups (an earlier run hit the registered DesignCanvasTab flake 0156) |
| `mise run test:agent:electron` | 9 passed (`electron-main.spec.ts` 3, `web-annotations-electron.spec.ts` 6) |
| `mise run test:agent:browser:isolated` | Pass (58 s); a rerun had 5 passed, 4 skipped (Docker, live agent), 1 failed: the unrelated agent-mail tooltip flake, registered as 0162 |
| `web-annotation-payloads.bench.test.ts` | 6 passed; largest brief 65,122 B, 16 images / 16.7 MB, 40 pages at ≤ 62.7 KB each |

Exercised on the real stack (synthetic fixture only):

- Gate A: capture with no agent tab, surviving renderer reload and a full
  app/backend restart; password fields masked in the native screenshot;
  adversarial strings kept inside the evidence block and forged provenance
  refused; no synthetic secret in profile storage or logs.
- Gate B: pins after reorder, hot reload and duplication either match
  corroborated identity or become `ambiguous`/`stale`, never a different
  target; hash/query variants keep separate identities and token parameters
  are stripped; overlapping batches from two clients reserve all-or-none and
  survive reload; the annotation-count bound holds at the command boundary.
- Gate C: text, region and page modes captured end to end; iframe and shadow
  roots resolve to their host element.

Outstanding: live-agent discuss/implement runs per provider (the spec skips
without `ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1` and credentials), Docker
materialization, remote backend upload, inactive-environment switching with a
pending approval, native-window checks at several zoom levels, iOS review, and
comparison fixtures for unstable animation, fonts and expired sign-in.
