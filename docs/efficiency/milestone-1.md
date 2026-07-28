# Milestone 1 — Static delivery and initial bundle

Status: Not started

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

- [ ] Add encoding-specific ETags.
- [ ] Add `Last-Modified`.
- [ ] Return `304` for matching `If-None-Match`.
- [ ] Return `304` for a valid matching `If-Modified-Since`.
- [ ] Serve hashed `/assets/*` with
      `Cache-Control: public, max-age=31536000, immutable`.
- [ ] Serve `index.html` and the SPA fallback with
      `Cache-Control: no-cache`.
- [ ] Include `Vary: Accept-Encoding` on compressed and identity responses.
- [ ] Merge `Vary` values without clobbering `Origin`.
- [ ] Support `HEAD` with the same headers as `GET` and no body.
- [ ] Preserve the existing traversal guard.

### Precompressed assets

- [ ] Add a Bun script that creates `.br` and `.gz` siblings for compressible
      production assets.
- [ ] Use Brotli quality 11 and gzip level 9 at build time.
- [ ] Skip WOFF2, compressed images, unknown octet streams, and outputs larger
      than their source.
- [ ] Prefer Brotli, then gzip, according to `Accept-Encoding`.
- [ ] Reject a compressed sibling whose mtime predates its source.
- [ ] Derive sibling paths only from an already-validated source path.
- [ ] Add moderate on-the-fly compression as a fallback for builds without
      siblings.
- [ ] Confirm the normal packaging path includes sibling artifacts.

### Fonts and bundle splitting

- [ ] Convert terminal TTF files to WOFF2.
- [ ] Measure and, if visually safe, ship a terminal-specific glyph subset.
- [ ] Lazy-load Monaco and diff viewing.
- [ ] Lazy-load Markdown editing and browser preview.
- [ ] Lazy-load looped review and infrequently used settings surfaces.
- [ ] Lazy-load provider tabs absent from the restored layout.
- [ ] Bundle Monaco locally and eliminate the jsDelivr runtime dependency.
- [ ] Add manual chunks only where bundle analysis shows a stable benefit.
- [ ] Verify the desktop `file://` renderer path.

## Required tests

- [ ] Brotli, gzip, and identity sibling selection.
- [ ] Stale sibling rejection.
- [ ] Encoding-specific ETag and `304`.
- [ ] `Last-Modified` revalidation.
- [ ] Immutable hashed assets and revalidated SPA fallback.
- [ ] `HEAD` parity.
- [ ] `Vary` merging with CORS.
- [ ] Traversal rejection with compressed sibling lookup enabled.
- [ ] On-the-fly fallback when siblings are absent.
- [ ] Production build succeeds and contains expected split chunks.

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

- [ ] Main JavaScript transfer is below 900 KiB with gzip.
- [ ] Main JavaScript transfer is below 750 KiB with Brotli.
- [ ] Repeat loads do not transfer unchanged hashed asset bodies.
- [ ] `index.html` revalidates and release hash changes work.
- [ ] Layouts without a file editor do not download Monaco.
- [ ] Monaco is self-hosted.
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

No evidence recorded yet.
