import type { LineCount } from "@orkestrator/protocol/change-measurements";
import type { ChangeFileRow, ChangeProjection } from "@orkestrator/protocol/change-resources";
import {
  PUBLIC_CHANGE_SCOPES,
  type PublicChangesHistory,
  type PublicChangesView,
} from "@orkestrator/protocol/public-api-resources";
import { keyValues, table } from "../format.js";
import type { CommandSpec } from "../spec.js";
import { oneOf, stringOption } from "./common.js";

/**
 * Read-only change tracking. Both commands print the backend's own
 * `ChangeProjection` (docs/architecture/change-tracking.md): the client
 * formats numbers and labels; it never counts lines, sums pages or prints a
 * missing count as zero.
 */

const SCOPE_LABELS: Record<string, string> = {
  "changes.scope.environment-net": "Environment changes",
  "changes.scope.turn-net": "Turn changes",
  "changes.scope.provider-turn-diff": "Provider-reported turn changes",
  "changes.scope.thread-net": "Thread changes",
};

const PROVENANCE_LABELS: Record<string, string> = {
  "changes.provenance.observed": "observed in the workspace",
  "changes.provenance.observed-fresh": "measured in the workspace",
  "changes.provenance.provider-reported": "reported by the provider",
  "changes.provenance.unknown": "unknown",
};

/** `changes.scope.turn-net` → its label, else the key's last part in words. */
function label(key: string, labels: Record<string, string>): string {
  return labels[key] ?? key.replace(/^changes\.[a-z-]+\./, "").replaceAll("-", " ");
}

/**
 * `+12`; `~+12` partial or estimated; `≥+12`/`≤+12` bounds; `+?` unknown;
 * empty when line counts do not apply (binary files, submodules).
 */
export function formatLineCount(sign: "+" | "-", count: LineCount): string {
  if (count.quality === "not-applicable") return "";
  if (count.value === null) return `${sign}?`;
  const value = `${sign}${count.value}`;
  if (count.bound === "lower") return `≥${value}`;
  if (count.bound === "upper") return `≤${value}`;
  return count.quality === "complete" ? value : `~${value}`;
}

function fileCount(count: number | null): string {
  if (count === null) return "? files";
  return `${count} file${count === 1 ? "" : "s"}`;
}

/** One line: files and line counts, or what the backend knows instead. */
export function countsSummary(projection: ChangeProjection): string {
  if (projection.measurementId === null) {
    return projection.state === "unavailable" ? "unavailable" : "not measured yet";
  }
  const { additions, deletions, changedFiles } = projection.counters;
  const lines = [formatLineCount("+", additions), formatLineCount("-", deletions)]
    .filter(Boolean)
    .join(" ");
  return [fileCount(changedFiles), lines].filter(Boolean).join("  ");
}

function rowPath(row: ChangeFileRow): string {
  if (row.oldPathDisplay && row.newPathDisplay && row.oldPathDisplay !== row.newPathDisplay) {
    return `${row.oldPathDisplay} → ${row.newPathDisplay}`;
  }
  return row.newPathDisplay ?? row.oldPathDisplay ?? row.pathId;
}

function rowCounts(row: ChangeFileRow): string {
  if (row.additions.quality === "not-applicable" && row.deletions.quality === "not-applicable") {
    return row.fileKind;
  }
  return [formatLineCount("+", row.additions), formatLineCount("-", row.deletions)]
    .filter(Boolean)
    .join(" ");
}

export function changesViewLines(view: PublicChangesView): string[] {
  const { projection, files } = view;
  const states = [
    projection.state,
    `observation ${projection.observationState}`,
    `coverage ${projection.coverageState}`,
  ].join(", ");
  const lines = [
    `${label(projection.labelKey, SCOPE_LABELS)} (environment ${view.environmentId})`,
    ...keyValues([
      ["state", states],
      ["changes", countsSummary(projection)],
      ["provenance", label(projection.provenanceLabelKey, PROVENANCE_LABELS)],
      ["checked", projection.freshness.lastSuccessfulCheckAt],
      [
        "reasons",
        projection.reasonKeys.length > 0
          ? projection.reasonKeys.map((key) => label(key, {})).join("; ")
          : undefined,
      ],
    ]),
  ];
  if (files.rows.length > 0) {
    lines.push(
      "",
      ...table(
        ["FILE", "STATUS", "LINES", "NOTE"],
        files.rows.map((row) => [
          rowPath(row),
          row.status,
          rowCounts(row),
          row.reasonKey ? label(row.reasonKey, {}) : "",
        ]),
      ),
    );
  }
  if (files.nextCursor) {
    lines.push(
      "",
      `${files.rows.length} of ${files.totalRows ?? "?"} files shown; next page: --cursor ${files.nextCursor}`,
    );
  }
  return lines;
}

