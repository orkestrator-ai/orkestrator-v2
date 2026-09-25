/**
 * Canonical synthetic fixtures for web annotations. Later steps and tests use
 * these instead of inventing incompatible payloads. All data is synthetic.
 */
import {
  EMPTY_WEB_ANNOTATION_REDACTION,
  WEB_ANNOTATION_REQUEST_STATES,
  WEB_ANNOTATION_SCHEMA_VERSION,
  type WebAnnotation,
  type WebAnnotationAnchor,
  type WebAnnotationCapture,
  type WebAnnotationCaptureInput,
  type WebAnnotationDestination,
  type WebAnnotationEntry,
  type WebAnnotationPageIdentity,
  type WebAnnotationRequest,
  type WebAnnotationRequestState,
  type WebAnnotationTarget,
} from "./web-annotations.js";

export const FIXTURE_ENVIRONMENT_ID = "env-fixture";
export const FIXTURE_TIME = "2026-09-21T12:00:00.000Z";

export const fixturePage: WebAnnotationPageIdentity = {
  service: { kind: "port", port: 5173 },
  route: "/settings?tab=profile",
  displayUrl: "http://localhost:5173/settings?tab=profile",
  title: "Settings",
  requiresNavigation: false,
};

export const fixtureAnchor: WebAnnotationAnchor = {
  stableId: { kind: "test-id", value: "save-settings" },
  semantic: { tagName: "button", role: "button", name: "Save" },
  text: { exact: "Save", prefix: "Cancel", suffix: "" },
  ancestors: [
    { tagName: "form", id: "settings-form", role: null, testId: null, name: null },
    { tagName: "div", id: null, role: "group", testId: "actions", name: null },
  ],
  cssPath: "form#settings-form > div > button:nth-of-type(2)",
  scope: { kind: "document" },
};

export const fixtureTargets: Record<WebAnnotationTarget["kind"], WebAnnotationTarget> = {
  element: {
    kind: "element",
    label: "button “Save”",
    anchor: fixtureAnchor,
    rect: { x: 640, y: 480, width: 72, height: 28 },
  },
  "text-range": {
    kind: "text-range",
    label: "“billed annually”",
    quote: { exact: "billed annually", prefix: "$120 ", suffix: " per seat" },
    container: {
      ...fixtureAnchor,
      stableId: undefined,
      semantic: { tagName: "p", role: null, name: null },
    },
    rect: { x: 100, y: 200, width: 110, height: 18 },
    rects: [{ x: 100, y: 200, width: 110, height: 18 }],
  },
  region: {
    kind: "region",
    label: "Region 320×120",
    rect: { x: 20, y: 40, width: 320, height: 120 },
    imageRect: { x: 20, y: 40, width: 320, height: 120 },
  },
  page: { kind: "page", label: "Whole page" },
  "legacy-unresolved": {
    kind: "legacy-unresolved",
    label: "Imported browser note",
    referenceText: "Browser element annotation\n\nElement: <button> (72×28 at 640, 480)",
  },
};

export function fixtureCaptureInput(
  kind: Exclude<WebAnnotationTarget["kind"], "legacy-unresolved"> = "element",
): WebAnnotationCaptureInput {
  return {
    producer: "desktop-native",
    capturedAt: FIXTURE_TIME,
    documentGeneration: 3,
    page: fixturePage,
    target: fixtureTargets[kind] as WebAnnotationCaptureInput["target"],
    geometry: {
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 120 },
      zoomFactor: 1,
      devicePixelRatio: 2,
      image: { width: 1280, height: 800, scale: 1, reduced: true },
    },
    evidence:
      kind === "page"
        ? null
        : {
            text: "Save",
            attributes: { type: "submit", "data-testid": "save-settings" },
            styles: { "font-size": "12px", padding: "2px 6px" },
            hierarchy: fixtureAnchor.ancestors,
            html: '<button type="submit" data-testid="save-settings">Save</button>',
          },
    assetIds: [],
    redaction: { ...EMPTY_WEB_ANNOTATION_REDACTION },
  };
}

export function fixtureCapture(
  kind: WebAnnotationTarget["kind"] = "element",
  overrides: Partial<WebAnnotationCapture> = {},
): WebAnnotationCapture {
  const base =
    kind === "legacy-unresolved"
      ? {
          ...fixtureCaptureInput("page"),
          target: fixtureTargets["legacy-unresolved"],
          geometry: null,
          evidence: null,
        }
      : fixtureCaptureInput(kind);
  return {
    id: `capture-${kind}`,
    annotationId: "annotation-1",
    schemaVersion: WEB_ANNOTATION_SCHEMA_VERSION,
    revision: 1,
    producer: kind === "legacy-unresolved" ? "legacy-import" : "desktop-native",
    capturedAt: base.capturedAt,
    documentGeneration: base.documentGeneration,
    page: base.page,
    target: base.target,
    geometry: base.geometry,
    evidence: base.evidence,
    assetIds: [],
    redaction: base.redaction,
    state: kind === "legacy-unresolved" ? "stale" : "complete",
    ...overrides,
  };
}

