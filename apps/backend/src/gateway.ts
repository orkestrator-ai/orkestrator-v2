export * from "./gateway-support.js";
export { createSseGzipCompressor, startProxiedEventStreamGzip } from "./gateway-proxy.js";

import { GatewayProxy } from "./gateway-proxy.js";

export class OrkestratorGateway extends GatewayProxy {}
