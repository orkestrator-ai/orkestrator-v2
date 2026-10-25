# Transcript artifacts: storage, verification and executable runtime

Backend ownership, records, verification, publication, and how
`html-interactive` content is prepared, previewed and displayed without
application authority. Rendering in the transcript is described in
[rich-transcripts.md](rich-transcripts.md); the agent-facing contract in
[transcript-artifacts-agent-guide.md](transcript-artifacts-agent-guide.md).

Code: `apps/backend/src/core/transcript-artifacts/`, `apps/desktop/electron/artifact-host-*.ts`,
`docker/artifact-preview-worker/`, shared contracts in `packages/protocol`.

## Ownership and authority

Every record belongs to an `ArtifactOwner { backendId, environmentId,
projectId, conversationKey }`:

- `backendId` is the SQLite database `instanceId`.
- `conversationKey` is the native logical session key `env-<environment>:<tab>`.
  A tab id is how a credential names the conversation; closing the tab
  deletes nothing, and reopening the conversation recovers its artifacts.
  A backend workflow session (Multi Review reviewer, build-pipeline stage,
  feature planning) is its own conversation under the session's durable key
  (see [rich-transcripts.md](rich-transcripts.md#workflow-transcripts)).
- Agent tools derive the owner from the authenticated tool credential
  (`AgentToolScope`). Callers can never nominate a project, environment,
  conversation, path or target message.
- When the credential is environment-wide (OpenCode's server registration),
  the tools require `scopeCapability`: an artifact-only grant minted at
  dispatch (`artifactDispatch.beginTurn` in the native agent service), bound
  to owner, provider session, turn and verbs, with its own HMAC secret and
  signing domain (`grants.ts`), at most 24 hours, digest-only persistence,
  revoked when the turn's outcome is recorded, and also when the provider
  send throws (rejected or ambiguous dispatch). OpenCode receives it in the
  prompt request's `system` field, never in visible prompt text. Because the
  model passes it back as a tool argument, `redactArtifactGrantArgs`
  (`@orkestrator/protocol/transcript-artifacts`) replaces `scopeCapability`
  with `"[redacted]"` in OpenCode transcript normalization
  (`opencode-messages.ts`) and in every projected part (`projectionPart`,
  before the projected-message cache), for canonical artifact tool calls and
  for any value shaped like a grant (`oag1.`). The provider's own history may
  keep the (revoked) value. Grants never appear in results, diagnostics or
  logs.
- Workflow-result credentials take the restricted branches in
  `createAgentToolServer` before artifact tools are registered, so they can
  neither see nor authorize artifact operations.
- A workflow turn's grant (minted through the same `artifactDispatch`,
  `workflow-artifact-turns.ts`) also authenticates the artifact-only
  `/artifact-mcp` server that the HTTP bridges attach as
  `orkestrator-artifacts` beside the workflow-result server: the grant is the
  bearer token, the server lists only the artifact tools, and every call is
  authorized with that grant (`registerTranscriptArtifactTools`'
  `boundGrant`), never with a model-supplied `scopeCapability`. A grant opens
  nothing on `/mcp`; no other credential opens `/artifact-mcp`; a revoked or
  expired grant, or artifact publication rolled back, closes it.
- Missing and out-of-scope records both answer `not_found`. UI reads use
  `environmentId + logicalSessionKey` and are checked against the stored
  owner and this backend's id.

## Records and storage

One engine store per environment (`store-layout.ts`, `store.ts`) holds heads
(current/published revision, storage generation), immutable revisions,
operations, successful receipts, publications (unique per owner, artifact and
revision; conversation sequence allocated in the publication transaction),
idempotency records keyed by `(owner, operationKind, requestKey)` with a
semantic digest that excludes credentials, an outbox, grants and quota
counters. Revision `N + 1` never overwrites `N`; kind is fixed per artifact.

Every row has a `schemaVersion`; decoding runs the explicit migration chain
(`RECORD_MIGRATIONS` in `store-records.ts`, today only the version-1
identity), refuses any unknown version as `storage_corrupt`, and re-validates
identity, ownership, kind discriminants and cheap payload/asset/evidence
shapes. Full content validation is not repeated per read; served bytes are
re-hashed instead.

Binary content is content-addressed under
`<dataDir>/transcript-artifacts/<environment>/assets/<sha256>`. Mutations
stage bytes outside any transaction (exclusive create, hash and length check,
fsync), promote them without overwriting different bytes, then commit the
referencing records in one synchronous transaction and notify only after the
commit. A crash between promotion and commit leaves an unreferenced file,
never a dangling reference. A missing or mismatched referenced asset reads as
`storage_corrupt`, never a blank success.

Hashes (`hashing.ts`) are SHA-256 over domain-separated canonical encodings;
`inputHash = SHA256("artifact-verification:v1\0" + canonicalJSON(identity))`.

Create and update follow the spec's step 1: after validation one short
transaction reserves the request key (a `pending` idempotency row with a
two-minute holder lease) and, for create, an unpublished-draft slot
(`pendingCreates` on the conversation row); update checks head, kind,
expected revision, revision limit and repair budget there too. Expensive work
(workflow collection, asset bytes) runs afterwards, and the commit
transaction re-checks everything and replaces the reservation with the
result. A concurrent duplicate in the same process awaits the original; a
live reservation held by another process answers a transient
`capacity_exceeded` (`request-in-progress`); a lapsed one is taken over and
the collector drops it.

Quotas refuse new work instead of evicting: 100 unpublished artifacts per
conversation (counting reserved slots), 100 revisions per artifact, 1 GiB of
assets per environment, two nonterminal preview operations per conversation,
64 staged uploads per conversation.

Cleanup (`gc.ts`) runs at startup and hourly: staging files older than an
hour, unpublished drafts idle for seven days (idempotency tombstones are kept
and answer `expired`), unreferenced preview assets after 24 hours.
References are re-checked under the store lock before unlinking. Deleting an
environment deletes its artifact store through the same hook web annotations
use; scrolling, closing a tab or an inactive environment never does.

`deleteConversation(environmentId, conversationKey)` removes one
conversation: one transaction sets a `deletedAt` fence on its conversation
row (checked by every write that adds records for a conversation, including
preview completion) and deletes its heads, revisions, derived documents,
operations, receipts, publications and keys, idempotency rows, repair
counters, staged uploads and outbox events; then its running previews are
aborted, its grants and live capabilities revoked and a change hint sent.
Shared content-addressed bytes are only marked unreferenced and reclaimed by
the collector after its grace period. No product path calls it yet: the
product has no explicit native-conversation deletion (closing a tab retains
the conversation). When it is called, the renderer recognises the deletion
from its change hint (the ledger re-read finds no publications where it
showed some) and clears that conversation's protected rich content; see
"Protected content clearing" in [rich-transcripts.md](rich-transcripts.md).

## Verification and publication

`preview_artifact` admits an asynchronous operation and returns its id
immediately. When the preview runner reports synchronously that it cannot
admit the job (`admissionRefusal`: conversation, environment or global queue
full), admission answers a transient `capacity_exceeded` naming that
resource instead of admitting an operation that would only fail later;
nothing is recorded under the request key. A worker that crashes (a
transient result, or the runner throwing) is retried at most twice with
jittered backoff. Per kind:

| Kind | Work | Receipt gates |
| --- | --- | --- |
| `chart` | `validateChartSpec`, `buildChartScene`, `chartSceneToSvg`; SVG stored as renderer output | schema, bounded-render |
| `mermaid` | Supervised Chromium job; sanitized SVG stored. Math labels (`$$…$$`) are refused before any worker starts with diagnostic `math_labels_unsupported` (see below) | schema, syntax, bounded-render |
| `workflow-snapshot` | `workflow-collector.ts` reads Multi Review, Looped Review or Build Pipeline records at an exact revision | schema, authoritative-source |
| `html-static` | Supervised Chromium job with the unchanged design runtime sanitizer; effective document and captures stored | schema, syntax, supervised-visual |
| `html-interactive` | Deterministic preparation, then a supervised job under the executable policy with declared probes | schema, syntax, supervised-visual + every probe passed |

Operations use leases and generations: a late, cancelled or deleted
environment's completion cannot commit. Cancellation records
`cancellationRequestedAt` on a running job until it really ends. Restart
recovery marks unfinished operations `interrupted`; nothing is re-run or
published automatically. Failed probes and diagnostic captures stay on the
operation and never produce a receipt.

`publish_artifact` reloads the receipt, re-checks ownership, exact revision,
source/effective/asset hashes, required gates, current policy, sanitizer,
dependency-manifest and browser identity, evidence presence, and that the
revision is still the head. The receipt's `rendererBundleHash` must match the
current bundle of its kind (the runner's `status().rendererBundleHashes` for
HTML and Mermaid; `CHART_RENDERER_BUNDLE_HASH`, derived from
`CHART_RENDERER_VERSION`, for charts; `not-applicable` for workflow
snapshots), and a Mermaid receipt's browser build must match the current one
whenever a browser is known. It is idempotent per (owner, artifact,
revision). Every committed draft, operation or publication change, and a
conversation deletion, is followed by a content-free `resource-changed` hint
of kind `transcript-artifact` whose id is the conversation key.

The repair budget is the initial preview plus two source repairs per
(owner, artifact, dispatched turn); turns are attributed by
`noteDispatchedTurn` at dispatch. Only an update made after a failed preview
of the previous revision (and no successful one) is a repair; a deliberate
update before any preview or after a successful one costs nothing.

## Preview worker

`preview-runner.ts` admits jobs: 1 running per environment and 2 globally,
8 queued per environment and 16 globally, 8 MiB of queued metadata (an
interactive job is charged its authored size plus probes, not its full
prepared document), fair dequeue across environments with aging, typed
`capacity_exceeded` naming the exhausted resource. Deadlines: 15 s queue,
30 s worker wall time including launch with 5 s readiness, 45 s operation,
2 s cleanup grace, then hard termination.

Isolation (`ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION`):

- `auto` (default): at startup the backend asks Docker (bounded to 5 s)
  whether the worker image is present. If so it uses `container`, otherwise
  `process`. The choice is fixed for the process lifetime; status reports
  `isolationSelection: "auto"`.
- `container`: the pinned worker image (`docker/artifact-preview-worker/`,
  Playwright 1.64.0 base pinned by digest) runs with `--network none
  --read-only --tmpfs /tmp --memory 1g --cpus 2 --pids-limit 128 --user
  pwuser --cap-drop ALL --security-opt no-new-privileges`, a seccomp profile
  that adds only `chroot` to Playwright's published profile so Chromium's
  sandbox can start, and no repository, home, credential or socket mounts.
  No host environment is passed (only `HOME=/tmp`). The job package goes in
  on stdin and bounded results come back on stdout. This is the OS-level
  network boundary and the only boundary that runs authored JavaScript by
  default. Containers carry an owner label derived from the data directory,
  and startup removes only this backend's orphans.
- `process`: each job runs in a fresh worker process with its own Chromium
  started through Playwright `launchServer()`, Chromium's sandbox required.
  The worker gets a scrubbed environment (fixed `PATH`, nothing inherited:
  no tokens, credentials, proxies or user configuration) and a private,
  owner-only scratch directory that is its `HOME`, `TMPDIR`, XDG directories
  and cwd; the directory is removed once the exit is verified. The watchdog
  lives in the backend, kills the whole process tree on deadline or memory
  breach (single process over 1 GiB or tree over 4 GiB, sampled every
  500 ms), and verifies exit before freeing the slot. Network denial is
  defense in depth only: resolver and proxy launch flags, WebRTC limited to
  proxied UDP, request interception installed before page creation, and the
  CSP. Because there is no OS network or filesystem boundary, process mode
  **refuses `html-interactive`** with `renderer_unavailable` ("interactive
  previews need the container worker; set
  ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION=container or explicitly allow process
  isolation with ORKESTRATOR_ARTIFACT_PREVIEW_ALLOW_PROCESS_INTERACTIVE=1").
  `html-static` (only the design runtime's own bootstrap executes) and
  Mermaid (application-owned renderer code only) still run.
- `disabled`: HTML and Mermaid previews report `renderer_unavailable`;
  charts and workflow snapshots still verify.

`PreviewRunnerStatus` reports the boundary honestly: `isolation` (where jobs
run), `interactiveIsolation` (`container`, `process` only with the opt-in, or
`unavailable` with `interactiveReason`), `isolationSelection`,
`quarantinedWorkers`, and `workerImage { reference, pinned }`.

Capacity is released only on positive evidence that the boundary is gone:
no owned process remains (process mode), or Docker answers a name-filtered
`ps` successfully with nothing listed (container mode; an unreachable daemon
is not evidence). Otherwise the slot is **quarantined**: it still counts
against global and per-environment running capacity while a bounded reaper
re-runs kill-and-verify (10 attempts over about 2 minutes). If the reaper gives
up, the slot stays held and is reported; when every slot is quarantined the
runner reports itself unavailable. The operation itself has already
answered; a quarantined slot does not count against its conversation.

Worker image pinning. A content-addressed `ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE`
(`sha256:<id>` or `<name>@sha256:<registry digest>`) is used as-is.
`docker/artifact-preview-worker/build.sh` records the built image id in the
git-ignored, host-local `image-pin.json` (local image ids are not
reproducible across hosts); when the configured tag matches that pin and the
id is present, jobs run the id rather than the mutable tag. Without a pin, or
when the pinned id is gone, the tag is used and a warning is logged. For a
published image, push it and set the registry digest
(`docker buildx imagetools inspect <name>:<tag>`).

Preparing the worker on demand (`transcript_artifact_prepare_worker`,
`preview-worker-prepare.ts`). Packaged installs carry no repository, so the
backend build (`apps/backend/scripts/build.ts`) ships the complete worker
build context in `dist/artifact-runtime/worker-context/` (exactly what
`build.sh` stages: Dockerfile, npm manifest and lockfile, the Node worker
bundle, every hash-verified pinned bundle, licenses) plus the seccomp
profile and `published-image.json`. The command (and the "Prepare isolated
preview worker" action the artifact card and draft inspector show when
capabilities report `interactiveIsolation: "unavailable"` and
`workerPreparation.available`) then runs one of two fixed routes: when
`published-image.json` records a digest it runs `docker pull --quiet
<image>@<digest>`; otherwise `docker build --quiet --pull=false --label
orkestrator.artifact-preview-worker=1 --tag
orkestrator-artifact-preview-worker:1 <shipped context>` (a source checkout
stages the context with `stage-context.ts` first). Each Docker call has a
fixed argument vector and a 10-minute bound; output is never logged, only the
image id is read. A built id is pinned in
`<data dir>/artifact-preview-worker/image-pin.json`, which later startups
prefer. Afterwards isolation is re-selected without a restart: under `auto`
(and an explicit `container`) a new container runner with the
content-addressed image replaces the process runner; new jobs go to it and
the old runner closes once its admitted work drains (at most 60 s). An
explicit `process` or `disabled` setting, or an explicit
`ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE`, is never overridden. One preparation
runs at a time; its state (`idle`, `preparing`, `ready`, `failed`, method,
content-free reason) is reported in `capabilities().workerPreparation`.

Publishing (maintainer only). `docker/artifact-preview-worker/publish.sh
<repository> [tag]` stages the same context, builds `linux/amd64` and
`linux/arm64` with `docker buildx build --push`, reads the pushed
manifest-list digest back with `docker buildx imagetools inspect`, and writes
`image`, `tag`, `digest` and `publishedAt` into the checked-in
`published-image.json`. Steps: `docker login <registry>`, run the script,
review and commit `published-image.json`, then build the backend so packaged
installs ship the pin. Until that happens the file holds `null`s and
preparation builds locally. Nothing in the product pushes or logs in.

Packaging. The worker image installs `playwright-core` with `npm ci` from
`docker/artifact-preview-worker/package-lock.json` (generated with the base
image's own npm; `tests/unit/version-drift.test.ts` checks it against the
manifest, the backend pin and the base-image tag). License texts for every
pinned bundle (d3, Chart.js, Mermaid, DOMPurify, pdf.js) ship beside the bundles as
`licenses/<id>/LICENSE*` plus `THIRD_PARTY_NOTICES.txt`, both in the backend
build output (`dist/artifact-runtime/`) and in the image
(`/opt/artifact-preview-worker/`). Mermaid's minified bundle embeds its own
dependencies; their notices are those preserved inside `mermaid.min.js`.

Qualified on macOS with Google Chrome and Docker 29.8 (both modes unless
noted): the calculator probes, the deliberate 80-instead-of-96 failure, the
offline d3 fixture, infinite loops before and after readiness, Mermaid kills
at the 5 s deadline, and the runaway matrix in `preview-runaway.test.ts`:
unbounded allocation (process: the RSS watchdog, `worker-memory`; container:
the renderer dies under the 1 GiB cgroup, `renderer-crash`), a DOM flood past
10,000 elements (`dom-elements`), a recursive microtask loop started after
readiness (`render_timeout`), an endless `requestAnimationFrame` animation
(completes normally) and huge canvases (`worker-memory` / `renderer-crash`).
Each ended within its deadline, the process tree or container was verified
gone, nothing stayed running or quarantined, and the next calculator job
passed. `preview-escape.test.ts` seeds canaries (an environment variable of
the backend process, a file in a fake `HOME`, and a session cookie from a
local "application" server) and tries images, CSS, fonts, scripts,
fetch/XHR, WebSocket, beacon, workers, EventSource, iframe, `<object>`,
forms, prefetch, preconnect, dns-prefetch, RTCPeerConnection (STUN to a local
UDP sink), redirects, meta refresh, popups and a custom scheme. A
deliberately unrestricted Chromium page reached the HTTP sink, opened TCP
connections, sent STUN datagrams and carried the cookie canary; the preview
reached none of them in either mode, and no canary appeared in the result,
the PNG bytes, the probe observations or any request a sink saw. DNS
egress itself is not observed by a sink (Chromium maps every host to
NOTFOUND in process mode; the container has no network).

### Mermaid math labels

Mermaid renders `$$…$$` math through KaTeX inside HTML labels. HTML labels
stay off (`htmlLabels: false`, strict security) because they would put HTML
`foreignObject` content back into the diagram. Instead of silently showing the
raw `$$` text, the runner refuses such a source before any worker starts:
`validation_failed` (resource `math-labels`) with diagnostic
`math_labels_unsupported` and the line/column of the first `$$`. `$$` inside
`%%` comments is ignored. Authors write the expression as plain text or
Unicode (`x² + y²`).

Evidence for keeping the refusal (pinned `mermaid@12.2.0`, checked
2026-10-20 against its sources and Context7's Mermaid math documentation):

- KaTeX ships inside the pinned `mermaid.min.js`, but math cannot be rendered
  with HTML labels off. `createText.ts`'s label path sets
  `useHtmlLabels = true` whenever a label contains `$$` and then always emits
  `<foreignObject><xhtml:div>…</div></foreignObject>` (`addHtmlSpan`);
  sequence diagrams draw math with `drawKatex`/`byKatex`, which also append a
  `foreignObject` (`dist/mermaid.js` around lines 37347, 45099, 259220 and
  260328 of the unminified bundle).
- KaTeX output is HTML or MathML (`output: "mathml"`, or `"htmlAndMathml"`
  under `legacyMathML`/`forceLegacyMathML`). MathML is not part of SVG's
  content model, so there is no pure-SVG form a `foreignObject`-free sanitizer
  could keep; the documented `legacyMathML` options only change the fallback
  inside the same HTML label.
- Mermaid calls `katex.renderToString(expr, { throwOnError: true,
  displayMode: true, output })` with fixed options. `trust` stays KaTeX's
  default (`false`), but `maxSize` (default unbounded) and `maxExpand`
  cannot be set, so the spec's finite-limit requirement cannot be met through
  Mermaid's configuration either.

Supporting math would therefore mean pre-rendering labels with a separately
pinned KaTeX and allowing a narrow `foreignObject` + MathML vocabulary in both
SVG sanitizers, which the policy forbids for diagrams inserted into the
application DOM. The refusal is the supported behaviour.

### Interactive preparation

`interactive-prepare.ts` parses HTML with Bun's `HTMLRewriter` and scripts
with `Bun.Transpiler.scanImports` (which, unlike `Transpiler.scan` and
`transformSync`, does not run Bun macros); nothing authored is evaluated. It
rejects external scripts, imports other than the module imports below, inline
event handlers, `<base>`, meta refresh and policy, nested browsing contexts,
resource hints, import maps and external CSS (found by `scanCssResources`,
which tokenizes escapes, `image-set` and `@import`). `artifact-asset:<name>`
references become data URLs from authorized assets (magic-byte MIME checks,
dimension and byte bounds). Dependencies come only from the checked-in
manifest in `dependency-manifest.ts`, are sha256-verified at load, and the
backend build copies and re-verifies the bundles into `dist/artifact-runtime/`
with their license texts and `THIRD_PARTY_NOTICES.txt`:

| Id | Bundle (pinned bytes) | Global | Module specifiers | License |
| --- | --- | --- | --- | --- |
| `d3@7.9.0` | `d3/dist/d3.min.js` (UMD) | `d3` | `d3` | ISC |
| `chart.js@4.5.1` | `chart.js/dist/chart.umd.min.js` (UMD, embeds `@kurkle/color` 0.3.2, MIT) | `Chart` | `chart.js`, `chart.js/auto` | MIT |

The frame runtime from `artifact-frame-channel.ts` is injected first, then
the declared dependencies verbatim as classic scripts, then authored scripts.

Module scripts (`interactive-modules.ts`). A `<script type="module">` may
import only the specifiers of dependencies listed in `dependencyIds`; an
import of an undeclared manifest dependency fails with
`undeclared_dependency` naming the id to add, and every other import
(relative, absolute, URL, `data:`, `node:`/`bun:`, other packages,
`require`, any `import()`) with `unresolved_import`. Each module script is
then bundled by `Bun.build` with one fixed configuration (`target: browser`,
`format: esm`, no minification, no source map, no splitting, `external: []`,
`allowUnresolved: []` so computed `import()` fails, `env: "disable"` and a
fixed `process.env.NODE_ENV` define, `macros: false`) and a single
application-owned resolver plugin. The plugin serves the authored text from
memory, resolves a declared specifier to the dependency's `moduleShim` (one
line of CommonJS re-exporting the global, e.g. `module.exports =
globalThis.d3;`), refuses everything else, and refuses any load from disk.
The library bytes are therefore never re-bundled: the pinned UMD file runs
byte for byte (shared by classic and module scripts), and the bundle holds
only Bun's CommonJS-interop helpers, the shim and the authored code. Bun
macros are the only bundler feature that executes code at build time; they
resolve from disk and bypass plugins, so `macros: false` is required and a
probe build proves it is honoured once per process before any authored
source is bundled (otherwise preparation fails `renderer_unavailable`). The
bundle replaces the script's text in place (escaped like injected scripts,
re-parsed, and covered by the same byte-for-byte hash check), counts toward
the 16 MiB prepared limit, and at most 16 module scripts are bundled per
document. Output is deterministic for identical input and Bun version; the
prepared result records `moduleBundler` (`artifact-module-bundler:v1
bun@<version>`), and stored documents are never re-prepared after an upgrade.

The CSP is generated from the exact serialized script bytes:

```text
default-src 'none'; script-src <sha256 hashes>; script-src-attr 'none';
style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none';
connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'; sandbox allow-scripts;
frame-ancestors <application origins> orkestrator-artifact-shell://viewer
```

The original source, the canonical dependency manifest and the prepared
document each have their own digest; the prepared document is stored as its
own asset.

### Probes

Declarative only: `click`, `set-number`, `fill`, `expect-text`,
`expect-number`, `wait-visible` against one unique
`[data-artifact-test="<id>"]`, at most 20 steps of 2 s each, run by
application-owned Playwright code. The first failure stops the run with the
step index and observed value.

### PDF output of HTML artifacts

`transcript_artifact_read_representation` with `representation: "pdf"` (and
`paper: "a4" | "letter"`, default A4) returns a PDF of exactly the published
revision (`service-print.ts`). On the first request for a (receipt, print
profile) pair the backend runs an `html-print` job through the same preview
runner as previews: same admission (it counts against the owner
conversation), queue/worker/operation deadlines, cancellation (environment
or conversation deletion and shutdown abort it) and fencing (a result for a
deleted environment or a publication that changed is discarded). Static
documents go through the design runtime exactly as their preview did, and
the hash of the sanitized document printed must equal the receipt's
`effectiveSourceHash` or the PDF is refused (`preview_stale`). Interactive
documents print the stored prepared package the receipt names, served from
memory under its own CSP, after the runtime's readiness signal (the initial
settled state; no probes run); bytes prepared under an older policy or
runtime are refused as for live sessions. Authored `window.print()` is a
no-op installed before any document script and is never called; printing
uses DevTools print-to-PDF.

The print profile (`print-profile.ts`, version `artifact-print-profile:v1`)
fixes the paper, 10 mm margins, scale 1, backgrounds on, reduced motion, and
takes theme and viewport from the receipt's preview profile; its SHA-256
identity is recorded. Output is bounded to 100 pages (the worker prints
pages 1–101 and refuses when more than 100 come back) and 20 MiB, and the
backend re-checks the signature, size and page count. Interactive printing
runs authored JavaScript, so process isolation refuses it exactly like
interactive previews. Charts and Mermaid have no `pdf` representation (their
SVG and PNG exports remain); workflow snapshots neither.

The PDF is stored as a content-addressed asset (counted against the
environment quota) and recorded on the revision's derived row as
`printed[]` (receipt id, effective hash, print-profile hash and version,
paper, page count, browser build, renderer hash; at most four per revision),
which the collector treats as a reference. Later reads return the stored
bytes; collected or damaged bytes are printed again. The response is
`application/pdf`, base64, with a filename from `safeArtifactFilename` and a
`print` block naming the profile, page count and receipt. The card's
**Download PDF** action saves it as an attachment (paper from the reader's
region); **Print saved preview** remains the fallback.

### PDF attachment previews

`transcript_media_pdf_preview { environmentId, source }` renders page 1 of a
PDF attachment (`commands-pdf.ts`, `service-media-pdf.ts`). The bytes are
read only by invoking the existing registered readers with their own
confinement: `read_file_base64` for an absolute host path,
`read_container_file_base64` for a `/workspace` path of the environment's own
container (any other container id is `policy_denied`), or
`get_native_agent_tool_details` for a conversation's deferred tool detail
(its inline `data:` bytes). Files over 20 MiB (or over the reader's own
10 MiB binary limit), or without a `%PDF-` signature, are refused with
metadata before a worker starts. A `pdf-thumbnail` job then runs the pinned
`pdfjs-dist@6.4.299` (`pdf.min.mjs` and `pdf.worker.min.mjs` in
`RENDERER_BUNDLES`, Apache-2.0, sha256-verified at load and shipped in
`dist/artifact-runtime/` and the image) inside the worker's isolated page:
the modules load from in-memory sources, the worker module runs on the page's
thread, and `getDocument` gets `isEvalSupported: false` (a no-op in pdf.js 6,
which removed eval code paths), `enableXfa: false`, `disableFontFace: true`,
`useWasm: false`, no range/stream/auto fetch, no system fonts and a 40 MP
`maxImageSize`. Only a canvas is drawn (no annotation or form layer, no
scripting sandbox bundle), so PDF JavaScript and actions never run, and every
request stays blocked. Over 100 pages answers `refused`/`page-limit` with the
page count; encrypted and unreadable documents are refused too. The PNG is at
most 1,024 px on its longest side and 4 MiB. Results are cached by content
hash (32 entries, 16 MiB); at most two previews hold bytes at once (else
`unavailable`/`capacity`). The file dialog's PDF route shows the page with
"Page 1 of N" and keeps **Download original**; inline-only attachment bytes
have no backend source and show metadata only.

## Content serving

`content-server.ts` is a separate listener with no application routes. It
serves exactly one prepared document per capability URL `/a/<token>` (bound
to artifact, revision, prepared hash; short-lived; revocable), re-hashes the
bytes on every request, never redirects, and sends `Content-Type: text/html;
charset=utf-8`, `X-Content-Type-Options: nosniff`, `Cache-Control: private,
no-store`, `Referrer-Policy: no-referrer`, `X-DNS-Prefetch-Control: off` and
the CSP header (the `sandbox` directive needs the header). Locally it uses a
different loopback host name from the application; a different port alone is
not a credential boundary. The backend learns its real application origins
once the gateway has bound (`main.ts` → `setTranscriptArtifactApplicationOrigins`:
the gateway browser listener, the Tailscale Serve URL, configured allowed web
origins, and the Vite dev origin in development) and re-chooses the loopback
content host so it never shares a host name with any of them; when both
loopback names are application hosts, live viewing is disabled with a reason.
Hosted deployments set `ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN` to a different
site (remote browsers: see
[remote-gateway.md](remote-gateway.md#live-artifacts-in-remote-browsers)); one on the application's site (same approximate registrable domain, or
one host a subdomain of the other) disables live viewing with a clear reason
(`contentServer.status()`, `origin() === null`). Capabilities are minted only
by `transcript_artifact_open_live_session` after the ownership check and are
redacted from logs.

`/s/<token>` serves the browser **viewer shell** for the same capability
(`content-shell.ts`; `mint` returns it as `shellUrl`, the live-session
response as `shellUrl`). It shares the document's expiry, revocation and
serve-time authorization, never loads the document's bytes, never redirects,
and sends the same base headers with its own CSP: `default-src 'none'`, its
one script and one style by hash, `frame-src`/`child-src` naming exactly the
document URL `<content origin>/a/<token>` (a path-exact source expression),
`connect-src`/`img-src`/`font-src`/`media-src`/`worker-src`/`object-src`
`'none'`, `base-uri`/`form-action 'none'`, `sandbox allow-scripts
allow-same-origin`, and the same `frame-ancestors` as the document
(snapshotted at mint). Because the shell has the content origin, every
document's `frame-ancestors` also names the content origin; the only
non-opaque documents the listener serves are shells (documents and media are
CSP-sandboxed), and every ancestor above the shell must still be a permitted
application origin.

Serve-time authorization: `mint` accepts an optional `authorize()` that the
server calls on every request before loading bytes (bounded to 5 s). A
`false`, a rejection or a timeout answers 404 and revokes the capability, so
a publication, owner or environment deleted or revoked after minting stops
being served even before the capability expires.

Default `frame-ancestors` are the desktop shell plus those exact application
origins (no loopback port wildcards); before the gateway binds only the
desktop shell may frame documents. `ORKESTRATOR_ARTIFACT_FRAME_ANCESTORS`
replaces the application origins with an explicit list. The prepared
document's stored policy carries only the stable configured ancestors; the
content server re-applies the current list to every response.

### Media streams

The same listener serves range-capable media at `/m/<capability>`
(`media-stream-route.ts`), so transcript audio and video play without their
bytes crossing `invoke` as base64. The listener's properties carry over: no
application routes, no cookies, no redirects, the `Host` check, and
capabilities that are random 256-bit table keys, revocable, never logged.

- **Minting.** Only `transcript_media_open_stream` `{ environmentId, path,
  containerId? }` mints (`media-stream.ts`), and only for a file resolved
  through the existing confined readers. Local environments use
  `openReadableHostFile` (`path-safety.ts`, the confinement behind
  `read_file_base64` / `read_environment_file_base64`) rooted at that
  environment's worktree (lexical and canonical form): no symbolic link on
  any segment, canonical target inside the root, a nonblocking no-follow
  open and a handle-backed regular-file check. Container environments run
  the container safe reader (the reader behind `read_container_file_base64`)
  in its `stream` mode: the same `/workspace` confinement, symbolic-link
  refusal, size limit and final stability check, with raw bytes on stdout,
  copied once into `<dataDir>/transcript-media-staging/` (mode 0700; the copy
  is discarded unless the reader exits cleanly). A `containerId` must name
  the environment's own container. The response is `{ url, mimeType,
  byteLength, expiresAt, streamId }`; `transcript_media_close_stream
  { streamId }` revokes it and removes any staged copy.
- **Type.** Sniffed from the leading bytes (`media-stream-sniff.ts`), never
  the file name: MP4/M4A/QuickTime, WebM/Matroska, Ogg, WAV, FLAC, MP3, AAC
  and PNG/JPEG/GIF/WebP/AVIF/BMP. SVG, HTML, PDF and anything unrecognised
  are refused (`unsupported_kind`); an HTML file named `.mp4` never reaches
  the listener.
- **Per request.** `authorize()` (the stream is still open; the environment
  exists, is not being deleted and still has the same worktree or container;
  bounded to 5 s) and `resolve()` (re-opens the file through the same
  confinement) run on every request. The opened file must have the minted
  size and identity (device, inode, size, mtime, ctime) and re-sniff as the
  minted type; any failure or mismatch revokes the capability and answers
  404, so a moved, deleted, replaced or symlinked file stops being served.
- **Ranges.** `GET`/`HEAD`, `Accept-Ranges: bytes`, one range per request:
  `206` with `Content-Range` for `bytes=N-M`, `bytes=N-` and `bytes=-N`;
  `416` with `Content-Range: bytes */<size>` for malformed, multiple,
  other-unit or unsatisfiable ranges. A ranged body is capped at 8 MiB
  (`MEDIA_RANGE_RESPONSE_MAX_BYTES`): an open-ended request gets the first
  8 MiB and media elements continue from there. A request without `Range`
  streams the whole file. Reads go straight from the file handle in 64 KiB
  chunks with backpressure; a client that stops draining for 30 s is
  disconnected.
- **Headers.** The sniffed `Content-Type`, `X-Content-Type-Options:
  nosniff`, `Cache-Control: private, no-store`, `Content-Security-Policy:
  default-src 'none'; frame-ancestors 'none'; sandbox`, `Referrer-Policy:
  no-referrer` and `Cross-Origin-Resource-Policy: cross-origin`. The
  application page and the content origin are different sites by design
  (127.0.0.1 and localhost, or a hosted content site), and real Chrome
  refuses the `<video>` load under `same-site`
  (`media-stream.browser.test.ts` plays and seeks through several ranges
  from an application-origin page; switching the header to `same-site` makes
  metadata never load).
- **Bounds.** 256 live media capabilities; 16 concurrent responses, 4 per
  capability (`503` with `Retry-After: 1` beyond); idle lifetime 15 minutes,
  extended by every served request up to 2 hours; host files up to 2 GiB,
  container files up to 512 MiB; staging at most 1 GiB per environment and
  2 GiB in total (the environment's oldest staged streams are evicted to fit
  a new maximum-size copy), at most two copies at a time, each within
  10 minutes; 128 open streams. Staged copies are removed on close, expiry
  or revocation and when their environment disappears (a sweep every
  minute while streams are open), and the staging directory is emptied when
  the backend first uses it.
- **Errors.** `invalid_input`, `not_found`, `policy_denied` (outside the
  workspace, a symbolic link, not a regular file, a foreign container),
  `unsupported_kind`, `package_size_exceeded`, `capacity_exceeded` (staging
  quota or concurrency) and `renderer_unavailable` (no content origin), as
  `ArtifactError` JSON. File paths are never echoed.

Changing the content origin or closing the listener revokes every media
capability with the document capabilities.

## Displaying live artifacts

`transcript_artifact_open_live_session` refuses (`policy_denied`, or
`preview_stale` for a runtime change) when the stored prepared package's
`policyVersion` or `runtimeVersion` differs from the current
`ARTIFACT_VERSIONS`: old bytes never run under a newer policy; the saved
preview stays readable.

The transcript shows the saved capture; **Run interactive** opens one live
session per window (`artifactLiveHostStore`, mounted once outside the
virtualized list) that keeps the same document across inline, panel and
fullscreen placement.

- **Browser**: the page frames the viewer shell (`session.shellUrl`), never
  the document: `<iframe sandbox="allow-scripts allow-same-origin"
  referrerpolicy="no-referrer">`. The shell URL must be http(s), on the
  document's origin and not on the page's origin, or nothing is framed and
  the view fails closed. The shell keeps the content origin (a different site,
  so never same-origin with the page): the host checks `event.origin` against
  it and addresses its theme to it, and the document's `frame-ancestors` can
  name it (an opaque shell would match no ancestor source). The shell's fixed
  hashed script creates the artifact frame (`sandbox="allow-scripts"`, no
  referrer, `allow=""`) only when the shell is itself framed, and relays
  exactly `ready`, `size` and `link-request` from that captured frame window
  (origin `null`, no ports) and `theme` from its exact parent (an origin in
  its ancestor list), re-checking envelope, exact keys, identity (artifact,
  revision, generation from the capability), bounds, link rules and rate,
  and rebuilding each message from its validated fields; a unit test runs the
  relay against `parseArtifactFrameMessage` on a corpus and requires the same
  decisions. Any load of the artifact frame after the first, or a frame
  navigation the shell's `frame-src` refused (`securitypolicyviolation`),
  removes the frame and sends one `shell-disposed` message (the only
  shell-originated type, `parseArtifactShellMessage`); the host then
  invalidates the channel and shows the saved preview, as it does on a
  second load of the shell itself. The host re-validates every relayed
  message with `parseArtifactFrameMessage` and the readiness nonce, rate
  limited (20/s, burst 40, size 4/s, 8 KiB each); the host sends only
  `theme`. Link requests become a host-owned "Open <host>" button.
- **Desktop** (`apps/desktop/electron/artifact-host-*.ts`): a sandboxed
  `WebContentsView` with no preload, `contextIsolation`, no Node integration
  in workers or subframes, a fresh nonpersistent session that denies
  permissions, downloads and new windows, and a single-owner
  `webRequest.onBeforeRequest` filter that allows the trusted shell
  (`orkestrator-artifact-shell://viewer/shell.html`, hashed CSP with
  `frame-src` limited to the content origin) and the exact content URL once.
  Any other request, redirect, WebSocket, unexpected navigation or nested
  frame closes the host. WebRTC is contained with
  `disable_non_proxied_udp` plus a session proxy that black-holes every host
  except the content host. The main process drains frame messages from the
  shell with `executeJavaScript` (no preload, no IPC bridge), re-validates
  them, and forwards presentation events to the owning window only. Hangs in
  the shell or the artifact frame are reported `unresponsive`; Stop destroys
  the view and its renderer processes without affecting the application.
  Qualified as recorded below.

Browser mode isolates origins but cannot guarantee CPU isolation; the saved
preview and Stop remain available. DNS prefetch egress from the desktop host
is not separately qualified.

### Desktop host qualification (2026-10-20)

Electron 44.7.0 (Chromium 152.0.7977.130, Node 24.21.0; the repository's
pinned `electron` that releases package), macOS 27.0, main process bundled
by `apps/desktop/scripts/electron-bundle.ts` as for production. Not a signed
packaged `.app`.

- `mise run test:logged -- --name rich-agent-electron -- mise run
  test:agent:electron` (no running profile needed; each spec creates a
  disposable one): 21 passed, 1 skipped (the Linux-only Wayland case), 0
  failed, 109 s. After adding the spec below, the same command passed with
  22 passed, 1 skipped, 0 failed, 115 s.
- Live-host probe, built and run as its header documents, twice: both runs
  `ALL PASSED`, exit 0, 24 of 24 checks each time. The checks were: open
  resolves ok (once per scenario), effective sandbox preferences, shell has a
  tuple origin and no bridge, ready/theme/link request/size relay, artifact
  opaque and isolated from the shell, storage and bridges, content request
  without referrer or cookies, repositioning keeps the same web contents,
  `escape`/`data:`/`reload` frame navigation closes the host,
  fetch/WebSocket/beacon/image/popup/worker reach no sink, STUN/TURN reach no
  UDP or TCP sink, content refusing the shell as ancestor never goes live,
  a hang after ready is reported unresponsive, closing a hung host
  terminates its renderer processes, and the application window survives.
  Expected noise: Chromium logs `site_info.cc … Check failed:
  origin.GetTupleOrPrecursorTupleIfOpaque().IsValid()` (non-fatal) for the
  `data:` navigation and `ERR_BLOCKED_BY_RESPONSE` for the refused ancestor.
- `e2e/agent-testing/artifact-host-electron.spec.ts` (in
  `test:agent:electron`) drives the real app: production main bundle,
  preload, sender-checked IPC and the per-window manager, called from the
  real renderer through `window.orkestrator.artifactHost` exactly as
  `ArtifactLiveHost` does. The document comes from the backend's real
  `LoopbackArtifactContentServer` (capability URL on `localhost` while the
  application is on `127.0.0.1`), with a policy from `buildInteractiveCsp`
  around the real frame runtime. It checks that a content URL on the
  application origin is refused; that the host view appears in the window's
  `contentView` with sandbox, context isolation, no preload, a nonpersistent
  session, zoom-scaled bounds, and shell and frame processes separate from
  the application renderer; readiness, theme and size events; a real click
  routed into the cross-origin frame (link request and a larger size);
  repositioning and hiding that keep the same web contents; and, on Stop, a
  `closed: requested` event, the view removed and destroyed, and every host
  renderer process gone, while the window, its renderer and backend IPC keep
  working. It does not seed a published artifact into a transcript or press
  the Run interactive button: creating an artifact needs an agent-tool
  credential that only a live provider dispatch mints, and that path is
  covered in the browser by `rich-transcripts-live.spec.ts`. Its click goes
  through Playwright's CDP attachment to the host page;
  `webContents.sendInputEvent` never reached the artifact frame on a shared
  macOS desktop.

### Browser engine qualification (2026-10-20)

`content-server.engines.test.ts` serves prepared documents from the real
`LoopbackArtifactContentServer` (content on `localhost`, the test
"application" on `127.0.0.1`) and drives each engine through playwright-core
1.64.0: Chromium is the design renderer's resolved browser (Google Chrome
155.0.8059.85 here), Firefox 157.0 (Playwright build 1555) and WebKit 27.2
(Playwright build 2370), installed with `bunx playwright install firefox
webkit`. An engine whose browser is missing is skipped with a printed
reason. Every adversarial probe first ran as a deliberately unrestricted
control (the same bytes served without the policy, same-origin with the
parent, unsandboxed or with the withheld sandbox privileges), and request
sinks are observed from outside the page; navigation handlers report that
they ran, so a zero at the sink cannot come from a missed click. Final two
runs: 27 passed (9 per engine), 0 skipped, 0 failed each (with the existing
Chromium `content-server.browser.test.ts`: 28 passed). Identical results in
all three engines:

