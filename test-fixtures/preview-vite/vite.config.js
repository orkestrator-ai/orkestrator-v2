// Pinned fixture for preview transport tests. It is intentionally not a
// workspace package: its Vite version is the *application's* version, which is
// independent of the Vite that builds Orkestrator's own renderer.
//
// Through a preview origin the page is served from a different host than the
// dev server believes it runs on. `allowedHosts` names the preview suffix
// explicitly instead of `true`, and HMR uses the page's own origin, which the
// preview transport forwards to this server's WebSocket endpoint.
export default {
  server: {
    allowedHosts: [".preview.test", "localhost"],
  },
};
