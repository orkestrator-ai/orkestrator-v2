// The previews domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// `test-support.ts` is a named exception in `.oxlintrc.json`, not part of this
// surface: the test-only entrypoints `preview-browser-harness.ts` and
// `preview-baseline-harness.ts` import `createPreviewHarness` from it directly,
// and their file names fall outside the lint override that exempts tests.
// `defaultProbeFamily` is here for `preview-browser-harness.ts`, which hands the
// real loopback family probe to the test support in place of its stub.
export { type AuthenticatedPreviewAccess, type PreviewPublicationPort } from "./access.js";
export { resolvePreviewTargetIntent } from "./intent.js";
export { type LegacyLoopbackPortAccess, PreviewRuntime } from "./runtime.js";
export { type ResolvedPreviewTarget } from "./service-registry.js";
export { defaultProbeFamily } from "./target-resolver.js";
