# Milestone 1 — Static delivery and initial bundle

Status: Implemented; manual verification pending

Depends on: Milestone 0

Unblocks: Milestone 2

## Outcome

Reduce remote and iOS startup transfer, parse, and initialization cost without
changing live-state protocols.

## Scope

Primary files:

- `apps/backend/src/gateway.ts`
- `apps/web/vite.config.ts`
- `apps/web/package.json`
- `apps/web/src/components/pane-layout/PaneLeafContainer.tsx`
- `apps/web/src/components/terminal/FileViewerTab.tsx`
- `apps/web/src/components/terminal/MonacoFileEditor.tsx`
- terminal font assets and declarations
- `apps/web/scripts/precompress.ts` (new)
- gateway static-serving tests

## Implementation checklist

### Cache validators and policies

- [x] Add encoding-specific ETags.
- [x] Add `Last-Modified`.
- [x] Return `304` for matching `If-None-Match`.
- [x] Return `304` for a valid matching `If-Modified-Since`.
- [x] Serve hashed `/assets/*` with
      `Cache-Control: public, max-age=31536000, immutable`.
- [x] Serve `index.html` and the SPA fallback with
      `Cache-Control: no-cache`.
- [x] Include `Vary: Accept-Encoding` on compressed and identity responses.
- [x] Merge `Vary` values without clobbering `Origin`.
- [x] Support `HEAD` with the same headers as `GET` and no body.
- [x] Preserve the existing traversal guard.

### Precompressed assets

- [x] Add a Bun script that creates `.br` and `.gz` siblings for compressible
      production assets.
- [x] Use Brotli quality 11 and gzip level 9 at build time.
- [x] Skip WOFF2, compressed images, unknown octet streams, and outputs larger
      than their source.
- [x] Prefer Brotli, then gzip, according to `Accept-Encoding`.
- [x] Reject a compressed sibling whose mtime predates its source.
- [x] Derive sibling paths only from an already-validated source path.
- [x] Add moderate on-the-fly compression as a fallback for builds without
      siblings.
- [x] Confirm the normal packaging path includes sibling artifacts.

### Fonts and bundle splitting

- [x] Convert terminal TTF files to WOFF2.
- [ ] Measure and, if visually safe, ship a terminal-specific glyph subset.
- [x] Lazy-load Monaco and diff viewing.
- [x] Lazy-load Markdown editing and browser preview.
- [x] Lazy-load looped review and infrequently used settings surfaces.
- [x] Lazy-load provider tabs absent from the restored layout.
- [x] Bundle Monaco locally and eliminate the jsDelivr runtime dependency.
- [x] Add manual chunks only where bundle analysis shows a stable benefit.
- [ ] Verify the desktop `file://` renderer path.

## Required tests

- [x] Brotli, gzip, and identity sibling selection.
- [x] Stale sibling rejection.
- [x] Encoding-specific ETag and `304`.
- [x] `Last-Modified` revalidation.
- [x] Immutable hashed assets and revalidated SPA fallback.
- [x] `HEAD` parity.
- [x] `Vary` merging with CORS.
- [x] Traversal rejection with compressed sibling lookup enabled.
- [x] On-the-fly fallback when siblings are absent.
- [x] Production build succeeds and contains expected split chunks.

## Manual verification

- [ ] Cold-load and repeat-load the remote UI over Tailscale.
- [ ] Confirm unchanged hashed assets transfer no body on repeat load.
- [ ] Confirm a new build with changed hashes loads without stale assets.
- [ ] Restore a layout without a file tab and confirm Monaco is not downloaded.
- [ ] Open the file editor and confirm Monaco loads from the application origin.
- [ ] Verify terminal normal, bold, symbols, ligatures, and powerline glyphs.
- [ ] Verify Electron `file://`, desktop browser, iPhone, and iPad.
- [ ] Exercise the inactive-environment path before completing the milestone.

## Commands

```bash
bun run --cwd apps/web build
bun run --cwd apps/web typecheck
bun run --cwd apps/backend typecheck
bun test tests/unit/electron/gateway.test.ts --parallel
bun run test
```

## Exit criteria

- [x] Main JavaScript transfer is below 900 KiB with gzip.
- [x] Main JavaScript transfer is below 750 KiB with Brotli.
- [x] Repeat loads do not transfer unchanged hashed asset bodies.
- [ ] `index.html` revalidates and release hash changes work.
- [x] Layouts without a file editor do not download Monaco.
- [x] Monaco is self-hosted.
- [ ] Font rendering is visually acceptable on all target clients.
- [ ] Static delivery tests, typechecks, and the full suite pass.

## Evidence and decisions

Record:

- before/after asset table with raw, gzip, and Brotli sizes;
- cold/warm transfer and boot timing changes;
- resulting chunk graph;
- font subset decision and visual test devices;
- cache headers captured from raw tailnet HTTP and Tailscale Serve;
- test command results.

### 2026-07-31 — reconciliation against PR #225 and current main

- PR #225 added `apps/web/scripts/precompress.ts` and runs it after every Vite
  production build. It emits only smaller Brotli-quality-11 and gzip-level-9
  siblings for eligible text assets; binary/unknown files, WOFF2, and existing
  compressed variants are excluded.
- Static serving now negotiates Brotli, gzip, and identity variants, rejects
  stale siblings, falls back to bounded on-the-fly compression, emits
  variant-specific ETags and `Last-Modified`, handles both conditional request
  forms, preserves CORS `Vary`, supports `HEAD`, applies immutable/no-cache
  policies, and derives sibling paths only after source-path validation.
- The production entry chunk built from current main is 2,062,537 bytes raw,
  588,159 bytes gzip (574.4 KiB), and 477,568 bytes Brotli (466.4 KiB), below
  both transfer limits.
- The build emits separate chunks for Monaco and its workers, file and diff
  viewing, Markdown editing, browser preview, looped review, settings, and
  provider tabs. Monaco workers load from application assets; there is no
  jsDelivr runtime dependency. Dynamic imports produced the useful split points,
  so no manual chunk rules were added.
- The terminal stylesheet references bundled regular and bold WOFF2 files. A
  terminal-specific glyph subset has not been measured or shipped.
- Verification on current main passed:
  - `bun run --cwd apps/web build` (251 compressed variants);
  - `bun test tests/unit/electron/gateway.test.ts --parallel` (156 tests);
  - the precompression, Monaco loader, lazy boundary, and pane-container suites
    (34 tests).
- Still pending: raw tailnet/Tailscale repeat-load captures, release-to-release
  hash verification, Electron `file://` and real iPhone/iPad checks, terminal
  glyph visual review, inactive-environment exercise, and final full-suite
  signoff.