- Loads only inside the permitted ancestor (ready arrives from origin
  `null`); a non-permitted ancestor receives no message at all
  (`frame-ancestors`).
- An inline script and `onload`/`onerror` handlers appended after
  preparation (hashes not in the policy) never run; `eval` and `new
  Function` throw `EvalError`. The control ran all of them.
- fetch, XHR, `sendBeacon`, EventSource, WebSocket, `Image`, `FontFace`, CSS
  `@font-face` and background images: 0 sink requests and 0 upgrades. The
  control reached all nine sink paths in every engine.
- Form submission (`form.submit()`), `window.open`, a `target=_blank` link
  click and `top.location` assignment, each on a real click (user
  activation): 0 sink requests, no new page, the parent stays on its URL.
  The control (with `allow-popups allow-top-navigation allow-forms
  allow-same-origin`) reached the sink for each.
- Reads of the parent's DOM, globals, cookie and `localStorage`, and of the
  frame's own `document.cookie`, `localStorage` and `sessionStorage`, all
  throw `SecurityError`; `opener` is `null`; no canary appears in any frame
  message or sink request. The same-origin control read every canary.
- Without any `sandbox` attribute on the iframe the header's CSP `sandbox`
  still applies: origin `null` and the same `SecurityError`s (the control
  reported the parent's real origin).
- With the real frame runtime and `parseArtifactFrameMessage` running in the
  page, only `ready`, `size` and `link-request` from the frame are accepted,
  each `size`/`link-request` carrying the host's generation; `tool-call`,
  `prompt` and a frame-sent `theme` are `unknown-type`, and forged
  generation, extra keys, `javascript:` and credentialed links, oversized
  height, wrong channel or version, oversized payload and a plain string are
  rejected (12 rejections). The runtime applied the host's `theme` (data
  attribute and `--accent` token) inside the frame.

