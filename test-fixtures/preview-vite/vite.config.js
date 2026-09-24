// Pinned fixture for preview transport tests. It is intentionally not a
// workspace package: its Vite version is the *application's* version, which is
// independent of the Vite that builds Orkestrator's own renderer.
//
// No host or HMR configuration is needed: both preview routes present
// `Host: localhost:<port>` upstream and map the service's own `Origin` to that
// private origin, so Vite's host check and HMR client work unchanged.
// `apps/backend/src/preview-vite.test.ts` verifies this.
export default {};
