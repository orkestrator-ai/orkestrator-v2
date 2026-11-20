/**
 * Results and reasoning (features 9-12 and 14): structured test/build result
 * cards, chart selections, diagram object actions, authored widget results
 * and inspectable evidence.
 *
 * Browser-safe.
 */
import { validateChartSpec, type ChartSpecV1 } from "../chart-spec.js";
import {
  readFormSpec,
  readFormValues,
  summarizeFormValues,
  type FormSpec,
  type FormValues,
} from "./form.js";
import { followup, type RichKindModule } from "./kind-module.js";
import {
  clip,
  describeAnchorLocation,
  describeContentRef,
  readAnchorLocation,
  readContentRef,
  type AnchorLocation,
  type ContentRef,
} from "./refs.js";
import {
  arr,
  fail,
  id,
  num,
  obj,
  oneOf,
  optArr,
  optBool,
  optNum,
  optStr,
  str,
  uniqueIds,
} from "./validate.js";

const TEXT = 8_000;
const LABEL = 200;

// ---------------------------------------------------------------------------
// 09. Structured test and build result cards

export const DIAGNOSTIC_CASE_STATUSES = [
  "passed",
  "failed",
  "skipped",
  "incomplete",
  "not-run",
] as const;
export type DiagnosticCaseStatus = (typeof DIAGNOSTIC_CASE_STATUSES)[number];

export interface DiagnosticCase {
  id: string;
  name: string;
  suite?: string;
  status: DiagnosticCaseStatus;
  location?: string;
  message?: string;
  excerpt?: string;
  attempt?: number;
  evidence: ContentRef[];
  /** observed: Orkestrator or a structured reporter saw it; reported: the agent says so. */
  provenance: "observed" | "reported";
  /** A server-held selector exists for an exact rerun of this case. */
  rerunnable: boolean;
}

export interface DiagnosticsSpec {
  runId: string;
  runRevision: number;
  baseline: { commit?: string; worktreeSnapshotId?: string; environmentLabel?: string };
  status: "running" | "passed" | "failed" | "cancelled" | "incomplete";
  commands: Array<{
    id: string;
    label: string;
    status: DiagnosticCaseStatus;
    exitCode?: number;
    durationMs?: number;
    outputTruncated?: boolean;
  }>;
  cases: DiagnosticCase[];
  /** The current workspace differs from the tested baseline. */
  workspaceChanged?: boolean;
}

export interface DiagnosticsResult {
  runRevision: number;
  caseIds: string[];
  note?: string;
}

export const DIAGNOSTICS_LIMITS = { cases: 2_000, commands: 50, excerptChars: 8_000 } as const;

export function diagnosticCounts(spec: DiagnosticsSpec): Record<DiagnosticCaseStatus, number> {
  const counts = { passed: 0, failed: 0, skipped: 0, incomplete: 0, "not-run": 0 };
  for (const item of spec.cases) counts[item.status] += 1;
  return counts;
}

