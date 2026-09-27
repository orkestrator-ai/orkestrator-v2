# Preview Vite fixture

Pinned `vite` 7.3.6 application used to validate HMR through the preview
transports. Install into an isolated copy, never into the workspace:

```bash
cp -R test-fixtures/preview-vite /tmp/preview-vite && cd /tmp/preview-vite
bun install && bun run dev
```

Editing `src/label.js` must update `#app` and increment
`document.body.dataset.hmrUpdates` without a full reload.

No `allowedHosts` or `hmr` configuration is needed: preview routes present
`Host: localhost:<port>` upstream. The opt-in transport check runs against the
installed copy:

```bash
ORKESTRATOR_TEST_PREVIEW_VITE_DIR=/tmp/preview-vite \
  bun test apps/backend/src/preview-vite.test.ts
```
