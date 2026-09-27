/**
 * Runtime validation for web annotation payloads.
 *
 * Every trust boundary (desktop main, backend command, agent tool) validates
 * with these functions; the renderer uses them to fail early. Validation never
 * trusts a declared provenance: `host-user` is assigned by the receiving
 * boundary, and page-supplied values are bounded before they are stored.
 */
import {
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_PROVENANCES,
  WEB_ANNOTATION_REQUEST_STATES,
  webAnnotationUtf8Bytes,
  type WebAnnotationAnchor,
  type WebAnnotationAnchorResolution,
  type WebAnnotationAncestorDescriptor,
  type WebAnnotationResultCaptureMetadata,
  type WebAnnotationCaptureInput,
  type WebAnnotationCheck,
  type WebAnnotationDestination,
  type WebAnnotationEvidenceSection,
  type WebAnnotationGeometry,
  type WebAnnotationOutcome,
  type WebAnnotationPageEvidence,
  type WebAnnotationPageIdentity,
  type WebAnnotationProvenance,
  type WebAnnotationRect,
  type WebAnnotationRedactionSummary,
  type WebAnnotationRequestState,
  type WebAnnotationTarget,
  type WebAnnotationTargetKind,
  type WebAnnotationTextQuote,
} from "./web-annotations.js";
import { isAgentPlatform } from "./agent-platforms.js";

export type WebAnnotationValidation<T> = { ok: true; value: T } | { ok: false; error: string };

export class WebAnnotationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAnnotationValidationError";
  }
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isWebAnnotationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= WEB_ANNOTATION_LIMITS.idChars &&
    ID_PATTERN.test(value)
  );
}

export function isBoundedString(
  value: unknown,
  maxChars: number,
  maxBytes?: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxChars &&
    (maxBytes === undefined || webAnnotationUtf8Bytes(value) <= maxBytes)
  );
}

function isFiniteNumber(value: unknown, min = -1e7, max = 1e7): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isNonNegativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function isWebAnnotationRect(value: unknown): value is WebAnnotationRect {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width, 0) &&
    isFiniteNumber(value.height, 0)
  );
}

function isNullableString(value: unknown, max: number): value is string | null {
  return value === null || isBoundedString(value, max);
}

function isTextQuote(value: unknown): value is WebAnnotationTextQuote {
  const limit = WEB_ANNOTATION_LIMITS.anchorTextChars;
  return (
    isRecord(value) &&
    isBoundedString(value.exact, limit * 4) &&
    isBoundedString(value.prefix, limit) &&
    isBoundedString(value.suffix, limit)
  );
}

function isAncestor(value: unknown): value is WebAnnotationAncestorDescriptor {
  return (
    isRecord(value) &&
    isBoundedString(value.tagName, 64) &&
    value.tagName.length > 0 &&
    isNullableString(value.id, 200) &&
    isNullableString(value.role, 100) &&
    isNullableString(value.testId, 200) &&
    isNullableString(value.name, WEB_ANNOTATION_LIMITS.anchorTextChars)
  );
}

export function isWebAnnotationAnchor(value: unknown): value is WebAnnotationAnchor {
  if (!isRecord(value)) return false;
  const stableId = value.stableId;
  if (
    stableId !== undefined &&
    !(
      isRecord(stableId) &&
      (stableId.kind === "id" || stableId.kind === "test-id") &&
      isBoundedString(stableId.value, 200) &&
      stableId.value.length > 0
    )
  ) {
    return false;
  }
  const semantic = value.semantic;
  if (
    !isRecord(semantic) ||
    !isBoundedString(semantic.tagName, 64) ||
    semantic.tagName.length === 0 ||
    !isNullableString(semantic.role, 100) ||
    !isNullableString(semantic.name, WEB_ANNOTATION_LIMITS.anchorTextChars)
  ) {
    return false;
  }
  const scope = value.scope;
  const scopeOk =
    isRecord(scope) &&
    (scope.kind === "document" ||
      (scope.kind === "unsupported" &&
        ["iframe", "shadow-root", "closed-root", "cross-origin"].includes(String(scope.reason))));
  return (
    scopeOk &&
    (value.text === null || isTextQuote(value.text)) &&
    Array.isArray(value.ancestors) &&
    value.ancestors.length <= 12 &&
    value.ancestors.every(isAncestor) &&
    isBoundedString(value.cssPath, 4_000)
  );
}