export const diagnosticsKind: RichKindModule<DiagnosticsSpec, DiagnosticsResult> = {
  kind: "diagnostics",
  features: [9],
  title: "Test and build results",
  actions: [
    followup("explain-selection", "Explain selection", { closesRequest: false }),
    followup("request-fix", "Ask agent to fix", { closesRequest: false }),
    {
      id: "rerun-selection",
      label: "Rerun selection",
      route: "product-command",
      effect: "command",
      commandId: "diagnostics.rerun",
      style: "secondary",
      closesRequest: false,
      description: "Runs only the selected cases through their registered runner selector.",
    },
  ],
  customFollowups: false,
  repeatable: true,
  readSpec(value, path) {
    const r = obj(value, path, [
      "runId",
      "runRevision",
      "baseline",
      "status",
      "commands",
      "cases",
      "workspaceChanged",
    ]);
    const baselineRecord = obj(r.baseline ?? {}, `${path}.baseline`, [
      "commit",
      "worktreeSnapshotId",
      "environmentLabel",
    ]);
    const baseline: DiagnosticsSpec["baseline"] = {};
    const commit = optStr(baselineRecord.commit, `${path}.baseline.commit`, 64);
    const snapshot = optStr(
      baselineRecord.worktreeSnapshotId,
      `${path}.baseline.worktreeSnapshotId`,
      200,
    );
    const environmentLabel = optStr(
      baselineRecord.environmentLabel,
      `${path}.baseline.environmentLabel`,
      LABEL,
    );
    if (commit !== undefined) baseline.commit = commit;
    if (snapshot !== undefined) baseline.worktreeSnapshotId = snapshot;
    if (environmentLabel !== undefined) baseline.environmentLabel = environmentLabel;
    const commands =
      optArr(r.commands, `${path}.commands`, DIAGNOSTICS_LIMITS.commands, (c, p) => {
        const cmd = obj(c, p, [
          "id",
          "label",
          "status",
          "exitCode",
          "durationMs",
          "outputTruncated",
        ]);
        const exitCode = optNum(cmd.exitCode, `${p}.exitCode`, { integer: true });
        const durationMs = optNum(cmd.durationMs, `${p}.durationMs`, { min: 0 });
        const outputTruncated = optBool(cmd.outputTruncated, `${p}.outputTruncated`);
        return {
          id: id(cmd.id, `${p}.id`),
          label: str(cmd.label, `${p}.label`, 400, 1),
          status: oneOf(cmd.status, `${p}.status`, DIAGNOSTIC_CASE_STATUSES),
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(outputTruncated === undefined ? {} : { outputTruncated }),
        };
      }) ?? [];
    uniqueIds(commands, `${path}.commands`, (c) => c.id);
    const cases = arr(r.cases, `${path}.cases`, DIAGNOSTICS_LIMITS.cases, (c, p) => {
      const item = obj(c, p, [
        "id",
        "name",
        "suite",
        "status",
        "location",
        "message",
        "excerpt",
        "attempt",
        "evidence",
        "provenance",
        "rerunnable",
      ]);
      const suite = optStr(item.suite, `${p}.suite`, LABEL);
      const location = optStr(item.location, `${p}.location`, 1_024);
      const message = optStr(item.message, `${p}.message`, 2_000);
      const excerpt = optStr(item.excerpt, `${p}.excerpt`, DIAGNOSTICS_LIMITS.excerptChars);
      const attempt = optNum(item.attempt, `${p}.attempt`, { min: 1, integer: true });
      return {
        id: id(item.id, `${p}.id`, 400),
        name: str(item.name, `${p}.name`, 400, 1),
        status: oneOf(item.status, `${p}.status`, DIAGNOSTIC_CASE_STATUSES),
        evidence: optArr(item.evidence, `${p}.evidence`, 10, readContentRef) ?? [],
        provenance:
          item.provenance === undefined
            ? ("reported" as const)
            : oneOf(item.provenance, `${p}.provenance`, ["observed", "reported"] as const),
        rerunnable: optBool(item.rerunnable, `${p}.rerunnable`) ?? false,
        ...(suite === undefined ? {} : { suite }),
        ...(location === undefined ? {} : { location }),
        ...(message === undefined ? {} : { message }),
        ...(excerpt === undefined ? {} : { excerpt }),
        ...(attempt === undefined ? {} : { attempt }),
      };
    });
    uniqueIds(cases, `${path}.cases`, (c) => c.id);
    for (const [index, item] of cases.entries()) {
      if (item.provenance === "observed")
        fail(
          `${path}.cases[${index}].provenance`,
          "agents report cases as reported; observed provenance is assigned by Orkestrator",
        );
    }
    const workspaceChanged = optBool(r.workspaceChanged, `${path}.workspaceChanged`);
    return {
      runId: id(r.runId, `${path}.runId`),
      runRevision: num(r.runRevision, `${path}.runRevision`, { min: 0, integer: true }),
      baseline,
      status: oneOf(r.status, `${path}.status`, [
        "running",
        "passed",
        "failed",
        "cancelled",
        "incomplete",
      ] as const),
      commands,
      cases,
      ...(workspaceChanged === undefined ? {} : { workspaceChanged }),
    };
  },
  readResult(spec, action, value, path) {
    const r = obj(value, path, ["runRevision", "caseIds", "note"]);
    const runRevision = num(r.runRevision, `${path}.runRevision`, { min: 0, integer: true });
    if (runRevision !== spec.runRevision)
      fail(
        `${path}.runRevision`,
        `the run is now at revision ${spec.runRevision}; review the update and resubmit`,
      );
    const caseIds = arr(
      r.caseIds,
      `${path}.caseIds`,
      DIAGNOSTICS_LIMITS.cases,
      (c, p) => {
        const caseId = id(c, p, 400);
        const item = spec.cases.find((x) => x.id === caseId);
        if (!item) fail(p, "is not a case of this run revision");
        if (action.id === "rerun-selection" && !item.rerunnable)
          fail(p, "has no runner selector for an exact rerun; ask the agent instead");
        return caseId;
      },
      1,
    );
    if (new Set(caseIds).size !== caseIds.length) fail(`${path}.caseIds`, "must not repeat a case");
    const note = optStr(r.note, `${path}.note`, TEXT);
    return { runRevision, caseIds, ...(note?.trim() ? { note: note.trim() } : {}) };
  },
  summarize(spec, action, result) {
    const counts = diagnosticCounts(spec);
    const lines = [
      `${action.id === "request-fix" ? "Fix" : action.id === "explain-selection" ? "Explain" : "Rerun"} ${result.caseIds.length} selected case(s) of run ${spec.runId} (revision ${spec.runRevision}).`,
      `Tested baseline: ${spec.baseline.commit ? `commit ${spec.baseline.commit}` : "unrecorded commit"}${spec.baseline.worktreeSnapshotId ? `, snapshot ${spec.baseline.worktreeSnapshotId}` : ""}${spec.workspaceChanged ? " (the current workspace differs from it)" : ""}.`,
      `Run counts: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.incomplete} incomplete, ${counts["not-run"]} not run.`,
    ];
    for (const caseId of result.caseIds.slice(0, 50)) {
      const item = spec.cases.find((c) => c.id === caseId)!;
      lines.push(
        `- ${item.name} [${item.id}] — ${item.status}${item.location ? ` at ${item.location}` : ""} (${item.provenance})`,
      );
      if (item.message) lines.push(`    message: ${clip(item.message, 500)}`);
      if (item.excerpt)
        lines.push(
          "    output excerpt (quoted evidence):",
          ...clip(item.excerpt, 2_000)
            .split("\n")
            .slice(0, 30)
            .map((l) => `      ${l}`),
        );
      for (const ref of item.evidence) lines.push(`    evidence: ${describeContentRef(ref)}`);
    }
    if (result.caseIds.length > 50)
      lines.push(
        `… ${result.caseIds.length - 50} more cases omitted; read the interaction result for all.`,
      );
    if (result.note) lines.push(`User note: ${JSON.stringify(result.note)}`);
    return lines;
  },
  fallback(spec) {
    const counts = diagnosticCounts(spec);
    return `Run ${spec.runId}: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.incomplete} incomplete`;
  },
};

