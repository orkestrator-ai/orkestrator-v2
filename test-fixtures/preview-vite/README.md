# Preview Vite fixture

Pinned `vite` 7.3.6 application used to validate HMR through the preview
transports. Install into an isolated copy, never into the workspace:

```bash
cp -R test-fixtures/preview-vite /tmp/preview-vite && cd /tmp/preview-vite
bun install && bun run dev
```

Editing `src/label.js` must update `#app` and increment
`document.body.dataset.hmrUpdates` without a full reload. Through a preview
origin, `server.allowedHosts` must list the preview suffix explicitly; do not
set it to `true`.