const ENABLED_CAPTURE_TARGETS: ReadonlySet<WebAnnotationTargetKind> = new Set([
  "element",
  "text-range",
  "region",
  "page",
]);

export function isWebAnnotationTarget(
  value: unknown,
  enabled: ReadonlySet<WebAnnotationTargetKind> = ENABLED_CAPTURE_TARGETS,
): value is WebAnnotationTarget {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (!enabled.has(value.kind as WebAnnotationTargetKind)) return false;
  if (!isBoundedString(value.label, WEB_ANNOTATION_LIMITS.titleChars) || !value.label.trim()) {
    return false;
  }
  switch (value.kind) {
    case "element":
      return isWebAnnotationAnchor(value.anchor) && isWebAnnotationRect(value.rect);
    case "text-range":
      return (
        isTextQuote(value.quote) &&
        value.quote.exact.trim().length > 0 &&
        isWebAnnotationAnchor(value.container) &&
        isWebAnnotationRect(value.rect) &&
        Array.isArray(value.rects) &&
        value.rects.length <= 64 &&
        value.rects.every(isWebAnnotationRect)
      );
    case "region":
      return (
        isWebAnnotationRect(value.rect) &&
        value.rect.width >= 1 &&
        value.rect.height >= 1 &&
        (value.imageRect === null || isWebAnnotationRect(value.imageRect)) &&
        (value.parentCaptureId === undefined || isWebAnnotationId(value.parentCaptureId))
      );
    case "page":
      return true;
    case "legacy-unresolved":
      return (
        isBoundedString(value.referenceText, WEB_ANNOTATION_LIMITS.referenceTextChars) &&
        value.referenceText.trim().length > 0
      );
    default:
      return false;
  }
}

export function isWebAnnotationGeometry(value: unknown): value is WebAnnotationGeometry {
  if (!isRecord(value)) return false;
  const viewport = value.viewport;
  const scroll = value.scroll;
  const image = value.image;
  return (
    isRecord(viewport) &&
    isFiniteNumber(viewport.width, 0, 100_000) &&
    isFiniteNumber(viewport.height, 0, 100_000) &&
    isRecord(scroll) &&
    isFiniteNumber(scroll.x) &&
    isFiniteNumber(scroll.y) &&
    isFiniteNumber(value.zoomFactor, 0.05, 20) &&
    isFiniteNumber(value.devicePixelRatio, 0.1, 16) &&
    (image === null ||
      (isRecord(image) &&
        isNonNegativeInteger(image.width, WEB_ANNOTATION_LIMITS.imageMaxDimension) &&
        isNonNegativeInteger(image.height, WEB_ANNOTATION_LIMITS.imageMaxDimension) &&
        isFiniteNumber(image.scale, 0.001, 64) &&
        typeof image.reduced === "boolean"))
  );
}

function isStringRecord(value: unknown, maxEntries: number, maxValue: number): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= maxEntries &&
    entries.every(
      ([key, entry]) => key.length > 0 && key.length <= 100 && isBoundedString(entry, maxValue),
    )
  );
}

export function isWebAnnotationEvidence(value: unknown): value is WebAnnotationPageEvidence {
  return (
    isRecord(value) &&
    isBoundedString(value.text, 4_000) &&
    isStringRecord(value.attributes, 32, 500) &&
    isStringRecord(value.styles, 48, 300) &&
    Array.isArray(value.hierarchy) &&
    value.hierarchy.length <= 12 &&
    value.hierarchy.every(isAncestor) &&
    isBoundedString(value.html, 8_000) &&
    (value.sourceHints === undefined ||
      (Array.isArray(value.sourceHints) &&
        value.sourceHints.length <= 4 &&
        value.sourceHints.every(
          (hint) =>
            isRecord(hint) &&
            isBoundedString(hint.producer, 100) &&
            isBoundedString(hint.path, 1_000) &&
            (hint.line === undefined || isNonNegativeInteger(hint.line, 10_000_000)) &&
            (hint.component === undefined || isBoundedString(hint.component, 200)) &&
            typeof hint.verified === "boolean",
        )))
  );
}