Engine difference, security-relevant (found, then closed by the browser
viewer shell): none of the engines lets the document's own policy stop the
frame from **navigating itself** (CSP has no navigation directive and
`allow-scripts` lets a frame navigate itself). Framed directly by the page,
a dynamically inserted `<meta http-equiv="refresh">` and a `location.href`
assignment each reached the sink in all three engines: a GET from the
opaque-origin frame carrying only what the artifact itself knows (no
application cookie; nothing can be read back). The embedding document's
`frame-src` governs every navigation of its child frame (a page CSP of
`frame-src <content origin>` stopped both in all three engines), but the
application's pages cannot carry one because Browser tabs frame arbitrary
URLs, so browser mode now frames the viewer shell instead (see Content
serving), whose `frame-src` names only the one document URL. The desktop
host already closed this (`webRequest` filter, shell `frame-src`). Other
differences were cosmetic (WebKit made one sink request per control
navigation where Chromium and Firefox made two).

Viewer shell qualification (same engines and versions, 2026-10-20; four more
tests per engine in `content-server.engines.test.ts`; the full file then ran
39 passed, 0 skipped, 0 failed). Each attack runs three ways: the
unrestricted control (same bytes, no policy, same origin as the page,
`allow-popups allow-top-navigation allow-forms`), the document framed
directly by the page (browser mode before the shell), and through the shell.
Requests counted at the sink (and, for `decoy`, at a second capability on
the same content origin):

