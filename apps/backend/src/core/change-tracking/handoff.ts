/**
 * ChangeHandoffSerializer: agent-handoff text for change measurements.
 *
 * Counts are serialized once from the selected measurement, with their scope,
 * provenance and quality. An unknown count is written as unknown, never as
 * zero; a partial count says so; a payload is labelled as proposed or
 * reported content, not as an applied workspace change.
 */

import type { ChangeMeasurement, LineCount } from "@orkestrator/protocol/change-measurements";
import { displayPath } from "./capture.js";
import type { ChangeLedger } from "./change-ledger.js";

const SCOPE_LABELS: Record<ChangeMeasurement["scope"], string> = {
  "environment-net": "environment changes",
  "uncommitted-net": "uncommitted changes",
  staged: "staged changes",
  unstaged: "unstaged changes",
  "turn-net": "this turn's changes",
  "provider-turn-diff": "provider-reported turn changes",
  "thread-net": "thread changes",
  "tool-effect": "tool change",
  "observation-window": "workspace changes observed during the tool",
  "tool-payload": "proposed/reported tool content",
  "operation-volume": "recorded edit activity",
  commit: "commit changes",
  "pull-request": "pull request changes",
};

function provenance(measurement: ChangeMeasurement): string {
  if (measurement.origin === "legacy-import") return "legacy summary";
  if (measurement.origin === "content-only") return "content supplied, prior state unknown";
  switch (measurement.effectClaim) {
    case "workspace-observed":
      return measurement.boundary.before === "fresh-before"
        ? "observed in the workspace"
        : "observed in the workspace after the tool started";
    case "provider-reported":
      return "reported by the provider";
    case "proposal":
      return "proposed (not verified as applied)";
    default:
      return "unknown provenance";
  }
}

export function formatCount(sign: "+" | "-", count: LineCount): string {
  if (count.quality === "not-applicable") return `${sign}n/a`;
  if (count.value === null) return `${sign}unknown`;
  const bound = count.bound === "lower" ? "≥" : count.bound === "upper" ? "≤" : "";
  const suffix = count.quality === "complete" ? "" : ` (${count.quality})`;
  return `${sign}${bound}${count.value}${suffix}`;
}

export class ChangeHandoffSerializer {
  constructor(private readonly ledger: ChangeLedger) {}

  serialize(
    measurementIds: readonly string[],
    maxCharacters = 8_000,
  ): { text: string; measurementIds: string[]; truncated: boolean } {
    const lines: string[] = [];
    const included: string[] = [];
    let truncated = false;
    for (const id of measurementIds.slice(0, 200)) {
      const measurement = this.ledger.measurement(id);
      if (!measurement) {
        lines.push(`- changes: unavailable (measurement ${id.slice(0, 12)} not retained)`);
        continue;
      }
      included.push(id);
      const totals = measurement.totals;
      const files =
        totals.changedFiles === null
          ? "files unknown"
          : `${totals.changedFiles} file${totals.changedFiles === 1 ? "" : "s"}${measurement.completeness.files === "complete" ? "" : ` (${measurement.completeness.files})`}`;
      const content = totals.contentLines != null ? `, ${totals.contentLines} content lines` : "";
      lines.push(
        `- ${SCOPE_LABELS[measurement.scope]} (${provenance(measurement)}): ${formatCount("+", totals.additions)} ${formatCount("-", totals.deletions)}, ${files}${content}`,
      );
      if (measurement.completeness.reasons.length > 0) {
        lines.push(`  limits: ${measurement.completeness.reasons.slice(0, 6).join(", ")}`);
      }
      if (measurement.attribution.overlap === "known-overlap") {
        lines.push(
          "  note: other writers overlapped this interval; changes are not exclusively attributable",
        );
      }
      for (const row of this.ledger.measurementFiles(id, 0, 20)) {
        const additions: LineCount = {
          value: row.additions,
          quality: row.additions_quality as LineCount["quality"],
          bound: row.additions_quality === "complete" ? "exact" : "none",
        };
        const deletions: LineCount = {
          value: row.deletions,
          quality: row.deletions_quality as LineCount["quality"],
          bound: row.deletions_quality === "complete" ? "exact" : "none",
        };
        const path = displayPath(row.new_path ?? row.old_path ?? row.path_id);
        const from =
          row.old_path && row.new_path && row.old_path !== row.new_path
            ? ` (from ${displayPath(row.old_path)})`
            : "";
        lines.push(
          `  ${row.status}: ${path}${from} ${formatCount("+", additions)} ${formatCount("-", deletions)}`,
        );
      }
      const total = this.ledger.measurementFileCount(id);
      if (total > 20) lines.push(`  … ${total - 20} more files`);
    }
    let text = lines.join("\n");
    if (text.length > maxCharacters) {
      text = `${text.slice(0, Math.max(0, maxCharacters - 20))}\n… (truncated)`;
      truncated = true;
    }
    return { text, measurementIds: included, truncated };
  }
}