export function isWebAnnotationRedaction(value: unknown): value is WebAnnotationRedactionSummary {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.attributesRemoved, 10_000) &&
    isNonNegativeInteger(value.valuesMasked, 10_000) &&
    isNonNegativeInteger(value.urlParametersRemoved, 10_000) &&
    isNonNegativeInteger(value.sensitiveRegionsMasked, 10_000) &&
    isNonNegativeInteger(value.manualRegions, WEB_ANNOTATION_LIMITS.redactionRegions) &&
    typeof value.imageExcluded === "boolean"
  );
}

export function isWebAnnotationPageIdentity(value: unknown): value is WebAnnotationPageIdentity {
  if (!isRecord(value)) return false;
  const service = value.service;
  const serviceOk =
    isRecord(service) &&
    (service.kind === "unknown" ||
      (service.kind === "service" && isWebAnnotationId(service.serviceId)) ||
      (service.kind === "port" &&
        isNonNegativeInteger(service.port, 65_535) &&
        (service.port as number) > 0));
  return (
    serviceOk &&
    isBoundedString(value.route, 4_000) &&
    (value.route as string).startsWith("/") &&
    isBoundedString(value.displayUrl, 4_000) &&
    isBoundedString(value.title, 500) &&
    typeof value.requiresNavigation === "boolean"
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

export function validateWebAnnotationCaptureInput(
  value: unknown,
): WebAnnotationValidation<WebAnnotationCaptureInput> {
  if (!isRecord(value)) return fail("Capture must be an object");
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return fail("Capture must be JSON serializable");
  }
  if (webAnnotationUtf8Bytes(encoded) > WEB_ANNOTATION_LIMITS.captureMetadataBytes) {
    return fail("Capture metadata exceeds 64 KiB");
  }
  if (!["desktop-native", "text-only", "result-capture"].includes(String(value.producer))) {
    return fail("Unsupported capture producer");
  }
  if (!isIsoTimestamp(value.capturedAt)) return fail("Capture time is invalid");
  if (value.documentGeneration !== null && !isNonNegativeInteger(value.documentGeneration)) {
    return fail("Document generation is invalid");
  }
  if (!isWebAnnotationPageIdentity(value.page)) return fail("Page identity is invalid");
  if (!isWebAnnotationTarget(value.target)) return fail("Capture target is invalid or unsupported");
  if (value.geometry !== null && !isWebAnnotationGeometry(value.geometry)) {
    return fail("Capture geometry is invalid");
  }
  if (value.evidence !== null && !isWebAnnotationEvidence(value.evidence)) {
    return fail("Capture evidence is invalid");
  }
  if (
    !Array.isArray(value.assetIds) ||
    value.assetIds.length > 4 ||
    !value.assetIds.every(isWebAnnotationId) ||
    new Set(value.assetIds).size !== value.assetIds.length
  ) {
    return fail("Capture asset references are invalid");
  }
  if (!isWebAnnotationRedaction(value.redaction)) return fail("Redaction summary is invalid");
  if (
    value.stale !== undefined &&
    !(isRecord(value.stale) && isBoundedString(value.stale.reason, 300))
  ) {
    return fail("Stale capture reason is invalid");
  }
  return { ok: true, value: value as unknown as WebAnnotationCaptureInput };
}

const ANCHOR_STATES = new Set([
  "matched",
  "missing",
  "ambiguous",
  "stale",
  "unsupported",
  "too-complex",
]);
const ANCHOR_RULES = new Set([
  "route-mismatch",
  "stable-id",
  "semantic-context",
  "structural-path",
  "text-quote",
  "none",
]);

function isAnchorResolution(value: unknown): value is WebAnnotationAnchorResolution {
  return (
    isRecord(value) &&
    ANCHOR_STATES.has(String(value.state)) &&
    ANCHOR_RULES.has(String(value.rule)) &&
    isNonNegativeInteger(value.candidateCount, 1_000) &&
    (value.documentGeneration === null || isNonNegativeInteger(value.documentGeneration)) &&
    (value.rect === null || isWebAnnotationRect(value.rect)) &&
    (value.offPage === undefined || typeof value.offPage === "boolean")
  );
}

/**
 * Optional comparison metadata sent with a result (after) capture. Absent
 * fields are fine; present fields must be bounded. Returns only known fields.
 */
export function validateWebAnnotationResultCaptureMetadata(
  value: Record<string, unknown>,
): WebAnnotationValidation<WebAnnotationResultCaptureMetadata> {
  const out: WebAnnotationResultCaptureMetadata = {};
  if (value.zoomFactor !== undefined) {
    if (!isFiniteNumber(value.zoomFactor, 0.05, 20)) return fail("zoomFactor is invalid");
    out.zoomFactor = value.zoomFactor;
  }
  if (value.deviceScaleFactor !== undefined) {
    if (!isFiniteNumber(value.deviceScaleFactor, 0.1, 16)) {
      return fail("deviceScaleFactor is invalid");
    }
    out.deviceScaleFactor = value.deviceScaleFactor;
  }
  if (value.scroll !== undefined) {
    const scroll = value.scroll;
    if (!isRecord(scroll) || !isFiniteNumber(scroll.x) || !isFiniteNumber(scroll.y)) {
      return fail("scroll is invalid");
    }
    out.scroll = { x: scroll.x, y: scroll.y };
  }
  if (value.stability !== undefined) {
    if (value.stability !== "stable" && value.stability !== "unstable") {
      return fail("stability must be stable or unstable");
    }
    out.stability = value.stability;
  }
  if (value.masks !== undefined) {
    if (
      !Array.isArray(value.masks) ||
      value.masks.length > WEB_ANNOTATION_LIMITS.redactionRegions ||
      !value.masks.every(
        (mask) =>
          isRecord(mask) &&
          (mask.source === "sensitive-field" || mask.source === "manual") &&
          isWebAnnotationRect(mask.rect),
      )
    ) {
      return fail("masks are invalid");
    }
    out.masks = (
      value.masks as Array<{ source: "sensitive-field" | "manual"; rect: WebAnnotationRect }>
    ).map((mask) => ({
      source: mask.source,
      rect: { x: mask.rect.x, y: mask.rect.y, width: mask.rect.width, height: mask.rect.height },
    }));
  }
  if (value.targetResolution !== undefined) {
    if (!isAnchorResolution(value.targetResolution)) return fail("targetResolution is invalid");
    out.targetResolution = value.targetResolution;
  }
  return { ok: true, value: out };
}

/** Human entry text: multiline, non-blank, bounded by characters and bytes. */
export function validateWebAnnotationBody(
  value: unknown,
  maxChars: number = WEB_ANNOTATION_LIMITS.entryChars,
): WebAnnotationValidation<string> {
  if (typeof value !== "string") return fail("Comment must be text");
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return fail("Comment must not be empty");
  if (normalized.length > maxChars) return fail(`Comment exceeds ${maxChars} characters`);
  if (webAnnotationUtf8Bytes(normalized) > maxChars * 4) return fail("Comment is too large");
  return { ok: true, value: normalized };
}

export function validateWebAnnotationTitle(value: unknown): WebAnnotationValidation<string> {
  if (typeof value !== "string") return fail("Title must be text");
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) return fail("Title must not be empty");
  if (title.length > WEB_ANNOTATION_LIMITS.titleChars) return fail("Title exceeds 200 characters");
  return { ok: true, value: title };
}

