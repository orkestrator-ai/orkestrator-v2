# Rich transcripts and transcript artifacts

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Publish the preview worker image**: push the multi-architecture worker image to a registry and pin packaged installs by digest in `published-image.json`. Status: open (tooling ready; needs a maintainer with registry credentials).
2. **Close phase 9**: the phase checklist still says "Partly" and "No PR opened", although the work shipped in #1103 and the live cycle passed on all six providers. Status: partly done (only the checklist wording is stale).

### 1. Publish the preview worker image

**Problem.** Packaged installs have no published worker image, so `transcript_artifact_prepare_worker` must build the shipped context locally on every machine (a Playwright base pull plus `npm ci`, bounded at 10 minutes) before interactive previews can use container isolation. Users of packaged builds who want container isolation pay that build, and the result is pinned only on that host.

**Context.** The only unticked item in the file. `docker/artifact-preview-worker/publish.sh <repository> [tag]` builds `linux/amd64` and `linux/arm64`, pushes, reads the manifest-list digest back and rewrites the checked-in `published-image.json`, which packaged builds ship. It needs `docker login` and buildx, so an agent cannot run it.

**Investigation.** `docker/artifact-preview-worker/published-image.json` still holds `null` for image, tag, digest and `publishedAt`, unchanged since #1103 (`97af3d45`). `publish.sh` matches the file's description. `apps/backend/src/core/transcript-artifacts/preview-worker-prepare.ts:75` reads the pin and validates the repository and digest (`:81`-`:87`); `:174` pulls `<image>@<digest>` and falls back to the build route on failure. Newly found: nothing ties a published digest to the context the backend ships. A digest published once would be pulled by every later release, even after the worker bundle, the pinned renderer bundles or the `playwright-core` pin (kept in step with the backend by `tests/unit/version-drift.test.ts:1053`) change. A stale pin would run an old worker against a newer backend. No CI workflow publishes the image.

**Decisions.**

- **Who publishes, and when?**
  - **Publish from the release workflow for every release that changes the worker context, and commit the pin in the release change (recommended).**
    - Pros: the pin always matches the shipped context; no manual step to forget.
    - Cons: needs registry credentials in CI and a buildx multi-architecture runner; more release plumbing.
  - **A maintainer runs `publish.sh` by hand once, as the file says.**
    - Pros: no CI work; closes the item today.
    - Cons: the pin goes stale at the next worker change, and nothing detects it.
- **How should a stale pin be prevented?**
  - **Record a hash of the staged context in `published-image.json`, and have preparation fall back to the build route on a mismatch (recommended).**
    - Pros: a stale digest can never be pulled; a drift test can compare the hash with `stage-context.ts` output.
    - Cons: `publish.sh`, the pin schema and `preview-worker-prepare.ts` all change; reproducible context staging is needed for a stable hash.
  - **Rely on publishing discipline.**
    - Pros: no code change.
    - Cons: a silent mismatch between backend and worker in packaged installs.
- **Which registry?**
  - **GitHub Container Registry under the project organisation (recommended).**
    - Pros: matches the example in `publish.sh`; free for public images; reachable from the default allowlist's GitHub ranges.
    - Cons: ties the packaged install to GitHub availability for this one pull (the build route remains a fallback).
  - **Docker Hub.**
    - Pros: the default registry most hosts can reach.
    - Cons: anonymous pull rate limits; another account to manage.

### 2. Close phase 9

**Problem.** The phase checklist says phase 9 is "Partly" with "No PR opened", which reads as outstanding work that is not there.

**Context.** The rich-transcript work merged as #1103. The Remaining work list shows every qualification item ticked on 2026-10-20.

**Investigation.** `git log` shows `97af3d45 feat: add rich transcript artifacts (#1103)` on `main`. The live cycle, performance gate, Electron host and engine matrix are all recorded as done. Phase 8's "Done with limits below" refers to limits that are now all ticked or closed with a decision (Mermaid math kept as a diagnostic).

