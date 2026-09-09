// This must be a separate, earlier preload. Static imports in tests/setup.ts
// evaluate before that module's body, and Testing Library binds `screen` when
// it evaluates. Registering the document in the preceding preload keeps setup
// synchronous, which Bun requires for reliable mock.module registration.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export const NATIVE_WEB_PLATFORM_KEY = Symbol.for("orkestrator.tests.native-web-platform");

export const nativeWebPlatform = {
  fetch: globalThis.fetch,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  Response: globalThis.Response,
};

GlobalRegistrator.register();

// Happy DOM installs its own fetch, abort and Response classes. Bun 1.4 rejects
// a Happy DOM AbortSignal passed to Bun's native fetch, and `Bun.serve` rejects
// a Happy DOM Response returned from a handler, both because they belong to a
// different Web API implementation. Integration tests that drive a loopback
// server therefore need the matching native constructors captured before
// registration.
Object.defineProperty(globalThis, NATIVE_WEB_PLATFORM_KEY, {
  value: nativeWebPlatform,
  configurable: true,
});