export function isWebAnnotationDestination(value: unknown): value is WebAnnotationDestination {
  return (
    isRecord(value) &&
    isAgentPlatform(value.agent) &&
    isWebAnnotationId(value.tabId) &&
    isBoundedString(value.logicalSessionKey, 512) &&
    (value.logicalSessionKey as string).length > 0 &&
    (value.label === undefined || isBoundedString(value.label, WEB_ANNOTATION_LIMITS.titleChars))
  );
}

/**
 * Provenance is decided by the receiving boundary. A client or page payload
 * that claims `host-user` (or anything else) is rejected rather than trusted.
 */
export function assertNoDeclaredProvenance(value: unknown): void {
  if (isRecord(value) && Object.hasOwn(value, "provenance")) {
    throw new WebAnnotationValidationError("Provenance is assigned by the receiver");
  }
}

export function isWebAnnotationProvenance(value: unknown): value is WebAnnotationProvenance {
  return WEB_ANNOTATION_PROVENANCES.includes(value as WebAnnotationProvenance);
}

export function isWebAnnotationRequestState(value: unknown): value is WebAnnotationRequestState {
  return WEB_ANNOTATION_REQUEST_STATES.includes(value as WebAnnotationRequestState);
}

const OUTCOMES: ReadonlySet<WebAnnotationOutcome> = new Set([
  "addressed",
  "partly-addressed",
  "not-addressed",
  "needs-clarification",
  "unreported",
]);