**Decisions.**

- **What should happen to the file once task 1 is done?**
  - **Delete it, after confirming that the architecture guides already hold the durable content (recommended).** The phase table and real-stack evidence are history; the shipped design lives in `rich-transcripts.md` and `transcript-artifacts-runtime.md`.
    - Pros: follows the README rule for a finished file; removes a stale "No PR opened" claim.
    - Cons: the 2026-10-20 evidence narrative goes, unless it is first copied into the runtime guide's qualification sections.
  - **Correct the phase 9 row now and keep the file until task 1 is done.**
    - Pros: a small, accurate edit; the file stays the single place tracking the publish step.
    - Cons: the file remains mostly history for an item that may wait on release plumbing for some time.

Status of the implementation of the rich-transcript specification
(`docs/temp/rich-transcripts.md`) and the work that remains. The shipped
design is in [rich-transcripts.md](../../architecture/rich-transcripts.md),
[transcript-artifacts-runtime.md](../../architecture/transcript-artifacts-runtime.md),
[transcript-artifacts-agent-guide.md](../../architecture/transcript-artifacts-agent-guide.md)
and [rich-transcripts-user-guide.md](../../architecture/rich-transcripts-user-guide.md).

Starting commit: `67a6cc31` on branch `20261020-005611-6ba26bffea80` (the
specification was written against `ef52cca4`; the integration points it names
were re-inspected at `67a6cc31`).

## Phase checklist

| Phase | State | Evidence |
| --- | --- | --- |
| 0 Baseline and fixtures | Done | Integration points mapped per area; synthetic fixtures in `packages/protocol/src/testing/{rich-content-fixtures,artifact-tool-fixtures}.ts`, backend `transcript-artifacts/fixtures/`, `RichMarkdownBlocks.test.tsx`; long-transcript fixture `apps/web/src/components/chat/rich-transcript.long-fixture.test.tsx`; real-browser performance gate `e2e/perf/rich-transcripts-perf.ts` over `e2e/fixture/RichTranscriptPerfFixture.tsx`. |
| 1 Protocol readers and durable foundations | Done | `packages/protocol/src/transcript-artifacts*.ts`; store, idempotency, outbox, restart recovery, deletion fences in `apps/backend/src/core/transcript-artifacts/`; race table in `service-races.test.ts`; unsupported/invalid placeholders in `ArtifactPart.test.tsx`. |
| 2 Rich frames and code | Done | `RichBlockFrame`, `CodeBlock` (Shiki worker), streaming coalescing, exact copy, Run in terminal, minimal diff hunks (now backend-rendered; see `docs/architecture/change-tracking.md`). |
| 3 Diagrams, tables, callouts, disclosures, media | Done | `MermaidBlock` (backend-supervised render + client sanitization), `RichTable`, `RichCallout`, `RichDetails` (micromark extension), media resolver, gallery, `FilePreview`. |
| 4 Charts and workflow | Done | `chart-spec`/`chart-scene`/`chart-svg` with geometry tests; `NativeChart`; workflow collector with status adapters, `WorkflowSnapshotCard`, `WorkflowLiveInspector`. |
| 5 Static HTML through the transcript | Done | Static preview job reusing `designBootstrap`; sanitizer diagnostics returned to the agent; static artifact published and rendered by a real Codex turn. |
| 6 Executable interactive HTML | Done | Preparation (HTMLRewriter, CSP hashes), content server, four-message channel, desktop `WebContentsView` host, container worker; calculator/bug/d3 fixtures; runaway, escape and credential-canary matrices in real Chrome and Docker. |
| 7 Provider parity, projection, history | Done | Artifact tools auto-allowed and recorded publish calls tested through each provider's real translation path (Claude, Codex, OpenCode, Cursor, Grok/ACP, Pi); OpenCode per-turn grant; ledger-driven placement with live hint, also in the backend projection; Codex reload keeps the publish call. Live cycle passed on all six providers. |
| 8 Cross-cutting behaviour | Done with limits below | Find segments and reveal, copy semantics, focus return, follow pausing, keep-mounted row, protected-content clearing, scoped caches. |
| 9 Qualification and handoff | Partly | Repository gates pass (`format:check`, `lint`, `typecheck`, `mise run test`). Live browser pass via `e2e/agent-testing/rich-transcripts-live.spec.ts` (opt-in) on all six providers; real-browser performance gate within 10%; Electron host qualified; Chromium, Firefox and WebKit engine matrix. No PR opened. |

