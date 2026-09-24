# Preview transport fixture

Deterministic HTTP/WebSocket server for browser-preview tests. Import
`startPreviewFixture()` from tests, or run `bun server.ts` (honours `PORT`,
`HOST`, `FIXTURE_MARKER`) inside a container. Every response carries
`x-service-marker`, so tests can tell the right application from a decoy.
Content and credentials are synthetic.
