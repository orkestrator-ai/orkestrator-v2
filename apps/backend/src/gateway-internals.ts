import * as support from "./gateway-support.js";
export * from "./gateway-support.js";

export const {
  GATEWAY_COMPRESSION_MODES,
  AUTH_COOKIE,
  API_PREFIX,
  AGENT_TEST_BOOTSTRAP_TTL_MS,
  AGENT_TEST_SESSION_TTL_MS,
  MAX_AGENT_TEST_BOOTSTRAPS,
  MAX_AGENT_TEST_SESSIONS,
  DEFAULT_GATEWAY_PORT,
  GATEWAY_PORT_FALLBACK_ATTEMPTS,
  MAX_JSON_BODY_BYTES,
  MAX_BROWSER_PREVIEW_BODY_BYTES,
  MAX_INVOKE_BODY_BYTES,
  KEEPALIVE_MS,
  IMMUTABLE_ASSET_CACHE_CONTROL,
  REVALIDATED_DOCUMENT_CACHE_CONTROL,
  STATIC_FALLBACK_BROTLI_QUALITY,
  STATIC_FALLBACK_GZIP_LEVEL,
  DYNAMIC_BROTLI_QUALITY,
  DYNAMIC_GZIP_LEVEL,
  COMPRESSION_MIN_BYTES,
  MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES,
  MAX_DYNAMIC_COMPRESSION_OUTPUT_OVERHEAD_BYTES,
  MAX_CONCURRENT_DYNAMIC_COMPRESSIONS,
  MAX_DYNAMIC_PROXY_BUFFERED_SOURCE_BYTES,
  MAX_BUFFERED_BODY_CHUNKS,
  MAX_BROWSER_PREVIEW_DECODED_TOTAL_BYTES,
  BUFFERED_PROXY_BODY_IDLE_TIMEOUT_MS,
  SSE_COMPRESSION_CHUNK_BYTES,
  MAX_STATIC_FALLBACK_SOURCE_BYTES,
  MAX_STATIC_FALLBACK_OUTPUT_BYTES,
  MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS,
  DROPPABLE_EVENT_PREFIX,
  SSE_CLIENT_SOFT_BUFFER_BYTES,
  SSE_CLIENT_HARD_BUFFER_BYTES,
  DEFAULT_GATEWAY_REPLAY_HANDSHAKE_FRAME_CAPACITY,
  DEFAULT_GATEWAY_REPLAY_HANDSHAKE_MAX_BYTES,
  GATEWAY_CONNECTED_EVENT,
  GATEWAY_RECONCILE_REQUIRED_EVENT,
  GATEWAY_CURSOR_EVENT,
  CORS_ALLOWED_METHODS,
  CORS_ALLOWED_HEADERS,
  GATEWAY_METRIC_MAP_LIMIT,
  GATEWAY_METRIC_LABEL_BYTES,
  GATEWAY_METRIC_TOTAL_LABEL_BYTES,
  GATEWAY_COMMAND_METRIC_MAP_LIMIT,
  GATEWAY_COMMAND_METRIC_TOTAL_LABEL_BYTES,
  GATEWAY_METRIC_SAMPLE_LIMIT,
  MAX_CLIENT_METRICS_BODY_BYTES,
  METRIC_OVERFLOW_KEY,
  METRIC_INVALID_KEY,
  METRIC_UNKNOWN_COMMAND_KEY,
  METRIC_KEEPALIVE_KEY,
  METRIC_RESERVED_KEYS,
  InvalidRequestBodyError,
  RequestBodyTooLargeError,
  isGatewayCompressionMode,
  parseGatewayCompressionMode,
  resolveGatewayCompressionMode,
  compressionModeForListener,
  appendBoundedSample,
  BoundedMetricMap,
  normalizeMetricLabel,
  truncateUtf8,
  normalizeContentEncoding,
  normalizeHttpMethod,
  normalizeHttpVersion,
  normalizeAcceptEncoding,
  normalizeCacheControl,
  normalizeContentType,
  normalizeNextHopProtocol,
  normalizeStatusMetricKey,
  numberOrNull,
  stringOrNull,
  headerValueToString,
  parseContentLengthHeader,
  measureChunkBytes,
  classifyGatewayRoute,
  PER_ENTITY_EVENT_PREFIXES,
  normalizeGatewayEventMetricKey,
  sanitizeClientBootReport,
  GatewayMetricsStore,
  instrumentGatewayResponse,
  parsePort,
  isAddressInUseError,
  parseIPv4,
  isTailscaleAddress,
  selectTailscaleBindAddress,
  formatHostForUrl,
  isLoopbackAddress,
  parseAllowedOrigins,
  originMatchesRule,
  mimeType,
  brotliCompressAsync,
  gzipAsync,
  appendVary,
  negotiateEncoding,
  appendResponseVary,
  appendHeadersVary,
  isCompressibleContentType,
  isCompressibleStaticContentType,
  isImmutableHashedAsset,
  httpDateFromMtimeMs,
  etagForStaticVariant,
  staticEncodingQuality,
  preferredStaticCompressionEncodings,
  compressedStaticSiblingPath,
  ifNoneMatchMatches,
  weakEntityTagValue,
  ifModifiedSinceMatches,
  compressStaticBuffer,
  compressBody,
  activeDynamicCompressions,
  canStartDynamicCompression,
  isDynamicCompressionSizeEligible,
  canBufferBodyChunk,
  DynamicCompressionBufferBudget,
  dynamicProxyCompressionBufferBudget,
  dynamicProxyCompressionBufferSnapshot,
  activeDynamicCompressionCount,
  AggregateByteBudget,
  browserPreviewDecodeBudget,
  browserPreviewDecodeSnapshot,
  allocateBufferedProxySource,
  canAppendToProxySourceBuffer,
  shouldAbandonBufferedProxyBody,
  releaseReservationOnResponseSettled,
  staticFallbackCompressions,
  readStaticFileWithinLimit,
  compressStaticFileWithinLimits,
  canStartStaticFallbackCompression,
  responseCompressionContexts,
  prepareCompressedBody,
  writePreparedBody,
  recoverBodyResponseError,
  settlePreparedBodyResponse,
  settleRewrittenProxyBodyResponse,
  bodyResponse,
  jsonResponse,
  serializedJsonResponse,
  textResponse,
  getCookie,
  getBearerToken,
  tokenMatches,
  authFilePath,
  loadOrCreateGatewayToken,
  persistGatewayToken,
  readRequestBody,
  readJsonBody,
  readLoginToken,
  loginPage,
  wantsHtml,
  filterGatewayCookie,
  sanitizeTargetRequestHeaders,
  isLoopbackHostname,
  proxyPath,
  rewriteLocationHeader,
  rewriteCookiePath,
  rewriteSetCookieHeader,
  rewriteSetCookieHeaders,
  sanitizeProxyResponseHeaders,
  responseStatusCanHaveBody,
  canTransformProxyRepresentation,
  parseStrictContentLengthHeader,
  stripCodedContentHeaders,
  stripTransformedRepresentationHeaders,
  browserPreviewContentKind,
  browserPreviewContentDecoder,
  rewriteBrowserPreviewBody,
  browserPreviewRefererPrefix,
  IdentityEventClientWriter,
  GzipEventClientWriter,
  parseEventSubscriptionFilter,
  eventMatchesSubscription
} = support;