## Real-stack evidence (2026-10-20)

Isolated profile `rich-transcripts-qa` (`dev:test --fixture`, Claude and Codex
credentials), Google Chrome, macOS, Docker 29.8:

- A real Codex turn created a deliberately wrong calculator revision, received
  `Probe 0 (expect-text on "total"): Expected text "60", observed "50"`,
  repaired it with `update_artifact`, passed all five probes, and published
  only revision 2 with its receipt. This found a real defect (publish compared
  a resolved dependency identity with the whole-manifest hash), fixed with a
  regression test.
- The published card rendered with "Revision 2 · Verified at light 960×640 ·
  Interactions verified by 5 probes"; Run interactive executed it inside
  `sandbox="allow-scripts"` on the content origin; tasks = 8 gave 96. The
  served document carried the generated CSP (script hashes, `sandbox
  allow-scripts`, `connect-src 'none'`), `nosniff`, `private, no-store`,
  `no-referrer`, no redirect. A clipping defect (the live frame painted over
  the tab strip) was found and fixed.
- Chart, Mermaid and static HTML artifacts published by the same agent; after
  a backend restart all four publications were read back from the ledger and
  rendered.
- The specification's rich Markdown fixture rendered callout, disclosure,
  table, Mermaid and chart; find opened the hidden disclosure for its match
  and restored it on close; at 390 px there was no horizontal overflow and no
  toolbar button outside its card (after a wrapping fix).
- Claude was rate-limited (HTTP 429) during the run, so the live cycle was
  demonstrated on Codex only.
- After all fixes, `e2e/agent-testing/rich-transcripts-live.spec.ts` passed in
  one run (1 passed, 51 s): real Codex authoring with a failed probe, repair
  and receipt-matched publication (preview in the container worker under the
  `auto` isolation default), verified card, Run interactive = 96 under the
  generated CSP and headers, clipping, reload recovery, the rich Markdown
  fixture, find reveal and restore, and the 390 px layout. Run with
  `ORKESTRATOR_AGENT_TEST_LIVE_RICH_TRANSCRIPTS=1` on a profile with Codex
  credentials.
