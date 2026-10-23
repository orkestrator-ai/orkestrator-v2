# Preview transport fixture

Deterministic HTTP/WebSocket server for browser-preview tests. Import
`startPreviewFixture()` from tests, or run `bun server.ts` (honours `PORT`,
`HOST`, `FIXTURE_MARKER`) inside a container. Every response carries
`x-service-marker`, so tests can tell the right application from a decoy.
Content and credentials are synthetic.

`/sw.js` is a benign service worker: it answers `/sw/marker` with the
service's marker and passes every other request to the network. Tests use it
for worker isolation and for worker-originated requests crossing the
transport.

`/sw-hostile/install` registers `/sw-hostile.js` at scope `/`. That worker
takes over every `/__orkestrator_preview/` request, so the session-code
redirect after a bootstrap never reaches the backend, and then tries the
captured code and credentialed requests against the `probe=` and `session=`
targets in the install page's query. It answers with a `#hostile-report`
page listing what it saw and what each attempt returned
(`e2e/preview/private-origin.spec.ts`).
