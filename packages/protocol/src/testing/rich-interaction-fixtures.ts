/**
 * Valid rich interaction specs and results for every registered kind, shared
 * by protocol, backend and renderer tests. Each fixture names an action the
 * result is valid for.
 */
import type { RichInteractionKind } from "../rich-interactions/core.js";

export interface RichKindFixture {
  title: string;
  spec: unknown;
  actionId: string;
  result: unknown;
}

const artifact = (artifactId: string, revision: number, label?: string) => ({ kind: "artifact", artifactId, revision, ...(label ? { label } : {}) });

export const RICH_KIND_FIXTURES: Record<RichInteractionKind, RichKindFixture> = {
  choice: {
    title: "Findings layout",
    spec: {
      questions: [
        {
          id: "findings-layout",
          prompt: "Which findings layout should I implement?",
          options: [
            { id: "focused-list", label: "Focused list", description: "One finding at a time", tradeoffs: ["Less overview"], preview: { kind: "artifact", description: "List mockup", ref: artifact("layout-list", 3) } },
            { id: "board", label: "Visual board", preview: { kind: "text", description: "Board sketch", source: "[ a ][ b ][ c ]" } },
          ],
          recommendedOptionId: "focused-list",
          recommendationRationale: "Matches keyboard review flow",
        },
      ],
    },
    actionId: "submit",
    result: { answers: [{ questionId: "findings-layout", optionIds: ["focused-list"] }], constraints: "Keep keyboard navigation visible" },
  },
  form: {
    title: "Configure the task",
    spec: {
      purpose: "Configure the background job",
      form: {
        fields: [
          { id: "concurrency", type: "number", label: "Concurrency", required: true, integer: true, minimum: 1, maximum: 16, unit: "workers", default: 4 },
          { id: "timeoutSeconds", type: "number", label: "Timeout", required: false, unit: "s", minimum: 0 },
          { id: "paths", type: "list", itemType: "text", label: "Allowed directories", required: false },
          { id: "browser", type: "boolean", label: "Include browser checks", required: true },
          { id: "browserName", type: "enum", label: "Browser", required: true, options: [{ id: "chromium", label: "Chromium" }], visibleWhen: { fieldId: "browser", equals: true } },
        ],
      },
    },
    actionId: "submit",
    result: { schemaRevision: 1, values: { concurrency: 0 + 4, timeoutSeconds: 0, paths: ["apps/web"], browser: false } },
  },
  plan: {
    title: "Session reliability plan",
    spec: {
      planId: "session-reliability",
      steps: [
        { id: "schema", title: "Add schema", dependsOn: [] },
        { id: "historical-migration", title: "Migrate history", dependsOn: ["schema"], optional: true },
        { id: "recovery-tests", title: "Recovery tests", dependsOn: ["schema"] },
        { id: "release", title: "Release", dependsOn: ["recovery-tests"] },
      ],
      criteria: [{ id: "c1", text: "No lost sessions" }],
    },
    actionId: "accept-scope",
    result: {
      baseRevision: 1,
      changes: [
        { op: "setIncluded", stepId: "historical-migration", value: false },
        { op: "addConstraint", text: "Preserve existing provider adapters" },
      ],
    },
  },
  collection: {
    title: "Usability findings",
    spec: {
      collectionId: "usability-findings",
      sourceRevision: 3,
      columns: [
        { id: "title", label: "Finding", type: "text" },
        { id: "severity", label: "Severity", type: "number" },
        { id: "priority", label: "Priority", type: "enum", options: ["low", "high"], editable: true },
      ],
      rows: [
        { id: "finding-02", cells: { title: "Focus lost", severity: 3, priority: "low" } },
        { id: "finding-07", cells: { title: "Slow search", severity: 10, priority: null } },
      ],
      complete: true,
    },
    actionId: "discuss-selected",
    result: { sourceRevision: 3, selection: { mode: "explicit", rowIds: ["finding-02", "finding-07"] }, edits: [{ rowId: "finding-07", field: "priority", value: "high" }] },
  },
  "code-review": {
    title: "Review session changes",
    spec: {
      changeRef: "commit:abc123..def456",
      files: [
        {
          path: "apps/backend/src/session.ts",
          status: "modified",
          afterHash: "sha256-after",
          hunks: [
            {
              id: "h1",
              header: "@@ -40,3 +40,4 @@",
              lines: [
                { type: "ctx", text: "function load() {", before: 40, after: 40 },
                { type: "del", text: "  return null;", before: 41 },
                { type: "add", text: "  throw new Error('gone');", after: 41 },
                { type: "add", text: "  // unreachable", after: 42 },
              ],
            },
          ],
        },
      ],
    },
    actionId: "send-review",
    result: { items: [{ itemId: "i1", file: "apps/backend/src/session.ts", scope: "lines", hunkId: "h1", side: "after", startLine: 41, endLine: 42, disposition: "revise", comment: "Return a clear error when the session no longer exists." }] },
  },
  feedback: {
    title: "Comment",
    spec: {
      target: { source: artifact("settings-preview", 5), location: { kind: "image-region", rect: { x: 0.12, y: 0.28, width: 0.3, height: 0.16 } } },
      entries: [],
      resolved: false,
    },
    actionId: "discuss",
    result: { body: "Why is this button misaligned?" },
  },
  "result-review": {
    title: "Review result",
    spec: {
      reviewId: "findings-layout-review",
      requestSummary: "Implement the focused list",
      sourceRevision: 2,
      resultRevision: 5,
      comparisons: [{ id: "screen", label: "Findings screen", mode: "image", before: artifact("shot-before", 1), after: artifact("shot-after", 1) }],
      checks: [{ id: "unit", label: "Unit tests", status: "passed", provenance: "agent-reported" }],
      criteria: [{ id: "keyboard-navigation", text: "Keyboard navigation works" }],
    },
    actionId: "request-changes",
    result: { expectedResultRevision: 5, decision: "request-changes", criterionIds: ["keyboard-navigation"], comment: "Keep the layout; improve the keyboard focus indicator." },
  },
  document: {
    title: "Provider integration spec",
    spec: {
      documentId: "doc_example",
      title: "Provider integration",
      blocks: [
        { id: "intro", type: "heading", level: 1, text: "Overview" },
        { id: "recovery", type: "paragraph", text: "Retry blindly." },
        { id: "compat", type: "paragraph", text: "Compatible with v1.", preserved: true },
      ],
    },
    actionId: "ask-revise",
    result: { baseRevision: 1, blockIds: ["recovery"], instruction: "Expand failure recovery" },
  },
  diagnostics: {
    title: "Test run",
    spec: {
      runId: "run_example",
      runRevision: 7,
      baseline: { commit: "abc1234" },
      status: "failed",
      commands: [{ id: "unit", label: "bun test", status: "failed", exitCode: 1 }],
      cases: [
        { id: "auth:expired-session", name: "expired session", status: "failed", message: "expected 401", rerunnable: true },
        { id: "auth:refresh-token", name: "refresh token", status: "failed", excerpt: "TypeError: x is undefined" },
        { id: "ui:browser", name: "browser case", status: "skipped" },
        { id: "types", name: "typecheck", status: "passed" },
      ],
    },
    actionId: "request-fix",
    result: { runRevision: 7, caseIds: ["auth:expired-session", "auth:refresh-token"] },
  },
  "chart-selection": {
    title: "Build duration",
    spec: {
      chart: {
        schemaVersion: 1,
        kind: "line",
        title: "Build duration",
        description: "Build duration per run",
        xAxis: { kind: "number", label: "Run" },
        yAxis: { label: "Duration", unit: "s" },
        series: [{ id: "build-duration", label: "Build", points: [{ x: 99, y: 40 }, { x: 100, y: 80 }, { x: 110, y: null }, { x: 120, y: 85 }, { x: 121, y: 41 }] }],
      },
      source: artifact("chart_example", 3),
    },
    actionId: "investigate-selection",
    result: { selection: { kind: "chart-range", seriesIds: ["build-duration"], from: 100, to: 120, inclusive: true, population: "all-underlying-observations" }, question: "Why did this regress?" },
  },
  diagram: {
    title: "Architecture",
    spec: {
      title: "Architecture",
      mermaid: "flowchart LR\n  bridge --> backend",
      objects: [
        { id: "node:provider-bridge", type: "node", label: "Provider bridge" },
        { id: "node:backend", type: "node", label: "Backend" },
        { id: "edge:bridge-to-backend", type: "edge", label: "HTTP", from: "node:provider-bridge", to: "node:backend" },
      ],
    },
    actionId: "explain",
    result: { objectIds: ["node:provider-bridge", "edge:bridge-to-backend"], question: "What happens when this connection is interrupted?" },
  },
  "widget-result": {
    title: "Capacity explorer",
    spec: {
      artifactId: "explorer_example",
      revision: 5,
      intent: "Choose worker settings",
      assumptions: ["Illustrative resource model; not a measured benchmark"],
      output: { fields: [{ id: "workers", type: "number", label: "Workers", required: true, integer: true, minimum: 1 }, { id: "memoryPerWorkerMiB", type: "number", label: "Memory per worker", unit: "MiB", required: true }] },
    },
    actionId: "send-result",
    result: { candidateId: "candidate_12", candidateHash: "fnv1a:0000", generation: "gen-1", value: { workers: 4, memoryPerWorkerMiB: 2048 } },
  },
  evidence: {
    title: "Why change buffering",
    spec: {
      recommendation: "Change transcript buffering",
      claims: [{ id: "claim_buffering", text: "Buffering causes the stall", kind: "interpretation" }],
      evidence: [{ id: "trace_steady_state", label: "Performance trace", source: artifact("trace", 7), excerpt: "frame 120ms" }],
      links: [{ claimId: "claim_buffering", evidenceId: "trace_steady_state", relevance: "Shows long frames during flush" }],
    },
    actionId: "challenge-assumption",
    result: { claimId: "claim_buffering", evidenceIds: ["trace_steady_state"], question: "Does this interval exclude initialization?" },
  },
  "context-packet": {
    title: "Regression context",
    spec: {
      items: [
        { itemId: "ctx-1", kind: "file", source: { kind: "file", path: "src/a.ts", live: true }, label: "a.ts", freeze: "latest" },
        { itemId: "ctx-2", kind: "artifact-selection", source: artifact("benchmark-a", 4), location: { kind: "chart-points", seriesIds: ["compile"], pointIds: ["compile#4"] }, label: "the regression", userNote: "Explain this regression" },
      ],
    },
    actionId: "send",
    result: { prompt: "Why did compile time jump?" },
  },
  criteria: {
    title: "Definition of done",
    spec: {
      setId: "crit-1",
      phase: "proposed",
      criteria: [
        { id: "narrow", requirement: "Usable at 390px", verification: { kind: "manual-walkthrough", steps: ["Resize to 390px", "Open menu"] } },
        { id: "keyboard-menu", requirement: "Every menu action is reachable by keyboard", verification: { kind: "inspection" } },
      ],
    },
    actionId: "agree",
    result: { edits: [{ criterionId: "narrow", requirement: "Usable at 375px" }] },
  },
  alternatives: {
    title: "Caching approaches",
    spec: {
      comparisonId: "cache-strategies",
      objective: "Reduce p95 latency",
      baseline: { commit: "base123" },
      criteria: [{ id: "latency", text: "p95 under 200ms" }],
      alternatives: [
        { id: "bounded-memory", label: "Bounded memory", summary: "LRU", status: "ready", commit: "aaa111", measurements: [{ criterionId: "latency", label: "p95", value: 180, unit: "ms" }] },
        { id: "disk", label: "Disk cache", summary: "SQLite", status: "ready", commit: "bbb222", measurements: [{ criterionId: "latency", label: "p95", value: null, unit: "ms" }] },
      ],
    },
    actionId: "prefer",
    result: { alternativeId: "bounded-memory", rationale: "Meets latency target with simpler invalidation" },
  },
  "workflow-actions": {
    title: "Validation workflow",
    spec: {
      workflowId: "wf-1",
      runId: "run-3",
      title: "Validation",
      snapshotRevision: 4,
      nodes: [
        { id: "lint", label: "Lint", state: "succeeded" },
        { id: "validation", label: "Validation", state: "failed", attemptId: "attempt-3", detail: "2 tests failed" },
      ],
    },
    actionId: "explain-failure",
    result: { nodeId: "validation", attemptId: "attempt-3", snapshotRevision: 4 },
  },
  "voice-request": {
    title: "Spoken request",
    spec: {
      targets: [{ source: artifact("build-trend", 5), location: { kind: "chart-points", seriesIds: ["build"], pointIds: ["build#42"] } }],
      recognized: "explain why this changed",
      engine: { name: "web-speech", processing: "unknown" },
    },
    actionId: "send",
    result: { text: "Explain why this changed" },
  },
  demonstration: {
    title: "Selection disappears",
    spec: {
      traceId: "trace-1",
      revision: 1,
      service: { label: "Web app", origin: "http://localhost:5173" },
      startedAt: "2026-11-20T10:00:00.000Z",
      durationMs: 9_000,
      steps: [
        { stepId: "step-1", offsetMs: 0, action: "click", target: { role: "button", label: "Menu" }, route: "/items", documentSegment: 0 },
        { stepId: "step-2", offsetMs: 4_000, action: "input", target: { role: "textbox", label: "Name" }, documentSegment: 0, valueOmitted: true },
        { stepId: "step-4", offsetMs: 8_250, action: "submit", target: { role: "button", label: "Save" }, documentSegment: 0, userObservation: "The selection disappears", wrongHere: true },
      ],
      gaps: [],
      stopReason: "user",
    },
    actionId: "send",
    result: { stepIds: ["step-1", "step-2", "step-4"], expectedOutcome: "The chosen item remains visible" },
  },
};