// ---------------------------------------------------------------------------
// 10. Charts with investigate-selection actions

export interface ChartSelectionSpec {
  chart: ChartSpecV1;
  source: ContentRef;
  /** Units and missing-value conventions the agent should know. */
  notes?: string;
}

export interface ChartSelectionResult {
  selection: Extract<AnchorLocation, { kind: "chart-points" | "chart-range" | "chart-categories" }>;
  question?: string;
}

/** Stable point ids: `${seriesId}:${categoryId}` for bars, `${seriesId}#${ordinal}` for continuous series, slice id for donuts. */
export function chartPointIds(
  chart: ChartSpecV1,
): Map<string, { seriesId: string; x: number | string; y: number | null; label: string }> {
  const ids = new Map<
    string,
    { seriesId: string; x: number | string; y: number | null; label: string }
  >();
  switch (chart.kind) {
    case "bar":
      for (const series of chart.series) {
        for (const point of series.points) {
          const category = chart.categories.find((c) => c.id === point.categoryId);
          ids.set(`${series.id}:${point.categoryId}`, {
            seriesId: series.id,
            x: point.categoryId,
            y: point.value,
            label: `${series.label} · ${category?.label ?? point.categoryId}`,
          });
        }
      }
      break;
    case "donut":
      for (const slice of chart.slices)
        ids.set(slice.id, { seriesId: "slices", x: slice.id, y: slice.value, label: slice.label });
      break;
    default:
      for (const series of chart.series) {
        series.points.forEach((point, ordinal) => {
          ids.set(`${series.id}#${ordinal}`, {
            seriesId: series.id,
            x: point.x,
            y: point.y,
            label: `${series.label} · x=${point.x}`,
          });
        });
      }
  }
  return ids;
}