export const fixtureDestination: WebAnnotationDestination = {
  agent: "claude",
  tabId: "tab-agent-1",
  logicalSessionKey: `env-${FIXTURE_ENVIRONMENT_ID}:tab-agent-1`,
  label: "Claude Code",
};

export function fixtureAnnotation(overrides: Partial<WebAnnotation> = {}): WebAnnotation {
  return {
    id: "annotation-1",
    environmentId: FIXTURE_ENVIRONMENT_ID,
    schemaVersion: WEB_ANNOTATION_SCHEMA_VERSION,
    metadataRevision: 1,
    contentRevision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    lastActivityAt: FIXTURE_TIME,
    page: fixturePage,
    currentCaptureId: "capture-element",
    captureRevision: 1,
    title: "Save button is cramped",
    targetKind: "element",
    targetLabel: "button “Save”",
    state: "open",
    hidden: false,
    defaultDestination: null,
    resolution: null,
    activeRequestId: null,
    requestIds: [],
    entryCount: 1,
    entryBytes: 40,
    lastSequence: 1,
    latestIntent: "Give the Save button more padding.",
    thumbnailAssetId: null,
    imported: false,
    ...overrides,
  };
}

export function fixtureEntry(overrides: Partial<WebAnnotationEntry> = {}): WebAnnotationEntry {
  return {
    id: "entry-1",
    annotationId: "annotation-1",
    sequence: 1,
    provenance: "host-user",
    kind: "comment",
    body: "Give the Save button more padding.",
    contentRevision: 1,
    captureId: "capture-element",
    createdAt: FIXTURE_TIME,
    ...overrides,
  };
}

export function fixtureRequest(
  state: WebAnnotationRequestState = "queued",
  overrides: Partial<WebAnnotationRequest> = {},
): WebAnnotationRequest {
  const terminal = ["completed", "awaiting-review", "failed", "cancelled", "abandoned-unconfirmed"];
  return {
    id: `request-${state}`,
    environmentId: FIXTURE_ENVIRONMENT_ID,
    schemaVersion: WEB_ANNOTATION_SCHEMA_VERSION,
    revision: 1,
    operation: "implement",
    destination: fixtureDestination,
    selections: [
      {
        annotationId: "annotation-1",
        reference: 1,
        contentRevision: 1,
        captureId: "capture-element",
        captureRevision: 1,
        entryIds: ["entry-1"],
        desiredOutcome: null,
        historicalEvidence: false,
      },
    ],
    instruction: "Give the Save button more padding.",
    bodyHash: "0".repeat(64),
    briefBytes: 2048,
    evidence: {
      items: [
        {
          annotationId: "annotation-1",
          reference: 1,
          included: ["intent", "target", "page", "geometry", "text", "styles"],
          omitted: ["html"],
          unavailable: ["image"],
          captureState: "complete",
          targetKind: "element",
        },
      ],
      textBytes: 2048,
      imageCount: 0,
      imageBytes: 0,
    },
    attachments: [],
    textOnly: true,
    readOnly: "not-applicable",
    state,
    blockedReason: state === "queued" ? "compose-draft" : null,
    stateReason: state === "failed" ? "The provider rejected the prompt." : null,
    reservation: !terminal.includes(state),
    queueKey: `claude\0${fixtureDestination.logicalSessionKey}`,
    enqueueIntentAt: FIXTURE_TIME,
    queueReceiptAt: state === "prepared" ? null : FIXTURE_TIME,
    dispatchConfirmedAt: [
      "running",
      "needs-input",
      "cancelling",
      "completed",
      "awaiting-review",
    ].includes(state)
      ? FIXTURE_TIME
      : null,
    settledAt: terminal.includes(state) ? FIXTURE_TIME : null,
    cancelRequestedAt: state === "cancelling" || state === "cancelled" ? FIXTURE_TIME : null,
    abandonedAt: state === "abandoned-unconfirmed" ? FIXTURE_TIME : null,
    interactionIds: state === "needs-input" ? ["interaction-1"] : [],
    transcript: {
      requestId: `request-${state}`,
      agent: fixtureDestination.agent,
      tabId: fixtureDestination.tabId,
      logicalSessionKey: fixtureDestination.logicalSessionKey,
    },
    response: null,
    resultIds: [],
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  };
}

/** One request fixture per lifecycle state. */
export function fixtureRequestsByState(): Record<WebAnnotationRequestState, WebAnnotationRequest> {
  return Object.fromEntries(
    WEB_ANNOTATION_REQUEST_STATES.map((state) => [state, fixtureRequest(state)]),
  ) as Record<WebAnnotationRequestState, WebAnnotationRequest>;
}