export type InvalidRequestBodyError = support.InvalidRequestBodyError;
export type RequestBodyTooLargeError = support.RequestBodyTooLargeError;
export type BoundedMetricMap<T> = support.BoundedMetricMap<T>;
export type GatewayMetricsStore = support.GatewayMetricsStore;
export type DynamicCompressionBufferBudget = support.DynamicCompressionBufferBudget;
export type AggregateByteBudget = support.AggregateByteBudget;
export type IdentityEventClientWriter = support.IdentityEventClientWriter;
export type GzipEventClientWriter = support.GzipEventClientWriter;

export type BackendInvoker = support.BackendInvoker;
export type NetworkInterfaceMap = support.NetworkInterfaceMap;
export type ListenerKind = support.ListenerKind;
export type GatewayRouteKey = support.GatewayRouteKey;
export type GatewayCompressionMode = support.GatewayCompressionMode;
export type GatewayStartInfo = support.GatewayStartInfo;
export type OrkestratorGatewayOptions = support.OrkestratorGatewayOptions;
export type StaticCompressionEncoding = support.StaticCompressionEncoding;
export type StaticContentEncoding = support.StaticContentEncoding;
export type CompressionEncoding = support.CompressionEncoding;
export type ContentEncoding = support.ContentEncoding;
export type StaticCompressionOutcome = support.StaticCompressionOutcome;
export type GatewayRouteMetrics = support.GatewayRouteMetrics;
export type GatewayCommandMetrics = support.GatewayCommandMetrics;
export type GatewayEventMetrics = support.GatewayEventMetrics;
export type GatewayStreamMetrics = support.GatewayStreamMetrics;
export type GatewayReplayMetrics = support.GatewayReplayMetrics;
export type GatewayCompressionMetrics = support.GatewayCompressionMetrics;
export type GatewayClientBootReport = support.GatewayClientBootReport;
export type GatewayRouteSample = support.GatewayRouteSample;
export type GatewayRequestMetrics = support.GatewayRequestMetrics;
export type DynamicCompressionBufferBudgetSnapshot = support.DynamicCompressionBufferBudgetSnapshot;
export type ResponseCompressionContext = support.ResponseCompressionContext;
export type PreparedBody = support.PreparedBody;
export type DynamicBodyCompressor = support.DynamicBodyCompressor;
export type BrowserPreviewContentKind = support.BrowserPreviewContentKind;
export type EventClientWriter = support.EventClientWriter;
export type DrainAwareEventClientWriter = support.DrainAwareEventClientWriter;
export type GatewayEventClient = support.GatewayEventClient;
export type GatewayReconcileReason = support.GatewayReconcileReason;
export type BufferedGatewayEvent = support.BufferedGatewayEvent;
export type GatewayReplayHandshake = support.GatewayReplayHandshake;