export function chartSeriesIds(chart: ChartSpecV1): string[] {
  return chart.kind === "donut" ? ["slices"] : chart.series.map((s) => s.id);
}

/** The observations a selection covers, in source order. */
export function chartSelectionMembers(
  chart: ChartSpecV1,
  selection: ChartSelectionResult["selection"],
): string[] {
  const points = chartPointIds(chart);
  switch (selection.kind) {
    case "chart-points":
      return selection.pointIds;
    case "chart-categories":
      return [...points.entries()]
        .filter(
          ([, point]) =>
            selection.categoryIds.includes(String(point.x)) &&
            (selection.seriesIds.length === 0 || selection.seriesIds.includes(point.seriesId)),
        )
        .map(([pointId]) => pointId);
    case "chart-range":
      return [...points.entries()]
        .filter(([, point]) => {
          if (!selection.seriesIds.includes(point.seriesId) || typeof point.x !== "number")
            return false;
          return selection.inclusive
            ? point.x >= selection.from && point.x <= selection.to
            : point.x > selection.from && point.x < selection.to;
        })
        .map(([pointId]) => pointId);
  }
}

export const chartSelectionKind: RichKindModule<ChartSelectionSpec, ChartSelectionResult> = {
  kind: "chart-selection",
  features: [10],
  title: "Chart",
  actions: [followup("investigate-selection", "Investigate selection", { closesRequest: false })],
  customFollowups: true,
  repeatable: true,
  readSpec(value, path) {
    const r = obj(value, path, ["chart", "source", "notes"]);
    const chart = validateChartSpec(r.chart);
    if (!chart.ok) {
      const first = chart.errors[0];
      fail(
        `${path}.chart${first?.path && first.path !== "$" ? `.${first.path.replace(/^\$\.?/, "")}` : ""}`,
        first?.message ?? "is not a valid chart",
      );
    }
    const notes = optStr(r.notes, `${path}.notes`, 2_000);
    return {
      chart: chart.value,
      source: readContentRef(r.source, `${path}.source`),
      ...(notes === undefined ? {} : { notes }),
    };
  },
  readResult(spec, _action, value, path) {
    const r = obj(value, path, ["selection", "question"]);
    const location = readAnchorLocation(r.selection, `${path}.selection`);
    if (
      location.kind !== "chart-points" &&
      location.kind !== "chart-range" &&
      location.kind !== "chart-categories"
    ) {
      fail(`${path}.selection.kind`, "must be chart-points, chart-range or chart-categories");
    }
    const seriesIds = chartSeriesIds(spec.chart);
    const points = chartPointIds(spec.chart);
    if ("seriesIds" in location) {
      for (const seriesId of location.seriesIds)
        if (!seriesIds.includes(seriesId))
          fail(`${path}.selection.seriesIds`, `${seriesId} is not a series of this chart revision`);
    }
    if (location.kind === "chart-points") {
      for (const pointId of location.pointIds)
        if (!points.has(pointId))
          fail(`${path}.selection.pointIds`, `${pointId} is not a point of this chart revision`);
    }
    if (location.kind === "chart-range") {
      if (spec.chart.kind === "bar" || spec.chart.kind === "donut")
        fail(`${path}.selection.kind`, "a range needs a numeric or time x axis");
    }
    if (location.kind === "chart-categories") {
      if (spec.chart.kind !== "bar" && spec.chart.kind !== "donut")
        fail(`${path}.selection.kind`, "categories need a bar or donut chart");
      const categories =
        spec.chart.kind === "bar"
          ? spec.chart.categories.map((c) => c.id)
          : spec.chart.slices.map((s) => s.id);
      for (const categoryId of location.categoryIds)
        if (!categories.includes(categoryId))
          fail(`${path}.selection.categoryIds`, `${categoryId} is not a category of this chart`);
    }
    const selection = location as ChartSelectionResult["selection"];
    if (chartSelectionMembers(spec.chart, selection).length === 0)
      fail(`${path}.selection`, "selects no observation");
    const question = optStr(r.question, `${path}.question`, TEXT);
    return { selection, ...(question?.trim() ? { question: question.trim() } : {}) };
  },
  summarize(spec, action, result) {
    const points = chartPointIds(spec.chart);
    const members = chartSelectionMembers(spec.chart, result.selection);
    const unit = spec.chart.kind === "donut" ? spec.chart.unit : spec.chart.yAxis.unit;
    const lines = [
      `${action.label} [${action.id}] on chart "${spec.chart.title}" ${describeContentRef(spec.source)}.`,
      `Selection: ${describeAnchorLocation(result.selection)} — ${members.length} observation(s)${unit ? `, values in ${unit}` : ""}.`,
    ];
    const shown = members.slice(0, 100);
    for (const pointId of shown) {
      const point = points.get(pointId)!;
      lines.push(`  - ${point.label} [${pointId}] = ${point.y === null ? "missing" : point.y}`);
    }
    if (members.length > shown.length)
      lines.push(
        `  … ${members.length - shown.length} more observations omitted (the selection is complete in the interaction result).`,
      );
    const missing = shown.filter((pointId) => points.get(pointId)?.y === null).length;
    if (missing)
      lines.push(`${missing} selected observation(s) have no value (missing, not zero).`);
    if (spec.notes) lines.push(`Chart notes: ${spec.notes}`);
    if (result.question) lines.push(`User question: ${JSON.stringify(result.question)}`);
    return lines;
  },
  fallback(spec) {
    return `${spec.chart.title}: ${spec.chart.description}`;
  },
};