- Provider parity, 2026-10-20, after the remaining-work round (viewer shell,
  backend projection, PDF, media streams), profile `rich-transcripts-qa`,
  Google Chrome: the spec, parametrised by `ORKESTRATOR_AGENT_TEST_RICH_PROVIDER`,
  passed end to end on **Codex** (89 s), **OpenCode** (87 s) and **Cursor**
  (46 s): failed probe, repair, receipt-matched publication, verified card,
  Run interactive = 96 through the trusted viewer shell (its `frame-src`
  names exactly the document URL; the document keeps `sandbox allow-scripts`),
  clipping, reload recovery, the rich Markdown fixture (sent fenced, so every
  rich block checked comes from the agent's reply), find reveal and restore,
  and the 390 px layout. After the host sign-ins were renewed the same spec
  passed on **Grok** (72 s), **Pi** (62 s, `openai/gpt-6.1-sol`) and
  **Claude** (48 s), so all six providers have completed the cycle live. Pi's
  default model was the retired first catalogue entry (`openai/gpt-4`), which
  ended the turn with no reply and no error; the spec takes
  `ORKESTRATOR_AGENT_TEST_RICH_MODEL` for that.

## Remaining work

### High

- [x] `qualification` Run the live author → fail → repair → publish → reopen cycle on every provider. Done 2026-10-20: Codex, OpenCode, Cursor, Grok, Pi and Claude all passed `e2e/agent-testing/rich-transcripts-live.spec.ts` live (see Real-stack evidence).
- [x] `qualification` Measure the performance gate in a real browser: median/p95 composer latency and scroll frame time against the pre-change baseline with a seeded large transcript (≤10% regression). Done 2026-10-20 with `e2e/perf/rich-transcripts-perf.ts` against `67a6cc31` in Chrome 155 (5 interleaved runs each): composer median +4.4%, p95 +1.6%, scroll frame median 0%, p95 −0.4%; caches, queue, view state and the worker count converge within `FRONTEND_RENDER_POLICY`. Numbers, method and limits in [rich-transcripts.md](../../architecture/rich-transcripts.md#performance-gate).
- [x] `qualification` Run `mise run test:agent:electron` and the desktop live-host probe (`apps/desktop/tests/artifact-host-live-probe.ts`) on the release Electron build and record the output. Done 2026-10-20 on Electron 44.7.0 (macOS): suite 22 passed, 1 skipped (Linux-only); probe 24/24 twice; new `e2e/agent-testing/artifact-host-electron.spec.ts`. Evidence and limits in [transcript-artifacts-runtime.md](../../architecture/transcript-artifacts-runtime.md#desktop-host-qualification-2026-10-20).

### Medium

- [x] Project publications in the backend transcript projection as well, so surfaces other than the native agent tab see them. Done: the projection places each publication beside its call (progressive view, `revisedMessages` outside the window, direct pages, sync-v1 and whole-transcript projections); unanchored publications stay a native-tab row. See [Publication placement](../../architecture/rich-transcripts.md#publication-placement).
- [x] Codex history reload in code mode does not keep the `publish_artifact` call record (`history/rollout.ts` reads the `exec` cell), so reloaded publications fall back to time placement. Done: the reload renders the rollout's recorded `McpToolCall` (`item_completed`) through the live normalization, so the reloaded part equals the live one; a cell with no record falls back to a bounded strict-JSON parse of `tools.mcp__<server>__<tool>({...})` (`history/code-mode-mcp-calls.ts`), which never claims success.
- [x] Process isolation mode still renders static HTML and Mermaid with browser-level network denial only; make the container worker the documented default for packaged installs, or ship it. Done: the backend build ships the worker build context (`dist/artifact-runtime/worker-context/`) and `transcript_artifact_prepare_worker` (the card's and draft inspector's "Prepare isolated preview worker" action) builds it, or pulls a published digest, with fixed Docker arguments, pins the id under the data directory and re-selects isolation, so `auto` switches to container without a restart; status in `capabilities().workerPreparation`. See the runtime guide's [Preview worker](../../architecture/transcript-artifacts-runtime.md#preview-worker) section.
- [x] Remote browsers (Tailscale Serve) need a hosted `ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN` for live interactive viewing; document the setup in the remote gateway guide. Done: [Live artifacts in remote browsers](../../architecture/remote-gateway.md#live-artifacts-in-remote-browsers); `ORKESTRATOR_ARTIFACT_CONTENT_BIND` moves the listener to a Tailscale (or loopback) interface only together with a content origin (`resolveContentListenerConfig`, tested).
- [x] Bundle ES-module imports for interactive artifacts with a fixed bundler configuration instead of rejecting them; extend the dependency manifest beyond `d3`. Module scripts import declared dependencies (`d3`, `chart.js`, `chart.js/auto`) by bare specifier; see the runtime guide's interactive preparation section.
- [x] PDF: a stored PDF representation and isolated print profile, and an isolated first-page preview for PDF attachments (download fallback today). Done: `pdf` representation of HTML publications printed by the supervised worker under the fixed print profile (A4/Letter, backgrounds, reduced motion, ≤100 pages, ≤20 MiB), bound to the receipt and stored per profile; `transcript_media_pdf_preview` renders page 1 with the pinned pdf.js 6.4.299 in the network-denied worker (no PDF scripting, XFA or eval). See [PDF output](../../architecture/transcript-artifacts-runtime.md#pdf-output-of-html-artifacts) and [PDF attachment previews](../../architecture/transcript-artifacts-runtime.md#pdf-attachment-previews).
- [x] Range-capable media serving; audio/video load on explicit activation and are capped at 8 MiB today. Done: after activation, environment audio/video streams from a short-lived `/m/<capability>` on the artifact content origin with single byte ranges (`transcript_media_open_stream`; host files read in place up to 2 GiB, container files staged once up to 512 MiB), bytes sniffed, authorization and confinement re-checked per request; the bounded base64 path remains the fallback. See [Media streams](../../architecture/transcript-artifacts-runtime.md#media-streams).
- [x] Clear a conversation's protected rich content when its native session is deleted or its permission revoked (`clearRichConversationContent` exists; no product event calls it). Done: the ledger hook treats a re-read that finds no publications where it showed some (the `transcript-artifact` hint `deleteConversation` sends, or a remount) as a deletion, and a ledger read failing with `not_found` or a permission error as revocation; a publication or representation read failing that way re-checks the ledger first. Each clears once (`revokeArtifactConversation`). Native sessions have no deletion path: projection `missing` and the `deleted` native-session change are tab teardown or re-adoption, which keep the conversation. See [Protected content clearing](../../architecture/rich-transcripts.md#protected-content-clearing).
- [x] Qualify the executable CSP and iframe sandbox in Firefox and WebKit (Chromium and Electron only so far). Done 2026-10-20: `content-server.engines.test.ts` runs the same probes with unrestricted controls in Chrome 155, Firefox 157 and WebKit 27.2 (39 passed, 13 per engine). Every engine behaves the same. The qualification found that the frame could navigate itself (meta refresh, `location`, `data:`/`blob:`, redirects) in all three; the browser host now frames a trusted viewer shell (`/s/<capability>`, `content-shell.ts`) whose path-exact `frame-src` blocks every such navigation (0 sink requests in each engine) and disposes the live view on an unexpected load, as the desktop shell already did. See [Browser engine qualification](../../architecture/transcript-artifacts-runtime.md#browser-engine-qualification-2026-10-20).
- [ ] Publish the preview worker image to a registry and pin packaged installs by digest (the pin is host-local today). Tooling ready, publishing left to the maintainer: `docker/artifact-preview-worker/publish.sh <repository> [tag]` pushes a multi-architecture image and records the digest in the checked-in `published-image.json`, which packaged builds ship and preparation pulls; it still holds `null` until someone runs it (steps in the runtime guide).
- [x] Cut streamed code layout cost while preserving selection: line layout containment and deferred highlighting until fence closure pass the 4× CPU performance gate (composer median +2.4%, p95 −1.4%, scroll unchanged). Three interleaved runs per checkout, twenty cycles each; all resources converge. [Review-fix evidence](../../handoff/2026-10-20-rich-transcript-review-fixes.md#throttled-performance-gate).

### Low

- [x] Mermaid math labels render as a `math_labels_unsupported` diagnostic; render them safely if a MathML path can be qualified. Done (kept the diagnostic): pinned Mermaid 12.2.0 always renders math through `foreignObject` HTML labels (it forces HTML labels for `$$` labels) with fixed KaTeX options and no finite `maxSize`, and MathML has no `foreignObject`-free SVG form; evidence in [Mermaid math labels](../../architecture/transcript-artifacts-runtime.md#mermaid-math-labels).
- [x] Observe rich-block visibility per block rather than per row for idle prefetch. Done: code blocks and diagrams register with the transcript's one IntersectionObserver (`useRichBlockVisibility`, at most 256 per transcript), so offscreen blocks of a long row prefetch and are promoted when they scroll in.
