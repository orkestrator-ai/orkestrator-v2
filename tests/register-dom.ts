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
};

GlobalRegistrator.register();

// Happy DOM installs its own fetch and abort classes. Bun 1.4 rejects a
// Happy DOM AbortSignal passed to Bun's native fetch because it belongs to a
// different Web API implementation, so integration tests need the matching
// native fetch/controller pair captured before registration.
Object.defineProperty(globalThis, NATIVE_WEB_PLATFORM_KEY, {
  value: nativeWebPlatform,
  configurable: true,
});
