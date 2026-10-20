/**
 * Shared limits for rich transcript content and transcript artifacts.
 *
 * One table serves the backend admission path, the agent tools, the preview
 * worker and the renderer, so a payload one layer accepts cannot be rejected
 * by another for a reason the author was never told. Byte limits are UTF-8
 * bytes and are enforced before parsing; structural limits are enforced after
 * parsing. Character limits are labelled as characters.
 *
 * Change a value only with recorded qualification evidence and matching tests.
 * Tests read these exports rather than repeating literals.
 */

const KIB = 1024;
const MIB = 1024 * KIB;

export const RICH_CONTENT_POLICY_VERSION = "rich-content-policy:v1";

/** Markdown parser and inline renderer budgets (characters, not bytes). */
export const MARKDOWN_POLICY = {
  blockParserCharacters: 32_000,
  inlineParserCharacters: 8_000,
  /** Streaming display updates per active text part. */
  maxStreamingUpdatesPerSecond: 20,
  maxDisclosureDepth: 4,
} as const;

export const CODE_BLOCK_POLICY = {
  maxHighlightBytes: 32 * KIB,
  maxHighlightLines: 2_000,
  initialVisualLines: 24,
} as const;

export const MERMAID_POLICY = {
  maxSourceBytes: 32 * KIB,
  maxEdges: 250,
  maxSvgBytes: 1 * MIB,
  maxSvgElements: 5_000,
  renderTimeoutMs: 5_000,
} as const;

export const CHART_POLICY = {
  maxPayloadBytes: 256 * KIB,
  maxSeries: 6,
  maxBarCategories: 100,
  maxCartesianPoints: 2_000,
  maxDonutSlices: 24,
  maxTitleCharacters: 200,
  maxLabelCharacters: 200,
  maxDescriptionCharacters: 2_000,
  maxSourceNotes: 8,
  maxSourceNoteCharacters: 500,
  maxIdCharacters: 64,
  maxUnitCharacters: 32,
  maxAbsoluteValue: 1e15,
  maxJsonDepth: 16,
} as const;

export const WORKFLOW_SNAPSHOT_POLICY = {
  maxNormalizedBytes: 256 * KIB,
  maxNodes: 200,
  maxEdges: 400,
  maxIdCharacters: 128,
  maxLabelCharacters: 200,
  maxDescriptionCharacters: 2_000,
  maxRawStatusCharacters: 100,
  maxLinksPerNode: 8,
} as const;

export const STATIC_HTML_POLICY = {
  maxSourceBytes: 256 * KIB,
  /** Authored source plus validated offline asset data URLs. */
  maxPreparedBytes: 16 * MIB,
  maxElements: 5_000,
} as const;

export const INTERACTIVE_HTML_POLICY = {
  maxAuthoredBytes: 512 * KIB,
  maxAssets: 32,
  maxAssetBytesTotal: 10 * MIB,
  maxDependencies: 4,
  maxPreparedBytes: 16 * MIB,
  maxRuntimeElements: 10_000,
  maxProbeSteps: 20,
  maxProbeStepMs: 2_000,
  defaultWaitVisibleMs: 1_000,
  maxProbeTextCharacters: 1_024,
  probeTargetPattern: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
} as const;

export const PREVIEW_CAPTURE_POLICY = {
  maxPngBytes: 8 * MIB,
  maxPixels: 12_000_000,
  maxDimension: 4_096,
  minDimension: 240,
  maxCapturesPerReceipt: 3,
  defaultViewport: { width: 960, height: 640, deviceScaleFactor: 1 as const },
} as const;

export const PREVIEW_ADMISSION_POLICY = {
  runningPerEnvironment: 1,
  runningGlobal: 2,
  queuedPerEnvironment: 8,
  queuedGlobal: 16,
  nonterminalPerConversation: 2,
  queuedMetadataBytesGlobal: 8 * MIB,
  queueWaitMs: 15_000,
  workerWallMs: 30_000,
  readinessMs: 5_000,
  operationDeadlineMs: 45_000,
  cleanupGraceMs: 2_000,
  workerMemoryBytes: 1024 * MIB,
  workerCpus: 2,
  workerPids: 128,
} as const;