| Attack | Control | Without shell | Through shell |
| --- | --- | --- | --- |
| inserted meta refresh | 1 | 1 | 0 |
| `location.href` | 1 | 1 | 0 |
| `location.replace` | 1 | 1 | 0 |
| `data:` document with a meta refresh | 1 | 1 | 0 |
| `blob:` document with a meta refresh | 1 | 1 | 0 |
| sink URL that redirects (302) | 2 | 2 | 0 |
| another capability URL on the content origin | 1 | 1 | 0 |
| `window.open` (real click) | 1 (Chromium 2) | 0 | 0 |
| form submission | 1 | 0 | 0 |

Identical in Chromium, Firefox and WebKit, so every engine honours the
path-exact `frame-src` (the decoy capability on the shell's own origin was
never requested). Every attempted frame navigation also disposed the frame
with exactly one `shell-disposed`: Chromium and Firefox report the refused
navigation as a `frame-src` violation (`blocked-navigation`); WebKit fires a
second `load` for the refused frame (`unexpected-load`). The popup and the
form never navigate the frame (the document's sandbox and `form-action`
refuse them), so they dispose nothing. A `location.reload()` (the one
navigation the shell's `frame-src` permits) disposes with `unexpected-load`
in all three engines and the artifact frame is removed. Through the relay
the host saw only `ready`, `size` and `link-request`, from the content
origin, each with the capability's generation; the frame's twelve hostile
messages (unknown types, forged generation, extra keys, `javascript:` and
credentialed links, oversized values, wrong channel or version, a plain
string) were dropped by the shell, and the runtime applied the host's theme
inside the artifact frame. Neither the artifact frame nor the shell could
read its parent (`SecurityError`). A non-permitted ancestor receives no
message from the shell, and the shell opened at the top level frames
nothing.

## Renderer commands for drafts and uploads

- `transcript_artifact_list_drafts` lists a conversation's artifacts,
  published or not, newest first (at most 100), each with its latest
  operation on the current revision (status, bounded error and diagnostics,
  diagnostic capture count).
- `transcript_artifact_read_draft` returns, in the
  `ArtifactRepresentationResponse` shape, either the exact source of a
  revision (hash re-checked, sliced on UTF-8 boundaries like `get_artifact`)
  or a failed operation's diagnostic capture by index (PNG, base64, bytes
  re-hashed). Same `not_found` rules as publication reads.