// ---------------------------------------------------------------------------
// 11. Diagrams with meaningful node actions

export interface DiagramObject {
  id: string;
  type: "node" | "edge";
  label: string;
  description?: string;
  from?: string;
  to?: string;
  sourceRefs: ContentRef[];
  provenance: "inferred" | "observed";
  /** The id a replaced (split/merged/removed) object had in an earlier revision. */
  replaces?: string[];
}

export interface DiagramSpec {
  title: string;
  /** Mermaid source shown read-only; actions use the manifest, never click directives. */
  mermaid?: string;
  objects: DiagramObject[];
}

export interface DiagramResult {
  objectIds: string[];
  question?: string;
}

export const diagramKind: RichKindModule<DiagramSpec, DiagramResult> = {
  kind: "diagram",
  features: [11],
  title: "Diagram",
  actions: [
    followup("explain", "Explain", { closesRequest: false }),
    followup("failure-modes", "Show failure modes", { closesRequest: false, style: "secondary" }),
    followup("plan-changes", "Plan changes here", { closesRequest: false, style: "secondary" }),
  ],
  customFollowups: true,
  repeatable: true,
  readSpec(value, path) {
    const r = obj(value, path, ["title", "mermaid", "objects"]);
    const mermaid = optStr(r.mermaid, `${path}.mermaid`, 60_000);
    if (mermaid !== undefined && /\bclick\b|\bcallback\b|\bhref\b/iu.test(mermaid)) {
      fail(
        `${path}.mermaid`,
        "click, callback and href directives are not allowed: actions come from the object manifest",
      );
    }
    const objects = arr(
      r.objects,
      `${path}.objects`,
      500,
      (o, p) => {
        const item = obj(o, p, [
          "id",
          "type",
          "label",
          "description",
          "from",
          "to",
          "sourceRefs",
          "provenance",
          "replaces",
        ]);
        const type = oneOf(item.type, `${p}.type`, ["node", "edge"] as const);
        const description = optStr(item.description, `${p}.description`, 2_000);
        const from = item.from === undefined ? undefined : id(item.from, `${p}.from`);
        const to = item.to === undefined ? undefined : id(item.to, `${p}.to`);
        if (type === "edge" && (from === undefined || to === undefined))
          fail(p, "an edge needs from and to");
        const replaces = optArr(item.replaces, `${p}.replaces`, 20, (x, xp) => id(x, xp));
        return {
          id: id(item.id, `${p}.id`),
          type,
          label: str(item.label, `${p}.label`, LABEL, 1),
          sourceRefs: optArr(item.sourceRefs, `${p}.sourceRefs`, 10, readContentRef) ?? [],
          provenance:
            item.provenance === undefined
              ? ("inferred" as const)
              : oneOf(item.provenance, `${p}.provenance`, ["inferred", "observed"] as const),
          ...(description === undefined ? {} : { description }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(replaces === undefined ? {} : { replaces }),
        };
      },
      1,
    );
    uniqueIds(objects, `${path}.objects`, (o) => o.id);
    for (const [index, item] of objects.entries()) {
      if (item.provenance === "observed")
        fail(
          `${path}.objects[${index}].provenance`,
          "agent-supplied architecture is inferred; observed provenance is assigned by Orkestrator",
        );
      for (const end of [item.from, item.to]) {
        if (end !== undefined && !objects.some((o) => o.id === end && o.type === "node"))
          fail(`${path}.objects[${index}]`, `edge end ${end} is not a node`);
      }
    }
    return {
      title: str(r.title, `${path}.title`, LABEL, 1),
      objects,
      ...(mermaid === undefined ? {} : { mermaid }),
    };
  },
  readResult(spec, _action, value, path) {
    const r = obj(value, path, ["objectIds", "question"]);
    const objectIds = arr(
      r.objectIds,
      `${path}.objectIds`,
      200,
      (o, p) => {
        const objectId = id(o, p);
        if (!spec.objects.some((x) => x.id === objectId))
          fail(p, "is not an object of this diagram revision");
        return objectId;
      },
      1,
    );
    if (new Set(objectIds).size !== objectIds.length)
      fail(`${path}.objectIds`, "must not repeat an object");
    const question = optStr(r.question, `${path}.question`, TEXT);
    return { objectIds, ...(question?.trim() ? { question: question.trim() } : {}) };
  },
  summarize(spec, action, result) {
    const lines = [
      `${action.label} [${action.id}] for ${result.objectIds.length} object(s) of diagram "${spec.title}". Architecture objects are agent-supplied (inferred) unless marked observed.`,
    ];
    const selected = new Set(result.objectIds);
    for (const objectId of result.objectIds) {
      const item = spec.objects.find((o) => o.id === objectId)!;
      lines.push(
        `- ${item.type} "${item.label}" [${item.id}] (${item.provenance})${item.type === "edge" ? ` ${item.from} → ${item.to}` : ""}${item.description ? `: ${clip(item.description, 400)}` : ""}`,
      );
      for (const ref of item.sourceRefs) lines.push(`    source: ${describeContentRef(ref)}`);
    }
    const neighbours = spec.objects.filter(
      (o) =>
        o.type === "edge" &&
        !selected.has(o.id) &&
        ((o.from && selected.has(o.from)) || (o.to && selected.has(o.to))),
    );
    if (neighbours.length)
      lines.push(
        `Adjacent edges: ${neighbours
          .slice(0, 30)
          .map((e) => `${e.label} [${e.id}] ${e.from} → ${e.to}`)
          .join("; ")}`,
      );
    const omitted = spec.objects.length - result.objectIds.length - neighbours.length;
    if (omitted > 0)
      lines.push(`${omitted} other object(s) of the diagram are omitted from this request.`);
    if (result.question) lines.push(`User question: ${JSON.stringify(result.question)}`);
    return lines;
  },
  fallback(spec) {
    return `${spec.title}: ${spec.objects
      .filter((o) => o.type === "node")
      .map((o) => o.label)
      .join(", ")}`;
  },
};

// ---------------------------------------------------------------------------
// 12. Calculators and parameter explorers with result submission

export interface WidgetResultSpec {
  /** The html-interactive artifact revision whose frame may propose candidates. */
  artifactId: string;
  revision: number;
  /** The declared output: candidates must match it exactly. */
  output: FormSpec;
  intent: string;
  assumptions: string[];
}

export interface WidgetResultResult {
  candidateId: string;
  /** Host-computed digest of the reviewed candidate value. */
  candidateHash: string;
  generation: string;
  value: FormValues;
}

export const widgetResultKind: RichKindModule<WidgetResultSpec, WidgetResultResult> = {
  kind: "widget-result",
  features: [12],
  title: "Explorer result",
  actions: [followup("send-result", "Send result", { closesRequest: false })],
  customFollowups: false,
  repeatable: true,
  readSpec(value, path) {
    const r = obj(value, path, ["artifactId", "revision", "output", "intent", "assumptions"]);
    return {
      artifactId: id(r.artifactId, `${path}.artifactId`),
      revision: num(r.revision, `${path}.revision`, { min: 0, integer: true }),
      output: readFormSpec(r.output, `${path}.output`),
      intent: str(r.intent, `${path}.intent`, LABEL, 1),
      assumptions:
        optArr(r.assumptions, `${path}.assumptions`, 20, (a, p) => str(a, p, 1_000, 1)) ?? [],
    };
  },
  readResult(spec, _action, value, path) {
    const r = obj(value, path, ["candidateId", "candidateHash", "generation", "value"]);
    return {
      candidateId: id(r.candidateId, `${path}.candidateId`),
      candidateHash: str(r.candidateHash, `${path}.candidateHash`, 128, 1),
      generation: id(r.generation, `${path}.generation`),
      value: readFormValues(spec.output, r.value, `${path}.value`),
    };
  },
  summarize(spec, _action, result) {
    return [
      `The user reviewed and sent a result from explorer artifact ${spec.artifactId} revision ${spec.revision} (${spec.intent}).`,
      ...summarizeFormValues(spec.output.fields, result.value),
      ...(spec.assumptions.length
        ? [
            "Stated assumptions (illustrative model, not measurements):",
            ...spec.assumptions.map((a) => `  - ${a}`),
          ]
        : []),
      "Applying these values is a separate, authorized operation.",
    ];
  },
  fallback(spec) {
    return `Explorer ${spec.artifactId}: ${spec.intent}`;
  },
};

// ---------------------------------------------------------------------------
// 14. Inspectable evidence cards

export const EVIDENCE_PROVENANCES = [
  "agent-cited",
  "orkestrator-observed",
  "user-provided",
  "imported",
] as const;

export interface EvidenceSpec {
  recommendation?: string;
  claims: Array<{ id: string; text: string; kind: "fact" | "assumption" | "interpretation" }>;
  evidence: Array<{
    id: string;
    label: string;
    source: ContentRef;
    excerpt?: string;
    provenance: (typeof EVIDENCE_PROVENANCES)[number];
    capturedAt?: string;
    contentHash?: string;
  }>;
  links: Array<{
    claimId: string;
    evidenceId: string;
    relevance: string;
    assertedBy: "agent" | "user";
  }>;
}

export interface EvidenceResult {
  claimId?: string;
  evidenceIds: string[];
  question?: string;
  /** Evidence revisions as shown, keyed by evidence id. */
  sourceRevisions: Record<string, string>;
}

export const evidenceKind: RichKindModule<EvidenceSpec, EvidenceResult> = {
  kind: "evidence",
  features: [14],
  title: "Evidence",
  actions: [
    followup("explain-relevance", "Explain relevance", { closesRequest: false }),
    followup("challenge-assumption", "Challenge this assumption", {
      closesRequest: false,
      style: "secondary",
    }),
    followup("reassess-without", "Reassess without this evidence", {
      closesRequest: false,
      style: "secondary",
    }),
  ],
  customFollowups: false,
  repeatable: true,
  readSpec(value, path) {
    const r = obj(value, path, ["recommendation", "claims", "evidence", "links"]);
    const claims = arr(
      r.claims,
      `${path}.claims`,
      50,
      (c, p) => {
        const claim = obj(c, p, ["id", "text", "kind"]);
        return {
          id: id(claim.id, `${p}.id`),
          text: str(claim.text, `${p}.text`, 2_000, 1),
          kind: oneOf(claim.kind ?? "fact", `${p}.kind`, [
            "fact",
            "assumption",
            "interpretation",
          ] as const),
        };
      },
      1,
    );
    uniqueIds(claims, `${path}.claims`, (c) => c.id);
    const evidence = arr(
      r.evidence,
      `${path}.evidence`,
      100,
      (e, p) => {
        const item = obj(e, p, [
          "id",
          "label",
          "source",
          "excerpt",
          "provenance",
          "capturedAt",
          "contentHash",
        ]);
        const excerpt = optStr(item.excerpt, `${p}.excerpt`, 4_000);
        const capturedAt = optStr(item.capturedAt, `${p}.capturedAt`, 64);
        const contentHash = optStr(item.contentHash, `${p}.contentHash`, 128);
        const provenance =
          item.provenance === undefined
            ? ("agent-cited" as const)
            : oneOf(item.provenance, `${p}.provenance`, EVIDENCE_PROVENANCES);
        if (provenance === "orkestrator-observed" || provenance === "user-provided")
          fail(`${p}.provenance`, "agents cite evidence as agent-cited or imported");
        return {
          id: id(item.id, `${p}.id`),
          label: str(item.label, `${p}.label`, LABEL, 1),
          source: readContentRef(item.source, `${p}.source`),
          provenance,
          ...(excerpt === undefined ? {} : { excerpt }),
          ...(capturedAt === undefined ? {} : { capturedAt }),
          ...(contentHash === undefined ? {} : { contentHash }),
        };
      },
      1,
    );
    uniqueIds(evidence, `${path}.evidence`, (e) => e.id);
    const links = arr(r.links, `${path}.links`, 300, (l, p) => {
      const link = obj(l, p, ["claimId", "evidenceId", "relevance", "assertedBy"]);
      const claimId = id(link.claimId, `${p}.claimId`);
      const evidenceId = id(link.evidenceId, `${p}.evidenceId`);
      if (!claims.some((c) => c.id === claimId)) fail(`${p}.claimId`, "is not a claim");
      if (!evidence.some((e) => e.id === evidenceId)) fail(`${p}.evidenceId`, "is not evidence");
      return {
        claimId,
        evidenceId,
        relevance: str(link.relevance, `${p}.relevance`, 1_000, 1),
        assertedBy: "agent" as const,
      };
    });
    const recommendation = optStr(r.recommendation, `${path}.recommendation`, TEXT);
    return { claims, evidence, links, ...(recommendation === undefined ? {} : { recommendation }) };
  },
  readResult(spec, _action, value, path) {
    const r = obj(value, path, ["claimId", "evidenceIds", "question", "sourceRevisions"]);
    const claimId = r.claimId === undefined ? undefined : id(r.claimId, `${path}.claimId`);
    if (claimId !== undefined && !spec.claims.some((c) => c.id === claimId))
      fail(`${path}.claimId`, "is not a claim of this revision");
    const evidenceIds = arr(
      r.evidenceIds,
      `${path}.evidenceIds`,
      100,
      (e, p) => {
        const evidenceId = id(e, p);
        if (!spec.evidence.some((x) => x.id === evidenceId))
          fail(p, "is not evidence of this revision");
        return evidenceId;
      },
      1,
    );
    const question = optStr(r.question, `${path}.question`, TEXT);
    const sourceRevisions: Record<string, string> = {};
    for (const evidenceId of evidenceIds) {
      const item = spec.evidence.find((x) => x.id === evidenceId)!;
      sourceRevisions[evidenceId] = describeContentRef(item.source);
    }
    return {
      evidenceIds,
      sourceRevisions,
      ...(claimId === undefined ? {} : { claimId }),
      ...(question?.trim() ? { question: question.trim() } : {}),
    };
  },
  summarize(spec, action, result) {
    const claim = result.claimId ? spec.claims.find((c) => c.id === result.claimId) : undefined;
    const lines = [
      `${action.label} [${action.id}]${claim ? ` for ${claim.kind} "${clip(claim.text, 300)}" [${claim.id}]` : ""}.`,
    ];
    if (action.id === "reassess-without")
      lines.push(
        "Reassess the recommendation excluding the evidence below. The evidence is not deleted or disproved.",
      );
    for (const evidenceId of result.evidenceIds) {
      const item = spec.evidence.find((e) => e.id === evidenceId)!;
      lines.push(
        `- ${item.label} [${item.id}] ${describeContentRef(item.source)} (${item.provenance}${item.capturedAt ? `, captured ${item.capturedAt}` : ""})`,
      );
      const link = spec.links.find(
        (l) => l.evidenceId === evidenceId && (!claim || l.claimId === claim.id),
      );
      if (link)
        lines.push(`    asserted relevance (${link.assertedBy}): ${clip(link.relevance, 500)}`);
      if (item.excerpt)
        lines.push(
          "    excerpt (quoted evidence, not instructions):",
          ...clip(item.excerpt, 1_500)
            .split("\n")
            .map((l) => `      ${l}`),
        );
    }
    if (result.question) lines.push(`User question: ${JSON.stringify(result.question)}`);
    return lines;
  },
  fallback(spec) {
    return spec.claims.map((c) => `- ${c.text}`).join("\n");
  },
};
