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