export interface WebAnnotationResultReportInput {
  requestId: string;
  expectedResultRevision: number | null;
  summary: string;
  outcomes: Array<{ annotationId: string; outcome: WebAnnotationOutcome; note: string | null }>;
  files: string[];
  checks: Array<Omit<WebAnnotationCheck, "provenance" | "artifactId">>;
  limitations: string[];
  questions: string[];
  /** Request evidence ids (attachment asset ids, capture ids) the report cites. */
  evidenceIds?: string[];
}

/**
 * Validates an agent-supplied result report. Check provenance is not accepted
 * from the agent: every agent check is recorded as `agent-reported`.
 */
export function validateWebAnnotationResultReport(
  value: unknown,
): WebAnnotationValidation<WebAnnotationResultReportInput> {
  if (!isRecord(value)) return fail("Result must be an object");
  const limits = WEB_ANNOTATION_LIMITS;
  if (!isWebAnnotationId(value.requestId)) return fail("requestId is invalid");
  const expected = value.expectedResultRevision ?? null;
  if (expected !== null && !isNonNegativeInteger(expected, limits.resultRevisions)) {
    return fail("expectedResultRevision is invalid");
  }
  if (!isBoundedString(value.summary, limits.resultSummaryChars) || !value.summary.trim()) {
    return fail("summary is required and bounded");
  }
  const outcomes = value.outcomes ?? [];
  if (
    !Array.isArray(outcomes) ||
    outcomes.length > limits.briefAnnotations ||
    !outcomes.every(
      (entry) =>
        isRecord(entry) &&
        isWebAnnotationId(entry.annotationId) &&
        OUTCOMES.has(entry.outcome as WebAnnotationOutcome) &&
        (entry.note === undefined || entry.note === null || isBoundedString(entry.note, 2_000)),
    )
  ) {
    return fail("outcomes are invalid");
  }
  const files = value.files ?? [];
  if (
    !Array.isArray(files) ||
    files.length > limits.resultFiles ||
    !files.every((file) => typeof file === "string" && isSafeRelativePath(file))
  ) {
    return fail("files must be bounded repository-relative paths");
  }
  const checks = value.checks ?? [];
  if (
    !Array.isArray(checks) ||
    checks.length > limits.resultChecks ||
    !checks.every(
      (check) =>
        isRecord(check) &&
        isBoundedString(check.description, 500) &&
        check.description.trim().length > 0 &&
        ["passed", "failed", "not-run", "unavailable"].includes(String(check.outcome)),
    )
  ) {
    return fail("checks are invalid");
  }
  const lines = (list: unknown, name: string) =>
    Array.isArray(list) && list.length <= 20 && list.every((item) => isBoundedString(item, 1_000))
      ? null
      : `${name} are invalid`;
  const limitationsError = lines(value.limitations ?? [], "limitations");
  if (limitationsError) return fail(limitationsError);
  const questionsError = lines(value.questions ?? [], "questions");
  if (questionsError) return fail(questionsError);
  const evidenceIds = value.evidenceIds ?? [];
  if (
    !Array.isArray(evidenceIds) ||
    evidenceIds.length > 50 ||
    !evidenceIds.every(isWebAnnotationId)
  ) {
    return fail("evidenceIds are invalid");
  }
  return {
    ok: true,
    value: {
      requestId: value.requestId,
      expectedResultRevision: expected as number | null,
      summary: value.summary,
      outcomes: (outcomes as Array<Record<string, unknown>>).map((entry) => ({
        annotationId: entry.annotationId as string,
        outcome: entry.outcome as WebAnnotationOutcome,
        note: (entry.note as string | null | undefined) ?? null,
      })),
      files: files as string[],
      checks: (checks as Array<Record<string, unknown>>).map((check) => ({
        description: check.description as string,
        outcome: check.outcome as WebAnnotationCheck["outcome"],
      })),
      limitations: (value.limitations ?? []) as string[],
      questions: (value.questions ?? []) as string[],
      evidenceIds: Array.from(new Set(evidenceIds as string[])),
    },
  };
}