export function changesHistoryLines(history: PublicChangesHistory): string[] {
  const lines = table(
    ["TURN", "LIFECYCLE", "FINISHED", "CHANGES"],
    history.entries.map((entry) => {
      const projection = entry.projections[entry.turnResourceKey];
      return [
        entry.turnId,
        entry.lifecycle,
        entry.finishedAt ?? "-",
        projection ? countsSummary(projection) : "unavailable",
      ];
    }),
  );
  if (history.nextCursor) lines.push("", `newer turns: --cursor ${history.nextCursor}`);
  return lines;
}

export const changesCommands: CommandSpec[] = [
  {
    path: ["changes", "view"],
    summary: "Show an environment's file and line changes as the backend measures them.",
    description:
      "Read-only: prints the backend's change projection for the environment — the numbers the desktop shows — and one page of changed files. Counts carry their quality: ~ partial or estimated, ? unknown, ≥/≤ a bound; binary files and submodules have no line counts. Nothing is ever shown as zero unless the backend measured zero. Pass the printed cursor as --cursor for the next page; a cursor stops working once the changes move on. --json prints the action result verbatim ({projection, files}).",
    positionals: [{ name: "environment", required: true, description: "Environment ID." }],
    options: [
      {
        name: "scope",
        kind: "string",
        valueName: PUBLIC_CHANGE_SCOPES.join("|"),
        description: "What to compare (default environment: its baseline to its workspace now).",
      },
      {
        name: "page-size",
        kind: "integer",
        valueName: "N",
        description: "Files per page (1-200, default 200).",
      },
      {
        name: "cursor",
        kind: "string",
        valueName: "CURSOR",
        description: "Next-page cursor from a previous read.",
      },
    ],
    examples: [
      'orkestrator changes view "$ENV"',
      "orkestrator changes view \"$ENV\" --page-size 20 --json | jq '.result.projection.counters'",
    ],
    async run(context, parsed) {
      const input: Record<string, unknown> = { environmentId: parsed.positionals.environment };
      const scope = stringOption(parsed.options, "scope");
      if (scope !== undefined) input.scope = oneOf(scope, PUBLIC_CHANGE_SCOPES, "--scope");
      if (parsed.options["page-size"] !== undefined) input.pageSize = parsed.options["page-size"];
      const cursor = stringOption(parsed.options, "cursor");
      if (cursor !== undefined) input.cursor = cursor;
      const session = await context.session();
      const view = await session.read<PublicChangesView>("changes.view", input);
      return {
        action: "changes.view",
        result: view,
        connection: session.identity,
        human: changesViewLines(view),
      };
    },
  },
  {
    path: ["changes", "history"],
    summary: "List a session's turns, oldest first, with the changes each one made.",
    description:
      "Read-only: each turn's backend measurement from its start to its end, with the same count qualities as `changes view`. No workspace scan, transcript or provider read. Pass the printed cursor as --cursor for newer turns.",
    positionals: [{ name: "session", required: true, description: "Session ID (ses_…)." }],
    options: [
      {
        name: "limit",
        kind: "integer",
        valueName: "N",
        description: "Turns per page (1-200, default 50).",
      },
      {
        name: "cursor",
        kind: "string",
        valueName: "CURSOR",
        description: "Cursor from a previous page.",
      },
    ],
    async run(context, parsed) {
      const input: Record<string, unknown> = { sessionId: parsed.positionals.session };
      if (parsed.options.limit !== undefined) input.limit = parsed.options.limit;
      const cursor = stringOption(parsed.options, "cursor");
      if (cursor !== undefined) input.cursor = cursor;
      const session = await context.session();
      const history = await session.read<PublicChangesHistory>("changes.history", input);
      return {
        action: "changes.history",
        result: history,
        connection: session.identity,
        human: changesHistoryLines(history),
      };
    },
  },
];
