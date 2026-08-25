/**
 * The runtime's own `fetch`, captured before the test preload replaces it.
 *
 * The repo's test setup registers happy-dom globally, which swaps `fetch` for a
 * browser implementation that enforces the same-origin policy. That is right
 * for renderer tests and wrong for a bridge test, which is talking to a real
 * loopback server on an arbitrary port. The ACP bridge's harness does the same
 * thing for the same reason.
 */
export const nativeFetch = Bun.fetch;
