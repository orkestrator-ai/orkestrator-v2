# Preview Next.js fixture

Minimal Next.js 16.4.3 app-router application (React 19.3.1) used to check a
streaming, router framework through the preview transports. Install into an
isolated copy outside any repository, never into the workspace:

```bash
cp -R test-fixtures/preview-next /tmp/preview-next && cd /tmp/preview-next
bun install
```

The direct dependencies are exact versions. Next.js pins its own runtime
dependencies exactly apart from `caniuse-lite` and `baseline-browser-mapping`
(browser data only); no lockfile is checked in, as with the Vite fixture.
Keep the copy outside this checkout: Turbopack picks its workspace root from
the nearest lockfile above the project.

What the pages exercise:

- `/`: a server component with a Suspense boundary that resolves after
  1.5 s, so the document streams; a client counter (hydration); a client
  `Link` to `/items/42`; a Server Action form (`useActionState`); and
  `app/hmr-label.js`, which the spec edits to check Fast Refresh.
- `/items/[id]`: a dynamic route, reached by client navigation and deep link.
- `/api/request`: a route handler returning the `Host`, `X-Forwarded-Host`
  and `X-Forwarded-Proto` it received and its `request.url`.
- `/go`: `NextResponse.redirect(new URL("/items/7", request.url))`. Next.js
  builds `request.url` from `X-Forwarded-Proto` and its own listening port, so
  through a preview this is `https://localhost:<port>/items/7`.

`next.config.mjs` turns off the dev indicator and Next.js 16.4's generated
`AGENTS.md`. The preview harness starts `next dev` under Node with
`NEXT_TELEMETRY_DISABLED=1`. The opt-in browser spec runs against the installed
copy:

```bash
ORKESTRATOR_TEST_PREVIEW_NEXT_DIR=/tmp/preview-next \
  mise run test:logged -- --name preview-next -- \
  bunx playwright test --config e2e/preview/playwright.preview.config.ts next-app-router
```

The Fast Refresh case rewrites `app/hmr-label.js` in the copy and restores it.
