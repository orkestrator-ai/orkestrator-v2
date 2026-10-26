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

`/` and `/app/*` serve the same page, so client-side routes and deep links
reload. Its `<img srcset>` candidates `/assets/small.png` (2 px) and
`/assets/large.png` (4 px) are real PNGs. `/assets/mapped.js` ends with
`//# sourceMappingURL=mapped.js.map`; the map is served as
`application/json` with its SHA-256 in `x-sha256`. `previewFixturePng()`,
`previewFixtureMappedScript()` and `previewFixtureSourceMap()` export the
exact bytes for assertions.