/** Repository-relative, normalized, no traversal, no absolute or drive paths. */
export function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > 1_000) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes("\0")) return false;
  return value
    .split(/[\\/]/)
    .every((segment) => segment.length > 0 && segment !== ".." && segment !== ".");
}

// ---------------------------------------------------------------------------
// URL sanitization for durable page identity.

const SENSITIVE_PARAMETER =
  /(token|secret|password|passwd|pwd|auth|session|sid|sig|signature|key|credential|jwt|bearer|code|otp|nonce|state|cookie)/i;
const OPAQUE_VALUE = /^[A-Za-z0-9+/_=.-]{32,}$/;

export interface SanitizedWebAnnotationUrl {
  route: string;
  displayUrl: string;
  removedParameters: number;
  requiresNavigation: boolean;
}

function sanitizeParameters(parameters: URLSearchParams): {
  kept: URLSearchParams;
  removed: number;
} {
  const kept = new URLSearchParams();
  let removed = 0;
  for (const [name, value] of parameters) {
    if (SENSITIVE_PARAMETER.test(name) || OPAQUE_VALUE.test(value)) {
      removed++;
      continue;
    }
    kept.append(name.slice(0, 200), value.slice(0, 500));
  }
  return { kept, removed };
}

function sanitizeHash(hash: string): { hash: string; removed: number } {
  if (!hash || hash === "#") return { hash: "", removed: 0 };
  const body = hash.slice(1);
  // Hash routes (`#/settings?tab=a`) and fragment parameters both appear in
  // practice. Treat `key=value` pairs as parameters; keep plain anchors.
  if (body.includes("=")) {
    const [path, query = ""] = body.includes("?") ? body.split("?", 2) : ["", body];
    const { kept, removed } = sanitizeParameters(new URLSearchParams(query));
    const rebuilt = `${path ?? ""}${kept.size > 0 ? `${path ? "?" : ""}${kept.toString()}` : ""}`;
    return { hash: rebuilt ? `#${rebuilt}` : "", removed };
  }
  return { hash: `#${body.slice(0, 500)}`, removed: 0 };
}

/**
 * Produce a durable route and display URL from an actual page URL. Credentials,
 * token-like parameters, and gateway prefixes never survive.
 */
export function sanitizeWebAnnotationUrl(
  value: string,
  options: { routePrefix?: RegExp } = {},
): SanitizedWebAnnotationUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { route: "/", displayUrl: "", removedParameters: 0, requiresNavigation: true };
  }
  let pathname = url.pathname || "/";
  if (options.routePrefix) {
    const match = options.routePrefix.exec(pathname);
    if (match) pathname = match[1] || "/";
  }
  const query = sanitizeParameters(url.searchParams);
  const hash = sanitizeHash(url.hash);
  const removed = query.removed + hash.removed + (url.username || url.password ? 1 : 0);
  const search = query.kept.size > 0 ? `?${query.kept.toString()}` : "";
  const route =
    `${pathname.startsWith("/") ? pathname : `/${pathname}`}${search}${hash.hash}`.slice(0, 4_000);
  const display = new URL(url.toString());
  display.username = "";
  display.password = "";
  display.pathname = pathname;
  display.search = search;
  display.hash = hash.hash;
  return {
    route,
    displayUrl: display.toString().slice(0, 4_000),
    removedParameters: removed,
    requiresNavigation: removed > 0,
  };
}

/** Evidence sections in budget priority order: essential first. */
export const WEB_ANNOTATION_EVIDENCE_PRIORITY: readonly WebAnnotationEvidenceSection[] = [
  "intent",
  "target",
  "page",
  "geometry",
  "text",
  "legacy-reference",
  "image",
  "styles",
  "hierarchy",
  "attributes",
  "thread-summary",
  "html",
];