- `transcript_artifact_stage_asset` `{ environmentId, logicalSessionKey,
  name, mimeType, dataBase64 }` stages one bounded upload (10 MiB decoded;
  MIME type must match the bytes' magic numbers; text types must be UTF-8)
  into the environment's content-addressed asset store and returns an
  owner-scoped `assetRef` (`stg-<32 hex>`, expires after seven days). Agents
  reference staged or attached assets only by that `assetRef` in
  `draft.assets[]`; the backend's asset resolver (wired in `core/index.ts`)
  resolves staged references of the same owner and nothing else. No path or
  URL is ever read.

Tool argument objects are strict at the top level (unknown keys are
refused). Results are compact; a result over 16 KiB keeps its identity and
status fields, drops the largest optional fields and reports them in
`omittedFields` with `truncated: true` rather than turning a committed
success into an error. Title, summary and request key are bounded in UTF-8
bytes as well as characters. `get_artifact_operation` reports
`visualInspection: "not-assessed"` always and `imageDelivery:
"attached-if-supported"` when it adds an image block: delivery is not a claim
that the model saw it.

## Configuration

| Setting | Effect |
| --- | --- |
| `ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION` | `auto` (default: `container` when Docker and the image are present, else `process`), `container`, `process`, `disabled` |
| `ORKESTRATOR_ARTIFACT_PREVIEW_ALLOW_PROCESS_INTERACTIVE` | `1` lets `html-interactive` run in process isolation (no OS network boundary); off by default |
| `ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE`, `…_DOCKER`, `…_SECCOMP` | Container worker image (tag, `sha256:<id>` or `name@sha256:<digest>`), Docker binary, seccomp profile |
| `ORKESTRATOR_DESIGN_CHROMIUM_PATH` | Chromium executable (shared with the design renderer) |
| `ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN`, `…_CONTENT_PORT` | Public content origin for hosted deployments; listener port |
| `ORKESTRATOR_ARTIFACT_CONTENT_BIND` | Interface of the content listener, honoured only with `…_CONTENT_ORIGIN` and only for a loopback or Tailscale address (default `127.0.0.1`); wildcard or public addresses are refused with a warning |
| `ORKESTRATOR_ARTIFACT_FRAME_ANCESTORS` | Trusted viewer origins replacing the application origins (the desktop shell is always added) |
| `ORKESTRATOR_RICH_MARKDOWN`, `ORKESTRATOR_ARTIFACT_PUBLICATION`, `ORKESTRATOR_ARTIFACT_LIVE_INTERACTIVE` | Rollout switches (default on). Turning one off stops new rendering, publication or live execution; stored records, source and saved previews stay readable. |

## Operations

Logs carry identifiers, kinds, sizes, durations and reason codes only. Never
source, prompts, arguments, capability URLs, console text or captures.
`service.metrics.snapshot()` counts blocked loads, deadlines, worker deaths,
repairs, cache evictions and receipt mismatches.
