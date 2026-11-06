// The http-bridge domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays reviewable.
export type { HttpBridgeAgent } from "./catalog.js";
export { HttpBridgeProvider } from "./provider.js";
export {
  boundedJson,
  bridgeFetch,
  openCodeSdkFetch,
  type HttpBridgeProviderDependencies,
} from "./transport.js";