export const FRONTEND_RENDER_POLICY = {
  highlightConcurrency: 2,
  diagramConcurrency: 1,
  maxQueuedJobs: 32,
  maxQueuedSourceBytes: 2 * MIB,
  maxSettledCacheEntries: 128,
  maxSettledCacheBytes: 16 * MIB,
  maxInactiveViewStateEntries: 500,
  /** Visible and pinned entries are bounded separately so a pin cannot grow memory without limit. */
  maxActiveViewStateEntries: 200,
  maxPinnedViewStateEntries: 50,
  liveExecutableHostsPerWindow: 1,
  imageDecodeMaxPixels: 40_000_000,
  pdfPreviewMaxPages: 100,
  pdfPreviewMaxBytes: 20 * MIB,
} as const;

/**
 * PDF output of HTML artifacts (printed by the isolated preview worker) and
 * first-page previews of PDF attachments (pdf.js inside the same worker).
 * Page and byte ceilings match `FRONTEND_RENDER_POLICY`'s PDF viewer limits.
 */
export const PDF_POLICY = {
  maxPages: 100,
  maxBytes: 20 * MIB,
  /** First-page thumbnail: longest side in CSS pixels, and its PNG size. */
  thumbnailMaxDimension: 1_024,
  thumbnailMaxPngBytes: 4 * MIB,
  /** pdf.js `maxImageSize` (pixels) while rendering page 1. */
  imageDecodeMaxPixels: 40_000_000,
  /** Fixed print profile margins (millimetres on every side). */
  printMarginMm: 10,
  /** In-memory first-page preview cache, keyed by content hash. */
  previewCacheEntries: 32,
  previewCacheBytes: 16 * MIB,
} as const;

export const DIAGNOSTIC_POLICY = {
  maxPersistedEntries: 50,
  maxEntryBytes: 2 * KIB,
  maxPersistedBytes: 32 * KIB,
  maxToolFieldErrors: 20,
  maxToolDiagnosticBytes: 8 * KIB,
} as const;

export const ARTIFACT_TOOL_POLICY = {
  maxResultBytes: 16 * KIB,
  maxSourceSliceBytes: 8 * KIB,
  maxTitleCharacters: 120,
  maxSummaryCharacters: 400,
  maxRequestKeyCharacters: 128,
  /** Initial preview plus at most two corrective revisions per requested output. */
  maxRepairRevisions: 2,
  maxTransientRetries: 2,
  maxUnpublishedArtifactsPerConversation: 100,
  maxRevisionsPerArtifact: 100,
  assetStoreBytesPerEnvironment: 1024 * MIB,
  scopeCapabilityTtlMs: 24 * 60 * 60 * 1000,
} as const;

export const ARTIFACT_RETENTION_POLICY = {
  cleanupIntervalMs: 60 * 60 * 1000,
  abandonedStagingMs: 60 * 60 * 1000,
  unpublishedDraftMs: 7 * 24 * 60 * 60 * 1000,
  unreferencedPreviewAssetMs: 24 * 60 * 60 * 1000,
} as const;

export const FRAME_CHANNEL_POLICY = {
  maxMessageBytes: 8 * KIB,
  messagesPerSecond: 20,
  burst: 40,
  sizeUpdatesPerSecond: 4,
  minInlineHeight: 120,
  maxInlineHeight: 1_600,
  maxLinkCharacters: 2_048,
  maxLinkLabelCharacters: 200,
} as const;

export function utf8ByteLength(value: string): number {
  // TextEncoder is available in every supported runtime (browser, Bun, Electron).
  return new TextEncoder().encode(value).length;
}
